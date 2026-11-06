/**
 * The read-side failure ladder (step 15, PR 15-b), extracted from the NF-e
 * task: one row per class, the most-derived class winning over its parent, and
 * every class it does not name answered `relancar`. The NF-e task's own answers
 * stay pinned by `nfe/processarNfe.test.ts`, untouched by the extraction.
 */
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonDocumentoEasyShipError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type ContextoRequisicaoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
  EstacionamentoAmazonEmConflitoError,
} from '../core/erros';
import { grpc } from '../testing/fakeDb';
import { AmazonLeituraDefasadaError, PedidoAmazonIlegivelError } from './erros';
import {
  FALHA_LEITURA_AMAZON,
  classificarFalhaDeLeituraAmazon,
  type FalhaLeituraAmazon,
} from './falhaLeituraAmazon';

const ORDER = '171-9876543-2109876';
const CONTA = 'conta-teste';

const SP: ContextoRequisicaoAmazon = {
  destino: 'sp-api',
  operacao: 'getOrder',
  metodo: 'GET',
  caminho: `/orders/2026-01-01/orders/${ORDER}`,
  correlationId: 'corr-1',
  requestIdAmazon: null,
  refCredencial: 'ref.1',
};
const LWA: ContextoRequisicaoAmazon = {
  ...SP,
  destino: 'lwa',
  operacao: 'trocarRefreshToken',
  metodo: 'POST',
  caminho: '/auth/o2/token',
};

const CASOS: readonly (readonly [string, unknown, FalhaLeituraAmazon])[] = [
  ['a 429', new AmazonThrottleError({ ...SP, status: 429, limiteTaxa: null }), 'pausa'],
  [
    'an LWA refusal',
    new AmazonAuthError({ ...LWA, status: 400, codigoLwa: 'invalid_grant' }),
    'auth-lwa',
  ],
  [
    'an SP-API 403 after the refresh',
    new AmazonAuthError({ ...SP, status: 403, codigoLwa: null }),
    'auth-sp-api',
  ],
  [
    'an SP-API 401 after the refresh',
    new AmazonAuthError({ ...SP, status: 401, codigoLwa: null }),
    'auth-sp-api',
  ],
  ['a 404', new AmazonNotFoundError({ ...SP, status: 404 }), 'nao-encontrado'],
  ['a 500', new AmazonHttpError({ ...SP, status: 500 }), 'transitorio'],
  ['a 503', new AmazonHttpError({ ...SP, status: 503 }), 'transitorio'],
  [
    'a 400',
    new AmazonHttpError({ ...SP, status: 400, codigosErro: ['InvalidInput'] }),
    'http-definitivo',
  ],
  ['a 3xx (never followed)', new AmazonHttpError({ ...SP, status: 302 }), 'http-definitivo'],
  [
    'a 2xx outside the shape',
    new AmazonSchemaError({ ...SP, status: 200, motivo: 'formato', campos: [] }),
    'esquema',
  ],
  ['a network failure', new AmazonNetworkError(SP, new TypeError('fetch failed')), 'transitorio'],
  ['our deadline', new AmazonTimeoutError({ ...SP, prazoMs: 20_000 }, null), 'transitorio'],
  [
    'a read older than the stored floor',
    new AmazonLeituraDefasadaError(CONTA, ORDER),
    'transitorio',
  ],
  ['an illegible order', new PedidoAmazonIlegivelError(ORDER, 'linha-duplicada'), 'ilegivel'],
  ['the read switch', new ChamadasAmazonDesligadasError(CONTA), 'chamadas-desligadas'],
  ['an inactive conta', new ContaAmazonInativaError(CONTA), 'conta-inativa'],
  ['a missing conta', new ContaAmazonNaoEncontradaError(CONTA), 'conta-indisponivel'],
  ['an unconnected conta', new ContaAmazonNaoConectadaError(CONTA), 'conta-indisponivel'],
  [
    'a PARKED credential (the getter, mid-run)',
    new ContaAmazonParadaError(CONTA, 400, 1),
    'conta-indisponivel',
  ],
  ['a removed credential', new CredencialAmazonAusenteError(CONTA), 'conta-indisponivel'],
  [
    'a corrupt credential',
    new CredencialAmazonInvalidaError(CONTA, ['acessoRef']),
    'conta-indisponivel',
  ],
];

describe('classificarFalhaDeLeituraAmazon', () => {
  it.each(CASOS)('★ %s ⇒ its token', (_nome, err, token) => {
    expect(classificarFalhaDeLeituraAmazon(err)).toBe(token);
  });

  it('★ most-derived first: a 429, a 401/403 and a 404 are AmazonHttpErrors, never read as their parent', () => {
    for (const err of [
      new AmazonThrottleError({ ...SP, status: 429, limiteTaxa: null }),
      new AmazonAuthError({ ...SP, status: 403, codigoLwa: null }),
      new AmazonNotFoundError({ ...SP, status: 404 }),
    ]) {
      expect(err).toBeInstanceOf(AmazonHttpError);
      expect(classificarFalhaDeLeituraAmazon(err)).not.toBe(FALHA_LEITURA_AMAZON.httpDefinitivo);
      expect(classificarFalhaDeLeituraAmazon(err)).not.toBe(FALHA_LEITURA_AMAZON.transitorio);
    }
  });

  it('★ rule 6: everything the ladder does not name is relancar — a bug, a config refusal, Firestore, the deploy shape, the park’s own conflict, the download’s class', () => {
    for (const err of [
      new TypeError('bug'),
      new Error('generic'),
      new AmazonConfigError('pedido', { operacao: 'getOrder', refCredencial: null }),
      grpc(14, 'UNAVAILABLE'),
      new ConfigAmazonAusenteError(['AMAZON_LWA_CLIENT_SECRET']),
      new EstacionamentoAmazonEmConflitoError(CONTA, 3),
      new AmazonDocumentoEasyShipError('sem-zpl'),
      null,
      undefined,
      'texto',
      { name: 'AmazonThrottleError' },
    ]) {
      expect(classificarFalhaDeLeituraAmazon(err)).toBe(FALHA_LEITURA_AMAZON.relancar);
    }
  });

  it('the tokens are closed and distinct', () => {
    const tokens = Object.values(FALHA_LEITURA_AMAZON);
    expect([...tokens].sort()).toEqual(
      [
        'auth-lwa',
        'auth-sp-api',
        'chamadas-desligadas',
        'conta-inativa',
        'conta-indisponivel',
        'esquema',
        'http-definitivo',
        'ilegivel',
        'nao-encontrado',
        'pausa',
        'relancar',
        'transitorio',
      ].sort(),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
