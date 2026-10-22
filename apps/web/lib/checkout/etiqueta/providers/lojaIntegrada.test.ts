import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import {
  CODIGO_ERRO_LI,
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MOTIVO_ROTA_ETIQUETA_LI,
  freightCapsFor,
  type FreteDoPedido,
  type IntegracaoFrete,
  type RespostaRotaEtiquetaLi,
} from '@delfrance/schemas';

const h = vi.hoisted(() => ({ resolverIntFrete: vi.fn() }));
vi.mock('../intFrete', () => ({ resolverIntFrete: h.resolverIntFrete }));

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
} from '@/lib/loja-integrada/client';
import { MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI } from '@/lib/loja-integrada/rotaEtiqueta';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import { aplicarRotaLi, createLojaIntegradaRouterProvider } from './lojaIntegrada';
import type {
  CheckoutEtiquetaProvider,
  EtiquetaOutcome,
  EtiquetaProviderInput,
  IntFreteResolvido,
} from '../types';

/**
 * The Loja Integrada ROUTER provider (master plan step 15): at checkout a pedido
 * still on its conta's Loja Integrada freight doc is routed through the backend's
 * `rota-etiqueta` route, then the label is the resolved TARGET's — delegated to
 * that target's own provider with the routed freight.
 */

const REF_DOC_LI = 'documents/int_frete/lojaIntegrada-CONTA1';
const REF_MOTOBOY = 'documents/int_frete/mot-1';

const FRETE_NO_DOC_LI = {
  integracaoFreteOuterRef: REF_DOC_LI,
  externalOptionId: null,
  integracaoTargetOuterRef: null,
  externalOptionIntegracao: null,
  externalOptionData: { id: 1001, code: 'A' },
  estado: ESTADO_FRETE.checkFinalizado,
  modalidade: '0',
  printLabelId: null,
  valorCobrado: 15,
} as unknown as FreteDoPedido;

const INT_FRETE_DOC_LI: IntFreteResolvido = {
  fonte: 'doc',
  id: 'lojaIntegrada-CONTA1',
  tipo: INTEGRACAO_FRETE.lojaIntegrada,
  data: { tipo: INTEGRACAO_FRETE.lojaIntegrada } as never,
};

const INT_FRETE_MOTOBOY: IntFreteResolvido = {
  fonte: 'doc',
  id: 'mot-1',
  tipo: INTEGRACAO_FRETE.motoboy,
  data: { tipo: INTEGRACAO_FRETE.motoboy, nome: 'Motoboy Centro' } as never,
};

type Roteado = Extract<RespostaRotaEtiquetaLi, { tipo: 'roteado' | 'ja-roteado' }>;

function respostaRoteada(
  tipo: Roteado['tipo'],
  rota: Partial<Roteado['rota']> = {},
  alvo: Partial<Roteado['alvo']> = {},
): Roteado {
  return {
    tipo,
    alvo: { id: 'mot-1', tipo: INTEGRACAO_FRETE.motoboy, nome: 'Motoboy Centro', ...alvo },
    rota: {
      integracaoFreteOuterRef: REF_MOTOBOY,
      externalOptionId: null,
      integracaoTargetOuterRef: null,
      estado: ESTADO_FRETE.checkFinalizado,
      ...rota,
    },
  };
}

/** A stand-in target provider: records the input it was delegated. */
function alvoFalso(outcome: EtiquetaOutcome = { status: 'printed' }) {
  const emitirOuImprimir = vi.fn(async (_input: EtiquetaProviderInput) => outcome);
  const provider: CheckoutEtiquetaProvider = {
    tipos: [INTEGRACAO_FRETE.motoboy],
    emitirOuImprimir,
  };
  return { provider, emitirOuImprimir };
}

function makeInput(over: {
  rotearEtiqueta?: (pedidoId: string, corpo: { escolha: string | null }) => Promise<unknown>;
  semCliente?: boolean;
  frete?: FreteDoPedido;
  notify?: EtiquetaProviderInput['ui']['notify'];
  conferenciaLi?: EtiquetaProviderInput['conferenciaLi'];
  intFrete?: IntFreteResolvido;
}): EtiquetaProviderInput {
  const frete = over.frete ?? FRETE_NO_DOC_LI;
  return {
    db: { __db: true } as never,
    pedido: { numero: '165', freteInicial: frete } as never,
    pedidoId: 'ped-li',
    frete,
    intFrete: over.intFrete ?? INT_FRETE_DOC_LI,
    formato: 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: over.semCliente
        ? null
        : lojaIntegradaClientFalso(
            over.rotearEtiqueta === undefined
              ? {}
              : { rotearEtiqueta: over.rotearEtiqueta as never },
          ),
      printJob: vi.fn(),
    },
    ui: {
      confirmRisk: vi.fn(async () => true),
      notify: over.notify ?? vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(),
      confirmarCiente: vi.fn(async () => true),
    },
    ...(over.conferenciaLi === undefined ? {} : { conferenciaLi: over.conferenciaLi }),
  };
}

/** A router whose resolver answers `alvo` for any tipo, recording the calls. */
function roteadorCom(alvo: CheckoutEtiquetaProvider) {
  const resolver = vi.fn((_tipo: IntegracaoFrete, _caps: unknown) => alvo);
  return { roteador: createLojaIntegradaRouterProvider(resolver), resolver };
}

beforeEach(() => {
  h.resolverIntFrete.mockReset().mockResolvedValue(INT_FRETE_MOTOBOY);
});

describe('the Loja Integrada router provider', () => {
  it('claims exactly the Loja Integrada tipo', () => {
    const { roteador } = roteadorCom(alvoFalso().provider);
    expect(roteador.tipos).toEqual([INTEGRACAO_FRETE.lojaIntegrada]);
  });

  it('⭐ routes ONCE with no escolha, then delegates to the TARGET with the routed freight and the target doc', async () => {
    const rotearEtiqueta = vi.fn(async () => respostaRoteada('roteado'));
    const alvo = alvoFalso();
    const { roteador, resolver } = roteadorCom(alvo.provider);
    const input = makeInput({ rotearEtiqueta });

    expect(await roteador.emitirOuImprimir(input)).toEqual({ status: 'printed' });

    expect(rotearEtiqueta).toHaveBeenCalledExactlyOnceWith('ped-li', { escolha: null });
    // The target doc is read by the CLIENT (the answer never carries it),
    // from the routed freight.
    expect(h.resolverIntFrete).toHaveBeenCalledTimes(1);
    const [dbLido, freteLido] = h.resolverIntFrete.mock.calls[0]! as [unknown, FreteDoPedido];
    expect(dbLido).toBe(input.db);
    expect(freteLido.integracaoFreteOuterRef).toBe(REF_MOTOBOY);
    // The target's provider is resolved by the TARGET tipo and its caps.
    expect(resolver).toHaveBeenCalledExactlyOnceWith(
      INTEGRACAO_FRETE.motoboy,
      freightCapsFor(INTEGRACAO_FRETE.motoboy),
    );
    // …and receives the routed freight, on the pedido too, with the target doc.
    expect(alvo.emitirOuImprimir).toHaveBeenCalledTimes(1);
    const delegado = alvo.emitirOuImprimir.mock.calls[0]![0];
    expect(delegado.frete).toEqual({ ...FRETE_NO_DOC_LI, integracaoFreteOuterRef: REF_MOTOBOY });
    expect(delegado.pedido.freteInicial).toBe(delegado.frete);
    expect((delegado.pedido as { numero?: string }).numero).toBe('165');
    expect(delegado.intFrete).toBe(INT_FRETE_MOTOBOY);
    expect(delegado.pedidoId).toBe('ped-li');
    expect(delegado.formato).toBe('pdf');
    expect(delegado.deps).toBe(input.deps);
    expect(delegado.ui).toBe(input.ui);
  });

  it('⚠️ NEAR-MISS: the target never receives the STALE freight that still names the Loja Integrada doc', async () => {
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);
    await roteador.emitirOuImprimir(
      makeInput({ rotearEtiqueta: async () => respostaRoteada('roteado') }),
    );
    const delegado = alvo.emitirOuImprimir.mock.calls[0]![0];
    expect(delegado.frete.integracaoFreteOuterRef).not.toBe(REF_DOC_LI);
    expect(delegado.pedido.freteInicial?.integracaoFreteOuterRef).not.toBe(REF_DOC_LI);
    expect(delegado.intFrete.tipo).not.toBe(INTEGRACAO_FRETE.lojaIntegrada);
  });

  it('`ja-roteado` delegates the same way — with NO second routing call', async () => {
    const rotearEtiqueta = vi.fn(async () => respostaRoteada('ja-roteado'));
    const alvo = alvoFalso({ status: 'opened' });
    const { roteador } = roteadorCom(alvo.provider);

    expect(await roteador.emitirOuImprimir(makeInput({ rotearEtiqueta }))).toEqual({
      status: 'opened',
    });
    expect(rotearEtiqueta).toHaveBeenCalledTimes(1);
    expect(alvo.emitirOuImprimir).toHaveBeenCalledTimes(1);
  });

  it('⚠️ NEAR-MISS: `ja-roteado` with no stored option delegates NO option — never the one the Loja Integrada doc’s freight carried', async () => {
    // The caller's freight still names the Loja Integrada doc, so its option
    // belongs to THAT ref. The route found the pedido routed to a Melhor Envio
    // target with no usable option: the target must quote first, never buy a
    // service nobody chose for it.
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);
    await roteador.emitirOuImprimir(
      makeInput({
        frete: { ...FRETE_NO_DOC_LI, externalOptionId: '3' } as FreteDoPedido,
        rotearEtiqueta: async () =>
          respostaRoteada(
            'ja-roteado',
            { integracaoFreteOuterRef: 'documents/int_frete/if-me', externalOptionId: null },
            { id: 'if-me', tipo: INTEGRACAO_FRETE.melhorEnvios },
          ),
      }),
    );
    const delegado = alvo.emitirOuImprimir.mock.calls[0]![0];
    expect(delegado.frete.integracaoFreteOuterRef).toBe('documents/int_frete/if-me');
    expect(delegado.frete.externalOptionId).toBeNull();
    expect(delegado.pedido.freteInicial?.externalOptionId).toBeNull();
  });

  it('the chain’s carried paid verdict rides along to the target (its soft gate reuses it)', async () => {
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);
    const conferenciaLi = { veredito: 'pago', recebidoEm: 1 } as never;
    await roteador.emitirOuImprimir(
      makeInput({ rotearEtiqueta: async () => respostaRoteada('roteado'), conferenciaLi }),
    );
    expect(alvo.emitirOuImprimir.mock.calls[0]![0].conferenciaLi).toBe(conferenciaLi);
  });

  it('a refusal notifies its copy plus the row hint, and is `unsupported` — nothing delegated', async () => {
    const notify = vi.fn();
    const alvo = alvoFalso();
    const { roteador, resolver } = roteadorCom(alvo.provider);
    const out = await roteador.emitirOuImprimir(
      makeInput({
        rotearEtiqueta: async () => ({
          tipo: 'recusado',
          motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
        }),
        notify,
      }),
    );

    expect(out.status).toBe('unsupported');
    expect(notify).toHaveBeenCalledTimes(1);
    const aviso = notify.mock.calls[0]![0] as { message: string; color?: string };
    expect(aviso.message).toBe(
      `${MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semMapeamento]} ` +
        'Use "Escolher transportadora…" na lista de pedidos.',
    );
    expect(aviso.color).toBe('yellow');
    expect(h.resolverIntFrete).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(alvo.emitirOuImprimir).not.toHaveBeenCalled();
  });

  /**
   * The row's hint is appended only where the row can do what the checkout
   * could not: "Definir transportadora" repeats this very call (no escolha), so
   * only the operator's own pick — "Escolher transportadora…", which bypasses
   * the stored override and the `mapa` — can route a pedido the checkout could
   * not. Written out, so a widening reds here.
   */
  const COM_DICA = [
    MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
    MOTIVO_ROTA_ETIQUETA_LI.semChave,
    MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido,
    MOTIVO_ROTA_ETIQUETA_LI.alvoAusente,
    MOTIVO_ROTA_ETIQUETA_LI.alvoInativo,
    MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico,
    MOTIVO_ROTA_ETIQUETA_LI.tipoNaoSuportado,
    MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido,
    MOTIVO_ROTA_ETIQUETA_LI.semEndereco,
  ] as const;
  const SEM_DICA = [
    MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
    MOTIVO_ROTA_ETIQUETA_LI.semRotaLi,
    MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago,
    MOTIVO_ROTA_ETIQUETA_LI.semFrete,
    MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada,
  ] as const;

  async function avisoDaRecusa(motivo: string): Promise<string> {
    const notify = vi.fn();
    const { roteador } = roteadorCom(alvoFalso().provider);
    await roteador.emitirOuImprimir(
      makeInput({ rotearEtiqueta: async () => ({ tipo: 'recusado', motivo }), notify }),
    );
    return (notify.mock.calls[0]![0] as { message: string }).message;
  }

  it('the two lists cover every motivo, once', () => {
    expect([...COM_DICA, ...SEM_DICA].sort()).toEqual(
      Object.values(MOTIVO_ROTA_ETIQUETA_LI).sort(),
    );
  });

  it.each(COM_DICA)('a `%s` refusal points at the row’s carrier picker', async (motivo) => {
    expect(await avisoDaRecusa(motivo)).toBe(
      `${MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[motivo]} ` +
        'Use "Escolher transportadora…" na lista de pedidos.',
    );
  });

  it.each(SEM_DICA)(
    '⚠️ NEAR-MISS: a `%s` refusal gets its copy ALONE — the row would refuse it again',
    async (motivo) => {
      expect(await avisoDaRecusa(motivo)).toBe(MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[motivo]);
    },
  );

  it('a motivo a newer backend added gets its neutral copy alone (prototype-safe: `toString` too)', async () => {
    for (const motivo of ['motivo-novo', 'toString']) {
      const aviso = await avisoDaRecusa(motivo);
      expect(aviso).toContain(`(${motivo})`);
      expect(aviso).not.toContain('Escolher transportadora');
    }
  });

  it('a null client is an `error` with the "não respondeu" copy — and calls nothing', async () => {
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);
    const out = await roteador.emitirOuImprimir(makeInput({ semCliente: true }));
    expect(out).toEqual({
      status: 'error',
      message:
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
    });
    expect(h.resolverIntFrete).not.toHaveBeenCalled();
    expect(alvo.emitirOuImprimir).not.toHaveBeenCalled();
  });

  it('a transport failure and a 403 are `error`s with their own copy, never the raw message', async () => {
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);

    const rede = await roteador.emitirOuImprimir(
      makeInput({
        rotearEtiqueta: async () => {
          throw new LojaIntegradaClientNetworkError('fetch failed');
        },
      }),
    );
    expect(rede).toEqual({
      status: 'error',
      message:
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
    });

    const proibido = await roteador.emitirOuImprimir(
      makeInput({
        rotearEtiqueta: async () => {
          throw new LojaIntegradaClientHttpError('Forbidden: frete.write', 403, 'FORBIDDEN');
        },
      }),
    );
    expect(proibido).toEqual({
      status: 'error',
      message: 'Você não tem permissão para definir a transportadora deste pedido.',
    });

    const conflito = await roteador.emitirOuImprimir(
      makeInput({
        rotearEtiqueta: async () => {
          throw new LojaIntegradaClientHttpError('x', 503, CODIGO_ERRO_LI.rotaEmConflito);
        },
      }),
    );
    expect(conflito).toEqual({
      status: 'error',
      message: 'O pedido foi alterado por outra ação ao mesmo tempo. Tente de novo.',
    });
    expect(alvo.emitirOuImprimir).not.toHaveBeenCalled();
  });

  it('a routed target whose doc is gone is an `error` — never a label against the Loja Integrada doc', async () => {
    h.resolverIntFrete.mockResolvedValue(null);
    const alvo = alvoFalso();
    const { roteador } = roteadorCom(alvo.provider);
    const out = await roteador.emitirOuImprimir(
      makeInput({ rotearEtiqueta: async () => respostaRoteada('roteado') }),
    );
    expect(out).toEqual({ status: 'error', message: 'Integração de frete não encontrada.' });
    expect(alvo.emitirOuImprimir).not.toHaveBeenCalled();
  });

  it('a Firestore failure reading the target is an `error` carrying it (the route already wrote)', async () => {
    h.resolverIntFrete.mockRejectedValue(new FirebaseError('permission-denied', 'sem acesso'));
    const { roteador } = roteadorCom(alvoFalso().provider);
    const out = await roteador.emitirOuImprimir(
      makeInput({ rotearEtiqueta: async () => respostaRoteada('roteado') }),
    );
    expect(out.status).toBe('error');
  });

  it('anything that is not a Firestore error propagates (rule 6)', async () => {
    h.resolverIntFrete.mockRejectedValue(new TypeError('boom'));
    const { roteador } = roteadorCom(alvoFalso().provider);
    await expect(
      roteador.emitirOuImprimir(
        makeInput({ rotearEtiqueta: async () => respostaRoteada('roteado') }),
      ),
    ).rejects.toThrow('boom');
  });

  it('a target that resolves to the router ITSELF is an error, never a loop', async () => {
    const rotearEtiqueta = vi.fn(async () => respostaRoteada('roteado'));
    let roteadorRef: CheckoutEtiquetaProvider | null = null;
    const roteador = createLojaIntegradaRouterProvider(() => roteadorRef!);
    roteadorRef = roteador;
    const out = await roteador.emitirOuImprimir(makeInput({ rotearEtiqueta }));
    expect(out.status).toBe('error');
    expect(rotearEtiqueta).toHaveBeenCalledTimes(1);
  });

  it('a `bloco` integration (no document) is refused before any call', async () => {
    const rotearEtiqueta = vi.fn(async () => respostaRoteada('roteado'));
    const { roteador } = roteadorCom(alvoFalso().provider);
    const out = await roteador.emitirOuImprimir(
      makeInput({
        rotearEtiqueta,
        intFrete: {
          fonte: 'bloco',
          id: null,
          tipo: INTEGRACAO_FRETE.lojaIntegrada,
          data: null,
        },
      }),
    );
    expect(out).toEqual({ status: 'error', message: 'Integração de frete não encontrada.' });
    expect(rotearEtiqueta).not.toHaveBeenCalled();
  });
});

describe('aplicarRotaLi — the routing fields of an answer laid over a freight', () => {
  const COM_OPCAO = { ...FRETE_NO_DOC_LI, externalOptionId: '3' } as FreteDoPedido;

  it.each(['roteado', 'ja-roteado'] as const)(
    '⚠️ NEAR-MISS: a `%s` null option REPLACES the caller’s — the option belongs to its ref, never to the Loja Integrada doc’s',
    (tipo) => {
      // The route WROTE `null` (`roteado`, a target that is not Melhor Envio),
      // or found the stored option null or unusable (`ja-roteado`). Either way
      // the caller's option came with the Loja Integrada doc: keeping it would
      // buy a Melhor Envio service nobody chose for this target.
      const { rota } = respostaRoteada(tipo, {
        externalOptionId: null,
        integracaoFreteOuterRef: 'documents/int_frete/if-me',
      });
      expect(aplicarRotaLi(COM_OPCAO, rota)).toMatchObject({
        integracaoFreteOuterRef: 'documents/int_frete/if-me',
        externalOptionId: null,
      });
    },
  );

  it('a stored option on the wire is taken over the caller’s', () => {
    const { rota } = respostaRoteada('ja-roteado', { externalOptionId: '17' });
    expect(aplicarRotaLi(COM_OPCAO, rota).externalOptionId).toBe('17');
  });

  it('an estado the route did not know (null) keeps the input estado; a known one replaces it', () => {
    expect(
      aplicarRotaLi(FRETE_NO_DOC_LI, respostaRoteada('roteado', { estado: null }).rota).estado,
    ).toBe(ESTADO_FRETE.checkFinalizado);
    expect(
      aplicarRotaLi(
        FRETE_NO_DOC_LI,
        respostaRoteada('roteado', { estado: ESTADO_FRETE.aguardandoRetirada }).rota,
      ).estado,
    ).toBe(ESTADO_FRETE.aguardandoRetirada);
  });

  it('keeps every other field of the freight untouched (the money, the key, the label id)', () => {
    const frete = aplicarRotaLi(
      FRETE_NO_DOC_LI,
      respostaRoteada('roteado', {
        integracaoTargetOuterRef: 'documents/int_frete/mot-1',
      }).rota,
    );
    expect(frete).toEqual({
      ...FRETE_NO_DOC_LI,
      integracaoFreteOuterRef: REF_MOTOBOY,
      integracaoTargetOuterRef: 'documents/int_frete/mot-1',
    });
  });

  it('does not mutate the freight it was given', () => {
    const antes = { ...COM_OPCAO };
    aplicarRotaLi(COM_OPCAO, respostaRoteada('roteado').rota);
    expect(COM_OPCAO).toEqual(antes);
  });
});
