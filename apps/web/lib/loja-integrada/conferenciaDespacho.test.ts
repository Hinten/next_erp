import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODIGO_ERRO_LI,
  CODIGO_SITUACAO_LI,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  createLojaIntegradaClient,
} from './client';
import { VALIDADE_CONFERENCIA_LI_MS, type ConferenciaLiCarregada } from './conferenciaPagamento';
import { conferirAntesDeDespacharLi } from './conferenciaDespacho';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

/**
 * The HARD gates of the Loja Integrada paid re-check (master plan step 15): the
 * checkout save and the Melhor Envio buy, which spend stock and money. The
 * decision table itself is `decidirConferenciaPagamentoLi`'s (pinned in
 * `conferenciaPagamento.test.ts`); this pins the RUN around it — who calls at
 * all, when a carried verdict stands in for a call, which copy each gate shows,
 * and that an answer which cannot be verified asks instead of blocking or
 * passing silently.
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
  codigo: CODIGO_SITUACAO_LI.aguardandoPagamento,
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
const NAO_APLICAVEL: RespostaConferenciaPagamentoLi = { aplicavel: false, motivo: 'nao-importado' };

/** A client whose ONE expected call answers `resposta` (or rejects with it). */
function clienteQueResponde(resposta: RespostaConferenciaPagamentoLi | Error) {
  const conferirPagamento = vi.fn((_pedidoId: string) =>
    resposta instanceof Error ? Promise.reject(resposta) : Promise.resolve(resposta),
  );
  return { client: lojaIntegradaClientFalso({ conferirPagamento }), conferirPagamento };
}

const carregada = (recebidoEm: number, pedidoId = ID_LI): ConferenciaLiCarregada => ({
  tipo: 'resposta',
  pedidoId,
  resposta: PAGO,
  recebidoEm,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('conferirAntesDeDespacharLi — who calls at all', () => {
  it('an imported Loja Integrada order calls the backend ONCE, for its own id', async () => {
    const { client, conferirPagamento } = clienteQueResponde(PAGO);
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
      agora: () => 7,
    });
    expect(d.acao).toBe('prosseguir');
    expect(conferirPagamento).toHaveBeenCalledTimes(1);
    expect(conferirPagamento.mock.calls[0]![0]).toBe(ID_LI);
  });

  it('⚠️ NEAR-MISS: a Mercado Livre or Shopee spelling, a duplicate and a manual pedido never call — and proceed', async () => {
    const casos: Array<[string, string, Record<string, unknown>]> = [
      ['mercado livre', sha256(`mercadoLivre${CONTA}-165`), PEDIDO_LI],
      ['shopee', sha256(`shopee${CONTA}-165`), PEDIDO_LI],
      ['duplicate (numero null)', ID_LI, { ...PEDIDO_LI, numero: null }],
      ['manual (no conta ref)', 'manual-1', { integracaoPedidoOuterRef: null, numero: '165' }],
    ];
    for (const [nome, pedidoId, pedido] of casos) {
      const { client, conferirPagamento } = clienteQueResponde(NAO_PAGO);
      const d = await conferirAntesDeDespacharLi({ client, pedidoId, pedido, gate: 'checkout' });
      expect(d, nome).toEqual({ acao: 'prosseguir', conferenciaLi: null });
      expect(conferirPagamento, nome).not.toHaveBeenCalled();
    }
  });
});

describe('conferirAntesDeDespacharLi — the verdict', () => {
  it('`pago` proceeds and CARRIES the answer for this pedido, stamped by the client clock', async () => {
    const { client } = clienteQueResponde(PAGO);
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
      agora: () => 1_234,
    });
    expect(d).toEqual({
      acao: 'prosseguir',
      conferenciaLi: { tipo: 'resposta', pedidoId: ID_LI, resposta: PAGO, recebidoEm: 1_234 },
    });
  });

  it('⚠️ NEAR-MISS: `aplicavel: false` proceeds but carries NOTHING — only a `pago` spares a later gate', async () => {
    const { client } = clienteQueResponde(NAO_APLICAVEL);
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect(d).toEqual({ acao: 'prosseguir', conferenciaLi: null });
  });

  it('`nao-pago`, an unknown situação and the ERP contested mirror BLOCK, with the gate saying what did not happen', async () => {
    const casos: Array<[RespostaConferenciaPagamentoLi, RegExp]> = [
      [NAO_PAGO, /não como pago\./],
      [{ ...PAGO, veredito: 'desconhecido', codigo: 'situacao_nova' }, /\(situacao_nova\)/],
      [ESPELHO, /contestado \(o comprador contestou a cobrança/],
    ];
    for (const [resposta, linha] of casos) {
      const { client } = clienteQueResponde(resposta);
      const d = await conferirAntesDeDespacharLi({
        client,
        pedidoId: ID_LI,
        pedido: PEDIDO_LI,
        gate: 'checkout',
      });
      expect(d.acao, resposta.aplicavel ? resposta.veredito : '-').toBe('bloquear');
      const mensagem = d.acao === 'bloquear' ? d.mensagem : '';
      expect(mensagem).toMatch(linha);
      expect(mensagem.endsWith('O checkout não foi salvo.')).toBe(true);
    }
  });

  it('each gate ends its block with its own consequence — the modal, and the buy inside the checkout chain', async () => {
    const sufixos = {
      comprar: 'A compra da etiqueta foi bloqueada.',
      cadeia: 'A compra da etiqueta foi bloqueada; o checkout e a NF-e já foram salvos.',
    } as const;
    for (const gate of ['comprar', 'cadeia'] as const) {
      const { client } = clienteQueResponde(NAO_PAGO);
      const d = await conferirAntesDeDespacharLi({
        client,
        pedidoId: ID_LI,
        pedido: PEDIDO_LI,
        gate,
      });
      expect(d.acao === 'bloquear' && d.mensagem.endsWith(sufixos[gate]), gate).toBe(true);
    }
  });

  it('an answer about another order (`pedidoDivergente`) blocks like a verdict', async () => {
    const { client } = clienteQueResponde(
      new LojaIntegradaClientHttpError('divergente', 502, CODIGO_ERRO_LI.pedidoDivergente),
    );
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'comprar',
    });
    expect(d.acao).toBe('bloquear');
  });
});

describe('conferirAntesDeDespacharLi — not verifiable asks, never blocks nor passes silently', () => {
  it('the read switch OFF (`chamadasDesligadas`) asks the CONFIGURATION confirm — never a block', async () => {
    const { client } = clienteQueResponde(
      new LojaIntegradaClientHttpError('desligada', 503, CODIGO_ERRO_LI.chamadasDesligadas),
    );
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect(d).toEqual({
      acao: 'confirmar',
      mensagem:
        'A conferência de pagamento na Loja Integrada não está disponível (a chave de chamadas ' +
        'está desligada): é configuração da conta, não instabilidade. Deseja continuar mesmo assim?',
    });
  });

  it('⭐ a backend WITHOUT the payment route (a 404 with no envelope) reads as "não verificável" — through the real client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response('<html>Not Found</html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    const client = createLojaIntegradaClient({
      baseUrl: 'https://li.example.invalid',
      getAuthToken: () => Promise.resolve('tok'),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect(d.acao).toBe('confirmar');
    expect(d.acao === 'confirmar' ? d.mensagem : '').toContain(
      'o backend da Loja Integrada ainda não oferece esta conferência',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a network failure asks the TRANSIENT confirm', async () => {
    const { client } = clienteQueResponde(new LojaIntegradaClientNetworkError());
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'comprar',
    });
    expect(d).toEqual({
      acao: 'confirmar',
      mensagem:
        'A Loja Integrada não respondeu à conferência de pagamento (falha de rede). ' +
        'Deseja continuar mesmo assim?',
    });
  });

  it('no client (logged out, an unusable backend) asks — it never throws and never proceeds silently', async () => {
    const d = await conferirAntesDeDespacharLi({
      client: null,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect(d.acao).toBe('confirmar');
  });

  it('a confirm carries no verdict: there is nothing to reuse after "não verificável"', async () => {
    const { client } = clienteQueResponde(
      new LojaIntegradaClientHttpError('desligada', 503, CODIGO_ERRO_LI.chamadasDesligadas),
    );
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect(d).not.toHaveProperty('conferenciaLi');
  });

  it('an error that is not the client’s own is rethrown (rule 6)', async () => {
    const { client } = clienteQueResponde(new TypeError('bug'));
    await expect(
      conferirAntesDeDespacharLi({ client, pedidoId: ID_LI, pedido: PEDIDO_LI, gate: 'checkout' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('conferirAntesDeDespacharLi — the caller gives up (a modal closed mid-check)', () => {
  it('the caller’s `sinal` reaches the client call', async () => {
    const controle = new AbortController();
    const conferirPagamento = vi.fn((_pedidoId: string, _opcoes?: { sinal?: AbortSignal }) =>
      Promise.resolve(PAGO),
    );
    await conferirAntesDeDespacharLi({
      client: lojaIntegradaClientFalso({ conferirPagamento }),
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'comprar',
      sinal: controle.signal,
    });
    expect(conferirPagamento.mock.calls[0]![1]?.sinal).toBe(controle.signal);
  });

  it('⭐ an abort comes back as the abort ITSELF, through the real client — never a "não verificável" to confirm', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createLojaIntegradaClient({
      baseUrl: 'https://li.example.invalid',
      getAuthToken: () => Promise.resolve('tok'),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const controle = new AbortController();
    const conferencia = conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'comprar',
      sinal: controle.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controle.abort();

    await expect(conferencia).rejects.toBe(controle.signal.reason);
  });

  it('⚠️ NEAR-MISS: with no `sinal` the call carries none — a gate nobody can close is not made abortable', async () => {
    const { client, conferirPagamento } = clienteQueResponde(PAGO);
    await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'checkout',
    });
    expect((conferirPagamento.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});

describe('conferirAntesDeDespacharLi — the carried verdict (120 s, client clock)', () => {
  it('a carried `pago` received 119 s ago stands in for the call', async () => {
    const { client, conferirPagamento } = clienteQueResponde(NAO_PAGO);
    const anterior = carregada(1_000);
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'cadeia',
      conferenciaLi: anterior,
      agora: () => 1_000 + 119_000,
    });
    expect(d).toEqual({ acao: 'prosseguir', conferenciaLi: anterior });
    expect(conferirPagamento).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: at 121 s it is asked again — and the new answer decides', async () => {
    const { client, conferirPagamento } = clienteQueResponde(NAO_PAGO);
    const d = await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'cadeia',
      conferenciaLi: carregada(1_000),
      agora: () => 1_000 + VALIDADE_CONFERENCIA_LI_MS + 1_000,
    });
    expect(conferirPagamento).toHaveBeenCalledTimes(1);
    expect(d.acao).toBe('bloquear');
  });

  it("⚠️ NEAR-MISS: another pedido's `pago` never stands in for this one", async () => {
    const { client, conferirPagamento } = clienteQueResponde(PAGO);
    await conferirAntesDeDespacharLi({
      client,
      pedidoId: ID_LI,
      pedido: PEDIDO_LI,
      gate: 'cadeia',
      conferenciaLi: carregada(1_000, sha256(`lojaIntegrada${CONTA}-166`)),
      agora: () => 2_000,
    });
    expect(conferirPagamento).toHaveBeenCalledTimes(1);
  });
});
