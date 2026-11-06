/**
 * A failure of the READ side of a dispatch, classified by its class into a
 * NEUTRAL token (step 15, PR 15-b): the context's conta and credential checks,
 * `getOrder` through `lerPedidoAmazon.ts`, and that reader's own refusals. The
 * class ladder the NF-e task ran inline since step 14, EXTRACTED so the Easy
 * Ship scheduling reads a failure the same way — one ladder, never a second
 * copy. Each flow maps the tokens onto its OWN answers: the NF-e task onto its
 * motivos (`nfe/processarNfe.ts`), the scheduling task and the label route onto
 * theirs. A token says what FAILED, never what to do about it.
 *
 * PURE: no Firestore, no clock, no logger. Most-derived class first (root
 * `CLAUDE.md` rule 6): `AmazonThrottleError`, `AmazonAuthError` and
 * `AmazonNotFoundError` before their parent `AmazonHttpError`;
 * `AmazonTimeoutError` is an `AmazonNetworkError`. Anything this ladder does
 * not name — an `AmazonConfigError` (nothing was sent: a bug), a Firestore
 * error, the LWA pair missing from the deploy, a `TypeError` — is `relancar`:
 * the caller rethrows it.
 *
 * | Class | Token |
 * | --- | --- |
 * | `AmazonThrottleError` (429) | `pausa` |
 * | `AmazonAuthError`, `destino: 'lwa'` | `auth-lwa` |
 * | `AmazonAuthError`, `destino: 'sp-api'` (a second 401/403 after the forced refresh) | `auth-sp-api` |
 * | `AmazonNotFoundError` (404) | `nao-encontrado` |
 * | `AmazonHttpError`, 5xx | `transitorio` |
 * | `AmazonHttpError`, any other status | `http-definitivo` |
 * | `AmazonSchemaError` | `esquema` |
 * | `AmazonNetworkError` (a timeout included) | `transitorio` |
 * | `AmazonLeituraDefasadaError` (a read older than the stored floor) | `transitorio` |
 * | `PedidoAmazonIlegivelError` | `ilegivel` |
 * | `ChamadasAmazonDesligadasError` (the read switch) | `chamadas-desligadas` |
 * | `ContaAmazonInativaError` | `conta-inativa` |
 * | `ContaAmazonNaoEncontradaError`, `ContaAmazonNaoConectadaError`, `ContaAmazonParadaError`, `CredencialAmazonAusenteError`, `CredencialAmazonInvalidaError` | `conta-indisponivel` |
 * | anything else | `relancar` |
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
} from '@delfrance/integrations-amazon-sp-api';

import {
  ChamadasAmazonDesligadasError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from '../core/erros';
import { AmazonLeituraDefasadaError, PedidoAmazonIlegivelError } from './erros';

/** What failed on the read side (module header). */
export const FALHA_LEITURA_AMAZON = {
  pausa: 'pausa',
  transitorio: 'transitorio',
  authLwa: 'auth-lwa',
  authSpApi: 'auth-sp-api',
  naoEncontrado: 'nao-encontrado',
  httpDefinitivo: 'http-definitivo',
  esquema: 'esquema',
  ilegivel: 'ilegivel',
  chamadasDesligadas: 'chamadas-desligadas',
  contaInativa: 'conta-inativa',
  contaIndisponivel: 'conta-indisponivel',
  relancar: 'relancar',
} as const satisfies Record<string, string>;

export type FalhaLeituraAmazon = (typeof FALHA_LEITURA_AMAZON)[keyof typeof FALHA_LEITURA_AMAZON];

/** The read-side failure's token (module header); `relancar` for anything it does not name. */
export function classificarFalhaDeLeituraAmazon(err: unknown): FalhaLeituraAmazon {
  if (err instanceof AmazonThrottleError) return FALHA_LEITURA_AMAZON.pausa;
  if (err instanceof AmazonAuthError) {
    return err.destino === 'lwa' ? FALHA_LEITURA_AMAZON.authLwa : FALHA_LEITURA_AMAZON.authSpApi;
  }
  if (err instanceof AmazonNotFoundError) return FALHA_LEITURA_AMAZON.naoEncontrado;
  if (err instanceof AmazonHttpError) {
    return err.transitorio ? FALHA_LEITURA_AMAZON.transitorio : FALHA_LEITURA_AMAZON.httpDefinitivo;
  }
  if (err instanceof AmazonSchemaError) return FALHA_LEITURA_AMAZON.esquema;
  if (err instanceof AmazonNetworkError) return FALHA_LEITURA_AMAZON.transitorio;
  if (err instanceof AmazonLeituraDefasadaError) return FALHA_LEITURA_AMAZON.transitorio;
  if (err instanceof PedidoAmazonIlegivelError) return FALHA_LEITURA_AMAZON.ilegivel;
  if (err instanceof ChamadasAmazonDesligadasError) return FALHA_LEITURA_AMAZON.chamadasDesligadas;
  if (err instanceof ContaAmazonInativaError) return FALHA_LEITURA_AMAZON.contaInativa;
  if (
    err instanceof ContaAmazonNaoEncontradaError ||
    err instanceof ContaAmazonNaoConectadaError ||
    err instanceof ContaAmazonParadaError ||
    err instanceof CredencialAmazonAusenteError ||
    err instanceof CredencialAmazonInvalidaError
  ) {
    return FALHA_LEITURA_AMAZON.contaIndisponivel;
  }
  return FALHA_LEITURA_AMAZON.relancar;
}
