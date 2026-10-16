import {
  liPedidoPagamentoSchema,
  liPedidoSchema,
  type PedidoLi,
  type PedidoPagamentoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  pagamentoSchema,
  type StatusPagamento,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { dataLiParaMicros } from './dataLi';
import {
  MODO_HISTORICO_LI,
  decidirEstadoLi,
  lerHistoricoLi,
  type DataDoHistoricoLi,
} from './estadoPedidoLi';
import { idPagamentoLi } from './orderIdsLi';
import {
  cartaoLi,
  formaPagamentoLi,
  mapearPagamentosLi,
  montarEscritaPagamentoLi,
  parcelasLi,
  type EscritaPagamentoLi,
  type PagamentoMapeadoLi,
} from './pagamentoMapeamento';

const AGORA_US = 1_800_000_000_000_000;
const WATERMARK_US = dataLiParaMicros('2026-03-10T15:20:10.123456')!;
const NENHUMA: DataDoHistoricoLi = { derivavel: true, us: null };

const pag = (campos: Record<string, unknown>): PedidoPagamentoLi =>
  liPedidoPagamentoSchema.parse({ id: 69291176, valor: '100.00', ...campos });

function pedido(pagamentos: Record<string, unknown>[]): PedidoLi {
  return liPedidoSchema.parse({
    numero: 165,
    situacao: { codigo: 'pedido_pago' },
    data_modificacao: '2026-03-10T15:20:10.123456',
    data_criacao: '2026-03-09T11:00:00.654321',
    pagamentos,
  });
}

function mapear(
  pagamentos: Record<string, unknown>[],
  status: { criacao: StatusPagamento; atualizacao: PagamentoMapeadoLi['statusAtualizacao'] } = {
    criacao: STATUS_PAGAMENTO.aprovado,
    atualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.aprovado },
  },
  datas: { aprovacao: DataDoHistoricoLi; cancelamento: DataDoHistoricoLi } = {
    aprovacao: NENHUMA,
    cancelamento: NENHUMA,
  },
): readonly PagamentoMapeadoLi[] {
  const r = mapearPagamentosLi({
    contaId: 'CONTA1',
    pedido: pedido(pagamentos),
    statusPagamento: status,
    dataAprovacao: datas.aprovacao,
    dataCancelamento: datas.cancelamento,
    watermarkUs: WATERMARK_US,
  });
  if (!r.ok) throw new Error(`refused: ${r.campos.join(',')}`);
  return r.pagamentos;
}

describe('the forma: pagamento_tipo first, then the exact codigo, else 99', () => {
  it('the three captured tipos', () => {
    expect(formaPagamentoLi(pag({ pagamento_tipo: 'instantPayment' })).forma).toBe(
      FORMA_PAGAMENTO.pix,
    );
    expect(formaPagamentoLi(pag({ pagamento_tipo: 'creditCard' })).forma).toBe(
      FORMA_PAGAMENTO.cartao_credito,
    );
    expect(formaPagamentoLi(pag({ pagamento_tipo: 'bankInvoice' })).forma).toBe(
      FORMA_PAGAMENTO.boleto_bancario,
    );
  });

  it('⚠️ the tipo wins over a contradicting codigo (a codigo-first mapper fails here)', () => {
    const f = formaPagamentoLi(
      pag({ pagamento_tipo: 'bankInvoice', forma_pagamento: { codigo: 'proxy-pagali-v2-cartao' } }),
    );
    expect(f).toMatchObject({ forma: FORMA_PAGAMENTO.boleto_bancario, origem: 'tipo' });
  });

  it('an absent tipo + the boleto codigo ⇒ 15; the pix and card gateways; deposito ⇒ 16', () => {
    expect(
      formaPagamentoLi(pag({ forma_pagamento: { codigo: 'proxy-pagali-v2-boleto' } })),
    ).toMatchObject({
      forma: FORMA_PAGAMENTO.boleto_bancario,
      origem: 'codigo',
    });
    for (const codigo of [
      'boleto',
      'wcboleto',
      'pmboleto',
      'pmboletov2',
      'psboleto',
      'pagali-boleto',
      'mpboleto',
    ]) {
      expect(formaPagamentoLi(pag({ forma_pagamento: { codigo } })).forma, codigo).toBe(
        FORMA_PAGAMENTO.boleto_bancario,
      );
    }
    expect(formaPagamentoLi(pag({ forma_pagamento: { codigo: 'pagali-pix' } })).forma).toBe(
      FORMA_PAGAMENTO.pix,
    );
    expect(
      formaPagamentoLi(pag({ forma_pagamento: { codigo: 'proxy-pagali-v2-pix' } })).forma,
    ).toBe(FORMA_PAGAMENTO.pix);
    expect(
      formaPagamentoLi(pag({ forma_pagamento: { codigo: 'proxy-pagali-v2-cartao' } })).forma,
    ).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect(formaPagamentoLi(pag({ forma_pagamento: { codigo: 'deposito' } })).forma).toBe(
      FORMA_PAGAMENTO.deposito_bancario,
    );
  });

  it('⚠️ NEAR-MISS: `INSTANTPAYMENT` is not a tipo; ` boleto` is not a codigo', () => {
    expect(formaPagamentoLi(pag({ pagamento_tipo: 'INSTANTPAYMENT' })).forma).toBe(
      FORMA_PAGAMENTO.outros,
    );
    expect(formaPagamentoLi(pag({ forma_pagamento: { codigo: ' boleto' } })).forma).toBe(
      FORMA_PAGAMENTO.outros,
    );
    expect(formaPagamentoLi(pag({ forma_pagamento: { codigo: 'Boleto' } })).forma).toBe(
      FORMA_PAGAMENTO.outros,
    );
  });

  it('the redirect gateway stays 99 with the raw codigo in the description (the NF-e xPag, ≤ 60)', () => {
    expect(
      formaPagamentoLi(pag({ forma_pagamento: { codigo: 'proxy-mercadopago-v1-redirect' } })),
    ).toEqual({
      forma: FORMA_PAGAMENTO.outros,
      origem: 'outros',
      codigo: 'proxy-mercadopago-v1-redirect',
      descricaoPagamento: 'Loja Integrada: proxy-mercadopago-v1-redirect',
    });
    expect(
      formaPagamentoLi(pag({ forma_pagamento: { codigo: 'x'.repeat(100) } })).descricaoPagamento,
    ).toHaveLength(60);
    expect(formaPagamentoLi(pag({})).descricaoPagamento).toBe('Loja Integrada: sem código');
  });
});

describe('the card block and the instalments', () => {
  it('⚠️ PIX carries the card block even without a brand (a bandeira-gated mapper fails here)', () => {
    expect(
      cartaoLi(FORMA_PAGAMENTO.pix, pag({ bandeira: null, authorization_code: null })),
    ).toEqual({
      tpIntegra: '2',
      bandeira: null,
      numeroCartao: null,
      cAut: null,
      cnpj_instituicao: null,
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
    });
  });

  it('the card: cAut from authorization_code; the brand stays null; boleto has none', () => {
    const p = pag({ bandeira: 'visa', authorization_code: 'A1B2' });
    expect(cartaoLi(FORMA_PAGAMENTO.cartao_credito, p)).toMatchObject({
      bandeira: null,
      cAut: 'A1B2',
    });
    expect(
      cartaoLi(FORMA_PAGAMENTO.cartao_credito, pag({ authorization_code: '' }))?.cAut,
    ).toBeNull();
    expect(cartaoLi(FORMA_PAGAMENTO.boleto_bancario, p)).toBeNull();
    expect(cartaoLi(FORMA_PAGAMENTO.outros, p)).toBeNull();
  });

  it('⚠️ `parcelamento: {}` ⇒ 1, à vista; 3 instalments ⇒ 3, not à vista; 0 ⇒ 1', () => {
    expect(parcelasLi(pag({ parcelamento: {} }))).toEqual({ parcelas: 1, aVista: true });
    expect(parcelasLi(pag({}))).toEqual({ parcelas: 1, aVista: true });
    expect(parcelasLi(pag({ parcelamento: { numero_parcelas: 4, valor_parcela: 25 } }))).toEqual({
      parcelas: 4,
      aVista: false,
    });
    expect(parcelasLi(pag({ parcelamento: { numero_parcelas: 0 } }))).toEqual({
      parcelas: 1,
      aVista: true,
    });
  });
});

describe('the mapping', () => {
  it('⚠️ valor, never valor_pago', () => {
    const [m] = mapear([{ id: 1, valor: '100.00', valor_pago: '0.00' }]);
    expect(m?.valor).toBe(100);
  });

  it('valor is rounded to centavos', () => {
    expect(mapear([{ id: 1, valor: '10.005' }])[0]?.valor).toBe(10.01);
  });

  it('⚠️ EVERY payment, never only the first: two payments ⇒ two docs', () => {
    const ms = mapear([
      { id: 11, valor: '60.00', pagamento_tipo: 'instantPayment' },
      { id: 12, valor: '40.00', pagamento_tipo: 'creditCard' },
    ]);
    expect(ms.map((m) => m.docId)).toEqual([
      idPagamentoLi('CONTA1', 11),
      idPagamentoLi('CONTA1', 12),
    ]);
    expect(ms.map((m) => m.valor)).toEqual([60, 40]);
  });

  it('a payment without a value (or a negative one) refuses the mapping, path only', () => {
    const r = mapearPagamentosLi({
      contaId: 'CONTA1',
      pedido: pedido([{ id: 1, valor: null }]),
      statusPagamento: { criacao: STATUS_PAGAMENTO.pendente, atualizacao: { tipo: 'manter' } },
      dataAprovacao: NENHUMA,
      dataCancelamento: NENHUMA,
      watermarkUs: WATERMARK_US,
    });
    expect(r).toEqual({ ok: false, campos: ['pagamentos[].valor'] });
  });

  it('⚠️ a create carries a cancellation date only beside a refund status', () => {
    const canceladoUs = WATERMARK_US - 500;
    const datas = {
      aprovacao: NENHUMA,
      cancelamento: { derivavel: true, us: canceladoUs },
    } as const;
    const [estornado] = mapear(
      [{ id: 1, valor: '10.00' }],
      { criacao: STATUS_PAGAMENTO.estornado, atualizacao: { tipo: 'manter' } },
      datas,
    );
    const e = montarEscritaPagamentoLi(null, estornado!, AGORA_US);
    expect(e.tipo === 'criar' && e.corpo.dataCancelamento).toBe(canceladoUs);
    // NEAR-MISS: the same date beside an `aprovado` creation is never written.
    const [aprovado] = mapear(
      [{ id: 1, valor: '10.00' }],
      { criacao: STATUS_PAGAMENTO.aprovado, atualizacao: { tipo: 'manter' } },
      datas,
    );
    const a = montarEscritaPagamentoLi(null, aprovado!, AGORA_US);
    expect(a.tipo === 'criar' && a.corpo.dataCancelamento).toBeNull();
  });

  it('a create body parses, with no vencimento, juros or tarifas and the order clock', () => {
    const [m] = mapear([
      { id: 1, valor: '50.00', pagamento_tipo: 'creditCard', parcelamento: { numero_parcelas: 2 } },
    ]);
    const e = montarEscritaPagamentoLi(null, m!, AGORA_US);
    expect(e.tipo).toBe('criar');
    if (e.tipo !== 'criar') return;
    const doc = pagamentoSchema.parse(e.corpo);
    expect(doc).toMatchObject({
      id: '1',
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 50,
      parcelas: 2,
      aVista: false,
      vencimento: null,
      juros: null,
      tarifas: null,
      marketplace: null,
      lastProviderUpdate: WATERMARK_US,
      ultimaModificacao: AGORA_US,
      dataCadastro: dataLiParaMicros('2026-03-09T11:00:00.654321'),
    });
    expect(doc.status_pagamento).not.toBeNull();
  });
});

describe('the update overlay', () => {
  const base = (over: Record<string, unknown> = {}): PagamentoMapeadoLi => ({
    ...mapear([{ id: 1, valor: '100.00', pagamento_tipo: 'bankInvoice' }])[0]!,
    ...over,
  });

  /** A stored doc exactly as `base()` would create it. */
  const armazenado = (over: Record<string, unknown> = {}) => ({
    ...montarEscritaPagamentoLiCorpo(base()),
    ...over,
  });

  function montarEscritaPagamentoLiCorpo(m: PagamentoMapeadoLi) {
    const e = montarEscritaPagamentoLi(null, m, AGORA_US - 1);
    if (e.tipo !== 'criar') throw new Error('expected a create');
    return e.corpo;
  }

  it('EQUAL stamp, same content ⇒ sem-mudanca, zero writes', () => {
    expect(montarEscritaPagamentoLi(armazenado(), base(), AGORA_US)).toEqual({
      tipo: 'sem-mudanca',
    });
  });

  it('⚠️ +1 µs ⇒ applies (the stamp advances, ultimaModificacao with it)', () => {
    const e = montarEscritaPagamentoLi(
      armazenado(),
      base({ watermarkUs: WATERMARK_US + 1 }),
      AGORA_US,
    );
    expect(e).toEqual({
      tipo: 'atualizar',
      patch: { lastProviderUpdate: WATERMARK_US + 1, ultimaModificacao: AGORA_US },
      statusRessuscitado: false,
    });
  });

  it('⚠️ a stored stamp strictly newer ⇒ obsoleto; a stored null ⇒ proceeds', () => {
    expect(
      montarEscritaPagamentoLi(
        armazenado({ lastProviderUpdate: WATERMARK_US + 1 }),
        base(),
        AGORA_US,
      ),
    ).toEqual({
      tipo: 'obsoleto',
      armazenadoUs: WATERMARK_US + 1,
    });
    expect(
      montarEscritaPagamentoLi(armazenado({ lastProviderUpdate: null }), base(), AGORA_US),
    ).toMatchObject({
      tipo: 'atualizar',
      patch: { lastProviderUpdate: WATERMARK_US },
    });
  });

  it('⚠️ a stored ms int of the same second reads through coerceToMicros: the incoming stamp is newer', () => {
    const ms = Math.floor(WATERMARK_US / 1_000_000) * 1000;
    expect(
      montarEscritaPagamentoLi(armazenado({ lastProviderUpdate: ms }), base(), AGORA_US).tipo,
    ).toBe('atualizar');
  });

  it('valor_pago ≠ valor upstream does not matter: a changed valor is overlaid', () => {
    expect(montarEscritaPagamentoLi(armazenado({ valor: 90 }), base(), AGORA_US)).toMatchObject({
      tipo: 'atualizar',
      patch: { valor: 100 },
    });
  });

  it('⚠️ a stored operator forma 3 + an incoming 99 ⇒ 3 kept', () => {
    const outros = base({
      forma: {
        forma: FORMA_PAGAMENTO.outros,
        origem: 'outros',
        codigo: 'x',
        descricaoPagamento: 'Loja Integrada: x',
      },
      parcelas: 1,
      aVista: true,
      cartao: null,
    });
    const e = montarEscritaPagamentoLi(
      armazenado({ forma_de_pagamento: 3, parcelas: 4, aVista: false }),
      outros,
      AGORA_US,
    );
    expect(e).toEqual({ tipo: 'sem-mudanca' });
  });

  it('a stored 99 + an incoming 15 ⇒ 15', () => {
    const e = montarEscritaPagamentoLi(armazenado({ forma_de_pagamento: 99 }), base(), AGORA_US);
    expect(e).toMatchObject({
      tipo: 'atualizar',
      patch: { forma_de_pagamento: FORMA_PAGAMENTO.boleto_bancario },
    });
  });

  it('the card block is fill-once: added when missing, an operator’s kept', () => {
    const pix = mapear([{ id: 1, valor: '100.00', pagamento_tipo: 'instantPayment' }])[0]!;
    const semCartao = { ...montarEscritaPagamentoLiCorpo(pix), cartao: null };
    expect(montarEscritaPagamentoLi(semCartao, pix, AGORA_US)).toMatchObject({
      tipo: 'atualizar',
      patch: { cartao: pix.cartao },
    });
    const doOperador = { ...semCartao, cartao: { tpIntegra: '1', cAut: 'OP' } };
    expect(montarEscritaPagamentoLi(doOperador, pix, AGORA_US)).toEqual({ tipo: 'sem-mudanca' });
  });

  it('the status goes through the ladder: aprovado never back to pendente; a kept status is kept', () => {
    const pendente = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.pendente },
    });
    expect(montarEscritaPagamentoLi(armazenado(), pendente, AGORA_US)).toEqual({
      tipo: 'sem-mudanca',
    });
    const estornado = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
    });
    expect(montarEscritaPagamentoLi(armazenado(), estornado, AGORA_US)).toMatchObject({
      tipo: 'atualizar',
      patch: { status_pagamento: STATUS_PAGAMENTO.estornado },
    });
    const mantido = base({ statusAtualizacao: { tipo: 'manter' } });
    expect(
      montarEscritaPagamentoLi(
        armazenado({ status_pagamento: STATUS_PAGAMENTO.em_disputa }),
        mantido,
        AGORA_US,
      ),
    ).toEqual({
      tipo: 'sem-mudanca',
    });
  });

  it('the dates: overlaid when derivable; kept when the history could not derive them', () => {
    const aprovadoUs = WATERMARK_US - 1000;
    const comData = base({ dataAprovacao: { derivavel: true, us: aprovadoUs } });
    expect(montarEscritaPagamentoLi(armazenado(), comData, AGORA_US)).toMatchObject({
      tipo: 'atualizar',
      patch: { dataAprovacao: aprovadoUs },
    });
    const semData = base({
      dataAprovacao: { derivavel: false },
      dataCancelamento: { derivavel: false },
    });
    expect(
      montarEscritaPagamentoLi(
        armazenado({ dataAprovacao: aprovadoUs, dataCancelamento: 5 }),
        semData,
        AGORA_US,
      ),
    ).toEqual({ tipo: 'sem-mudanca' });
  });

  it('⚠️ the cancellation date follows the STATUS: a kept status (the keep-both arm) never gets one', () => {
    const canceladoUs = WATERMARK_US - 500;
    const mantido = base({
      statusAtualizacao: { tipo: 'manter' },
      dataCancelamento: { derivavel: true, us: canceladoUs },
    });
    expect(montarEscritaPagamentoLi(armazenado(), mantido, AGORA_US)).toEqual({
      tipo: 'sem-mudanca',
    });
  });

  it('⚠️ NEAR-MISS: the same date beside a WRITTEN refund status is written', () => {
    const canceladoUs = WATERMARK_US - 500;
    const estornado = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
      dataCancelamento: { derivavel: true, us: canceladoUs },
    });
    expect(montarEscritaPagamentoLi(armazenado(), estornado, AGORA_US)).toMatchObject({
      tipo: 'atualizar',
      patch: { status_pagamento: STATUS_PAGAMENTO.estornado, dataCancelamento: canceladoUs },
    });
  });

  it('a status kept by the ladder (a painel reversal) keeps the stored dates; one already at the target refreshes them', () => {
    const regressivo = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.pendente },
      dataCancelamento: NENHUMA,
    });
    expect(
      montarEscritaPagamentoLi(armazenado({ dataCancelamento: 5 }), regressivo, AGORA_US),
    ).toEqual({ tipo: 'sem-mudanca' });
    const canceladoUs = WATERMARK_US - 500;
    const jaEstornado = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
      dataCancelamento: { derivavel: true, us: canceladoUs },
    });
    expect(
      montarEscritaPagamentoLi(
        armazenado({ status_pagamento: STATUS_PAGAMENTO.estornado, dataCancelamento: null }),
        jaEstornado,
        AGORA_US,
      ),
    ).toMatchObject({ tipo: 'atualizar', patch: { dataCancelamento: canceladoUs } });
  });

  it('a resurrected payment (a dead status left) drops its cancellation date', () => {
    const revivido = base({
      statusAtualizacao: { tipo: 'status', status: STATUS_PAGAMENTO.aprovado },
      dataCancelamento: NENHUMA,
    });
    expect(
      montarEscritaPagamentoLi(
        armazenado({ status_pagamento: STATUS_PAGAMENTO.estornado, dataCancelamento: 5 }),
        revivido,
        AGORA_US,
      ),
    ).toMatchObject({
      tipo: 'atualizar',
      patch: { status_pagamento: STATUS_PAGAMENTO.aprovado, dataCancelamento: null },
      statusRessuscitado: true,
    });
  });

  it('⚠️ end to end: an UNKNOWN codigo after a cancellation (9→2→8→xyz) keeps the stored status AND its date', () => {
    const h = lerHistoricoLi({
      numero: 165,
      codigoDetalhe: 'xyz',
      linhas: [
        {
          id: 1,
          numero: 165,
          data: '2026-03-02T10:00:00',
          situacao: { codigo: 'aguardando_pagamento' },
          situacao_anterior: { codigo: 'pedido_efetuado' },
        },
        {
          id: 2,
          numero: 165,
          data: '2026-03-02T10:01:00',
          situacao: { codigo: 'pedido_cancelado' },
          situacao_anterior: { codigo: 'aguardando_pagamento' },
        },
        {
          id: 3,
          numero: 165,
          data: '2026-03-02T10:02:00',
          situacao: { codigo: 'xyz' },
          situacao_anterior: { codigo: 'pedido_cancelado' },
        },
      ],
      modo: MODO_HISTORICO_LI.estrito,
    });
    if (!h.ok) throw new Error('history refused');
    const d = decidirEstadoLi({
      armazenado: { estado: 'cancelado', estoqueAplicado: null },
      codigo: 'xyz',
      capturado: h.capturado,
    });
    const [m] = mapear(
      [{ id: 1, valor: '100.00', pagamento_tipo: 'bankInvoice' }],
      d.statusPagamento,
      { aprovacao: h.dataAprovacao, cancelamento: h.dataCancelamento },
    );
    const cancelado = armazenado({
      status_pagamento: STATUS_PAGAMENTO.cancelado,
      dataCancelamento: 5,
    });
    expect(montarEscritaPagamentoLi(cancelado, m!, AGORA_US)).toEqual({ tipo: 'sem-mudanca' });
  });

  it('fill-once id and dataCadastro; ultimaModificacao never goes backwards', () => {
    const e = montarEscritaPagamentoLi(
      armazenado({ id: null, dataCadastro: null, ultimaModificacao: AGORA_US + 5 }),
      base(),
      AGORA_US,
    );
    expect(e).toEqual({
      tipo: 'atualizar',
      patch: { id: '1', dataCadastro: base().dataCadastroUs, ultimaModificacao: AGORA_US + 5 },
      statusRessuscitado: false,
    });
    expect(montarEscritaPagamentoLi(armazenado({ id: 'outro' }), base(), AGORA_US)).toEqual({
      tipo: 'sem-mudanca',
    });
  });
});

describe('⚠️ why the pagamentos and the pedido commit in ONE batch (module header, "Rule 7")', () => {
  const linhas = [{ id: 1, valor: '100.00', pagamento_tipo: 'bankInvoice' }];
  const canceladoUs = WATERMARK_US - 500;
  const datas = {
    aprovacao: NENHUMA,
    cancelamento: { derivavel: true, us: canceladoUs },
  } as const;
  /** 1020, captured, against a stored `pago`: the stock removal applied or not. */
  const decisao = (estoqueAplicado: unknown) =>
    decidirEstadoLi({
      armazenado: { estado: 'pago', estoqueAplicado },
      codigo: 'pagamento_devolvido_sem_retorno',
      capturado: true,
    }).statusPagamento;
  const REMOVIDO = { depositoId: 'd', ehSaida: true, removido: { p: 1 } };

  /** The payment as an earlier import stored it: `aprovado`, at the same stamp. */
  function aprovado(): Readonly<Record<string, unknown>> {
    const e = montarEscritaPagamentoLi(null, mapear(linhas)[0]!, AGORA_US - 1);
    if (e.tipo !== 'criar') throw new Error('expected a create');
    return e.corpo;
  }

  /** The stored document once `escrita` has landed on `doc` (or `doc` itself when it writes nothing). */
  function depois(
    doc: Readonly<Record<string, unknown>>,
    escrita: EscritaPagamentoLi,
  ): Readonly<Record<string, unknown>> {
    if (escrita.tipo === 'atualizar') return { ...doc, ...escrita.patch };
    if (escrita.tipo === 'criar') return escrita.corpo;
    return doc;
  }

  it('a refund status decided from a stale snapshot S is NOT undone by re-deciding from the fresh S′', () => {
    const armazenado = aprovado();
    expect(armazenado.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);

    // S: the removal not applied yet ⇒ the refund status and its date.
    const [deS] = mapear(linhas, decisao(null), datas);
    const escritaS = montarEscritaPagamentoLi(armazenado, deS!, AGORA_US);
    if (escritaS.tipo !== 'atualizar') throw new Error('expected an update');
    expect(escritaS.patch).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.estornado,
      dataCancelamento: canceladoUs,
    });

    // S′: the stock sync applied the removal in between ⇒ the keep-both arm.
    const [deSLinha] = mapear(linhas, decisao(REMOVIDO), datas);
    expect(deSLinha!.statusAtualizacao).toEqual({ tipo: 'manter' });

    // The OLD order: S's write landed, then S′ was decided over it. That
    // writes nothing, so the refund stays beside a kept `pago`.
    const comS = depois(armazenado, escritaS);
    const fimRegravando = depois(comS, montarEscritaPagamentoLi(comS, deSLinha!, AGORA_US));
    expect(fimRegravando.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(fimRegravando.dataCancelamento).toBe(canceladoUs);

    // NEAR-MISS, the batch: S's write never landed (the pedido's precondition
    // aborted it), and the retry decides S′ over the document as it was.
    const fimDoLote = depois(armazenado, montarEscritaPagamentoLi(armazenado, deSLinha!, AGORA_US));
    expect(fimDoLote.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(fimDoLote.dataCancelamento).toBeNull();

    // The two end states must stay distinct: only the batch keeps `aprovado`.
    expect(fimDoLote.status_pagamento).not.toBe(fimRegravando.status_pagamento);
  });
});
