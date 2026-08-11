import { describe, expect, it } from 'vitest';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';
import {
  describeMassImportStartError,
  describePriceSyncStartError,
  mercadoLivreQueryErrorMessage,
} from './mercadoLivreJobErrors';

describe('describeMassImportStartError', () => {
  it('maps ML_MASS_IMPORT_RUNNING to a yellow "already running" entry', () => {
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_MASS_IMPORT_RUNNING');
    expect(describeMassImportStartError(err)).toEqual({
      color: 'yellow',
      message: 'Já existe uma importação em andamento.',
    });
  });

  it('falls back to the backend message for any other HTTP code', () => {
    const err = new MercadoLivreClientHttpError(
      'Falha ao enfileirar a importação.',
      503,
      'ML_MASS_IMPORT_ENQUEUE_FAILED',
    );
    expect(describeMassImportStartError(err)).toEqual({
      color: 'red',
      message: 'Falha ao enfileirar a importação.',
    });
  });

  it('maps a network failure to its own copy', () => {
    expect(describeMassImportStartError(new MercadoLivreClientNetworkError('x'))).toEqual({
      color: 'red',
      message: 'Falha de rede ao iniciar a importação.',
    });
  });

  it('returns null for anything that is not a Mercado Livre client error', () => {
    // Rule 6: not ours to describe — the caller rethrows it.
    expect(describeMassImportStartError(new TypeError('boom'))).toBeNull();
    expect(describeMassImportStartError('nope')).toBeNull();
  });
});

describe('describePriceSyncStartError', () => {
  it('maps ML_PRICE_SYNC_RUNNING to a yellow "already running" entry', () => {
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_PRICE_SYNC_RUNNING');
    expect(describePriceSyncStartError(err)).toEqual({
      color: 'yellow',
      message: 'Já existe um envio de preços em andamento.',
    });
  });

  it('gives SEM_TABELA_NORMAL its own actionable copy', () => {
    const err = new MercadoLivreClientHttpError('sem tabela', 400, 'SEM_TABELA_NORMAL');
    expect(describePriceSyncStartError(err)).toEqual({
      color: 'red',
      message: 'Configure a tabela de preços normal da conta antes de enviar.',
    });
  });

  it('maps a network failure to its own copy', () => {
    expect(describePriceSyncStartError(new MercadoLivreClientNetworkError('x'))).toEqual({
      color: 'red',
      message: 'Falha de rede ao iniciar o envio de preços.',
    });
  });

  it('returns null for anything that is not a Mercado Livre client error', () => {
    expect(describePriceSyncStartError(new RangeError('boom'))).toBeNull();
  });
});

describe('mercadoLivreQueryErrorMessage', () => {
  const fallbacks = { network: 'rede caiu', unknown: 'não deu' };

  it('prefers the backend message on an HTTP error', () => {
    const err = new MercadoLivreClientHttpError('Importação não encontrada.', 404, null);
    expect(mercadoLivreQueryErrorMessage(err, fallbacks)).toBe('Importação não encontrada.');
  });

  it('keeps "unreachable" and "unknown state" distinct', () => {
    expect(mercadoLivreQueryErrorMessage(new MercadoLivreClientNetworkError('x'), fallbacks)).toBe(
      'rede caiu',
    );
    expect(mercadoLivreQueryErrorMessage(new TypeError('x'), fallbacks)).toBe('não deu');
  });
});
