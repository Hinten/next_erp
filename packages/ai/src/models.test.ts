import { describe, expect, it } from 'vitest';

import {
  AI_MODELOS_FALLBACK,
  bareModelId,
  isSuggestionCapable,
  projectModelos,
  resolveModelo,
} from './models';

const PADRAO = 'gemini-3.5-flash-lite';

describe('bareModelId', () => {
  it('reduces every provider spelling to the id a call needs', () => {
    // Vertex sends a resource name, the Gemini API sends `models/<id>`, and a
    // config doc holds the bare id. All three must land on the same string.
    expect(bareModelId('publishers/google/models/gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(bareModelId('models/gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(bareModelId('gemini-3.6-flash')).toBe('gemini-3.6-flash');
  });

  it('survives a trailing slash and an empty name', () => {
    expect(bareModelId('models/gemini-3.6-flash/')).toBe('gemini-3.6-flash');
    expect(bareModelId('')).toBeNull();
    expect(bareModelId(undefined)).toBeNull();
  });
});

describe('isSuggestionCapable', () => {
  it('keeps a Vertex row that reports NO supportedActions', () => {
    // ⚠️ The load-bearing case. Vertex publisher rows omit `supportedActions`,
    // so an `includes('generateContent')` test filters the whole live list to
    // nothing — and the page would silently show only the fallback while
    // claiming it was live.
    expect(isSuggestionCapable({ name: 'publishers/google/models/gemini-3.6-flash' })).toBe(true);
    expect(
      isSuggestionCapable({
        name: 'publishers/google/models/gemini-3.6-flash',
        supportedActions: [],
      }),
    ).toBe(true);
  });

  it('drops a row that reports actions WITHOUT generateContent', () => {
    expect(
      isSuggestionCapable({
        name: 'models/gemini-embedding-001',
        supportedActions: ['embedContent'],
      }),
    ).toBe(false);
  });

  it('drops anything that is not a Gemini model', () => {
    expect(isSuggestionCapable({ name: 'publishers/google/models/imagen-4.0' })).toBe(false);
    expect(isSuggestionCapable({ name: 'publishers/meta/models/llama-4' })).toBe(false);
    expect(isSuggestionCapable({})).toBe(false);
  });
});

describe('projectModelos', () => {
  it('projects live rows and labels them', () => {
    const out = projectModelos([
      { name: 'publishers/google/models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
    ]);
    expect(out).toEqual({
      modelos: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }],
      fonte: 'live',
    });
  });

  it('falls back to the id when the provider sends no display name', () => {
    const out = projectModelos([{ name: 'models/gemini-3.6-flash', displayName: '  ' }]);
    expect(out.modelos[0]).toEqual({ id: 'gemini-3.6-flash', label: 'gemini-3.6-flash' });
  });

  it('dedups ids the provider repeats across versions', () => {
    const out = projectModelos([
      { name: 'publishers/google/models/gemini-3.6-flash' },
      { name: 'models/gemini-3.6-flash' },
    ]);
    expect(out.modelos).toHaveLength(1);
  });

  it('returns the shipped list, marked as fallback, when nothing survives', () => {
    // An answer full of unusable rows is, for the operator, the same as no
    // answer — and an empty Select makes the page look broken.
    expect(projectModelos([{ name: 'publishers/google/models/imagen-4.0' }])).toEqual({
      modelos: [...AI_MODELOS_FALLBACK],
      fonte: 'fallback',
    });
    expect(projectModelos([]).fonte).toBe('fallback');
  });

  it('never offers an empty list', () => {
    expect(projectModelos([]).modelos.length).toBeGreaterThan(0);
  });
});

describe('resolveModelo', () => {
  const disponiveis = [
    { id: PADRAO, label: 'x' },
    { id: 'gemini-3.6-flash', label: 'y' },
  ];

  it('prefers the config doc over the env var over the shipped default', () => {
    expect(
      resolveModelo({ stored: 'gemini-3.6-flash', env: PADRAO, padrao: PADRAO, disponiveis })
        .modelo,
    ).toBe('gemini-3.6-flash');
    expect(
      resolveModelo({ stored: null, env: 'gemini-3.6-flash', padrao: PADRAO, disponiveis }).modelo,
    ).toBe('gemini-3.6-flash');
    expect(resolveModelo({ stored: null, env: null, padrao: PADRAO, disponiveis }).modelo).toBe(
      PADRAO,
    );
  });

  it('treats a blank stored value as absent, not as a model named ""', () => {
    expect(resolveModelo({ stored: '   ', env: null, padrao: PADRAO, disponiveis }).modelo).toBe(
      PADRAO,
    );
  });

  it('replaces a stored model the provider no longer serves', () => {
    // A model retired between the save and the call would otherwise 404 from
    // Vertex as an opaque 500, on a button whose failure the operator cannot
    // diagnose.
    const out = resolveModelo({
      stored: 'gemini-2.0-retired',
      env: null,
      padrao: PADRAO,
      disponiveis,
    });
    expect(out).toEqual({ modelo: PADRAO, substituido: true });
  });

  it('never returns the unavailable value it just rejected', () => {
    const only = [{ id: 'gemini-3.6-flash', label: 'y' }];
    const out = resolveModelo({
      stored: 'gemini-2.0-retired',
      env: null,
      padrao: PADRAO,
      disponiveis: only,
    });
    expect(out).toEqual({ modelo: 'gemini-3.6-flash', substituido: true });
  });

  it('skips validation when the list is unknown rather than failing closed', () => {
    // An empty list means "we could not find out" — the live call failed and the
    // fallback was itself unavailable. Rejecting everything there would take the
    // feature down over a metadata read.
    const out = resolveModelo({ stored: 'gemini-experimental', env: null, padrao: PADRAO });
    expect(out).toEqual({ modelo: 'gemini-experimental', substituido: false });
  });
});
