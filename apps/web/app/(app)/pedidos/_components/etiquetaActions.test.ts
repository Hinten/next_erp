import { describe, expect, it } from 'vitest';

import { etiquetaRowState } from './etiquetaActions';

describe('etiquetaRowState', () => {
  const base = { tipo: 'melhorEnvios' as const, printLabelId: null, externalOptionId: null };

  it('returns none while the tipo is still resolving', () => {
    expect(etiquetaRowState({ ...base, tipo: null, estado: 'iniciado' }).action).toBe('none');
  });

  it('marks non-Melhor-Envio carriers as unsupported (v1)', () => {
    expect(etiquetaRowState({ ...base, tipo: 'motoboy', estado: 'iniciado' }).action).toBe(
      'unsupported',
    );
    expect(etiquetaRowState({ ...base, tipo: 'fob', estado: 'iniciado' }).action).toBe(
      'unsupported',
    );
  });

  it('offers reprint when a label is already bought', () => {
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: 'aguardandoPostagem' }).action,
    ).toBe('imprimir');
  });

  it('offers buy when a quote is selected but no label yet', () => {
    expect(etiquetaRowState({ ...base, externalOptionId: '2', estado: 'iniciado' }).action).toBe(
      'comprar',
    );
  });

  it('asks to quote first when there is no quote and no label', () => {
    expect(etiquetaRowState({ ...base, estado: 'iniciado' }).action).toBe('quote-first');
  });

  it('flags needsPostedConfirm only for already-posted estados', () => {
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: 'iniciado' }).needsPostedConfirm,
    ).toBe(false);
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: 'postado' }).needsPostedConfirm,
    ).toBe(true);
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: 'entregue' }).needsPostedConfirm,
    ).toBe(true);
  });
});
