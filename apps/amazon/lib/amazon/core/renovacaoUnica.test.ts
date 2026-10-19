/**
 * The forced-refresh-once rule, against REAL package errors and a recording
 * getter. No network: `fn` and `obterAcesso` are scripted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonThrottleError,
  type ContextoRequisicaoAmazon,
  type CredencialSpApi,
} from '@delfrance/integrations-amazon-sp-api';

import { executarComRenovacaoUnica } from './renovacaoUnica';

const SP: ContextoRequisicaoAmazon = {
  destino: 'sp-api',
  operacao: 'getOrder',
  metodo: 'GET',
  caminho: '/orders/2026-01-01/orders/000-0000000-0000001',
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

const spApi = (status: number) => new AmazonAuthError({ ...SP, status, codigoLwa: null });
const lwaInvalidGrant = () =>
  new AmazonAuthError({ ...LWA, status: 400, codigoLwa: 'invalid_grant' });

/** A context whose getter records every call and its options. */
function contexto(
  obter: () => Promise<CredencialSpApi> = () =>
    Promise.resolve({ accessToken: 'tok|TESTE-acesso', ref: 'ref.2' }),
) {
  const obterAcesso = vi.fn((_opts?: { readonly forcarRenovacao?: boolean }) => obter());
  return { ctx: { obterAcesso }, obterAcesso };
}

/** `fn` answering from a script: each entry an error to throw or a value to resolve. */
function roteiro<T>(...passos: (Error | T)[]) {
  const fila = [...passos];
  return vi.fn((): Promise<T> => {
    const passo = fila.shift();
    if (passo === undefined) throw new Error('roteiro esgotado');
    return passo instanceof Error ? Promise.reject(passo) : Promise.resolve(passo);
  });
}

describe('executarComRenovacaoUnica', () => {
  it('a success runs fn once and refreshes NOTHING', async () => {
    const { ctx, obterAcesso } = contexto();
    const fn = roteiro<string>('ok');
    await expect(executarComRenovacaoUnica(ctx, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(obterAcesso).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    '★ an SP-API %i forces EXACTLY one refresh, then ONE retry',
    async (status) => {
      const { ctx, obterAcesso } = contexto();
      const fn = roteiro<string>(spApi(status), 'ok');
      await expect(executarComRenovacaoUnica(ctx, fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(obterAcesso).toHaveBeenCalledTimes(1);
      expect(obterAcesso.mock.calls[0]).toEqual([{ forcarRenovacao: true }]);
    },
  );

  it('★ a SECOND 401 propagates untouched — no second refresh, no third call', async () => {
    const { ctx, obterAcesso } = contexto();
    const segunda = spApi(401);
    const fn = roteiro<string>(spApi(401), segunda, 'nunca');
    await expect(executarComRenovacaoUnica(ctx, fn)).rejects.toBe(segunda);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(obterAcesso).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Error]>([
    ['a 404', () => new AmazonNotFoundError({ ...SP, status: 404 })],
    ['a throttle', () => new AmazonThrottleError({ ...SP, status: 429, limiteTaxa: null })],
    ['a 400', () => new AmazonHttpError({ ...SP, status: 400 })],
    ['an LWA refusal from the getter inside fn', lwaInvalidGrant],
    ['a TypeError', () => new TypeError('bug')],
  ])('★ %s is NOT retried: it propagates at once, with zero refreshes', async (_c, falha) => {
    const { ctx, obterAcesso } = contexto();
    const err = falha();
    const fn = roteiro<string>(err, 'nunca');
    await expect(executarComRenovacaoUnica(ctx, fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(obterAcesso).not.toHaveBeenCalled();
  });

  it('an LWA refusal DURING the forced refresh propagates untouched, and fn is not retried', async () => {
    const recusa = lwaInvalidGrant();
    const { ctx, obterAcesso } = contexto(() => Promise.reject(recusa));
    const fn = roteiro<string>(spApi(401), 'nunca');
    await expect(executarComRenovacaoUnica(ctx, fn)).rejects.toBe(recusa);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(obterAcesso).toHaveBeenCalledTimes(1);
  });
});
