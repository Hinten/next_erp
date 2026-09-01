import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  ML_ATTR_SKU_PAI_NOME,
  MercadoLivreHttpError,
  type MercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import type { ComponentesKit } from '@delfrance/schemas';

import {
  type PublishDeps,
  loadTabelaBinding,
  publishProduto,
  quantidadeParaPublicar,
} from './publish';
import {
  STOCK_KIT_VIRTUAL_SKIP_FLAG_ENV,
  quantidadeDoMembro,
  quantidadeParaEnvio,
} from '../estoque/bulkEstoquePlan';
import {
  MercadoLivrePublishError,
  SKU_PAI_ATRIBUTO_FLAG_ENV,
  TABELA_BINDING_RECUSA,
  type TabelaBindingMotivo,
  sizeChartIssue,
} from './publishCore';

/**
 * Regression tests for the LEGACY-WIRE contract of the publish orchestrator. The
 * migrated corpus stores these docs in the old Flutter shape, so every
 * `*OuterRef` must be written `documents/`-prefixed (`pathWithDocuments`) or our
 * own equality queries fork into two populations, and a re-publish must preserve
 * every Flutter-authored field it doesn't own (the old app persisted via
 * `copyWith(...).save()`, so those keys are in the data). Backed by an in-memory
 * fake of the few Admin-SDK surfaces the handles touch.
 */

type DocData = Record<string, unknown>;

/**
 * Resolve the `FieldValue` transforms this module actually writes.
 *
 * ⚠️ Without this the fake stores the SENTINEL OBJECT, so a test asserting a
 * number passes only while the code under test writes a plain value — i.e. it goes
 * green exactly when the rule-7-safe version is replaced by the unsafe one. Both
 * transforms expose `operand`, and their constructor names are the only thing that
 * tells them apart.
 */
function aplicarSentinelas(atual: DocData | undefined, patch: DocData): DocData {
  const out: DocData = {};
  for (const [k, v] of Object.entries(patch)) {
    const nome = (v as { constructor?: { name?: string } } | null)?.constructor?.name;
    const operand = (v as { operand?: unknown } | null)?.operand;
    const anterior = atual?.[k];
    if (nome === 'NumericIncrementTransform' && typeof operand === 'number') {
      out[k] = (typeof anterior === 'number' ? anterior : 0) + operand;
    } else if (nome === 'NumericMaximumTransform' && typeof operand === 'number') {
      out[k] = typeof anterior === 'number' ? Math.max(anterior, operand) : operand;
    } else if (nome === 'NumericMinimumTransform' && typeof operand === 'number') {
      out[k] = typeof anterior === 'number' ? Math.min(anterior, operand) : operand;
    } else {
      out[k] = v;
    }
  }
  return out;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];
  private autoN = 0;
  /** Monotonic per-doc version standing in for Firestore's `updateTime`. */
  private readonly versions = new Map<string, number>();
  /**
   * Fires once, right after the next `get()` on this doc path, so a test can
   * simulate a concurrent writer landing inside a read-modify-write window.
   */
  afterGet: { path: string; fn: () => void } | null = null;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }

  versionOf(key: string): number {
    return this.versions.get(key) ?? 1;
  }

  bump(key: string): void {
    this.versions.set(key, this.versionOf(key) + 1);
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
    this.bump(`${path}/${id}`);
  }

  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  /**
   * A WriteBatch with REAL atomicity: nothing is applied until `commit()`, and a
   * failing `create` applies NOTHING.
   *
   * ⚠️ The all-or-nothing half is the point, not a nicety. #1087's materialisation
   * is unrecoverable if it half-lands (a produto that gained a child is never
   * re-entered), so a fake that applied ops as they were queued would let the exact
   * defect the batch exists to prevent pass its own test.
   */
  batch() {
    const self = this;
    const ops: Array<{
      path: string;
      id: string;
      data: DocData;
      kind: 'create' | 'set' | 'update';
    }> = [];
    return {
      create(ref: { __path: string; __id: string }, data: DocData) {
        ops.push({ path: ref.__path, id: ref.__id, data, kind: 'create' });
      },
      set(ref: { __path: string; __id: string }, data: DocData) {
        ops.push({ path: ref.__path, id: ref.__id, data, kind: 'set' });
      },
      update(ref: { __path: string; __id: string }, data: DocData) {
        ops.push({ path: ref.__path, id: ref.__id, data, kind: 'update' });
      },
      async commit() {
        // Validate FIRST, mutate second — a rejected batch must leave no trace.
        for (const op of ops) {
          const col = self.col(op.path);
          if (op.kind === 'create' && col.has(op.id)) {
            const err = new Error(`ALREADY_EXISTS: ${op.path}/${op.id}`) as Error & {
              code: number;
            };
            err.code = 6;
            throw err;
          }
          if (op.kind === 'update' && !col.has(op.id)) {
            const err = new Error(`NOT_FOUND: ${op.path}/${op.id}`) as Error & { code: number };
            err.code = 5;
            throw err;
          }
        }
        for (const op of ops) {
          const col = self.col(op.path);
          const atual = col.get(op.id);
          const resolvido = aplicarSentinelas(atual, op.data);
          col.set(op.id, op.kind === 'create' ? resolvido : { ...(atual ?? {}), ...resolvido });
          self.bump(`${op.path}/${op.id}`);
        }
      },
    };
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        const key = `${path}/${docId}`;
        return {
          id: docId,
          // How `batch()` addresses this doc — the fake's stand-in for a real
          // DocumentReference's own path.
          __path: path,
          __id: docId,
          get: async () => {
            const snap = {
              exists: col.has(docId),
              id: docId,
              data: () => col.get(docId),
              updateTime: self.versionOf(key),
            };
            if (self.afterGet?.path === key) {
              const { fn } = self.afterGet;
              self.afterGet = null;
              fn();
            }
            return snap;
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            const atual = col.get(docId);
            const resolvido = aplicarSentinelas(atual, data);
            col.set(docId, opts?.merge ? { ...(atual ?? {}), ...resolvido } : { ...resolvido });
            self.bump(key);
          },
          // Real `create()` semantics, and the ALREADY_EXISTS half is the point:
          // the sole-member materialisation (#1087) treats gRPC 6 as an ADOPTION,
          // so a double is indistinguishable from a first run only if this throws
          // the way Firestore does.
          create: async (data: DocData) => {
            if (col.has(docId)) {
              const err = new Error(`ALREADY_EXISTS: ${key}`) as Error & { code: number };
              err.code = 6;
              throw err;
            }
            col.set(docId, { ...data });
            self.bump(key);
          },
          update: async (patch: DocData, precondition?: { lastUpdateTime?: unknown }) => {
            // Recorded only once the write COMMITS — a rejected update never
            // reaches Firestore, so a test asserting on `updates` must not see
            // one (the CAS retry below issues two attempts, one of which loses).
            const current = col.get(docId);
            if (!current) {
              // Real Firestore rejects update() on a missing doc with gRPC 5;
              // `mergeIfExists` narrows exactly that to `false`.
              const err = new Error(`NOT_FOUND: ${key}`) as Error & { code: number };
              err.code = 5;
              throw err;
            }
            if (
              precondition?.lastUpdateTime != null &&
              precondition.lastUpdateTime !== self.versionOf(key)
            ) {
              // gRPC FAILED_PRECONDITION — the doc moved under the read the
              // patch was derived from (rule 7, tier 1).
              const err = new Error(`FAILED_PRECONDITION: ${key}`) as Error & { code: number };
              err.code = 9;
              throw err;
            }
            col.set(docId, { ...current, ...aplicarSentinelas(current, patch) });
            self.bump(key);
            self.updates.push({ path: key, patch });
          },
        };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...col.entries()]
            .filter(([, d]) => d[field] === value)
            .map(([docId, d]) => ({ id: docId, data: () => d, exists: true })),
        }),
      }),
      get: async () => ({
        docs: [...col.entries()].map(([docId, d]) => ({ id: docId, data: () => d, exists: true })),
        empty: col.size === 0,
      }),
    };
  }
}

const CONTA = 'conta-1';
const PROD = 'prod-1';
const LINKS_PATH = `produtos/${PROD}/produtoMercadoLivre`;

const ITEM_RESPONSE = {
  id: 'MLB777',
  status: 'active',
  permalink: 'https://ml/MLB777',
  price: 79.9,
  category_id: 'MLB31447',
  listing_type_id: 'gold_special',
  shipping: { free_shipping: false },
  variations: null,
};

function makeApi(overrides: Partial<Record<keyof MercadoLivreApi, unknown>> = {}): {
  api: MercadoLivreApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    createItem: vi.fn(async () => ITEM_RESPONSE),
    updateItem: vi.fn(async () => ITEM_RESPONSE),
    suggestCategories: vi.fn(async () => [{ category_id: 'MLB31447' }]),
    getCategory: vi.fn(async () => ({ id: 'MLB31447', settings: null })),
    // #1087: the size-chart binding asks whether the category carries a
    // `grid_id` attribute before refusing a publish. `[]` = it does not, which
    // is the CURRENT behaviour for every fixture here — a chart that fails to
    // bind is omitted silently, exactly as before. Only a test that opts into a
    // grid category reaches the refusal.
    getCategoryAttributes: vi.fn(async () => []),
    uploadPicture: vi.fn(async () => ({ id: 'PIC-NEW' })),
    setItemDescription: vi.fn(async () => ({ plain_text: 'ok' })),
    // #798: a FIRST publish probes `GET /users/me` for the `user_product_seller`
    // tag. Untagged by default — every fixture in this file is a legacy-model
    // listing, and an accidental UP resolution would change the payload shape.
    getMe: vi.fn(async () => ({ id: 9, tags: [] as string[] })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

function seedBase(db: FakeDb, opts: { externalIds?: DocData[] | null } = {}): void {
  db.seed('produtos', PROD, {
    nome: 'Camiseta Básica',
    sku: 'SKU-1',
    paiId: null,
    publicado: true,
    precos: { 'lista-1': { valor: 79.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
  });
  db.seed(`produtos/${PROD}/estoques`, 'est-1', {
    depositoOuterRef: 'documents/depositos/dep-1',
    quantidade: 10,
    quantidadeReservada: 2,
  });
  db.seed('arquivos', 'arq-1', {
    filename: 'foto.jpg',
    contentType: 'image/jpeg',
    url: 'https://storage/foto.jpg',
    externalIds: opts.externalIds ?? null,
  });
  // The rascunho the listing editor saves before a first publish. Since #799
  // publish no longer picks the ML category itself (a wrong domain_discovery
  // hit was only discoverable once the listing existed), an unpublished
  // listing must already carry `category_id` on its link doc. `id: null` is
  // what still makes this a create. Tests that need the Flutter-authored shape
  // overwrite this same doc id.
  db.seed(LINKS_PATH, 'ML-DOC-1', {
    contaOuterRef: `documents/integracao/${CONTA}`,
    channels: ['marketplace'],
    estado: 'r',
    id: null,
    site_id: 'MLB',
    title: 'Camiseta Básica',
    category_id: 'MLB31447',
    condition: 'new',
    listing_type_id: 'gold_special',
    isUserProductModel: false,
  });
}

function makeDeps(db: FakeDb, api: MercadoLivreApi): PublishDeps {
  return {
    db: db as unknown as Firestore,
    api,
    integracaoId: CONTA,
    tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
    depositoOuterRef: null,
    // The conta's ML user id, as the route reads it — the removed-variation
    // sweep needs it to enumerate a family (#798).
    sellerUserId: 9,
    listingTypeId: 'gold_special',
    fetchImpl: vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    })) as unknown as typeof globalThis.fetch,
  };
}

/** The Flutter-authored link doc a re-publish must not corrupt. */
const FLUTTER_LINK: DocData = {
  contaOuterRef: `documents/integracao/${CONTA}`,
  channels: ['marketplace', 'mshops'],
  estado: 'pa',
  id: 'MLB777',
  sku: null,
  descricao: 'Descrição custom do vendedor',
  site_id: 'MLB',
  title: 'Título antigo',
  category_id: 'MLB31447',
  condition: 'new',
  listing_type_id: 'gold_pro',
  crossdocking: 3,
  freteGratis: false,
  precoPublicado: 50,
  tarifaFrete: 1.5,
  comissao: 0.11,
  isUserProductModel: false,
  video_id: 'VID-9',
  attributes: null,
  errors: null,
  ultimaModificacao: 1000,
  dataCadastro: 1000,
  campoLegadoDesconhecido: 'preservar',
};

beforeEach(() => {
  // listaDePrecosCache.ts's reader is module-scope and keyed by document PATH
  // only (not by which FakeDb supplied the data) — every test here builds a
  // fresh FakeDb but many reuse the same price-list id ('lista-1'), so a
  // stale cached `nome` would otherwise leak from one test into the next.
  __resetAllReadCaches();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
});

describe('publishProduto — userProductId on the parent link (#706)', () => {
  it('a SIMPLE listing is the stock unit, so it IS stamped', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api } = makeApi({
      createItem: vi.fn(async () => ({ ...ITEM_RESPONSE, user_product_id: 'MLBU-SIMPLE' })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = [...db.docs(LINKS_PATH).values()][0]!;
    expect(link.userProductId).toBe('MLBU-SIMPLE');
  });

  it('⚠️ a LEGACY variations[] listing is NOT stamped — its stock units are the variations', async () => {
    // ML issues a `user_product_id` for every item, 1:1 with the item id, long
    // before a seller is a `user_product_seller`. Stamping it on a listing whose
    // quantities live on its variations would let the send write ONE number for
    // the whole family. Reachable in exactly the #706 scenario: a conta that
    // becomes `warehouse_management` keeps republishing its pre-existing legacy
    // listings through this branch.
    const db = new FakeDb();
    seedBase(db);
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        user_product_id: 'MLBU-ITEM',
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = [...db.docs(LINKS_PATH).values()][0]!;
    expect(link.userProductId).toBeNull();
  });
});

describe('publishProduto — legacy wire shape', () => {
  it('first publish writes canonical documents/-prefixed refs everywhere', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    const result = await publishProduto(makeDeps(db, api), PROD);
    expect(result.itemId).toBe('MLB777');

    const [linkDocId, link] = [...db.docs(LINKS_PATH).entries()][0]!;
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.estado).toBe('p');
    expect(link.id).toBe('MLB777');
    expect(link.errors).toEqual([]);

    const varDocs = [...db.docs('produtos/child-1/variacaoMercadoLivre').values()];
    expect(varDocs).toHaveLength(1);
    expect(varDocs[0]).toMatchObject({
      id: 555,
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/${linkDocId}`,
      sku: 'SKU-1-M',
    });

    // Picture cache appended race-safely (arrayUnion), prefixed path.
    expect(mocks.uploadPicture).toHaveBeenCalledOnce();
    const update = db.updates.find((u) => u.path === 'arquivos/arq-1');
    expect(update).toBeDefined();
    const sentinel = update!.patch.externalIds as FieldValue;
    expect(
      sentinel.isEqual(
        FieldValue.arrayUnion({
          externalId: 'PIC-NEW',
          integracaoPath: `documents/integracao/${CONTA}`,
        }),
      ),
    ).toBe(true);
  });

  it('re-publish preserves every Flutter-authored field (old copyWith semantics)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.updateItem).toHaveBeenCalledOnce();
    expect(mocks.uploadPicture).not.toHaveBeenCalled(); // cache hit
    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // Fields the publish owns are refreshed…
    expect(link).toMatchObject({ estado: 'p', id: 'MLB777', precoPublicado: 79.9, errors: [] });
    // …everything Flutter authored survives untouched.
    expect(link).toMatchObject({
      descricao: 'Descrição custom do vendedor',
      channels: ['marketplace', 'mshops'],
      video_id: 'VID-9',
      crossdocking: 3,
      tarifaFrete: 1.5,
      comissao: 0.11,
      dataCadastro: 1000,
      campoLegadoDesconhecido: 'preservar',
      contaOuterRef: `documents/integracao/${CONTA}`,
    });
    // The link doc's own description wins and rides the replace variant.
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Descrição custom do vendedor',
      { replace: true },
    );
  });

  it('sends and preserves an operator-edited title instead of produto.nome (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // The payload carries the LISTING's title, not the ERP produto name…
    expect(mocks.updateItem!.mock.calls[0]![1]).toMatchObject({ title: 'Título antigo' });
    // …and the publish no longer clobbers it on the way back.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.title).toBe('Título antigo');
  });

  it('sends produto.nome when the link title is blank, without rewriting the doc', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, title: '   ' });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // Blank means absent for the PAYLOAD…
    expect(mocks.updateItem!.mock.calls[0]![1]).toMatchObject({ title: 'Camiseta Básica' });
    // …but `title` is operator-owned, so publish leaves the stored value alone
    // rather than deciding on the operator's behalf what it should have been.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.title).toBe('   ');
  });

  it('does not clobber a concurrent edit made during the ML round trip (rule 7)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        // A second operator edits the listing while we are talking to ML —
        // the window the old read-modify-write silently lost.
        const cur = db.docs(LINKS_PATH).get('ML-DOC-1')!;
        db.seed(LINKS_PATH, 'ML-DOC-1', { ...cur, descricao: 'Editado durante a publicação' });
        return ITEM_RESPONSE;
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // Publish used to re-apply the snapshot it read at the top of the function,
    // reverting this to 'Descrição custom do vendedor'.
    expect(link.descricao).toBe('Editado durante a publicação');
    // Publish-owned fields still land.
    expect(link).toMatchObject({ estado: 'p', id: 'MLB777', errors: [] });
  });

  it('a successful publish clears the PREVIOUS rejection, causes and all', async () => {
    // The regression this exists for: `causas` outliving its `errors` paints a
    // red field on a listing that just published fine, and a stale highlight is
    // indistinguishable from a fresh rejection. The two clear together or the
    // feature is worse than no feature.
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      estado: 'E',
      errors: ['error · item.attributes.missing_required — falta BRAND [item.attributes]'],
      causas: [
        {
          code: 'item.attributes.missing_required',
          causaId: 147,
          tipo: 'error',
          departamento: 'catalog',
          mensagem: 'falta BRAND',
          referencias: ['item.attributes'],
          campos: ['attributes.BRAND'],
        },
      ],
    });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link).toMatchObject({ estado: 'p', errors: [], causas: [] });
  });

  it('recreates a COMPLETE link doc when it was deleted mid-publish, never a ghost', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        db.docs(LINKS_PATH).delete('ML-DOC-1');
        return ITEM_RESPONSE;
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // A live ML listing with no link doc is invisible to every sweep, so the
    // write falls through rather than being dropped…
    expect(link).toMatchObject({ id: 'MLB777', estado: 'p' });
    // …and it is schema-complete, not the key-only ghost merge() would upsert.
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.title).toBe('Título antigo');
    expect(link.site_id).toBe('MLB');
  });

  it('re-derives the child denorm stamp when the doc moves under it (rule 7 tier 1)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    // Another writer lands on the child produto inside the stamp's
    // read-modify-write window, exactly once.
    // The concurrent write lands on `marketplaceIds` — a field the stamp still
    // owns since #920 moved `integracoesComProduto` to the link trigger. Any
    // write fails the `lastUpdateTime` precondition, but only a field the stamp
    // re-derives can show whether the retry RE-DERIVED or blindly re-applied.
    db.afterGet = {
      path: 'produtos/child-1',
      fn: () => {
        const cur = db.docs('produtos').get('child-1')!;
        db.seed('produtos', 'child-1', { ...cur, marketplaceIds: ['concorrente'] });
      },
    };

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    // The first update failed the precondition; the retry re-READ and
    // re-DERIVED, so the concurrent value is folded in rather than erased.
    expect(child.marketplaceIds).toEqual(expect.arrayContaining(['concorrente', '555']) as unknown);
    expect(child.marketplace).toEqual([
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
  });

  it('a link without category_id is blocked, and never asks ML to pick one (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      contaOuterRef: `documents/integracao/${CONTA}`,
      estado: 'r',
      id: null,
      title: 'Camiseta Básica',
      category_id: null,
      listing_type_id: 'gold_special',
    });
    const { api, mocks } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'categoria do Mercado Livre não definida (category_id)',
    );
    // Publish used to silently apply suggestCategories(nome, 1)[0]; a wrong
    // first hit was only discoverable once the listing existed.
    expect(mocks.suggestCategories).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('a produto with no price names the tabela by BOTH nome and id, not just its raw Firestore id', async () => {
    const db = new FakeDb();
    seedBase(db);
    // Same produto seedBase() writes, but with no price under the resolved
    // price-list id ('lista-1', from makeDeps' tabelaNormalOuterRef) —
    // reproduces the "sem preço" block end to end.
    db.seed('produtos', PROD, {
      nome: 'Camiseta Básica',
      sku: 'SKU-1',
      paiId: null,
      publicado: true,
      precos: {},
      fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    });
    db.seed('listaDePrecos', 'lista-1', { nome: 'Tabela Padrão' });
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'produto "Camiseta Básica" sem preço na tabela "Tabela Padrão" (lista-1)',
    );
  });

  it('falls back to the id alone when the price table was never seeded — unchanged pre-fix message', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed('produtos', PROD, {
      nome: 'Camiseta Básica',
      sku: 'SKU-1',
      paiId: null,
      publicado: true,
      precos: {},
      fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    });
    // No `listaDePrecos/lista-1` doc seeded at all.
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'produto "Camiseta Básica" sem preço na tabela lista-1',
    );
  });

  it('writes status/sub_status from the ML response (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        status: 'paused',
        sub_status: ['out_of_stock'],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    // Without these the stock planner reads the fresh listing as a #780
    // legacy-authored doc and sends optimistically for a cycle.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      status: 'paused',
      sub_status: ['out_of_stock'],
      estado: 'pa',
    });
  });

  it('persists the authored attributes and never duplicates the derived ones (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      id: null,
      attributes: [{ id: 'BRAND', value_name: 'Acme' }],
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // SELLER_SKU/WEIGHT/SELLER_PACKAGE_* are rebuilt from the produto on every
    // publish — storing them would grow the array without bound.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.attributes).toEqual([
      { id: 'BRAND', value_name: 'Acme' },
    ]);
    // They still reach ML on the wire.
    const sent = mocks.createItem!.mock.calls[0]![0] as { attributes: Array<{ id: string }> };
    expect(sent.attributes.map((a) => a.id)).toContain('SELLER_SKU');
  });

  it('an ML failure stamps estado E + errors without wiping existing fields', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        // ML's real rejection shape (developers site, *Guia para produtos →
        // Validações*), not a bare message: the whole point of the stamp is
        // that `cause[]` survives onto the doc.
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          message: 'Validation error',
          error: 'validation_error',
          status: 400,
          cause: [
            {
              department: 'catalog',
              cause_id: 147,
              type: 'error',
              code: 'item.attributes.missing_required',
              references: ['item.attributes'],
              message: 'The attributes [BRAND] are required for category MLB1234.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    // ⚠️ NOT `['ML 400: Validation error']`. That headline — all `api.ts` can
    // build out of the body — was the entire diagnosis the operator used to
    // get, for a rejection ML had explained field by field.
    expect(link.errors).toEqual([
      'error · item.attributes.missing_required — The attributes [BRAND] are required for category MLB1234. [item.attributes]',
    ]);
    expect(link.causas).toEqual([
      expect.objectContaining({
        code: 'item.attributes.missing_required',
        causaId: 147,
        tipo: 'error',
        // Resolved against the payload we sent, so the editor can paint the row.
        campos: ['attributes.BRAND'],
      }),
    ]);
    // Previously persisted data survives the stamp.
    expect(link).toMatchObject({
      precoPublicado: 50,
      descricao: 'Descrição custom do vendedor',
      channels: ['marketplace', 'mshops'],
      campoLegadoDesconhecido: 'preservar',
    });
  });

  it('a description failure AFTER the item write still stamps estado E on the doc', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      setItemDescription: vi.fn(async () => {
        throw new MercadoLivreHttpError('description rate limited', 429, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'description rate limited',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // The item itself published (id refreshed), but the failure is on record.
    expect(link.id).toBe('MLB777');
    expect(link.estado).toBe('E');
    expect(link.errors).toEqual(['description rate limited']);
  });

  it('a description failure on a link deleted mid-publish still records the item id', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      setItemDescription: vi.fn(async () => {
        // The operator removes the listing between the item write and the
        // description call — the window a bare merge() would fill with a
        // key-only ghost holding an error and no `id`.
        db.docs(LINKS_PATH).delete('ML-DOC-1');
        throw new MercadoLivreHttpError('description rate limited', 429, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'description rate limited',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // A live ML listing must never end up with no id on record.
    expect(link.id).toBe('MLB777');
    expect(link.estado).toBe('E');
    // …and the recreated doc is schema-complete, not a key-only ghost.
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.title).toBe('Título antigo');
    expect(link.site_id).toBe('MLB');
  });

  it('stamps the parent deprecated arrays in the legacy order-import shape (#431)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const update = db.updates.find((u) => u.path === `produtos/${PROD}`);
    expect(update).toBeDefined();
    // Exact probe shape: {integracaoUid, externalId} — NO relevantData, or the
    // legacy array-contains (exact map equality) would miss it.
    expect(
      (update!.patch.marketplace as FieldValue).isEqual(
        FieldValue.arrayUnion({ integracaoUid: CONTA, externalId: 'MLB777' }),
      ),
    ).toBe(true);
    expect(
      (update!.patch.marketplaceIds as FieldValue).isEqual(FieldValue.arrayUnion('MLB777')),
    ).toBe(true);
    // #920: `integracoesComProduto` is NOT in this patch any more —
    // `onProdutoMercadoLivreLinkChanged` derives it from the link doc written
    // above. Two writers is how a conta gets silently dropped while a live
    // listing exists, so this assertion guards the removal.
    expect(update!.patch).not.toHaveProperty('integracoesComProduto');
  });

  it('stamps each variation child with the legacy cleanup semantics (#431)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
      marketplace: [
        // Stale: same conta + same listing, but an old variation id.
        { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '111' },
        // Parent-shaped entry wrongly on a child — legacy removes it.
        { integracaoUid: CONTA, externalId: 'MLB777' },
        // Another conta's entry must survive untouched.
        { integracaoUid: 'outra-conta', externalParentId: 'MLB999', externalId: '42' },
      ],
      marketplaceIds: ['111'],
      integracoesComProduto: ['outra-conta'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    expect(child.marketplace).toEqual([
      { integracaoUid: 'outra-conta', externalParentId: 'MLB999', externalId: '42' },
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
    expect(child.marketplaceIds).toEqual(['111', '555']);
    // #920: the stamp no longer touches this array — the child's
    // `variacaoMercadoLivre` link carries `contaOuterRef` and
    // `onVariacaoMercadoLivreLinkChanged` derives it. The seeded value must
    // come through untouched, CONTA included only by the trigger.
    expect(child.integracoesComProduto).toEqual(['outra-conta']);
  });

  it('re-publish with an already-correct child entry does not duplicate it (#432 review)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
      // Already exactly what this publish will produce.
      marketplace: [{ integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' }],
      marketplaceIds: ['555'],
      integracoesComProduto: [CONTA],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    expect(child.marketplace).toEqual([
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
    expect(child.marketplaceIds).toEqual(['555']);
    expect(child.integracoesComProduto).toEqual([CONTA]);
  });

  it('does NOT stamp the deprecated arrays when the ML call fails', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('rejected', 400, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('rejected');

    expect(db.updates.find((u) => u.path === `produtos/${PROD}`)).toBeUndefined();
    expect(db.docs('produtos').get(PROD)!.marketplace).toBeUndefined();
  });

  it('binds the tabela de medidas chart end-to-end (SIZE_GRID_*, SIZE swap, descrição, foto)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: [{ arquivoOuterRef: 'arquivos/arq-chart' }],
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: {
          tabelas: [
            {
              id: '1594439',
              nome: 'Camisetas ML',
              domain_id: 'MLB-T_SHIRTS',
              attributes: [],
              rows: [
                {
                  varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
                  id: '1594439:1',
                  attributes: [{ id: 'SIZE', value_name: 'M (38-40)' }],
                },
              ],
            },
          ],
        },
      },
    });
    db.seed('arquivos', 'arq-chart', {
      filename: 'chart.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/chart.jpg',
      externalIds: [{ externalId: 'PIC-CHART', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB31447',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.getCategory).toHaveBeenCalledWith('MLB31447');
    // ⚠️ The KNOWN-GOOD control for the #1087 refusal: a matching domain must
    // still bind and still reach ML. A refusal that fires here would be caught
    // by this line rather than by a live publish.
    expect(mocks.createItem).toHaveBeenCalled();
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = payload.attributes as Array<Record<string, unknown>>;
    expect(attrs).toContainEqual({ id: 'SIZE_GRID_ID', value_name: '1594439' });
    const variation = (payload.variations as Array<Record<string, unknown>>)[0]!;
    expect(variation.attributes).toContainEqual({
      id: 'SIZE_GRID_ROW_ID',
      value_name: '1594439:1',
    });
    // The chart row's SIZE replaces the variante's nome ('M').
    expect(variation.attribute_combinations).toContainEqual({
      id: 'SIZE',
      value_name: 'M (38-40)',
    });
    // Chart photo appended after the produto pictures (cached — no upload).
    expect(payload.pictures).toEqual([{ id: 'PIC-CACHED' }, { id: 'PIC-CHART' }]);
    // No extraData/link description → the tabela text is the whole description.
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: false },
    );
  });

  it('domain mismatch in a category with NO guia → publishes without SIZE_GRID_*, as before', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: [{ arquivoOuterRef: 'arquivos/arq-chart' }],
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: { tabelas: [{ id: '1594439', domain_id: 'MLB-SNEAKERS', rows: [] }] },
      },
    });
    db.seed('arquivos', 'arq-chart', {
      filename: 'chart.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/chart.jpg',
      externalIds: [{ externalId: 'PIC-CHART', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB31447',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    // ⚠️ The CONTROL FOR THE CONTROL (#1087). `getCategoryAttributes` answers
    // `[]`, so this category carries no `grid_id` attribute and ML would accept
    // the listing without a chart — refusing here would break a publish that
    // works today. Without this test the refusal could be universal and every
    // other assertion in this file would still pass.
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = payload.attributes as Array<Record<string, unknown>>;
    expect(attrs.find((a) => a.id === 'SIZE_GRID_ID')).toBeUndefined();
    expect(payload.pictures).toEqual([{ id: 'PIC-CACHED' }, { id: 'PIC-CHART' }]);
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: false },
    );
  });

  it('domain mismatch in a category that USES a guia → refused locally, naming BOTH domains', async () => {
    // ⚠️ The KNOWN-BAD control: the live #1087 case. Chart 7523235 is
    // MLB-SHIRTS, category MLB1398 reports MLB-T_SHIRTS. Before this, publish
    // omitted SIZE_GRID_ID and ML answered `Attribute [SIZE_GRID_ID] is
    // missing` — naming neither domain, though the ERP held both.
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: null,
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: { tabelas: [{ id: '7523235', domain_id: 'MLB-SHIRTS', rows: [] }] },
      },
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      // A fashion category: ML lists SIZE_GRID_ID with value_type `grid_id`.
      getCategoryAttributes: vi.fn(async () => [
        { id: 'BRAND', value_type: 'string' },
        { id: 'SIZE_GRID_ID', value_type: 'grid_id' },
      ]),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivrePublishError);
    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      /MLB-SHIRTS.*MLB-T_SHIRTS/,
    );

    // …and it never reached Mercado Livre. This half is the point: the operator
    // gets the answer without spending a round trip on a rejection.
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('a tabela with NO guia in this conta is refused too — the reason is REACHABLE', async () => {
    // ⚠️ Review finding: this exit hard-coded `categoriaUsaGuia: null`, so
    // `sizeChartIssue` bailed and the carefully-worded message was dead code
    // that read as live. Publish shipped without SIZE_GRID_ID and ML answered
    // with the opaque rejection this PR exists to replace. "Linked a tabela,
    // never created the guia in this conta" is plausibly the most common form
    // of the mistake, so it must refuse like the domain mismatch does.
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: null,
      // Guias exist — on ANOTHER conta.
      tabelasDeMedidasMercadoLivre: {
        'outra-conta': { tabelas: [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }] },
      },
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      getCategoryAttributes: vi.fn(async () => [{ id: 'SIZE_GRID_ID', value_type: 'grid_id' }]),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      /não tem nenhuma guia nesta conta/,
    );
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('…and still publishes when that category uses no guia', async () => {
    // The control: the refusal above must come from the gate, not from the
    // reason existing.
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: null,
      tabelasDeMedidasMercadoLivre: {
        'outra-conta': { tabelas: [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }] },
      },
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);
    expect(mocks.createItem).toHaveBeenCalled();
  });

  it('a getCategory failure during the chart binding stamps estado E (legacy MLError catch)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: null,
      fotos: null,
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: { tabelas: [{ id: '1594439', domain_id: 'MLB-T_SHIRTS', rows: [] }] },
      },
    });
    const { api } = makeApi({
      getCategory: vi.fn(async () => {
        throw new MercadoLivreHttpError('category not found', 404, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('category not found');

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    expect(link.errors).toEqual(['category not found']);
    // Field preservation holds on this stamp path too.
    expect(link.descricao).toBe('Descrição custom do vendedor');
  });

  it("a link doc holding descricao '' falls through — the tabela text still ships", async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, descricao: '' });
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: null,
      tabelasDeMedidasMercadoLivre: null,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: true },
    );
  });

  it('prunes a purged ML picture id from the arquivo cache (picture_not_found)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [
        { externalId: 'PIC-DEAD', integracaoPath: `documents/integracao/${CONTA}` },
        { externalId: 'PIC-OTHER', integracaoPath: 'documents/integracao/outra-conta' },
      ],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('publish failed', 400, {
          cause: [
            {
              code: 'item.pictures.picture_not_found',
              message: 'Picture id PIC-DEAD does not exist.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('publish failed');

    // The dead entry is gone so the next publish re-uploads; the other
    // conta's entry is untouched.
    const arquivo = db.docs('arquivos').get('arq-1')!;
    expect(arquivo.externalIds).toEqual([
      { externalId: 'PIC-OTHER', integracaoPath: 'documents/integracao/outra-conta' },
    ]);
  });
});

describe('publishProduto — kit-aware stock (#797 E5)', () => {
  /** seedBase gives the parent 10 − 2 reservada = 8 of its own. */
  const OWN_DISPONIVEL = 8;

  function seedKit(db: FakeDb, produtoPatch: DocData): void {
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    Object.assign(db.docs('produtos').get(PROD)!, produtoPatch);
  }

  it('a kit publishes its component-min, not its own stock', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      componentesKit: { 'comp-a': { quantidade: 2, limitarEstoque: true } },
    });
    db.seed('produtos', 'comp-a', { nome: 'Malha', paiId: null });
    db.seed('produtos/comp-a/estoques', 'est-a', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 5,
      quantidadeReservada: 0,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // 5 units of a component consumed 2-at-a-time build 2 kits. Before #797 E5
    // this published the kit's OWN 8 — an oversell of four.
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(2);
    expect(payload.available_quantity).not.toBe(OWN_DISPONIVEL);
  });

  it('a component with no estoque at all counts as ZERO, never as unconstrained', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      componentesKit: { 'comp-sem-estoque': { quantidade: 1, limitarEstoque: true } },
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(0);
  });

  it('a VIRTUAL kit still sends a quantity — POST /items requires one', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { 'comp-a': { quantidade: 1, limitarEstoque: true } },
    });
    db.seed('produtos', 'comp-a', { nome: 'Malha', paiId: null });
    db.seed('produtos/comp-a/estoques', 'est-a', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 3,
      quantidadeReservada: 0,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // The sweep's `quantidadeParaEnvio` returns null here meaning "do not push a
    // stock update". Publish must NOT read that as "omit the field": this port
    // never creates a real ML virtual kit (those are User-Products-only), so ML
    // receives a plain POST /items and rejects one with no available_quantity.
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toHaveProperty('available_quantity');
    expect(payload.available_quantity).toBe(3);
  });

  it('a plain produto still publishes its own stock', async () => {
    const db = new FakeDb();
    seedKit(db, {});
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(OWN_DISPONIVEL);
  });
});

describe('publishProduto — per-variation pictures (#797 E7)', () => {
  const AZUL = 'documents/grupoDeVariacoes/g-cor/variacoes/v-azul';
  const PRETO = 'documents/grupoDeVariacoes/g-cor/variacoes/v-preto';

  function seedCores(db: FakeDb): void {
    seedBase(db, {
      externalIds: [
        { externalId: 'PIC-GENERICA', integracaoPath: `documents/integracao/${CONTA}` },
      ],
    });
    // Parent gallery: one untagged photo plus one per colour.
    db.docs('produtos').get(PROD)!.fotos = [
      { arquivoOuterRef: 'arquivos/arq-1' },
      { arquivoOuterRef: 'arquivos/arq-azul', variantePath: AZUL },
      { arquivoOuterRef: 'arquivos/arq-preto', variantePath: PRETO },
    ];
    for (const [arq, pic] of [
      ['arq-azul', 'PIC-AZUL'],
      ['arq-preto', 'PIC-PRETO'],
    ]) {
      db.seed('arquivos', arq!, {
        filename: `${arq}.jpg`,
        contentType: 'image/jpeg',
        url: `https://storage/${arq}.jpg`,
        externalIds: [{ externalId: pic!, integracaoPath: `documents/integracao/${CONTA}` }],
      });
    }
    db.seed('grupoDeVariacoes', 'g-cor', {
      nome: 'Cor',
      tipo: 2,
      variacoes: [
        { id: 'v-azul', nome: 'Azul' },
        { id: 'v-preto', nome: 'Preto' },
      ],
    });
    for (const [id, nome, uid, ordem] of [
      ['child-azul', 'Camiseta Azul', AZUL, 0],
      ['child-preto', 'Camiseta Preta', PRETO, 1],
    ] as const) {
      db.seed('produtos', id, { nome, sku: `SKU-${id}`, paiId: PROD, ordem, variacoesUid: [uid] });
      db.seed(`produtos/${id}/estoques`, 'est', {
        depositoOuterRef: 'documents/depositos/dep-1',
        quantidade: 3,
        quantidadeReservada: 0,
      });
    }
  }

  it('each variation gets the photos tagged for ITS variante', async () => {
    const db = new FakeDb();
    seedCores(db);
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const variations = payload.variations as Array<Record<string, unknown>>;
    // Before #797 E7 `pictureIds` was never populated, so BOTH of these were
    // the parent set — and a republish overwrote the correct per-variation
    // picture_ids ML already held.
    expect(variations[0]!.picture_ids).toEqual(['PIC-AZUL']);
    expect(variations[1]!.picture_ids).toEqual(['PIC-PRETO']);
    expect(variations[0]!.picture_ids).not.toEqual(variations[1]!.picture_ids);
    // The item gallery is untouched — the variation ids are NOT unioned in.
    expect(payload.pictures).toEqual([
      { id: 'PIC-GENERICA' },
      { id: 'PIC-AZUL' },
      { id: 'PIC-PRETO' },
    ]);
  });

  it('an untagged catalogue still falls back to the parent gallery', async () => {
    const db = new FakeDb();
    seedCores(db);
    // Strip the per-colour tags: nothing matches, so rung 3 applies.
    db.docs('produtos').get(PROD)!.fotos = [{ arquivoOuterRef: 'arquivos/arq-1' }];
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const variations = (mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>)
      .variations as Array<Record<string, unknown>>;
    // ML requires every variation to carry a picture.
    expect(variations[0]!.picture_ids).toEqual(['PIC-GENERICA']);
    expect(variations[1]!.picture_ids).toEqual(['PIC-GENERICA']);
  });

  it('resolves each arquivo ONCE per publish, however many children share it', async () => {
    const db = new FakeDb();
    seedCores(db);
    db.docs('produtos').get(PROD)!.fotos = [{ arquivoOuterRef: 'arquivos/arq-1' }];
    // No cached external id → the shared photo must be uploaded exactly once,
    // not once per child (parent + 2 children would be three uploads).
    db.docs('arquivos').get('arq-1')!.externalIds = null;
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.uploadPicture).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * #798 — the publishing MODEL is decided before anything is uploaded, and a
 * User-Products family fans out to ONE ML ITEM PER VARIATION.
 *
 * ML runs two publishing models side by side during its migration.
 * `buildItemPayload` DROPS the variations array for the UP one, so a family sent
 * through it would collapse into a single variation-less item — which is why a
 * family never goes through it at all.
 */
describe('publishProduto — User-Products model resolution (#798)', () => {
  /** Parent + one variation child. */
  function seedFamily(db: FakeDb): void {
    seedBase(db);
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
  }

  /** ...plus a second child, so a fan-out is observably more than one call. */
  function seedFamilyOfTwo(db: FakeDb): void {
    seedFamily(db);
    db.seed('produtos', 'child-2', {
      nome: 'Camiseta G',
      sku: 'SKU-1-G',
      paiId: PROD,
      precos: { 'lista-1': { valor: 89.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
    });
    db.seed('produtos/child-2/estoques', 'est-c2', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 7,
      quantidadeReservada: 0,
    });
    db.docs('grupoDeVariacoes').get('g-tam')!.variacoes = [
      { id: 'v-m', nome: 'M' },
      { id: 'v-g', nome: 'G' },
    ];
  }

  /** A tagged account whose createItem answers a distinct id per call. */
  function upApi(overrides: Record<string, unknown> = {}) {
    let n = 0;
    return makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        id: `MLB90${++n}`,
        family_id: 4260899048783356,
      })),
      // The orphan sweep's hops. Membership == exactly what was published, so
      // the default fixture closes nothing.
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2'] })),
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB901', 'MLB902'] })),
      // Hop three: the sweep PROVES membership before closing, so an id it
      // cannot confirm stays open. Confirms whatever it is asked about — a
      // fixture that wants a refusal overrides this.
      getItemsByIds: vi.fn(async (ids: readonly string[]) =>
        ids.map((id) => ({ code: 200, body: { id, user_product_id: 'MLBU1' } })),
      ),
      ...overrides,
    });
  }

  type MlAttr = { id?: string; value_name?: string };
  const valueOf = (attrs: MlAttr[], id: string): string | undefined =>
    attrs.find((a) => a.id === id)?.value_name;

  /** An established family: the FAMILY id on the parent, item ids on members. */
  function seedPublishedFamily(db: FakeDb, publishedChildren: readonly string[]): void {
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      id: '4260899048783356',
      isUserProductModel: true,
      listing_type_id: 'gold_special',
    });
    publishedChildren.forEach((childId, i) => {
      db.seed(`produtos/${childId}/variacaoMercadoLivre`, `var-${childId}`, {
        itemId: `MLB90${i + 1}`,
        produtoVariacaoOuterRef: `documents/produtos/${childId}`,
        produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
        contaOuterRef: `documents/integracao/${CONTA}`,
      });
    });
  }

  describe('the parent-sku characteristic survives a half-failed fan-out (#1400)', () => {
    const carregaSkuPai = (payload: unknown): boolean =>
      ((payload as { attributes?: Array<{ name?: string }> }).attributes ?? []).some(
        (a) => a.name === ML_ATTR_SKU_PAI_NOME,
      );

    beforeEach(() => {
      process.env[SKU_PAI_ATRIBUTO_FLAG_ENV] = '1';
    });
    afterEach(() => {
      delete process.env[SKU_PAI_ATRIBUTO_FLAG_ENV];
    });

    it('⛔ member 1 created, member 2 rejected → the RETRY finishes the família uniformly', async () => {
      // ⚠️ The split-beyond-repair case. The fan-out is sequential and persists
      // each member as ML confirms it, while the parent link is written once at
      // the end and the failure path (`stampErrorLinkDoc`) never wrote this
      // fact at all. A decision that consulted the PARENT would see "nothing
      // recorded" plus "a member already has an itemId", conclude the família is
      // not new, and create members 2..n WITHOUT the characteristic — beside a
      // sibling that has it, which is a família split no later publish repairs.
      const db = new FakeDb();
      seedFamilyOfTwo(db);

      let n = 0;
      const { api } = upApi({
        createItem: vi.fn(async () => {
          n += 1;
          if (n === 2) throw new MercadoLivreHttpError('ML 400: BODY_INVALID_FIELDS', 400, {});
          return { ...ITEM_RESPONSE, id: 'MLB901', family_id: 4260899048783356 };
        }),
      });
      await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow();

      // Member 1's item WAS created with the characteristic, and its link — the
      // ONLY witness, since the parent link's failure path records none — says so.
      const linkDeChild1 = [...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0];
      expect(linkDeChild1?.itemId).toBe('MLB901');
      expect(linkDeChild1?.skuPaiAtributo).toBe(true);

      // FakeDb artifact, not product behaviour: the failed run stamped the
      // picture cache with a `FieldValue.arrayUnion` sentinel the fake stores
      // verbatim. Clear it so the republish takes the ordinary upload path.
      db.docs('arquivos').get('arq-1')!.externalIds = null;

      // Now the operator fixes the produto and republishes. Every remaining
      // create MUST carry the characteristic.
      const { api: api2, mocks: mocks2 } = upApi();
      await publishProduto(makeDeps(db, api2), PROD);
      expect(mocks2.createItem).toHaveBeenCalled();
      for (const call of mocks2.createItem!.mock.calls) {
        expect(carregaSkuPai(call[0])).toBe(true);
      }
      // …and the member that already existed is UPDATED, never re-created.
      for (const call of mocks2.updateItem!.mock.calls) {
        expect(carregaSkuPai(call[1])).toBe(true);
      }
    });

    it('a família whose members all lack it never gains one — even with the flag on', async () => {
      // The mirror control. Without it the test above would pass on an
      // implementation that simply always sends the characteristic.
      const db = new FakeDb();
      seedFamilyOfTwo(db);
      seedPublishedFamily(db, ['child-1', 'child-2']);

      const { api, mocks } = upApi();
      await publishProduto(makeDeps(db, api), PROD);

      expect(mocks.createItem).not.toHaveBeenCalled();
      expect(mocks.updateItem!.mock.calls.length).toBeGreaterThan(0);
      for (const call of mocks.updateItem!.mock.calls) {
        expect(carregaSkuPai(call[1])).toBe(false);
      }
    });
  });

  it('publishes ONE ML item per variation, sharing a family_name', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api, mocks } = upApi();

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).toHaveBeenCalledTimes(2);
    expect(result.itemIds).toEqual(['MLB901', 'MLB902']);
    for (const call of mocks.createItem!.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(payload.family_name).toBe('Camiseta Básica');
      // Two hard ML rejections: a written title, and any variations array.
      expect(payload.title).toBeUndefined();
      expect(payload.variations).toBeUndefined();
    }
    // Each item IS one variation, so its identity rides the ordinary attributes
    // (`attribute_combinations` does not exist on a User-Products write).
    const attrsOf = (i: number) =>
      (mocks.createItem!.mock.calls[i]![0] as { attributes: MlAttr[] }).attributes;
    expect(valueOf(attrsOf(0), 'SIZE')).toBe('M');
    expect(valueOf(attrsOf(1), 'SIZE')).toBe('G');
    // ...and its own SKU and stock, not the parent's.
    expect(valueOf(attrsOf(0), 'SELLER_SKU')).toBe('SKU-1-M');
    expect(valueOf(attrsOf(1), 'SELLER_SKU')).toBe('SKU-1-G');
    expect(
      mocks.createItem!.mock.calls.map(
        (c) => (c[0] as { available_quantity: number }).available_quantity,
      ),
    ).toEqual([4, 7]);
  });

  /**
   * #1118 review. `buildUserProductItemPayload` sends
   * `attributesWithValue(input.attributes)` minus the member's own overrides, so
   * a valueless or overridden entry SHIFTS every later index. Resolving
   * `item.attributes[0]` against `input.attributes` therefore paints a healthy
   * row red and leaves the offending one clean — the exact outcome the `campos`
   * docblock exists to forbid.
   */
  it('resolves NO control for a positional cause on the family path', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          message: 'Validation error',
          error: 'validation_error',
          status: 400,
          cause: [
            {
              cause_id: 154,
              type: 'error',
              code: 'item.attributes.invalid_length',
              // Positional, and meaningless without the array actually sent.
              references: ['item.attributes[0]'],
              message: 'Invalid value length for attribute.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    // The cause is still PERSISTED and still readable — it just claims no control.
    expect(link.errors).toEqual([
      'error · item.attributes.invalid_length — Invalid value length for attribute. [item.attributes[0]]',
    ]);
    expect(link.causas).toEqual([
      expect.objectContaining({ code: 'item.attributes.invalid_length', campos: [] }),
    ]);
  });

  it('DOES resolve a bracketed id from the message on the family path', async () => {
    // The message scan is index-independent, so dropping the positional
    // resolver costs nothing where ML names the attribute.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          cause: [
            {
              type: 'error',
              code: 'item.attributes.missing_required',
              references: ['item.attributes'],
              message: 'The attributes [BRAND] are required for category MLB1234.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.causas).toEqual([
      expect.objectContaining({ campos: ['attributes.BRAND'] }),
    ]);
  });

  it('records every member itemId on its child link, and the FAMILY id on the parent', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi();

    const result = await publishProduto(makeDeps(db, api), PROD);

    // `itemId` is the field precoPlan/bulkEstoquePlan already read — until now
    // only the importer ever wrote it.
    const m1 = [...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]!;
    const m2 = [...db.docs('produtos/child-2/variacaoMercadoLivre').values()][0]!;
    expect(m1).toMatchObject({
      itemId: 'MLB901',
      sku: 'SKU-1-M',
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
      contaOuterRef: `documents/integracao/${CONTA}`,
    });
    expect(m2).toMatchObject({ itemId: 'MLB902', sku: 'SKU-1-G' });
    // ⚠️ The legacy numeric variation id must stay null: there is no variation
    // object under User Products, and a value here would make
    // `variacaoLinkHasListing` report a legacy listing that does not exist.
    expect(m1.id).toBeNull();

    // The PARENT link carries the FAMILY id — never an item id, or the next
    // republish would `PUT /items/{familyId}`.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      id: '4260899048783356',
      isUserProductModel: true,
      estado: 'p',
      errors: [],
    });
    expect(result.itemId).toBe('4260899048783356');
  });

  it('a republish PUTs each member by ITS OWN itemId, without family_name or price', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    seedPublishedFamily(db, ['child-1', 'child-2']);
    const { api, mocks } = upApi({
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem!.mock.calls.map((c) => c[0])).toEqual(['MLB901', 'MLB902']);
    for (const call of mocks.updateItem!.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      // ML rejects editing family_name once the family has sales, and it feeds
      // the family-id hash — a PUT carrying it could move the member elsewhere.
      expect(payload.family_name).toBeUndefined();
      // Prices belong to the manual price flow and its "baixar preços" guard.
      expect(payload.price).toBeUndefined();
      expect(payload.title).toBeUndefined();
    }
  });

  it('a member added to an existing family POSTs, carrying category and price', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    seedPublishedFamily(db, ['child-1']); // child-2 has never been published
    const { api, mocks } = upApi({
      // Distinct id, so the sweep sees the family exactly as published and this
      // test observes create-vs-update routing and nothing else.
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        id: 'MLB902',
        family_id: 4260899048783356,
      })),
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.updateItem!.mock.calls.map((c) => c[0])).toEqual(['MLB901']);
    expect(mocks.createItem).toHaveBeenCalledOnce();
    // ⚠️ The create-only fields key off the MEMBER, not the family: an
    // established family is `isUpdate` at the listing level, and letting that
    // decide would POST this new member with no category and earn a 400 the
    // operator cannot read.
    expect(mocks.createItem!.mock.calls[0]![0]).toMatchObject({
      // The link's operator-authored title is the family name (#799 bug 4a).
      family_name: 'Título antigo',
      category_id: 'MLB31447',
      listing_type_id: 'gold_special',
      price: 79.9,
    });
  });

  it('a failure mid fan-out keeps the members already confirmed', async () => {
    // Legacy batched every member and committed after the loop, so a failure on
    // the last one discarded the earlier ids while their ML items stayed live —
    // and the retry POSTed them again, duplicating items inside the family.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    let n = 0;
    const { api } = upApi({
      createItem: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new MercadoLivreHttpError('atributo inválido', 400, null);
        return { ...ITEM_RESPONSE, id: 'MLB901', family_id: 4260899048783356 };
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivreHttpError);

    expect([...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]).toMatchObject({
      itemId: 'MLB901',
    });
    expect([...db.docs('produtos/child-2/variacaoMercadoLivre').values()]).toHaveLength(0);
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      estado: 'E',
      errors: ['atributo inválido'],
    });
  });

  it('sends the description to EVERY member, not just the first', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    db.seed(`produtos/${PROD}/extraData`, 'singleton', { descricao: 'Algodão 100%' });
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    // ML replicates title/attributes/pictures across a user product, but NOT
    // the description — that one is per item.
    expect(mocks.setItemDescription!.mock.calls.map((c) => c[0])).toEqual(['MLB901', 'MLB902']);
  });

  it('prices each member from its own tabela entry when propagation is off', async () => {
    // The rule `precoPlan.buildPrecoDrafts` already applies. Publish has to
    // agree with it, or a first publish lands a price the next price sync
    // immediately overwrites.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    db.docs('produtos').get(PROD)!.propagatePriceToChildren = false;
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem!.mock.calls.map((c) => (c[0] as { price: number }).price)).toEqual([
      79.9, 89.9,
    ]);
  });

  it('does NOT clobber a concurrent write to a member link (rule 7)', async () => {
    // `state.raw` is captured in the children loop, BEFORE the grupo reads, the
    // size-chart binding, every picture upload and all N ML calls — so by the
    // time the member link is written that snapshot is stale. Re-applying it
    // wholesale reverts whatever `importVariations` or the `items` status sync
    // — the UPtin takeover included — wrote in between; `parse` even fills
    // defaults for what the snapshot lacks, so it is a clobber and not a merge.
    const db = new FakeDb();
    seedFamily(db); // child-1 only
    seedPublishedFamily(db, ['child-1']);
    const { api } = upApi({
      updateItem: vi.fn(async (id: string, payload: Record<string, unknown>) => {
        // A concurrent writer lands mid-publish, exactly inside the window
        // between the children loop's read and this member's link write.
        //
        // ⚠️ Gated on the MEMBER payload. The orphan sweep also calls
        // `updateItem` — with `{status}` bodies, and AFTER the link write — so an
        // ungated mock re-applied the "concurrent" fields once more at the end
        // and the assertion below passed under a full-clobber implementation.
        //
        // ⚠️ The discriminator is the payload's SIZE, not the absence of a
        // `status` key: since #1087 a family of ONE carries `status: 'active'` on
        // its member PUT too (it stands in for a simple item, which has always
        // reactivated on edit), so "no status" stopped telling the two apart and
        // silently disabled this whole mock.
        if (Object.keys(payload).length > 1) {
          const doc = db.docs('produtos/child-1/variacaoMercadoLivre').get('var-child-1')!;
          doc.attributes = [{ id: 'VOLTAGE', value_name: '220V' }];
          doc.campoLegadoDesconhecido = 'preservar';
        }
        return { ...ITEM_RESPONSE, id, family_id: 4260899048783356 };
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const member = db.docs('produtos/child-1/variacaoMercadoLivre').get('var-child-1')!;
    // Publish's own field landed...
    expect(member.itemId).toBe('MLB901');
    // ...and the concurrent writer's survived. `attributes` in particular is
    // what Flutter rebuilds its next publish's combinations from.
    expect(member.attributes).toEqual([{ id: 'VOLTAGE', value_name: '220V' }]);
    expect(member.campoLegadoDesconhecido).toBe('preservar');
  });

  it('closes the ML item of a variation deleted in the ERP', async () => {
    // "Camiseta G" was removed here; its MLB902 is still live on ML with no
    // produto behind it — the stock sweep would never touch it again and an
    // order for it would land with nothing to decrement.
    const db = new FakeDb();
    seedFamily(db); // child-1 only
    seedPublishedFamily(db, ['child-1']);
    const { api, mocks } = upApi({
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(result.orfaosEncerrados).toEqual(['MLB902']);
    // Pause first, then close — the surviving member is never touched.
    expect(mocks.updateItem!.mock.calls).toEqual([
      ['MLB901', expect.any(Object)],
      ['MLB902', { status: 'paused' }],
      ['MLB902', { status: 'closed' }],
    ]);
  });

  it('a sweep failure never fails a publish that already succeeded', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      getUserProductFamily: vi.fn(async () => {
        throw new MercadoLivreHttpError('indisponível', 503, null);
      }),
    });

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(result.itemIds).toEqual(['MLB901', 'MLB902']);
    expect(result.orfaosEncerrados).toEqual([]);
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ estado: 'p', errors: [] });
  });

  it('prices every member from the anchor by default', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem!.mock.calls.map((c) => (c[0] as { price: number }).price)).toEqual([
      79.9, 79.9,
    ]);
  });

  it('the SAME family publishes normally on an untagged account', async () => {
    const db = new FakeDb();
    seedFamily(db);
    const { api, mocks } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).toHaveBeenCalledOnce();
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.title).toBe('Camiseta Básica');
    expect(payload.family_name).toBeUndefined();
    expect(payload.variations).toHaveLength(1);
  });

  it('a tagged account with NO children publishes in the UP shape', async () => {
    // The other half of the bug: reading only the link doc resolved every first
    // publish to 'legacy', so a simple produto went out with `title` and no
    // `family_name` — which ML rejects once the seller is tagged.
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.family_name).toBe('Camiseta Básica');
    expect(payload.title).toBeUndefined();
    // ...and the resolution is PERSISTED, so the re-publish below needs no probe.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ isUserProductModel: true });
  });

  it('a PUBLISHED legacy listing never probes the account', async () => {
    // Coexistence: an item published before the tag stays editable with the
    // legacy payload. Probing here could only flip it to a shape ML refuses for
    // an already-legacy item — so the call must not happen at all.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(mocks.updateItem).toHaveBeenCalledOnce();
    const payload = mocks.updateItem!.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.family_name).toBeUndefined();
  });

  it('a PUBLISHED User-Products listing with NO children republishes without family_name', async () => {
    // The reported bug: a UP produto that never had variations does NOT go
    // through the family fan-out (`publishModeIssues` lets it past precisely
    // because `link.id` is a real item id, not a family id), so it republishes
    // through `buildItemPayload` — which used to carry `family_name` on the PUT
    // and earned `ML 400 BODY_INVALID_FIELDS / The field family name is
    // invalid` on every attempt.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, isUserProductModel: true });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).toHaveBeenCalledOnce();
    const payload = mocks.updateItem!.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.family_name).toBeUndefined();
    // Nor a `title`: ML derives it from the family name and the attributes.
    expect(payload.title).toBeUndefined();
    // ...and the edit itself still goes out.
    expect(payload.status).toBe('active');
  });

  it("estado 'am' (mid-UPtin) blocks the publish before any ML call", async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, estado: 'am' });
    const { api, mocks } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(/UPtin/);

    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.uploadPicture).not.toHaveBeenCalled();
  });

  it('a getMe failure surfaces as itself AND lands on the link doc', async () => {
    // Two separate contracts. (1) A dead credential must reach the route's
    // 409/502 mapping — swallowing it into a `legacy` guess would publish the
    // wrong payload shape. (2) The module header: every ML failure leaves its
    // reason ON THE DOC, so the ML tab shows why the last attempt failed. The
    // probe is an ML call like any other, so it owes the same stamp.
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => {
        throw new MercadoLivreHttpError('unauthorized', 401, null);
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivreHttpError);
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      estado: 'E',
      errors: ['unauthorized'],
      // Untouched: the probe never learned the model, so the persisted value
      // must survive rather than be guessed at.
      isUserProductModel: false,
    });
  });

  it('a PRE-FLIGHT refusal still writes nothing — it is not an ML failure', async () => {
    // The distinction the stamp above must not blur: `estado: 'am'` is a
    // validation block raised before any ML call, so the doc keeps its state.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, estado: 'am' });
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(/UPtin/);

    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ estado: 'am', errors: null });
  });

  /**
   * #1252 at MEMBER level. The parent link's clear lives in the top-level
   * describe below; this is the `variacaoMercadoLivre` half, which publish writes
   * through `writeMemberLink`.
   *
   * ⚠️ It is asserted from HERE rather than from `publishUserProduct.test.ts`,
   * which mocks the ML API and holds no Firestore at all — a link-doc assertion
   * has nowhere to live there. This block already drives the family fan-out
   * against `FakeDb`, so the write is observable.
   */
  it('clears a member reason ML has stopped reporting, with no moderation call', async () => {
    const db = new FakeDb();
    seedFamily(db);
    db.seed('produtos/child-1/variacaoMercadoLivre', 'var-child-1', {
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
      itemId: 'MLB901',
      moderacoes: [{ nome: 'WATERMARK', motivo: "Marca d'água" }],
    });
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    // ML answered `active` with no sub_status, so the stored reason is stale.
    expect([...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]).toMatchObject({
      status: 'active',
      moderacoes: [],
    });
    // And it cost nothing. ⚠️ Asserted on the API SURFACE, not via
    // `expect(mocks.getLastModeration).toBeUndefined()` — `makeApi`'s mocks are a
    // fixed literal with no such key, so that can never fail and would read as a
    // guard while checking nothing. The surface lacking the endpoint is the real
    // guarantee: a lookup would throw.
    expect(Object.keys(mocks)).not.toContain('getLastModeration');
  });

  /**
   * ⚠️ The other arm. `writeMemberLink`'s patch is `update()`-backed, so OMITTING
   * the key is what leaves a stored reason standing — writing `null` would be a
   * schema violation on a merge and writing `[]` would record a verdict publish
   * never asked for.
   */
  it('leaves a member reason alone while ML is still reporting one', async () => {
    const db = new FakeDb();
    seedFamily(db);
    const moderacao = { nome: 'WATERMARK', motivo: "Marca d'água" };
    db.seed('produtos/child-1/variacaoMercadoLivre', 'var-child-1', {
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
      itemId: 'MLB901',
      moderacoes: [moderacao],
    });
    // ⚠️ Both verbs: a member with a seeded link doc is UPDATED, one without is
    // CREATED, and the fan-out here does each at least once. Overriding only
    // `createItem` leaves the update answering a bare `active` and the assertion
    // then passes for the wrong reason.
    let n = 0;
    const moderado = async () => ({
      ...ITEM_RESPONSE,
      id: `MLB90${++n}`,
      family_id: 4260899048783356,
      status: 'active',
      sub_status: ['poor_quality_thumbnail'],
    });
    const { api } = upApi({
      createItem: vi.fn(moderado),
      updateItem: vi.fn(moderado),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect([...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]).toMatchObject({
      moderacoes: [moderacao],
    });
  });
});

/**
 * #1252 — publish joins the roster of writers that keep `moderacoes` honest.
 *
 * It never asks ML about moderation, and it does not need to: the gate is a pure
 * predicate over the `status`/`sub_status` the create/update response already
 * carried, so a listing ML now calls healthy is written `[]` for free. What that
 * buys is the stale-reason case — a republish of a listing whose moderação ML has
 * since lifted used to leave the old reason standing forever, and a stale
 * moderação on a healthy listing is indistinguishable from a real one.
 */
describe('publishProduto — ML moderations on the parent link (#1252)', () => {
  const MODERACAO = { nome: 'WATERMARK', motivo: "A foto de capa contém marcas d'água." };

  it('CLEARS a reason ML has stopped reporting', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, moderacoes: [MODERACAO] });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // ⚠️ One `toMatchObject` carrying BOTH: the invariant is that the reason and
    // the status it explains move in the same patch, so asserting them apart
    // would pass on a writer that split them.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      status: 'active',
      moderacoes: [],
    });
  });

  /**
   * ⚠️ The case the clear must NOT swallow. `poor_quality_thumbnail` leaves the
   * listing `active` — it is live and merely losing exposure — so a republish
   * succeeds while the moderation is still in force. Clearing on the publish's
   * own authority would erase a live reason.
   */
  it('leaves a reason alone while ML is STILL reporting one', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, moderacoes: [MODERACAO] });
    // ⚠️ `FLUTTER_LINK` carries an `id`, so this is a REPUBLISH — the response
    // comes from `updateItem`, not `createItem`. Overriding the wrong one makes
    // the fixture inert and the test pass for no reason.
    const { api } = makeApi({
      updateItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        status: 'active',
        sub_status: ['poor_quality_thumbnail'],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      sub_status: ['poor_quality_thumbnail'],
      moderacoes: [MODERACAO],
    });
  });

  it('costs no moderation lookup either way — the gate is pure', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // ⚠️ The API surface publish is given has no moderation endpoint, so a
    // lookup would THROW rather than fail an assertion — that absence is the
    // real guard. `expect(mocks.getLastModeration).toBeUndefined()` would be
    // vacuous here: the mocks object is a fixed literal without the key.
    expect(Object.keys(mocks)).not.toContain('getLastModeration');
  });
});

describe('publishProduto — which anúncio a publish targets', () => {
  /**
   * A conta holding TWO listings on one produto. Storage has always allowed
   * this — the schema mints auto-ids and both sweeps loop every link with no
   * `limit(1)` — but the selection here could only ever name the first, so a
   * second anúncio was unpublishable and Publicar silently re-published #1.
   *
   * `ML-DOC-1` comes from `seedBase`; this adds the sibling. Insertion order is
   * what makes `ML-DOC-1` the "first" one, matching the Firestore snapshot order
   * the real query returns.
   */
  function seedSegundoAnuncio(db: FakeDb): void {
    db.seed(LINKS_PATH, 'ML-DOC-2', {
      contaOuterRef: `documents/integracao/${CONTA}`,
      channels: ['marketplace'],
      estado: 'r',
      id: null,
      site_id: 'MLB',
      title: 'Camiseta Básica — Premium',
      category_id: 'MLB31447',
      condition: 'new',
      listing_type_id: 'gold_pro',
      isUserProductModel: false,
    });
  }

  it('publishes the named link doc and leaves its sibling untouched', async () => {
    const db = new FakeDb();
    seedBase(db);
    seedSegundoAnuncio(db);
    const { api, mocks } = makeApi();

    await publishProduto({ ...makeDeps(db, api), linkDocId: 'ML-DOC-2' }, PROD);

    expect(mocks.createItem).toHaveBeenCalledTimes(1);
    // The listing type comes off the TARGETED doc, which is the whole point:
    // reading it off the first link would publish the wrong listing's shape.
    expect(mocks.createItem!.mock.calls[0]![0]).toMatchObject({ listing_type_id: 'gold_pro' });
    expect(db.docs(LINKS_PATH).get('ML-DOC-2')).toMatchObject({ id: 'MLB777', estado: 'p' });
    // Still the rascunho `seedBase` wrote — publish never reached it.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ id: null, estado: 'r' });
  });

  it('falls back to the conta first link when no linkDocId is given', async () => {
    // The regression guard for every existing caller: omitting the id must keep
    // the historical behaviour byte for byte.
    const db = new FakeDb();
    seedBase(db);
    seedSegundoAnuncio(db);
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ id: 'MLB777', estado: 'p' });
    expect(db.docs(LINKS_PATH).get('ML-DOC-2')).toMatchObject({ id: null, estado: 'r' });
  });

  it('refuses an id this conta does not own, without calling ML', async () => {
    // The route 404s this first, so reaching here means the doc moved conta
    // between the two reads — or that someone called the orchestrator directly.
    // Either way it must not publish someone else's listing under this token.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-OUTRA', {
      contaOuterRef: 'documents/integracao/outra-conta',
      estado: 'r',
      id: null,
      site_id: 'MLB',
      title: 'De outra conta',
      category_id: 'MLB31447',
      condition: 'new',
    });
    const { api, mocks } = makeApi();

    await expect(
      publishProduto({ ...makeDeps(db, api), linkDocId: 'ML-DOC-OUTRA' }, PROD),
    ).rejects.toThrow(/não encontrado nesta conta/);
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('refuses an id that does not exist at all', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi();

    await expect(
      publishProduto({ ...makeDeps(db, api), linkDocId: 'ML-DOC-FANTASMA' }, PROD),
    ).rejects.toThrow(/não encontrado nesta conta/);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('treats an empty linkDocId as absent rather than as a doc that cannot exist', async () => {
    // ⚠️ Not because `''` is a plausible doc id — it is not: `.doc('')` throws.
    // (The `link.id !== ''` test elsewhere in this module is about the ML ITEM
    // id, a schema field whose blank value IS in the corpus; a Firestore doc id
    // is a different thing.) It is because a caller threading a falsy variable
    // through should get the default, not a guaranteed refusal.
    const db = new FakeDb();
    seedBase(db);
    const { api } = makeApi();

    await publishProduto({ ...makeDeps(db, api), linkDocId: '' }, PROD);

    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ id: 'MLB777', estado: 'p' });
  });
});

/* ------------------- the User-Products SOLE MEMBER (#1087) ------------------ */

describe('publishProduto — the User-Products sole member (#1087)', () => {
  /** `XMLB000000000000000<parentLinkDocId>vMLB<itemId>` — the importer's own id. */
  const CHILD = 'XMLB000000000000000ML-DOC-1vMLBMLB777';

  function seedPublishedSingle(db: FakeDb): void {
    seedBase(db);
    // A produto published under the OLD convention: User-Products model, a REAL
    // item id on the link (not a family id), and no children.
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      isUserProductModel: true,
      userProductId: 'MLBU-1',
      status: 'active',
      sub_status: [],
    });
  }

  it('⛔ ADOPTS the live listing — it must never POST a second item', async () => {
    // This is the assertion the whole change hangs on. Materialise the child
    // WITHOUT seeding its member link with `link.id` and `findVariacaoLink`
    // returns null, the member counts as new, `createItem` POSTs a duplicate,
    // and `sweepRemovedMembers` then confirms the ORIGINAL as an orphan and
    // pauses-then-closes it — a live, selling listing with its sales history and
    // its search ranking. Do not delete this test.
    const db = new FakeDb();
    seedPublishedSingle(db);
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).toHaveBeenCalled();
    expect(mocks.updateItem!.mock.calls[0]![0]).toBe('MLB777');
  });

  it('seeds the member link with the existing item id, which is what makes it a PUT', async () => {
    const db = new FakeDb();
    seedPublishedSingle(db);
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const member = db.docs(`produtos/${CHILD}/variacaoMercadoLivre`).get(CHILD)!;
    expect(member.itemId).toBe('MLB777');
    expect(member.userProductId).toBe('MLBU-1');
  });

  it('mints the child at the id a later IMPORT would use, so the two converge', async () => {
    const db = new FakeDb();
    seedPublishedSingle(db);
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get(CHILD)!;
    expect(child.paiId).toBe(PROD);
    expect(child.sku).toBe('SKU-1');
    // A sole member has nothing to vary, so it carries no variation taxonomy —
    // exactly what the importer writes for an empty `attribute_combinations`.
    expect(child.variacoesUid).toBeNull();
    expect(child.grupoDeVariacoesUid).toBeNull();
  });

  it('moves the AVAILABLE stock to the child and leaves the reserve on the parent', async () => {
    // 10 in the warehouse, 2 owed to an open pedido whose release decrements the
    // PARENT. The sweep prices a family off its children, so the child must own
    // the sellable 8 — but moving the 2 as well would strand that release.
    const db = new FakeDb();
    seedPublishedSingle(db);
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(db.docs(`produtos/${CHILD}/estoques`).get(`est-${CHILD}-dep-1`)!.quantidade).toBe(8);
    expect(db.docs(`produtos/${PROD}/estoques`).get('est-1')!.quantidade).toBe(2);
  });

  it('is idempotent — publishing twice leaves ONE child and does not re-move stock', async () => {
    const db = new FakeDb();
    seedPublishedSingle(db);
    // The picture must resolve from cache on the second pass; re-uploading is a
    // different code path and not what this test is about.
    db.seed('arquivos', 'arq-1', {
      filename: 'foto.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/foto.jpg',
      externalIds: [{ integracaoPath: `documents/integracao/${CONTA}`, id: 'PIC-1' }],
    });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);
    await publishProduto(makeDeps(db, api), PROD);

    const filhos = [...db.docs('produtos').keys()].filter((id) => id !== PROD);
    expect(filhos).toEqual([CHILD]);
    // The second pass must NOT copy the parent's now-reduced quantity over the
    // child's good row.
    expect(db.docs(`produtos/${CHILD}/estoques`).get(`est-${CHILD}-dep-1`)!.quantidade).toBe(8);
  });

  it('⛔ a LOST race applies NOTHING — the reshape is all-or-nothing', async () => {
    // The defect this guards is unrecoverable, not untidy: once the child produto
    // exists the produto HAS children, so `classificarMembroUnico` answers
    // `'nenhum'` and `garantirMembroUnico` is never entered again. A half-applied
    // reshape would therefore be permanent — stock stranded on the parent for ever,
    // or counted twice — with no later run able to finish it.
    //
    // Here a concurrent publish mints the child in the window between our existence
    // check and our commit, so our `batch.create` loses with ALREADY_EXISTS. What
    // must be true afterwards is that our OTHER three writes did not land either.
    const db = new FakeDb();
    seedPublishedSingle(db);
    db.afterGet = {
      path: `produtos/${CHILD}`,
      fn: () => db.seed('produtos', CHILD, { nome: 'vencedor da corrida', paiId: PROD }),
    };
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // eslint-disable-next-line no-console
    // ⛔ The loser must STILL end up adopting. Its batch — the one that would have
    // written the member link — is exactly the one that failed, so without a
    // recovery here `findVariacaoLink` finds nothing, the member counts as new, and
    // this POSTs a SECOND ML item that the orphan sweep then closes the original
    // for. Measured: before the recovery existed, this was `createItem: 1`.
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).toHaveBeenCalled();

    // The parent's stock is untouched — not reduced by a delta whose child row
    // never materialised.
    expect(db.docs(`produtos/${PROD}/estoques`).get('est-1')!.quantidade).toBe(10);
    // ...and no child estoque row was left behind on its own.
    expect(db.docs(`produtos/${CHILD}/estoques`).size).toBe(0);
    // The winner's document stands; we did not overwrite it.
    expect(db.docs('produtos').get(CHILD)!.nome).toBe('vencedor da corrida');
  });

  it('still REFUSES a family id with no children — that one is not repairable here', async () => {
    // `link.id` all digits means the ERP variations were deleted out from under a
    // family that may still have live ML members. Materialising a sole member
    // there would POST into it and the sweep would orphan the siblings.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, isUserProductModel: true, id: '426089904' });
    const { api, mocks } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivrePublishError);
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });
});

/**
 * WHY no chart bound — one assertion per structurally different cause (#1087).
 *
 * ⚠️ This block exists because the four `{resolved: null}` exits used to be
 * INDISTINGUISHABLE. A test asserting only "publish refused" cannot tell a
 * domain mismatch from a missing tabela doc, which is the very conflation the
 * change is fixing — so each reason is pinned with `toEqual` on the whole
 * object, payload included.
 */
describe('loadTabelaBinding — why no chart bound (#1087)', () => {
  const TABELA_REF = 'documents/tabMedi/tm-1';

  /** The conta's guias, wrapped in the nested map the tabMedi doc stores. */
  function seedTabela(db: FakeDb, tabelas: unknown[], over: Record<string, unknown> = {}): void {
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: 'Confira as medidas.',
      tabelasDeMedidasMercadoLivre: { [CONTA]: { tabelas } },
      ...over,
    });
  }

  const camisetas = [{ id: '7523235', domain_id: 'MLB-SHIRTS', rows: [] }];

  /** A fashion category — ML lists SIZE_GRID_ID with value_type `grid_id`. */
  const COM_GUIA = [{ id: 'SIZE_GRID_ID', value_type: 'grid_id' }];

  function bind(
    db: FakeDb,
    api: MercadoLivreApi,
    produto: { tabelaDeMedidasModaUid?: string | null },
    categoryId: string | null = 'MLB1398',
  ) {
    return loadTabelaBinding(makeDeps(db, api), produto, null, categoryId, []);
  }

  it('produto names no tabela → produto-sem-tabela, and no ML call at all', async () => {
    const { api, mocks } = makeApi();
    const out = await bind(new FakeDb(), api, {});
    expect(out.motivo).toEqual({ codigo: 'produto-sem-tabela' });
    expect(out.resolved).toBeNull();
    // Never asked — a third value, distinct from `false`, and it refuses nothing.
    expect(out.categoriaUsaGuia).toBeNull();
    expect(mocks.getCategory).not.toHaveBeenCalled();
    expect(mocks.getCategoryAttributes).not.toHaveBeenCalled();
  });

  it('the tabela doc is gone → tabela-inexistente (a dangling ref, NOT a mismatch)', async () => {
    const { api, mocks } = makeApi();
    const out = await bind(new FakeDb(), api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({ codigo: 'tabela-inexistente', tabMediId: 'tm-1' });
    // Paths 1 and 2 also drop the descrição and the photo — there is no doc to
    // read them from. Paths 3 and 4 keep both.
    expect(out.descricao).toBeNull();
    expect(out.foto).toBeNull();
    expect(mocks.getCategory).not.toHaveBeenCalled();
    // ⚠️ It DOES ask whether the category uses a guia. Hard-coding `null` here
    // left this reason unable to refuse anything — a message that read as live
    // and was dead code.
    expect(out.categoriaUsaGuia).toBe(false);
  });

  it('no guia in THIS conta → tabela-sem-guias-nesta-conta, descrição kept', async () => {
    const db = new FakeDb();
    seedTabela(db, [], { tabelasDeMedidasMercadoLivre: { 'outra-conta': { tabelas: camisetas } } });
    const { api, mocks } = makeApi();
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({
      codigo: 'tabela-sem-guias-nesta-conta',
      tabMediId: 'tm-1',
      nome: 'Camiseta lisa infantil',
    });
    expect(out.descricao).toBe('Confira as medidas.');
    expect(mocks.getCategory).not.toHaveBeenCalled();
    expect(out.categoriaUsaGuia).toBe(false);
  });

  it('the anúncio has no categoria → anuncio-sem-categoria, told apart from the line above', async () => {
    // ⚠️ These two share ONE exit in the source (`charts.length === 0 ||
    // !categoryId`). Same branch, different fact, different fix.
    const db = new FakeDb();
    seedTabela(db, camisetas);
    const { api, mocks } = makeApi();
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF }, null);
    expect(out.motivo).toEqual({ codigo: 'anuncio-sem-categoria', tabMediId: 'tm-1' });
    expect(mocks.getCategory).not.toHaveBeenCalled();
    // The one exit that stays `null`: with no category there is nothing to ask.
    expect(out.categoriaUsaGuia).toBeNull();
    expect(mocks.getCategoryAttributes).not.toHaveBeenCalled();
  });

  it('the category reports no catalog_domain → categoria-sem-dominio', async () => {
    const db = new FakeDb();
    seedTabela(db, camisetas);
    const { api } = makeApi({
      getCategory: vi.fn(async () => ({ id: 'MLB1398', settings: null })),
      getCategoryAttributes: vi.fn(async () => COM_GUIA),
    });
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({ codigo: 'categoria-sem-dominio', categoryId: 'MLB1398' });
    expect(out.categoriaUsaGuia).toBe(true);
  });

  it('the live case → dominio-divergente carrying BOTH domain strings', async () => {
    const db = new FakeDb();
    seedTabela(db, camisetas);
    const { api } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      getCategoryAttributes: vi.fn(async () => COM_GUIA),
    });
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({
      codigo: 'dominio-divergente',
      categoryId: 'MLB1398',
      nome: 'Camiseta lisa infantil',
      dominiosDaTabela: ['MLB-SHIRTS'],
      dominioDaCategoria: 'MLB-T_SHIRTS',
    });
    expect(out.categoriaUsaGuia).toBe(true);
  });

  it('the guia in the RIGHT domain was never sent → guias-nao-enviadas', async () => {
    const db = new FakeDb();
    seedTabela(db, [{ id: null, domain_id: 'MLB-T_SHIRTS', rows: [] }]);
    const { api } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      getCategoryAttributes: vi.fn(async () => COM_GUIA),
    });
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({
      codigo: 'guias-nao-enviadas',
      categoryId: 'MLB1398',
      dominioDaCategoria: 'MLB-T_SHIRTS',
      nome: 'Camiseta lisa infantil',
    });
  });

  it('right domain, wrong gênero → sem-atributos-correspondentes', async () => {
    const db = new FakeDb();
    seedTabela(db, [
      {
        id: '7523235',
        domain_id: 'MLB-T_SHIRTS',
        attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
        rows: [],
      },
    ]);
    const { api } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      getCategoryAttributes: vi.fn(async () => COM_GUIA),
    });
    const out = await loadTabelaBinding(
      makeDeps(db, api),
      { tabelaDeMedidasModaUid: TABELA_REF },
      { docId: 'ML-DOC-1', id: null, attributes: [{ id: 'GENDER', value_id: '19159491' }] },
      'MLB1398',
      [],
    );
    expect(out.motivo).toEqual({
      codigo: 'sem-atributos-correspondentes',
      categoryId: 'MLB1398',
      dominioDaCategoria: 'MLB-T_SHIRTS',
      nome: 'Camiseta lisa infantil',
    });
  });

  it('a bound chart reports vinculada, and pays for NO attributes call', async () => {
    // The happy path must not gain an ML round trip: the attribute list exists
    // only to gate a refusal, and there is nothing to refuse here.
    const db = new FakeDb();
    seedTabela(db, [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }]);
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB1398',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
    });
    const out = await bind(db, api, { tabelaDeMedidasModaUid: TABELA_REF });
    expect(out.motivo).toEqual({ codigo: 'vinculada', chartId: '7523235' });
    expect(out.resolved).toEqual({ chartId: '7523235', rowByChildId: {} });
    expect(mocks.getCategoryAttributes).not.toHaveBeenCalled();
  });
});

/**
 * The tabela's chart photo on a User-Products FAMILY (#1087).
 *
 * ⚠️ Under User Products the parent is NOT a listing — every published item is a
 * family MEMBER, and a member's own `pictures` come from its `pictureIds`
 * (`itemPayload.ts`: `member.pictureIds ?? parentPictureIds`). The chart photo
 * rode only the parent set, so any produto whose photos are TAGGED PER VARIANTE
 * gave every member a non-empty own set and lost the chart image entirely —
 * measured on produto LYXqJKB96YJzhA3qaVkn, whose member came back from ML with
 * 3 pictures and no chart. The photo was uploaded and cached either way, so the
 * cost was paid and the result discarded.
 *
 * ⚠️ The fixture is the configuration that DROPS it: children with no fotos of
 * their own, parent photos tagged per variante. A child with its own fotos
 * takes the same branch and would mask nothing — but a child with NO tagged
 * parent photo either falls to the parent set, which already carries the chart.
 */
describe('publishProduto — the chart photo on a User-Products family (#1087)', () => {
  /** `fotosForVariacao` rung 2: a parent foto tagged for this child's variante. */
  const TAGGED = 'documents/grupoDeVariacoes/g-tam/variacoes/v-m';

  function seedChartFamily(db: FakeDb, extraParentFotos: DocData[] = []): void {
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    // ⚠️ TAGGED, so the child resolves pictures OF ITS OWN and never falls
    // through to the parent set. That fall-through is the only path that
    // carried the chart photo before this fix.
    db.docs('produtos').get(PROD)!.fotos = [
      { arquivoOuterRef: 'arquivos/arq-1', variantePath: TAGGED },
      ...extraParentFotos,
    ];
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: null,
      fotos: [{ arquivoOuterRef: 'arquivos/arq-chart' }],
    });
    db.seed('arquivos', 'arq-chart', {
      filename: 'chart.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/chart.jpg',
      externalIds: [{ externalId: 'PIC-CHART', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    // The child carries NO fotos of its own — rung 2 is what feeds it.
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: [TAGGED],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
  }

  function upChartApi(overrides: Record<string, unknown> = {}) {
    let n = 0;
    return makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        id: `MLB90${++n}`,
        family_id: 4260899048783356,
      })),
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1'] })),
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB901'] })),
      getItemsByIds: vi.fn(async (ids: readonly string[]) =>
        ids.map((id) => ({ code: 200, body: { id, user_product_id: 'MLBU1' } })),
      ),
      ...overrides,
    });
  }

  /** The pictures the MEMBER item was POSTed with. */
  function memberPictures(mocks: Record<string, ReturnType<typeof vi.fn>>): string[] {
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    return ((payload.pictures ?? []) as Array<{ id: string }>).map((p) => p.id);
  }

  it('sends the chart photo on the MEMBER — the listing the buyer actually opens', async () => {
    const db = new FakeDb();
    seedChartFamily(db);
    const { api, mocks } = upChartApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(memberPictures(mocks)).toEqual(['PIC-CACHED', 'PIC-CHART']);
  });

  it('pays for NO extra upload — the chart photo is cached on its Arquivo', async () => {
    // It was already being uploaded before this fix and then discarded; adding
    // it to the member must reuse the same memoised id, not fetch it again.
    const db = new FakeDb();
    seedChartFamily(db);
    const { api, mocks } = upChartApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.uploadPicture).not.toHaveBeenCalled();
  });

  it('a member with NO pictures of its own still inherits the PARENT set', async () => {
    // `publish.ts` skips a member that resolved nothing so the mapper falls back
    // to `parentPictureIds`, which already carries the chart photo.
    //
    // ⚠️ This does NOT discriminate the two placements: a member resolves zero
    // pictures only when the produto has no resolvable fotos at all, and then
    // the parent set is the chart photo alone, so both answer `['PIC-CHART']`.
    // Measured, not assumed — the cap test below is the one that separates them.
    const db = new FakeDb();
    seedChartFamily(db);
    // Untagged parent foto + a child whose variante matches nothing ⇒ rung 3
    // returns the whole parent gallery, so this child still has pictures. To
    // reach the EMPTY case the produto must have no resolvable fotos at all.
    db.docs('produtos').get(PROD)!.fotos = [];
    const { api, mocks } = upChartApi();

    await publishProduto(makeDeps(db, api), PROD);

    // The parent set is the chart photo alone here, and the member inherits it
    // rather than being handed a second, differently-built copy.
    expect(memberPictures(mocks)).toEqual(['PIC-CHART']);
  });

  it('⚠️ an INHERITING member publishes the parent set — 11 pictures, not MAX_PICTURES', async () => {
    // ⚠️ The bound above is about the list this branch builds, NOT about every
    // member. A member that resolves nothing inherits `parentPictureIds`, which
    // is built by the PARENT rule and legitimately reaches 11. Harmless — ML
    // accepts 12 — but the comment first read as a universal invariant and was
    // not one. Pinned so the claim is checkable rather than asserted.
    const db = new FakeDb();
    const extras = Array.from({ length: 9 }, (_, i) => ({
      arquivoOuterRef: `arquivos/arq-x${String(i)}`,
    }));
    seedChartFamily(db, extras);
    // Untagged parent fotos ⇒ 10 in the parent set, + the chart photo = 11.
    db.docs('produtos').get(PROD)!.fotos = [{ arquivoOuterRef: 'arquivos/arq-1' }, ...extras];
    for (let i = 0; i < 9; i++) {
      db.seed('arquivos', `arq-x${String(i)}`, {
        filename: `x${String(i)}.jpg`,
        contentType: 'image/jpeg',
        url: `https://storage/x${String(i)}.jpg`,
        externalIds: [
          { externalId: `PIC-X${String(i)}`, integracaoPath: `documents/integracao/${CONTA}` },
        ],
      });
    }
    // ⚠️ rung 1 wins on a NON-EMPTY own list even when every entry is
    // unresolvable, so this child resolves ZERO pictures and takes the
    // `continue` — the only way to reach the inherit path with a full parent.
    db.docs('produtos').get('child-1')!.fotos = [{ arquivoOuterRef: 'arquivos/sumiu' }];
    const { api, mocks } = upChartApi();

    await publishProduto(makeDeps(db, api), PROD);

    const pics = memberPictures(mocks);
    expect(pics).toHaveLength(11);
    expect(pics[10]).toBe('PIC-CHART');
  });

  it('⚠️ at the cap it REPLACES the last picture, never overflows and never drops', async () => {
    // The legacy VARIATION lists' rule. `resolvePictures` slices a member to
    // MAX_PICTURES (10); the chart photo takes the last slot rather than
    // becoming an 11th, which is a liberty only the parent set takes.
    const db = new FakeDb();
    const extras = Array.from({ length: 11 }, (_, i) => ({
      arquivoOuterRef: `arquivos/arq-x${String(i)}`,
      variantePath: TAGGED,
    }));
    seedChartFamily(db, extras);
    for (let i = 0; i < 11; i++) {
      db.seed('arquivos', `arq-x${String(i)}`, {
        filename: `x${String(i)}.jpg`,
        contentType: 'image/jpeg',
        url: `https://storage/x${String(i)}.jpg`,
        externalIds: [
          { externalId: `PIC-X${String(i)}`, integracaoPath: `documents/integracao/${CONTA}` },
        ],
      });
    }
    const { api, mocks } = upChartApi();

    await publishProduto(makeDeps(db, api), PROD);

    const pics = memberPictures(mocks);
    expect(pics).toHaveLength(10);
    expect(pics[9]).toBe('PIC-CHART');
    // …and it replaced a picture rather than being dropped or appended.
    expect(pics).not.toContain('PIC-X8');
  });

  it('⚠️ the LEGACY path is untouched — the chart photo stays at ITEM level', async () => {
    // ⚠️ The control. Legacy sends ONE item whose top-level `pictures` carries
    // the chart photo, with per-variation `picture_ids` beside it — correct
    // before this change. Without this assertion the fix could silently move
    // the chart photo into every variation's list and every other test here
    // would still pass.
    const db = new FakeDb();
    seedChartFamily(db);
    const { api, mocks } = makeApi(); // untagged account ⇒ legacy model

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const itemPics = ((payload.pictures ?? []) as Array<{ id: string }>).map((p) => p.id);
    expect(itemPics).toEqual(['PIC-CACHED', 'PIC-CHART']);
    const variation = (payload.variations as Array<Record<string, unknown>>)[0]!;
    expect(variation.picture_ids).toEqual(['PIC-CACHED']);
  });
});

/**
 * Every refusal reason is REACHABLE, and refuses (#1087).
 *
 * ⚠️ This exists because a carefully-worded refusal message shipped as dead
 * code. The exits hard-coded `categoriaUsaGuia: null`, `sizeChartIssue` bails
 * on `!== true`, and `publishCore.test.ts` hand-builds the motivo and passes
 * `categoriaUsaGuia: true` directly — so the unit tests could never notice. The
 * guard below closes that by driving the REAL `loadTabelaBinding` and feeding
 * `sizeChartIssue` the values it actually produced.
 *
 * ⚠️ Both directions, like the repo's other inventories: an UNREACHABLE codigo
 * fails, and a codigo missing from the fixture table fails. Without the second,
 * adding a tenth reason and forgetting to cover it passes silently.
 */
describe('every tabela-binding reason is reachable and refuses as declared (#1087)', () => {
  const TABELA_REF = 'documents/tabMedi/tm-1';
  const COM_GUIA = [{ id: 'SIZE_GRID_ID', value_type: 'grid_id' }];

  function seed(db: FakeDb, tabelas: unknown[], over: Record<string, unknown> = {}): void {
    db.seed('tabMedi', 'tm-1', {
      nome: 'Camiseta lisa infantil',
      codigo: null,
      descricao: null,
      tabelasDeMedidasMercadoLivre: { [CONTA]: { tabelas } },
      ...over,
    });
  }

  const categoria = (catalogDomain: string | null) =>
    vi.fn(async () => ({
      id: 'MLB1398',
      settings: catalogDomain == null ? null : { catalog_domain: catalogDomain },
    }));

  /**
   * One fixture per codigo, each driving the real `loadTabelaBinding`.
   *
   * ⚠️ `categoriaUsaGuia` is never set by hand — it comes back from the binding,
   * which is the whole point: that field being `null` is exactly how two of
   * these reasons became unable to refuse.
   */
  const FIXTURES: Record<
    keyof typeof TABELA_BINDING_RECUSA,
    () => Promise<{ motivo: TabelaBindingMotivo; categoriaUsaGuia: boolean | null }>
  > = {
    vinculada: async () => {
      const db = new FakeDb();
      seed(db, [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }]);
      const { api } = makeApi({ getCategory: categoria('MLB-T_SHIRTS') });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'produto-sem-tabela': async () => {
      const { api } = makeApi();
      return loadTabelaBinding(makeDeps(new FakeDb(), api), {}, null, 'MLB1398', []);
    },
    'tabela-inexistente': async () => {
      const { api } = makeApi({ getCategoryAttributes: vi.fn(async () => COM_GUIA) });
      return loadTabelaBinding(
        makeDeps(new FakeDb(), api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'tabela-sem-guias-nesta-conta': async () => {
      const db = new FakeDb();
      seed(db, [], {
        tabelasDeMedidasMercadoLivre: {
          'outra-conta': { tabelas: [{ id: '1', domain_id: 'MLB-T_SHIRTS', rows: [] }] },
        },
      });
      const { api } = makeApi({ getCategoryAttributes: vi.fn(async () => COM_GUIA) });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'anuncio-sem-categoria': async () => {
      const db = new FakeDb();
      seed(db, [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }]);
      const { api } = makeApi();
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        null,
        [],
      );
    },
    'categoria-sem-dominio': async () => {
      const db = new FakeDb();
      seed(db, [{ id: '7523235', domain_id: 'MLB-T_SHIRTS', rows: [] }]);
      const { api } = makeApi({
        getCategory: categoria(null),
        getCategoryAttributes: vi.fn(async () => COM_GUIA),
      });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'guias-nao-enviadas': async () => {
      const db = new FakeDb();
      seed(db, [{ id: null, domain_id: 'MLB-T_SHIRTS', rows: [] }]);
      const { api } = makeApi({
        getCategory: categoria('MLB-T_SHIRTS'),
        getCategoryAttributes: vi.fn(async () => COM_GUIA),
      });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'dominio-divergente': async () => {
      const db = new FakeDb();
      seed(db, [{ id: '7523235', domain_id: 'MLB-SHIRTS', rows: [] }]);
      const { api } = makeApi({
        getCategory: categoria('MLB-T_SHIRTS'),
        getCategoryAttributes: vi.fn(async () => COM_GUIA),
      });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        null,
        'MLB1398',
        [],
      );
    },
    'sem-atributos-correspondentes': async () => {
      const db = new FakeDb();
      seed(db, [
        {
          id: '7523235',
          domain_id: 'MLB-T_SHIRTS',
          attributes: [{ id: 'GENDER', value_id: '339665' }],
          rows: [],
        },
      ]);
      const { api } = makeApi({
        getCategory: categoria('MLB-T_SHIRTS'),
        getCategoryAttributes: vi.fn(async () => COM_GUIA),
      });
      return loadTabelaBinding(
        makeDeps(db, api),
        { tabelaDeMedidasModaUid: TABELA_REF },
        { docId: 'ML-DOC-1', id: null, attributes: [{ id: 'GENDER', value_id: '19159491' }] },
        'MLB1398',
        [],
      );
    },
  };

  it('covers every declared codigo — no more, no fewer', () => {
    // The compile error catches a NEW codigo; this catches the fixture table not
    // being widened to match it.
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(TABELA_BINDING_RECUSA).sort());
  });

  it('every codigo is REACHABLE — its fixture actually produces it', async () => {
    for (const [codigo, fixture] of Object.entries(FIXTURES)) {
      // ⚠️ The category read cache is process-scoped and keyed on the category
      // id alone, so without this every fixture after the first is served the
      // FIRST one's `settings` and resolves against the wrong domain. The
      // suite's own beforeEach cannot help — these all run inside one `it`.
      __resetAllReadCaches();
      const { motivo } = await fixture();
      expect(motivo.codigo, `fixture for '${codigo}' produced '${motivo.codigo}'`).toBe(codigo);
    }
  });

  it('⚠️ each codigo refuses exactly as TABELA_BINDING_RECUSA declares', async () => {
    // ⚠️ `categoriaUsaGuia` comes from the BINDING, never hand-set — a reason
    // whose exit forgets to ask cannot refuse, and that is what shipped.
    for (const [codigo, fixture] of Object.entries(FIXTURES)) {
      __resetAllReadCaches(); // see the ⚠️ above
      const { motivo, categoriaUsaGuia } = await fixture();
      const issue = sizeChartIssue(motivo, categoriaUsaGuia);
      const deveRecusar = TABELA_BINDING_RECUSA[codigo as keyof typeof TABELA_BINDING_RECUSA];
      expect(
        issue != null,
        deveRecusar
          ? `'${codigo}' is declared refusable but produced no issue — is its exit still ` +
              'answering `categoriaUsaGuia: null`?'
          : `'${codigo}' is declared silent but produced: ${String(issue)}`,
      ).toBe(deveRecusar);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('#1087 — the sweep and publish must compute the SAME quantity', () => {
  /**
   * ⚠️ **The acceptance criterion of #1087, and the reason it is asserted as an
   * EQUALITY rather than against hand-written numbers.**
   *
   * Before #1087 the two sides disagreed by design: publish sent a virtual
   * kit's component-min (`POST /items` requires `available_quantity`) while the
   * sweep refused to send at all, so the listing froze at its publish-time
   * quantity for ever and oversold. Making the sweep send is only half a fix —
   * if it now sends a DIFFERENT number, the first sweep after a publish
   * silently changes the advertised quantity, which is a new bug wearing the
   * fix's clothes.
   *
   * A number written into this file could not catch that: it would pin one side
   * and let the other drift toward it. Comparing the two functions to each
   * other is what makes the disagreement impossible to introduce. It holds
   * today because `quantidadeParaPublicar` IS `quantidadeParaEnvio` with the
   * escape hatch pinned off — the test's job is to notice if that ever stops
   * being true.
   */
  const CASOS: Array<{
    nome: string;
    produto: { ehKit: boolean; ehKitVirtual: boolean; componentesKit: ComponentesKit | null };
    own: number;
    componentes: Record<string, number>;
  }> = [
    {
      nome: 'virtual kit constrained by two components (min, not own stock)',
      produto: {
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: {
          A: { quantidade: 1, limitarEstoque: true, timestamp: null },
          B: { quantidade: 1, limitarEstoque: true, timestamp: null },
        },
      },
      own: 50,
      componentes: { A: 5, B: 3 },
    },
    {
      nome: 'virtual kit whose components divide (floored min)',
      produto: {
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: {
          A: { quantidade: 2, limitarEstoque: true, timestamp: null },
          B: { quantidade: 3, limitarEstoque: true, timestamp: null },
        },
      },
      own: 100,
      componentes: { A: 10, B: 9 },
    },
    {
      nome: 'virtual kit with NO constraining component → own stock',
      produto: { ehKit: true, ehKitVirtual: true, componentesKit: null },
      own: 12,
      componentes: {},
    },
    {
      nome: 'virtual kit whose component has no estoque → 0, never unconstrained (#238)',
      produto: {
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
      },
      own: 40,
      componentes: {},
    },
    {
      // ⚠️ The near-miss. `ehKitVirtual` without `ehKit` must STILL take the kit
      // branch on both sides; keying it on `ehKit` alone answers `own` — a wrong
      // number rather than a refusal, and nothing reports it.
      nome: 'ehKitVirtual WITHOUT ehKit still takes the kit branch',
      produto: {
        ehKit: false,
        ehKitVirtual: true,
        componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
      },
      own: 50,
      componentes: { A: 4 },
    },
    {
      nome: 'an ORDINARY kit, the control that was never in dispute',
      produto: {
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: { A: { quantidade: 2, limitarEstoque: true, timestamp: null } },
      },
      own: 99,
      componentes: { A: 7 },
    },
  ];

  it.each(CASOS)('agrees on: $nome', ({ produto, own, componentes }) => {
    const doSweep = quantidadeDoMembro({
      produtoId: 'P',
      ehKit: produto.ehKit,
      ehKitVirtual: produto.ehKitVirtual,
      publicado: true,
      componentesKit: produto.componentesKit,
      timestampMs: null,
      estoque: { quantidade: own, quantidadeReservada: 0 },
      componentEstoques: Object.entries(componentes).map(([parentId, quantidade]) => ({
        parentId,
        quantidade,
        quantidadeReservada: 0,
      })),
    });
    const doPublish = quantidadeParaPublicar(produto, own, componentes);

    // Not `toBe(<a number>)`: the EQUALITY is the assertion. A null on the sweep
    // side would mean the refusal came back with the hatch off, which is also a
    // disagreement — `toBe` catches it, since publish can never return null.
    expect(doSweep).toBe(doPublish);
  });

  /**
   * ⚠️ **Agreement is necessary and NOT sufficient, and this pins the gap.**
   *
   * The equality above is symmetric: both sides now call one function, so a
   * defect INSIDE that function moves both answers together and the comparison
   * stays green. Measured, not assumed — reverting the kit branch to
   * `if (args.ehKit)` alone leaves every case above passing, because publish and
   * the sweep then agree on the produto's own stock instead of the component-min.
   *
   * So the near-miss needs a second, one-sided assertion: for a produto flagged
   * `ehKitVirtual` WITHOUT `ehKit`, the published quantity must NOT be the
   * produto's own stock. `bulkEstoquePlan.test.ts` pins the sweep's half.
   */
  it('near-miss: `ehKitVirtual` without `ehKit` must NOT publish the own stock', () => {
    const produto = {
      ehKit: false,
      ehKitVirtual: true,
      componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    };
    expect(quantidadeParaPublicar(produto, 50, { A: 4 })).toBe(4); // the component-min
    expect(quantidadeParaPublicar(produto, 50, { A: 4 })).not.toBe(50); // own stock
  });

  it('the escape hatch moves the SWEEP only — publish can never skip', () => {
    // `POST /items` requires `available_quantity`, so `quantidadeParaPublicar`
    // pins `pularKitVirtual: false`. Turning the hatch on must therefore break
    // the agreement in exactly ONE direction, and never make publish emit null.
    const produto = {
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    };
    const componentes = { A: 3 };
    process.env[STOCK_KIT_VIRTUAL_SKIP_FLAG_ENV] = '1';
    try {
      expect(quantidadeParaPublicar(produto, 50, componentes)).toBe(3);
      expect(
        quantidadeParaEnvio({
          ehKit: produto.ehKit,
          ehKitVirtual: produto.ehKitVirtual,
          componentesKit: produto.componentesKit,
          ownDisponivel: 50,
          disponivelByProdutoId: componentes,
        }),
      ).toBeNull();
    } finally {
      delete process.env[STOCK_KIT_VIRTUAL_SKIP_FLAG_ENV];
    }
  });
});
