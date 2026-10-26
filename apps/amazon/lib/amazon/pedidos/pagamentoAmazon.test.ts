/**
 * The pure pagamento decisions (master plan step 6, PR 6): the forma table, the
 * legs, the `valor` rule under CIF and FOB, the status ladder and its target,
 * and the write over a stored snapshot (create, overlays, fill-once stamps).
 * End-to-end pairs with the pedido estado live in `pedidoMapeamento.test.ts`.
 *
 * ⚠️ PLACEHOLDERS ONLY: every document is generated at run time
 * (`testing/documentos.ts`), never committed.
 */
import { describe, expect, it } from 'vitest';
import {
  BANDEIRA,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  type ItemDoPedido,
} from '@delfrance/schemas';

import { gerarCnpj, gerarCpf, pontuarCnpj } from '../testing/documentos';
import { execucaoAmazon, pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  DESCRICAO_FORMA_NAO_INFORMADA_AMAZON,
  alvoStatusPagamentoAmazon,
  codigoAutorizacaoAmazon,
  execucaoPrincipalAmazon,
  execucoesPagamentoAmazon,
  formaDePagamentoAmazon,
  montarEscritaPagamentoAmazon,
  somaPagamentoAmazon,
  statusPagamentoAmazonAplicavel,
  totalDaNotaAmazon,
  valorPagamentoAmazon,
  type EntradaPagamentoAmazon,
  type TotaisDoPedidoAmazon,
} from './pagamentoAmazon';

const NOW_US = 1_900_000_000_000_000;
const WATERMARK_US = 1_800_000_000_000_000;
const ORDER = '171-9876543-2109876';

/** Legs → the read executions. */
function legs(...execucoes: Record<string, unknown>[]) {
  return execucoesPagamentoAmazon(pedidoAmazon({ pagamento: execucoes }));
}

function item(preco: number, quantidade: number): ItemDoPedido {
  return {
    produtoUid: null,
    ordem: 1,
    precoDeVenda: preco,
    descontoUnitario: 0,
    quantidade,
  } as ItemDoPedido;
}

/** An entrada for an approved, live order ("aprovado" target) with sane defaults. */
function entrada(over: Partial<EntradaPagamentoAmazon> = {}): EntradaPagamentoAmazon {
  const execucoes = over.execucoes ?? legs(execucaoAmazon('CreditCard', '20.00'));
  return {
    orderId: ORDER,
    watermarkUs: WATERMARK_US,
    maisNovo: true,
    alvo: { tipo: 'status', status: STATUS_PAGAMENTO.aprovado },
    cancelamento: false,
    modoValor: 'espelhar',
    execucoes,
    valor: { valor: 20, divergente: false },
    ...over,
  };
}

function montar(raw: Record<string, unknown> | null, e: EntradaPagamentoAmazon | null = entrada()) {
  const status =
    raw === null
      ? 'ausente'
      : typeof raw.status_pagamento === 'number'
        ? (raw.status_pagamento as never)
        : 'ilegivel';
  return montarEscritaPagamentoAmazon(raw, status, e, { nowUs: NOW_US });
}

function corpoDe(r: ReturnType<typeof montar>): Readonly<Record<string, unknown>> {
  if (r.escrita.tipo !== 'criar') throw new Error(`esperava criar, veio ${r.escrita.tipo}`);
  return r.escrita.corpo;
}

function patchDe(r: ReturnType<typeof montar>): Readonly<Record<string, unknown>> {
  if (r.escrita.tipo !== 'atualizar') throw new Error(`esperava atualizar, veio ${r.escrita.tipo}`);
  return r.escrita.patch;
}

describe('the forma: an EXACT match', () => {
  it('★ each row of the table', () => {
    expect(formaDePagamentoAmazon('CreditCard')).toEqual({
      forma: FORMA_PAGAMENTO.cartao_credito,
      conhecida: true,
      descricao: null,
    });
    expect(formaDePagamentoAmazon('Pix').forma).toBe(FORMA_PAGAMENTO.pix);
    expect(formaDePagamentoAmazon('Boleto').forma).toBe(FORMA_PAGAMENTO.boleto_bancario);
    for (const outro of ['Other', 'Invoice', 'GC', 'Rewards']) {
      expect(formaDePagamentoAmazon(outro)).toEqual({
        forma: FORMA_PAGAMENTO.outros,
        conhecida: false,
        descricao: `Amazon: ${outro}`,
      });
    }
  });

  it('★ NEAR-MISS: another case, a trailing space, a longer word ⇒ 99 (never folded, never trimmed)', () => {
    for (const quase of ['pix', 'PIX', 'Pix ', 'Pixel', 'creditcard', 'CREDITCARD', ' Boleto']) {
      expect(formaDePagamentoAmazon(quase), quase).toMatchObject({
        forma: FORMA_PAGAMENTO.outros,
        conhecida: false,
      });
    }
    // A prototype key is no method.
    expect(formaDePagamentoAmazon('constructor').forma).toBe(FORMA_PAGAMENTO.outros);
  });

  it('blank or absent ⇒ 99 "não informada"; a long method is cut to xPag’s 60', () => {
    for (const nada of [undefined, null, '', '   ', 7]) {
      expect(formaDePagamentoAmazon(nada).descricao).toBe(DESCRICAO_FORMA_NAO_INFORMADA_AMAZON);
    }
    const longa = formaDePagamentoAmazon('X'.repeat(100)).descricao ?? '';
    expect(longa).toHaveLength(60);
    expect(longa.startsWith('Amazon: XXX')).toBe(true);
  });
});

describe('the legs', () => {
  it('Σ is null when ANY leg is unreadable; no leg sums to 0', () => {
    expect(
      somaPagamentoAmazon(
        legs(execucaoAmazon('CreditCard', '10.00'), execucaoAmazon('Pix', '5.50')),
      ),
    ).toBe(15.5);
    expect(
      somaPagamentoAmazon(legs(execucaoAmazon('CreditCard', '10.00'), execucaoAmazon('Pix', 'x'))),
    ).toBeNull();
    expect(somaPagamentoAmazon(legs(execucaoAmazon('CreditCard', null)))).toBeNull();
    expect(somaPagamentoAmazon([])).toBe(0);
    expect(execucoesPagamentoAmazon(pedidoAmazon({ pagamento: null }))).toEqual([]);
  });

  it('★ the principal leg is the LARGEST; ties broken by the key, never the array index (the same legs in another order pick the same leg)', () => {
    const a = execucaoAmazon('CreditCard', '30.00', { authorizationCode: 'A1' });
    const b = execucaoAmazon('Pix', '70.00', { authorizationCode: 'B1' });
    expect(execucaoPrincipalAmazon(legs(a, b))?.metodo).toBe('Pix');
    expect(execucaoPrincipalAmazon(legs(b, a))?.metodo).toBe('Pix');
    const empate1 = execucaoAmazon('Pix', '50.00', { authorizationCode: 'Z9' });
    const empate2 = execucaoAmazon('CreditCard', '50.00', { authorizationCode: 'A1' });
    expect(execucaoPrincipalAmazon(legs(empate1, empate2))?.metodo).toBe('CreditCard');
    expect(execucaoPrincipalAmazon(legs(empate2, empate1))?.metodo).toBe('CreditCard');
    // An unreadable amount never wins over a readable one.
    expect(
      execucaoPrincipalAmazon(
        legs(execucaoAmazon('Pix', 'abc'), execucaoAmazon('CreditCard', '0.01')),
      )?.metodo,
    ).toBe('CreditCard');
    expect(execucaoPrincipalAmazon([])).toBeNull();
  });

  it('★ the tie key covers EVERY field the pagamento reads: two legs equal in method, authorization and amount but not in brand or acquirer ⇒ the same card in either array order', () => {
    const visa = execucaoAmazon('CreditCard', '10.00', {
      cardBrand: 'Visa',
      acquirerId: gerarCnpj('434567890001'),
    });
    const master = execucaoAmazon('CreditCard', '10.00', {
      cardBrand: 'Mastercard',
      acquirerId: gerarCnpj('534567890001'),
    });
    const vm = montar(null, entrada({ execucoes: legs(visa, master) }));
    const mv = montar(null, entrada({ execucoes: legs(master, visa) }));
    expect(corpoDe(vm).cartao).toEqual(corpoDe(mv).cartao);
    expect(vm).toEqual(mv);
    // NEAR-MISS: the key differs on each of those fields (and on the currency) alone.
    const chave = (extra: Record<string, unknown>, moeda = 'BRL') =>
      execucoesPagamentoAmazon(
        pedidoAmazon({
          pagamento: [
            {
              ...execucaoAmazon('CreditCard', null, extra),
              paymentAmount: { amount: '10.00', currencyCode: moeda },
            },
          ],
        }),
      )[0]?.chave;
    const base = chave({});
    expect(chave({ cardBrand: 'Visa' })).not.toBe(base);
    expect(chave({ acquirerId: 'X' })).not.toBe(base);
    expect(chave({}, 'USD')).not.toBe(base);
    expect(chave({})).toBe(base);
  });

  it('cAut: trimmed, 1–128 characters, else null', () => {
    expect(codigoAutorizacaoAmazon(' 000123 ')).toBe('000123');
    expect(codigoAutorizacaoAmazon('')).toBeNull();
    expect(codigoAutorizacaoAmazon('   ')).toBeNull();
    expect(codigoAutorizacaoAmazon('9'.repeat(128))).toHaveLength(128);
    expect(codigoAutorizacaoAmazon('9'.repeat(129))).toBeNull();
    expect(codigoAutorizacaoAmazon(123)).toBeNull();
  });
});

describe('★ valor = what the NF-e states (CIF carries the freight, every other modalidade does not)', () => {
  const comFrete = (modalidade: unknown): TotaisDoPedidoAmazon => ({
    itens: [item(100, 1)],
    descontoTotal: 10,
    valorFrete: 15,
    modalidade,
  });

  it('the note’s total: the freight member only under CIF ("0")', () => {
    expect(totalDaNotaAmazon(comFrete('0'))).toBe(105);
    for (const m of ['1', '2', '3', '4', '9', null, undefined]) {
      expect(totalDaNotaAmazon(comFrete(m)), String(m)).toBe(90);
    }
  });

  it('★ CIF: Σ = lines − discount + freight ⇒ Σ, nothing filed (EQUAL); one centavo short ⇒ the total + divergente (NEAR-MISS); above ⇒ Σ + divergente', () => {
    const cif = (soma: number | null) =>
      valorPagamentoAmazon({ soma, freteDoComprador: 15, totais: comFrete('0') });
    expect(cif(105)).toEqual({ valor: 105, divergente: false });
    expect(cif(104.99)).toEqual({ valor: 105, divergente: true });
    expect(cif(105.01)).toEqual({ valor: 105.01, divergente: true });
    expect(cif(null)).toEqual({ valor: 105, divergente: true });
  });

  it('★ FOB: the buyer-paid freight is EXCLUDED — Σ − freight = lines − discount ⇒ that, nothing filed (EQUAL); one centavo off ⇒ divergente (NEAR-MISS)', () => {
    const fob = (soma: number | null, frete: number | null = 15) =>
      valorPagamentoAmazon({ soma, freteDoComprador: frete, totais: comFrete('1') });
    expect(fob(105)).toEqual({ valor: 90, divergente: false });
    expect(fob(105.01)).toEqual({ valor: 90.01, divergente: true });
    expect(fob(104.99)).toEqual({ valor: 90, divergente: true });
    // No freight row at all: nothing to exclude.
    expect(
      valorPagamentoAmazon({
        soma: 90,
        freteDoComprador: null,
        totais: { ...comFrete('1'), valorFrete: null },
      }),
    ).toEqual({ valor: 90, divergente: false });
  });

  it('never negative: a negative total floors at 0, still divergente', () => {
    expect(
      valorPagamentoAmazon({
        soma: 0,
        freteDoComprador: null,
        totais: { itens: [item(5, 1)], descontoTotal: 9, valorFrete: null, modalidade: '1' },
      }),
    ).toEqual({ valor: 0, divergente: true });
    // ABOVE a negative total, the remainder itself may be negative: floored too
    // (the pagamento schema refuses a negative valor, which would refuse the order).
    expect(
      valorPagamentoAmazon({
        soma: 0,
        freteDoComprador: 3,
        totais: { itens: [item(5, 1)], descontoTotal: 9, valorFrete: 3, modalidade: '1' },
      }),
    ).toEqual({ valor: 0, divergente: true });
    expect(
      valorPagamentoAmazon({
        soma: -1,
        freteDoComprador: 3,
        totais: { itens: [item(5, 1)], descontoTotal: 9, valorFrete: null, modalidade: '0' },
      }),
    ).toEqual({ valor: 0, divergente: true });
    // NEAR-MISS: a positive remainder above the total is kept as it is.
    expect(
      valorPagamentoAmazon({
        soma: 1,
        freteDoComprador: null,
        totais: { itens: [item(5, 1)], descontoTotal: 9, valorFrete: null, modalidade: '0' },
      }),
    ).toEqual({ valor: 1, divergente: true });
  });
});

describe('the status: a ladder of two equal rungs', () => {
  const aprovado = { tipo: 'status', status: STATUS_PAGAMENTO.aprovado } as const;
  const estornado = { tipo: 'status', status: STATUS_PAGAMENTO.estornado } as const;
  const manter = { tipo: 'manter' } as const;

  it('★ none stored ⇒ created at aprovado only; never at estornado', () => {
    expect(statusPagamentoAmazonAplicavel('ausente', aprovado, { maisNovo: false })).toEqual({
      escrever: true,
      status: STATUS_PAGAMENTO.aprovado,
      ressuscitado: false,
    });
    expect(statusPagamentoAmazonAplicavel('ausente', estornado, { maisNovo: true })).toEqual({
      escrever: false,
      motivo: 'ausente',
    });
  });

  it('★ aprovado → estornado always; estornado → aprovado ONLY on a strictly newer clock (ressuscitado)', () => {
    expect(
      statusPagamentoAmazonAplicavel(STATUS_PAGAMENTO.aprovado, estornado, { maisNovo: false }),
    ).toMatchObject({ escrever: true, status: STATUS_PAGAMENTO.estornado });
    expect(
      statusPagamentoAmazonAplicavel(STATUS_PAGAMENTO.estornado, aprovado, { maisNovo: false }),
    ).toEqual({ escrever: false, motivo: 'terminal' });
    expect(
      statusPagamentoAmazonAplicavel(STATUS_PAGAMENTO.estornado, aprovado, { maisNovo: true }),
    ).toEqual({ escrever: true, status: STATUS_PAGAMENTO.aprovado, ressuscitado: true });
  });

  it('★ an operator’s status (or an unreadable one) is never walked', () => {
    for (const status of [
      STATUS_PAGAMENTO.em_disputa,
      STATUS_PAGAMENTO.recusado,
      STATUS_PAGAMENTO.devolvido,
      STATUS_PAGAMENTO.estornado_parcialmente,
      STATUS_PAGAMENTO.cancelado,
      STATUS_PAGAMENTO.pendente,
      'ilegivel' as const,
    ]) {
      for (const alvo of [aprovado, estornado]) {
        expect(
          statusPagamentoAmazonAplicavel(status, alvo, { maisNovo: true }),
          String(status),
        ).toEqual({ escrever: false, motivo: 'fora-da-escada' });
      }
    }
  });

  it('manter and the same status write nothing', () => {
    expect(
      statusPagamentoAmazonAplicavel(STATUS_PAGAMENTO.aprovado, manter, { maisNovo: true }),
    ).toEqual({ escrever: false, motivo: 'manter' });
    expect(
      statusPagamentoAmazonAplicavel(STATUS_PAGAMENTO.aprovado, aprovado, { maisNovo: true }),
    ).toEqual({ escrever: false, motivo: 'sem-mudanca' });
  });

  it('★ the target is PAIRED with the pedido estado this attempt leaves', () => {
    const alvo = (e: Partial<Parameters<typeof alvoStatusPagamentoAmazon>[0]>) =>
      alvoStatusPagamentoAmazon({
        cancelamento: false,
        aprovadoNaAmazon: true,
        revertido: false,
        estadoFinal: ESTADO_PEDIDO.pago,
        ...e,
      });
    expect(alvo({})).toEqual({ tipo: 'status', status: STATUS_PAGAMENTO.aprovado });
    // A cancellation: estornado exactly beside estornadoIntegralmente.
    expect(alvo({ cancelamento: true, estadoFinal: ESTADO_PEDIDO.estornadoIntegralmente })).toEqual(
      { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
    );
    expect(alvo({ cancelamento: true, estadoFinal: ESTADO_PEDIDO.cancelado })).toEqual({
      tipo: 'manter',
    });
    expect(alvo({ cancelamento: true, estadoFinal: ESTADO_PEDIDO.pago })).toEqual({
      tipo: 'manter',
    });
    // Never beside our error, a kept terminal, an operator's estado, PENDING or a reversal.
    for (const estadoFinal of [
      ESTADO_PEDIDO.error,
      ESTADO_PEDIDO.cancelado,
      ESTADO_PEDIDO.estornadoIntegralmente,
      ESTADO_PEDIDO.emProcessamento,
      ESTADO_PEDIDO.finalizado,
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      null,
    ]) {
      expect(alvo({ estadoFinal }), String(estadoFinal)).toEqual({ tipo: 'manter' });
    }
    expect(alvo({ aprovadoNaAmazon: false })).toEqual({ tipo: 'manter' });
    expect(alvo({ revertido: true })).toEqual({ tipo: 'manter' });
  });
});

describe('the CREATE', () => {
  it('★ a live approved order ⇒ the whole document: id, forma, aprovado, valor, the stamps; never the Shopee/MP-only fields', () => {
    const r = montar(null);
    expect(corpoDe(r)).toEqual({
      id: ORDER,
      metodoPagamentoOuterRef: null,
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      cartao: {
        tpIntegra: '2',
        bandeira: null,
        numeroCartao: null,
        cAut: null,
        cnpj_instituicao: null,
        tarifa: null,
        tarifaFixa: null,
        prazoRecebimento: null,
      },
      cheque: null,
      descricaoPagamento: null,
      valor: 20,
      parcelas: 1,
      juros: null,
      tarifas: null,
      aVista: true,
      duplicata: false,
      nFat: null,
      vencimento: null,
      ultimaModificacao: NOW_US,
      lastProviderUpdate: WATERMARK_US,
      dataCancelamento: null,
      dataAprovacao: WATERMARK_US,
      dataCadastro: WATERMARK_US,
    });
    expect(r.statusFinal).toBe(STATUS_PAGAMENTO.aprovado);
    expect(r.incidentes).toEqual([]);
  });

  it('★ the card block on 3/4/17 even with every Amazon field absent; Pix never carries a brand; boleto and 99 none', () => {
    const pix = corpoDe(
      montar(
        null,
        entrada({ execucoes: legs(execucaoAmazon('Pix', '20.00', { cardBrand: 'Visa' })) }),
      ),
    );
    expect(pix.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    expect(pix.cartao).toMatchObject({ tpIntegra: '2', bandeira: null });
    const cartao = corpoDe(
      montar(
        null,
        entrada({ execucoes: legs(execucaoAmazon('CreditCard', '20.00', { cardBrand: 'Visa' })) }),
      ),
    );
    expect(cartao.cartao).toMatchObject({ bandeira: BANDEIRA.visa });
    const boleto = corpoDe(
      montar(null, entrada({ execucoes: legs(execucaoAmazon('Boleto', '20.00')) })),
    );
    expect(boleto.cartao).toBeNull();
    const outro = montar(null, entrada({ execucoes: legs(execucaoAmazon('GC', '20.00')) }));
    expect(corpoDe(outro)).toMatchObject({
      forma_de_pagamento: FORMA_PAGAMENTO.outros,
      descricaoPagamento: 'Amazon: GC',
      cartao: null,
    });
    expect(outro.incidentes).toEqual(['forma-pagamento-desconhecida']);
    // No execution at all on an approved order.
    const nenhuma = montar(null, entrada({ execucoes: [] }));
    expect(corpoDe(nenhuma)).toMatchObject({
      forma_de_pagamento: FORMA_PAGAMENTO.outros,
      descricaoPagamento: DESCRICAO_FORMA_NAO_INFORMADA_AMAZON,
    });
    expect(nenhuma.incidentes).toContain('forma-pagamento-desconhecida');
  });

  it('★ the acquirer: a valid punctuated CNPJ ⇒ its 14 digits; a root, a CPF, one wrong digit ⇒ null + ONE count event, never the value', () => {
    const cnpj = gerarCnpj('112223330001');
    const ok = montar(
      null,
      entrada({
        execucoes: legs(
          execucaoAmazon('CreditCard', '20.00', {
            acquirerId: pontuarCnpj(cnpj),
            authorizationCode: ' 000123 ',
          }),
        ),
      }),
    );
    expect(corpoDe(ok).cartao).toMatchObject({ cnpj_instituicao: cnpj, cAut: '000123' });
    expect(ok.eventos).toEqual([]);
    const errado = `${cnpj.slice(0, 13)}${String((Number(cnpj[13]) + 1) % 10)}`;
    for (const recusado of [cnpj.slice(0, 8), gerarCpf(), errado]) {
      const r = montar(
        null,
        entrada({
          execucoes: legs(execucaoAmazon('CreditCard', '20.00', { acquirerId: recusado })),
        }),
      );
      expect(corpoDe(r).cartao).toMatchObject({ cnpj_instituicao: null });
      expect(r.eventos).toEqual(['cnpj-instituicao-recusado']);
      expect(JSON.stringify(r)).not.toContain(recusado);
    }
    // Absent is not refused (NEAR-MISS).
    expect(montar(null).eventos).toEqual([]);
  });

  it('★ split legs ⇒ ONE document, the largest leg’s forma, pagamento-dividido; another array order ⇒ the SAME document', () => {
    const a = execucaoAmazon('CreditCard', '5.00', { authorizationCode: 'A1' });
    const b = execucaoAmazon('Pix', '15.00', { authorizationCode: 'B1' });
    const ab = montar(null, entrada({ execucoes: legs(a, b) }));
    const ba = montar(null, entrada({ execucoes: legs(b, a) }));
    expect(corpoDe(ab).forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    expect(ab).toEqual(ba);
    expect(ab.incidentes).toEqual(['pagamento-dividido']);
  });

  it('★ never a pagamento on a PENDING order, a reversal, or a cancellation with none stored', () => {
    expect(montar(null, entrada({ alvo: { tipo: 'manter' } })).escrita).toEqual({ tipo: 'nada' });
    expect(
      montar(
        null,
        entrada({
          alvo: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
          cancelamento: true,
        }),
      ).escrita,
    ).toEqual({ tipo: 'nada' });
    // A D17 block forbids every write, and files nothing.
    expect(montar(null, null)).toEqual({
      escrita: { tipo: 'nada' },
      statusFinal: null,
      incidentes: [],
      eventos: [],
    });
  });

  it('★ an approved create whose TOTAL cannot be read (valor null) ⇒ no pagamento, no status claimed, and pagamento-divergente — never a silent approved pedido without one', () => {
    const r = montar(
      null,
      entrada({
        valor: null,
        execucoes: legs(
          execucaoAmazon('CreditCard', '10.00', { acquirerId: '12345678' }),
          execucaoAmazon('Pix', '10.00'),
        ),
      }),
    );
    expect(r).toEqual({
      escrita: { tipo: 'nada' },
      statusFinal: null,
      // Nothing was written, so nothing about a written pagamento is filed.
      incidentes: ['pagamento-divergente'],
      eventos: [],
    });
    // NEAR-MISS: a readable total creates it.
    expect(montar(null, entrada()).escrita.tipo).toBe('criar');
    // And a target that creates nothing files nothing.
    expect(montar(null, entrada({ valor: null, alvo: { tipo: 'manter' } })).incidentes).toEqual([]);
  });

  it('the money arm of pagamento-divergente rides the derived valor', () => {
    expect(montar(null, entrada({ valor: { valor: 20, divergente: true } })).incidentes).toEqual([
      'pagamento-divergente',
    ]);
  });
});

describe('the UPDATE', () => {
  const GUARDADO = {
    id: ORDER,
    forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    cartao: {
      tpIntegra: '2',
      bandeira: null,
      numeroCartao: null,
      cAut: null,
      cnpj_instituicao: null,
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
    },
    valor: 20,
    dataAprovacao: WATERMARK_US - 1,
    dataCadastro: WATERMARK_US - 1,
    dataCancelamento: null,
    lastProviderUpdate: WATERMARK_US - 1,
    ultimaModificacao: NOW_US - 1,
  };

  it('★ an unchanged order ⇒ NOTHING (an empty patch is never written; no stamp alone)', () => {
    expect(montar({ ...GUARDADO }).escrita).toEqual({ tipo: 'nada' });
  });

  it('★ a 99 never overwrites a stored known forma; a known one upgrades a stored 99 (NEAR-MISS pair)', () => {
    const pix = { ...GUARDADO, forma_de_pagamento: FORMA_PAGAMENTO.pix };
    const veio99 = montar(pix, entrada({ execucoes: legs(execucaoAmazon('GC', '20.00')) }));
    expect(veio99.escrita).toEqual({ tipo: 'nada' });
    expect(veio99.incidentes).toEqual([]);
    const migrado99 = {
      ...GUARDADO,
      forma_de_pagamento: FORMA_PAGAMENTO.outros,
      descricaoPagamento: 'x',
      cartao: null,
    };
    const veioPix = patchDe(
      montar(migrado99, entrada({ execucoes: legs(execucaoAmazon('Pix', '20.00')) })),
    );
    expect(veioPix.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    expect(veioPix.cartao).toMatchObject({ tpIntegra: '2', bandeira: null });
    expect(veioPix.lastProviderUpdate).toBe(WATERMARK_US);
    expect(veioPix.ultimaModificacao).toBe(NOW_US);
  });

  it('★ the card overlay, PER SUBFIELD: a stored non-null subfield is kept while a null one is filled (never a whole-block fill-once)', () => {
    const cnpjGuardado = gerarCnpj('998887770001');
    const cnpjNovo = gerarCnpj('112223330001');
    const guardado = {
      ...GUARDADO,
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
      cartao: { ...GUARDADO.cartao, cnpj_instituicao: cnpjGuardado },
    };
    const p = patchDe(
      montar(
        guardado,
        entrada({
          execucoes: legs(
            execucaoAmazon('Pix', '20.00', { acquirerId: cnpjNovo, authorizationCode: 'AUT1' }),
          ),
        }),
      ),
    );
    expect(p.cartao).toMatchObject({ cnpj_instituicao: cnpjGuardado, cAut: 'AUT1' });
    // Nothing to fill ⇒ no write.
    const cheio = {
      ...guardado,
      cartao: { ...guardado.cartao, cAut: 'AUT0' },
    };
    expect(
      montar(
        cheio,
        entrada({
          execucoes: legs(
            execucaoAmazon('Pix', '20.00', { acquirerId: cnpjNovo, authorizationCode: 'AUT1' }),
          ),
        }),
      ).escrita,
    ).toEqual({ tipo: 'nada' });
  });

  it('★ ONE instrument per block: a known forma replacing a DIFFERENT stored one replaces the block whole (never another instrument’s brand, CNPJ or cAut), or drops it for a forma without one', () => {
    const cnpjCartao = gerarCnpj('998887770001');
    const cnpjPix = gerarCnpj('112223330001');
    const cartaoVisa = {
      ...GUARDADO.cartao,
      bandeira: BANDEIRA.visa,
      cAut: 'AUT-CARTAO',
      cnpj_instituicao: cnpjCartao,
    };
    const credito = { ...GUARDADO, cartao: cartaoVisa };
    const pix = patchDe(
      montar(
        credito,
        entrada({
          execucoes: legs(
            execucaoAmazon('Pix', '20.00', { acquirerId: cnpjPix, authorizationCode: 'AUT-PIX' }),
          ),
        }),
      ),
    );
    expect(pix.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    expect(pix.cartao).toEqual({
      ...GUARDADO.cartao,
      bandeira: null,
      cAut: 'AUT-PIX',
      cnpj_instituicao: cnpjPix,
    });
    const boleto = patchDe(
      montar(credito, entrada({ execucoes: legs(execucaoAmazon('Boleto', '20.00')) })),
    );
    expect(boleto).toMatchObject({ forma_de_pagamento: FORMA_PAGAMENTO.boleto_bancario });
    expect(boleto.cartao).toBeNull();
    // The other direction: a stored Pix block never lends its cAut or CNPJ to a card.
    const guardadoPix = {
      ...GUARDADO,
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
      cartao: { ...GUARDADO.cartao, cAut: 'PIXAUT', cnpj_instituicao: cnpjPix },
    };
    const veioCartao = patchDe(
      montar(
        guardadoPix,
        entrada({
          execucoes: legs(
            execucaoAmazon('CreditCard', '20.00', {
              cardBrand: 'Visa',
              authorizationCode: 'CCAUT',
            }),
          ),
        }),
      ),
    );
    expect(veioCartao.cartao).toEqual({
      ...GUARDADO.cartao,
      bandeira: BANDEIRA.visa,
      cAut: 'CCAUT',
      cnpj_instituicao: null,
    });
    // NEAR-MISS: the SAME instrument keeps the per-subfield overlay (operator-edit-wins).
    const mesmo = patchDe(
      montar(
        { ...credito, cartao: { ...cartaoVisa, cnpj_instituicao: null } },
        entrada({
          execucoes: legs(
            execucaoAmazon('CreditCard', '20.00', {
              cardBrand: 'Mastercard',
              acquirerId: cnpjPix,
              authorizationCode: 'OUTRO',
            }),
          ),
        }),
      ),
    );
    expect(mesmo.cartao).toEqual({ ...cartaoVisa, cnpj_instituicao: cnpjPix });
    // A forma without a block replacing another one without a block: nothing to drop.
    const outroSemBloco = { ...GUARDADO, forma_de_pagamento: FORMA_PAGAMENTO.outros, cartao: null };
    const p = patchDe(
      montar(outroSemBloco, entrada({ execucoes: legs(execucaoAmazon('Boleto', '20.00')) })),
    );
    expect(p.forma_de_pagamento).toBe(FORMA_PAGAMENTO.boleto_bancario);
    expect(Object.hasOwn(p, 'cartao')).toBe(false);
  });

  it('★ a stored 3/4/17 WITHOUT a block, kept under an unknown method, still gets the builder’s block (a missing one is cStat 391); a stored 15 gets none', () => {
    const semBloco = { ...GUARDADO, cartao: null };
    const p = patchDe(
      montar(
        semBloco,
        entrada({
          execucoes: legs(
            execucaoAmazon('Other', '20.00', { cardBrand: 'Visa', authorizationCode: 'X' }),
          ),
        }),
      ),
    );
    expect(Object.hasOwn(p, 'forma_de_pagamento')).toBe(false);
    // The builder's block for the KEPT forma, with no field of the unknown leg.
    expect(p.cartao).toEqual(GUARDADO.cartao);
    const boleto = montar(
      { ...semBloco, forma_de_pagamento: FORMA_PAGAMENTO.boleto_bancario },
      entrada({ execucoes: legs(execucaoAmazon('Other', '20.00')) }),
    );
    expect(boleto.escrita).toEqual({ tipo: 'nada' });
  });

  it('a stored card block the card schema would REWRITE is left alone', () => {
    const estranho = { ...GUARDADO, cartao: { ...GUARDADO.cartao, bandeira: 'zz' } };
    expect(
      montar(
        estranho,
        entrada({
          execucoes: legs(execucaoAmazon('CreditCard', '20.00', { authorizationCode: 'AUT1' })),
        }),
      ).escrita,
    ).toEqual({ tipo: 'nada' });
  });

  it('★ valor by mode: espelhar writes the derived one but a 0 never replaces a stored positive; preencher fills only a non-positive one; manter never touches it', () => {
    const v = (modoValor: EntradaPagamentoAmazon['modoValor'], valor: number, guardado: unknown) =>
      montar(
        { ...GUARDADO, valor: guardado },
        entrada({ modoValor, valor: { valor, divergente: false } }),
      ).escrita;
    expect(v('espelhar', 25, 20)).toMatchObject({ tipo: 'atualizar', patch: { valor: 25 } });
    expect(v('espelhar', 0, 20)).toEqual({ tipo: 'nada' });
    expect(v('preencher', 25, 20)).toEqual({ tipo: 'nada' });
    expect(v('preencher', 25, 0)).toMatchObject({ patch: { valor: 25 } });
    expect(v('preencher', 25, 'x')).toMatchObject({ patch: { valor: 25 } });
    expect(v('manter', 25, 0)).toEqual({ tipo: 'nada' });
    // Centavos, never floats: a legacy 19.999999999999996 is 20.00.
    expect(v('espelhar', 20, 19.999999999999996)).toEqual({ tipo: 'nada' });
  });

  it('★ CANCELLED on a stored aprovado ⇒ estornado + dataCancelamento (fill-once); the valor never touched', () => {
    const r = montar(
      { ...GUARDADO },
      entrada({
        alvo: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
        cancelamento: true,
        modoValor: 'manter',
        valor: { valor: 0, divergente: true },
      }),
    );
    expect(patchDe(r)).toEqual({
      status_pagamento: STATUS_PAGAMENTO.estornado,
      dataCancelamento: WATERMARK_US,
      lastProviderUpdate: WATERMARK_US,
      ultimaModificacao: NOW_US,
    });
    expect(r.statusFinal).toBe(STATUS_PAGAMENTO.estornado);
    // Not live ⇒ no payment incidente on a cancellation.
    expect(r.incidentes).toEqual([]);
    // A stamp already there is kept.
    const jaCancelado = montar(
      { ...GUARDADO, status_pagamento: STATUS_PAGAMENTO.estornado, dataCancelamento: 7 },
      entrada({ alvo: { tipo: 'status', status: STATUS_PAGAMENTO.estornado }, cancelamento: true }),
    );
    expect(jaCancelado.escrita).toEqual({ tipo: 'nada' });
  });

  it('★ dataCancelamento never beside aprovado; dataAprovacao fill-once and never re-stamped', () => {
    const semDatas = { ...GUARDADO, dataAprovacao: null, dataCancelamento: null };
    const p = patchDe(montar(semDatas));
    expect(p.dataAprovacao).toBe(WATERMARK_US);
    expect(Object.hasOwn(p, 'dataCancelamento')).toBe(false);
    // A stored one is kept.
    expect(montar({ ...GUARDADO, dataAprovacao: 5 }).escrita).toEqual({ tipo: 'nada' });
  });

  it('★ estornado → aprovado (the pedido resurrected) only on a strictly newer clock, logged', () => {
    const estornado = { ...GUARDADO, status_pagamento: STATUS_PAGAMENTO.estornado };
    const novo = montar(estornado, entrada({ maisNovo: true }));
    expect(patchDe(novo).status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(novo.eventos).toEqual(['pagamento-ressuscitado']);
    expect(montar(estornado, entrada({ maisNovo: false })).escrita).toEqual({ tipo: 'nada' });
  });

  it('★ a resurrection clears dataCancelamento (never a cancellation stamp beside aprovado), so a LATER cancellation stamps its own clock', () => {
    const cancelado = {
      ...GUARDADO,
      status_pagamento: STATUS_PAGAMENTO.estornado,
      dataCancelamento: WATERMARK_US - 5,
    };
    const ressuscitado = patchDe(montar(cancelado, entrada({ maisNovo: true })));
    expect(ressuscitado).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      dataCancelamento: null,
    });
    const reCancelado = patchDe(
      montar(
        { ...cancelado, ...ressuscitado },
        entrada({
          watermarkUs: WATERMARK_US + 9,
          alvo: { tipo: 'status', status: STATUS_PAGAMENTO.estornado },
          cancelamento: true,
          modoValor: 'manter',
        }),
      ),
    );
    expect(reCancelado.dataCancelamento).toBe(WATERMARK_US + 9);
    // NEAR-MISS: a resurrection over no stamp writes none.
    const semCarimbo = patchDe(
      montar({ ...cancelado, dataCancelamento: null }, entrada({ maisNovo: true })),
    );
    expect(Object.hasOwn(semCarimbo, 'dataCancelamento')).toBe(false);
  });

  it('★ an operator’s status is never moved, and nothing else of the pagamento is touched', () => {
    for (const status of [STATUS_PAGAMENTO.recusado, STATUS_PAGAMENTO.em_disputa]) {
      const r = montar(
        { ...GUARDADO, status_pagamento: status, forma_de_pagamento: FORMA_PAGAMENTO.outros },
        entrada({ valor: { valor: 99, divergente: true } }),
      );
      expect(r.escrita).toEqual({ tipo: 'nada' });
      expect(r.statusFinal).toBe(status);
      expect(r.incidentes).toEqual([]);
    }
  });
});
