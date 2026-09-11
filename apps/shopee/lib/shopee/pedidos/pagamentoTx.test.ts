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
 *     to equal the pedido's `valorCobrado` to the centavo or the NF-e refuses to
 *     emit (cStat 865/866, and `canalDevolveTroco` is false on a marketplace).
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
/** O irmão LEGADO do piso de cupom — nunca nosso, nunca tocado. */
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
 * `degradado` exige `nossos >= 2`, então num pedido de perna única ele é
 * sempre `false` e o grupo DADOS realmente roda.
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
    valorCobrado?: number | null;
    watermarkUs?: number;
    nowUs?: number;
  } = {},
): PagamentosMapeadosShopee {
  return mapearPagamentosShopee({
    linha: args.linha ?? linhaSG(),
    escrow: args.escrow ?? null,
    valorCobrado: args.valorCobrado === undefined ? 31.99 : args.valorCobrado,
    watermarkUs: args.watermarkUs ?? WATERMARK_US,
    nowUs: args.nowUs ?? AGORA_US,
    contaId: CONTA,
    orderSn: ORDER_SN,
  });
}

/** O pedido que a transação relê — a metade do guard que mora fora daqui. */
function semearPedido(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(PEDIDO_PATH, {
    numero: ORDER_SN,
    valorCobrado: 31.99,
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

  it('19. ⚠️ o irmão LEGADO `-desconto` não é nosso: nem lido como nosso, nem escrito', async () => {
    const db = new FakeDb();
    semearPedido(db, { valorCobrado: 41.99 });
    db.seed(`${PAGAMENTOS_PATH}/${DESCONTO}`, {
      id: `${ORDER_SN}-desconto`,
      valor: 10,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    const r = await salvar(db, { mapeados: mapear({ escrow: escrowSG() }) });

    expect(r.acao).toBe('criado');
    expect(db.patches.map((p) => p.path)).toEqual([]);
    expect(db.store[`${PAGAMENTOS_PATH}/${DESCONTO}`]!.data.valor).toBe(10);
    // …mas ele CONTA na Σ, porque é exatamente o que a NF-e soma.
    expect(r.somaPagante).toBe(41.99);
    expect(r.divergenciaDeSoma).toBe(0);
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
