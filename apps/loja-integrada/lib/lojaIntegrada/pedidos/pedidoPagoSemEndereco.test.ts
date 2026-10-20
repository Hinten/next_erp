/**
 * A PAID Loja Integrada order with no usable delivery address (owner decision,
 * 2026-10-19): the pure verdict (what "usable" means, and who is exempt), the
 * retryable error the import throws, and the LOUD signal the notification
 * pipeline's exhaustion hook runs — an ERROR line with ids only, then the open
 * aviso — against `testing/fakeDb.ts` and the real `escreverAviso`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANAL_AVISO,
  CODIGOS_LI_PAGO,
  CODIGO_SITUACAO_LI,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  codigoSituacaoLiSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { pedidoLiBruto } from '../testing/pedidosLi';
import { chaveDoAvisoDoPedidoLi, type PedidoDoAvisoLi } from './avisosPedidoLi';
import type { EnderecoEntregaLi } from './clienteMapeamento';
import {
  LiPedidoPagoSemEnderecoError,
  enderecoEntregaUtilizavelLi,
  pedidoPagoSemEnderecoLi,
  sinalizarPedidoPagoSemEnderecoLi,
} from './pedidoPagoSemEndereco';

const CONTA = 'conta-li-sem-endereco';
const LOJA = 'Loja de Nome Sensível';

/** The fixture's delivery block: a CEP and a street. */
function endereco(over: Partial<Record<keyof EnderecoEntregaLi, unknown>> = {}): EnderecoEntregaLi {
  return {
    ...(pedidoLiBruto().endereco_entrega as EnderecoEntregaLi),
    ...over,
  } as EnderecoEntregaLi;
}

const PAGO = CODIGO_SITUACAO_LI.pedidoPago;

function decidir(over: Partial<Parameters<typeof pedidoPagoSemEnderecoLi>[0]> = {}): boolean {
  return pedidoPagoSemEnderecoLi({
    codigo: PAGO,
    enderecoEntrega: null,
    dispensaEndereco: false,
    armazenado: null,
    ...over,
  });
}

function doAviso(relogioUs = 1_000): PedidoDoAvisoLi {
  return { integracaoId: CONTA, lojaNome: LOJA, pedidoId: 'pedido-1', numero: '9001', relogioUs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enderecoEntregaUtilizavelLi: a CEP AND a street, read by the endereço builder', () => {
  it('EQUAL: the fixture block, a punctuated CEP, a one-letter street the builder completes', () => {
    expect(enderecoEntregaUtilizavelLi(endereco())).toBe(true);
    expect(enderecoEntregaUtilizavelLi(endereco({ cep: '01310100' }))).toBe(true);
    expect(enderecoEntregaUtilizavelLi(endereco({ endereco: 'A' }))).toBe(true);
    // Nothing else is asked of it: no número, bairro or cidade still ships.
    expect(
      enderecoEntregaUtilizavelLi(
        endereco({ numero: null, bairro: null, cidade: null, estado: null }),
      ),
    ).toBe(true);
  });

  it('NEAR-MISS: absent, empty, no usable CEP, or no street ⇒ not usable', () => {
    expect(enderecoEntregaUtilizavelLi(null)).toBe(false);
    expect(enderecoEntregaUtilizavelLi(undefined)).toBe(false);
    expect(enderecoEntregaUtilizavelLi({} as EnderecoEntregaLi)).toBe(false);
    for (const cep of [null, '', '   ', '0131-010', 'sem cep']) {
      expect(enderecoEntregaUtilizavelLi(endereco({ cep })), String(cep)).toBe(false);
    }
    for (const rua of [null, '', '   ']) {
      expect(enderecoEntregaUtilizavelLi(endereco({ endereco: rua })), String(rua)).toBe(false);
    }
    // The builder's own placeholder is no street either.
    expect(enderecoEntregaUtilizavelLi(endereco({ endereco: 'NAO INFORMADO' }))).toBe(false);
  });
});

describe('pedidoPagoSemEnderecoLi: who is refused', () => {
  it('EQUAL: every PAID codigo with no usable address, no pickup and no stored endereço ⇒ refused', () => {
    expect(CODIGOS_LI_PAGO.size).toBe(7);
    for (const codigo of CODIGOS_LI_PAGO) expect(decidir({ codigo }), codigo).toBe(true);
    expect(decidir({ enderecoEntrega: endereco({ cep: null }) })).toBe(true);
    // An EMPTY stored ref is no endereço.
    expect(
      decidir({
        armazenado: {
          enderecoFiscalOuterRef: '',
          freteInicial: { enderecoFreteOuterReference: null },
        },
      }),
    ).toBe(true);
  });

  it('NEAR-MISS: every codigo that is not paid imports as before — the dispute and a request to cancel included', () => {
    for (const codigo of codigoSituacaoLiSchema.options) {
      if (CODIGOS_LI_PAGO.has(codigo)) continue;
      expect(decidir({ codigo }), codigo).toBe(false);
    }
    for (const codigo of ['Pedido_Pago', 'pedido_pago ', 'codigo_novo']) {
      expect(decidir({ codigo }), codigo).toBe(false);
    }
  });

  it('NEAR-MISS: a usable address, a PICKUP route, or an endereço the pedido already stores ⇒ not refused', () => {
    expect(decidir({ enderecoEntrega: endereco() })).toBe(false);
    expect(decidir({ dispensaEndereco: true })).toBe(false);
    expect(
      decidir({ armazenado: { enderecoFiscalOuterRef: 'documents/clientes/c1/enderecos/e1' } }),
    ).toBe(false);
    expect(
      decidir({
        armazenado: {
          freteInicial: { enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1' },
        },
      }),
    ).toBe(false);
  });
});

describe('LiPedidoPagoSemEnderecoError', () => {
  it('carries what the loud signal needs, and its message names ids only', () => {
    const err = new LiPedidoPagoSemEnderecoError(doAviso(1_234));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LiPedidoPagoSemEnderecoError');
    expect(err.pedido).toEqual(doAviso(1_234));
    expect(err.message).toContain(CONTA);
    expect(err.message).toContain('9001');
    expect(err.message).not.toContain(LOJA);
  });
});

describe('sinalizarPedidoPagoSemEnderecoLi: the LOUD failure once the retries ran out', () => {
  const caminho = `avisos/${chaveDoAvisoDoPedidoLi(
    TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
    CONTA,
    'pedido-1',
  )}`;

  function logger() {
    const erros: unknown[][] = [];
    return {
      erros,
      logger: {
        warn: () => undefined,
        error: (msg: string, meta?: Record<string, unknown>) => {
          erros.push([msg, meta]);
        },
      },
    };
  }

  it('EQUAL: our error ⇒ ONE ERROR line with ids only, then the open critico aviso', async () => {
    const db = new FakeDb();
    const l = logger();
    const r = await sinalizarPedidoPagoSemEnderecoLi(
      asDb(db),
      new LiPedidoPagoSemEnderecoError(doAviso(1_000)),
      { increment, agoraMs: () => AGORA_MS, logger: l.logger },
    );
    expect(r).toBe(true);
    expect(l.erros).toHaveLength(1);
    expect(l.erros[0]![1]).toEqual({ integracaoId: CONTA, numero: '9001', pedidoId: 'pedido-1' });
    expect(JSON.stringify(l.erros)).not.toContain(LOJA);
    expect(db.ler(caminho)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: LOJA, pedido: '9001' },
      relogioEvento: 1_000,
      resolvidoEm: null,
    });
  });

  it('NEAR-MISS: any OTHER error parked at the cap is not ours — no line, no aviso, nothing written', async () => {
    const db = new FakeDb();
    const l = logger();
    for (const err of [new Error('ainda sem endereço'), new TypeError('x')]) {
      const r = await sinalizarPedidoPagoSemEnderecoLi(asDb(db), err, {
        increment,
        agoraMs: () => AGORA_MS,
        logger: l.logger,
      });
      expect(r, err.name).toBe(false);
    }
    expect(l.erros).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('a logger without `error` still gets an ERROR line, on the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = new FakeDb();
    await sinalizarPedidoPagoSemEnderecoLi(asDb(db), new LiPedidoPagoSemEnderecoError(doAviso()), {
      increment,
      agoraMs: () => AGORA_MS,
      logger: { warn: () => undefined },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls[0])).toContain('pedido-1');
    expect(db.ler(caminho)?.resolvidoEm).toBeNull();
  });

  it('the line comes BEFORE the aviso write: a failed aviso write still leaves the line', async () => {
    const db = new FakeDb();
    db.falharEscrita(caminho, grpc(14, 'UNAVAILABLE'));
    const l = logger();
    await expect(
      sinalizarPedidoPagoSemEnderecoLi(asDb(db), new LiPedidoPagoSemEnderecoError(doAviso()), {
        increment,
        agoraMs: () => AGORA_MS,
        logger: l.logger,
      }),
    ).rejects.toMatchObject({ code: 14 });
    expect(l.erros).toHaveLength(1);
  });
});
