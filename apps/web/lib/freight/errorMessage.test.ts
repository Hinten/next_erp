/**
 * `freightErrorMessage` — the shared pt-BR mapper the etiqueta surfaces use. Its
 * `null` arm is what makes callers rethrow (root `CLAUDE.md` rule 6).
 */
import { describe, expect, it } from 'vitest';

import {
  FreightHttpError,
  FreightLabelTerminalError,
  FreightNetworkError,
  FreightReauthRequiredError,
  FreightTimeoutError,
  FreightValidationError,
} from '@delfrance/integrations-freight-br/http-client';

import { freightErrorMessage } from './errorMessage';

describe('freightErrorMessage', () => {
  it('a timeout carries its own copy (#1094) — never "Falha de rede"', () => {
    // It subclasses FreightNetworkError, so its arm must come first; the copy
    // says whether a repeat is safe (a read) or must wait for a check (a buy).
    const compra = new FreightTimeoutError(
      'A compra pode ainda estar em andamento. Confira se a etiqueta já aparece no pedido.',
      { origem: 'gateway', timeoutMs: null, operacao: 'comprar' },
    );
    expect(freightErrorMessage(compra)).toBe(
      'A compra pode ainda estar em andamento. Confira se a etiqueta já aparece no pedido.',
    );
  });

  it('near-miss: a plain network error keeps the network copy', () => {
    expect(freightErrorMessage(new FreightNetworkError('x'))).toBe(
      'Falha de rede ao falar com o Melhor Envio.',
    );
  });

  it('maps the HTTP family', () => {
    expect(freightErrorMessage(new FreightReauthRequiredError('r', null))).toContain(
      'Reconecte em Logística',
    );
    expect(freightErrorMessage(new FreightLabelTerminalError('t', 'canceled', null))).toContain(
      '(canceled)',
    );
    expect(freightErrorMessage(new FreightValidationError('v', { cep: ['inválido'] }, null))).toBe(
      'inválido',
    );
    expect(freightErrorMessage(new FreightHttpError('boom', 500, null))).toBe('boom');
  });

  it('returns null for anything that is not a freight client error', () => {
    expect(freightErrorMessage(new TypeError('bug'))).toBeNull();
    expect(freightErrorMessage('x')).toBeNull();
  });
});
