/**
 * A PAID Loja Integrada order that carries NO CEP at all (owner decisions,
 * 2026-10-19 and 2026-10-20): the pure verdict (what "no CEP" means, and who is
 * exempt), the retryable error the import throws, and the LOUD signal the
 * notification pipeline's exhaustion hook runs — an ERROR line with ids only,
 * then the open aviso — against `testing/fakeDb.ts` and the real
 * `escreverAviso`.
 */
import { format, inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANAL_AVISO,
  CODIGOS_LI_PAGO,
  CODIGO_SITUACAO_LI,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  codigoSituacaoLiSchema,
  valorUtilizavel,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { pedidoLiBruto } from '../testing/pedidosLi';
import { chaveDoAvisoDoPedidoLi, type PedidoDoAvisoLi } from './avisosPedidoLi';
import { enderecoDoPedidoLi, type EnderecoEntregaLi } from './clienteMapeamento';
import {
  LiPedidoPagoSemEnderecoError,
  entregaSemCepLi,
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
    temEnvio: true,
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

/** Blank texts: whitespace only, which carries nothing (decided and pinned here). */
const CEPS_EM_BRANCO = [' ', '   ', '\t', ' \n ', '\u00a0'];

/**
 * Present but INVALID CEPs, as a customer may type them into the store: the
 * endereço builder reads none of them (`sem-cep`), and waiting fixes none.
 */
const CEPS_INVALIDOS = ['00000', 'abc', '0131-010', '013101000', 'sem cep', '-'];

describe('entregaSemCepLi: the delivery block carries NO CEP at all (owner decision, 2026-10-20)', () => {
  it('EQUAL: no block, an empty block, and a CEP absent, null or empty ⇒ no CEP', () => {
    expect(entregaSemCepLi(null)).toBe(true);
    expect(entregaSemCepLi(undefined)).toBe(true);
    expect(entregaSemCepLi({} as EnderecoEntregaLi)).toBe(true);
    const semChave: Record<string, unknown> = { ...endereco() };
    delete semChave.cep;
    expect('cep' in semChave).toBe(false);
    expect(entregaSemCepLi(semChave as EnderecoEntregaLi)).toBe(true);
    for (const cep of [null, undefined, '']) {
      expect(entregaSemCepLi(endereco({ cep })), String(cep)).toBe(true);
    }
  });

  it('⚠️ EQUAL (decided): a whitespace-only CEP is no CEP either — it carries nothing', () => {
    for (const cep of CEPS_EM_BRANCO) {
      expect(entregaSemCepLi(endereco({ cep })), JSON.stringify(cep)).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: an INVALID non-empty CEP is a CEP — the builder reads none of them, and the rule still says one is there', () => {
    for (const cep of CEPS_INVALIDOS) {
      // The builder's own verdict: no endereço from it…
      expect(enderecoDoPedidoLi(endereco({ cep })).kind, cep).toBe('sem-cep');
      // …and still not "no CEP": the scope is the CEP's ABSENCE, never its quality.
      expect(entregaSemCepLi(endereco({ cep })), cep).toBe(false);
    }
  });

  it('⚠️ NEAR-MISS (deliberate): the `-` placeholder and a masked value, which the shared `valorUtilizavel` reads as absent, are present (invalid) CEPs here', () => {
    for (const cep of ['-', ' - ', '*****-***']) {
      // The shared absence reader would call each of them "nothing was sent"…
      expect(valorUtilizavel(cep), cep).toBeNull();
      // …the builder reads no endereço from any of them…
      expect(enderecoDoPedidoLi(endereco({ cep })).kind, cep).toBe('sem-cep');
      // …and the rule, narrower on purpose (the owner decision's set), still sees a CEP.
      expect(entregaSemCepLi(endereco({ cep })), cep).toBe(false);
      expect(decidir({ enderecoEntrega: endereco({ cep }) }), cep).toBe(false);
    }
  });

  it('NEAR-MISS: a valid CEP — bare or punctuated, with or without a street — is a CEP', () => {
    expect(entregaSemCepLi(endereco())).toBe(false);
    expect(entregaSemCepLi(endereco({ cep: '01310100' }))).toBe(false);
    expect(entregaSemCepLi(endereco({ cep: ' 01310-100 ' }))).toBe(false);
    expect(entregaSemCepLi(endereco({ endereco: null }))).toBe(false);
    expect(
      entregaSemCepLi(endereco({ endereco: null, numero: null, bairro: null, cidade: null })),
    ).toBe(false);
  });
});

describe('pedidoPagoSemEnderecoLi: who is refused', () => {
  it('EQUAL: every PAID codigo carrying no CEP, no pickup and no stored endereço ⇒ refused', () => {
    expect(CODIGOS_LI_PAGO.size).toBe(7);
    for (const codigo of CODIGOS_LI_PAGO) expect(decidir({ codigo }), codigo).toBe(true);
    expect(decidir({ enderecoEntrega: {} as EnderecoEntregaLi })).toBe(true);
    for (const cep of [null, undefined, '', ...CEPS_EM_BRANCO]) {
      expect(decidir({ enderecoEntrega: endereco({ cep }) }), JSON.stringify(cep)).toBe(true);
    }
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

  it('⚠️ NEAR-MISS (owner decision, 2026-10-20): an INVALID non-empty CEP is never refused — waiting never fixes what the customer typed', () => {
    for (const cep of CEPS_INVALIDOS) {
      expect(decidir({ enderecoEntrega: endereco({ cep }) }), cep).toBe(false);
      // Not even with no street, number or district: the CEP is what is asked about.
      expect(
        decidir({
          enderecoEntrega: endereco({ cep, endereco: null, numero: null, bairro: null }),
        }),
        cep,
      ).toBe(false);
    }
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

  it('NEAR-MISS: a valid CEP, a PICKUP route, NO shipment, or an endereço the pedido already stores ⇒ not refused', () => {
    expect(decidir({ enderecoEntrega: endereco() })).toBe(false);
    expect(decidir({ enderecoEntrega: endereco({ endereco: null }) })).toBe(false);
    expect(decidir({ dispensaEndereco: true })).toBe(false);
    // No shipment: no freight block, so nothing a label could be bought for.
    expect(decidir({ temEnvio: false })).toBe(false);
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
    expect(err).toMatchObject({ integracaoId: CONTA, pedidoId: 'pedido-1', numero: '9001' });
    expect(err.message).toContain(CONTA);
    expect(err.message).toContain('9001');
    expect(err.message).not.toContain(LOJA);
  });

  it('⚠️ the store name never reaches a log: the runtime’s `Unhandled error` line inspects the error, and the name is no enumerable field of it', () => {
    const err = new LiPedidoPagoSemEnderecoError(doAviso());
    // What `onTaskDispatched` logs for a rethrow on the queue's attempts 0 and 1.
    expect(format('Unhandled error', err)).not.toContain(LOJA);
    expect(inspect(err, { depth: 10 })).not.toContain(LOJA);
    expect(JSON.stringify(err)).not.toContain(LOJA);
    expect(Object.keys(err)).not.toContain('pedido');
    // The ids still are, so the line names the order.
    expect(format('Unhandled error', err)).toContain('pedido-1');
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
    // Narrowed by the CLASS, never by the shape: an error that merely carries
    // the same `pedido` field is somebody else's.
    const mesmoFormato = Object.assign(new Error('ainda sem endereço'), { pedido: doAviso() });
    for (const err of [new Error('ainda sem endereço'), new TypeError('x'), mesmoFormato]) {
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
