import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shopeeItemBaseInfoRowSchema, shopeeModelSchema } from '@delfrance/integrations-shopee';
import type { ShopeeModel } from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import type { ItemLido } from './itemLido';
import { idProdutoFilhoShopee, idProdutoPaiShopee } from './produtoIds';
import {
  idDoFilhoPlanejado,
  idDoPaiPlanejado,
  resolverFilhosDaListagem,
  resolverPaiDaListagem,
  skuDoItemShopee,
  vinculoNomeiaOutroModelo,
  type ComboDoFilho,
} from './resolveProduto';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma real.                                       */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const OUTRA = 'int-2';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_OUTRA = `documents/integracao/${OUTRA}`;
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const OUTRO_MODEL_ID = 2000458803;
const PAI = 'prod-pai';

function item(parcial: Record<string, unknown> = {}): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      ...parcial,
    }),
    models: null,
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: MODEL_ID, ...parcial });
}

/**
 * ⚠️ `sku` e `paiId` SEMPRE explícitos: o FakeDb casa por igualdade estrita,
 * como o índice do Firestore — um documento sem o campo não entra no índice e
 * não pode casar `where('paiId', '==', null)`.
 */
function semearProduto(db: FakeDb, id: string, over: Record<string, unknown> = {}): void {
  db.seed(`produtos/${id}`, { sku: null, paiId: null, ...over });
}

/**
 * O carimbo GRAVADO de um produto. O resolvido tem de carregar este MESMO
 * objeto — é o que o patch de preço guardado afirma como `lastUpdateTime`.
 */
function carimboDe(db: FakeDb, id: string): unknown {
  return db.store[`produtos/${id}`]?.updateTime;
}

function semearLinkDaListagem(
  db: FakeDb,
  opts: { produtoId: string; docId?: string; itemId?: number; conta?: string },
): string {
  const docId = opts.docId ?? 'link-1';
  db.seed(`produtos/${opts.produtoId}/prodshopee/${docId}`, {
    item_id: opts.itemId ?? ITEM_ID,
    contaProdutoShopeeOuterRef: opts.conta ?? REF_CONTA,
    item_name: 'Camiseta Básica',
  });
  return docId;
}

function semearLinkDaVariacao(
  db: FakeDb,
  opts: { produtoId: string; docId?: string; modelId?: number | string; conta?: string },
): string {
  const docId = opts.docId ?? 'var-1';
  db.seed(`produtos/${opts.produtoId}/variashopee/${docId}`, {
    model_id: opts.modelId ?? MODEL_ID,
    contaVariacaoShopeeOuterRef: opts.conta ?? REF_CONTA,
  });
  return docId;
}

const consultasDeGrupo = (db: FakeDb, nome: string) =>
  db.consultas.filter((c) => c.fonte === `group:${nome}`);

const consultasDeProdutos = (db: FakeDb) => db.consultas.filter((c) => c.fonte === 'produtos');

function combo(...uids: string[]): ComboDoFilho {
  return { variacoesUid: uids.length === 0 ? null : uids };
}

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  1. A cascata do PAI                                                        */
/* -------------------------------------------------------------------------- */

describe('resolverPaiDaListagem — os quatro degraus', () => {
  it('degrau 1: o `prodshopee` resolve o pai, com extraData e filhos', async () => {
    const db = new FakeDb();
    semearProduto(db, PAI, { sku: 'SKU-PAI' });
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-F' });
    semearLinkDaListagem(db, { produtoId: PAI });
    db.seed(`produtos/${PAI}/extraData/singleton`, { observacoes: 'oi' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(r.existente).toEqual({
      id: PAI,
      raw: { sku: 'SKU-PAI', paiId: null },
      updateTime: carimboDe(db, PAI),
    });
    // A IDENTIDADE do carimbo lido — é ele que o patch guardado afirma.
    expect(r.existente?.updateTime).toBe(carimboDe(db, PAI));
    // O vínculo não carrega carimbo: nenhuma escrita de vínculo é guardada.
    expect(r.link).not.toHaveProperty('updateTime');
    expect(r.extraData).toEqual({ observacoes: 'oi' });
    expect(r.jaTemFilhos).toBe(true);
    expect(r.linkSobFilho).toBe(false);
    expect(r.link?.id).toBe('link-1');
  });

  it('degrau 1: a consulta leva `item_id` como NÚMERO e o filtro de CONTA ao servidor', async () => {
    const db = new FakeDb();
    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    const [consulta] = consultasDeGrupo(db, 'prodshopee');
    expect(consulta!.clausulas).toEqual([
      ['item_id', ITEM_ID],
      ['contaProdutoShopeeOuterRef', REF_CONTA],
    ]);
    expect(typeof consulta!.clausulas[0]![1]).toBe('number');
    expect(consulta!.limite).toBe(2);
  });

  it('⛔ NEAR-MISS: um vínculo de OUTRA conta não resolve nada', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-alheio', { sku: 'SKU-PAI' });
    semearLinkDaListagem(db, { produtoId: 'prod-alheio', conta: REF_OUTRA });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(r.existente).toBeNull();
    expect(r.link).toBeNull();
  });

  it('degrau 1 com produto APAGADO cai para o degrau do SKU e reaproveita o vínculo', async () => {
    const db = new FakeDb();
    // O link aponta para um produto que não existe mais — é linha velha, não conflito.
    semearLinkDaListagem(db, { produtoId: 'prod-sumido' });
    semearProduto(db, 'prod-por-sku', { sku: 'SKU-PAI' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: 'SKU-PAI' }));

    expect(r.existente?.id).toBe('prod-por-sku');
    expect(r.link?.id).toBe('link-1');
    expect(r.linkSobFilho).toBe(false);
  });

  it('degrau 2: `sku` + `paiId == null`, aceito em EXATAMENTE um', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-por-sku', { sku: 'SKU-PAI' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: '  SKU-PAI  ' }));

    expect(r.existente?.id).toBe('prod-por-sku');
    expect(r.existente?.updateTime).toBe(carimboDe(db, 'prod-por-sku'));
    const [porSku, deFilhos] = consultasDeProdutos(db);
    expect(porSku!.clausulas).toEqual([
      ['sku', 'SKU-PAI'],
      ['paiId', null],
    ]);
    expect(porSku!.limite).toBe(2);
    // a SEGUNDA consulta é a de filhos, já com o produto resolvido
    expect(deFilhos!.clausulas).toEqual([['paiId', 'prod-por-sku']]);
  });

  it('⛔ NEAR-MISS: DOIS produtos com o mesmo sku declinam o degrau — `limit(2)` é detector', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-a', { sku: 'SKU-PAI' });
    semearProduto(db, 'prod-b', { sku: 'SKU-PAI' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: 'SKU-PAI' }));

    expect(r.existente).toBeNull();
    expect(r.jaTemFilhos).toBe(false);
  });

  it('degrau 2 NÃO é consultado com `item_sku` vazio', async () => {
    const db = new FakeDb();
    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: '   ' }));
    expect(consultasDeProdutos(db)).toHaveLength(0);
  });

  it('degrau 3: nada resolve — tudo em branco, e o id planejado é o determinístico', async () => {
    const db = new FakeDb();
    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(r).toEqual({
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      link: null,
    });
    expect(idDoPaiPlanejado(INTEGRACAO, ITEM_ID)).toBe(idProdutoPaiShopee(INTEGRACAO, ITEM_ID));
  });

  it('extraData ausente lê `null`, nunca `{}`', async () => {
    const db = new FakeDb();
    semearProduto(db, PAI, { sku: 'SKU-PAI' });
    semearLinkDaListagem(db, { produtoId: PAI });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());
    expect(r.extraData).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  2. As duas recusas — BANDEIRAS, e nada é escrito                           */
/* -------------------------------------------------------------------------- */

describe('as duas recusas de vínculo inconsistente', () => {
  it('um `prodshopee` sob um FILHO recusa o item e não resolve nada', async () => {
    const db = new FakeDb();
    semearProduto(db, PAI, { sku: 'SKU-PAI' });
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-PAI' });
    semearLinkDaListagem(db, { produtoId: 'prod-filho' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: 'SKU-PAI' }));

    expect(r.linkSobFilho).toBe(true);
    expect(r.existente).toBeNull();
    expect(r.jaTemFilhos).toBe(false);
    expect(r.link?.id).toBe('link-1');
    // ⚠️ a recusa é BANDEIRA: quem lança é `planejarImportacaoShopee`.
    expect(db.writes).toEqual([]);
  });

  it('um `variashopee` apontando para OUTRA família recusa o modelo, sem escrever', async () => {
    const db = new FakeDb();
    semearProduto(db, PAI);
    semearProduto(db, 'prod-alheio', { paiId: 'outro-pai', sku: 'SKU-M' });
    semearLinkDaVariacao(db, { produtoId: 'prod-alheio' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_sku: 'SKU-M' })],
      [combo()],
      null,
    );

    expect(r!.vinculoDeOutraFamilia).toBe(true);
    expect(r!.existente).toBeNull();
    expect(r!.link?.id).toBe('var-1');
    expect(db.writes).toEqual([]);
    // recusado ANTES do degrau do sku: o produto alheio casa `SKU-M` e mesmo
    // assim nenhuma consulta por sku é emitida.
    expect(consultasDeProdutos(db).some((c) => c.clausulas[0]?.[0] === 'sku')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. A cascata do FILHO                                                      */
/* -------------------------------------------------------------------------- */

describe('resolverFilhosDaListagem — os quatro degraus', () => {
  it('degrau 1: o `variashopee` da MESMA família resolve o filho', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-M' });
    semearLinkDaVariacao(db, { produtoId: 'prod-filho' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo()],
      [combo()],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
    expect(r!.existente?.updateTime).toBe(carimboDe(db, 'prod-filho'));
    expect(r!.vinculoDeOutraFamilia).toBe(false);
    expect(r!.link?.id).toBe('var-1');
    const [consulta] = consultasDeGrupo(db, 'variashopee');
    expect(consulta!.clausulas).toEqual([
      ['model_id', MODEL_ID],
      ['contaVariacaoShopeeOuterRef', REF_CONTA],
    ]);
    expect(consulta!.limite).toBe(2);
  });

  it('⛔ `model_id` 0 PULA o degrau 1 inteiro — zero consultas em variashopee', async () => {
    const db = new FakeDb();
    // Um vínculo com model_id 0 existe no banco e NÃO pode ser tocado: 0 é o
    // sentinela "item sem modelo" e casaria qualquer linha de qualquer anúncio.
    semearLinkDaVariacao(db, { produtoId: 'prod-armadilha', modelId: 0 });
    semearProduto(db, 'prod-armadilha', { paiId: PAI, sku: 'SKU-M' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: 0, model_sku: 'SKU-M' })],
      [combo()],
      null,
    );

    expect(consultasDeGrupo(db, 'variashopee')).toHaveLength(0);
    // o degrau 2 ainda responde — o que morre é só o vínculo
    expect(r!.existente?.id).toBe('prod-armadilha');
    expect(r!.link).toBeNull();
  });

  it('degrau 2: `sku` escopado ao PAI, aceito em exatamente um', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-M' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_sku: '  SKU-M ' })],
      [combo()],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
    expect(r!.existente?.updateTime).toBe(carimboDe(db, 'prod-filho'));
    const porSku = consultasDeProdutos(db).find((c) => c.clausulas[0]?.[0] === 'sku');
    expect(porSku!.clausulas).toEqual([
      ['sku', 'SKU-M'],
      ['paiId', PAI],
    ]);
    expect(porSku!.limite).toBe(2);
  });

  it('⛔ NEAR-MISS: dois filhos com o mesmo sku sob o pai declinam o degrau 2', async () => {
    const db = new FakeDb();
    semearProduto(db, 'f-a', { paiId: PAI, sku: 'SKU-M' });
    semearProduto(db, 'f-b', { paiId: PAI, sku: 'SKU-M' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_sku: 'SKU-M' })],
      [combo()],
      null,
    );
    expect(r!.existente).toBeNull();
  });

  it('degrau 3: a combinação casa o irmão mesmo FORA DE ORDEM e reaproveita o vínculo dele', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['b', 'a'] });
    semearLinkDaVariacao(db, { produtoId: 'prod-filho', docId: 'var-meu', modelId: MODEL_ID });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID })],
      [combo('a', 'b')],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
    expect(r!.existente?.updateTime).toBe(carimboDe(db, 'prod-filho'));
    expect(r!.link?.id).toBe('var-meu');
  });

  it('⛔ NEAR-MISS: uma combinação DIFERENTE não casa o irmão', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a', 'b'] });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo()],
      [combo('a', 'c')],
      null,
    );
    expect(r!.existente).toBeNull();
  });

  it('degrau 4: nada resolve, e o id planejado é o determinístico do filho', async () => {
    const db = new FakeDb();
    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      false,
      [modelo()],
      [combo('a')],
      null,
    );

    expect(r).toEqual({
      modelo: expect.objectContaining({ model_id: MODEL_ID }),
      existente: null,
      vinculoDeOutraFamilia: false,
      link: null,
    });
    expect(idDoFilhoPlanejado(PAI, MODEL_ID)).toBe(idProdutoFilhoShopee(PAI, MODEL_ID));
  });

  it('devolve UMA entrada por modelo, na ORDEM dos modelos', async () => {
    const db = new FakeDb();
    const rs = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      false,
      [modelo({ model_id: 11 }), modelo({ model_id: 22 }), modelo({ model_id: 33 })],
      [combo(), combo(), combo()],
      null,
    );
    expect(rs.map((r) => r.modelo.model_id)).toEqual([11, 22, 33]);
  });

  it('dois modelos NUNCA amarram o mesmo irmão — pelo degrau da COMBINAÇÃO', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a'] });

    const rs = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: 11 }), modelo({ model_id: 22 })],
      [combo('a'), combo('a')],
      null,
    );

    expect(rs[0]!.existente?.id).toBe('prod-filho');
    expect(rs[1]!.existente).toBeNull();
  });

  it('dois modelos NUNCA amarram o mesmo irmão — pelo degrau do SKU', async () => {
    // ⚠️ `model_sku` não tem restrição de unicidade no wire: a página de
    // `get_model_list` só diz "SKU of this model. the length should be under
    // 100". Dois modelos com o mesmo sku amarrando o MESMO produto significam um
    // documento para dois modelos — o preço e o estoque do segundo por cima do
    // primeiro — e dois `variashopee` sob ele nomeando `model_id` diferentes,
    // estado que não se cura sozinho: no import seguinte os DOIS modelos vencem
    // o degrau 1 nesse mesmo filho.
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-COMPARTILHADO' });

    const rs = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [
        modelo({ model_id: 11, model_sku: 'SKU-COMPARTILHADO' }),
        modelo({ model_id: 22, model_sku: 'SKU-COMPARTILHADO' }),
      ],
      [combo(), combo()],
      null,
    );

    expect(rs[0]!.existente?.id).toBe('prod-filho');
    expect(rs[1]!.existente).toBeNull();
  });

  it('degrau 2: um irmão cujo vínculo nomeia OUTRO modelo não é adotado pelo sku', async () => {
    // O caso entre execuções: o vendedor renomeou o sku de um modelo e criou um
    // novo com o sku antigo. Sem esta guarda o modelo novo adota o filho do
    // modelo velho, e o velho fica órfão.
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-ANTIGO' });
    semearLinkDaVariacao(db, { produtoId: 'prod-filho', modelId: OUTRO_MODEL_ID });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID, model_sku: 'SKU-ANTIGO' })],
      [combo()],
      null,
    );

    expect(r!.existente).toBeNull();
    expect(r!.link).toBeNull();
  });

  it('degrau 2: ⛔ NEAR-MISS — um vínculo que NÃO nomeia outro modelo é adotado e REAPROVEITADO', async () => {
    // A outra metade da mesma guarda, e a que impede o conserto de virar um
    // "nunca adote nada". Uma linha legada sem `model_id` não é evidência da
    // reivindicação de ninguém: o degrau 1 não a acha (ela não entra no índice
    // de `model_id`), o degrau 2 acha o filho pelo sku, e o vínculo é REUSADO —
    // um `merge`, não um segundo `variashopee` sob o mesmo produto.
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: 'SKU-A' });
    db.seed('produtos/prod-filho/variashopee/var-legado', {
      contaVariacaoShopeeOuterRef: REF_CONTA,
    });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID, model_sku: 'SKU-A' })],
      [combo()],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
    expect(r!.link?.id).toBe('var-legado');
  });
});

/* -------------------------------------------------------------------------- */
/*  4. A leitura PREGUIÇOSA dos irmãos                                         */
/* -------------------------------------------------------------------------- */

describe('os irmãos são lidos uma única vez, e só quando servem', () => {
  const consultasDeIrmaos = (db: FakeDb) =>
    consultasDeProdutos(db).filter(
      (c) => c.limite === null && c.clausulas.length === 1 && c.clausulas[0]![0] === 'paiId',
    );

  it('pai que ainda NÃO existe ⇒ zero leituras de irmãos', async () => {
    const db = new FakeDb();
    await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      false,
      [modelo({ model_id: 11 }), modelo({ model_id: 22 })],
      [combo('a'), combo('b')],
      null,
    );
    expect(consultasDeIrmaos(db)).toHaveLength(0);
  });

  it('modelo sem combinação ⇒ os irmãos nem são lidos', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a'] });

    await resolverFilhosDaListagem(asDb(db), INTEGRACAO, PAI, true, [modelo()], [combo()], null);
    expect(consultasDeIrmaos(db)).toHaveLength(0);
  });

  it('dois modelos com combinação ⇒ UMA única leitura de irmãos', async () => {
    const db = new FakeDb();
    semearProduto(db, 'f-a', { paiId: PAI, sku: null, variacoesUid: ['a'] });
    semearProduto(db, 'f-b', { paiId: PAI, sku: null, variacoesUid: ['b'] });

    const rs = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: 11 }), modelo({ model_id: 22 })],
      [combo('a'), combo('b')],
      null,
    );

    expect(rs.map((r) => r.existente?.id)).toEqual(['f-a', 'f-b']);
    expect(consultasDeIrmaos(db)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. O detector de duplicados — o primeiro id vence, e nada é apagado        */
/* -------------------------------------------------------------------------- */

describe('vínculos duplicados: o primeiro id vence, e NADA é apagado', () => {
  function comDoisLinksDaListagem(): FakeDb {
    const db = new FakeDb();
    semearProduto(db, 'prod-z', { sku: null });
    semearProduto(db, 'prod-a', { sku: null });
    // semeados fora de ordem: a escolha não pode depender do que a query devolve.
    semearLinkDaListagem(db, { produtoId: 'prod-z', docId: 'link-z' });
    semearLinkDaListagem(db, { produtoId: 'prod-a', docId: 'link-a' });
    return db;
  }

  it('dois `prodshopee` para a mesma chave: vence o lexicograficamente primeiro', async () => {
    const db = comDoisLinksDaListagem();

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(r.link?.id).toBe('link-a');
    expect(r.existente?.id).toBe('prod-a');
  });

  it('nenhum dos dois documentos é APAGADO — um deles pode ser um vínculo humano', async () => {
    const db = comDoisLinksDaListagem();

    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(db.store['produtos/prod-z/prodshopee/link-z']).toBeDefined();
    expect(db.store['produtos/prod-a/prodshopee/link-a']).toBeDefined();
    expect(db.writes).toEqual([]);
  });

  it('o aviso carrega a contagem e o id escolhido — e NENHUM corpo', async () => {
    const db = comDoisLinksDaListagem();

    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());

    expect(avisos).toHaveBeenCalledWith(expect.stringContaining('mais de um vínculo'), {
      integracaoId: INTEGRACAO,
      itemId: ITEM_ID,
      subcolecao: 'prodshopee',
      encontrados: 2,
      escolhido: 'link-a',
    });
    expect(JSON.stringify(avisos.mock.calls)).not.toContain('Camiseta');
  });

  it('dois `variashopee` para o mesmo modelo: primeiro id, nada apagado, um aviso', async () => {
    const db = new FakeDb();
    semearProduto(db, 'f-z', { paiId: PAI, sku: null });
    semearProduto(db, 'f-a', { paiId: PAI, sku: null });
    semearLinkDaVariacao(db, { produtoId: 'f-z', docId: 'var-z' });
    semearLinkDaVariacao(db, { produtoId: 'f-a', docId: 'var-a' });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo()],
      [combo()],
      null,
    );

    expect(r!.link?.id).toBe('var-a');
    expect(r!.existente?.id).toBe('f-a');
    expect(db.store['produtos/f-z/variashopee/var-z']).toBeDefined();
    expect(db.store['produtos/f-a/variashopee/var-a']).toBeDefined();
    expect(db.writes).toEqual([]);
    expect(avisos).toHaveBeenCalledWith(
      expect.stringContaining('mais de um vínculo'),
      expect.objectContaining({ subcolecao: 'variashopee', modelId: MODEL_ID, encontrados: 2 }),
    );
  });

  it('⛔ dois `variashopee` sob o MESMO filho, no degrau da COMBINAÇÃO: vence o lexicamente primeiro, UMA linha de log, nada apagado', async () => {
    // O único caminho até aqui: nenhum dos dois vínculos NOMEIA um modelo — um
    // que nomeasse ESTE modelo teria sido achado pelo degrau 1, e um que
    // nomeasse OUTRO desqualificaria o irmão. Um `model_id` ausente responde
    // FALSE em `vinculoNomeiaOutroModelo`, então o irmão continua candidato e o
    // duplicado chega ao degrau 3 — onde ele era escolhido em SILÊNCIO.
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a'] });
    // Semeados fora de ordem: a escolha não pode depender do que a leitura devolve.
    db.seed('produtos/prod-filho/variashopee/var-z', {
      model_id: null,
      contaVariacaoShopeeOuterRef: REF_CONTA,
    });
    db.seed('produtos/prod-filho/variashopee/var-a', {
      model_id: null,
      contaVariacaoShopeeOuterRef: REF_CONTA,
    });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID })],
      [combo('a')],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
    expect(r!.link?.id).toBe('var-a');
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos).toHaveBeenCalledWith(
      expect.stringContaining('mais de um vínculo'),
      expect.objectContaining({
        subcolecao: 'variashopee',
        modelId: MODEL_ID,
        produtoId: 'prod-filho',
        encontrados: 2,
        escolhido: 'var-a',
      }),
    );
    expect(db.store['produtos/prod-filho/variashopee/var-z']).toBeDefined();
    expect(db.store['produtos/prod-filho/variashopee/var-a']).toBeDefined();
    expect(db.writes).toEqual([]);
  });

  it('um único vínculo NÃO avisa nada', async () => {
    const db = new FakeDb();
    semearProduto(db, PAI, { sku: null });
    semearLinkDaListagem(db, { produtoId: PAI });

    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());
    expect(avisos).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  6. `vinculoNomeiaOutroModelo`                                              */
/* -------------------------------------------------------------------------- */

describe('vinculoNomeiaOutroModelo', () => {
  it('⛔ um `model_id` AUSENTE responde FALSE — "não nomeia nada" não é prova de ninguém', () => {
    expect(vinculoNomeiaOutroModelo({}, MODEL_ID)).toBe(false);
    expect(vinculoNomeiaOutroModelo({ model_id: null }, MODEL_ID)).toBe(false);
    expect(vinculoNomeiaOutroModelo({ model_id: { a: 1 } }, MODEL_ID)).toBe(false);
  });

  it('compara como STRING — a linha da era Flutter guarda o id em texto', () => {
    expect(vinculoNomeiaOutroModelo({ model_id: String(MODEL_ID) }, MODEL_ID)).toBe(false);
    expect(vinculoNomeiaOutroModelo({ model_id: MODEL_ID }, MODEL_ID)).toBe(false);
  });

  it('um id diferente nomeia OUTRO modelo', () => {
    expect(vinculoNomeiaOutroModelo({ model_id: OUTRO_MODEL_ID }, MODEL_ID)).toBe(true);
    expect(vinculoNomeiaOutroModelo({ model_id: String(OUTRO_MODEL_ID) }, MODEL_ID)).toBe(true);
  });

  it('o irmão reivindicado por OUTRO modelo da mesma listagem não é candidato', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a'] });
    semearLinkDaVariacao(db, { produtoId: 'prod-filho', modelId: OUTRO_MODEL_ID });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID })],
      [combo('a')],
      null,
    );

    expect(r!.existente).toBeNull();
  });

  it('⛔ NEAR-MISS: o mesmo irmão com um vínculo de OUTRA conta continua candidato', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-filho', { paiId: PAI, sku: null, variacoesUid: ['a'] });
    semearLinkDaVariacao(db, {
      produtoId: 'prod-filho',
      modelId: OUTRO_MODEL_ID,
      conta: REF_OUTRA,
    });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID })],
      [combo('a')],
      null,
    );

    expect(r!.existente?.id).toBe('prod-filho');
  });
});

/* -------------------------------------------------------------------------- */
/*  6b. Passo 19 — o SKU da listagem e a cascata de filhos ESCOPADA            */
/* -------------------------------------------------------------------------- */

describe('skuDoItemShopee — a dobra do degrau 2 do pai, exportada (R-14)', () => {
  it('PAR IGUAL: espaços nas pontas caem; null/ausente ≡ vazio', () => {
    expect(skuDoItemShopee({ item_sku: '  KIT-1 ' })).toBe('KIT-1');
    expect(skuDoItemShopee({ item_sku: 'KIT-1' })).toBe(skuDoItemShopee({ item_sku: 'KIT-1 ' }));
    expect(skuDoItemShopee({ item_sku: null })).toBe('');
    expect(skuDoItemShopee({})).toBe('');
  });

  it('⛔ NEAR-MISS: caixa e espaço INTERNO continuam distintos (o `where` é sensível)', () => {
    expect(skuDoItemShopee({ item_sku: 'kit-1' })).not.toBe(skuDoItemShopee({ item_sku: 'KIT-1' }));
    expect(skuDoItemShopee({ item_sku: 'KIT 1' })).not.toBe(skuDoItemShopee({ item_sku: 'KIT1' }));
  });

  it('é a MESMA dobra que o degrau 2 do pai consulta', async () => {
    const db = new FakeDb();
    semearProduto(db, 'prod-kit', { sku: 'KIT-1' });

    const r = await resolverPaiDaListagem(asDb(db), INTEGRACAO, item({ item_sku: ' KIT-1 ' }));

    expect(r.existente?.id).toBe('prod-kit');
    expect(consultasDeProdutos(db)[0]!.clausulas).toEqual([
      ['sku', skuDoItemShopee({ item_sku: ' KIT-1 ' })],
      ['paiId', null],
    ]);
  });
});

describe('resolverFilhosDaListagem — escopada à LISTAGEM (passo 19, S2C-01, M162)', () => {
  const L_NOVO = 'link-kit-novo';
  const L_VELHO = 'link-kit-velho';
  const refDoLink = (linkId: string) => `documents/produtos/${PAI}/prodshopee/${linkId}`;

  /** A linha de OUTRA listagem da mesma conta — a do kit velho, nomeando outro modelo. */
  function semearLinhaDoKitVelho(db: FakeDb, produtoId: string): Record<string, unknown> {
    const dados = {
      model_id: OUTRO_MODEL_ID,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: refDoLink(L_VELHO),
    };
    db.seed(`produtos/${produtoId}/variashopee/var-velho`, dados);
    return dados;
  }

  it('(OP-2) o escopo da listagem é OBRIGATÓRIO: omiti-lo não compila (o mutante X1 não volta calado)', () => {
    // Pinned by the TYPE CHECKER, not by vitest: with a `= null` default the
    // directive below is unused and `tsc --noEmit` fails (TS2578). The call is
    // never made — only its type is asserted.
    const semEscopo = (db: FakeDb) =>
      // @ts-expect-error — `linkDocIdDaListagem` has no default: pass `null` explicitly.
      resolverFilhosDaListagem(asDb(db), INTEGRACAO, PAI, true, [modelo()], [combo()]);
    // ÂNCORA: a forma com `null` explícito compila e é a mesma função.
    const comNull = (db: FakeDb) =>
      resolverFilhosDaListagem(asDb(db), INTEGRACAO, PAI, true, [modelo()], [combo()], null);
    expect([typeof semEscopo, typeof comNull]).toEqual(['function', 'function']);
  });

  it('degrau 2 (SKU): a linha da OUTRA listagem não reivindica o filho, nem vira o vínculo', async () => {
    const db = new FakeDb();
    semearProduto(db, 'filho-a', { paiId: PAI, sku: 'KIT-1-A' });
    const antes = structuredClone(semearLinhaDoKitVelho(db, 'filho-a'));

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID, model_sku: 'KIT-1-A' })],
      [combo()],
      L_NOVO,
    );

    expect(r!.existente?.id).toBe('filho-a');
    // ⛔ NUNCA o `var-velho`: um merge nele reescreveria o `model_id` e o
    // `produtoShopeeOuterRef` do kit velho e órfão os pedidos dele.
    expect(r!.link).toBeNull();
    expect(db.store['produtos/filho-a/variashopee/var-velho']?.data).toEqual(antes);
    expect(db.writes).toEqual([]);
  });

  it('degrau 3 (combinação): um filho SEM sku com a linha do kit velho é casado pela variante', async () => {
    const db = new FakeDb();
    semearProduto(db, 'filho-b', { paiId: PAI, sku: null, variacoesUid: ['azul'] });
    semearLinhaDoKitVelho(db, 'filho-b');

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID })],
      [combo('azul')],
      L_NOVO,
    );

    expect(r!.existente?.id).toBe('filho-b');
    expect(r!.link).toBeNull();
  });

  it('⛔ NEAR-MISS: com `null` (o import de anúncio comum) a MESMA linha recusa o filho, como hoje', async () => {
    for (const via of ['sku', 'combinacao'] as const) {
      const db = new FakeDb();
      semearProduto(db, 'filho', {
        paiId: PAI,
        sku: via === 'sku' ? 'KIT-1-A' : null,
        variacoesUid: ['azul'],
      });
      semearLinhaDoKitVelho(db, 'filho');

      const [r] = await resolverFilhosDaListagem(
        asDb(db),
        INTEGRACAO,
        PAI,
        true,
        [modelo({ model_id: MODEL_ID, model_sku: via === 'sku' ? 'KIT-1-A' : null })],
        [combo('azul')],
        null,
      );

      expect(r!.existente).toBeNull();
      expect(r!.link).toBeNull();
    }
  });

  it('⛔ NEAR-MISS: uma linha DESTA listagem que nomeia outro modelo AINDA reivindica', async () => {
    // O escopo tira as linhas das OUTRAS listagens, nunca a guarda: dois modelos
    // da MESMA listagem continuam sem poder dividir um filho.
    const db = new FakeDb();
    semearProduto(db, 'filho-a', { paiId: PAI, sku: 'KIT-1-A' });
    db.seed('produtos/filho-a/variashopee/var-novo-outro', {
      model_id: OUTRO_MODEL_ID,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: refDoLink(L_NOVO),
    });

    const [r] = await resolverFilhosDaListagem(
      asDb(db),
      INTEGRACAO,
      PAI,
      true,
      [modelo({ model_id: MODEL_ID, model_sku: 'KIT-1-A' })],
      [combo()],
      L_NOVO,
    );

    expect(r!.existente).toBeNull();
  });

  it('a linha DESTA listagem é reaproveitada nas DUAS grafias do ref (canônica e legada)', async () => {
    for (const ref of [refDoLink(L_NOVO), `produtos/${PAI}/prodshopee/${L_NOVO}`]) {
      const db = new FakeDb();
      semearProduto(db, 'filho-a', { paiId: PAI, sku: 'KIT-1-A' });
      semearLinhaDoKitVelho(db, 'filho-a');
      db.seed('produtos/filho-a/variashopee/var-novo', {
        contaVariacaoShopeeOuterRef: REF_CONTA,
        produtoShopeeOuterRef: ref,
      });

      const [r] = await resolverFilhosDaListagem(
        asDb(db),
        INTEGRACAO,
        PAI,
        true,
        [modelo({ model_id: MODEL_ID, model_sku: 'KIT-1-A' })],
        [combo()],
        L_NOVO,
      );

      expect(r!.existente?.id).toBe('filho-a');
      expect(r!.link?.id).toBe('var-novo');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Os índices compostos, no arquivo REAL                                   */
/* -------------------------------------------------------------------------- */

describe('as consultas do import usam os compostos declarados', () => {
  interface CampoDeIndice {
    readonly fieldPath: string;
    readonly order?: string;
  }
  interface IndiceDeclarado {
    readonly collectionGroup: string;
    readonly queryScope: string;
    readonly fields: readonly CampoDeIndice[];
  }

  function declarados(): readonly IndiceDeclarado[] {
    const url = new URL('../../../../../firestore.indexes.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { indexes: IndiceDeclarado[] }).indexes;
  }

  // ⚠️ Apagar qualquer uma das duas entradas não quebra nada que roda: no
  // Enterprise um composto ausente não lança e não oferece link — ele varre a
  // coleção inteira e é cobrado por dado varrido (regra 1).
  it.each(INDICES_COMPOSTOS_SHOPEE)(
    '$collectionGroup: COLLECTION_GROUP, na ORDEM em que a query filtra',
    (esperado) => {
      expect(declarados()).toContainEqual({
        collectionGroup: esperado.collectionGroup,
        queryScope: 'COLLECTION_GROUP',
        fields: esperado.campos.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })),
      });
    },
  );

  it('as cláusulas emitidas são EXATAMENTE os campos do índice, na ordem', async () => {
    const db = new FakeDb();
    await resolverPaiDaListagem(asDb(db), INTEGRACAO, item());
    await resolverFilhosDaListagem(asDb(db), INTEGRACAO, PAI, false, [modelo()], [combo()], null);

    const [variacao, listagem] = INDICES_COMPOSTOS_SHOPEE;
    expect(consultasDeGrupo(db, 'prodshopee')[0]!.clausulas.map(([campo]) => campo)).toEqual([
      ...listagem.campos,
    ]);
    expect(consultasDeGrupo(db, 'variashopee')[0]!.clausulas.map(([campo]) => campo)).toEqual([
      ...variacao.campos,
    ]);
  });
});
