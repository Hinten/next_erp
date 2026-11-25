/**
 * `salvarPagamentosShopee` — the SECOND transaction of the Shopee order import
 * (#1514, step 6, plan §3.0-W W10), over the shared `FakeDb` + the REAL
 * `OccEngine`.
 *
 * ⚠️ The three properties this file exists for, and none of them is visible to a
 * happy-path assertion:
 *
 *  1. **a byte-identical replay writes NOTHING.** `onPagamentoChanged` ignores
 *     only `id` and `ultimaModificacao`, so any other re-stamped field files a
 *     `historicoDeModificacoes` row on every push. The replay tests run with a
 *     DIFFERENT `nowUs` on purpose: a clock leaking into a compared field would
 *     pass a same-clock replay and fail in production once a day;
 *  2. **`liquidacao` is never in a task patch.** It is the weekly settlement
 *     sweep's top-level field, and disjoint masks are the whole reason it is
 *     top-level rather than nested in `marketplace`;
 *  3. **a degraded delivery never re-takes the primary's `valor`.** Σ pagante has
 *     to equal what the NF-e states (`vNF`: the lines − `descontoTotal`, the
 *     freight only under CIF) to the centavo or the NF-e refuses to emit
 *     (cStat 865/866, and `canalDevolveTroco` is false on a marketplace).
 *
 * ⚠️ No real credential, shop or buyer datum: the SG bodies are the redacted
 * `__wire__` corpus and the BR vector is built inline through the package
 * schemas with the canonical fake CNPJ `11222333000181`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@delfrance/data/testing';
import { pagamentoCollection } from '@delfrance/data/admin/collections';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO, type StatusPagamento } from '@delfrance/schemas';
import {
  shopeeOrderDetailRowSchema,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  lerEscrowDetalhe,
  lerPedidoDetalhe,
} from '../fixtures/wireCorpus';
import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { SHOPEE_ORDER_STATUS } from './orderStatusMaps';
import {
  esquecerLogsDePagamentoShopee,
  mapearPagamentosShopee,
  statusPagamentoDeOrderStatus,
  type PagamentosMapeadosShopee,
} from './pagamentoMapping';
import { salvarPagamentosShopee } from './pagamentoTx';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const PAGAMENTOS_PATH = `${PEDIDO_PATH}/pagamentos`;
const PRIMARIO = makePagamentoIdShopee(CONTA, ORDER_SN);
const SECUNDARIO = makePagamentoIdShopee(CONTA, ORDER_SN, '-1');
/** O pagamento-cupom do piso — a identidade LEGADA `-desconto`, NOSSA desde 2026-11-24. */
const DESCONTO = makePagamentoIdShopee(CONTA, ORDER_SN, '-desconto');
const PAY_TIME_S = 1_788_973_353;
const WATERMARK_US = microsDeSegundosShopee(1_788_973_354);
const AGORA_US = 1_700_000_000_000_000;
/** Um SEGUNDO relógio, para provar que `nowUs` não vaza num campo comparado. */
const OUTRO_AGORA_US = 1_700_000_999_000_000;
const CNPJ_FALSO = '11222333000181';

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // O memo de log do mapper é estado de MÓDULO: sem isto, um teste que conta
  // "exatamente um console.info" passa a contar ZERO assim que outro teste do
  // arquivo já usou a mesma string.
  esquecerLogsDePagamentoShopee();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function linhaSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}
function escrowSG(): ShopeeEscrowDetail {
  return lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
}

/** O vetor BR combinado, inline e pelo schema do pacote (ver o mapper). */
function linhaCombinadaBR(overrides: { paymentInfo?: unknown; orderStatus?: string } = {}) {
  const pix = {
    payment_method: 'pix',
    payment_amount: 10,
    card_brand: '',
    transaction_id: 'AUT-PIX',
    payment_processor_register: CNPJ_FALSO,
  };
  const cartao = {
    payment_method: 'credit_card',
    payment_amount: 21.99,
    card_brand: 'visa',
    transaction_id: 'AUT-CC',
    payment_processor_register: CNPJ_FALSO,
  };
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: overrides.orderStatus ?? SHOPEE_ORDER_STATUS.readyToShip,
    region: 'BR',
    pay_time: PAY_TIME_S,
    total_amount: 31.99,
    payment_method: 'Combined Payment',
    payment_info: 'paymentInfo' in overrides ? overrides.paymentInfo : [pix, cartao],
  });
}

/**
 * UMA perna BR — o caso COMUM, e o que a entrega degradada NUNCA cobre:
 * `degradado` é uma entrega que PERDEU detalhe (menos entradas utilizáveis do que
 * as pernas em jogo) ou dinheiro provisório, então num pedido de perna única (um
 * guardado, um mapeado, escrow respondido) ele é sempre `false` e o grupo DADOS
 * realmente roda.
 */
function linhaUmaPernaBR(overrides: { paymentInfo?: unknown; orderStatus?: string } = {}) {
  const cartao = {
    payment_method: 'credit_card',
    payment_amount: 31.99,
    card_brand: 'visa',
    transaction_id: 'AUT-CC',
    payment_processor_register: CNPJ_FALSO,
  };
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: overrides.orderStatus ?? SHOPEE_ORDER_STATUS.readyToShip,
    region: 'BR',
    pay_time: PAY_TIME_S,
    total_amount: 31.99,
    payment_method: 'Credit Card',
    payment_info: 'paymentInfo' in overrides ? overrides.paymentInfo : [cartao],
  });
}

function mapear(
  args: {
    linha?: ShopeeOrderDetailRow;
    escrow?: ShopeeEscrowDetail | null;
    valorDoComprador?: number | null;
    cupomShopee?: number;
    dinheiroProvisorio?: boolean;
    watermarkUs?: number;
    nowUs?: number;
  } = {},
): PagamentosMapeadosShopee {
  return mapearPagamentosShopee({
    linha: args.linha ?? linhaSG(),
    escrow: args.escrow ?? null,
    valorDoComprador: args.valorDoComprador === undefined ? 31.99 : args.valorDoComprador,
    ...(args.cupomShopee === undefined ? {} : { cupomShopee: args.cupomShopee }),
    ...(args.dinheiroProvisorio === undefined
      ? {}
      : { dinheiroProvisorio: args.dinheiroProvisorio }),
    watermarkUs: args.watermarkUs ?? WATERMARK_US,
    nowUs: args.nowUs ?? AGORA_US,
    contaId: CONTA,
    orderSn: ORDER_SN,
  });
}

/** O pedido que a transação relê — a metade do guard que mora fora daqui. */
function semearPedido(db: FakeDb, over: Record<string, unknown> = {}): void {
  const valor = typeof over.valorCobrado === 'number' ? over.valorCobrado : 31.99;
  db.seed(PEDIDO_PATH, {
    numero: ORDER_SN,
    valorCobrado: valor,
    // ONE line carrying the whole value and no freight block: the stored NF-e
    // total (`totalDaNotaDoPedidoArmazenado`) the Σ diagnostic compares against.
    itens: { NONE: [{ precoDeVenda: valor, quantidade: 1 }] },
    lastMarketplaceUpdate: WATERMARK_US,
    ...over,
  });
}

function salvar(
  db: FakeDb,
  args: {
    mapeados?: PagamentosMapeadosShopee;
    linha?: ShopeeOrderDetailRow;
    watermarkUs?: number;
    nowUs?: number;
  } = {},
) {
  const linha = args.linha ?? linhaSG();
  return salvarPagamentosShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    contaId: CONTA,
    orderSn: ORDER_SN,
    watermarkUs: args.watermarkUs ?? WATERMARK_US,
    nowUs: args.nowUs ?? AGORA_US,
    mapeados: args.mapeados ?? mapear({ linha, watermarkUs: args.watermarkUs, nowUs: args.nowUs }),
    alvoStatus: statusPagamentoDeOrderStatus(linha.order_status),
  });
}

/** Um pagamento gravado, como o Firestore o guarda. */
function doc(db: FakeDb, id: string): Record<string, unknown> {
  return db.store[`${PAGAMENTOS_PATH}/${id}`]!.data;
}

/* ========================================================================== */
/*  1–3 · criação                                                             */
/* ========================================================================== */

describe('salvarPagamentosShopee — criação', () => {
  it('1. cria UM pagamento com o corpo mapeado inteiro, e o opLog é [get, get, create]', async () => {
    const db = new FakeDb();
    semearPedido(db);

    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    expect(r.acao).toBe('criado');
    expect(r.criados).toBe(1);
    expect(r.atualizados).toBe(0);
    expect(r.docs).toEqual([{ docId: PRIMARIO, idCampo: ORDER_SN }]);
    expect(r.pedidoJaExistia).toBe(true);
    expect(r.congelado).toBe(false);
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([PRIMARIO]);

    const gravado = doc(db, PRIMARIO);
    expect(gravado.id).toBe(ORDER_SN);
    expect(gravado.valor).toBe(31.99);
    expect(gravado.forma_de_pagamento).toBe(
      FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
    );
    expect(gravado.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(gravado.parcelas).toBe(1);
    expect(gravado.aVista).toBe(true);
    expect(gravado.tarifas).toBe(1.29);
    expect(gravado.juros).toBeNull();
    expect(gravado.duplicata).toBe(false);
    expect(gravado.dataAprovacao).toBe(microsDeSegundosShopee(PAY_TIME_S));
    expect(gravado.dataCadastro).toBe(AGORA_US);
    expect((gravado.marketplace as Record<string, unknown>).atualizadoEm).toBe(WATERMARK_US);
    expect((gravado.marketplace as Record<string, unknown>).tarifasBrutas).toBe(1.29);
    // O corpo inteiro é exatamente o que o schema de ESCRITA produz.
    expect(gravado).toEqual(pagamentoCollection.parse(gravado));

    // ⚠️ DOIS `get`: o pedido e a subcoleção INTEIRA. Um point read não enxerga
    // um secundário que uma entrega anterior escreveu.
    expect(db.opLog).toEqual([
      { op: 'get', path: PEDIDO_PATH },
      { op: 'get', path: PAGAMENTOS_PATH },
      { op: 'create', path: `${PAGAMENTOS_PATH}/${PRIMARIO}` },
    ]);
  });

  it('2. ⚠️ usa tx.create e NUNCA tx.set', async () => {
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db);
    expect(db.opLog.filter((o) => o.op === 'set')).toEqual([]);
    expect(db.opLog.filter((o) => o.op === 'create')).toHaveLength(1);
  });

  it('3. Σ pagante sai igual ao `valorCobrado` do pedido — divergência ZERO', async () => {
    const db = new FakeDb();
    semearPedido(db);
    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });
    expect(r.somaPagante).toBe(31.99);
    // ⚠️ Tem de ser 0: num marketplace `canalDevolveTroco` é false, então uma
    // sobra é cStat 866 e uma falta 865 — nota nenhuma, para sempre.
    expect(r.divergenciaDeSoma).toBe(0);
  });
});

/* ========================================================================== */
/*  4–6 · o replay byte-idêntico e a marca d'água                             */
/* ========================================================================== */

describe('salvarPagamentosShopee — replay e marca d’água', () => {
  it('4. ⚠️ replay byte-idêntico com OUTRO nowUs ⇒ ignorado-sem-mudanca e ZERO escritas', async () => {
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    const escritasAntes = db.writes.length;
    const patchesAntes = db.patches.length;
    const corpoAntes = { ...doc(db, PRIMARIO) };
    db.opLog.length = 0;

    // ⚠️ O relógio MUDA. Se `nowUs` vazasse num campo comparado — em
    // `marketplace.atualizadoEm`, por exemplo — este replay gravaria, e uma
    // linha de histórico por entrega é exatamente o que a disciplina evita.
    const r = await salvar(db, {
      mapeados: mapear({ escrow: escrowSG(), nowUs: OUTRO_AGORA_US }),
      nowUs: OUTRO_AGORA_US,
    });

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.criados + r.atualizados).toBe(0);
    expect(r.gruposAplicados).toEqual([]);
    expect(db.writes).toHaveLength(escritasAntes);
    expect(db.patches).toHaveLength(patchesAntes);
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);
    expect(doc(db, PRIMARIO)).toEqual(corpoAntes);
  });

  it('5. a marca d’água IGUAL é aceita e re-mapeada (o `>=` do step 5)', async () => {
    const db = new FakeDb();
    semearPedido(db, { lastMarketplaceUpdate: WATERMARK_US });
    const r = await salvar(db, { watermarkUs: WATERMARK_US });
    // Aceita: criou. É o `>` que jogaria fora `UNPAID → PENDING → READY_TO_SHIP`
    // dentro de um mesmo segundo.
    expect(r.acao).toBe('criado');
  });

  it('6. uma entrega ESTRITAMENTE mais velha é descartada, sem escrita nenhuma', async () => {
    const db = new FakeDb();
    semearPedido(db, { lastMarketplaceUpdate: WATERMARK_US + 1_000_000 });

    const r = await salvar(db, { watermarkUs: WATERMARK_US });

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(db.writes).toEqual([]);
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([]);
    // ⚠️ E a subcoleção nem chega a ser lida: a porta é o pedido.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
  });

  it('7. a marca d’água armazenada em MILISSEGUNDOS (corpus legado) é lida certo', async () => {
    const db = new FakeDb();
    // `coerceToMicros` no lado ARMAZENADO — o corpus legado guarda ms e ISO ali.
    semearPedido(db, { lastMarketplaceUpdate: Math.floor(WATERMARK_US / 1000) + 1000 });
    const r = await salvar(db, { watermarkUs: WATERMARK_US });
    expect(r.acao).toBe('ignorado-obsoleto');
  });
});

/* ========================================================================== */
/*  8–9 · o pedido ausente e o pagamento ausente                              */
/* ========================================================================== */

describe('salvarPagamentosShopee — as duas ausências', () => {
  it('8. sem pedido ⇒ ignorado-sem-pedido, e NADA é gravado sob um ancestral morto', async () => {
    const db = new FakeDb();
    const r = await salvar(db);
    expect(r.acao).toBe('ignorado-sem-pedido');
    expect(r.pedidoJaExistia).toBe(false);
    expect(db.writes).toEqual([]);
    // Uma subcoleção sob um documento inexistente é LEGAL no Firestore — é por
    // isso que a recusa é explícita e não uma consequência de algo falhar.
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([]);
  });

  it('9. sem nada mapeado E sem nada nosso gravado ⇒ ignorado-sem-pagamento', async () => {
    const db = new FakeDb();
    semearPedido(db);
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.unpaid,
      pay_time: 0,
    });
    const r = await salvar(db, { linha, mapeados: mapear({ linha }) });
    expect(r.acao).toBe('ignorado-sem-pagamento');
    expect(db.writes).toEqual([]);
  });

  it('10. ⚠️ o portão de criação NÃO congela o que já existe: CANCELLED + pay_time 0 estorna', async () => {
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.cancelled,
      pay_time: 0,
    });
    const r = await salvar(db, { linha, mapeados: mapear({ linha }) });

    expect(r.acao).toBe('atualizado');
    expect(r.statusEscrito).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).dataCancelamento).toBe(WATERMARK_US);
    // …e nada do grupo DADOS foi re-tomado a partir de uma entrega sem legs.
    expect(doc(db, PRIMARIO).valor).toBe(31.99);
  });
});

/* ========================================================================== */
/*  11 · a tabela de grupos: fill-once, congelado, DADOS                      */
/* ========================================================================== */

describe('salvarPagamentosShopee — a tabela de grupos de campos', () => {
  interface Caso {
    readonly nome: string;
    readonly armazenado: Record<string, unknown>;
    readonly congelado: boolean;
    readonly campo: string;
    readonly esperadoNoPatch: boolean;
    readonly valorEsperado?: unknown;
  }

  const CASOS: readonly Caso[] = [
    {
      nome: 'valor diferente, pedido livre ⇒ take-new',
      armazenado: { valor: 1 },
      congelado: false,
      campo: 'valor',
      esperadoNoPatch: true,
      valorEsperado: 31.99,
    },
    {
      nome: '⚠️ valor diferente, pedido CONGELADO ⇒ o grupo DADOS não escreve',
      armazenado: { valor: 1 },
      congelado: true,
      campo: 'valor',
      esperadoNoPatch: false,
    },
    {
      nome: 'forma diferente ⇒ take-new',
      armazenado: { forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
      congelado: false,
      campo: 'forma_de_pagamento',
      esperadoNoPatch: true,
      valorEsperado: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
    },
    {
      nome: 'parcelas/aVista diferentes ⇒ take-new',
      armazenado: { parcelas: 3, aVista: false },
      congelado: false,
      campo: 'parcelas',
      esperadoNoPatch: true,
      valorEsperado: 1,
    },
    {
      nome: '⚠️ dataCadastro JÁ gravada NÃO é re-carimbada (fill-once)',
      armazenado: { dataCadastro: 123 },
      congelado: false,
      campo: 'dataCadastro',
      esperadoNoPatch: false,
    },
    {
      nome: 'dataCadastro vazia é preenchida',
      armazenado: { dataCadastro: null },
      congelado: false,
      campo: 'dataCadastro',
      esperadoNoPatch: true,
      valorEsperado: AGORA_US,
    },
    {
      nome: '⚠️ `id` string VAZIA conta como vazio e é repreenchido',
      armazenado: { id: '' },
      congelado: false,
      campo: 'id',
      esperadoNoPatch: true,
      valorEsperado: ORDER_SN,
    },
    {
      nome: '`id` já preenchido NÃO é reescrito',
      armazenado: { id: 'algum-id-do-operador' },
      congelado: false,
      campo: 'id',
      esperadoNoPatch: false,
    },
    {
      nome: '⚠️ dataAprovacao JÁ gravada NÃO é reescrita (fill-once, e nem sob congelado)',
      armazenado: { dataAprovacao: 42 },
      congelado: true,
      campo: 'dataAprovacao',
      esperadoNoPatch: false,
    },
    {
      nome: 'dataAprovacao vazia é preenchida MESMO com o pedido congelado',
      armazenado: { dataAprovacao: null },
      congelado: true,
      campo: 'dataAprovacao',
      esperadoNoPatch: true,
      valorEsperado: microsDeSegundosShopee(PAY_TIME_S),
    },
    {
      nome: '⚠️ tarifas: o mapper não aprendeu (escrow ausente) ⇒ a chave é OMITIDA',
      armazenado: { tarifas: 1.29 },
      congelado: false,
      campo: 'tarifas',
      esperadoNoPatch: false,
    },
  ];

  it.each(CASOS)(
    '11. $nome',
    async ({ armazenado, congelado, campo, esperadoNoPatch, valorEsperado }) => {
      const db = new FakeDb();
      semearPedido(db, congelado ? { hasUserInteraction: true } : {});
      db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
        id: ORDER_SN,
        valor: 31.99,
        forma_de_pagamento: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        parcelas: 1,
        aVista: true,
        dataAprovacao: microsDeSegundosShopee(PAY_TIME_S),
        dataCadastro: AGORA_US,
        ...armazenado,
      });

      const r = await salvar(db, { mapeados: mapear() });
      const patch = db.patches.at(-1)?.patch ?? {};

      expect(r.congelado).toBe(congelado);
      expect(Object.prototype.hasOwnProperty.call(patch, campo)).toBe(esperadoNoPatch);
      if (esperadoNoPatch) expect(patch[campo]).toEqual(valorEsperado);
    },
  );

  it('12. ⚠️ um `cartao` já aprendido NUNCA é apagado por uma entrega sem payment_info', async () => {
    const db = new FakeDb();
    semearPedido(db);
    // Primeira entrega BR: aprende o bloco do cartão.
    await salvar(db, {
      linha: linhaCombinadaBR(),
      mapeados: mapear({ linha: linhaCombinadaBR() }),
    });
    const cartaoAntes = doc(db, PRIMARIO).cartao;
    expect(cartaoAntes).not.toBeNull();

    // Entrega posterior (SHIPPED) com `payment_info: null` — a Shopee para de
    // mandar o bloco. Um `cartao: null` aqui destruiria o que o PIX precisa
    // (cStat 391) num pedido que ainda não emitiu.
    const depois = linhaCombinadaBR({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: null,
    });
    await salvar(db, { linha: depois, mapeados: mapear({ linha: depois }) });

    expect(doc(db, PRIMARIO).cartao).toEqual(cartaoAntes);
    for (const { patch } of db.patches) {
      expect(Object.prototype.hasOwnProperty.call(patch, 'cartao')).toBe(false);
    }
  });

  it('12b. ⚠️ UMA perna, SEM degradado: o cartao aprendido não é apagado — e o patch prova a escrita', async () => {
    // ⚠️ O teste 12 usa o vetor COMBINADO, então a segunda entrega é
    // `degradado` e `construirPatch` retorna ANTES do bloco do cartao: a guarda
    // que ele nomeia nunca executa ali, e o laço sobre `db.patches` iteraria um
    // array VAZIO. Aqui há um doc nosso e um doc mapeado — `degradado` é false,
    // o grupo DADOS roda, e a ÚNICA coisa que impede um `cartao: null` é o
    // `!== undefined` da guarda. Um `cartao: null` aqui destrói o que o PIX/
    // cartão precisa (cStat 391) num pedido que ainda não emitiu.
    const db = new FakeDb();
    semearPedido(db);
    const primeira = linhaUmaPernaBR();
    await salvar(db, { linha: primeira, mapeados: mapear({ linha: primeira }) });
    const cartaoAntes = doc(db, PRIMARIO).cartao;
    expect(cartaoAntes).not.toBeNull();
    expect(doc(db, PRIMARIO).tarifas).toBeNull();

    // A entrega seguinte PERDE o `payment_info` e GANHA o escrow: assim o patch
    // é provadamente não-vazio, que é o que torna o negativo abaixo uma prova.
    const depois = linhaUmaPernaBR({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: null,
    });
    const r = await salvar(db, {
      linha: depois,
      mapeados: mapear({ linha: depois, escrow: escrowSG() }),
    });

    expect(r.congelado).toBe(false);
    expect(doc(db, PRIMARIO).cartao).toEqual(cartaoAntes);
    // ⚠️ A ÂNCORA: sem isto o laço abaixo é um laço sobre array vazio.
    expect(db.patches).toHaveLength(1);
    expect(Object.keys(db.patches[0]!.patch).sort()).toEqual([
      'marketplace',
      'tarifas',
      'ultimaModificacao',
    ]);
    for (const { patch } of db.patches) {
      expect(Object.prototype.hasOwnProperty.call(patch, 'cartao')).toBe(false);
    }
  });
});

/* ========================================================================== */
/*  13–16 · a escada de status contra o que está gravado                      */
/* ========================================================================== */

describe('salvarPagamentosShopee — a escada de status', () => {
  async function comStatusArmazenado(
    armazenado: StatusPagamento | null,
    orderStatus: string,
  ): Promise<{ db: FakeDb; r: Awaited<ReturnType<typeof salvarPagamentosShopee>> }> {
    const db = new FakeDb();
    semearPedido(db);
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 31.99,
      forma_de_pagamento: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
      status_pagamento: armazenado,
      parcelas: 1,
      aVista: true,
      dataAprovacao: microsDeSegundosShopee(PAY_TIME_S),
      dataCadastro: AGORA_US,
    });
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: orderStatus,
      pay_time: PAY_TIME_S,
      payment_method: 'Apple Pay',
    });
    const r = await salvar(db, { linha, mapeados: mapear({ linha }) });
    return { db, r };
  }

  it('13. ⚠️ `aprovado` + um PENDING atrasado NÃO regride — a nota ficaria curta', async () => {
    const { db, r } = await comStatusArmazenado(
      STATUS_PAGAMENTO.aprovado,
      SHOPEE_ORDER_STATUS.pending,
    );
    expect(r.motivoStatus).toBe('regressivo');
    expect(r.statusEscrito).toBeNull();
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    for (const { patch } of db.patches) {
      expect(Object.prototype.hasOwnProperty.call(patch, 'status_pagamento')).toBe(false);
    }
  });

  it('14. ⚠️ `estornado` → `aprovado` É permitido, e sai um warn de ressuscitado', async () => {
    const { db, r } = await comStatusArmazenado(
      STATUS_PAGAMENTO.estornado,
      SHOPEE_ORDER_STATUS.readyToShip,
    );
    expect(r.statusEscrito).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.statusRessuscitado).toBe(true);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(
      warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('ressuscitado')),
    ).toHaveLength(1);
  });

  it('15. um status FORA da escada (o `recusado` de um operador) não é mexido', async () => {
    const { db, r } = await comStatusArmazenado(
      STATUS_PAGAMENTO.recusado,
      SHOPEE_ORDER_STATUS.readyToShip,
    );
    expect(r.motivoStatus).toBe('fora-da-escada');
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.recusado);
  });

  it('16. `dataCancelamento` é fill-once: a SEGUNDA entrega CANCELLED mantém a primeira data', async () => {
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    const cancelada = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.cancelled,
      pay_time: PAY_TIME_S,
      payment_method: 'Apple Pay',
    });
    await salvar(db, { linha: cancelada, mapeados: mapear({ linha: cancelada }) });
    const primeira = doc(db, PRIMARIO).dataCancelamento;
    expect(primeira).toBe(WATERMARK_US);

    const maisNova = WATERMARK_US + 60_000_000;
    db.seed(PEDIDO_PATH, {
      numero: ORDER_SN,
      valorCobrado: 31.99,
      lastMarketplaceUpdate: maisNova,
    });
    await salvar(db, {
      linha: cancelada,
      mapeados: mapear({ linha: cancelada, watermarkUs: maisNova }),
      watermarkUs: maisNova,
    });
    // ⚠️ A data do ESTORNO é a da entrega que estornou, não a da última releitura.
    // ⚠️ Mas o que SEGURA esta segunda entrega é a ESCADA (`sem-mudanca`: já está
    // em `estornado`), não o fill-once — que nem chega a ser consultado. Onde o
    // fill-once é a única coisa que segura a data é o teste 16b.
    expect(doc(db, PRIMARIO).dataCancelamento).toBe(primeira);
  });

  it('16b. ⚠️ ressuscitar e estornar DE NOVO mantém a data do PRIMEIRO estorno', async () => {
    // ⚠️ Este é o único caminho em que o `vazio(raw.dataCancelamento)` decide
    // sozinho: na re-entrega CANCELLED comum a escada já devolve `sem-mudanca` e
    // o ramo nem roda, então um teste só daquele caso NÃO mostra onde a regra
    // para. Aqui a escada MANDA escrever (`aprovado → estornado`) e é o
    // fill-once que preserva a data.
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    const linhaComStatus = (status: string) =>
      shopeeOrderDetailRowSchema.parse({
        order_sn: ORDER_SN,
        order_status: status,
        pay_time: PAY_TIME_S,
        payment_method: 'Apple Pay',
      });
    const entregar = async (status: string, watermarkUs: number) => {
      db.seed(PEDIDO_PATH, {
        numero: ORDER_SN,
        valorCobrado: 31.99,
        lastMarketplaceUpdate: watermarkUs,
      });
      const linha = linhaComStatus(status);
      return salvar(db, {
        linha,
        mapeados: mapear({ linha, watermarkUs }),
        watermarkUs,
      });
    };

    const w1 = WATERMARK_US + 10_000_000;
    const w2 = WATERMARK_US + 20_000_000;
    const w3 = WATERMARK_US + 30_000_000;

    await entregar(SHOPEE_ORDER_STATUS.cancelled, w1);
    expect(doc(db, PRIMARIO).dataCancelamento).toBe(w1);

    const volta = await entregar(SHOPEE_ORDER_STATUS.readyToShip, w2);
    expect(volta.statusRessuscitado).toBe(true);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);

    const denovo = await entregar(SHOPEE_ORDER_STATUS.cancelled, w3);
    // A escada escreveu de novo — a âncora que torna o negativo abaixo real.
    expect(denovo.statusEscrito).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).dataCancelamento).toBe(w1);
  });
});

/* ========================================================================== */
/*  17–19 · o combinado BR e a entrega DEGRADADA                              */
/* ========================================================================== */

describe('salvarPagamentosShopee — combinado e entrega degradada', () => {
  async function comDoisDocs(): Promise<FakeDb> {
    const db = new FakeDb();
    semearPedido(db);
    const linha = linhaCombinadaBR();
    await salvar(db, { linha, mapeados: mapear({ linha }) });
    return db;
  }

  it('17. dois legs viram DOIS documentos cuja Σ bate no `valorCobrado` do pedido', async () => {
    const db = await comDoisDocs();
    expect(db.idsEm(PAGAMENTOS_PATH).sort()).toEqual([PRIMARIO, SECUNDARIO].sort());
    // O leg de crédito ordena antes do pix, então ele é o PRIMÁRIO e leva o
    // `order_sn` como `id`.
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    expect(doc(db, SECUNDARIO).id).toBe(`${ORDER_SN}-1`);
    // A tarifa é do PEDIDO e anda só no primário; o irmão carrega um 0 asseverado.
    expect(doc(db, SECUNDARIO).tarifas).toBe(0);
  });

  it('18. ⚠️ entrega DEGRADADA: o primário NÃO re-toma o valor inteiro, e nada é apagado', async () => {
    const db = await comDoisDocs();
    const antes = { primario: doc(db, PRIMARIO).valor, secundario: doc(db, SECUNDARIO).valor };
    infoSpy.mockClear();

    // A Shopee para de mandar `payment_info` depois de READY_TO_SHIP. Um
    // primário que re-tomasse 31,99 deixaria Σ = 41,99 contra uma nota de 31,99.
    const degradada = linhaCombinadaBR({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: null,
    });
    const r = await salvar(db, { linha: degradada, mapeados: mapear({ linha: degradada }) });

    expect(doc(db, PRIMARIO).valor).toBe(antes.primario);
    expect(doc(db, SECUNDARIO).valor).toBe(antes.secundario);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
    expect(
      infoSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('entrega degradada')),
    ).toHaveLength(1);
  });

  it('18e. ⚠️ encolhimento PARCIAL (3 legs → 2): o grupo DADOS congela e o órfão não dobra a Σ', async () => {
    // O vetor do claude[bot] na PR #1582: três legs 10 / 15 / 6,99 e depois dois
    // legs 10 / 21,99, ambos somando 31,99. Um `degradado` preso ao número DOIS
    // deixava os dois legs mapeados re-tomarem os seus valores enquanto o terceiro
    // documento guardava os 6,99 (ou 10) que uma entrega mais rica lhe deu — e o
    // NF-e soma um órfão pagante. O predicado é RELATIVO ao que é nosso.
    const tresLegs = linhaCombinadaBR({
      paymentInfo: [
        {
          payment_method: 'pix',
          payment_amount: 10,
          card_brand: '',
          transaction_id: 'AUT-PIX',
          payment_processor_register: CNPJ_FALSO,
        },
        {
          payment_method: 'credit_card',
          payment_amount: 15,
          card_brand: 'visa',
          transaction_id: 'AUT-CC',
          payment_processor_register: CNPJ_FALSO,
        },
        {
          payment_method: 'credit_card',
          payment_amount: 6.99,
          card_brand: 'master',
          transaction_id: 'AUT-CC2',
          payment_processor_register: CNPJ_FALSO,
        },
      ],
    });
    const db = new FakeDb();
    semearPedido(db);
    const r1 = await salvar(db, { linha: tresLegs, mapeados: mapear({ linha: tresLegs }) });
    const TERCEIRO = makePagamentoIdShopee(CONTA, ORDER_SN, '-2');
    expect(r1.acao).toBe('criado');
    expect(db.idsEm(PAGAMENTOS_PATH).sort()).toEqual([PRIMARIO, SECUNDARIO, TERCEIRO].sort());
    expect(r1.somaPagante).toBe(31.99);
    const antes = {
      primario: doc(db, PRIMARIO).valor,
      secundario: doc(db, SECUNDARIO).valor,
      terceiro: doc(db, TERCEIRO).valor,
    };
    infoSpy.mockClear();

    // Dois legs que também somam 31,99 — a entrega default de `linhaCombinadaBR`.
    const doisLegs = linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.processed });
    const r2 = await salvar(db, { linha: doisLegs, mapeados: mapear({ linha: doisLegs }) });

    expect(doc(db, PRIMARIO).valor).toBe(antes.primario);
    expect(doc(db, SECUNDARIO).valor).toBe(antes.secundario);
    expect(doc(db, TERCEIRO).valor).toBe(antes.terceiro);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(3);
    expect(r2.somaPagante).toBe(31.99);
    expect(r2.divergenciaDeSoma).toBe(0);
    // A ÂNCORA do outro lado: o que NÃO está congelado ainda anda — o status.
    expect(doc(db, TERCEIRO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(
      infoSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('entrega degradada')),
    ).toHaveLength(1);
  });

  it('18f. ⚠️ NEAR-MISS de 18e: o MESMO número de legs com valores diferentes NÃO é degradado', async () => {
    // Dois guardados, dois mapeados: a entrega não perdeu detalhe, o dinheiro
    // mudou. O grupo DADOS roda, os dois documentos re-tomam os novos valores e a
    // Σ continua igual à nota — sem nenhuma linha de "entrega degradada".
    const db = await comDoisDocs();
    infoSpy.mockClear();
    const outrosValores = linhaCombinadaBR({
      orderStatus: SHOPEE_ORDER_STATUS.processed,
      paymentInfo: [
        {
          payment_method: 'pix',
          payment_amount: 11.99,
          card_brand: '',
          transaction_id: 'AUT-PIX',
          payment_processor_register: CNPJ_FALSO,
        },
        {
          payment_method: 'credit_card',
          payment_amount: 20,
          card_brand: 'visa',
          transaction_id: 'AUT-CC',
          payment_processor_register: CNPJ_FALSO,
        },
      ],
    });
    const r = await salvar(db, {
      linha: outrosValores,
      mapeados: mapear({ linha: outrosValores }),
    });

    expect(r.acao).toBe('atualizado');
    expect(doc(db, PRIMARIO).valor).toBe(20);
    expect(doc(db, SECUNDARIO).valor).toBe(11.99);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
    expect(
      infoSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('entrega degradada')),
    ).toHaveLength(0);
  });

  it('18b. ⚠️ CONJUNTO CONGELADO: com o pedido congelado, uma entrega mais RICA não cria o irmão', async () => {
    // ⚠️ O espelho do 18, e a direção PIOR. A primeira entrega não trouxe
    // `payment_info`, então o primário nasceu com o `valorCobrado` INTEIRO. Um
    // humano então toca o cabeçalho do pedido (`hasUserInteraction`), o que
    // congela o grupo DADOS. Se a entrega seguinte — agora com as duas pernas
    // — criasse o secundário, o primário ficaria em 31,99 e o irmão em 10:
    // Σ pagante 41,99 contra uma nota de 31,99, que é cStat 866 PARA SEMPRE,
    // porque `hasUserInteraction` é um latch e nenhuma entrega futura re-toma
    // o `valor` do primário.
    const db = new FakeDb();
    semearPedido(db);
    const pobre = linhaCombinadaBR({ paymentInfo: null });
    await salvar(db, { linha: pobre, mapeados: mapear({ linha: pobre }) });
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([PRIMARIO]);
    expect(doc(db, PRIMARIO).valor).toBe(31.99);

    // O operador salva o formulário do pedido.
    db.store[PEDIDO_PATH]!.data.hasUserInteraction = true;
    infoSpy.mockClear();

    const rica = linhaCombinadaBR();
    const r = await salvar(db, { linha: rica, mapeados: mapear({ linha: rica }) });

    expect(r.congelado).toBe(true);
    expect(r.criados).toBe(0);
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([PRIMARIO]);
    expect(doc(db, PRIMARIO).valor).toBe(31.99);
    // ⚠️ O par que importa: Σ continua igual ao `valorCobrado`.
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
    expect(
      infoSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('conjunto congelado')),
    ).toHaveLength(1);
  });

  it('18c. ⚠️ NEAR-MISS de 18b: SEM o congelamento a mesma entrega cria o irmão e Σ continua certa', async () => {
    // A âncora do negativo acima: o portao é o congelamento, não o crescimento.
    const db = new FakeDb();
    semearPedido(db);
    const pobre = linhaCombinadaBR({ paymentInfo: null });
    await salvar(db, { linha: pobre, mapeados: mapear({ linha: pobre }) });

    const rica = linhaCombinadaBR();
    const r = await salvar(db, { linha: rica, mapeados: mapear({ linha: rica }) });

    expect(r.congelado).toBe(false);
    expect(r.criados).toBe(1);
    expect(db.idsEm(PAGAMENTOS_PATH).sort()).toEqual([PRIMARIO, SECUNDARIO].sort());
    // O primário foi RE-TOMADO para a sua perna, e é por isso que Σ fecha.
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('18d. ⚠️ o portao exige um doc NOSSO já gravado: num pedido congelado SEM pagamento nenhum, cria tudo', async () => {
    // ⚠️ A direção oposta, e ela também é dinheiro: se o congelamento
    // bloqueasse TODA criação, um pedido que um humano tocou antes da primeira
    // entrega ficaria com Σ pagante ZERO — cStat 865. Aqui as criações são o
    // que TORNA Σ certa, e nenhum doc nosso existe para discordar delas.
    const db = new FakeDb();
    semearPedido(db, { hasUserInteraction: true });
    const rica = linhaCombinadaBR();

    const r = await salvar(db, { linha: rica, mapeados: mapear({ linha: rica }) });

    expect(r.congelado).toBe(true);
    expect(r.criados).toBe(2);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('19. ⚠️ o irmão LEGADO `-desconto` é NOSSO: o cupom ATUALIZA o documento legado, nunca cria um 2º', async () => {
    // Legacy parity (Lucas, 2026-11-24): the cupom leg keeps the legacy
    // identity, so a migrated coupon document is the one this import writes.
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 43.99 });
    db.seed(`${PAGAMENTOS_PATH}/${DESCONTO}`, {
      id: `${ORDER_SN}-desconto`,
      valor: 10,
      forma_de_pagamento: FORMA_PAGAMENTO.outros,
      descricaoPagamento: 'cupom de desconto shopee',
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG(), cupomShopee: 12 }) });

    expect(r.criados).toBe(1);
    expect(r.atualizados).toBe(1);
    const docs = Object.keys(db.store).filter((k) => k.startsWith(`${PAGAMENTOS_PATH}/`));
    expect(docs.sort()).toEqual(
      [`${PAGAMENTOS_PATH}/${DESCONTO}`, `${PAGAMENTOS_PATH}/${PRIMARIO}`].sort(),
    );
    const cupom = db.store[`${PAGAMENTOS_PATH}/${DESCONTO}`]!.data;
    expect(cupom.valor).toBe(12);
    expect(cupom.descricaoPagamento).toBe('Cupom de desconto Shopee');
    expect(cupom.id).toBe(`${ORDER_SN}-desconto`);
    expect(r.somaPagante).toBe(43.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('19b. ⚠️ NEAR-MISS: uma entrega SEM escrow (provisória) não re-toma nada ao lado de um cupom gravado', async () => {
    // The stored set is primary + cupom; a PAID delivery whose escrow did not
    // answer maps only the primary, from the detail's total, as PROVISIONAL
    // money (`dinheiroShopee.ts`). One leg mapped, one leg stored: not a
    // shrink — the provisional rule is what freezes the buyer leg, and the
    // cupom is NOT retired, because a delivery with no escrow says nothing
    // about the floor. Σ stays what the earlier, complete delivery wrote.
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 43.99 });
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 31.99,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    db.seed(`${PAGAMENTOS_PATH}/${DESCONTO}`, {
      id: `${ORDER_SN}-desconto`,
      valor: 12,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    const r = await salvar(db, {
      mapeados: mapear({ valorDoComprador: 43.99, dinheiroProvisorio: true }),
    });

    expect(db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`]!.data.valor).toBe(31.99);
    expect(db.store[`${PAGAMENTOS_PATH}/${DESCONTO}`]!.data.valor).toBe(12);
    expect(db.store[`${PAGAMENTOS_PATH}/${DESCONTO}`]!.data.status_pagamento).toBe(
      STATUS_PAGAMENTO.aprovado,
    );
    expect(r.movimentoCupom).toBeNull();
    expect(r.somaPagante).toBe(43.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('19b2. ⚠️ o MESMO conjunto, entrega COM dinheiro respondido e sem cupom: a perna re-toma, o cupom é retirado', async () => {
    // The near-miss of 19b on the other side of the money gate: the delivery is
    // escrow-backed and says the floor no longer binds (the pedido's `vNF` is
    // now the buyer leg alone, 43.99). One leg against one leg is not degraded,
    // so the primary re-takes its value; the cupom leaves Σ as `estornado` and
    // keeps its 12 — never deleted, never zeroed.
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 43.99 });
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 31.99,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    db.seed(`${PAGAMENTOS_PATH}/${DESCONTO}`, {
      id: `${ORDER_SN}-desconto`,
      valor: 12,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    const r = await salvar(db, { mapeados: mapear({ valorDoComprador: 43.99 }) });

    expect(doc(db, PRIMARIO).valor).toBe(43.99);
    expect(doc(db, DESCONTO).valor).toBe(12);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(r.movimentoCupom).toBe('retirado');
    expect(r.somaPagante).toBe(43.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('19c. ⚠️ dinheiro PROVISÓRIO (pago, escrow em falha) congela o `valor` gravado — mesmo com UM doc só', async () => {
    // Same COUNT on both sides (one stored, one mapped), so the shrink rule
    // alone would re-take the primary's `valor` from the detail's total.
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 24 });
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 24,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    const r = await salvar(db, {
      mapeados: mapear({ valorDoComprador: 31.99, dinheiroProvisorio: true }),
    });

    expect(db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`]!.data.valor).toBe(24);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('19d. ⚠️ NEAR-MISS: o mesmo dinheiro NÃO provisório re-toma o `valor`', async () => {
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 24 });
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 24,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    await salvar(db, { mapeados: mapear({ valorDoComprador: 31.99 }) });

    expect(db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`]!.data.valor).toBe(31.99);
  });

  it('19e. dinheiro provisório num pedido SEM pagamento nosso ainda CRIA o conjunto', async () => {
    const db = new FakeDb();
    semearPedido(db);

    const r = await salvar(db, {
      mapeados: mapear({ valorDoComprador: 31.99, dinheiroProvisorio: true }),
    });

    expect(r.criados).toBe(1);
    expect(db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`]!.data.valor).toBe(31.99);
  });
});

/* ========================================================================== */
/*  shared by 25 and 26 — one delivery over the mapper's real output          */
/* ========================================================================== */

interface Entrega {
  /** The pedido's `vNF` as `orderPedidoTx.ts` leaves it for this delivery. */
  readonly vNF: number;
  readonly w: number;
  /** The buyer leg (`valorDoComprador`). */
  readonly comprador: number;
  /** The cupom leg; absent ⇒ the floor did not bind (nothing mapped). */
  readonly cupom?: number;
  readonly provisorio?: boolean;
  readonly linha?: ShopeeOrderDetailRow;
  readonly congelado?: boolean;
  readonly nowUs?: number;
}

/**
 * ONE delivery: the pedido re-seeded as the FIRST transaction would leave it
 * (its `vNF` as a single line, the order clock, the latch), then the
 * pagamento write over the mapper's real output.
 */
function entregar(db: FakeDb, e: Entrega) {
  semearPedido(db, {
    valorCobrado: e.vNF,
    lastMarketplaceUpdate: e.w,
    ...(e.congelado === true ? { hasUserInteraction: true } : {}),
  });
  const linha = e.linha ?? linhaSG();
  const relogio = e.nowUs === undefined ? {} : { nowUs: e.nowUs };
  return salvar(db, {
    linha,
    watermarkUs: e.w,
    ...relogio,
    mapeados: mapear({
      linha,
      valorDoComprador: e.comprador,
      ...(e.cupom === undefined ? {} : { cupomShopee: e.cupom }),
      ...(e.provisorio === undefined ? {} : { dinheiroProvisorio: e.provisorio }),
      watermarkUs: e.w,
      ...relogio,
    }),
  });
}

function chamadas(spy: ReturnType<typeof vi.spyOn>, trecho: string): number {
  return spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(trecho)).length;
}

/* ========================================================================== */
/*  25 · o ciclo de vida do cupom: contado À PARTE das pernas                 */
/* ========================================================================== */

describe('salvarPagamentosShopee — o ciclo de vida do cupom (o piso)', () => {
  const W1 = WATERMARK_US;
  const W2 = WATERMARK_US + 10_000_000;
  const W3 = WATERMARK_US + 20_000_000;
  const W4 = WATERMARK_US + 30_000_000;
  const W5 = WATERMARK_US + 40_000_000;

  /** The reviewer's opening state: the floor binds — buyer leg 55 + cupom 5 = vNF 60. */
  async function pisoAplicado(db: FakeDb): Promise<void> {
    const r = await entregar(db, { vNF: 60, w: W1, comprador: 55, cupom: 5 });
    expect(r.acao).toBe('criado');
    expect(db.idsEm(PAGAMENTOS_PATH).sort()).toEqual([PRIMARIO, DESCONTO].sort());
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  }

  function patchesDoCupom(db: FakeDb) {
    return db.patches.filter((p) => p.path.endsWith(`/${DESCONTO}`));
  }

  /** The retired state: 25's first two deliveries. */
  async function cupomRetirado(db: FakeDb): Promise<void> {
    await pisoAplicado(db);
    const r = await entregar(db, { vNF: 55, w: W2, comprador: 55 });
    expect(r.movimentoCupom).toBe('retirado');
  }

  it('25. ⚠️ o vetor do revisor (PR #2224): o piso deixa de valer ⇒ o cupom é ESTORNADO com o valor mantido, e Σ = vNF', async () => {
    const db = new FakeDb();
    await pisoAplicado(db);
    infoSpy.mockClear();

    // The actual shipping cost came in lower: the floor drops to 50, under the
    // 55 paid, so the first transaction takes vNF down to 55 and the mapper
    // maps no cupom. Counted together, this was "1 mapped < 2 owned" — a
    // degraded delivery that froze everything and left Σ at 60: cStat 866.
    const r = await entregar(db, { vNF: 55, w: W2, comprador: 55 });

    expect(r.acao).toBe('atualizado');
    expect(r.movimentoCupom).toBe('retirado');
    expect(r.statusRessuscitado).toBe(false);
    expect(doc(db, PRIMARIO).valor).toBe(55);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const cupom = doc(db, DESCONTO);
    expect(cupom.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(cupom.dataCancelamento).toBe(W2);
    // Never deleted, never zeroed: the valor and the identity stay as stored.
    expect(cupom.valor).toBe(5);
    expect(cupom.descricaoPagamento).toBe('Cupom de desconto Shopee');
    expect(cupom.id).toBe(`${ORDER_SN}-desconto`);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    // The retirement patch is the status and its date — no money field.
    expect(patchesDoCupom(db)).toHaveLength(1);
    expect(Object.keys(patchesDoCupom(db)[0]!.patch).sort()).toEqual([
      'dataCancelamento',
      'status_pagamento',
      'ultimaModificacao',
    ]);
    // ⚠️ The pair that matters: the projection SEES the retirement.
    expect(r.somaPagante).toBe(55);
    expect(r.divergenciaDeSoma).toBe(0);
    // Not a degraded delivery: one leg mapped, one leg stored.
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(0);
    expect(chamadas(infoSpy, 'cupom de desconto retirado')).toBe(1);
  });

  it('25b. o piso volta a valer ⇒ o cupom é REATIVADO com o valor novo, Σ = vNF — sem o warn de ressuscitado', async () => {
    const db = new FakeDb();
    await cupomRetirado(db);
    infoSpy.mockClear();
    warnSpy.mockClear();

    const r = await entregar(db, { vNF: 62, w: W3, comprador: 55, cupom: 7 });

    expect(r.movimentoCupom).toBe('reativado');
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(7);
    // Fill-once, exactly as on a reversed leg that comes back (16b).
    expect(doc(db, DESCONTO).dataCancelamento).toBe(W2);
    expect(doc(db, PRIMARIO).valor).toBe(55);
    expect(r.somaPagante).toBe(62);
    expect(r.divergenciaDeSoma).toBe(0);
    // ⚠️ An EXPECTED path: its own info line, never the loud warn/flag.
    expect(r.statusRessuscitado).toBe(false);
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(0);
    expect(chamadas(infoSpy, 'cupom de desconto reativado')).toBe(1);
  });

  it('25c. ⚠️ replay byte-idêntico do estado RETIRADO, com OUTRO nowUs ⇒ ignorado-sem-mudanca e ZERO escritas', async () => {
    const db = new FakeDb();
    await cupomRetirado(db);
    const escritasAntes = db.writes.length;
    const cupomAntes = { ...doc(db, DESCONTO) };
    db.opLog.length = 0;

    const r = await entregar(db, { vNF: 55, w: W2, comprador: 55, nowUs: OUTRO_AGORA_US });

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.movimentoCupom).toBeNull();
    expect(db.writes).toHaveLength(escritasAntes);
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);
    expect(doc(db, DESCONTO)).toEqual(cupomAntes);
    expect(r.somaPagante).toBe(55);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25d. NEAR-MISS (i): uma entrega PROVISÓRIA (escrow em falha) NÃO retira o cupom', async () => {
    const db = new FakeDb();
    await pisoAplicado(db);

    // Provisional money keeps the pedido's stored money, so vNF stays 60; the
    // buyer leg comes from the detail's total and maps NO cupom.
    const r = await entregar(db, { vNF: 60, w: W2, comprador: 61.99, provisorio: true });

    expect(r.movimentoCupom).toBeNull();
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(doc(db, PRIMARIO).valor).toBe(55);
    expect(patchesDoCupom(db)).toEqual([]);
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25e. NEAR-MISS (ii): uma entrega sem pay_time utilizável (nenhum doc mapeado) NÃO retira o cupom', async () => {
    const db = new FakeDb();
    await pisoAplicado(db);
    const semPayTime = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      pay_time: 0,
    });

    const r = await entregar(db, { vNF: 60, w: W2, comprador: 55, linha: semPayTime });

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.movimentoCupom).toBeNull();
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25f. NEAR-MISS (iii): com o pedido CONGELADO o cupom não é retirado e o valor dele não anda', async () => {
    const db = new FakeDb();
    await pisoAplicado(db);

    // A human edited the header: the first transaction keeps the lines, so the
    // latched vNF stays 60 — retiring the cupom would leave Σ short (865).
    const semCupom = await entregar(db, { vNF: 60, w: W2, comprador: 55, congelado: true });
    expect(semCupom.congelado).toBe(true);
    expect(semCupom.movimentoCupom).toBeNull();
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(semCupom.divergenciaDeSoma).toBe(0);

    // …and a delivery that maps a DIFFERENT cupom does not move its valor.
    const outroCupom = await entregar(db, {
      vNF: 60,
      w: W3,
      comprador: 55,
      cupom: 7,
      congelado: true,
    });
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(patchesDoCupom(db)).toEqual([]);
    expect(outroCupom.somaPagante).toBe(60);
    expect(outroCupom.divergenciaDeSoma).toBe(0);
  });

  it('25g. NEAR-MISS (iv): um status de OPERADOR fora da escada no cupom não é mexido', async () => {
    const db = new FakeDb();
    await pisoAplicado(db);
    db.store[`${PAGAMENTOS_PATH}/${DESCONTO}`]!.data.status_pagamento = STATUS_PAGAMENTO.recusado;

    const r = await entregar(db, { vNF: 55, w: W2, comprador: 55 });

    expect(r.movimentoCupom).toBeNull();
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.recusado);
    expect(patchesDoCupom(db)).toEqual([]);
    // `recusado` is outside Σ already, so the sum still closes.
    expect(r.somaPagante).toBe(55);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25h. (v) combinado 2 pernas + cupom; a entrega seguinte PERDE o payment_info mas mapeia o cupom: pernas congeladas, cupom re-tomado', async () => {
    const db = new FakeDb();
    const combinada = linhaCombinadaBR();
    const r1 = await entregar(db, {
      vNF: 36.99,
      w: W1,
      comprador: 31.99,
      cupom: 5,
      linha: combinada,
    });
    expect(r1.criados).toBe(3);
    expect(r1.somaPagante).toBe(36.99);
    infoSpy.mockClear();

    const pobre = linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: null });
    const r2 = await entregar(db, { vNF: 38.99, w: W2, comprador: 31.99, cupom: 7, linha: pobre });

    // The LEGS lost detail: frozen at the split the richer delivery wrote.
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    // The CUPOM tracks the floor: re-taken, even with the legs degraded.
    expect(doc(db, DESCONTO).valor).toBe(7);
    expect(Object.keys(patchesDoCupom(db).at(-1)!.patch).sort()).toEqual([
      'ultimaModificacao',
      'valor',
    ]);
    // Nothing double-counted: 21,99 + 10 + 7.
    expect(r2.somaPagante).toBe(38.99);
    expect(r2.divergenciaDeSoma).toBe(0);
  });

  it('25i. (2b) um cupom mapeado e NÃO gravado é CRIADO mesmo com as pernas degradadas', async () => {
    const db = new FakeDb();
    const combinada = linhaCombinadaBR();
    await entregar(db, { vNF: 31.99, w: W1, comprador: 31.99, linha: combinada });
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    infoSpy.mockClear();

    const pobre = linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: null });
    const r = await entregar(db, { vNF: 36.99, w: W2, comprador: 31.99, cupom: 5, linha: pobre });

    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(chamadas(infoSpy, 'conjunto congelado')).toBe(0);
    expect(r.criados).toBe(1);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.somaPagante).toBe(36.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25j. as pernas degradadas E o piso deixando de valer: o cupom é retirado e Σ fecha na perna do comprador', async () => {
    const db = new FakeDb();
    await entregar(db, {
      vNF: 36.99,
      w: W1,
      comprador: 31.99,
      cupom: 5,
      linha: linhaCombinadaBR(),
    });

    const pobre = linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: null });
    const r = await entregar(db, { vNF: 31.99, w: W2, comprador: 31.99, linha: pobre });

    expect(r.movimentoCupom).toBe('retirado');
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25k. ⚠️ (vi) o cupom RETIRADO não é ressuscitado por um READY_TO_SHIP que continua sem mapeá-lo', async () => {
    const db = new FakeDb();
    await cupomRetirado(db);
    expect(patchesDoCupom(db)).toHaveLength(1);

    // Every delivery below carries `READY_TO_SHIP` ⇒ target `aprovado`, which
    // the ladder WOULD write over an `estornado` (`estornado → aprovado` is
    // allowed for a leg): the refusal is the cupom rule, nothing else.
    const provisoria = await entregar(db, { vNF: 55, w: W3, comprador: 70, provisorio: true });
    const semPayTime = await entregar(db, {
      vNF: 55,
      w: W4,
      comprador: 55,
      linha: shopeeOrderDetailRowSchema.parse({
        order_sn: ORDER_SN,
        order_status: SHOPEE_ORDER_STATUS.readyToShip,
        pay_time: 0,
      }),
    });
    const congelada = await entregar(db, { vNF: 55, w: W5, comprador: 55, congelado: true });

    for (const r of [provisoria, semPayTime, congelada]) {
      expect(r.movimentoCupom).toBeNull();
      expect(r.statusRessuscitado).toBe(false);
      expect(r.somaPagante).toBe(55);
      expect(r.divergenciaDeSoma).toBe(0);
    }
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    // Only the retirement ever wrote the cupom.
    expect(patchesDoCupom(db)).toHaveLength(1);
  });

  it.each([
    {
      nome: 'sem pay_time (nenhum doc mapeado)',
      congelado: false,
      payTime: 0,
    },
    {
      nome: 'pedido CONGELADO, entrega com pay_time',
      congelado: true,
      payTime: PAY_TIME_S,
    },
  ])(
    '25l. (vii) um CANCELLED ainda tira um cupom VIVO e não mapeado da Σ — $nome',
    async ({ congelado, payTime }) => {
      const db = new FakeDb();
      await pisoAplicado(db);
      const cancelada = shopeeOrderDetailRowSchema.parse({
        order_sn: ORDER_SN,
        order_status: SHOPEE_ORDER_STATUS.cancelled,
        pay_time: payTime,
        payment_method: 'Apple Pay',
      });

      const r = await entregar(db, { vNF: 60, w: W2, comprador: 55, linha: cancelada, congelado });

      expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      expect(doc(db, DESCONTO).dataCancelamento).toBe(W2);
      expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      // The ORDER was cancelled — not the floor ceasing to bind.
      expect(r.movimentoCupom).toBeNull();
      expect(r.somaPagante).toBe(0);
    },
  );

  it('25m. ⚠️ CONGELADO: o cupom que NÓS retiramos não volta quando o piso volta a valer, se o primário não sai do estorno', async () => {
    // Retired, then a human edits the header (the latch), then the shipping
    // cost flips back and the floor binds again. The first transaction keeps
    // the latched lines — vNF stays 55, written WITHOUT the cupom — so
    // re-activating it would put Σ at 60 against 55: cStat 866, and the latch
    // means no later delivery repairs it.
    const db = new FakeDb();
    await cupomRetirado(db);

    const r = await entregar(db, { vNF: 55, w: W3, comprador: 55, cupom: 7, congelado: true });

    expect(r.movimentoCupom).toBeNull();
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(patchesDoCupom(db)).toHaveLength(1);
    expect(r.somaPagante).toBe(55);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25n. NEAR-MISS de 25m: CONGELADO, uma ordem cancelada que volta traz o cupom de volta JUNTO com as pernas', async () => {
    // The cupom left Σ together with the legs (a cancellation), so the latched
    // vNF was written WITH it: when the order comes back, it comes back too.
    const db = new FakeDb();
    await pisoAplicado(db);
    const cancelada = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.cancelled,
      pay_time: PAY_TIME_S,
      payment_method: 'Apple Pay',
    });
    await entregar(db, { vNF: 60, w: W2, comprador: 55, cupom: 5, linha: cancelada });
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    warnSpy.mockClear();

    const r = await entregar(db, { vNF: 60, w: W3, comprador: 55, cupom: 5, congelado: true });

    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    // The ORDER's resurrection is still reported loudly — by its leg — and the
    // cupom reports NOTHING: the floor did not move, so a `reativado` token
    // (and its "o piso voltou a valer" line) would name a cause that never was.
    expect(r.statusRessuscitado).toBe(true);
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(1);
    expect(r.movimentoCupom).toBeNull();
    expect(chamadas(infoSpy, 'cupom de desconto reativado')).toBe(0);
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  /** The SG single-leg order at a given status — amounts come from the mapper's inputs. */
  function linhaNoStatus(orderStatus: string, payTime: number = PAY_TIME_S): ShopeeOrderDetailRow {
    return shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: orderStatus,
      pay_time: payTime,
      payment_method: 'Apple Pay',
    });
  }

  it('25o. ⚠️ um cupom em `em_processo_aprovacao` ACOMPANHA as pernas numa entrega provisória — e o latch não o prende fora da Σ', async () => {
    // The reviewers' vector: a PAID `PENDING` whose escrow answered creates the
    // buyer leg AND the cupom at `em_processo_aprovacao` (outside Σ, both). The
    // next delivery is `READY_TO_SHIP` with a failed escrow: provisional money
    // maps no cupom, and the legs move into Σ. A cupom held at 3 by a "never
    // INTO Σ" rule left Σ at 55 against the 60 the pedido kept (865), and once
    // a human latched the header the next delivery that mapped it was refused
    // too — 865 for ever. A cupom that is not `estornado` is not one we retired.
    const db = new FakeDb();
    await entregar(db, {
      vNF: 60,
      w: W1,
      comprador: 55,
      cupom: 5,
      linha: linhaNoStatus(SHOPEE_ORDER_STATUS.pending),
    });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.em_processo_aprovacao);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.em_processo_aprovacao);

    const provisoria = await entregar(db, { vNF: 60, w: W2, comprador: 61.99, provisorio: true });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(provisoria.movimentoCupom).toBeNull();
    expect(provisoria.somaPagante).toBe(60);
    expect(provisoria.divergenciaDeSoma).toBe(0);

    const enviada = await entregar(db, {
      vNF: 60,
      w: W3,
      comprador: 55,
      cupom: 5,
      congelado: true,
      linha: linhaNoStatus(SHOPEE_ORDER_STATUS.shipped),
    });
    expect(enviada.congelado).toBe(true);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(enviada.somaPagante).toBe(60);
    expect(enviada.divergenciaDeSoma).toBe(0);
  });

  it.each([{ congelado: false }, { congelado: true }])(
    '25p. ⚠️ uma ordem cancelada que volta numa entrega PROVISÓRIA traz o cupom JUNTO com as pernas (congelado: $congelado)',
    async ({ congelado }) => {
      // The cancellation took the legs and the cupom out of Σ TOGETHER; the
      // reversal arrives on a delivery whose escrow failed, so nothing maps the
      // cupom. Kept out, Σ is 55 against the 60 the pedido kept — and under the
      // latch every later delivery that mapped it was refused as well.
      const db = new FakeDb();
      await pisoAplicado(db);
      await entregar(db, {
        vNF: 60,
        w: W2,
        comprador: 55,
        cupom: 5,
        congelado,
        linha: linhaNoStatus(SHOPEE_ORDER_STATUS.cancelled),
      });
      expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      warnSpy.mockClear();
      infoSpy.mockClear();

      const volta = await entregar(db, {
        vNF: 60,
        w: W3,
        comprador: 61.99,
        provisorio: true,
        congelado,
      });
      expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
      expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
      expect(doc(db, DESCONTO).valor).toBe(5);
      // The ORDER came back: its leg says so, the cupom does not.
      expect(volta.statusRessuscitado).toBe(true);
      expect(volta.movimentoCupom).toBeNull();
      expect(chamadas(infoSpy, 'cupom de desconto reativado')).toBe(0);
      expect(volta.somaPagante).toBe(60);
      expect(volta.divergenciaDeSoma).toBe(0);

      const enviada = await entregar(db, {
        vNF: 60,
        w: W4,
        comprador: 55,
        cupom: 5,
        congelado,
        linha: linhaNoStatus(SHOPEE_ORDER_STATUS.shipped),
      });
      expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
      expect(enviada.somaPagante).toBe(60);
      expect(enviada.divergenciaDeSoma).toBe(0);
    },
  );

  it('25q. ⚠️ NEAR-MISS de 25o/25p: o cupom retirado enquanto as pernas esperavam NÃO volta quando elas ENTRAM na Σ', async () => {
    // Only the PRIMARY leaving `estornado` (a reversed cancellation) may bring
    // a retired cupom back. Legs moving from `em_processo_aprovacao` into Σ are
    // the order getting PAID, which says nothing about the floor: read as
    // "a leg enters Σ", this delivery would resurrect the cupom at 5 over a
    // pedido whose `vNF` (kept by the provisional money) is 55 — 866.
    const db = new FakeDb();
    const pendente = linhaNoStatus(SHOPEE_ORDER_STATUS.pending);
    await entregar(db, { vNF: 60, w: W1, comprador: 55, cupom: 5, linha: pendente });
    const retirada = await entregar(db, { vNF: 55, w: W2, comprador: 55, linha: pendente });
    expect(retirada.movimentoCupom).toBe('retirado');
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.em_processo_aprovacao);

    const paga = await entregar(db, { vNF: 55, w: W3, comprador: 61.99, provisorio: true });

    // The anchor: the legs really did ENTER Σ on this delivery.
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(paga.movimentoCupom).toBeNull();
    expect(paga.somaPagante).toBe(55);
    expect(paga.divergenciaDeSoma).toBe(0);
  });

  it('25r. NEAR-MISS da regra: um cupom VIVO e não mapeado segue a ordem DENTRO da Σ (aprovado ⇄ em_disputa)', async () => {
    // Both statuses count, so neither move is a return: the rule must not
    // freeze a live cupom at `aprovado` while the legs open a dispute, nor at
    // `em_disputa` once it closes.
    const db = new FakeDb();
    await pisoAplicado(db);

    const disputa = await entregar(db, {
      vNF: 60,
      w: W2,
      comprador: 61.99,
      provisorio: true,
      linha: linhaNoStatus(SHOPEE_ORDER_STATUS.inCancel),
    });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.em_disputa);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.em_disputa);
    expect(disputa.movimentoCupom).toBeNull();
    expect(disputa.somaPagante).toBe(60);
    expect(disputa.divergenciaDeSoma).toBe(0);

    const fechada = await entregar(db, {
      vNF: 60,
      w: W3,
      comprador: 55,
      linha: linhaNoStatus(SHOPEE_ORDER_STATUS.readyToShip, 0),
    });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(fechada.somaPagante).toBe(60);
    expect(fechada.divergenciaDeSoma).toBe(0);
  });

  it('25s. um cupom LEGADO sem status (`null`, que já conta) é escrito pela ordem numa entrega provisória', async () => {
    const db = new FakeDb();
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 55,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    db.seed(`${PAGAMENTOS_PATH}/${DESCONTO}`, {
      id: `${ORDER_SN}-desconto`,
      valor: 5,
      status_pagamento: null,
    });

    const r = await entregar(db, { vNF: 60, w: W1, comprador: 61.99, provisorio: true });

    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(r.movimentoCupom).toBeNull();
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('25t. ⚠️ o gêmeo de 18d: num pedido CONGELADO sem pagamento nenhum, a primeira entrega cria a perna E o cupom', async () => {
    // The cupom's creation gate is the latch AND a document of ours already
    // stored. Withheld here, Σ would stand at 55 against the floor's 60, and
    // the buyer leg created alongside would make every later delivery a
    // "set that may not grow" — 865 for ever.
    const db = new FakeDb();

    const r = await entregar(db, { vNF: 60, w: W1, comprador: 55, cupom: 5, congelado: true });

    expect(r.congelado).toBe(true);
    expect(r.criados).toBe(2);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.somaPagante).toBe(60);
    expect(r.divergenciaDeSoma).toBe(0);
  });
});

/* ========================================================================== */
/*  26 · o colapso POR VALOR: as pernas superadas são RETIRADAS               */
/* ========================================================================== */

describe('salvarPagamentosShopee — o colapso por valor e as pernas superadas', () => {
  const W1 = WATERMARK_US;
  const W2 = WATERMARK_US + 10_000_000;
  const W3 = WATERMARK_US + 20_000_000;
  const W4 = WATERMARK_US + 30_000_000;
  const W5 = WATERMARK_US + 40_000_000;
  const W6 = WATERMARK_US + 50_000_000;

  function entrada(metodo: string, valor: number, autorizacao: string) {
    return {
      payment_method: metodo,
      payment_amount: valor,
      card_brand: metodo === 'pix' ? '' : 'visa',
      transaction_id: autorizacao,
      payment_processor_register: CNPJ_FALSO,
    };
  }

  /**
   * The Codex vector (PR #2224): a FOB order, goods 50 and 10 of freight the
   * buyer paid, a combined payment of two entries that sum to the
   * freight-INCLUSIVE 60. The credit-card entry sorts first: it is the PRIMARY.
   */
  function linhaCodex(
    over: { orderStatus?: string; payTime?: number; paymentInfo?: unknown } = {},
  ): ShopeeOrderDetailRow {
    return shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: over.orderStatus ?? SHOPEE_ORDER_STATUS.readyToShip,
      region: 'BR',
      pay_time: over.payTime ?? PAY_TIME_S,
      total_amount: 60,
      payment_method: 'Combined Payment',
      payment_info:
        'paymentInfo' in over
          ? over.paymentInfo
          : [entrada('pix', 30, 'AUT-PIX'), entrada('credit_card', 30, 'AUT-CC')],
    });
  }

  function patchesDe(db: FakeDb, id: string) {
    return db.patches.filter((p) => p.path.endsWith(`/${id}`));
  }

  /**
   * Delivery 1 of the vector: PAID, the escrow failed (contained) — the buyer
   * leg is the detail's freight-inclusive `total_amount`, the entries fit it,
   * and the two legs are CREATED. The pedido's `vNF` is the goods (FOB), so
   * provisional money does not close: the NF-e refuses rather than emits.
   */
  async function combinadoProvisorio(db: FakeDb): Promise<void> {
    const r = await entregar(db, {
      vNF: 50,
      w: W1,
      comprador: 60,
      provisorio: true,
      linha: linhaCodex(),
    });
    expect(r.criados).toBe(2);
    expect(doc(db, PRIMARIO).valor).toBe(30);
    expect(doc(db, SECUNDARIO).valor).toBe(30);
    expect(r.divergenciaDeSoma).toBe(10);
  }

  /** Delivery 2 of the vector: the escrow answers ⇒ buyer leg 50, the SAME entries collapse. */
  async function pernaSuperada(db: FakeDb): Promise<void> {
    await combinadoProvisorio(db);
    const r = await entregar(db, { vNF: 50, w: W2, comprador: 50, linha: linhaCodex() });
    expect(r.pernasRetiradas).toBe(1);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
  }

  it('26. ⚠️ o vetor do Codex (PR #2224): o escrow responde ⇒ o primário re-toma 50, o irmão é RETIRADO, Σ = vNF; o replay não grava; provisória e sem pay_time não ressuscitam', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);
    infoSpy.mockClear();
    warnSpy.mockClear();

    // Delivery 2 — the escrow answers: the buyer leg is 60 − 10 of freight = 50,
    // and the SAME two entries (60) collapse. Read as detail loss ("1 mapped <
    // 2 stored") this froze both legs at 30 + 30 against a vNF of 50: cStat 866
    // on every later import, never repaired.
    const r2 = await entregar(db, { vNF: 50, w: W2, comprador: 50, linha: linhaCodex() });

    expect(r2.acao).toBe('atualizado');
    expect(doc(db, PRIMARIO).valor).toBe(50);
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const irmao = doc(db, SECUNDARIO);
    expect(irmao.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(irmao.dataCancelamento).toBe(W2);
    // Never deleted, never zeroed: the valor and the identity stay as stored.
    expect(irmao.valor).toBe(30);
    expect(irmao.id).toBe(`${ORDER_SN}-1`);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    // The retirement patch is the status and its date — no money field.
    expect(patchesDe(db, SECUNDARIO)).toHaveLength(1);
    expect(Object.keys(patchesDe(db, SECUNDARIO)[0]!.patch).sort()).toEqual([
      'dataCancelamento',
      'status_pagamento',
      'ultimaModificacao',
    ]);
    expect(r2.pernasRetiradas).toBe(1);
    expect(r2.pernasReativadas).toBe(0);
    expect(r2.statusRessuscitado).toBe(false);
    // ⚠️ The pair that matters: the projection SEES the retirement.
    expect(r2.somaPagante).toBe(50);
    expect(r2.divergenciaDeSoma).toBe(0);
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(0);
    expect(chamadas(infoSpy, 'pernas superadas retiradas')).toBe(1);

    // Delivery 3 — the byte-identical replay, under ANOTHER clock: nothing.
    const escritasAntes = db.writes.length;
    db.opLog.length = 0;
    const r3 = await entregar(db, {
      vNF: 50,
      w: W2,
      comprador: 50,
      linha: linhaCodex(),
      nowUs: OUTRO_AGORA_US,
    });
    expect(r3.acao).toBe('ignorado-sem-mudanca');
    expect(r3.pernasRetiradas).toBe(0);
    expect(db.writes).toHaveLength(escritasAntes);
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);

    // Delivery 4 — `READY_TO_SHIP` targets `aprovado`, which the ladder WOULD
    // write over the sibling's `estornado`. Provisional money MAPS it again
    // (the entries fit the freight-inclusive 60), and a delivery with no usable
    // `pay_time` maps nothing: neither may bring it back into Σ.
    warnSpy.mockClear();
    const provisoria = await entregar(db, {
      vNF: 50,
      w: W3,
      comprador: 60,
      provisorio: true,
      linha: linhaCodex(),
    });
    const semPayTime = await entregar(db, {
      vNF: 50,
      w: W4,
      comprador: 50,
      linha: linhaCodex({ payTime: 0 }),
    });
    for (const r of [provisoria, semPayTime]) {
      expect(r.statusRessuscitado).toBe(false);
      expect(r.pernasReativadas).toBe(0);
      expect(r.somaPagante).toBe(50);
      expect(r.divergenciaDeSoma).toBe(0);
    }
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, PRIMARIO).valor).toBe(50);
    // Only the retirement ever wrote the sibling.
    expect(patchesDe(db, SECUNDARIO)).toHaveLength(1);
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(0);
  });

  it('26b. ⚠️ NEAR-MISS (i): PERDA DE DETALHE ainda congela — UMA entrada utilizável contra duas pernas, com o escrow respondido', async () => {
    const db = new FakeDb();
    await entregar(db, { vNF: 31.99, w: W1, comprador: 31.99, linha: linhaCombinadaBR() });
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    infoSpy.mockClear();

    // One usable entry is not a collapse (the mapper never fans out ONE), so
    // the delivery LOST detail: the primary must not re-take the whole 31,99
    // beside the sibling's 10.
    const umaEntrada = linhaCombinadaBR({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: [entrada('credit_card', 21.99, 'AUT-CC')],
    });
    const r = await entregar(db, { vNF: 31.99, w: W2, comprador: 31.99, linha: umaEntrada });

    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(patchesDe(db, SECUNDARIO)).toEqual([]);
    expect(r.pernasRetiradas).toBe(0);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it.each([
    {
      nome: 'TRÊS pernas guardadas, DUAS entradas que não fecham ⇒ perda de detalhe: congela',
      guardadas: [
        entrada('pix', 10, 'AUT-PIX'),
        entrada('credit_card', 15, 'AUT-CC'),
        entrada('credit_card', 6.99, 'AUT-CC2'),
      ],
      vNFAntes: 31.99,
      recebidas: [entrada('pix', 10, 'AUT-PIX'), entrada('credit_card', 15, 'AUT-CC')],
      vNFDepois: 31.99,
      retira: false,
    },
    {
      nome: 'DUAS pernas guardadas, TRÊS entradas que não fecham ⇒ nada perdido: o irmão é retirado',
      guardadas: [entrada('pix', 10, 'AUT-PIX'), entrada('credit_card', 21.99, 'AUT-CC')],
      vNFAntes: 31.99,
      recebidas: [
        entrada('pix', 10, 'AUT-PIX'),
        entrada('credit_card', 15, 'AUT-CC'),
        entrada('credit_card', 6.99, 'AUT-CC2'),
      ],
      vNFDepois: 30,
      retira: true,
    },
  ])(
    '26c. a fronteira é `entradas >= pernas guardadas`, nunca "mapeou uma só" — $nome',
    async ({ guardadas, vNFAntes, recebidas, vNFDepois, retira }) => {
      const db = new FakeDb();
      const r1 = await entregar(db, {
        vNF: vNFAntes,
        w: W1,
        comprador: vNFAntes,
        linha: linhaCombinadaBR({ paymentInfo: guardadas }),
      });
      expect(r1.criados).toBe(guardadas.length);
      const antes = Object.fromEntries(
        db.idsEm(PAGAMENTOS_PATH).map((id) => [id, doc(db, id).valor]),
      );
      infoSpy.mockClear();

      // Both deliveries COLLAPSE (`soma-divergente`); only the entry count says
      // whether anything was lost.
      const r2 = await entregar(db, {
        vNF: vNFDepois,
        w: W2,
        comprador: vNFDepois,
        linha: linhaCombinadaBR({
          orderStatus: SHOPEE_ORDER_STATUS.shipped,
          paymentInfo: recebidas,
        }),
      });

      expect(chamadas(infoSpy, 'entrega degradada')).toBe(retira ? 0 : 1);
      expect(r2.pernasRetiradas).toBe(retira ? 1 : 0);
      if (retira) {
        expect(doc(db, PRIMARIO).valor).toBe(30);
        expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      } else {
        for (const [id, valor] of Object.entries(antes)) {
          expect(doc(db, id).valor).toBe(valor);
          expect(doc(db, id).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
        }
      }
      expect(r2.somaPagante).toBe(vNFDepois);
      expect(r2.divergenciaDeSoma).toBe(0);
    },
  );

  it('26d. NEAR-MISS (ii): o MESMO colapso num pedido CONGELADO não retira nada e não re-toma nada', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);

    const r = await entregar(db, {
      vNF: 50,
      w: W2,
      comprador: 50,
      linha: linhaCodex(),
      congelado: true,
    });

    expect(r.congelado).toBe(true);
    expect(r.pernasRetiradas).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(30);
    expect(doc(db, SECUNDARIO).valor).toBe(30);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(patchesDe(db, SECUNDARIO)).toEqual([]);
    // A human froze the pedido: what is stored stands, exactly as before.
    expect(r.somaPagante).toBe(60);
  });

  it('26e. NEAR-MISS (iii): um colapso numa entrega PROVISÓRIA continua congelado — nada retirado', async () => {
    // Two legs an escrow-backed delivery wrote (21,99 + 10 = vNF 31,99); then a
    // paid delivery whose escrow failed: its buyer leg is the freight-inclusive
    // 33,98, the same two entries (31,99) collapse — but the money is not the
    // escrow's, so the collapse proves nothing.
    const db = new FakeDb();
    await entregar(db, { vNF: 31.99, w: W1, comprador: 31.99, linha: linhaCombinadaBR() });
    infoSpy.mockClear();

    const r = await entregar(db, {
      vNF: 31.99,
      w: W2,
      comprador: 33.98,
      provisorio: true,
      linha: linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.shipped }),
    });

    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(r.pernasRetiradas).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(21.99);
    expect(doc(db, SECUNDARIO).valor).toBe(10);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('26f. NEAR-MISS (iv): um status de OPERADOR fora da escada no irmão não é mexido', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);
    db.store[`${PAGAMENTOS_PATH}/${SECUNDARIO}`]!.data.status_pagamento = STATUS_PAGAMENTO.recusado;

    const r = await entregar(db, { vNF: 50, w: W2, comprador: 50, linha: linhaCodex() });

    expect(r.pernasRetiradas).toBe(0);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.recusado);
    expect(patchesDe(db, SECUNDARIO)).toEqual([]);
    // The primary still re-takes the buyer leg; `recusado` is outside Σ already.
    expect(doc(db, PRIMARIO).valor).toBe(50);
    expect(r.somaPagante).toBe(50);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('26g. ⚠️ (vii) um irmão retirado nunca abona a volta de um cupom retirado, nem o cupom a do irmão', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);
    // The collapse AND the floor binding (cupom 5, vNF 55), then the floor
    // stops binding: both the sibling and the cupom are retired.
    await entregar(db, { vNF: 55, w: W2, comprador: 50, cupom: 5, linha: linhaCodex() });
    const r = await entregar(db, { vNF: 50, w: W3, comprador: 50, linha: linhaCodex() });
    expect(r.movimentoCupom).toBe('retirado');
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    const patchesAntes = db.patches.length;
    warnSpy.mockClear();

    // (a) no usable `pay_time`: `READY_TO_SHIP` targets `aprovado` for both.
    // Under "any LEG leaving `estornado`" the sibling came back on its own and
    // vouched for the cupom: Σ 85 against 50.
    const semPayTime = await entregar(db, {
      vNF: 50,
      w: W4,
      comprador: 50,
      linha: linhaCodex({ payTime: 0 }),
    });
    // (b) the latch, the floor binding again: the mapped cupom may not come
    // back over the latched vNF, and neither may the unmapped sibling.
    const congelada = await entregar(db, {
      vNF: 50,
      w: W5,
      comprador: 50,
      cupom: 7,
      congelado: true,
      linha: linhaCodex(),
    });
    for (const x of [semPayTime, congelada]) {
      expect(x.statusRessuscitado).toBe(false);
      expect(x.movimentoCupom).toBeNull();
      expect(x.pernasReativadas).toBe(0);
      expect(x.somaPagante).toBe(50);
      expect(x.divergenciaDeSoma).toBe(0);
    }
    expect(db.patches).toHaveLength(patchesAntes);

    // (c) off the latch, the floor binds again: the cupom's OWN return is
    // legitimate — and it does not carry the still-superseded sibling with it.
    const piso = await entregar(db, {
      vNF: 57,
      w: W6,
      comprador: 50,
      cupom: 7,
      linha: linhaCodex(),
    });
    expect(piso.movimentoCupom).toBe('reativado');
    expect(doc(db, DESCONTO).valor).toBe(7);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(piso.pernasReativadas).toBe(0);
    expect(piso.somaPagante).toBe(57);
    expect(piso.divergenciaDeSoma).toBe(0);
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(0);
  });

  it('26h. (v) o combinado volta a FECHAR ⇒ o irmão é mapeado e REATIVADO com o valor novo — linha própria, sem o warn de ressuscitado', async () => {
    const db = new FakeDb();
    await pernaSuperada(db);
    infoSpy.mockClear();
    warnSpy.mockClear();

    const fecha = linhaCodex({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: [entrada('pix', 25, 'AUT-PIX'), entrada('credit_card', 25, 'AUT-CC')],
    });
    const r = await entregar(db, { vNF: 50, w: W3, comprador: 50, linha: fecha });

    expect(r.pernasReativadas).toBe(1);
    expect(r.pernasRetiradas).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(25);
    expect(doc(db, SECUNDARIO).valor).toBe(25);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    // Fill-once, exactly as on a reversed leg that comes back (16b).
    expect(doc(db, SECUNDARIO).dataCancelamento).toBe(W2);
    expect(r.somaPagante).toBe(50);
    expect(r.divergenciaDeSoma).toBe(0);
    // ⚠️ An EXPECTED path: its own info line, never the loud warn/flag.
    expect(r.statusRessuscitado).toBe(false);
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(0);
    expect(chamadas(infoSpy, 'perna de pagamento reativada')).toBe(1);
  });

  it('26i. (vi) RESIDUAL documentado: o cancelamento tira tudo; a volta traz o primário E o irmão e o cupom retirados; o colapso seguinte retira de novo', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);
    await entregar(db, { vNF: 55, w: W2, comprador: 50, cupom: 5, linha: linhaCodex() });
    await entregar(db, { vNF: 50, w: W3, comprador: 50, linha: linhaCodex() });

    const cancelada = await entregar(db, {
      vNF: 50,
      w: W4,
      comprador: 50,
      linha: linhaCodex({ orderStatus: SHOPEE_ORDER_STATUS.cancelled }),
    });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(cancelada.somaPagante).toBe(0);
    warnSpy.mockClear();

    // `estornado` cannot say who wrote it: the PRIMARY leaving it is the order
    // coming back, and everything we retired follows it — Σ above the nota.
    const volta = await entregar(db, {
      vNF: 50,
      w: W5,
      comprador: 50,
      linha: linhaCodex({ payTime: 0 }),
    });
    expect(volta.statusRessuscitado).toBe(true);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(volta.somaPagante).toBe(85);
    // The order's return is reported loudly, by its legs; the cupom says nothing.
    expect(chamadas(warnSpy, 'ressuscitado')).toBe(2);
    expect(volta.movimentoCupom).toBeNull();
    expect(volta.pernasReativadas).toBe(0);

    // Off the latch, the next money-answered collapse retires both again.
    const colapso = await entregar(db, { vNF: 50, w: W6, comprador: 50, linha: linhaCodex() });
    expect(colapso.pernasRetiradas).toBe(1);
    expect(colapso.movimentoCupom).toBe('retirado');
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    // The FIRST retirement's date, kept across the round trip.
    expect(doc(db, SECUNDARIO).dataCancelamento).toBe(W2);
    expect(colapso.somaPagante).toBe(50);
    expect(colapso.divergenciaDeSoma).toBe(0);
  });

  it('26j. (viii) o cupom e o colapso por valor na MESMA entrega: o irmão é retirado, o cupom criado, Σ = vNF', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);

    const r = await entregar(db, {
      vNF: 55,
      w: W2,
      comprador: 50,
      cupom: 5,
      linha: linhaCodex(),
    });

    expect(r.criados).toBe(1);
    expect(r.pernasRetiradas).toBe(1);
    expect(r.movimentoCupom).toBeNull();
    expect(doc(db, PRIMARIO).valor).toBe(50);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, DESCONTO).valor).toBe(5);
    expect(doc(db, DESCONTO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.somaPagante).toBe(55);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  /** Three entries: credit 15 (the PRIMARY), credit 6,99 (the -1), pix 10 (the -2). */
  const TRES_ENTRADAS = [
    entrada('pix', 10, 'AUT-PIX'),
    entrada('credit_card', 15, 'AUT-CC'),
    entrada('credit_card', 6.99, 'AUT-CC2'),
  ];
  const TERCEIRO = makePagamentoIdShopee(CONTA, ORDER_SN, '-2');

  it('26k. ⚠️ um irmão RETIRADO não é detalhe a perder: uma entrega SEM payment_info depois da retirada re-toma o primário e Σ = vNF', async () => {
    // After the retirement (50 + 30@estornado) the shipped order stops
    // carrying `payment_info` and the escrow's buyer leg moves to 48. Counting
    // the retired sibling (1 mapped < 2 stored) froze the primary at 50
    // against a vNF of 48 — 866 for as long as the detail stays absent, while
    // a single-leg order in the same spot closes.
    const db = new FakeDb();
    await pernaSuperada(db);
    infoSpy.mockClear();

    const semDetalhe = linhaCodex({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: [] });
    const r = await entregar(db, { vNF: 48, w: W3, comprador: 48, linha: semDetalhe });

    expect(chamadas(infoSpy, 'entrega degradada')).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(48);
    expect(doc(db, SECUNDARIO)).toMatchObject({
      valor: 30,
      status_pagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(patchesDe(db, SECUNDARIO)).toHaveLength(1);
    expect(r.pernasRetiradas).toBe(0);
    expect(r.pernasReativadas).toBe(0);
    expect(r.somaPagante).toBe(48);
    expect(r.divergenciaDeSoma).toBe(0);

    // NEAR-MISS: the SAME detail-less delivery over a sibling still PAGANTE is
    // detail loss — the primary must not re-take the whole 60 beside its 30.
    const vivo = new FakeDb();
    await entregar(vivo, { vNF: 60, w: W1, comprador: 60, linha: linhaCodex() });
    infoSpy.mockClear();
    const r2 = await entregar(vivo, { vNF: 60, w: W3, comprador: 60, linha: semDetalhe });
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(doc(vivo, PRIMARIO).valor).toBe(30);
    expect(doc(vivo, SECUNDARIO)).toMatchObject({
      valor: 30,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    expect(r2.somaPagante).toBe(60);
    expect(r2.divergenciaDeSoma).toBe(0);
  });

  it('26l. três pernas, DUAS retiradas: duas entradas que não fecham ainda são colapso por VALOR; as duas que fecham reativam só a -1', async () => {
    const db = new FakeDb();
    const r1 = await entregar(db, {
      vNF: 31.99,
      w: W1,
      comprador: 31.99,
      linha: linhaCombinadaBR({ paymentInfo: TRES_ENTRADAS }),
    });
    expect(r1.criados).toBe(3);
    // The buyer leg moves to 30 under the SAME three entries: both siblings go.
    const r2 = await entregar(db, {
      vNF: 30,
      w: W2,
      comprador: 30,
      linha: linhaCombinadaBR({
        orderStatus: SHOPEE_ORDER_STATUS.shipped,
        paymentInfo: TRES_ENTRADAS,
      }),
    });
    expect(r2.pernasRetiradas).toBe(2);
    expect(r2.somaPagante).toBe(30);
    infoSpy.mockClear();

    // (a) TWO entries that do not fit a buyer leg moved to 28: fewer than the
    // three STORED legs, but only the primary is in play — nothing was lost.
    // Read as detail loss, the primary froze at 30 against a vNF of 28.
    const r3 = await entregar(db, {
      vNF: 28,
      w: W3,
      comprador: 28,
      linha: linhaCombinadaBR({
        orderStatus: SHOPEE_ORDER_STATUS.shipped,
        paymentInfo: [entrada('pix', 10, 'AUT-PIX'), entrada('credit_card', 15, 'AUT-CC')],
      }),
    });
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(28);
    expect(r3.pernasRetiradas).toBe(0);
    expect(r3.somaPagante).toBe(28);
    expect(r3.divergenciaDeSoma).toBe(0);

    // (b) Two entries that FIT 28 map the primary and the -1: both re-take,
    // the -1 comes back into Σ; the unmapped -2 stays retired.
    const r4 = await entregar(db, {
      vNF: 28,
      w: W4,
      comprador: 28,
      linha: linhaCombinadaBR({
        orderStatus: SHOPEE_ORDER_STATUS.shipped,
        paymentInfo: [entrada('pix', 10, 'AUT-PIX'), entrada('credit_card', 18, 'AUT-CC')],
      }),
    });
    expect(r4.pernasReativadas).toBe(1);
    expect(doc(db, PRIMARIO).valor).toBe(18);
    expect(doc(db, SECUNDARIO)).toMatchObject({
      valor: 10,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    expect(doc(db, TERCEIRO)).toMatchObject({
      valor: 10,
      status_pagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(r4.somaPagante).toBe(28);
    expect(r4.divergenciaDeSoma).toBe(0);
  });

  it('26m. NEAR-MISS de 26k: um irmão que a ORDEM estornou junto com o primário ainda conta — o cancelamento sem detalhe não re-toma o primário, e a volta fecha', async () => {
    const db = new FakeDb();
    // Two legs an escrow-backed delivery wrote: 30 + 30 = vNF 60.
    await entregar(db, { vNF: 60, w: W1, comprador: 60, linha: linhaCodex() });
    const cancelada = linhaCodex({
      orderStatus: SHOPEE_ORDER_STATUS.cancelled,
      paymentInfo: [],
    });
    await entregar(db, { vNF: 60, w: W2, comprador: 60, linha: cancelada });
    expect(doc(db, PRIMARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    infoSpy.mockClear();

    // The primary is stored `estornado` too: the sibling comes back WITH it,
    // so it is still in play and this delivery lost detail.
    await entregar(db, { vNF: 60, w: W3, comprador: 60, linha: cancelada });
    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(doc(db, PRIMARIO).valor).toBe(30);

    // The un-cancel (no usable `pay_time`): the order brings both back, and Σ
    // closes only because the primary was never re-taken to the whole 60.
    const volta = await entregar(db, {
      vNF: 60,
      w: W4,
      comprador: 60,
      linha: linhaCodex({ payTime: 0 }),
    });
    expect(volta.statusRessuscitado).toBe(true);
    expect(doc(db, SECUNDARIO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(volta.somaPagante).toBe(60);
    expect(volta.divergenciaDeSoma).toBe(0);
  });

  it('26n. ⚠️ uma perna retirada e MAPEADA não volta enquanto o grupo DADOS está congelado (perda de detalhe ao lado de um irmão vivo)', async () => {
    const db = new FakeDb();
    await entregar(db, {
      vNF: 31.99,
      w: W1,
      comprador: 31.99,
      linha: linhaCombinadaBR({ paymentInfo: TRES_ENTRADAS }),
    });
    // An operator folds the -1 (6,99) into the primary by hand — a HOLE our
    // own retirements never leave (they retire a suffix) — with Σ still 31,99.
    db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`]!.data.valor = 21.99;
    db.store[`${PAGAMENTOS_PATH}/${SECUNDARIO}`]!.data.status_pagamento =
      STATUS_PAGAMENTO.estornado;
    infoSpy.mockClear();

    // Two entries that FIT 31,99 map the primary and the -1 while the -2
    // (pix 10) stays pagante and unmapped: detail LOST, DATA frozen. Brought
    // back at its frozen 6,99, the -1 would put Σ at 38,98 against 31,99.
    const r = await entregar(db, {
      vNF: 31.99,
      w: W2,
      comprador: 31.99,
      linha: linhaCombinadaBR({
        orderStatus: SHOPEE_ORDER_STATUS.shipped,
        paymentInfo: [entrada('pix', 10, 'AUT-PIX'), entrada('credit_card', 21.99, 'AUT-CC')],
      }),
    });

    expect(chamadas(infoSpy, 'entrega degradada')).toBe(1);
    expect(r.pernasReativadas).toBe(0);
    expect(doc(db, SECUNDARIO)).toMatchObject({
      valor: 6.99,
      status_pagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(doc(db, TERCEIRO).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.somaPagante).toBe(31.99);
    expect(r.divergenciaDeSoma).toBe(0);
  });

  it('26o. RESIDUAL documentado: pernas criadas no dinheiro provisório cuja primeira entrega com escrow PERDEU o payment_info ficam acima do vNF até chegarem entradas suficientes', async () => {
    const db = new FakeDb();
    await combinadoProvisorio(db);

    // Detail loss by the rule: fewer usable entries (none) than legs in play.
    // Telling these legs apart from an escrow-backed set would need a stored
    // marker no document carries — an open decision (the module header).
    const semDetalhe = await entregar(db, {
      vNF: 50,
      w: W2,
      comprador: 50,
      linha: linhaCodex({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: [] }),
    });
    expect(semDetalhe.pernasRetiradas).toBe(0);
    expect(doc(db, PRIMARIO).valor).toBe(30);
    expect(doc(db, SECUNDARIO)).toMatchObject({
      valor: 30,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    expect(semDetalhe.somaPagante).toBe(60);
    expect(semDetalhe.divergenciaDeSoma).toBe(10);

    // It heals on the first delivery carrying at least as many entries.
    const cura = await entregar(db, {
      vNF: 50,
      w: W3,
      comprador: 50,
      linha: linhaCodex({ orderStatus: SHOPEE_ORDER_STATUS.shipped }),
    });
    expect(cura.pernasRetiradas).toBe(1);
    expect(cura.somaPagante).toBe(50);
    expect(cura.divergenciaDeSoma).toBe(0);
  });
});

/* ========================================================================== */
/*  20 · `liquidacao` — a máscara disjunta                                    */
/* ========================================================================== */

describe('salvarPagamentosShopee — a máscara da varredura de liquidação', () => {
  it('20. ⚠️ o caminho da tarefa NUNCA nomeia `liquidacao`, nem para reescrever igual', async () => {
    const db = new FakeDb();
    semearPedido(db);
    const liquidacao = {
      payoutAmount: 30.7,
      escrowReleaseTimeUs: 1_789_000_000_000_000,
      liquidadoEmUs: 1_789_100_000_000_000,
      fonte: 'escrow_list',
    };
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 31.99,
      forma_de_pagamento: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      parcelas: 1,
      aVista: true,
      tarifas: 9.99,
      dataAprovacao: microsDeSegundosShopee(PAY_TIME_S),
      dataCadastro: AGORA_US,
      liquidacao,
    });

    // Uma entrega que MUDA a tarifa: o patch existe, e ainda assim não pode
    // nomear `liquidacao` — as duas escritoras possuem máscaras disjuntas.
    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    expect(r.acao).toBe('atualizado');
    expect(db.patches).toHaveLength(1);
    expect(Object.keys(db.patches[0]!.patch)).not.toContain('liquidacao');
    expect(doc(db, PRIMARIO).liquidacao).toEqual(liquidacao);
    expect(doc(db, PRIMARIO).tarifas).toBe(1.29);
  });
});

/* ========================================================================== */
/*  21 · o pagamento que o operador apagou                                    */
/* ========================================================================== */

describe('salvarPagamentosShopee — recriação', () => {
  it('21. um pagamento apagado à mão volta na entrega seguinte (criado + pedidoJaExistia)', async () => {
    const db = new FakeDb();
    semearPedido(db);
    await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });
    delete db.store[`${PAGAMENTOS_PATH}/${PRIMARIO}`];

    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    expect(r.acao).toBe('criado');
    // ⚠️ É esta dupla que torna a recriação greppável: o pedido já existia, logo
    // não é uma primeira importação.
    expect(r.pedidoJaExistia).toBe(true);
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([PRIMARIO]);
  });

  it('21b. ⚠️ quando a MESMA entrega cria um doc e atualiza outro, a ação é `atualizado`', async () => {
    // ⚠️ O par de rótulos só se separa aqui, e a direção importa: `criado` é a
    // resposta enxuta ("apareceu um pagamento novo"), `atualizado` é a que diz
    // que algo que JÁ existia mudou — e é essa que um operador precisa ver,
    // porque é a que pode mexer em Σ pagante de um pedido já conferido.
    const db = new FakeDb();
    semearPedido(db);
    const linha = linhaCombinadaBR();
    // 1ª entrega SEM escrow ⇒ o primário nasce com `tarifas: null`.
    await salvar(db, { linha, mapeados: mapear({ linha }) });
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
    expect(doc(db, PRIMARIO).tarifas).toBeNull();

    // O operador apaga o secundário…
    delete db.store[`${PAGAMENTOS_PATH}/${SECUNDARIO}`];

    // …e a entrega seguinte traz o escrow: recria UM e atualiza o OUTRO.
    const r = await salvar(db, { linha, mapeados: mapear({ linha, escrow: escrowSG() }) });

    expect(r.criados).toBe(1);
    expect(r.atualizados).toBe(1);
    expect(r.acao).toBe('atualizado');
    expect(doc(db, PRIMARIO).tarifas).toBe(1.29);
    expect(db.idsEm(PAGAMENTOS_PATH)).toHaveLength(2);
  });
});

/* ========================================================================== */
/*  22–24 · concorrência — o OccEngine de verdade                             */
/* ========================================================================== */

describe('salvarPagamentosShopee — corridas', () => {
  it('22. duas tarefas concorrentes: UM abort, UM documento, ZERO `set`', async () => {
    const db = new FakeDb();
    semearPedido(db);
    const portao = deferred();
    let segurou = false;
    // ⚠️ A corrida é identificada pelo que a tentativa VAI escrever, nunca pelo
    // `ctx.label` — o rótulo segue a ordem de abertura, que é um artefato de
    // qual cadeia de await chegou primeiro (o próprio header do engine diz).
    db.occ.beforeCommit = (ctx) => {
      if (ctx.writes.length === 0 || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };

    const runA = salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });
    const runB = salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    await Promise.race([runA, runB]);
    portao.resolve();
    const [a, b] = await Promise.all([runA, runB]);

    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(db.occ.txLog.filter((e) => e.phase === 'commit')).toHaveLength(2);
    expect(db.idsEm(PAGAMENTOS_PATH)).toEqual([PRIMARIO]);
    expect(db.opLog.filter((o) => o.op === 'set')).toEqual([]);
    // O perdedor reabre, encontra o documento do vencedor e não acha mudança
    // nenhuma — o patch sai VAZIO e nada é gravado duas vezes.
    expect([a.acao, b.acao].sort()).toEqual(['criado', 'ignorado-sem-mudanca']);
    expect(db.writes.map((w) => w.path)).toEqual([`${PAGAMENTOS_PATH}/${PRIMARIO}`]);
  });

  it('23. a varredura escrevendo `liquidacao` e a tarefa escrevendo `tarifas`: as DUAS pousam', async () => {
    const db = new FakeDb();
    semearPedido(db);
    db.seed(`${PAGAMENTOS_PATH}/${PRIMARIO}`, {
      id: ORDER_SN,
      valor: 31.99,
      forma_de_pagamento: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      parcelas: 1,
      aVista: true,
      tarifas: 9.99,
      dataAprovacao: microsDeSegundosShopee(PAY_TIME_S),
      dataCadastro: AGORA_US,
    });
    const liquidacao = { payoutAmount: 30.7, fonte: 'escrow_list' };

    const portao = deferred();
    let segurou = false;
    db.occ.beforeCommit = (ctx) => {
      const ehATarefa = ctx.writes.some((w) => 'tarifas' in w.data);
      if (!ehATarefa || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };

    // A "varredura": um escritor concorrente que toca SÓ o campo dela.
    const varredura = db.runTransaction(async (tx) => {
      const ref = pagamentoCollection.docRef(asDb(db), { pedidoId: PEDIDO_ID }, PRIMARIO);
      await tx.get(ref as unknown as { path: string; get: () => Promise<unknown> });
      tx.update(ref, { liquidacao });
    });
    const tarefa = salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    await Promise.race([varredura, tarefa]);
    portao.resolve();
    await Promise.all([varredura, tarefa]);

    // Uma delas aborta e refaz — e as duas metades ficam de pé, porque as
    // máscaras são disjuntas em chaves de PRIMEIRO nível.
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(doc(db, PRIMARIO).liquidacao).toEqual(liquidacao);
    expect(doc(db, PRIMARIO).tarifas).toBe(1.29);
    expect(db.opLog.filter((o) => o.op === 'set')).toEqual([]);
  });

  it('24. o pedido é APAGADO entre as duas transações ⇒ ignorado-sem-pedido', async () => {
    const db = new FakeDb();
    semearPedido(db);
    delete db.store[PEDIDO_PATH];
    const r = await salvar(db);
    expect(r.acao).toBe('ignorado-sem-pedido');
    expect(db.writes).toEqual([]);
  });
});
