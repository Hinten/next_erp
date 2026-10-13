import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
  shopeeItemBaseInfoPayloadSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { toOuterRef } from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { FakeDb, asDb } from '../testing/fakeDb';
import { lerBaseInfoDosItens, resolverComponentesDoKitErp } from './componentesKit';

/* --------------------------------- fixtures -------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
/** The SAME conta in the bare legacy encoding (`integracoes/<id>`, no `documents/`). */
const REF_CONTA_NUA = integracaoCollection.docPath({}, INTEGRACAO);
const REF_OUTRA_CONTA = toOuterRef(integracaoCollection.docPath({}, 'int-2'));

/** Kit roles (D1). A: a 2-tier item; B: a plain item whose kit row carries a HIDDEN model id. */
const COMP_A = 2500139871;
const MODELO_A = 2000458821;
const COMP_B = 2500139872;
const MODELO_OCULTO_B = 2000458829;
/** A second plain listing, and a native KIT listing (never a component). */
const ITEM_OUTRO = 2500139861;
const MODELO_OUTRO = 2000458802;
const KIT = 2500139870;
const CATEGORIA = 107290;

function refDoVinculo(produtoId: string, linkDocId: string): string {
  return toOuterRef(produtoShopeeLinkCollection.docPath({ produtoId }, linkDocId));
}

interface LinhaBase {
  readonly item_id: number;
  readonly item_status?: string | null;
  readonly has_model?: boolean | null;
  readonly kit?: boolean | null;
}

/** A client whose ONLY method is `getItemBaseInfo`, answering from a table, recorded. */
function cliente(linhas: readonly LinhaBase[]): {
  readonly client: ShopeeClient;
  readonly getItemBaseInfo: ReturnType<typeof vi.fn>;
} {
  const porId = new Map(linhas.map((l) => [l.item_id, l]));
  const getItemBaseInfo = vi.fn((p: { itemIds: readonly number[] }) =>
    Promise.resolve(
      shopeeItemBaseInfoPayloadSchema.parse({
        item_list: p.itemIds
          .map((id) => porId.get(id))
          .filter((l): l is LinhaBase => l !== undefined)
          .map((l) => ({
            item_id: l.item_id,
            item_status: l.item_status === undefined ? 'NORMAL' : l.item_status,
            has_model: l.has_model === undefined ? false : l.has_model,
            ...(l.kit === undefined ? {} : { tag: { kit: l.kit } }),
          })),
      }),
    ),
  );
  return { client: { getItemBaseInfo } as unknown as ShopeeClient, getItemBaseInfo };
}

/** A family of many: parent `comp-a-pai` with its listing, child `comp-a-filho` bound to model A. */
function semearA(
  db: FakeDb,
  over: { link?: Record<string, unknown>; linha?: Record<string, unknown> } = {},
): void {
  db.seed('produtos/comp-a-pai', { nome: 'A', sku: 'COMP-A', paiId: null });
  db.seed('produtos/comp-a-pai/prodshopee/vinc-a', {
    item_id: COMP_A,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
    kitNativo: false,
    ...over.link,
  });
  db.seed('produtos/comp-a-filho', { nome: 'A branco', sku: 'COMP-A-BR', paiId: 'comp-a-pai' });
  db.seed('produtos/comp-a-filho/variashopee/var-a', {
    model_id: MODELO_A,
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: refDoVinculo('comp-a-pai', 'vinc-a'),
    ...over.linha,
  });
}

/** A família de um: wrapper `comp-b` holds the listing, member `comp-b-membro` the stock (#1398). */
function semearB(db: FakeDb, link: Record<string, unknown> = {}): void {
  db.seed('produtos/comp-b', {
    nome: 'B',
    sku: 'COMP-B',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
  });
  db.seed('produtos/comp-b-membro', { nome: 'B', sku: 'COMP-B-UN', paiId: 'comp-b' });
  db.seed('produtos/comp-b/prodshopee/vinc-b', {
    item_id: COMP_B,
    contaProdutoShopeeOuterRef: REF_CONTA,
    ...link,
  });
}

/** A root produto that is itself a plain listing. */
function semearRaiz(db: FakeDb, produtoId: string, link: Record<string, unknown>): void {
  db.seed(`produtos/${produtoId}`, { nome: produtoId, sku: produtoId, paiId: null });
  db.seed(`produtos/${produtoId}/prodshopee/vinc-${produtoId}`, {
    item_id: ITEM_OUTRO,
    contaProdutoShopeeOuterRef: REF_CONTA,
    ...link,
  });
}

async function resolver(db: FakeDb, client: ShopeeClient, ids: readonly string[]) {
  return resolverComponentesDoKitErp(asDb(db), client, INTEGRACAO, ids);
}

/* ---------------------------------- tests ---------------------------------- */

describe('resolverComponentesDoKitErp — the three rungs', () => {
  it('A by its variation row (through the link under its parent), B by the sole-member hop — ONE base-info batch', async () => {
    const db = new FakeDb();
    semearA(db);
    semearB(db);
    const { client, getItemBaseInfo } = cliente([
      { item_id: COMP_A, has_model: true },
      { item_id: COMP_B, has_model: false },
    ]);

    const r = await resolver(db, client, ['comp-a-filho', 'comp-b-membro']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({
      ok: true,
      endereco: { itemId: COMP_A, modelId: MODELO_A },
    });
    // The MEMBER's key, the WRAPPER's listing: a plain item sends NO model.
    expect(r.resolucao.get('comp-b-membro')).toEqual({
      ok: true,
      endereco: { itemId: COMP_B, modelId: null },
    });
    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(getItemBaseInfo.mock.calls[0]![0]).toEqual({ itemIds: [COMP_A, COMP_B] });
    expect(r.chamadas).toBe(1);
    expect([...r.temModelos.entries()]).toEqual([
      [COMP_A, true],
      [COMP_B, false],
    ]);
    // The STORED link's category; B's link stores none.
    expect(r.categoriaPorProduto.get('comp-a-filho')).toBe(CATEGORIA);
    expect(r.categoriaPorProduto.get('comp-b-membro')).toBeNull();
  });

  it('the WRAPPER itself as a key (an un-repointed map) resolves through its own listing — same address', async () => {
    const db = new FakeDb();
    semearB(db);
    const { client } = cliente([{ item_id: COMP_B, has_model: false }]);

    const r = await resolver(db, client, ['comp-b', 'comp-b-membro']);

    expect(r.resolucao.get('comp-b')).toEqual(r.resolucao.get('comp-b-membro'));
    expect(r.resolucao.get('comp-b')).toEqual({
      ok: true,
      endereco: { itemId: COMP_B, modelId: null },
    });
  });

  it('a root produto that is itself a plain listing (rung 2)', async () => {
    const db = new FakeDb();
    semearRaiz(db, 'avulso', { category_id: CATEGORIA });
    const { client } = cliente([{ item_id: ITEM_OUTRO, has_model: false }]);

    const r = await resolver(db, client, ['avulso']);

    expect(r.resolucao.get('avulso')).toEqual({
      ok: true,
      endereco: { itemId: ITEM_OUTRO, modelId: null },
    });
    expect(r.categoriaPorProduto.get('avulso')).toBe(CATEGORIA);
  });

  it('never a group query: every read is one doc or one produto subcollection (rule 1)', async () => {
    const db = new FakeDb();
    semearA(db);
    semearB(db);
    const { client } = cliente([
      { item_id: COMP_A, has_model: true },
      { item_id: COMP_B, has_model: false },
    ]);

    await resolver(db, client, ['comp-a-filho', 'comp-b-membro']);

    expect(db.consultas.filter((c) => c.fonte.startsWith('group:'))).toEqual([]);
    expect(db.consultas.every((c) => c.clausulas.length === 0)).toBe(true);
    expect(db.writes).toEqual([]);
  });

  it('a TOTAL map: every requested id answers, duplicates resolve once, an impossible id reads nothing', async () => {
    const db = new FakeDb();
    semearB(db);
    const { client } = cliente([{ item_id: COMP_B, has_model: false }]);

    const r = await resolver(db, client, [
      'comp-b-membro',
      'comp-b-membro',
      '',
      'a/b',
      'nao-existe',
    ]);

    expect([...r.resolucao.keys()]).toEqual(['comp-b-membro', '', 'a/b', 'nao-existe']);
    expect([...r.categoriaPorProduto.keys()]).toEqual(['comp-b-membro', '', 'a/b', 'nao-existe']);
    expect(r.resolucao.get('')).toEqual({ ok: false, motivo: 'componente-nao-publicado' });
    expect(r.resolucao.get('a/b')).toEqual({ ok: false, motivo: 'componente-nao-publicado' });
    expect(r.resolucao.get('nao-existe')).toEqual({
      ok: false,
      motivo: 'componente-nao-publicado',
    });
    expect(db.caminhos.filter((c) => c === 'produtos/comp-b-membro')).toHaveLength(1);
    expect(db.caminhos.some((c) => c.includes('a/b'))).toBe(false);
  });
});

describe('resolverComponentesDoKitErp — the default-model rule (schemas, applied after the read)', () => {
  it('PAR IGUAL: a plain item sends NO model even when a stale row stores the hidden id', async () => {
    // The member carries a row naming B's HIDDEN default id: has_model false ⇒ dropped.
    const db = new FakeDb();
    semearB(db);
    db.seed('produtos/comp-b-membro/variashopee/var-b', {
      model_id: MODELO_OCULTO_B,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: refDoVinculo('comp-b', 'vinc-b'),
    });
    const { client } = cliente([{ item_id: COMP_B, has_model: false }]);

    const r = await resolver(db, client, ['comp-b-membro']);

    expect(r.resolucao.get('comp-b-membro')).toEqual({
      ok: true,
      endereco: { itemId: COMP_B, modelId: null },
    });
  });

  it('⛔ NEAR-MISS: the same row on an item that HAS variations keeps its model', async () => {
    const db = new FakeDb();
    semearB(db);
    db.seed('produtos/comp-b-membro/variashopee/var-b', {
      model_id: MODELO_OCULTO_B,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: refDoVinculo('comp-b', 'vinc-b'),
    });
    const { client } = cliente([{ item_id: COMP_B, has_model: true }]);

    const r = await resolver(db, client, ['comp-b-membro']);

    expect(r.resolucao.get('comp-b-membro')).toEqual({
      ok: true,
      endereco: { itemId: COMP_B, modelId: MODELO_OCULTO_B },
    });
  });

  it('a `model_id: 0` row on an item with variations is no model ⇒ componente-sem-modelo', async () => {
    const db = new FakeDb();
    semearA(db, { linha: { model_id: 0 } });
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-filho']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({ ok: false, motivo: 'componente-sem-modelo' });
  });
});

describe('resolverComponentesDoKitErp — the refusals', () => {
  it('(M95) a component whose listing link says kitNativo ⇒ componente-e-kit-nativo, and it is never read', async () => {
    const db = new FakeDb();
    semearRaiz(db, 'um-kit', { item_id: KIT, kitNativo: true });
    // The live row does NOT say kit: only the LINK can refuse it here.
    const { client, getItemBaseInfo } = cliente([{ item_id: KIT, has_model: true, kit: false }]);

    const r = await resolver(db, client, ['um-kit']);

    expect(r.resolucao.get('um-kit')).toEqual({ ok: false, motivo: 'componente-e-kit-nativo' });
    expect(r.categoriaPorProduto.get('um-kit')).toBeNull();
    expect(getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('⛔ NEAR-MISS (M95): the same link with kitNativo false (or null) is a component', async () => {
    for (const kitNativo of [false, null]) {
      const db = new FakeDb();
      semearRaiz(db, 'comum', { kitNativo });
      const { client } = cliente([{ item_id: ITEM_OUTRO, has_model: false }]);

      const r = await resolver(db, client, ['comum']);

      expect(r.resolucao.get('comum'), String(kitNativo)).toEqual({
        ok: true,
        endereco: { itemId: ITEM_OUTRO, modelId: null },
      });
    }
  });

  it('a CHILD of a native kit (its row sits on the kit link) ⇒ componente-e-kit-nativo', async () => {
    const db = new FakeDb();
    semearA(db, { link: { item_id: KIT, kitNativo: true } });
    const { client } = cliente([{ item_id: KIT, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-filho']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({
      ok: false,
      motivo: 'componente-e-kit-nativo',
    });
  });

  it('a listing whose LIVE row is a kit (an import that predates the kitNativo stamp) ⇒ componente-e-kit-nativo', async () => {
    const db = new FakeDb();
    semearRaiz(db, 'kit-legado', { item_id: KIT, kitNativo: null });
    const { client } = cliente([{ item_id: KIT, has_model: true, kit: true }]);

    const r = await resolver(db, client, ['kit-legado']);

    expect(r.resolucao.get('kit-legado')).toEqual({ ok: false, motivo: 'componente-e-kit-nativo' });
  });

  it('componente-sem-modelo: a family PARENT used as the component (its listing has variations)', async () => {
    const db = new FakeDb();
    semearA(db);
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-pai']);

    expect(r.resolucao.get('comp-a-pai')).toEqual({ ok: false, motivo: 'componente-sem-modelo' });
  });

  it('componente-sem-modelo: a child of a família de MUITOS with no row; ⛔ NEAR-MISS a parent with no listing ⇒ não publicado', async () => {
    const db = new FakeDb();
    semearA(db);
    db.seed('produtos/comp-a-outro-filho', {
      nome: 'A preto',
      sku: 'COMP-A-PR',
      paiId: 'comp-a-pai',
    });
    db.seed('produtos/sem-anuncio', { nome: 'X', sku: 'X', paiId: null });
    db.seed('produtos/sem-anuncio-filho', { nome: 'X1', sku: 'X1', paiId: 'sem-anuncio' });
    const { client, getItemBaseInfo } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-outro-filho', 'sem-anuncio-filho']);

    expect(r.resolucao.get('comp-a-outro-filho')).toEqual({
      ok: false,
      motivo: 'componente-sem-modelo',
    });
    expect(r.resolucao.get('sem-anuncio-filho')).toEqual({
      ok: false,
      motivo: 'componente-nao-publicado',
    });
    // Decided from Firestore alone: neither reached the base-info batch.
    expect(getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('a row the sync MARKED (`modeloAusenteEm`) is not an address ⇒ componente-sem-modelo; ⛔ NEAR-MISS unmarked ⇒ bound', async () => {
    const marcado = new FakeDb();
    semearA(marcado, { linha: { modeloAusenteEm: 1_791_244_800_000 } });
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);
    expect(
      (await resolver(marcado, client, ['comp-a-filho'])).resolucao.get('comp-a-filho'),
    ).toEqual({
      ok: false,
      motivo: 'componente-sem-modelo',
    });

    const vivo = new FakeDb();
    semearA(vivo, { linha: { modeloAusenteEm: null } });
    expect((await resolver(vivo, client, ['comp-a-filho'])).resolucao.get('comp-a-filho')).toEqual({
      ok: true,
      endereco: { itemId: COMP_A, modelId: MODELO_A },
    });
  });

  it('componente-nao-publicado: no listing; a link of ANOTHER conta; a link never published (`item_id: null`)', async () => {
    const db = new FakeDb();
    db.seed('produtos/sem-link', { nome: 'S', sku: 'S', paiId: null });
    semearRaiz(db, 'outra-conta', { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });
    semearRaiz(db, 'nunca-publicado', { item_id: null });
    const { client, getItemBaseInfo } = cliente([]);

    const r = await resolver(db, client, ['sem-link', 'outra-conta', 'nunca-publicado']);

    for (const id of ['sem-link', 'outra-conta', 'nunca-publicado']) {
      expect(r.resolucao.get(id), id).toEqual({ ok: false, motivo: 'componente-nao-publicado' });
    }
    expect(getItemBaseInfo).not.toHaveBeenCalled();
    expect(r.chamadas).toBe(0);
  });

  it("a variation row of ANOTHER conta is not this conta's address (then the hop decides)", async () => {
    const db = new FakeDb();
    semearA(db, { linha: { contaVariacaoShopeeOuterRef: REF_OUTRA_CONTA } });
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-filho']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({ ok: false, motivo: 'componente-sem-modelo' });
  });

  it('PAR IGUAL: the bare legacy conta encoding binds exactly like the canonical one', async () => {
    const db = new FakeDb();
    semearA(db, {
      link: { contaProdutoShopeeOuterRef: REF_CONTA_NUA },
      linha: { contaVariacaoShopeeOuterRef: REF_CONTA_NUA },
    });
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-filho']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({
      ok: true,
      endereco: { itemId: COMP_A, modelId: MODELO_A },
    });
  });

  it('componente-anuncio-inativo: no base row, an unreadable has_model, BANNED, SELLER_DELETE; ⛔ NEAR-MISS UNLIST and NORMAL are usable', async () => {
    const casos: readonly [LinhaBase | null, string][] = [
      [null, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, has_model: null }, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, item_status: 'BANNED' }, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, item_status: 'SELLER_DELETE' }, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, item_status: 'REVIEWING' }, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, item_status: null }, 'componente-anuncio-inativo'],
      [{ item_id: ITEM_OUTRO, item_status: 'UNLIST' }, 'ok'],
      [{ item_id: ITEM_OUTRO, item_status: 'NORMAL' }, 'ok'],
    ];
    for (const [linha, esperado] of casos) {
      const db = new FakeDb();
      semearRaiz(db, 'avulso', {});
      const { client } = cliente(linha === null ? [] : [linha]);

      const r = (await resolver(db, client, ['avulso'])).resolucao.get('avulso');

      const rotulo = JSON.stringify(linha);
      if (esperado === 'ok') {
        expect(r, rotulo).toEqual({ ok: true, endereco: { itemId: ITEM_OUTRO, modelId: null } });
      } else {
        expect(r, rotulo).toEqual({ ok: false, motivo: esperado });
      }
    }
  });

  it("two usable links of one produto: step 9's policy, LEXICALLY first, whatever the insertion order", async () => {
    for (const ordem of [
      ['vinc-1', 'vinc-2'],
      ['vinc-2', 'vinc-1'],
    ] as const) {
      const db = new FakeDb();
      db.seed('produtos/dup', { nome: 'D', sku: 'D', paiId: null });
      for (const id of ordem) {
        db.seed(`produtos/dup/prodshopee/${id}`, {
          item_id: id === 'vinc-1' ? ITEM_OUTRO : COMP_B,
          contaProdutoShopeeOuterRef: REF_CONTA,
        });
      }
      const { client } = cliente([
        { item_id: ITEM_OUTRO, has_model: false },
        { item_id: COMP_B, has_model: false },
      ]);

      const r = await resolver(db, client, ['dup']);

      expect(r.resolucao.get('dup'), ordem.join(',')).toEqual({
        ok: true,
        endereco: { itemId: ITEM_OUTRO, modelId: null },
      });
    }
  });

  it('a row whose model belongs to a variation on another item is addressed as stored (no position guess)', async () => {
    const db = new FakeDb();
    semearA(db, { linha: { model_id: MODELO_OUTRO } });
    const { client } = cliente([{ item_id: COMP_A, has_model: true }]);

    const r = await resolver(db, client, ['comp-a-filho']);

    expect(r.resolucao.get('comp-a-filho')).toEqual({
      ok: true,
      endereco: { itemId: COMP_A, modelId: MODELO_OUTRO },
    });
  });
});

describe('lerBaseInfoDosItens — the shared reader, observed', () => {
  it('rows and has_model from the SAME calls; 51 ids ⇒ two calls of ≤ 50', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => 2500139000 + i);
    const { client, getItemBaseInfo } = cliente(
      ids.map((id) => ({ item_id: id, has_model: false })),
    );

    const leitura = await lerBaseInfoDosItens(client, [...ids, ids[0]!]);

    expect(getItemBaseInfo).toHaveBeenCalledTimes(2);
    expect(leitura.chamadas).toBe(2);
    expect(leitura.linhas.size).toBe(51);
    expect(leitura.temModelos.size).toBe(51);
  });

  it('first row wins, a row nobody asked for is ignored, an absent row stays absent', async () => {
    const getItemBaseInfo = vi.fn(() =>
      Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: [
            { item_id: COMP_A, item_status: 'NORMAL', has_model: true },
            { item_id: COMP_A, item_status: 'BANNED', has_model: true },
            { item_id: KIT, item_status: 'NORMAL', has_model: true },
          ],
        }),
      ),
    );
    const client = { getItemBaseInfo } as unknown as ShopeeClient;

    const leitura = await lerBaseInfoDosItens(client, [COMP_A, COMP_B]);

    expect(leitura.linhas.get(COMP_A)?.item_status).toBe('NORMAL');
    expect(leitura.linhas.has(KIT)).toBe(false);
    expect(leitura.linhas.has(COMP_B)).toBe(false);
    expect(leitura.temModelos.has(COMP_B)).toBe(false);
  });

  it('zero ids ⇒ zero calls', async () => {
    const { client, getItemBaseInfo } = cliente([]);
    const leitura = await lerBaseInfoDosItens(client, []);
    expect(getItemBaseInfo).not.toHaveBeenCalled();
    expect(leitura).toEqual({ temModelos: new Map(), linhas: new Map(), chamadas: 0 });
  });

  it('the batch "none of these ids exists" verdict is the reader\'s: no rows, no throw, the call counted', async () => {
    const getItemBaseInfo = vi.fn(() =>
      Promise.reject(
        new ShopeeApiError('Shopee respondeu error_item_not_found (HTTP 200)', {
          code: 'product.error_item_not_found',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_base_info',
        }),
      ),
    );
    const client = { getItemBaseInfo } as unknown as ShopeeClient;

    const leitura = await lerBaseInfoDosItens(client, [COMP_A]);

    expect(leitura.linhas.size).toBe(0);
    expect(leitura.temModelos.size).toBe(0);
    expect(leitura.chamadas).toBe(1);
  });

  it('⛔ any other failure propagates untouched (a rate limit is not a verdict about the ids)', async () => {
    const erro = new ShopeeRateLimitError('limite', {
      code: 'error_too_many_request',
      kind: 'burst',
      httpStatus: 429,
      path: '/api/v2/product/get_item_base_info',
    });
    const client = {
      getItemBaseInfo: vi.fn(() => Promise.reject(erro)),
    } as unknown as ShopeeClient;

    await expect(lerBaseInfoDosItens(client, [COMP_A])).rejects.toBe(erro);
  });
});
