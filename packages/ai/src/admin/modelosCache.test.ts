import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_MODELOS_FALLBACK, resolveModelo } from '../models';
import { __resetAiModelosCache, getAiModelosCached, modelosParaValidacao } from './modelosCache';

beforeEach(() => {
  __resetAiModelosCache();
});

describe('getAiModelosCached', () => {
  it('projects a live answer and marks it live', async () => {
    const out = await getAiModelosCached(async () => [
      { name: 'publishers/google/models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
    ]);
    expect(out.fonte).toBe('live');
    expect(out.modelos).toEqual([{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }]);
  });

  it('caches a live answer instead of re-asking', async () => {
    const list = vi.fn(async () => [{ name: 'models/gemini-3.6-flash' }]);
    await getAiModelosCached(list);
    await getAiModelosCached(list);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('falls back to the shipped list on ANY provider failure', async () => {
    // The settings page is what someone opens to FIX a broken setting, so it is
    // exactly when the provider is most likely to be the broken thing. Every
    // failure class — 403 from a missing IAM grant, 404 from a location that
    // serves no models, a socket reset — has the same right answer.
    for (const err of [
      new Error('403 permission denied on aiplatform.googleapis.com'),
      new TypeError('fetch failed'),
      'a thrown string',
    ]) {
      __resetAiModelosCache();
      const out = await getAiModelosCached(async () => {
        throw err;
      });
      expect(out.fonte).toBe('fallback');
      expect(out.modelos).toEqual([...AI_MODELOS_FALLBACK]);
    }
  });

  it('does NOT cache a failure as if it were an answer', async () => {
    // A transient blip must not pin the fallback for the whole TTL and leave the
    // page claiming the catalogue is unavailable after it recovered.
    let attempt = 0;
    const list = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return [{ name: 'models/gemini-3.6-flash' }];
    };
    expect((await getAiModelosCached(list)).fonte).toBe('fallback');
    expect((await getAiModelosCached(list)).fonte).toBe('live');
  });

  it('reports a truncated reason, never the raw error object', async () => {
    const out = await getAiModelosCached(async () => {
      throw new Error('x'.repeat(500));
    });
    expect(out.erro).toBeDefined();
    expect(out.erro!.length).toBeLessThanOrEqual(200);
  });

  it('rethrows an abort — a cancelled request is not a provider failure', async () => {
    // Swallowing this would turn a caller's own cancellation into a silent
    // fallback list, and the caller would never learn its timeout fired.
    await expect(
      getAiModelosCached(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it('never hands back an empty list', async () => {
    const out = await getAiModelosCached(async () => []);
    expect(out.modelos.length).toBeGreaterThan(0);
    expect(out.fonte).toBe('fallback');
  });
});

describe('modelosParaValidacao', () => {
  it('is the live list when the provider answered', async () => {
    const lista = await getAiModelosCached(async () => [{ name: 'models/gemini-3.6-flash' }]);
    expect(modelosParaValidacao(lista)).toEqual(lista.modelos);
  });

  it('is EMPTY when the list is the shipped fallback', async () => {
    // ⚠️ The bug this closes. `getAiModelosCached` never answers empty — both
    // `projectModelos` and the catch substitute the fallback — so validating
    // against `.modelos` made `resolveModelo`'s "empty means we could not find
    // out" escape hatch unreachable, and INVERTED it: a transient `models.list`
    // blip shrank the known universe to three shipped ids and any stored model
    // outside them was declared retired and silently replaced.
    const lista = await getAiModelosCached(async () => {
      throw new Error('transient 503');
    });
    expect(lista.modelos.length).toBeGreaterThan(0);
    expect(modelosParaValidacao(lista)).toEqual([]);
  });

  it('leaves a stored model alone when only the LIST call failed', async () => {
    // Failing to list models is not evidence that generateContent would reject
    // the stored one. End-to-end through the real resolver.
    const lista = await getAiModelosCached(async () => {
      throw new Error('transient 503');
    });
    expect(
      resolveModelo({
        stored: 'gemini-3.7-pro',
        env: null,
        padrao: 'gemini-3.5-flash-lite',
        disponiveis: modelosParaValidacao(lista),
      }),
    ).toEqual({ modelo: 'gemini-3.7-pro', substituido: false });
  });

  it('still substitutes a retired model when the list IS live', async () => {
    // The guard must not disable the real validation it was built for.
    const lista = await getAiModelosCached(async () => [{ name: 'models/gemini-3.5-flash-lite' }]);
    expect(
      resolveModelo({
        stored: 'gemini-2.0-retired',
        env: null,
        padrao: 'gemini-3.5-flash-lite',
        disponiveis: modelosParaValidacao(lista),
      }),
    ).toEqual({ modelo: 'gemini-3.5-flash-lite', substituido: true });
  });
});
