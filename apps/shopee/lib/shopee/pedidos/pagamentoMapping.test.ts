/**
 * The pure pagamento mapper (#1514, step 6, plan W1–W9).
 *
 * ⚠️ **Every fold in this module is tested in BOTH directions** — a pair that
 * must come out EQUAL and a near-miss that must stay DISTINCT — because a test
 * that a fold APPLIES cannot show where it STOPS, and that gap is silent (#1372:
 * a row diff folded `value_name` to a number, `'90,5'` became `'90,50'`, real
 * edits read as "no change" and reached neither the marketplace nor Firestore,
 * behind a 200, with eight green mutation tests).
 *
 * ⚠️ **No real credential, shop or buyer datum appears here.** The SG bodies are
 * the already-redacted `__wire__` corpus; every inline vector uses the canonical
 * fake CNPJ `11222333000181` (`00000000000000` is DV-invalid by design and
 * cannot exercise the card path at all) and invented authorization codes. The
 * last suite is a console spy that asserts none of it leaks into a log line.
 */
import { coerceToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import {
  BANDEIRA,
  FORMA_PAGAMENTO,
  MARKETPLACE_PEDIDO_TIPO,
  STATUS_PAGAMENTO,
  type StatusPagamento,
} from '@delfrance/schemas';
import {
  shopeeEscrowDetailPayloadSchema,
  shopeeOrderDetailRowSchema,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
  lerEscrowDetalhe,
  lerPedidoDetalhe,
} from '../fixtures/wireCorpus';
import { makePagamentoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { SHOPEE_ORDER_STATUS } from './orderStatusMaps';
import {
  ALVO_STATUS_PAGAMENTO_SHOPEE,
  COMPOSICAO_TARIFAS,
  COMPOSICAO_TARIFAS_SHOPEE,
  MAX_PAGAMENTOS_COMBINADOS_SHOPEE,
  MOTIVO_COLAPSO_SHOPEE,
  MOTIVO_FORMA_SHOPEE,
  MOTIVO_STATUS_PAGAMENTO_SHOPEE,
  bandeiraDeCardBrand,
  cnpjDoProcessador,
  diarioMarketplaceDeEscrow,
  esquecerLogsDePagamentoShopee,
  formaPagamentoDeShopee,
  mapearPagamentosShopee,
  parcelasDeShopee,
  statusPagamentoAplicavel,
  statusPagamentoDeOrderStatus,
  tarifasDeShopee,
} from './pagamentoMapping';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
/** O pedido do sandbox SG, já nos corpos `__wire__` comprometidos. */
const ORDER_SN = '260910KJBHUJDM';
/** `pay_time` do corpo SG — segundos. */
const PAY_TIME_S = 1_788_973_353;
/** `update_time` do corpo SG, convertido UMA vez. */
const WATERMARK_US = microsDeSegundosShopee(1_788_973_354);
const AGORA_US = 1_700_000_000_000_000;
/** CNPJ FICTÍCIO canônico do repo. `00000000000000` é DV-inválido de propósito. */
const CNPJ_FALSO = '11222333000181';
/** CPF de teste clássico (DV válido) — tem de ser RECUSADO como cnpj_instituicao. */
const CPF_VALIDO = '52998224725';

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  esquecerLogsDePagamentoShopee();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function linhaSG(qual = FIXTURE_ORDER_DETAIL_QTY2_SG): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(qual).response.order_list[0]!;
}
function escrowSG(): ShopeeEscrowDetail {
  return lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
}

function mapear(
  args: Partial<Parameters<typeof mapearPagamentosShopee>[0]> & {
    linha: ShopeeOrderDetailRow;
  },
) {
  return mapearPagamentosShopee({
    escrow: null,
    valorCobrado: 31.99,
    watermarkUs: WATERMARK_US,
    nowUs: AGORA_US,
    contaId: CONTA,
    orderSn: ORDER_SN,
    ...args,
  });
}

/** Um escrow sintético, SEMPRE pelo schema do pacote — nunca um literal com cast. */
function escrowSintetico(orderIncome: Record<string, unknown>): ShopeeEscrowDetail {
  return shopeeEscrowDetailPayloadSchema.parse({
    order_sn: ORDER_SN,
    order_income: orderIncome,
  });
}

/**
 * O vetor BR de PAGAMENTO COMBINADO, inline e pelo schema do pacote.
 *
 * ⚠️ Inline e não em `__wire__`: o placeholder de redação (`00000000000000`) é
 * DV-inválido por construção, então um corpo redigido NÃO consegue exercer o
 * caminho do cartão. O CNPJ aqui é o fictício canônico do repo.
 */
function linhaCombinadaBR(
  overrides: {
    valorPix?: number;
    registroCartao?: string;
    orderStatus?: string;
    paymentInfo?: unknown;
    invertido?: boolean;
  } = {},
): ShopeeOrderDetailRow {
  const pix = {
    payment_method: 'pix',
    payment_amount: overrides.valorPix ?? 10,
    card_brand: '',
    transaction_id: 'AUT-PIX',
    payment_processor_register: CNPJ_FALSO,
  };
  const cartao = {
    payment_method: 'credit_card',
    payment_amount: 21.99,
    card_brand: 'visa',
    transaction_id: 'AUT-CC',
    payment_processor_register: overrides.registroCartao ?? CNPJ_FALSO,
  };
  const lista = overrides.invertido === true ? [cartao, pix] : [pix, cartao];
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: overrides.orderStatus ?? SHOPEE_ORDER_STATUS.readyToShip,
    region: 'BR',
    pay_time: PAY_TIME_S,
    total_amount: 31.99,
    payment_method: 'Combined Payment',
    payment_info: 'paymentInfo' in overrides ? overrides.paymentInfo : lista,
  });
}

/** Tudo o que qualquer spy de console viu, como uma string só. */
function tudoQueFoiLogado(): string {
  return [...infoSpy.mock.calls, ...warnSpy.mock.calls]
    .map((args: unknown[]) =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    )
    .join('\n');
}

/* ========================================================================== */
/*  1–9 · o pedido de sandbox SG                                              */
/* ========================================================================== */

describe('mapearPagamentosShopee — o pedido de sandbox SG', () => {
  it('1. dá UM doc, e a chave `cartao` fica AUSENTE (undefined, nunca null)', () => {
    const { docs } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.docId).toBe(makePagamentoIdShopee(CONTA, ORDER_SN));
    expect(doc.indice).toBe(0);
    expect(doc.sufixo).toBeUndefined();
    expect(doc.preencherUmaVez.id).toBe(ORDER_SN);
    expect(doc.preencherUmaVez.dataCadastro).toBe(AGORA_US);
    // ⚠️ AUSENTE, não `null`. Um `null` aqui destruiria o bloco que o PIX precisa
    // (cStat 391) num pedido que ainda não emitiu — o corpo SG manda
    // `payment_info: null` com a CHAVE presente, que é "não aprendemos".
    expect(doc.dados.cartao).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(doc.dados, 'cartao')).toBe(true);
  });

  it('2. "Apple Pay" dobra para carteira digital (18) e NÃO escreve descricaoPagamento', () => {
    const { docs, diagnosticos } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    expect(docs[0]!.dados.forma_de_pagamento).toBe(
      FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
    );
    expect(docs[0]!.dados.descricaoPagamento).toBeNull();
    expect(diagnosticos.formaMotivo).toBe(MOTIVO_FORMA_SHOPEE.carteira);
  });

  it('3. `instalment_plan: "N/A"` é SENTINELA ⇒ parcelas 1 e aVista true', () => {
    const { docs } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    expect(escrowSG().order_income!.instalment_plan).toBe('N/A');
    expect(docs[0]!.dados.parcelas).toBe(1);
    expect(docs[0]!.dados.aVista).toBe(true);
  });

  it('4. `valor` é o valorCobrado do PEDIDO (31,99) — nunca o escrow_amount (30,70)', () => {
    const escrow = escrowSG();
    const { docs } = mapear({ linha: linhaSG(), escrow, valorCobrado: 31.99 });
    expect(docs[0]!.dados.valor).toBe(31.99);
    // ⛔ MUTANTE 3: ler `escrow_amount` daria 30,70 — 1,29 a MENOS que a nota,
    // e num marketplace isso é cStat 865 e nenhuma emissão.
    expect(escrow.order_income!.escrow_amount).toBe(30.7);
    expect(docs[0]!.dados.valor).not.toBe(escrow.order_income!.escrow_amount);
  });

  it('5. tarifas = 1,29 sob AS DUAS composições, com o bruto no diário', () => {
    const escrow = escrowSG();
    for (const composicao of [COMPOSICAO_TARIFAS.taxasNomeadas, COMPOSICAO_TARIFAS.spreadEscrow]) {
      const { docs, diagnosticos } = mapear({
        linha: linhaSG(),
        escrow,
        composicaoTarifas: composicao,
      });
      expect(docs[0]!.sempre.tarifas).toBe(1.29);
      expect(diagnosticos.tarifasBrutas).toBe(1.29);
      expect(diagnosticos.composicaoTarifas).toBe(composicao);
      expect(docs[0]!.sempre.marketplace!.tarifasBrutas).toBe(1.29);
    }
    // …e é exatamente por isso que o corpo SG NÃO decide a pergunta: as duas
    // composições respondem o mesmo número. A resposta vem de um pedido BR real.
    expect(COMPOSICAO_TARIFAS_SHOPEE).toBe(COMPOSICAO_TARIFAS.taxasNomeadas);
  });

  it('6. o diário `marketplace` usa o relógio da ORDEM (watermark), nunca o nowUs', () => {
    const { docs } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    const diario = docs[0]!.sempre.marketplace!;
    expect(diario.tipo).toBe(MARKETPLACE_PEDIDO_TIPO.shopee);
    expect(diario.orderSn).toBe(ORDER_SN);
    expect(diario.buyerTotalAmount).toBe(31.99);
    expect(diario.escrowAmount).toBe(30.7);
    expect(diario.escrowAmountAfterAdjustment).toBe(30.7);
    expect(diario.taxas!.comissao).toBe(0.65);
    expect(diario.taxas!.transacaoVendedor).toBe(0.64);
    // ⛔ MUTANTE 16: `atualizadoEm = nowUs` faria TODA reentrega escrever, e
    // `onPagamentoChanged` viraria uma linha de histórico por push.
    expect(diario.atualizadoEm).toBe(WATERMARK_US);
    expect(diario.atualizadoEm).not.toBe(AGORA_US);
  });

  it('7. os DOIS corpos SG (READY_TO_SHIP e PROCESSED) miram `aprovado`', () => {
    for (const fixture of [FIXTURE_ORDER_DETAIL_QTY2_SG, FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED]) {
      const { docs } = mapear({ linha: linhaSG(fixture), escrow: escrowSG() });
      expect(docs[0]!.sempre.alvoStatus).toEqual({
        tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status,
        status: STATUS_PAGAMENTO.aprovado,
      });
    }
  });

  it('8. dataAprovacao = microsDeSegundosShopee(pay_time)', () => {
    const { docs } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    expect(linhaSG().pay_time).toBe(PAY_TIME_S);
    expect(docs[0]!.datas.dataAprovacao).toBe(microsDeSegundosShopee(PAY_TIME_S));
    expect(docs[0]!.datas.dataAprovacao).toBe(1_788_973_353_000_000);
  });

  it('9. ⛔ NEAR-MISS: `coerceToMicros(pay_time)` responde 1970 e é 1000× MENOR', () => {
    // A armadilha, fixada contra o próprio `coerceToMicros`: ele classifica por
    // MAGNITUDE, então 1,79e9 é lido como MILISSEGUNDOS. Não lança, não devolve
    // null — devolve um número errado por três ordens de grandeza.
    const errado = coerceToMicros(PAY_TIME_S);
    expect(errado).toBe(1_788_973_353_000);
    // ⚠️ Ele nem lança nem devolve `null` — devolve um NÚMERO, só que errado
    // por três ordens de grandeza, que é exatamente por que nada falha.
    expect(errado).not.toBeNull();
    const certo = microsDeSegundosShopee(PAY_TIME_S);
    expect(certo).toBe(errado! * 1000);
    expect(new Date(errado! / 1000).getUTCFullYear()).toBe(1970);
    const { docs } = mapear({ linha: linhaSG(), escrow: escrowSG() });
    expect(docs[0]!.datas.dataAprovacao).toBe(certo);
    expect(docs[0]!.datas.dataAprovacao).not.toBe(errado!);
  });

  it('10. escrow AUSENTE: nada de tarifas, nada de diário, parcelas 1, valor intacto', () => {
    const { docs, diagnosticos } = mapear({ linha: linhaSG(), escrow: null });
    // ⛔ MUTANTE 6: `null` em vez de `undefined` APAGARIA uma tarifa já aprendida.
    expect(docs[0]!.sempre.tarifas).toBeUndefined();
    expect(docs[0]!.sempre.marketplace).toBeUndefined();
    expect(docs[0]!.dados.parcelas).toBe(1);
    expect(docs[0]!.dados.valor).toBe(31.99);
    expect(diagnosticos.escrowAusente).toBe(true);
    expect(diagnosticos.tarifasBrutas).toBeNull();
  });

  it('11. sem `payment_method` na linha, a forma cai para o `buyer_payment_method` do escrow', () => {
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      pay_time: PAY_TIME_S,
      // ⚠️ `''` é o zero-fill da Shopee para string ausente, não uma forma vazia.
      payment_method: '',
    });
    const escrow = escrowSintetico({ buyer_payment_method: 'Pix' });
    const { docs } = mapear({ linha, escrow });
    expect(docs[0]!.dados.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
  });
});

/* ========================================================================== */
/*  12–20 · o vetor BR de pagamento combinado                                 */
/* ========================================================================== */

describe('mapearPagamentosShopee — pagamento combinado BR', () => {
  it('12. duas pernas que somam 31,99 viram DOIS docs, e o CARTÃO é o primário', () => {
    const { docs, diagnosticos } = mapear({ linha: linhaCombinadaBR() });
    expect(docs).toHaveLength(2);
    expect(diagnosticos.combinado).toBe(true);
    expect(diagnosticos.motivoColapso).toBeNull();
    expect(diagnosticos.somaPaymentInfo).toBe(31.99);
    expect(diagnosticos.deltaDaSoma).toBe(0);

    // A ordem é por CONTEÚDO: `credit_card` < `pix`, então o cartão é o índice 0.
    const [primario, secundario] = docs;
    expect(primario!.dados.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect(primario!.preencherUmaVez.id).toBe(ORDER_SN);
    expect(primario!.docId).toBe(makePagamentoIdShopee(CONTA, ORDER_SN));
    expect(primario!.dados.valor).toBe(21.99);

    expect(secundario!.dados.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    expect(secundario!.preencherUmaVez.id).toBe(`${ORDER_SN}-1`);
    expect(secundario!.docId).toBe(makePagamentoIdShopee(CONTA, ORDER_SN, '-1'));
    expect(secundario!.dados.valor).toBe(10);

    // A identidade fiscal: Σ = valorCobrado, ao centavo.
    expect(roundReais(primario!.dados.valor + secundario!.dados.valor)).toBe(31.99);
  });

  it('13. o `cartao` do leg de crédito sai completo', () => {
    const { docs } = mapear({ linha: linhaCombinadaBR() });
    expect(docs[0]!.dados.cartao).toEqual({
      tpIntegra: '2',
      bandeira: BANDEIRA.visa,
      numeroCartao: null,
      cAut: 'AUT-CC',
      cnpj_instituicao: CNPJ_FALSO,
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
    });
  });

  it('14. o leg PIX também ganha `cartao`, com bandeira null — `""` não é "outros"', () => {
    const { docs } = mapear({ linha: linhaCombinadaBR() });
    const pix = docs[1]!;
    // ⚠️ O PIX PRECISA do bloco (cStat 391); o que ele não tem é BANDEIRA.
    expect(pix.dados.cartao!.bandeira).toBeNull();
    expect(pix.dados.cartao!.cnpj_instituicao).toBe(CNPJ_FALSO);
    expect(pix.dados.cartao!.cAut).toBe('AUT-PIX');
    expect(pix.dados.cartao!.tpIntegra).toBe('2');
  });

  it('15. o parcelamento vai só para o leg de CRÉDITO; tarifas só para o PRIMÁRIO', () => {
    const escrow = escrowSintetico({
      instalment_plan: '3',
      commission_fee: 1,
      service_fee: 0.5,
      seller_transaction_fee: 0.25,
    });
    const { docs } = mapear({ linha: linhaCombinadaBR(), escrow });
    expect(docs[0]!.dados.parcelas).toBe(3);
    expect(docs[0]!.dados.aVista).toBe(false);
    expect(docs[1]!.dados.parcelas).toBe(1);
    expect(docs[1]!.dados.aVista).toBe(true);
    // ⛔ MUTANTE 31: repetir a tarifa em cada doc cobraria a comissão N vezes.
    expect(docs[0]!.sempre.tarifas).toBe(1.75);
    expect(docs[1]!.sempre.tarifas).toBe(0);
    expect(docs[1]!.sempre.marketplace).toBeUndefined();
  });

  it('16. a ORDEM DO FIO não muda nada — o conjunto de docs é idêntico invertido', () => {
    // ⚠️ Shopee não documenta ordem nenhuma para `payment_info`. Se o fio
    // decidisse quem é o primário, a mesma ordem relida moveria dinheiro entre
    // dois documentos que já existem.
    const direto = mapear({ linha: linhaCombinadaBR() }).docs;
    const invertido = mapear({ linha: linhaCombinadaBR({ invertido: true }) }).docs;
    expect(invertido).toEqual(direto);
  });

  it('16b. ⚠️ NEAR-MISS: sem o SEPARADOR da chave, o primário troca de perna', () => {
    // ⚠️ O mesmo defeito que `chaveDaLinhaShopee` fixa uma coleção acima:
    // `("pix","TX1")` e `("pi","xTX1")` concatenam na MESMA string. Com o NUL a
    // ordem é uma; sem ele é a OUTRA — e o primário é quem fica com o `id` igual
    // ao `order_sn` e, numa entrega degradada seguinte, com o `valor` inteiro.
    // Um teste que só somasse 31,99 passaria nas duas ordens.
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      region: 'BR',
      pay_time: PAY_TIME_S,
      payment_method: 'Combined Payment',
      payment_info: [
        { payment_method: 'pix', payment_amount: 10, transaction_id: 'TX1' },
        { payment_method: 'pi', payment_amount: 21.99, transaction_id: 'xTX1' },
      ],
    });
    const { docs, diagnosticos } = mapear({ linha });
    expect(diagnosticos.combinado).toBe(true);
    expect(docs).toHaveLength(2);
    // Com o separador: `pi` < `pix`, então a perna de 21,99 é a PRIMÁRIA.
    expect(docs[0]!.preencherUmaVez.id).toBe(ORDER_SN);
    expect(docs[0]!.dados.valor).toBe(21.99);
    expect(docs[1]!.dados.valor).toBe(10);
    // Sem ele as duas chaves viram `pixTX1…` e a de 10 assumiria o primário.
    expect(docs[0]!.dados.valor).not.toBe(10);
  });

  it('17. soma divergente (pix 9,99) COLAPSA para um doc e avisa UMA vez', () => {
    const { docs, diagnosticos } = mapear({ linha: linhaCombinadaBR({ valorPix: 9.99 }) });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.dados.valor).toBe(31.99);
    // A forma cai para a da ORDEM ("Combined Payment") ⇒ 99 + xPag.
    expect(docs[0]!.dados.forma_de_pagamento).toBe(FORMA_PAGAMENTO.outros);
    expect(docs[0]!.dados.descricaoPagamento).toBe('Shopee: Combined Payment');
    expect(diagnosticos.combinado).toBe(false);
    expect(diagnosticos.motivoColapso).toBe(MOTIVO_COLAPSO_SHOPEE.somaDivergente);
    expect(diagnosticos.somaPaymentInfo).toBe(31.98);
    expect(diagnosticos.deltaDaSoma).toBe(-0.01);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({
      orderSn: ORDER_SN,
      motivo: MOTIVO_COLAPSO_SHOPEE.somaDivergente,
      entradas: 2,
      soma: 31.98,
      valorCobrado: 31.99,
      delta: -0.01,
    });
  });

  it('18. mais de MAX legs COLAPSA com `excede-maximo`', () => {
    const legs = Array.from({ length: MAX_PAGAMENTOS_COMBINADOS_SHOPEE + 1 }, (_, i) => ({
      payment_method: 'pix',
      payment_amount: 1,
      transaction_id: `AUT-${i}`,
    }));
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      region: 'BR',
      pay_time: PAY_TIME_S,
      payment_method: 'Combined Payment',
      payment_info: legs,
    });
    const { docs, diagnosticos } = mapear({ linha, valorCobrado: 9 });
    expect(docs).toHaveLength(1);
    expect(diagnosticos.motivoColapso).toBe(MOTIVO_COLAPSO_SHOPEE.excedeMaximo);
    expect(diagnosticos.entradasPaymentInfo).toBe(MAX_PAGAMENTOS_COMBINADOS_SHOPEE + 1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('19. um CNPJ MASCARADO vira null, e nem ele nem o cAut chegam a um log', () => {
    const { docs } = mapear({ linha: linhaCombinadaBR({ registroCartao: '***.***.333/0001-**' }) });
    expect(docs[0]!.dados.cartao!.cnpj_instituicao).toBeNull();
    // O resto do bloco sobrevive — só o documento é que foi recusado.
    expect(docs[0]!.dados.cartao!.bandeira).toBe(BANDEIRA.visa);
    const logado = tudoQueFoiLogado();
    expect(logado).not.toMatch(/\d{14}/);
    expect(logado).not.toContain('***');
    expect(logado).not.toContain('AUT-');
  });

  it('20. `00000000000000` (DV inválido) e um CPF VÁLIDO são os dois recusados', () => {
    const zeros = mapear({ linha: linhaCombinadaBR({ registroCartao: '00000000000000' }) });
    expect(zeros.docs[0]!.dados.cartao!.cnpj_instituicao).toBeNull();
    expect(zeros.diagnosticos.cnpjProcessadorRecusado).toBe(true);

    // ⛔ MUTANTE 26: sem o `length === 14`, um CPF seria gravado como o CNPJ da
    // instituição de pagamento e emitido para a SEFAZ como tal.
    const cpf = mapear({ linha: linhaCombinadaBR({ registroCartao: CPF_VALIDO }) });
    expect(cpf.docs[0]!.dados.cartao!.cnpj_instituicao).toBeNull();
    expect(cpf.diagnosticos.cnpjProcessadorRecusado).toBe(true);

    // …e um CNPJ bom continua passando, senão o teste acima seria vácuo.
    const bom = mapear({ linha: linhaCombinadaBR() });
    expect(bom.docs[0]!.dados.cartao!.cnpj_instituicao).toBe(CNPJ_FALSO);
    expect(bom.diagnosticos.cnpjProcessadorRecusado).toBe(false);
  });

  it('21. o MESMO pedido em SHIPPED sem `payment_info` volta a UM doc, `cartao` ausente', () => {
    // ⚠️ É o caso que a transação tem de tratar como ENTREGA DEGRADADA: a
    // Shopee para de mandar `payment_info` depois de READY_TO_SHIP.
    const linha = linhaCombinadaBR({
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
      paymentInfo: null,
    });
    const { docs, diagnosticos } = mapear({ linha });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.dados.valor).toBe(31.99);
    expect(docs[0]!.dados.cartao).toBeUndefined();
    expect(diagnosticos.entradasPaymentInfo).toBe(0);
    // Um pedido BR já despachado sem payment_info é o achado instrumentado.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toEqual({
      orderSn: ORDER_SN,
      orderStatus: SHOPEE_ORDER_STATUS.shipped,
    });
  });

  it('22. uma perna com `payment_amount: 0` é ABSENTE, não uma perna de zero reais', () => {
    // O zero-fill da Shopee de novo: duas pernas declaradas, uma utilizável.
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      region: 'BR',
      pay_time: PAY_TIME_S,
      payment_method: 'Credit Card',
      payment_info: [
        { payment_method: 'credit_card', payment_amount: 31.99, transaction_id: 'AUT-CC' },
        { payment_method: 'pix', payment_amount: 0, transaction_id: 'AUT-ZERO' },
      ],
    });
    const { docs, diagnosticos } = mapear({ linha });
    expect(diagnosticos.entradasPaymentInfo).toBe(1);
    expect(diagnosticos.combinado).toBe(false);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.dados.valor).toBe(31.99);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  23–28 · tarifasDeShopee / diarioMarketplaceDeEscrow                        */
/* ========================================================================== */

describe('tarifasDeShopee', () => {
  it('23. ⛔ o vetor sintético que MATA a troca pelo `credit_card_transaction_fee`', () => {
    // No corpo SG `credit_card_transaction_fee === seller_transaction_fee === 0,64`
    // (porque `buyer_transaction_fee` é 0), então aquele corpo NÃO distingue os
    // dois campos. Aqui eles diferem.
    const escrow = escrowSintetico({
      commission_fee: 0.65,
      service_fee: 0,
      seller_transaction_fee: 0.64,
      buyer_transaction_fee: 0.1,
      credit_card_transaction_fee: 0.74,
    });
    const { tarifas, bruto } = tarifasDeShopee(escrow, COMPOSICAO_TARIFAS.taxasNomeadas);
    expect(tarifas).toBe(1.29);
    expect(bruto).toBe(1.29);
    // O mutante somaria o rollup: 0,65 + 0 + 0,74 = 1,39.
    expect(tarifas).not.toBe(1.39);
  });

  it('24. ⛔ o clamp em 0 é OBRIGATÓRIO — `final_shipping_fee: -10` sob o spread', () => {
    // A Shopee credita o vendedor: o escrow liberado passa do que o comprador
    // pagou, e o spread fica NEGATIVO. `pagamentoSchema.tarifas` é `.min(0)`, e
    // um negativo cru é um ZodError que o pipeline lê como transitório (#794).
    const escrow = escrowSintetico({
      buyer_total_amount: 31.99,
      escrow_amount: 41.99,
      escrow_amount_after_adjustment: 41.99,
      final_shipping_fee: -10,
    });
    const { tarifas, bruto } = tarifasDeShopee(escrow, COMPOSICAO_TARIFAS.spreadEscrow);
    expect(tarifas).toBe(0);
    // …e o valor cru NÃO se perde: ele fica visível como dado no diário.
    expect(bruto).toBe(-10);
    expect(diarioMarketplaceDeEscrow(escrow, COMPOSICAO_TARIFAS.spreadEscrow)!.tarifasBrutas).toBe(
      -10,
    );
  });

  it('25. as variantes BR `net_*` GANHAM das brutas quando chegam', () => {
    const escrow = escrowSintetico({
      commission_fee: 9,
      net_commission_fee: 1,
      service_fee: 9,
      net_service_fee: 2,
      seller_transaction_fee: 0.5,
    });
    const { tarifas, taxas } = tarifasDeShopee(escrow, COMPOSICAO_TARIFAS.taxasNomeadas);
    expect(tarifas).toBe(3.5);
    expect(taxas!.comissao).toBe(1);
    expect(taxas!.servico).toBe(2);
  });

  it('26. uma tarifa de EXATAMENTE 0 é uma tarifa real, não uma ausência', () => {
    // ⚠️ `?? 0`, nunca `positivoOuNull`: uma comissão isenta é 0, e lê-la como
    // ausente faria `tarifas` sair `undefined` e a escrita ser pulada.
    const escrow = escrowSintetico({
      commission_fee: 0,
      service_fee: 0,
      seller_transaction_fee: 0,
    });
    const { tarifas, bruto } = tarifasDeShopee(escrow, COMPOSICAO_TARIFAS.taxasNomeadas);
    expect(tarifas).toBe(0);
    expect(bruto).toBe(0);
    expect(tarifas).not.toBeUndefined();
  });

  it('27. sem `order_income`: os TRÊS campos saem `undefined`, nenhum `null`', () => {
    for (const escrow of [null, shopeeEscrowDetailPayloadSchema.parse({ order_sn: ORDER_SN })]) {
      const r = tarifasDeShopee(escrow, COMPOSICAO_TARIFAS.taxasNomeadas);
      expect(r.tarifas).toBeUndefined();
      expect(r.bruto).toBeUndefined();
      expect(r.taxas).toBeUndefined();
      expect(diarioMarketplaceDeEscrow(escrow)).toBeUndefined();
    }
  });

  it('28. o spread sem um dos lados é DESCONHECIDO, não zero', () => {
    const semTotal = escrowSintetico({ escrow_amount: 30.7 });
    expect(tarifasDeShopee(semTotal, COMPOSICAO_TARIFAS.spreadEscrow).bruto).toBeUndefined();
    const semEscrow = escrowSintetico({ buyer_total_amount: 31.99 });
    expect(tarifasDeShopee(semEscrow, COMPOSICAO_TARIFAS.spreadEscrow).bruto).toBeUndefined();
    // `after_adjustment` é a primeira rampa; `escrow_amount` é a segunda.
    const soAjustado = escrowSintetico({
      buyer_total_amount: 31.99,
      escrow_amount: 20,
      escrow_amount_after_adjustment: 30.7,
    });
    expect(tarifasDeShopee(soAjustado, COMPOSICAO_TARIFAS.spreadEscrow).bruto).toBe(1.29);
  });
});

/* ========================================================================== */
/*  29–32 · o ESCOPO do fold de forma                                          */
/* ========================================================================== */

describe('formaPagamentoDeShopee — o que o fold trata como IGUAL', () => {
  const pares: ReadonlyArray<readonly [string, readonly string[], number]> = [
    [
      'crédito',
      [
        'Credit Card',
        'credit_card',
        'CREDIT CARD',
        'Cartão de Crédito',
        'cartao de credito',
        'Ebanx Credit Card',
      ],
      FORMA_PAGAMENTO.cartao_credito,
    ],
    ['pix', ['Pix', 'PIX', 'pix', ' pix '], FORMA_PAGAMENTO.pix],
    [
      'boleto',
      ['Boleto Bancário', 'Boleto BancÃ¡rio', 'Ebanx Boleto', 'BOLETO'],
      FORMA_PAGAMENTO.boleto_bancario,
    ],
    ['débito', ['Debit Card', 'debit_card', 'Cartão de Débito'], FORMA_PAGAMENTO.cartao_debito],
    [
      'carteira',
      ['Apple Pay', 'Google Pay', 'Samsung Pay', 'ShopeePay', 'Bank Transfer', 'Carteira digital'],
      FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
    ],
  ];

  it.each(pares)('29. %s: todas as grafias dobram na MESMA forma', (_nome, grafias, esperado) => {
    for (const grafia of grafias) {
      expect(formaPagamentoDeShopee(grafia).forma).toBe(esperado);
    }
  });

  const quaseIguais: ReadonlyArray<readonly [unknown, number, string]> = [
    // ⚠️ TOKEN, nunca substring — senão `Pixel` viraria PIX.
    ['Pixel', FORMA_PAGAMENTO.outros, 'Shopee: Pixel'],
    // `payment` não é `pay`: "Combined Payment" não é uma carteira digital.
    ['Combined Payment', FORMA_PAGAMENTO.outros, 'Shopee: Combined Payment'],
    ['SParcelado', FORMA_PAGAMENTO.outros, 'Shopee: SParcelado'],
    ['Shopee Parcelado', FORMA_PAGAMENTO.outros, 'Shopee: Shopee Parcelado'],
    ['Cash on Delivery', FORMA_PAGAMENTO.outros, 'Shopee: Cash on Delivery'],
    // A ORDEM das regras: uma string com as duas palavras é CRÉDITO.
    ['Credit Card/Debit Card', FORMA_PAGAMENTO.cartao_credito, ''],
    ['Credit Card Installment', FORMA_PAGAMENTO.cartao_credito, ''],
  ];

  it.each(quaseIguais)('30. ⚠️ NEAR-MISS %s fica DISTINTO', (raw, esperado, descricaoEsperada) => {
    const r = formaPagamentoDeShopee(raw);
    expect(r.forma).toBe(esperado);
    if (descricaoEsperada !== '') expect(`Shopee: ${r.bruto}`).toBe(descricaoEsperada);
  });

  it('31. o que NÃO é uma string, e o branco, respondem `ausente` sem descrição', () => {
    for (const raw of [null, undefined, 42, {}, [], '', '   ']) {
      const r = formaPagamentoDeShopee(raw);
      expect(r.forma).toBe(FORMA_PAGAMENTO.outros);
      expect(r.motivo).toBe(MOTIVO_FORMA_SHOPEE.ausente);
      // ⚠️ `bruto` null ⇒ `descricaoPagamento` null. Um `''` daria o literal
      // "Shopee: " como xPag da NF-e, que é o que a SEFAZ receberia.
      expect(r.bruto).toBeNull();
    }
  });

  it('32. UM `console.info` por valor não mapeado DISTINTO, por mais que se repita', () => {
    formaPagamentoDeShopee('Zzz Metodo Lunar');
    formaPagamentoDeShopee('Zzz Metodo Lunar');
    formaPagamentoDeShopee('Zzz Metodo Lunar');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    formaPagamentoDeShopee('Zzz Outro Método');
    expect(infoSpy).toHaveBeenCalledTimes(2);
    // …e um valor MAPEADO nunca loga.
    formaPagamentoDeShopee('Pix');
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });
});

/* ========================================================================== */
/*  33–36 · bandeiraDeCardBrand / cnpjDoProcessador                            */
/* ========================================================================== */

describe('bandeiraDeCardBrand', () => {
  it('33. o nome do MEMBRO do enum, insensível a caixa, mais os dois apelidos', () => {
    expect(bandeiraDeCardBrand('visa').bandeira).toBe(BANDEIRA.visa);
    expect(bandeiraDeCardBrand('VISA').bandeira).toBe(BANDEIRA.visa);
    expect(bandeiraDeCardBrand('Mastercard').bandeira).toBe(BANDEIRA.mastercard);
    expect(bandeiraDeCardBrand('MASTER').bandeira).toBe(BANDEIRA.mastercard);
    expect(bandeiraDeCardBrand('master').bandeira).toBe(BANDEIRA.mastercard);
    expect(bandeiraDeCardBrand('AMEX').bandeira).toBe(BANDEIRA.american_express);
    expect(bandeiraDeCardBrand('elo').bandeira).toBe(BANDEIRA.elo);
  });

  it('34. ⚠️ NEAR-MISS: `""` e branco são NULL (PIX), nunca "outros"', () => {
    for (const raw of ['', '   ', null, undefined, 7]) {
      const r = bandeiraDeCardBrand(raw);
      expect(r.bandeira).toBeNull();
      expect(r.desconhecida).toBe(false);
    }
    expect(bandeiraDeCardBrand('').bandeira).not.toBe(BANDEIRA.outros);
  });

  it('35. uma bandeira desconhecida vira "99", logada UMA vez', () => {
    const r = bandeiraDeCardBrand('nubank');
    expect(r.bandeira).toBe(BANDEIRA.outros);
    expect(r.desconhecida).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    bandeiraDeCardBrand('nubank');
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('36. ⚠️ NEAR-MISS: uma chave do PROTÓTIPO não devolve uma função', () => {
    // Um índice cru em `BANDEIRA` devolveria `Object.prototype.toString`, e o
    // `.catch(null)` de `cartaoSchema.bandeira` engoliria isso como "sem
    // bandeira" — uma bandeira desconhecida relatada como nenhuma.
    for (const raw of ['toString', 'constructor', 'hasOwnProperty']) {
      const r = bandeiraDeCardBrand(raw);
      expect(typeof r.bandeira).toBe('string');
      expect(r.bandeira).toBe(BANDEIRA.outros);
      expect(r.desconhecida).toBe(true);
    }
  });
});

describe('cnpjDoProcessador', () => {
  it('37. só um CNPJ de 14 com DV válido passa', () => {
    expect(cnpjDoProcessador(CNPJ_FALSO)).toBe(CNPJ_FALSO);
    expect(cnpjDoProcessador('11.222.333/0001-81')).toBe(CNPJ_FALSO);
  });

  it('38. ⚠️ NEAR-MISS: mascarado, CPF válido, DV inválido e não-string ⇒ null', () => {
    for (const raw of [
      '***.***.333/0001-**',
      CPF_VALIDO,
      '00000000000000',
      '',
      null,
      11222333000181,
    ]) {
      expect(cnpjDoProcessador(raw)).toBeNull();
    }
  });
});

/* ========================================================================== */
/*  39–41 · parcelasDeShopee                                                   */
/* ========================================================================== */

describe('parcelasDeShopee', () => {
  const casos: ReadonlyArray<readonly [string, unknown, number, boolean]> = [
    ['a SENTINELA "N/A"', 'N/A', 1, false],
    ['"n/a" em caixa baixa', 'n/a', 1, false],
    ['string vazia', '', 1, false],
    ['uma string numérica', '3', 3, false],
    ['"6x"', '6x', 6, false],
    ['"em 10 vezes"', 'em 10 vezes', 10, false],
    ['"999" é limitado em 99', '999', 99, false],
    ['ilegível vira 1 e é sinalizado', 'parcelado', 1, true],
  ];

  it.each(casos)('39. %s', (_nome, plano, esperado, ilegivel) => {
    const r = parcelasDeShopee(escrowSintetico({ instalment_plan: plano }));
    expect(r.parcelas).toBe(esperado);
    expect(r.ilegivel).toBe(ilegivel);
  });

  it('39b. o INT do anúncio 1080 chega pelo `tenure_info_list` e é limitado', () => {
    // ⚠️ `order_income.instalment_plan` é `z.string()` no schema do pacote, então
    // o INT do anúncio só pode chegar pela união do `tenure_info_list`. A união
    // preserva os dois tipos e o fold é ESTE — o pacote não dobra nada.
    const parcelasDe = (plano: unknown) =>
      parcelasDeShopee(escrowSintetico({ tenure_info_list: [{ instalment_plan: plano }] }))
        .parcelas;
    expect(parcelasDe(6)).toBe(6);
    // ⚠️ NEAR-MISS: zero e negativos não são "sem parcelas", são valores fora do
    // intervalo que `pagamentoSchema.parcelas` (`.int().min(1)`) aceita.
    expect(parcelasDe(0)).toBe(1);
    expect(parcelasDe(-3)).toBe(1);
    expect(parcelasDe(200)).toBe(99);
  });

  it('40. sem `instalment_plan`, a rampa é o `tenure_info_list` — as TRÊS formas', () => {
    // Array de UM (o que o corpo SG manda).
    expect(
      parcelasDeShopee(escrowSintetico({ tenure_info_list: [{ instalment_plan: 3 }] })).parcelas,
    ).toBe(3);
    // Objeto singular (o que a PÁGINA documenta).
    expect(
      parcelasDeShopee(escrowSintetico({ tenure_info_list: { instalment_plan: '2' } })).parcelas,
    ).toBe(2);
    // Nada.
    expect(parcelasDeShopee(escrowSintetico({})).parcelas).toBe(1);
    expect(parcelasDeShopee(null).parcelas).toBe(1);
  });

  it('41. ⚠️ NEAR-MISS: DUAS opções de tenure não decidem nada ⇒ 1', () => {
    // A lista não diz qual o comprador escolheu; responder a primeira seria um
    // palpite carimbado num documento fiscal.
    const r = parcelasDeShopee(
      escrowSintetico({ tenure_info_list: [{ instalment_plan: 3 }, { instalment_plan: 6 }] }),
    );
    expect(r.parcelas).toBe(1);
    // …e UMA só volta a decidir, senão o caso acima seria vácuo.
    expect(
      parcelasDeShopee(escrowSintetico({ tenure_info_list: [{ instalment_plan: 6 }] })).parcelas,
    ).toBe(6);
  });
});

/* ========================================================================== */
/*  42–44 · a escada de status                                                 */
/* ========================================================================== */

describe('statusPagamentoDeOrderStatus', () => {
  const tabela: ReadonlyArray<readonly [string, StatusPagamento | null]> = [
    [SHOPEE_ORDER_STATUS.unpaid, null],
    [SHOPEE_ORDER_STATUS.pending, STATUS_PAGAMENTO.em_processo_aprovacao],
    [SHOPEE_ORDER_STATUS.readyToShip, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.processed, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.retryShip, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.shipped, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.toConfirmReceive, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.completed, STATUS_PAGAMENTO.aprovado],
    [SHOPEE_ORDER_STATUS.inCancel, STATUS_PAGAMENTO.em_disputa],
    [SHOPEE_ORDER_STATUS.toReturn, STATUS_PAGAMENTO.em_disputa],
    [SHOPEE_ORDER_STATUS.cancelled, STATUS_PAGAMENTO.estornado],
    ['FOO_BAR', null],
  ];

  it.each(tabela)('42. %s', (orderStatus, esperado) => {
    const alvo = statusPagamentoDeOrderStatus(orderStatus);
    if (esperado === null) {
      expect(alvo).toEqual({ tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.manter });
    } else {
      expect(alvo).toEqual({ tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status, status: esperado });
    }
  });

  it('43. os onze status documentados estão TODOS na tabela acima', () => {
    const cobertos = new Set(tabela.map(([s]) => s));
    for (const status of Object.values(SHOPEE_ORDER_STATUS)) {
      expect(cobertos.has(status)).toBe(true);
    }
  });
});

describe('statusPagamentoAplicavel', () => {
  const S = STATUS_PAGAMENTO;
  const alvo = (status: StatusPagamento) => ({
    tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status as 'status',
    status,
  });

  const celulas: ReadonlyArray<
    readonly [StatusPagamento | null, StatusPagamento, boolean, string]
  > = [
    // armazenado null ⇒ tudo escreve
    [null, S.em_processo_aprovacao, true, ''],
    [null, S.aprovado, true, ''],
    [null, S.estornado, true, ''],
    // a subida normal
    [S.em_processo_aprovacao, S.aprovado, true, ''],
    [S.em_processo_aprovacao, S.em_disputa, true, ''],
    [S.em_processo_aprovacao, S.estornado, true, ''],
    // ⚠️ a REGRESSÃO que a função existe para recusar
    [S.aprovado, S.em_processo_aprovacao, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.regressivo],
    [S.estornado, S.em_processo_aprovacao, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.regressivo],
    [S.em_disputa, S.em_processo_aprovacao, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.regressivo],
    // a disputa é um HOLD, e vai e volta
    [S.aprovado, S.em_disputa, true, ''],
    [S.em_disputa, S.aprovado, true, ''],
    [S.aprovado, S.estornado, true, ''],
    [S.em_disputa, S.estornado, true, ''],
    // a ressurreição, permitida
    [S.estornado, S.aprovado, true, ''],
    // já lá ⇒ nada
    [S.aprovado, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.semMudanca],
    // fora da escada ⇒ nada
    [S.recusado, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
    [S.devolvido, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
    [S.cancelado, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
    [S.pendente, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
    [S.pago_parcialmente, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
    [S.em_revisao, S.aprovado, false, MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada],
  ];

  it.each(celulas)('44. (%s → %s)', (armazenado, destino, escreve, motivo) => {
    const v = statusPagamentoAplicavel(armazenado, alvo(destino));
    expect(v.escrever).toBe(escreve);
    if (!v.escrever) expect(v.motivo).toBe(motivo);
    else expect(v.status).toBe(destino);
  });

  it('45. o alvo `manter` nunca escreve, qualquer que seja o armazenado', () => {
    for (const armazenado of [null, S.aprovado, S.estornado, S.recusado]) {
      const v = statusPagamentoAplicavel(armazenado, { tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.manter });
      expect(v.escrever).toBe(false);
      if (!v.escrever) expect(v.motivo).toBe(MOTIVO_STATUS_PAGAMENTO_SHOPEE.manter);
    }
  });

  it('46. só `estornado → outra coisa` é RESSUSCITADO', () => {
    const ress = statusPagamentoAplicavel(S.estornado, alvo(S.aprovado));
    expect(ress).toEqual({ escrever: true, status: S.aprovado, ressuscitado: true });
    const normal = statusPagamentoAplicavel(S.aprovado, alvo(S.estornado));
    expect(normal).toEqual({ escrever: true, status: S.estornado, ressuscitado: false });
  });
});

/* ========================================================================== */
/*  47–49 · o portão de criação e o não-vazamento                              */
/* ========================================================================== */

describe('o portão de criação (pay_time)', () => {
  function linhaComPayTime(payTime: number | null): ShopeeOrderDetailRow {
    return shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.readyToShip,
      pay_time: payTime,
      payment_method: 'Pix',
    });
  }

  it('47. `pay_time: 0` (zero-fill) e abaixo do piso NÃO criam documento nenhum', () => {
    // ⛔ MUTANTE 13: `pay_time != null` leria o zero-fill como uma data de 1970 e
    // criaria um pagamento aprovado para um pedido que ninguém pagou.
    for (const payTime of [0, null, 1_500_000_000]) {
      const r = mapear({ linha: linhaComPayTime(payTime) });
      expect(r.docs).toEqual([]);
      expect(r.diagnosticos.payTimeUsavel).toBe(false);
    }
  });

  it('48. um `pay_time` acima do piso cria UM documento', () => {
    const r = mapear({ linha: linhaComPayTime(PAY_TIME_S) });
    expect(r.docs).toHaveLength(1);
    expect(r.diagnosticos.payTimeUsavel).toBe(true);
    expect(r.docs[0]!.datas.dataAprovacao).toBe(microsDeSegundosShopee(PAY_TIME_S));
  });

  it('49. ⚠️ o portão governa só a CRIAÇÃO — o alvo de status continua sendo dito', () => {
    // Uma releitura CANCELLED cujo `pay_time` voltou 0 não cria nada, mas o alvo
    // que a transação aplica a um doc que JÁ existe continua vindo daqui.
    const linha = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: SHOPEE_ORDER_STATUS.cancelled,
      pay_time: 0,
    });
    const r = mapear({ linha });
    expect(r.docs).toEqual([]);
    expect(statusPagamentoDeOrderStatus(linha.order_status)).toEqual({
      tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status,
      status: STATUS_PAGAMENTO.estornado,
    });
  });
});

describe('⚠️ nenhum dado sensível chega a um log', () => {
  it('50. nenhuma chamada de console carrega 14 dígitos, um "AUT-" ou um campo do comprador', () => {
    mapear({ linha: linhaSG(), escrow: escrowSG() });
    mapear({ linha: linhaCombinadaBR() });
    mapear({ linha: linhaCombinadaBR({ valorPix: 9.99 }) });
    mapear({ linha: linhaCombinadaBR({ registroCartao: '***.***.333/0001-**' }) });
    mapear({
      linha: linhaCombinadaBR({ orderStatus: SHOPEE_ORDER_STATUS.shipped, paymentInfo: null }),
    });
    mapear({ linha: linhaSG(), escrow: escrowSintetico({ instalment_plan: 'parcelado' }) });

    const logado = tudoQueFoiLogado();
    expect(logado).not.toMatch(/\d{14}/);
    expect(logado).not.toContain('AUT-');
    expect(logado).not.toContain(CNPJ_FALSO);
    expect(logado).not.toContain('buyer_');
    expect(logado).not.toContain('REDACTED');
    // …e o spy VIU algo, senão a asserção acima seria vácua.
    expect(warnSpy.mock.calls.length + infoSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
