import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import {
  CODIGO_ERRO_LI,
  CODIGO_SITUACAO_LI,
  type CodigoErroLi,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
} from './client';
import {
  ACAO_HARD_DO_CODIGO_LI,
  ACAO_IMPRESSAO_DO_CODIGO_LI,
  VALIDADE_CONFERENCIA_LI_MS,
  conferirAntesDeImprimirLi,
  conferirPagamentoLi,
  decidirConferenciaImpressaoLi,
  decidirConferenciaPagamentoLi,
  ehPedidoImportadoDaLojaIntegrada,
  mensagemBloqueioConferenciaLi,
  mensagemConfirmacaoConferenciaLi,
  type ConferenciaPagamentoLi,
} from './conferenciaPagamento';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

/**
 * The web half of the Loja Integrada paid re-check (master plan step 15): the
 * identity hash that decides whether any gate runs, the two decision tables
 * (hard: the checkout save and the Melhor Envio buy; soft: a reprint and a
 * generic label), and the soft gate the label providers call.
 *
 * Every table is pinned with its EQUAL and NEAR-MISS pairs: a gate that folds
 * too much lets an unpaid order ship, one that folds too little nags every
 * Mercado Livre order with a Loja Integrada dialog.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const CONTA = 'CONTA1';
const ID_LI = sha256(`lojaIntegrada${CONTA}-165`);
const PEDIDO_LI = { integracaoPedidoOuterRef: `documents/integracao/${CONTA}`, numero: '165' };

const PAGO: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: 'loja',
  veredito: 'pago',
  codigo: CODIGO_SITUACAO_LI.pedidoPago,
  motivoContestacao: null,
  conferidoEmMs: 1_790_000_000_000,
  correlationId: null,
};
const NAO_PAGO: RespostaConferenciaPagamentoLi = {
  ...PAGO,
  veredito: 'nao-pago',
  codigo: CODIGO_SITUACAO_LI.pagamentoEmDisputa,
  motivoContestacao: 'disputa',
};
const DESCONHECIDO: RespostaConferenciaPagamentoLi = {
  ...PAGO,
  veredito: 'desconhecido',
  codigo: 'situacao_nova',
};
const ESPELHO: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: 'erp',
  veredito: 'contestado',
  codigo: null,
  motivoContestacao: 'chargeback',
  conferidoEmMs: null,
  correlationId: null,
};
const NAO_APLICAVEL: RespostaConferenciaPagamentoLi = {
  aplicavel: false,
  motivo: 'nao-importado',
};

const resposta = (r: RespostaConferenciaPagamentoLi, recebidoEm = 0): ConferenciaPagamentoLi => ({
  tipo: 'resposta',
  pedidoId: ID_LI,
  resposta: r,
  recebidoEm,
});
const codigo = (c: CodigoErroLi): ConferenciaPagamentoLi => ({
  tipo: 'falha',
  falha: { tipo: 'codigo', codigo: c },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                              The identity hash                              */
/* -------------------------------------------------------------------------- */

describe('ehPedidoImportadoDaLojaIntegrada — the web identity check', () => {
  it("the web digest equals node's sha256 for the master plan's vector", async () => {
    expect(ID_LI).toBe('60fe37ac35667bf3d56a8cb3a015114133ce02dad6d7338ac5db4f421413e532');
    await expect(ehPedidoImportadoDaLojaIntegrada(ID_LI, PEDIDO_LI)).resolves.toBe(true);
  });

  it('EQUAL pair: a numeric numero and its decimal string; the bare conta ref and its documents/ form', async () => {
    await expect(
      ehPedidoImportadoDaLojaIntegrada(ID_LI, { ...PEDIDO_LI, numero: 165 as never }),
    ).resolves.toBe(true);
    await expect(
      ehPedidoImportadoDaLojaIntegrada(ID_LI, {
        ...PEDIDO_LI,
        integracaoPedidoOuterRef: `integracao/${CONTA}`,
      }),
    ).resolves.toBe(true);
  });

  it("⚠️ NEAR-MISS: a duplicate's null numero, a padded numero, another conta and another collection are NOT imported", async () => {
    const casos = [
      { ...PEDIDO_LI, numero: null },
      { ...PEDIDO_LI, numero: '0165' },
      { ...PEDIDO_LI, numero: '165.0' },
      { ...PEDIDO_LI, integracaoPedidoOuterRef: 'documents/integracao/CONTA2' },
      { ...PEDIDO_LI, integracaoPedidoOuterRef: `documents/clientes/${CONTA}` },
      { ...PEDIDO_LI, integracaoPedidoOuterRef: null },
      {},
    ];
    for (const pedido of casos) {
      await expect(
        ehPedidoImportadoDaLojaIntegrada(ID_LI, pedido as never),
        JSON.stringify(pedido),
      ).resolves.toBe(false);
    }
  });

  it("⚠️ NEAR-MISS: another channel's spelling of the same order, and an uppercase digest, are NOT this pedido", async () => {
    await expect(
      ehPedidoImportadoDaLojaIntegrada(sha256(`mercadoLivre${CONTA}-165`), PEDIDO_LI),
    ).resolves.toBe(false);
    await expect(ehPedidoImportadoDaLojaIntegrada(sha256(`${CONTA}-165`), PEDIDO_LI)).resolves.toBe(
      false,
    );
    await expect(ehPedidoImportadoDaLojaIntegrada(ID_LI.toUpperCase(), PEDIDO_LI)).resolves.toBe(
      false,
    );
  });

  it('a page without WebCrypto (an insecure origin) checks anyway — the route decides the identity itself', async () => {
    vi.stubGlobal('crypto', {});
    await expect(ehPedidoImportadoDaLojaIntegrada('qualquer', PEDIDO_LI)).resolves.toBe(true);
    // …but only for a pedido that COULD be an import: no preimage, no call.
    await expect(
      ehPedidoImportadoDaLojaIntegrada('qualquer', { ...PEDIDO_LI, numero: null }),
    ).resolves.toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                            The two decision tables                          */
/* -------------------------------------------------------------------------- */

const NAO_AUTORIZADOS: readonly CodigoErroLi[] = [
  CODIGO_ERRO_LI.pedidoDivergente,
  CODIGO_ERRO_LI.pedidoAusenteNaLoja,
  CODIGO_ERRO_LI.pedidoNaoEncontrado,
];
const DE_CONFIGURACAO: readonly CodigoErroLi[] = [
  CODIGO_ERRO_LI.chamadasDesligadas,
  CODIGO_ERRO_LI.reconexaoPendente,
  CODIGO_ERRO_LI.contaInativa,
  CODIGO_ERRO_LI.contaNaoEncontrada,
  CODIGO_ERRO_LI.credencialAusente,
  CODIGO_ERRO_LI.credencialInvalida,
  CODIGO_ERRO_LI.credencialAlterada,
];
const TODOS: readonly CodigoErroLi[] = Object.values(CODIGO_ERRO_LI);

describe('the code tables are TOTAL over CodigoErroLi', () => {
  it('each table has exactly one row per code — no more, no fewer', () => {
    expect(Object.keys(ACAO_HARD_DO_CODIGO_LI).sort()).toEqual([...TODOS].sort());
    expect(Object.keys(ACAO_IMPRESSAO_DO_CODIGO_LI).sort()).toEqual([...TODOS].sort());
  });

  it.each(TODOS)(
    '%s — hard and soft agree: a block is the checkbox, a confirm is the SAME confirm',
    (c) => {
      const hard = ACAO_HARD_DO_CODIGO_LI[c];
      const soft = ACAO_IMPRESSAO_DO_CODIGO_LI[c];
      // ⭐ The soft column never asks MORE than the hard one: the checkbox
      // replaces exactly the block, and an unverifiable answer is the same A1
      // confirm at every gate.
      if (hard === 'bloquear') expect(soft).toBe('ciente');
      else expect(soft).toBe(hard);
    },
  );

  it('the not-authorised codes block; the configuration codes confirm as configuration; every other code is transient', () => {
    for (const c of TODOS) {
      const esperado = NAO_AUTORIZADOS.includes(c)
        ? 'bloquear'
        : DE_CONFIGURACAO.includes(c)
          ? 'confirmar-configuracao'
          : 'confirmar-transitorio';
      expect(ACAO_HARD_DO_CODIGO_LI[c], c).toBe(esperado);
    }
  });
});

describe('decidirConferenciaPagamentoLi (hard) and decidirConferenciaImpressaoLi (soft)', () => {
  it('not identified, not applicable and a live `pago` all proceed — hard and soft alike', () => {
    for (const desfecho of [
      { tipo: 'nao-identificado' } as const,
      resposta(NAO_APLICAVEL),
      resposta(PAGO),
    ]) {
      expect(decidirConferenciaPagamentoLi(desfecho)).toEqual({ acao: 'prosseguir' });
      expect(decidirConferenciaImpressaoLi(desfecho)).toEqual({ acao: 'imprimir' });
    }
  });

  it('`nao-pago` blocks naming the situação by its label; the soft gate asks the checkbox with the SAME line', () => {
    const hard = decidirConferenciaPagamentoLi(resposta(NAO_PAGO));
    const soft = decidirConferenciaImpressaoLi(resposta(NAO_PAGO));

    expect(hard).toEqual({
      acao: 'bloquear',
      linha: 'A Loja Integrada mostra este pedido como "Pagamento em disputa", não como pago.',
    });
    expect(soft).toEqual({ acao: 'ciente', linha: hard.acao === 'bloquear' ? hard.linha : '' });
  });

  it('`desconhecido` blocks naming the raw codigo', () => {
    expect(decidirConferenciaPagamentoLi(resposta(DESCONHECIDO))).toEqual({
      acao: 'bloquear',
      linha: 'A Loja Integrada devolveu uma situação que o ERP não conhece (situacao_nova).',
    });
  });

  it("the ERP mirror's `contestado` blocks with the aviso's own phrase for the motivo", () => {
    expect(decidirConferenciaPagamentoLi(resposta(ESPELHO))).toEqual({
      acao: 'bloquear',
      linha:
        'O pagamento deste pedido está contestado (o comprador contestou a cobrança junto ao ' +
        'emissor do cartão (chargeback)).',
    });
    // A motivo this build does not know reads as null on the wire: still a block.
    expect(
      decidirConferenciaPagamentoLi(resposta({ ...ESPELHO, motivoContestacao: null })).acao,
    ).toBe('bloquear');
  });

  it('⚠️ NEAR-MISS: a 404 WITH the envelope blocks (pedido not found); WITHOUT it is the older-backend confirm', () => {
    expect(decidirConferenciaPagamentoLi(codigo(CODIGO_ERRO_LI.pedidoNaoEncontrado)).acao).toBe(
      'bloquear',
    );
    expect(
      decidirConferenciaPagamentoLi({ tipo: 'falha', falha: { tipo: 'backend-desatualizado' } }),
    ).toEqual({
      acao: 'confirmar',
      classe: 'configuracao',
      causa: 'o backend da Loja Integrada ainda não oferece esta conferência',
    });
  });

  it('the switch off is configuration, never a verdict — and the soft gate asks the same confirm', () => {
    const esperado = {
      acao: 'confirmar',
      classe: 'configuracao',
      causa: 'a chave de chamadas está desligada',
    };
    expect(decidirConferenciaPagamentoLi(codigo(CODIGO_ERRO_LI.chamadasDesligadas))).toEqual(
      esperado,
    );
    expect(decidirConferenciaImpressaoLi(codigo(CODIGO_ERRO_LI.chamadasDesligadas))).toEqual(
      esperado,
    );
  });

  it('the transport outcomes: no client and an unparseable answer are configuration; the network, the deadline, a bare 5xx and an unknown code are transient', () => {
    const casos: ReadonlyArray<[ConferenciaPagamentoLi, 'configuracao' | 'transitorio']> = [
      [{ tipo: 'falha', falha: { tipo: 'sem-cliente' } }, 'configuracao'],
      [{ tipo: 'falha', falha: { tipo: 'sem-permissao' } }, 'configuracao'],
      [{ tipo: 'falha', falha: { tipo: 'resposta-invalida' } }, 'configuracao'],
      [{ tipo: 'falha', falha: { tipo: 'rede' } }, 'transitorio'],
      [{ tipo: 'falha', falha: { tipo: 'tempo-esgotado' } }, 'transitorio'],
      [{ tipo: 'falha', falha: { tipo: 'sessao' } }, 'transitorio'],
      [{ tipo: 'falha', falha: { tipo: 'http', status: 500, codigo: null } }, 'transitorio'],
      [{ tipo: 'falha', falha: { tipo: 'http', status: 418, codigo: 'LI_NOVO' } }, 'transitorio'],
    ];
    for (const [desfecho, classe] of casos) {
      const hard = decidirConferenciaPagamentoLi(desfecho);
      expect(hard.acao, JSON.stringify(desfecho)).toBe('confirmar');
      expect(hard.acao === 'confirmar' && hard.classe, JSON.stringify(desfecho)).toBe(classe);
      expect(decidirConferenciaImpressaoLi(desfecho)).toEqual(hard);
    }
  });
});

describe('the copy — one source for every gate', () => {
  it('a block names the gate it stopped', () => {
    const linha = 'A Loja Integrada devolveu outro pedido. Confira a credencial da conta.';
    expect(mensagemBloqueioConferenciaLi(linha, 'checkout')).toBe(
      `${linha} O checkout não foi salvo.`,
    );
    expect(mensagemBloqueioConferenciaLi(linha, 'comprar')).toBe(
      `${linha} A compra da etiqueta foi bloqueada.`,
    );
    expect(mensagemBloqueioConferenciaLi(linha, 'cadeia')).toBe(
      `${linha} A compra da etiqueta foi bloqueada; o checkout e a NF-e já foram salvos.`,
    );
  });

  it('the two confirms say which class the failure is', () => {
    expect(mensagemConfirmacaoConferenciaLi({ classe: 'configuracao', causa: 'x' })).toBe(
      'A conferência de pagamento na Loja Integrada não está disponível (x): é configuração da ' +
        'conta, não instabilidade. Deseja continuar mesmo assim?',
    );
    expect(mensagemConfirmacaoConferenciaLi({ classe: 'transitorio', causa: 'y' })).toBe(
      'A Loja Integrada não respondeu à conferência de pagamento (y). Deseja continuar mesmo assim?',
    );
  });

  it.each(TODOS)('%s has its own cause line (never empty, never the raw code alone)', (c) => {
    const d = decidirConferenciaPagamentoLi(codigo(c));
    const texto = d.acao === 'confirmar' ? d.causa : d.acao === 'bloquear' ? d.linha : '';
    expect(texto.length).toBeGreaterThan(0);
    expect(texto).not.toBe(c);
  });
});

/* -------------------------------------------------------------------------- */
/*                            One call, one outcome                            */
/* -------------------------------------------------------------------------- */

describe('conferirPagamentoLi — every way the call ends, as data', () => {
  const falhaDe = async (err: unknown) => {
    const client = lojaIntegradaClientFalso({ conferirPagamento: () => Promise.reject(err) });
    return conferirPagamentoLi(client, ID_LI);
  };

  it('stamps the answer with the pedido it was asked for and the CLIENT clock it arrived at', async () => {
    const client = lojaIntegradaClientFalso({ conferirPagamento: async () => PAGO });

    await expect(conferirPagamentoLi(client, ID_LI, { agora: () => 1234 })).resolves.toEqual({
      tipo: 'resposta',
      pedidoId: ID_LI,
      resposta: PAGO,
      recebidoEm: 1234,
    });
  });

  it('no client is its own outcome, with no call', async () => {
    await expect(conferirPagamentoLi(null, ID_LI)).resolves.toEqual({
      tipo: 'falha',
      falha: { tipo: 'sem-cliente' },
    });
  });

  it('maps each client error to its outcome — the subclasses narrowed first', async () => {
    const casos: ReadonlyArray<[unknown, unknown]> = [
      [
        new LojaIntegradaClientHttpError('x', 503, CODIGO_ERRO_LI.chamadasDesligadas),
        { tipo: 'codigo', codigo: CODIGO_ERRO_LI.chamadasDesligadas },
      ],
      [new LojaIntegradaClientHttpError('x', 404, null), { tipo: 'backend-desatualizado' }],
      [new LojaIntegradaClientHttpError('x', 403, null), { tipo: 'sem-permissao' }],
      [new LojaIntegradaClientHttpError('x', 401, 'auth/x'), { tipo: 'sem-permissao' }],
      [
        new LojaIntegradaClientHttpError('x', 502, null),
        { tipo: 'http', status: 502, codigo: null },
      ],
      [
        new LojaIntegradaClientHttpError('x', 409, 'LI_CODIGO_NOVO'),
        { tipo: 'http', status: 409, codigo: 'LI_CODIGO_NOVO' },
      ],
      [
        new LojaIntegradaClientRespostaInvalidaError('x', 200, ['tipo']),
        { tipo: 'resposta-invalida' },
      ],
      [new LojaIntegradaClientTempoEsgotadoError(), { tipo: 'tempo-esgotado' }],
      [new LojaIntegradaClientNetworkError(), { tipo: 'rede' }],
      [new FirebaseError('auth/network-request-failed', 'x'), { tipo: 'sessao' }],
    ];
    for (const [err, falha] of casos) {
      await expect(falhaDe(err), String(err)).resolves.toEqual({ tipo: 'falha', falha });
    }
  });

  it('⚠️ NEAR-MISS: a 404 carrying a known code is THAT code, never the older backend', async () => {
    await expect(
      falhaDe(new LojaIntegradaClientHttpError('x', 404, CODIGO_ERRO_LI.pedidoNaoEncontrado)),
    ).resolves.toEqual({
      tipo: 'falha',
      falha: { tipo: 'codigo', codigo: CODIGO_ERRO_LI.pedidoNaoEncontrado },
    });
  });

  it("anything else is rethrown (rule 6) — a bug, and the caller's own abort", async () => {
    const bug = new RangeError('bug');
    await expect(falhaDe(bug)).rejects.toBe(bug);
    const abort = new DOMException('aborted', 'AbortError');
    await expect(falhaDe(abort)).rejects.toBe(abort);
  });
});

/* -------------------------------------------------------------------------- */
/*                           The soft gate, end to end                         */
/* -------------------------------------------------------------------------- */

describe('conferirAntesDeImprimirLi — the soft gate', () => {
  function cenario(responder: () => Promise<RespostaConferenciaPagamentoLi>) {
    const conferirPagamento = vi.fn(responder);
    const confirmRisk = vi.fn(async (_msg: string) => true);
    const confirmarCiente = vi.fn(async (_p: { titulo: string; mensagem: string }) => true);
    return {
      conferirPagamento,
      confirmRisk,
      confirmarCiente,
      args: {
        client: lojaIntegradaClientFalso({ conferirPagamento }),
        pedidoId: ID_LI,
        pedido: PEDIDO_LI,
        ui: { confirmRisk, confirmarCiente },
        ato: 'etiqueta-generica' as const,
      },
    };
  }

  it('`nao-pago` asks the checkbox — never the A1 confirm — and follows the answer', async () => {
    const s = cenario(async () => NAO_PAGO);

    s.confirmarCiente.mockResolvedValueOnce(false);
    await expect(conferirAntesDeImprimirLi(s.args)).resolves.toBe('cancelado');
    s.confirmarCiente.mockResolvedValueOnce(true);
    await expect(conferirAntesDeImprimirLi(s.args)).resolves.toBe('prosseguir');

    expect(s.confirmarCiente).toHaveBeenCalledTimes(2);
    expect(s.confirmRisk).not.toHaveBeenCalled();
    expect(s.confirmarCiente.mock.calls[0]).toEqual([
      {
        // The title names the pedido: on /pedidos the question queues behind
        // other pedidos' and opens seconds after the click.
        titulo: 'Pedido 165 — Pagamento não confirmado na Loja Integrada',
        mensagem:
          'A Loja Integrada mostra este pedido como "Pagamento em disputa", não como pago. ' +
          'Imprimir a etiqueta deste pedido pode levar ao despacho de um pedido que não deveria ' +
          'sair. Você pode continuar, mas o pedido pode não estar liberado para despacho.',
      },
    ]);
  });

  it('a reprint says so in the warning', async () => {
    const s = cenario(async () => NAO_PAGO);

    await conferirAntesDeImprimirLi({ ...s.args, ato: 'reimpressao' });

    expect(s.confirmarCiente.mock.calls[0]?.[0].mensagem).toContain(
      'Reimprimir a etiqueta deste pedido pode levar ao despacho',
    );
  });

  it('`pago` prints with no dialog at all', async () => {
    const s = cenario(async () => PAGO);

    await expect(conferirAntesDeImprimirLi(s.args)).resolves.toBe('prosseguir');

    expect(s.conferirPagamento).toHaveBeenCalledTimes(1);
    expect(s.confirmarCiente).not.toHaveBeenCalled();
    expect(s.confirmRisk).not.toHaveBeenCalled();
  });

  it('⭐ unverifiable asks the A1 confirm, NEVER the checkbox', async () => {
    const s = cenario(() =>
      Promise.reject(new LojaIntegradaClientHttpError('x', 503, CODIGO_ERRO_LI.chamadasDesligadas)),
    );

    s.confirmRisk.mockResolvedValueOnce(false);
    await expect(conferirAntesDeImprimirLi(s.args)).resolves.toBe('cancelado');
    await expect(conferirAntesDeImprimirLi(s.args)).resolves.toBe('prosseguir');

    expect(s.confirmarCiente).not.toHaveBeenCalled();
    expect(s.confirmRisk.mock.calls[0]?.[0]).toContain('a chave de chamadas está desligada');
  });

  it('both questions name their pedido — a queued question is never answered for the wrong order', async () => {
    const naoPago = cenario(async () => NAO_PAGO);
    await conferirAntesDeImprimirLi({ ...naoPago.args, pedido: { ...PEDIDO_LI, numero: 165 } });
    expect(naoPago.confirmarCiente.mock.calls[0]?.[0].titulo).toBe(
      'Pedido 165 — Pagamento não confirmado na Loja Integrada',
    );

    const desligado = cenario(() =>
      Promise.reject(new LojaIntegradaClientHttpError('x', 503, CODIGO_ERRO_LI.chamadasDesligadas)),
    );
    await conferirAntesDeImprimirLi(desligado.args);
    expect(desligado.confirmRisk.mock.calls[0]?.[0]).toBe(
      `Pedido 165: ${mensagemConfirmacaoConferenciaLi({
        classe: 'configuracao',
        causa: 'a chave de chamadas está desligada',
      })}`,
    );
  });

  it('no client is the configuration confirm, with no call', async () => {
    const s = cenario(async () => PAGO);

    await conferirAntesDeImprimirLi({ ...s.args, client: null });

    expect(s.confirmRisk).toHaveBeenCalledTimes(1);
    expect(s.confirmarCiente).not.toHaveBeenCalled();
  });

  it("⭐ a pedido that is not an imported order — a Mercado Livre one, or an LI order's duplicate — never calls", async () => {
    const s = cenario(async () => NAO_PAGO);

    await expect(
      conferirAntesDeImprimirLi({
        ...s.args,
        pedidoId: 'pedido-mercado-livre',
        pedido: { integracaoPedidoOuterRef: 'documents/integracao/ML1', numero: '2000001' },
      }),
    ).resolves.toBe('prosseguir');
    await expect(
      conferirAntesDeImprimirLi({ ...s.args, pedido: { ...PEDIDO_LI, numero: null } }),
    ).resolves.toBe('prosseguir');

    expect(s.conferirPagamento).not.toHaveBeenCalled();
    expect(s.confirmarCiente).not.toHaveBeenCalled();
  });

  describe('a `pago` carried along the checkout chain', () => {
    const carregada = (
      veredito: RespostaConferenciaPagamentoLi,
      recebidoEm: number,
      pedidoId: string = ID_LI,
    ) => ({
      tipo: 'resposta' as const,
      pedidoId,
      resposta: veredito,
      recebidoEm,
    });

    it('EQUAL: at 119 s it is reused — no call', async () => {
      const s = cenario(async () => NAO_PAGO);

      await expect(
        conferirAntesDeImprimirLi({
          ...s.args,
          conferenciaLi: carregada(PAGO, 0),
          agora: () => 119_000,
        }),
      ).resolves.toBe('prosseguir');

      expect(VALIDADE_CONFERENCIA_LI_MS).toBe(120_000);
      expect(s.conferirPagamento).not.toHaveBeenCalled();
    });

    it('⚠️ NEAR-MISS: at 121 s it is stale — one call, and its answer decides', async () => {
      const s = cenario(async () => NAO_PAGO);

      await conferirAntesDeImprimirLi({
        ...s.args,
        conferenciaLi: carregada(PAGO, 0),
        agora: () => 121_000,
      });

      expect(s.conferirPagamento).toHaveBeenCalledTimes(1);
      expect(s.confirmarCiente).toHaveBeenCalledTimes(1);
    });

    it("⚠️ NEAR-MISS: the age is the CLIENT's clock — a fresh server stamp does not make an old answer new", async () => {
      const s = cenario(async () => PAGO);

      await conferirAntesDeImprimirLi({
        ...s.args,
        conferenciaLi: carregada({ ...PAGO, conferidoEmMs: Date.now() }, 0),
        agora: () => 121_000,
      });

      expect(s.conferirPagamento).toHaveBeenCalledTimes(1);
    });

    it('⚠️ NEAR-MISS: a `pago` carried for ANOTHER pedido is never reused — one call, for THIS one', async () => {
      const s = cenario(async () => NAO_PAGO);
      const outroPedido = sha256(`lojaIntegrada${CONTA}-166`);

      await conferirAntesDeImprimirLi({
        ...s.args,
        conferenciaLi: carregada(PAGO, 0, outroPedido),
        agora: () => 10_000,
      });

      expect(s.conferirPagamento).toHaveBeenCalledTimes(1);
      expect(s.conferirPagamento).toHaveBeenCalledWith(ID_LI, undefined);
      expect(s.confirmarCiente).toHaveBeenCalledTimes(1);
    });

    it('⚠️ NEAR-MISS: only a `pago` is carried — a fresh `nao-pago` or a not-applicable answer is asked again', async () => {
      for (const r of [NAO_PAGO, NAO_APLICAVEL]) {
        const s = cenario(async () => PAGO);
        await conferirAntesDeImprimirLi({
          ...s.args,
          conferenciaLi: carregada(r, 0),
          agora: () => 1_000,
        });
        expect(s.conferirPagamento, JSON.stringify(r)).toHaveBeenCalledTimes(1);
      }
    });
  });
});
