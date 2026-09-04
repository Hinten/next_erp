import { describe, expect, it } from 'vitest';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';
import {
  describeMassImportCancelError,
  describeMassImportStartError,
  describePriceSyncCancelError,
  describePriceSyncStartError,
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

/* ------------------------------ the cancel pair ------------------------------ */

/**
 * The two cancel mappers share a contract the `describe*StartError` pair does
 * NOT have: they always return copy, never `null`, because their caller is an
 * async click handler that cannot rethrow. Every case below asserts a string.
 *
 * ⚠️ They are tested TOGETHER and against each other's codes on purpose. Both
 * feed the same `JobCardShell`, which hard-coded the mass-import one until
 * #1144 — so "does it map its own code?" was never the question that would have
 * caught the bug; "does it refuse the other flow's?" is.
 */
describe('describeMassImportCancelError', () => {
  it('maps ML_MASS_IMPORT_NOT_RUNNING to the benign-race copy', () => {
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_MASS_IMPORT_NOT_RUNNING');
    expect(describeMassImportCancelError(err)).toBe('Esta importação já foi finalizada.');
  });

  it('maps a 404 to its own copy, whatever the code', () => {
    const err = new MercadoLivreClientHttpError('…', 404, null);
    expect(describeMassImportCancelError(err)).toBe('Importação não encontrada.');
  });

  it('maps a network failure and an unrecognised error to copy, never to null', () => {
    expect(describeMassImportCancelError(new MercadoLivreClientNetworkError('x'))).toBe(
      'Falha de rede ao cancelar a importação.',
    );
    expect(describeMassImportCancelError(new RangeError('boom'))).toBe(
      'Não foi possível cancelar a importação.',
    );
  });

  it('does NOT recognise the price-sync cancel code', () => {
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_PRICE_SYNC_NOT_RUNNING');
    expect(describeMassImportCancelError(err)).not.toBe('Esta importação já foi finalizada.');
  });
});

describe('describePriceSyncCancelError', () => {
  it('maps ML_PRICE_SYNC_NOT_RUNNING to the benign-race copy', () => {
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_PRICE_SYNC_NOT_RUNNING');
    expect(describePriceSyncCancelError(err)).toBe('Este envio de preços já foi finalizado.');
  });

  it('⭐ does NOT match the START route’s ML_PRICE_SYNC_RUNNING', () => {
    // One word apart and the opposite condition: matching it here would tell an
    // operator whose envio just finished that one is still in andamento.
    const err = new MercadoLivreClientHttpError('…', 409, 'ML_PRICE_SYNC_RUNNING');
    expect(describePriceSyncCancelError(err)).not.toBe('Este envio de preços já foi finalizado.');
  });

  it('maps a 404 to its own copy, whatever the code', () => {
    const err = new MercadoLivreClientHttpError('…', 404, null);
    expect(describePriceSyncCancelError(err)).toBe('Envio de preços não encontrado.');
  });

  it('maps a network failure and an unrecognised error to copy, never to null', () => {
    expect(describePriceSyncCancelError(new MercadoLivreClientNetworkError('x'))).toBe(
      'Falha de rede ao cancelar o envio de preços.',
    );
    expect(describePriceSyncCancelError(new RangeError('boom'))).toBe(
      'Não foi possível cancelar o envio de preços.',
    );
  });
});
