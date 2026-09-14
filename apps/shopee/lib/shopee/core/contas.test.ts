import { describe, expect, it } from 'vitest';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { listarContasShopeeAtivas } from './contas';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, key or shop id.      */
/* -------------------------------------------------------------------------- */

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const INT_A = 'int-1';
const INT_B = 'int-2';
const SHOP_A = 987654;
const SHOP_B = 987655;

function contaDoc(over: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja BR', shop_id: SHOP_A, ...over };
}

describe('listarContasShopeeAtivas', () => {
  it('1 — a consulta é EXATAMENTE (tipo, ativo), nessa ordem, e sem limite', async () => {
    // ⚠️ The clause set, their ORDER and the absence of a `limit` are the whole
    // contract: `(tipo, ativo)` is the composite that exists in
    // `firestore.indexes.json`, and on Enterprise an unindexed query does not
    // throw — it full-scans and bills the scan (root rule 1). A third clause
    // added here needs its own index entry in the same commit, and this is the
    // assertion that makes that impossible to forget.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());

    await listarContasShopeeAtivas(asDb(db));

    expect(db.consultas).toEqual([
      {
        fonte: INTEGRACAO_PATH,
        clausulas: [
          ['tipo', INTEGRACAO_TIPO.shopee],
          ['ativo', true],
        ],
        limite: null,
      },
    ]);
  });

  it('2 — devolve o id do documento e o shop_id RAW de cada conta ativa', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));

    const contas = await listarContasShopeeAtivas(asDb(db));

    expect(contas).toEqual([
      { integracaoId: INT_A, shopId: SHOP_A },
      { integracaoId: INT_B, shopId: SHOP_B },
    ]);
  });

  it('3 — uma conta SEM shop_id sai com shopId null e NÃO é descartada', async () => {
    // A consent given by MAIN ACCOUNT has no `shop_id`: it is a documented,
    // renderable state in this channel, not a failure. Dropping it here would
    // make the backfill's `semShopId` counter unreachable and would hide the
    // conta from every future caller that has something else to do with it.
    const db = new FakeDb();
    const semShop = contaDoc();
    delete semShop.shop_id;
    db.seed(`${INTEGRACAO_PATH}/${INT_A}`, semShop);
    db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));

    const contas = await listarContasShopeeAtivas(asDb(db));

    expect(contas).toEqual([
      { integracaoId: INT_A, shopId: null },
      { integracaoId: INT_B, shopId: SHOP_B },
    ]);
  });

  it('4 — NEAR-MISS: um shop_id não-numérico ou não-finito também vira null', async () => {
    // The raw read is `typeof === 'number' && Number.isFinite`, not a truthiness
    // test: a legacy document holding the id as a STRING would otherwise reach
    // `loadShopeeContext` as a value that cannot sign anything, and the failure
    // would surface at Shopee rather than here.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc({ shop_id: '987654' }));
    db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: Number.NaN }));

    const contas = await listarContasShopeeAtivas(asDb(db));

    expect(contas).toEqual([
      { integracaoId: INT_A, shopId: null },
      { integracaoId: INT_B, shopId: null },
    ]);
  });

  it('5 — contas inativas e de OUTRO canal não entram (o filtro vai ao servidor)', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    db.seed(`${INTEGRACAO_PATH}/inativa`, contaDoc({ ativo: false }));
    db.seed(
      `${INTEGRACAO_PATH}/outro-canal`,
      contaDoc({ tipo: INTEGRACAO_TIPO.mercadoLivre, shop_id: SHOP_B }),
    );

    const contas = await listarContasShopeeAtivas(asDb(db));

    expect(contas).toEqual([{ integracaoId: INT_A, shopId: SHOP_A }]);
  });

  it('6 — nenhuma conta ativa ⇒ lista vazia, uma consulta, nenhum outro caminho tocado', async () => {
    const db = new FakeDb();

    const contas = await listarContasShopeeAtivas(asDb(db));

    expect(contas).toEqual([]);
    expect(db.consultas).toHaveLength(1);
    // ⚠️ Nothing else is read — in particular nothing under `/credenciais/`.
    expect(db.caminhos).toEqual([INTEGRACAO_PATH]);
    expect(db.writes).toEqual([]);
  });
});
