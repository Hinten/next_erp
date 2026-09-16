import { describe, expect, it, vi } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  shopeeModelSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import type { ItemLido } from './itemLido';
import {
  planejarImportacaoShopee,
  type PlanoImportacaoShopee,
  type PreparoFilhoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';
import { aplicarFilhoShopee, aplicarFilhoUnicoShopee } from './variacoesShopee';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const PAI = 'prod-pai';
const AGORA = 1_757_000_000_000;

const PRECO_BRL = [{ currency: 'BRL', original_price: 29.9, current_price: 19.9 }];

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [0], ...parcial });
}

function listaDeModelos(models: ShopeeModel[], tiers?: unknown) {
  return shopeeModelListPayloadSchema.parse({
    model: models,
    tier_variation: tiers ?? [
      { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
    ],
  });
}

function item(
  models: ShopeeModel[],
  tiers?: unknown,
  parcial: Record<string, unknown> = {},
): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      item_sku: 'CAM-001',
      has_model: true,
      weight: '0.5',
      dimension: { package_length: 30, package_width: 20, package_height: 10 },
      ...parcial,
    }),
    models: listaDeModelos(models, tiers),
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function filho(m: ShopeeModel, parcial: Partial<PreparoFilhoShopee> = {}): PreparoFilhoShopee {
  return {
    modelo: m,
    existente: null,
    vinculoDeOutraFamilia: false,
    link: null,
    estoque: null,
    ...parcial,
  };
}

function plano(
  models: ShopeeModel[],
  tiers?: unknown,
  parcial: Partial<PreparoImportacaoShopee> = {},
) {
  const entrada = item(models, tiers);
  const preparo: PreparoImportacaoShopee = {
    entrada,
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: DEPOSITO,
    pai: {
      existente: { id: PAI, raw: { nome: 'Camiseta Básica', paiId: null } },
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: true,
      estoque: null,
    },
    filhos: models.map((m) => filho(m)),
    linkPai: { id: 'link-1', raw: {} },
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
  return planejarImportacaoShopee(preparo);
}

async function aplicarTodosOsFilhos(db: FakeDb, p: PlanoImportacaoShopee): Promise<string[]> {
  const criados: string[] = [];
  for (const [i, f] of p.filhos.entries()) {
    const id = p.filhoUnico.idsPlanejados[i] ?? '';
    const res = await aplicarFilhoShopee(asDb(db), f, id, PAI, 'link-1');
    if (res.criado) criados.push(res.produtoId);
  }
  return criados;
}

/* --------------------------- 1. o filho escrito --------------------------- */

describe('aplicarFilhoShopee — o documento do filho', () => {
  it('compõe o nome com o nome do pai e as opções do tier', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ tier_index: [1], price_info: PRECO_BRL })]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(id)}`]?.data.nome).toBe('Camiseta Básica Verde');
  });

  it('⛔ um `tier_index` FORA da lista de opções não contribui nada e cai no fallback', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ tier_index: [9], model_sku: 'CAM-001-X', price_info: PRECO_BRL })]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(id)}`]?.data.nome).toBe('Camiseta Básica CAM-001-X');
  });

  it('sem `model_sku` o fallback é o `model_id` — nunca um nome vazio', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ tier_index: [9], price_info: PRECO_BRL })]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(id)}`]?.data.nome).toBe(
      `Camiseta Básica ${String(MODEL_ID)}`,
    );
  });

  it('o `sku` do filho é o `model_sku` VERBATIM e o gtin `00` vira null', async () => {
    const db = new FakeDb();
    const p = plano([
      modelo({ model_sku: ' CAM-001-AZ ', gtin_code: '00', price_info: PRECO_BRL }),
    ]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    const doc = db.store[`produtos/${String(id)}`]?.data ?? {};
    expect(doc.sku).toBe('CAM-001-AZ');
    expect(doc.gtin).toBeNull();
  });

  it('as dimensões caem para as do ITEM quando o modelo não traz as suas', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ price_info: PRECO_BRL })]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(id)}`]?.data).toMatchObject({
      alturaCm: 10,
      larguraCm: 20,
      profundidadeCm: 30,
      pesoLiquidoKg: 0.5,
    });
  });

  it('cada filho leva o SEU preço, do seu próprio `price_info`', async () => {
    const db = new FakeDb();
    const p = plano([
      modelo({ model_id: 1, tier_index: [0], price_info: PRECO_BRL }),
      modelo({
        model_id: 2,
        tier_index: [1],
        price_info: [{ currency: 'BRL', original_price: 39.9, current_price: 39.9 }],
      }),
    ]);
    const criados = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(criados[0])}`]?.data.precos).toEqual({
      'tab-normal': { valor: 29.9 },
    });
    expect(db.store[`produtos/${String(criados[1])}`]?.data.precos).toEqual({
      'tab-normal': { valor: 39.9 },
    });
  });

  it('a ordem interna do filho é preço → produto → estoque → vínculo', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PAI}-existente`, {});
    const p = plano([modelo({ price_info: PRECO_BRL })], undefined, {
      options: opcoes({ sobrescreverEstoque: true }),
    });
    const filhoId = p.filhoUnico.idsPlanejados[0] ?? '';
    // Um filho que JÁ existe: só aí o patch guardado de preço tem o que fazer.
    db.seed(`produtos/${filhoId}`, { nome: 'Camiseta Básica Azul', paiId: PAI });
    const pExistente = plano([modelo({ price_info: PRECO_BRL })], undefined, {
      filhos: [
        filho(modelo({ price_info: PRECO_BRL }), {
          existente: { id: filhoId, raw: { nome: 'Camiseta Básica Azul', paiId: PAI } },
        }),
      ],
    });

    await aplicarFilhoShopee(asDb(db), pExistente.filhos[0]!, filhoId, PAI, 'link-1');

    const caminhos = db.writes.map((w) => w.path);
    expect(caminhos[0]).toBe(`produtos/${filhoId}`); // o patch pontilhado de preço
    expect(db.writes[0]?.patch).toEqual({ 'precos.tab-normal': { valor: 29.9 } });
    expect(caminhos[caminhos.length - 1]?.startsWith(`produtos/${filhoId}/variashopee/`)).toBe(
      true,
    );
  });

  it('um `model_id: 0` cria o FILHO e não escreve vínculo nenhum', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ model_id: 0, price_info: PRECO_BRL })]);
    const [id] = await aplicarTodosOsFilhos(db, p);

    expect(db.store[`produtos/${String(id)}`]).toBeDefined();
    expect(db.idsEm(`produtos/${String(id)}/variashopee`)).toEqual([]);
    expect(p.resultado.variacoes.semLink).toBe(1);
  });

  it('uma criação que PERDE a corrida vira merge — e não relata `criado`', async () => {
    const db = new FakeDb();
    const p = plano([modelo({ price_info: PRECO_BRL })]);
    const filhoId = p.filhoUnico.idsPlanejados[0] ?? '';
    db.seed(`produtos/${filhoId}`, { nome: 'do vencedor', paiId: PAI });

    const res = await aplicarFilhoShopee(asDb(db), p.filhos[0]!, filhoId, PAI, 'link-1');

    expect(res.criado).toBe(false);
    expect(db.store[`produtos/${filhoId}`]?.data.nome).toBe('Camiseta Básica Azul');
  });
});

/* ------------------- 2. a família de UM, sem sufixo ----------------------- */

describe('o anúncio de UM model', () => {
  it('vira pai + UM filho, com o `sku` do model verbatim', async () => {
    const db = new FakeDb();
    const p = plano(
      [modelo({ model_sku: 'CAM-001-AZ', price_info: PRECO_BRL })],
      [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
    );
    const criados = await aplicarTodosOsFilhos(db, p);

    expect(criados).toHaveLength(1);
    expect(db.store[`produtos/${String(criados[0])}`]?.data.sku).toBe('CAM-001-AZ');
  });

  it('⛔ NEAR-MISS: um anúncio de 1 model NÃO recebe sufixo `-UN` em sku nenhum', async () => {
    const db = new FakeDb();
    const p = plano(
      [modelo({ model_sku: 'CAM-001', price_info: PRECO_BRL })],
      [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
    );
    await aplicarTodosOsFilhos(db, p);

    const escrito = JSON.stringify(db.writes);
    expect(escrito).not.toContain('-UN');
    // O caso aceito e documentado: pai e filho ficam com o MESMO código.
    expect(p.filhos[0]?.produto?.data.sku).toBe('CAM-001');
  });
});

/* ----------------------------- 3. filhoUnicoId ---------------------------- */

/**
 * A database whose CHILD QUERY lands a concurrent writer — the only way to make
 * the read and the write disagree without mocking the writer.
 */
function comEscritaConcorrente(db: FakeDb, vezes: number, escrever: () => void): FakeDb {
  let restantes = vezes;
  const collection = db.collection.bind(db);
  return new Proxy(db, {
    get(alvo, prop, receiver) {
      if (prop !== 'collection') return Reflect.get(alvo, prop, receiver) as unknown;
      return (caminho: string) => {
        const consulta = collection(caminho);
        const get = consulta.get.bind(consulta);
        consulta.get = async () => {
          const resultado = await get();
          if (caminho === 'produtos' && restantes > 0) {
            restantes -= 1;
            escrever();
          }
          return resultado;
        };
        return consulta;
      };
    },
  });
}

describe('aplicarFilhoUnicoShopee', () => {
  function semearFamilia(db: FakeDb, filhos: string[], filhoUnicoId: unknown = null): void {
    db.seed(`produtos/${PAI}`, { nome: 'Camiseta Básica', paiId: null, filhoUnicoId });
    for (const id of filhos) db.seed(`produtos/${id}`, { nome: id, paiId: PAI });
  }

  it('deriva o ponteiro para a família de UM', async () => {
    const db = new FakeDb();
    semearFamilia(db, ['f-1']);

    await aplicarFilhoUnicoShopee(asDb(db), PAI, AGORA);

    expect(db.store[`produtos/${PAI}`]?.data.filhoUnicoId).toBe('f-1');
    expect(db.store[`produtos/${PAI}`]?.data.ultimaModificacao).toBe(AGORA);
  });

  it('deriva `null` para a família de MUITOS', async () => {
    const db = new FakeDb();
    semearFamilia(db, ['f-1', 'f-2'], 'f-1');

    await aplicarFilhoUnicoShopee(asDb(db), PAI, AGORA);

    expect(db.store[`produtos/${PAI}`]?.data.filhoUnicoId).toBeNull();
  });

  it('não escreve quando o ponteiro NÃO mudou', async () => {
    const db = new FakeDb();
    semearFamilia(db, ['f-1'], 'f-1');

    await aplicarFilhoUnicoShopee(asDb(db), PAI, AGORA);

    expect(db.patches).toEqual([]);
  });

  it('um pai que não existe não é criado por este reparo', async () => {
    const db = new FakeDb();
    await aplicarFilhoUnicoShopee(asDb(db), PAI, AGORA);
    expect(db.writes).toEqual([]);
  });

  it('⛔ uma pré-condição perdida RE-DERIVA — nunca reaplica o mesmo ponteiro', async () => {
    const db = new FakeDb();
    semearFamilia(db, ['f-1']);
    // Entre a leitura do pai e a escrita, outro import cria o SEGUNDO filho.
    const comCorrida = comEscritaConcorrente(db, 1, () => {
      db.seed('produtos/f-2', { nome: 'f-2', paiId: PAI });
      db.seed(`produtos/${PAI}`, { nome: 'Camiseta Básica', paiId: null, filhoUnicoId: null });
    });

    await aplicarFilhoUnicoShopee(asDb(comCorrida), PAI, AGORA);

    // Reaplicar o patch teria deixado `f-1` — o ponteiro obsoleto que este
    // reparo existe para evitar.
    expect(db.store[`produtos/${PAI}`]?.data.filhoUnicoId).toBeNull();
    expect(db.patches.filter((p) => p.path === `produtos/${PAI}`)).toEqual([]);
  });

  it('⛔ uma SEGUNDA perda pula o reparo com um aviso — e não lança', async () => {
    const db = new FakeDb();
    semearFamilia(db, ['f-1']);
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    const comCorrida = comEscritaConcorrente(db, 2, () => {
      n += 1;
      db.seed(`produtos/${PAI}`, {
        nome: 'Camiseta Básica',
        paiId: null,
        filhoUnicoId: null,
        toque: n,
      });
    });

    await expect(aplicarFilhoUnicoShopee(asDb(comCorrida), PAI, AGORA)).resolves.toBeUndefined();

    expect(avisos).toHaveBeenCalledTimes(1);
    expect(db.patches.filter((p) => p.path === `produtos/${PAI}`)).toEqual([]);
    avisos.mockRestore();
  });
});
