import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { fraseDosCanaisImplementados } from './canaisImplementados';

const sim = { implementado: true } as const;
const nao = { implementado: false } as const;

describe('fraseDosCanaisImplementados', () => {
  it('names every implemented row, in pt-BR list form', () => {
    expect(
      fraseDosCanaisImplementados({
        [INTEGRACAO_TIPO.mercadoLivre]: sim,
        [INTEGRACAO_TIPO.lojaIntegrada]: sim,
        [INTEGRACAO_TIPO.shopee]: sim,
      }),
    ).toBe('implementados hoje: Mercado Livre, Loja Integrada e Shopee.');
  });

  it('leaves out a surveyed row whose implementado is still false (the near-miss)', () => {
    // Loja Integrada's real shape: a named `channel`, every capability 'sim',
    // and NOT built — it must not be listed.
    expect(
      fraseDosCanaisImplementados({
        [INTEGRACAO_TIPO.mercadoLivre]: sim,
        [INTEGRACAO_TIPO.lojaIntegrada]: nao,
        [INTEGRACAO_TIPO.shopee]: sim,
      }),
    ).toBe('implementados hoje: Mercado Livre e Shopee.');
  });

  it('agrees in number with one row, and says so with none', () => {
    expect(
      fraseDosCanaisImplementados({
        [INTEGRACAO_TIPO.mercadoLivre]: sim,
        [INTEGRACAO_TIPO.shopee]: nao,
      }),
    ).toBe('implementado hoje: Mercado Livre.');
    expect(fraseDosCanaisImplementados({ [INTEGRACAO_TIPO.shopee]: nao })).toBe(
      'nenhum está implementado ainda.',
    );
  });

  it('reads the live table — the copy the operator sees today', () => {
    // ⚠️ Reds at the NEXT flip on purpose: the sentence on /canais is part of
    // shipping a channel, so that PR re-reads it here.
    expect(fraseDosCanaisImplementados()).toBe('implementados hoje: Mercado Livre e Shopee.');
  });
});
