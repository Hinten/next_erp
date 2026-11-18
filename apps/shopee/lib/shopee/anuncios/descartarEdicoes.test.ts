/**
 * `descartarEdicoesDoAnuncioShopee` — discard the pending ERP edits of a
 * published listing. The REAL module runs over the FakeDb; the Shopee read is a
 * counting fake, so "ZERO calls before the gate" is a number, not a promise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopeeItemBaseInfoRowSchema } from '@delfrance/integrations-shopee';
import {
  CAMPOS_DE_EDICAO_ERP_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  type CorpoDescartarEdicoesAnuncioShopee,
} from '@delfrance/schemas';

import type { ItemLido } from '../produtos/itemLido';
import { FakeDb, asDb, grpc, type DocData } from '../testing/fakeDb';
import { RecusaDeRascunhoShopeeError } from './rascunho';
import {
  TENTATIVAS_DO_DESCARTE,
  descartarEdicoesDoAnuncioShopee,
  type DescartarEdicoesDeps,
} from './descartarEdicoes';

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const REF_CONTA = `documents/integracao/${CONTA}`;
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const CAMINHO = `produtos/${PRODUTO}/prodshopee/${LINK}`;
const ITEM_ID = 2500139861;
const T0 = 1_760_000_000_000;
const REVISAO = 3;

const CORPO: CorpoDescartarEdicoesAnuncioShopee = {
  integracaoId: CONTA,
  produtoId: PRODUTO,
  linkDocId: LINK,
  revisao: REVISAO,
};

/** A published listing with an ERP edit saved and not yet sent. */
function link(extra: DocData = {}): DocData {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_ID,
    item_name: 'Título editado no ERP',
    description: 'Descrição editada no ERP',
    category_id: 100_017,
    brand_id: 0,
    original_brand_name: null,
    item_status: 'NORMAL',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    kitNativo: false,
    precos: { 'tab-1': 49.9 },
    edicaoErpRevisao: REVISAO,
    edicaoErpPendenteEm: T0 - 60_000,
    ...extra,
  };
}

/** What Shopee answers NOW — every content field differs from {@link link}. */
function anuncioDaShopee(): ItemLido {
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Título da Shopee',
    description: 'Descrição da Shopee',
    category_id: 100_017,
    brand: { brand_id: 7, original_brand_name: 'Marca Shopee' },
    attribute_list: [{ attribute_id: 1, attribute_value_list: [] }],
  });
  return { base, models: null, taxInfo: null, kit: null, itemId: ITEM_ID };
}

let db: FakeDb;
let lerAnuncio: ReturnType<typeof vi.fn<(itemId: number) => Promise<ItemLido>>>;

function deps(): DescartarEdicoesDeps {
  return { db: asDb(db), nowMs: T0, lerAnuncio };
}

function semear(doc: DocData | null = link()): void {
  if (doc !== null) db.seed(CAMINHO, doc);
}

beforeEach(() => {
  db = new FakeDb();
  lerAnuncio = vi.fn<(itemId: number) => Promise<ItemLido>>(async () => anuncioDaShopee());
});

async function recusa(corpo = CORPO): Promise<RecusaDeRascunhoShopeeError> {
  try {
    await descartarEdicoesDoAnuncioShopee(deps(), corpo);
  } catch (err) {
    if (err instanceof RecusaDeRascunhoShopeeError) return err;
    throw err;
  }
  throw new Error('esperava uma recusa');
}

/* ----------------------------------- gate --------------------------------- */

describe('o portão — nenhuma chamada à Shopee antes de passar', () => {
  it('⛔ 404 INEXISTENTE: o vínculo não existe', async () => {
    semear(null);

    const err = await recusa();

    expect(err.status).toBe(404);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);
    expect(lerAnuncio).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('⛔ 404 INEXISTENTE: o vínculo é de OUTRA conta', async () => {
    semear(link({ contaProdutoShopeeOuterRef: 'documents/integracao/int-2' }));

    const err = await recusa();

    expect(err.status).toBe(404);
    expect(lerAnuncio).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['um rascunho (sem item_id)', { item_id: null }],
    ['um kit nativo', { kitNativo: true }],
    ['um anúncio removido', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }],
    ['um vínculo substituído', { substituidoPorLinkDocId: 'outro-link' }],
  ])('⛔ 409 ANUNCIO_NAO_EDITAVEL: %s', async (_nome, over) => {
    semear(link(over));

    const err = await recusa();

    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.anuncioNaoEditavel);
    expect(lerAnuncio).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('⛔ 409 CONFLITO `conflitos: []`: a revisão que o operador viu não é a gravada', async () => {
    semear(link({ edicaoErpRevisao: REVISAO + 1 }));

    const err = await recusa();

    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    expect(err.conflitos).toEqual([]);
    expect(lerAnuncio).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('nada pendente ⇒ `descartado: false`, ZERO leituras na Shopee e ZERO gravações', async () => {
    semear(link({ edicaoErpPendenteEm: null }));

    await expect(descartarEdicoesDoAnuncioShopee(deps(), CORPO)).resolves.toEqual({
      linkDocId: LINK,
      descartado: false,
    });
    expect(lerAnuncio).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('NEAR-MISS: a flag AUSENTE (nunca editado) também é «nada pendente»', async () => {
    const { edicaoErpPendenteEm: _p, ...semFlag } = link();
    semear(semFlag);

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res.descartado).toBe(false);
    expect(lerAnuncio).not.toHaveBeenCalled();
  });
});

/* ---------------------------------- happy path ---------------------------- */

describe('descartar', () => {
  it('relê a Shopee UMA vez e grava só os campos de conteúdo + flag null + ultimaModificacao', async () => {
    semear();
    const antes = structuredClone(db.store[CAMINHO]?.data) as DocData;

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res).toEqual({ linkDocId: LINK, descartado: true });
    expect(lerAnuncio).toHaveBeenCalledTimes(1);
    expect(lerAnuncio).toHaveBeenCalledWith(ITEM_ID);

    expect(db.patches).toHaveLength(1);
    const patch = db.patches[0]?.patch ?? {};
    expect(Object.keys(patch).sort()).toEqual(
      [...CAMPOS_DE_EDICAO_ERP_SHOPEE, 'edicaoErpPendenteEm', 'ultimaModificacao'].sort(),
    );

    const depois = db.store[CAMINHO]?.data as DocData;
    expect(depois.item_name).toBe('Título da Shopee');
    expect(depois.description).toBe('Descrição da Shopee');
    expect(depois.brand_id).toBe(7);
    expect(depois.original_brand_name).toBe('Marca Shopee');
    expect(depois.edicaoErpPendenteEm).toBeNull();
    expect(depois.ultimaModificacao).toBe(T0);
    // D-C: the revision is NEVER bumped, and nothing outside the patch moves.
    expect(depois.edicaoErpRevisao).toBe(REVISAO);
    expect(depois.item_status).toBe(antes.item_status);
    expect(depois.estadoAnuncio).toBe(antes.estadoAnuncio);
    expect(depois.precos).toEqual(antes.precos);
    expect(depois.kitNativo).toBe(false);
  });

  it('um segundo descarte logo depois é «nada pendente» — idempotente, sem nova leitura', async () => {
    semear();
    await descartarEdicoesDoAnuncioShopee(deps(), CORPO);
    const escritas = db.writes.length;

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res.descartado).toBe(false);
    expect(lerAnuncio).toHaveBeenCalledTimes(1);
    expect(db.writes).toHaveLength(escritas);
  });

  it('um erro da Shopee propaga e NADA é gravado', async () => {
    semear();
    lerAnuncio.mockRejectedValue(new Error('shopee fora do ar'));

    await expect(descartarEdicoesDoAnuncioShopee(deps(), CORPO)).rejects.toThrow('shopee fora');
    expect(db.writes).toEqual([]);
  });
});

/* ------------------------------- rule 7 races ----------------------------- */

describe('corrida (rule 7)', () => {
  it('⛔ uma edição que bumpa a revisão ENQUANTO a Shopee é lida ⇒ 409 CONFLITO, nada gravado', async () => {
    semear();
    lerAnuncio.mockImplementation(async () => {
      db.seed(CAMINHO, link({ edicaoErpRevisao: REVISAO + 1 }));
      return anuncioDaShopee();
    });

    const err = await recusa();

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    expect(db.writes).toEqual([]);
  });

  it('⛔ um write-back que pousa ENQUANTO a Shopee é lida (revisão igual) faz a gravação perder e a Shopee ser lida DE NOVO — nunca grava a leitura velha', async () => {
    semear();
    let chamadas = 0;
    lerAnuncio.mockImplementation(async () => {
      chamadas += 1;
      // A republish's write-back lands during the FIRST read only: same
      // revision, flag still set, the stamp moves.
      if (chamadas === 1) db.seed(CAMINHO, link({ item_status: 'NORMAL' }));
      return anuncioDaShopee();
    });

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res.descartado).toBe(true);
    expect(lerAnuncio).toHaveBeenCalledTimes(2);
    expect(db.patches).toHaveLength(1);
  });

  it('⛔ a precondição perdida RE-DECIDE: a revisão mudou entre a leitura e a gravação ⇒ 409, o editado fica', async () => {
    semear();
    let primeira = true;
    vi.spyOn(db.falhasDeUpdate, 'get').mockImplementation(() => {
      if (!primeira) return undefined;
      primeira = false;
      // The editor lands between our read and our write.
      db.seed(CAMINHO, link({ edicaoErpRevisao: REVISAO + 1, item_name: 'Editado de novo' }));
      return grpc(9, 'FAILED_PRECONDITION');
    });

    const err = await recusa();

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    expect(db.writes).toEqual([]);
    expect((db.store[CAMINHO]?.data as DocData).item_name).toBe('Editado de novo');
  });

  it('uma precondição perdida SEM mudança de decisão: a releitura grava na 2ª tentativa', async () => {
    semear();
    let primeira = true;
    vi.spyOn(db.falhasDeUpdate, 'get').mockImplementation(() => {
      if (!primeira) return undefined;
      primeira = false;
      db.seed(CAMINHO, link({ precos: { 'tab-1': 59.9 } })); // an unrelated write
      return grpc(9, 'FAILED_PRECONDITION');
    });

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res.descartado).toBe(true);
    // The unrelated write survived: the patch names only its own keys.
    expect((db.store[CAMINHO]?.data as DocData).precos).toEqual({ 'tab-1': 59.9 });
  });

  it('⛔ a precondição perdida em TODA tentativa ⇒ 409 CONFLITO `conflitos: []`', async () => {
    semear();
    db.falhasDeUpdate.set(CAMINHO, grpc(9, 'FAILED_PRECONDITION'));

    const err = await recusa();

    expect(err.status).toBe(409);
    expect(err.conflitos).toEqual([]);
    expect(db.store[CAMINHO]?.data).toMatchObject({ item_name: 'Título editado no ERP' });
    expect(TENTATIVAS_DO_DESCARTE).toBe(3);
  });

  it('⛔ uma flag limpa por um Republicar no meio ⇒ `descartado: false`, nada gravado', async () => {
    semear();
    lerAnuncio.mockImplementation(async () => {
      db.seed(CAMINHO, link({ edicaoErpPendenteEm: null }));
      return anuncioDaShopee();
    });

    const res = await descartarEdicoesDoAnuncioShopee(deps(), CORPO);

    expect(res.descartado).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('⛔ uma falha do Firestore que não é a precondição propaga (rule 6)', async () => {
    semear();
    db.falhasDeUpdate.set(CAMINHO, grpc(14, 'UNAVAILABLE'));

    await expect(descartarEdicoesDoAnuncioShopee(deps(), CORPO)).rejects.toThrow('UNAVAILABLE');
  });
});
