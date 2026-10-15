import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_RETURN_CONFIRM_PATH,
  SHOPEE_RETURN_SOLUTION,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  shopeeErrorFromEnvelope,
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnDetailSchema,
  shopeeReturnWriteSchema,
  type OfferReturnParams,
  type ShopeeAlvoDeDevolucao,
  type ShopeeApiError,
  type ShopeeReturnAvailableSolutionsEnvelope,
  type ShopeeReturnDetailEnvelope,
  type ShopeeReturnWriteResponse,
} from '@delfrance/integrations-shopee';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import {
  DevolucaoAcaoRecusadaError,
  executarAcaoDevolucaoShopee,
  lerEstadoDevolucaoShopee,
  type DevolucaoResolveDeps,
  type PedidoDeAcaoDevolucao,
} from './acoesDevolucao';
import { STATUS_DEVOLUCAO_SHOPEE } from './devolucaoMapping';
import { ACAO_DEVOLUCAO_SHOPEE, type AcaoDevolucaoShopee } from './estadoDevolucao';
import { FRASE_RECUSA_DEVOLUCAO, MOTIVO_RECUSA_DEVOLUCAO } from './recusaDevolucao';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
/** ALPHANUMERIC on purpose — a digits-only id would hide the one shape a digits guard breaks. */
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO, ORDER_SN);
const UPDATE_S = 1_789_042_568;

/** A sentence a log line must never carry (Shopee's own text can echo what we sent). */
const FRASE_DA_SHOPEE = 'Type of return does not allow seller to offer refund';

/* -------------------------------------------------------------------------- */
/*  The stub client — a FULL Pick, typed, never cast.                          */
/* -------------------------------------------------------------------------- */

function envDetalhe(campos: Record<string, unknown> = {}): ShopeeReturnDetailEnvelope {
  return shopeeReturnDetailSchema.parse({
    error: '-',
    message: null,
    request_id: 'req-detalhe',
    response: {
      return_sn: RETURN_SN,
      order_sn: ORDER_SN,
      status: STATUS_DEVOLUCAO_SHOPEE.requested,
      update_time: UPDATE_S,
      return_refund_request_type: 0,
      validation_type: 'seller_validation',
      return_refund_type: 'RRBOC',
      refund_amount: 10.5,
      currency: 'BRL',
      negotiation: {
        negotiation_status: 'PENDING_RESPOND',
        latest_solution: 'REFUND',
        latest_offer_amount: 7.25,
      },
      ...campos,
    },
  });
}

function envSolucoes(response: Record<string, unknown>): ShopeeReturnAvailableSolutionsEnvelope {
  return shopeeReturnAvailableSolutionsSchema.parse({
    error: ' ',
    request_id: 'req-sol',
    response,
  });
}

const SOLUCOES_PADRAO = (): ShopeeReturnAvailableSolutionsEnvelope =>
  envSolucoes({
    return_sn: RETURN_SN,
    offer_return_refund: { eligibility: true, refund_amount_adjustable: false },
    offer_refund: {
      eligibility: true,
      refund_amount_adjustable: true,
      min_refund_amount: 5,
      max_refund_amount: 10.5,
    },
  });

function envEscrita(error = ' '): ShopeeReturnWriteResponse {
  return shopeeReturnWriteSchema.parse({
    error,
    request_id: 'req-escrita',
    response: { return_sn: RETURN_SN },
  });
}

function recusaDaShopee(error: string, message: string, path: string): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

type Resposta<T> = T | Error;

interface Roteiro {
  detalhe?: Resposta<ShopeeReturnDetailEnvelope>;
  solucoes?: Resposta<ShopeeReturnAvailableSolutionsEnvelope>;
  escrita?: Resposta<ShopeeReturnWriteResponse>;
}

interface Chamada {
  readonly op: string;
  readonly args: unknown;
}

function responder<T>(r: Resposta<T>): T {
  if (r instanceof Error) throw r;
  return r;
}

function clienteDe(roteiro: Roteiro = {}): { deps: DevolucaoResolveDeps; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const anotar = (op: string, args: unknown) => chamadas.push({ op, args });
  const client: DevolucaoResolveDeps['client'] = {
    getReturnDetail: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('getReturnDetail', p);
      return responder(roteiro.detalhe ?? envDetalhe());
    },
    getReturnAvailableSolutions: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('getReturnAvailableSolutions', p);
      return responder(roteiro.solucoes ?? SOLUCOES_PADRAO());
    },
    confirmReturn: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('confirmReturn', p);
      return responder(roteiro.escrita ?? envEscrita());
    },
    offerReturn: async (p: OfferReturnParams) => {
      anotar('offerReturn', p);
      return responder(roteiro.escrita ?? envEscrita());
    },
    acceptReturnOffer: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('acceptReturnOffer', p);
      return responder(roteiro.escrita ?? envEscrita());
    },
  };
  return { deps: { client }, chamadas };
}

const ops = (chamadas: readonly Chamada[]) => chamadas.map((c) => c.op);

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Structure — no db, no scheduler (tier 0)                                   */
/* -------------------------------------------------------------------------- */

const FONTE = readFileSync(new URL('./acoesDevolucao.ts', import.meta.url), 'utf8');
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

describe('acoesDevolucao.ts — sem db, sem agendador: o importador é o único escritor', () => {
  it('DevolucaoResolveDeps tem UMA chave, client, com as cinco operações', () => {
    expectTypeOf<keyof DevolucaoResolveDeps>().toEqualTypeOf<'client'>();
    expectTypeOf<keyof DevolucaoResolveDeps['client']>().toEqualTypeOf<
      | 'getReturnDetail'
      | 'getReturnAvailableSolutions'
      | 'confirmReturn'
      | 'offerReturn'
      | 'acceptReturnOffer'
    >();
    // The runtime half of the same pin (vitest does not run the type checker).
    const corpo = /export interface DevolucaoResolveDeps \{([\s\S]*?)\n\}/.exec(CODIGO)?.[1] ?? '';
    const chaves = [...corpo.matchAll(/^ {2}readonly (\w+)/gm)].map((m) => m[1]);
    expect(chaves).toEqual(['client']);
  });

  it('nenhum import ou chamada de Firestore, de fila ou de relógio', () => {
    for (const proibido of [
      'firebase',
      '@delfrance/data',
      'Firestore',
      'runTransaction',
      'enqueue',
      'scheduler',
      'notificacaoSintetica',
      'Date.now',
      'process.env',
    ]) {
      expect(CODIGO, proibido).not.toContain(proibido);
    }
  });

  it('centavos → reais por roundReais + centavosDeReais, nunca Math.round(x * 100)', () => {
    expect(CODIGO).not.toMatch(/Math\.round/);
    expect(CODIGO).toContain('roundReais(minor / 100)');
    expect(CODIGO).toContain('centavosDeReais(reais) !== minor');
  });
});

describe('DevolucaoAcaoRecusadaError', () => {
  it('a mensagem é a frase do vocabulário único; carrega motivo e ações', () => {
    const e = new DevolucaoAcaoRecusadaError(MOTIVO_RECUSA_DEVOLUCAO.valorMudou, [
      ACAO_DEVOLUCAO_SHOPEE.ofertar,
    ]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DevolucaoAcaoRecusadaError');
    expect(e.message).toBe(FRASE_RECUSA_DEVOLUCAO[MOTIVO_RECUSA_DEVOLUCAO.valorMudou]);
    expect(e.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
    expect(e.acoesDisponiveis).toEqual(['ofertar']);
  });
});

/* -------------------------------------------------------------------------- */
/*  lerEstadoDevolucaoShopee                                                  */
/* -------------------------------------------------------------------------- */

describe('lerEstadoDevolucaoShopee — o estado vivo, no máximo duas leituras', () => {
  const ler = (deps: DevolucaoResolveDeps) =>
    lerEstadoDevolucaoShopee(deps, { integracaoId: INTEGRACAO, returnSn: RETURN_SN });

  it('uma devolução aberta: detalhe, depois soluções; o return_sn vai VERBATIM', async () => {
    const { deps, chamadas } = clienteDe();
    const estado = await ler(deps);
    expect(chamadas).toEqual([
      { op: 'getReturnDetail', args: { returnSn: RETURN_SN } },
      { op: 'getReturnAvailableSolutions', args: { returnSn: RETURN_SN } },
    ]);
    expect(estado.pedidoId).toBe(PEDIDO_ID);
    expect(estado.acoesDisponiveis).toEqual(['confirmar', 'ofertar', 'aceitar-oferta']);
    expect(estado.solucoes).toHaveLength(2);
  });

  it.each([
    STATUS_DEVOLUCAO_SHOPEE.closed,
    STATUS_DEVOLUCAO_SHOPEE.cancelled,
    STATUS_DEVOLUCAO_SHOPEE.judging,
    STATUS_DEVOLUCAO_SHOPEE.sellerDispute,
    'DESCONHECIDO',
  ])('%s: as soluções não mudariam nada no painel — a chamada não é paga', async (status) => {
    const { deps, chamadas } = clienteDe({ detalhe: envDetalhe({ status }) });
    const estado = await ler(deps);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
    expect(estado.solucoes).toEqual([]);
    expect(estado.acoesDisponiveis).toEqual([]);
  });

  it('UMA linha de log: ids, o status e o `error` cru de cada envelope — nada da Shopee além disso', async () => {
    const { deps } = clienteDe();
    await ler(deps);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe('[shopee/devolucao] estado lido');
    expect(info.mock.calls[0]?.[1]).toEqual({
      integracaoId: INTEGRACAO,
      returnSn: RETURN_SN,
      status: STATUS_DEVOLUCAO_SHOPEE.requested,
      erroEnvelope: '-',
      erroEnvelopeSolucoes: ' ',
      solucoesRecusadas: null,
      acoesDisponiveis: ['confirmar', 'ofertar', 'aceitar-oferta'],
    });
  });

  it.each([
    ['error_data', FRASE_DA_SHOPEE, MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite],
    [
      'error_data',
      'Shopee is reviewing the case and will get back to you.',
      MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee,
    ],
    [
      'error_data',
      'The return case is missing initial evidence from the buyer and will be auto-cancelled.',
      MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente,
    ],
    [
      'error_return_status',
      'The return status cannot support this action',
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    ],
  ])(
    'a leitura LATERAL recusada (%s: %s) degrada para "sem soluções" — o painel continua',
    async (codigo, frase, motivo) => {
      const { deps } = clienteDe({
        solucoes: recusaDaShopee(codigo, frase, SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH),
      });
      const estado = await ler(deps);
      expect(estado.solucoes).toEqual([]);
      expect(estado.acoesDisponiveis).toEqual(['confirmar', 'aceitar-oferta']);
      const log = info.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(log.solucoesRecusadas).toEqual({ motivo, codigo });
      expect(log.erroEnvelopeSolucoes).toBeNull();
      expect(JSON.stringify(info.mock.calls)).not.toContain(frase);
    },
  );

  it('o código LOGADO da recusa lateral passa por codigoSeguro: PAR aparado; QUASE-IGUAL nunca cru', async () => {
    const { deps } = clienteDe({
      solucoes: recusaDaShopee(
        ' error_data\t',
        FRASE_DA_SHOPEE,
        SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
      ),
    });
    await ler(deps);
    const log = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(log.solucoesRecusadas).toEqual({
      motivo: MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite,
      codigo: 'error_data',
    });
    // The quoted padded form — `JSON.stringify` escapes the tab, so the raw string could never match.
    expect(JSON.stringify(info.mock.calls)).not.toContain('" error_data');
  });

  it.each([
    [
      'um código que a tabela não conhece',
      recusaDaShopee('error_server', 'boom', SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH),
    ],
    [
      'error_param (o NOSSO pedido)',
      recusaDaShopee(
        'error_param',
        'Return SN or ID is invalid.',
        SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
      ),
    ],
    [
      'a devolução sumiu depois do detalhe',
      recusaDaShopee(
        'error_data',
        "The return you queried doesn't exist.",
        SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
      ),
    ],
    ['uma falha de rede', new ShopeeNetworkError('socket hang up')],
    ['um bug nosso', new TypeError('x is not a function')],
  ])('%s na leitura lateral PROPAGA — o mesmo erro, intacto', async (_, erro) => {
    const { deps } = clienteDe({ solucoes: erro });
    await expect(ler(deps)).rejects.toBe(erro);
    expect(info).not.toHaveBeenCalled();
  });

  it('uma recusa do DETALHE propaga, e as soluções nem são lidas', async () => {
    const erro = recusaDaShopee(
      'error_data',
      'The return detail is not available.',
      SHOPEE_GET_RETURN_DETAIL_PATH,
    );
    const { deps, chamadas } = clienteDe({ detalhe: erro });
    await expect(ler(deps)).rejects.toBe(erro);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
  });

  it.each([
    ['vazio', ''],
    ['com hífen', '2609-100000'],
    ['65 caracteres', 'A'.repeat(65)],
    ['com espaço', ' 260910ABCDE0001'],
  ])(
    'return_sn %s ⇒ RangeError ANTES de qualquer chamada, sem ecoar o valor',
    async (_, returnSn) => {
      const { deps, chamadas } = clienteDe();
      const leitura = lerEstadoDevolucaoShopee(deps, { integracaoId: INTEGRACAO, returnSn });
      await expect(leitura).rejects.toBeInstanceOf(RangeError);
      await leitura.catch((e: unknown) => {
        if (returnSn.trim() !== '')
          expect((e as RangeError).message).not.toContain(returnSn.trim());
      });
      expect(chamadas).toEqual([]);
    },
  );

  it('integracaoId em branco ⇒ RangeError antes de qualquer chamada', async () => {
    const { deps, chamadas } = clienteDe();
    await expect(
      lerEstadoDevolucaoShopee(deps, { integracaoId: ' ', returnSn: RETURN_SN }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(chamadas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  executarAcaoDevolucaoShopee                                               */
/* -------------------------------------------------------------------------- */

const base = { integracaoId: INTEGRACAO, pedidoId: PEDIDO_ID, returnSn: RETURN_SN } as const;
const CONFIRMAR = (valorExibidoMinor: number | null = 1050): PedidoDeAcaoDevolucao => ({
  ...base,
  acao: ACAO_DEVOLUCAO_SHOPEE.confirmar,
  valorExibidoMinor,
});
const OFERTAR = (
  solucao: PedidoDeAcaoDevolucao['solucao'],
  valorReembolsoMinor?: number,
): PedidoDeAcaoDevolucao => ({
  ...base,
  acao: ACAO_DEVOLUCAO_SHOPEE.ofertar,
  solucao,
  ...(valorReembolsoMinor === undefined ? {} : { valorReembolsoMinor }),
});
const ACEITAR = (
  solucaoExibida: PedidoDeAcaoDevolucao['solucaoExibida'] = SHOPEE_RETURN_SOLUTION.soReembolso,
  valorExibidoMinor: number | null = 725,
): PedidoDeAcaoDevolucao => ({
  ...base,
  acao: ACAO_DEVOLUCAO_SHOPEE.aceitarOferta,
  solucaoExibida,
  valorExibidoMinor,
});

async function recusada(promessa: Promise<unknown>): Promise<DevolucaoAcaoRecusadaError> {
  const erro = await promessa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).toBeInstanceOf(DevolucaoAcaoRecusadaError);
  return erro as DevolucaoAcaoRecusadaError;
}

describe('executarAcaoDevolucaoShopee — confirmar', () => {
  it('relê o detalhe AO VIVO e confirma: duas chamadas, return_sn verbatim, nenhuma solução lida', async () => {
    const { deps, chamadas } = clienteDe();
    const r = await executarAcaoDevolucaoShopee(deps, CONFIRMAR());
    expect(chamadas).toEqual([
      { op: 'getReturnDetail', args: { returnSn: RETURN_SN } },
      { op: 'confirmReturn', args: { returnSn: RETURN_SN } },
    ]);
    expect(r).toEqual({
      returnSn: RETURN_SN,
      orderSn: ORDER_SN,
      acao: 'confirmar',
      erroEnvelope: ' ',
    });
  });

  it('erroEnvelope é o `error` cru da ESCRITA (registro 231)', async () => {
    const { deps } = clienteDe({ escrita: envEscrita('-') });
    expect((await executarAcaoDevolucaoShopee(deps, CONFIRMAR())).erroEnvelope).toBe('-');
  });

  it.each([
    [
      'tipo de requisição 1 (em trânsito)',
      { return_refund_request_type: 1 },
      MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite,
    ],
    [
      'tipo de requisição 2 (no ato)',
      { return_refund_request_type: 2 },
      MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite,
    ],
    [
      'warehouse_validation',
      { validation_type: 'warehouse_validation' },
      MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem,
    ],
    ['RRAOC', { return_refund_type: 'RRAOC' }, MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite],
    [
      'ACCEPTED',
      { status: STATUS_DEVOLUCAO_SHOPEE.accepted },
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    ],
    [
      'CLOSED',
      { status: STATUS_DEVOLUCAO_SHOPEE.closed },
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada,
    ],
    [
      'SELLER_DISPUTE',
      { status: STATUS_DEVOLUCAO_SHOPEE.sellerDispute },
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa,
    ],
  ])('%s ⇒ 409 do NOSSO gate, e a Shopee não recebe a escrita', async (_, campos, motivo) => {
    const { deps, chamadas } = clienteDe({ detalhe: envDetalhe(campos) });
    const erro = await recusada(executarAcaoDevolucaoShopee(deps, CONFIRMAR()));
    expect(erro.motivo).toBe(motivo);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
  });

  it('o valor mudou desde a tela ⇒ valor-mudou, sem escrita; acoesDisponiveis é a do gate vivo', async () => {
    const { deps, chamadas } = clienteDe({ detalhe: envDetalhe({ refund_amount: 10.6 }) });
    const erro = await recusada(executarAcaoDevolucaoShopee(deps, CONFIRMAR(1050)));
    expect(erro.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
    expect(erro.acoesDisponiveis).toEqual(['confirmar', 'aceitar-oferta']);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
  });

  it('o pedido do order_sn vivo não é o do painel ⇒ pedido-divergente, sem escrita', async () => {
    const { deps, chamadas } = clienteDe({ detalhe: envDetalhe({ order_sn: '260910KJBHUJDN' }) });
    const erro = await recusada(executarAcaoDevolucaoShopee(deps, CONFIRMAR()));
    expect(erro.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
  });

  it('a recusa da Shopee na escrita PROPAGA intacta (a rota a classifica)', async () => {
    const erro = recusaDaShopee(
      'error_data',
      'Shopee is reviewing the case and will get back to you.',
      SHOPEE_RETURN_CONFIRM_PATH,
    );
    const { deps } = clienteDe({ escrita: erro });
    await expect(executarAcaoDevolucaoShopee(deps, CONFIRMAR())).rejects.toBe(erro);
  });

  it('nenhum console na ação — a rota loga', async () => {
    const { deps } = clienteDe();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await executarAcaoDevolucaoShopee(deps, CONFIRMAR());
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('executarAcaoDevolucaoShopee — ofertar', () => {
  it('sem valor numa solução não ajustável: o corpo NÃO tem a chave do valor', async () => {
    const { deps, chamadas } = clienteDe();
    await executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso));
    expect(ops(chamadas)).toEqual([
      'getReturnDetail',
      'getReturnAvailableSolutions',
      'offerReturn',
    ]);
    const corpo = chamadas[2]?.args as Record<string, unknown>;
    expect(corpo).toEqual({ returnSn: RETURN_SN, proposedSolution: 'RETURN_REFUND' });
    expect(Object.keys(corpo)).not.toContain('proposedAdjustedRefundAmount');
  });

  it.each([
    [1050, 10.5],
    [1005, 10.05],
    [500, 5],
    [777, 7.77],
  ])('%j centavos viram %j REAIS exatos no fio', async (minor, reais) => {
    const { deps, chamadas } = clienteDe();
    await executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso, minor));
    expect(chamadas[2]).toEqual({
      op: 'offerReturn',
      args: {
        returnSn: RETURN_SN,
        proposedSolution: 'REFUND',
        proposedAdjustedRefundAmount: reais,
      },
    });
  });

  it.each([499, 1051])(
    '%j centavos fora da faixa ⇒ valor-fora-da-faixa, NUNCA ajustado à borda',
    async (minor) => {
      const { deps, chamadas } = clienteDe();
      const erro = await recusada(
        executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso, minor)),
      );
      expect(erro.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa);
      expect(ops(chamadas)).not.toContain('offerReturn');
    },
  );

  it('valor numa solução não ajustável ⇒ valor-nao-ajustavel; ajustável sem valor ⇒ valor-obrigatorio', async () => {
    const a = clienteDe();
    expect(
      (
        await recusada(
          executarAcaoDevolucaoShopee(
            a.deps,
            OFERTAR(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, 500),
          ),
        )
      ).motivo,
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel);
    const b = clienteDe();
    expect(
      (
        await recusada(
          executarAcaoDevolucaoShopee(b.deps, OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso)),
        )
      ).motivo,
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorObrigatorio);
    expect([...ops(a.chamadas), ...ops(b.chamadas)]).not.toContain('offerReturn');
  });

  it('um valor que não sobrevive à volta centavos → reais → centavos é RECUSADO, nunca arredondado', async () => {
    const { deps, chamadas } = clienteDe({
      solucoes: envSolucoes({
        offer_refund: { eligibility: true, refund_amount_adjustable: true },
      }),
    });
    await expect(
      executarAcaoDevolucaoShopee(
        deps,
        OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso, 9_007_199_254_740_990),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(ops(chamadas)).not.toContain('offerReturn');
  });

  it('encerrada ou de outro pedido: recusada SEM pagar a leitura das soluções', async () => {
    for (const campos of [
      { status: STATUS_DEVOLUCAO_SHOPEE.closed },
      { order_sn: '260910KJBHUJDN' },
      { status: STATUS_DEVOLUCAO_SHOPEE.judging },
    ]) {
      const { deps, chamadas } = clienteDe({ detalhe: envDetalhe(campos) });
      await recusada(
        executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso)),
      );
      expect(ops(chamadas)).toEqual(['getReturnDetail']);
    }
  });

  it('a recusa da Shopee na leitura das soluções PROPAGA na ação (não degrada como no estado)', async () => {
    const erro = recusaDaShopee('error_data', FRASE_DA_SHOPEE, SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH);
    const { deps, chamadas } = clienteDe({ solucoes: erro });
    await expect(
      executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso)),
    ).rejects.toBe(erro);
    expect(ops(chamadas)).not.toContain('offerReturn');
  });

  it('a solução escolhida inelegível ⇒ solucao-indisponivel', async () => {
    const { deps } = clienteDe({
      solucoes: envSolucoes({
        offer_return_refund: { eligibility: true },
        offer_refund: { eligibility: false },
      }),
    });
    const erro = await recusada(
      executarAcaoDevolucaoShopee(deps, OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso)),
    );
    expect(erro.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel);
    expect(erro.acoesDisponiveis).toEqual(['confirmar', 'ofertar', 'aceitar-oferta']);
  });
});

describe('executarAcaoDevolucaoShopee — aceitar-oferta', () => {
  it('a proposta viva igual ao eco: aceita, sem ler soluções', async () => {
    const { deps, chamadas } = clienteDe();
    const r = await executarAcaoDevolucaoShopee(deps, ACEITAR());
    expect(chamadas).toEqual([
      { op: 'getReturnDetail', args: { returnSn: RETURN_SN } },
      { op: 'acceptReturnOffer', args: { returnSn: RETURN_SN } },
    ]);
    expect(r.acao).toBe('aceitar-oferta');
  });

  it('sem PENDING_RESPOND ⇒ sem-proposta-do-comprador, sem escrita', async () => {
    const { deps, chamadas } = clienteDe({
      detalhe: envDetalhe({ negotiation: { negotiation_status: 'PENDING_BUYER_RESPOND' } }),
    });
    const erro = await recusada(executarAcaoDevolucaoShopee(deps, ACEITAR(null, null)));
    expect(erro.motivo).toBe(MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador);
    expect(ops(chamadas)).toEqual(['getReturnDetail']);
  });

  it('uma contraproposta chegou entre a leitura e o clique ⇒ proposta-mudou / valor-mudou', async () => {
    const outraSolucao = clienteDe({
      detalhe: envDetalhe({
        negotiation: {
          negotiation_status: 'PENDING_RESPOND',
          latest_solution: 'RETURN_REFUND',
          latest_offer_amount: 7.25,
        },
      }),
    });
    expect((await recusada(executarAcaoDevolucaoShopee(outraSolucao.deps, ACEITAR()))).motivo).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.propostaMudou,
    );
    const outroValor = clienteDe({
      detalhe: envDetalhe({
        negotiation: {
          negotiation_status: 'PENDING_RESPOND',
          latest_solution: 'REFUND',
          latest_offer_amount: 7.5,
        },
      }),
    });
    expect((await recusada(executarAcaoDevolucaoShopee(outroValor.deps, ACEITAR()))).motivo).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.valorMudou,
    );
    expect([...ops(outraSolucao.chamadas), ...ops(outroValor.chamadas)]).not.toContain(
      'acceptReturnOffer',
    );
  });
});

describe('executarAcaoDevolucaoShopee — o contrato do pedido (RangeError ANTES de qualquer chamada)', () => {
  const casos: readonly [string, PedidoDeAcaoDevolucao][] = [
    ['solucao com confirmar', { ...CONFIRMAR(), solucao: SHOPEE_RETURN_SOLUTION.soReembolso }],
    ['valorReembolsoMinor com confirmar', { ...CONFIRMAR(), valorReembolsoMinor: 100 }],
    ['solucaoExibida com confirmar', { ...CONFIRMAR(), solucaoExibida: null }],
    ['confirmar sem valorExibidoMinor', { ...base, acao: ACAO_DEVOLUCAO_SHOPEE.confirmar }],
    ['valorExibidoMinor negativo', CONFIRMAR(-1)],
    ['valorExibidoMinor em reais', CONFIRMAR(10.5)],
    ['ofertar sem solucao', { ...base, acao: ACAO_DEVOLUCAO_SHOPEE.ofertar }],
    ['ofertar com solução desconhecida', OFERTAR('refund' as PedidoDeAcaoDevolucao['solucao'])],
    ['ofertar com valor 0', OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso, 0)],
    ['ofertar com valor fracionário', OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso, 10.5)],
    [
      'valorExibidoMinor com ofertar',
      { ...OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso), valorExibidoMinor: 1 },
    ],
    [
      'solucaoExibida com ofertar',
      { ...OFERTAR(SHOPEE_RETURN_SOLUTION.soReembolso), solucaoExibida: null },
    ],
    [
      'aceitar sem solucaoExibida',
      { ...base, acao: ACAO_DEVOLUCAO_SHOPEE.aceitarOferta, valorExibidoMinor: 1 },
    ],
    [
      'aceitar sem valorExibidoMinor',
      { ...base, acao: ACAO_DEVOLUCAO_SHOPEE.aceitarOferta, solucaoExibida: null },
    ],
    ['aceitar com solucao', { ...ACEITAR(), solucao: SHOPEE_RETURN_SOLUTION.soReembolso }],
    [
      'aceitar com solucaoExibida desconhecida',
      ACEITAR('REFUND_ONLY' as PedidoDeAcaoDevolucao['solucaoExibida']),
    ],
    ['acao fora do enum', { ...CONFIRMAR(), acao: 'contestar' as AcaoDevolucaoShopee }],
    ['return_sn com hífen', { ...CONFIRMAR(), returnSn: '2609-1' }],
    ['pedidoId em branco', { ...CONFIRMAR(), pedidoId: '' }],
  ];

  it.each(casos)('%s', async (_, p) => {
    const { deps, chamadas } = clienteDe();
    await expect(executarAcaoDevolucaoShopee(deps, p)).rejects.toBeInstanceOf(RangeError);
    expect(chamadas).toEqual([]);
  });

  it('a mensagem nomeia o CAMPO, nunca o valor', async () => {
    const { deps } = clienteDe();
    const erro = await executarAcaoDevolucaoShopee(deps, {
      ...CONFIRMAR(),
      returnSn: 'ZZ-260910',
    }).catch((e: unknown) => e);
    expect((erro as RangeError).message).toContain('returnSn');
    expect((erro as RangeError).message).not.toContain('ZZ-260910');
  });
});
