/**
 * The shared link walk's OWN specs (#1200).
 *
 * The walk's behaviour moved here verbatim from `preco/precoReconciliacao.ts`,
 * and that module's suite is kept BYTE-UNCHANGED as the regression proof: every
 * case it had — the classifier, the noise guard, both ref forms, the
 * path-shaped cursor, the projections — still runs, through the price binding,
 * against this code. So this file covers only what the move newly adds: the two
 * cost counters, the `limpos` list the audit folds pages with, the page size
 * taken as given (no env), the audit's ONE-form walk (`contaRef`, an `==` where
 * the price phase keeps its `in`), the wire strings of the
 * codes, the price module re-exporting rather than copying, and the
 * re-confirmation the stock audit runs before it resolves an aviso.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  CODIGO_NAO_ENUMERADO,
  classificarLinkNaoEnumerado,
  fetchLinksNaoEnumeradosPage,
  reclassificarProdutoNaoEnumerado,
} from './linksNaoEnumerados';
import {
  classificarLinkNaoEnumerado as classificarViaPreco,
  fetchPrecoReconPage,
} from '../preco/precoReconciliacao';

/* ------------------------------ fake Firestore ----------------------------- */
// Same shape as `precoReconciliacao.test.ts`'s fake — real document REFS
// (`path`, `parent.parent.id`), because the produto id comes off the ref and the
// keyset cursor is a DocumentReference — plus the one surface the
// re-confirmation adds: a COLLECTION-scope query on one produto's own
// `produtoMercadoLivre` subcollection. Every read is counted, because "reads
// nothing when there is nothing to classify" is half of what is asserted here.

type DocData = Record<string, unknown>;

interface FakeRef {
  readonly path: string;
  readonly id: string;
  readonly parent: { readonly parent: { readonly id: string } | null };
}

function refOf(path: string): FakeRef {
  const parts = path.split('/');
  const id = parts[parts.length - 1]!;
  const produtoId = parts.length >= 4 ? parts[parts.length - 3]! : null;
  return { path, id, parent: { parent: produtoId == null ? null : { id: produtoId } } };
}

interface QueryLog {
  /** `group:<id>` for a collection group, the collection path otherwise. */
  source: string;
  clauses: Array<{ field: string; op: string; value: unknown }>;
  select: string[] | null;
  limit: number | null;
}

class FakeDb {
  readonly links = new Map<string, DocData>();
  readonly produtos = new Map<string, DocData>();
  readonly queries: QueryLog[] = [];
  /** One entry per `getAll` call: the ids it asked for and its mask. */
  readonly getAlls: Array<{ ids: string[]; mask: string[] | null }> = [];

  seedLink(path: string, data: DocData): void {
    this.links.set(path, data);
  }
  seedProduto(id: string, data: DocData): void {
    this.produtos.set(id, data);
  }

  private query(source: string, inScope: (path: string) => boolean) {
    const self = this;
    const log: QueryLog = { source, clauses: [], select: null, limit: null };
    let after: string | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        log.clauses.push({ field, op, value });
        return q;
      },
      select(...fields: string[]) {
        log.select = fields;
        return q;
      },
      orderBy(_fieldPath: unknown) {
        return q;
      },
      startAfter(cursor: unknown) {
        if (cursor == null || typeof cursor !== 'object' || !('path' in cursor)) {
          throw new Error('FakeDb: startAfter needs a DocumentReference');
        }
        after = (cursor as FakeRef).path;
        return q;
      },
      limit(n: number) {
        log.limit = n;
        return q;
      },
      async get() {
        self.queries.push(log);
        let rows = [...self.links.entries()].filter(
          ([path, d]) =>
            inScope(path) &&
            log.clauses.every(({ field, op, value }) => {
              if (op === '==') return d[field] === value;
              if (op !== 'in') throw new Error(`FakeDb: unsupported operator ${op}`);
              return Array.isArray(value) && value.includes(d[field]);
            }),
        );
        rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (after != null) rows = rows.filter(([path]) => path > after!);
        if (log.limit != null) rows = rows.slice(0, log.limit);
        return { docs: rows.map(([path, d]) => ({ ref: refOf(path), data: () => d })) };
      },
    };
    return q;
  }

  collectionGroup(groupId: string) {
    return this.query(`group:${groupId}`, (path) => path.split('/').slice(-2, -1)[0] === groupId);
  }

  /**
   * `docRef` (produtos batch read, cursor rebuild) AND `ref` (the
   * re-confirmation's subcollection query) both go through here.
   */
  collection(path: string) {
    return {
      ...this.query(path, (p) => p.split('/').slice(0, -1).join('/') === path),
      doc: (id: string) => refOf(`${path}/${id}`),
    };
  }

  getAll(...args: unknown[]) {
    let mask: string[] | null = null;
    const opts = args[args.length - 1];
    if (opts != null && typeof opts === 'object' && 'fieldMask' in opts) {
      mask = (opts as { fieldMask: string[] }).fieldMask;
      args = args.slice(0, -1);
    }
    const refs = args as FakeRef[];
    this.getAlls.push({ ids: refs.map((r) => r.id), mask });
    return Promise.resolve(
      refs.map((ref) => {
        const data = this.produtos.get(ref.id);
        return { id: ref.id, exists: data != null, data: () => data };
      }),
    );
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-A';
const REF_CANONICO = `documents/integracao/${CONTA}`;
const REF_BARE = `integracao/${CONTA}`;
const PAGE_ENV = 'MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT';

function linkPath(produtoId: string, linkId = 'link1'): string {
  return `produtos/${produtoId}/produtoMercadoLivre/${linkId}`;
}

function seedLink(db: FakeDb, produtoId: string, linkId: string, over: DocData = {}): void {
  db.seedLink(linkPath(produtoId, linkId), {
    contaOuterRef: REF_CANONICO,
    id: `MLB-${produtoId}-${linkId}`,
    estado: 'p',
    ...over,
  });
}

/** A produto the anchor terms DO enumerate for {@link CONTA}. */
const LIMPO: DocData = { paiId: null, integracoesComProduto: [CONTA] };
/** Class 2 — the denorm lost the conta. */
const DERIVADO: DocData = { paiId: null, integracoesComProduto: [] };

beforeEach(() => {
  delete process.env[PAGE_ENV];
});
afterEach(() => {
  delete process.env[PAGE_ENV];
});

/* -------------------------------- vocabulary ------------------------------- */

describe('CODIGO_NAO_ENUMERADO', () => {
  it('keeps the exact wire strings stored price reports already carry', () => {
    // These are persisted raw as `EnvioPrecoSkip.code` and keyed by
    // `precoMotivos.MENSAGEM_POR_MOTIVO`; a rename orphans every stored row.
    expect(CODIGO_NAO_ENUMERADO).toEqual({
      produtoAusente: 'NAO_ENUMERADO_PRODUTO_AUSENTE',
      linkEmVariacao: 'NAO_ENUMERADO_LINK_EM_VARIACAO',
      paiIdInvalido: 'NAO_ENUMERADO_PAI_ID_INVALIDO',
      contaForaDoProduto: 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
    });
  });

  it('the price module RE-EXPORTS the classifier rather than keeping a copy', () => {
    // A copy is the drift this extraction exists to remove (#1369): identity,
    // not equal behaviour on a few inputs, is the only proof there is one.
    expect(classificarViaPreco).toBe(classificarLinkNaoEnumerado);
  });
});

/* --------------------------------- the walk -------------------------------- */

describe('fetchLinksNaoEnumeradosPage — what the move adds', () => {
  it('`lidos` counts EVERY link read — closed and never-published included', async () => {
    // The noise guard runs in code AFTER the read is billed, so the closed
    // history is the cost driver even though it reports nothing.
    const db = new FakeDb();
    seedLink(db, 'P1', 'vivo');
    seedLink(db, 'P2', 'fechado', { estado: 'c' });
    seedLink(db, 'P3', 'nunca', { id: null });
    db.seedProduto('P1', LIMPO);

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });

    expect(page.lidos).toBe(3);
    expect(page.inspecionados).toBe(1);
    expect(page.naoEnumerados).toEqual([]);
  });

  it('`produtosLidos` is the DEDUPED key-read count, in ONE batch', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');
    seedLink(db, 'P1', 'b');
    seedLink(db, 'P2', 'a', { contaOuterRef: REF_BARE });
    db.seedProduto('P1', DERIVADO);
    db.seedProduto('P2', LIMPO);

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });

    expect(page.produtosLidos).toBe(2);
    expect(db.getAlls).toHaveLength(1);
    expect(db.getAlls[0]!.ids).toEqual(['P1', 'P2']);
    // Both listings on P1 are findings — one per link, not per produto.
    expect(page.naoEnumerados).toEqual([
      { produtoId: 'P1', itemId: 'MLB-P1-a', code: CODIGO_NAO_ENUMERADO.contaForaDoProduto },
      { produtoId: 'P1', itemId: 'MLB-P1-b', code: CODIGO_NAO_ENUMERADO.contaForaDoProduto },
    ]);
  });

  it('`produtosLidos` is 0 with NO getAll when the page holds nothing live', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a', { estado: 'c' });

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });

    expect(page.produtosLidos).toBe(0);
    expect(page.lidos).toBe(1);
    expect(page.limpos).toEqual([]);
    expect(db.getAlls).toEqual([]);
  });

  it('`limpos` names each produto read CLEAN — once, sorted, never one that is also a finding', async () => {
    // The audit folds pages with "the latest read wins", and a clean read is a
    // read: without this list, a produto fixed between two pages keeps the
    // earlier page's stale code and is healed or alerted on for nothing.
    const db = new FakeDb();
    seedLink(db, 'P2', 'a');
    seedLink(db, 'P2', 'b');
    seedLink(db, 'P1', 'a', { contaOuterRef: REF_BARE });
    seedLink(db, 'P3', 'a');
    // Only a CLOSED listing: never read, so neither clean nor a finding.
    seedLink(db, 'P4', 'fechado', { estado: 'c' });
    db.seedProduto('P1', LIMPO);
    db.seedProduto('P2', LIMPO);
    db.seedProduto('P3', DERIVADO);
    db.seedProduto('P4', LIMPO);

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });

    expect(page.limpos).toEqual(['P1', 'P2']);
    expect(page.naoEnumerados.map((n) => n.produtoId)).toEqual(['P3']);
  });

  it('honours pageLimit AS GIVEN — the price env tunable does not leak in', async () => {
    // The shared module reads no environment: the price binding supplies its
    // own default, and the audit must not silently inherit it.
    process.env[PAGE_ENV] = '1';
    const db = new FakeDb();
    for (const p of ['P1', 'P2', 'P3', 'P4']) {
      seedLink(db, p, 'a', { estado: 'c' });
    }

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 3,
    });

    expect(db.queries[0]!.limit).toBe(3);
    expect(page.lidos).toBe(3);
    // A FULL page of closed links keeps the cursor — it advances on documents
    // READ, never on rows reported.
    expect(page.nextAfterLinkPath).toBe(linkPath('P3', 'a'));
  });

  it('…while the price binding still defaults to its env tunable', async () => {
    process.env[PAGE_ENV] = '2';
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');

    await fetchPrecoReconPage(asDb(db), { integracaoId: CONTA });

    expect(db.queries[0]!.limit).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses pageLimit %s before reading anything — a 0 would report a drained walk',
    async (pageLimit) => {
      // `full` is `docs.length === pageLimit`: with 0 the page is "full", has
      // no last path, and returns a null cursor — a COMPLETE walk that
      // inspected nothing, which the audit would read as licence to resolve
      // every open aviso.
      const db = new FakeDb();
      seedLink(db, 'P1', 'a');

      await expect(
        fetchLinksNaoEnumeradosPage(asDb(db), { integracaoId: CONTA, pageLimit }),
      ).rejects.toThrow(RangeError);
      expect(db.queries).toEqual([]);
    },
  );

  it('names the cursor in its error — the price suite matches /cursor de reconciliação/', async () => {
    const db = new FakeDb();

    await expect(
      fetchLinksNaoEnumeradosPage(asDb(db), {
        integracaoId: CONTA,
        afterLinkPath: 'produtos/P1',
        pageLimit: 10,
      }),
    ).rejects.toThrow(/cursor de reconciliação de anúncios inválido/);
  });
});

describe('fetchLinksNaoEnumeradosPage — ONE ref form (`contaRef`, the stock audit’s walk)', () => {
  /** P1 and P3 on the canonical form, P2 and P4 on the bare one — interleaved in key order. */
  function seedDuasFormas(db: FakeDb): void {
    seedLink(db, 'P1', 'a');
    seedLink(db, 'P2', 'a', { contaOuterRef: REF_BARE });
    seedLink(db, 'P3', 'a');
    seedLink(db, 'P4', 'a', { contaOuterRef: REF_BARE });
    for (const p of ['P1', 'P2', 'P3', 'P4']) db.seedProduto(p, LIMPO);
  }

  it('reads `contaOuterRef == contaRef` — ONE equality, never the `in` — and only that form’s links', async () => {
    // The `in` over both forms is what the staging proxy sorts with a
    // `MajorSort` that reads the conta's whole remainder on every page; one `==`
    // is a single key-ordered stream (anuncios/linksNaoEnumerados.ts, module doc).
    for (const [contaRef, esperado] of [
      [REF_CANONICO, ['P1', 'P3']],
      [REF_BARE, ['P2', 'P4']],
    ] as const) {
      const db = new FakeDb();
      seedDuasFormas(db);

      const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
        integracaoId: CONTA,
        contaRef,
        pageLimit: 10,
      });

      expect(db.queries).toHaveLength(1);
      expect(db.queries[0]).toEqual({
        source: 'group:produtoMercadoLivre',
        clauses: [{ field: 'contaOuterRef', op: '==', value: contaRef }],
        select: ['id', 'estado'],
        limit: 10,
      });
      expect(page.limpos).toEqual(esperado);
      expect(page.lidos).toBe(2);
      expect(page.nextAfterLinkPath).toBeNull();
    }
  });

  it('without `contaRef` it is the price phase’s walk, unchanged: ONE `in` over both forms', async () => {
    const db = new FakeDb();
    seedDuasFormas(db);

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });

    expect(db.queries[0]!.clauses).toEqual([
      { field: 'contaOuterRef', op: 'in', value: [REF_CANONICO, REF_BARE] },
    ]);
    expect(page.limpos).toEqual(['P1', 'P2', 'P3', 'P4']);
    // `null` is "no form": the same `in`.
    const db2 = new FakeDb();
    seedDuasFormas(db2);
    await fetchLinksNaoEnumeradosPage(asDb(db2), {
      integracaoId: CONTA,
      contaRef: null,
      pageLimit: 10,
    });
    expect(db2.queries[0]!.clauses[0]!.op).toBe('in');
  });

  it('pages one form by its own cursor — a full page keeps it, the drained page nulls it', async () => {
    const db = new FakeDb();
    seedDuasFormas(db);

    const pagina1 = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      contaRef: REF_BARE,
      pageLimit: 1,
    });
    expect(pagina1.limpos).toEqual(['P2']);
    expect(pagina1.nextAfterLinkPath).toBe(linkPath('P2', 'a'));
    const pagina2 = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      contaRef: REF_BARE,
      afterLinkPath: pagina1.nextAfterLinkPath,
      pageLimit: 1,
    });
    // P3 (canonical) sorts between P2 and P4 and is NOT this form's.
    expect(pagina2.limpos).toEqual(['P4']);
  });

  it.each([
    ['another conta’s canonical ref', 'documents/integracao/outra-conta'],
    ['another conta’s bare ref', 'integracao/outra-conta'],
    ['a prefix-sharing conta', `${REF_BARE}2`],
    ['the bare id', CONTA],
    ['an empty string', ''],
  ])('refuses %s as `contaRef` before reading anything', async (_n, contaRef) => {
    // The classifier judges every link against `integracaoId`: another conta's
    // links would all read as "conta fora do produto" and be healed onto the
    // wrong produtos.
    const db = new FakeDb();
    seedDuasFormas(db);

    await expect(
      fetchLinksNaoEnumeradosPage(asDb(db), { integracaoId: CONTA, contaRef, pageLimit: 10 }),
    ).rejects.toThrow(RangeError);
    expect(db.queries).toEqual([]);
  });
});

/* --------------------------- the re-confirmation --------------------------- */

describe('reclassificarProdutoNaoEnumerado — the check before a resolve', () => {
  it('asks ONLY that produto’s own links, on both ref forms, masked like the walk', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');
    db.seedProduto('P1', DERIVADO);
    // Another produto's live drifted link must not be read, let alone counted.
    seedLink(db, 'P2', 'a');
    db.seedProduto('P2', DERIVADO);

    await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]).toEqual({
      // COLLECTION scope — the declared `produtoMercadoLivre(contaOuterRef)`
      // entry `sobrevivemLinksDoProduto` rides, never the group index.
      source: 'produtos/P1/produtoMercadoLivre',
      clauses: [{ field: 'contaOuterRef', op: 'in', value: [REF_CANONICO, REF_BARE] }],
      select: ['id', 'estado'],
      limit: null,
    });
    expect(db.getAlls).toEqual([{ ids: ['P1'], mask: ['paiId', 'integracoesComProduto'] }]);
  });

  it('a produto still drifted re-confirms as CONTA_FORA_DO_PRODUTO', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a', { contaOuterRef: REF_BARE });
    db.seedProduto('P1', DERIVADO);

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA)).toBe(
      CODIGO_NAO_ENUMERADO.contaForaDoProduto,
    );
  });

  it('a live link that moved onto a variation child re-confirms as LINK_EM_VARIACAO', async () => {
    // The flap this exists to stop: the walk passed the produto before the
    // link landed, so the aviso is absent from `vistos` — and still true.
    const db = new FakeDb();
    seedLink(db, 'CHILD', 'a');
    db.seedProduto('CHILD', { paiId: 'ANCHOR', integracoesComProduto: [CONTA] });

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'CHILD', CONTA)).toBe(
      CODIGO_NAO_ENUMERADO.linkEmVariacao,
    );
  });

  it('an invalid paiId re-confirms as PAI_ID_INVALIDO — exact, not coerced', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');
    db.seedProduto('P1', { paiId: '', integracoesComProduto: [CONTA] });

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA)).toBe(
      CODIGO_NAO_ENUMERADO.paiIdInvalido,
    );
  });

  it('a live link whose produto is gone re-confirms as PRODUTO_AUSENTE', async () => {
    const db = new FakeDb();
    seedLink(db, 'GONE', 'a');

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'GONE', CONTA)).toBe(
      CODIGO_NAO_ENUMERADO.produtoAusente,
    );
  });

  it('a repaired produto re-confirms CLEAN', async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');
    db.seedProduto('P1', LIMPO);

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA)).toBeNull();
  });

  it('no LIVE link on the conta is clean, whatever the cadastro says — and reads no produto', async () => {
    // The walk's noise guard, applied here too: a closed or never-published
    // listing is exactly why the trigger dropped the conta. A produto that is
    // still a child, or gone, is not a finding without a live anúncio.
    const db = new FakeDb();
    seedLink(db, 'P1', 'fechado', { estado: 'c' });
    seedLink(db, 'P1', 'nunca', { id: null });
    db.seedProduto('P1', { paiId: 'ANCHOR', integracoesComProduto: [] });

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA)).toBeNull();
    expect(db.getAlls).toEqual([]);
  });

  it("another conta's live link on the same produto does not count", async () => {
    const db = new FakeDb();
    seedLink(db, 'P1', 'a', { contaOuterRef: 'documents/integracao/outra-conta' });
    db.seedProduto('P1', DERIVADO);

    expect(await reclassificarProdutoNaoEnumerado(asDb(db), 'P1', CONTA)).toBeNull();
    expect(db.getAlls).toEqual([]);
  });

  it('agrees with the walk on the same data, code for code', async () => {
    // One predicate, two read paths: if they ever classify the same produto
    // differently, the audit resolves what its own walk would re-open.
    const db = new FakeDb();
    seedLink(db, 'P1', 'a');
    db.seedProduto('P1', DERIVADO);
    seedLink(db, 'P2', 'a');
    db.seedProduto('P2', { paiId: 'X', integracoesComProduto: [CONTA] });
    seedLink(db, 'P3', 'a');
    db.seedProduto('P3', { integracoesComProduto: [CONTA] });
    seedLink(db, 'P4', 'a');
    seedLink(db, 'P5', 'a');
    db.seedProduto('P5', LIMPO);

    const page = await fetchLinksNaoEnumeradosPage(asDb(db), {
      integracaoId: CONTA,
      pageLimit: 10,
    });
    const pelaVarredura = Object.fromEntries(
      ['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => [
        p,
        page.naoEnumerados.find((n) => n.produtoId === p)?.code ?? null,
      ]),
    );
    const pelaReconfirmacao: Record<string, string | null> = {};
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) {
      pelaReconfirmacao[p] = await reclassificarProdutoNaoEnumerado(asDb(db), p, CONTA);
    }

    expect(pelaReconfirmacao).toEqual(pelaVarredura);
    // Non-vacuous: four distinct findings and one clean produto.
    expect(pelaVarredura).toEqual({
      P1: CODIGO_NAO_ENUMERADO.contaForaDoProduto,
      P2: CODIGO_NAO_ENUMERADO.linkEmVariacao,
      P3: CODIGO_NAO_ENUMERADO.paiIdInvalido,
      P4: CODIGO_NAO_ENUMERADO.produtoAusente,
      P5: null,
    });
  });
});
