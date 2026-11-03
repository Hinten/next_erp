/**
 * The catalogue's four process-scoped caches (`cache.ts`): their key, their TTL, their bounds,
 * and the primitive's behaviours the catalogue core leans on — a failure is never kept, a
 * predicate invalidation spares an in-flight load, and the clock is the module's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_CACHE_TTL,
  __resetAllReadCaches,
  readCacheStatsSnapshot,
} from '@delfrance/data/admin/cache';

import { AGORA_MS } from '../testing/fixtures';
import {
  CACHES_DO_CATALOGO_LI,
  type ChaveCatalogoLi,
  MAX_ENTRADAS_CATALOGO_LI,
  RECURSOS_CATALOGO_LI,
  type RecursoCatalogoLi,
  type RespostasCatalogoLi,
  SEM_VERSAO_CATALOGO_LI,
  __setRelogioDoCatalogoParaTestes,
  chaveDoCatalogoLi,
} from './cache';

let agora = AGORA_MS;

beforeEach(() => {
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setRelogioDoCatalogoParaTestes(() => agora);
});

afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCatalogoParaTestes();
  vi.restoreAllMocks();
});

/** One answer per resource (empty lists: the cache never looks inside). */
const VALORES: RespostasCatalogoLi = {
  categorias: { categorias: [], lidaEmMs: AGORA_MS },
  marcas: { marcas: [], lidaEmMs: AGORA_MS },
  grades: { grades: [], lidaEmMs: AGORA_MS },
  grade: { grade: { id: 1, nome: 'g', nomeVisivel: null }, opcoes: [], lidaEmMs: AGORA_MS },
};

/** `get` on `recurso`'s cache, counting the loads in `contador`. */
function obter<R extends RecursoCatalogoLi>(
  recurso: R,
  chave: ChaveCatalogoLi,
  contador: { n: number } = { n: 0 },
): Promise<RespostasCatalogoLi[R]> {
  return CACHES_DO_CATALOGO_LI[recurso].get(chave, () => {
    contador.n += 1;
    return Promise.resolve(VALORES[recurso]);
  });
}

describe('the catalogue caches', () => {
  it('four instances, one per resource, each under its own name', async () => {
    expect(RECURSOS_CATALOGO_LI).toEqual(['categorias', 'marcas', 'grades', 'grade']);
    for (const recurso of RECURSOS_CATALOGO_LI) {
      // A `get` registers the cache with the stats registry after a reset.
      expect(await obter(recurso, chaveDoCatalogoLi('c', 'v', recurso, null))).toBe(
        VALORES[recurso],
      );
    }
    expect(readCacheStatsSnapshot().map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'li:catalogo-categorias',
        'li:catalogo-marcas',
        'li:catalogo-grades',
        'li:catalogo-grade',
      ]),
    );
  });

  it('a settled answer is served until the 15-minute TTL, then read again', async () => {
    const chave = chaveDoCatalogoLi('conta-1', '1700', 'categorias', null);
    const c = { n: 0 };
    await obter('categorias', chave, c);
    agora += READ_CACHE_TTL.config - 1;
    await obter('categorias', chave, c);
    expect(c.n).toBe(1);
    agora += 1;
    await obter('categorias', chave, c);
    expect(c.n).toBe(2);
    expect(READ_CACHE_TTL.config).toBe(15 * 60 * 1000);
  });

  it('the key: the same conta, version, resource and grade hit; any one of them changed misses', async () => {
    const c = { n: 0 };
    await obter('grade', chaveDoCatalogoLi('conta-1', '1700', 'grade', '8946'), c);
    await obter('grade', chaveDoCatalogoLi('conta-1', '1700', 'grade', '8946'), c);
    expect(c.n).toBe(1);
    for (const outra of [
      chaveDoCatalogoLi('conta-2', '1700', 'grade', '8946'),
      chaveDoCatalogoLi('conta-1', '1701', 'grade', '8946'),
      chaveDoCatalogoLi('conta-1', SEM_VERSAO_CATALOGO_LI, 'grade', '8946'),
      chaveDoCatalogoLi('conta-1', '1700', 'grade', '8947'),
    ]) {
      await obter('grade', outra, c);
    }
    expect(c.n).toBe(5);
  });

  it('the key is the tuple itself, so the primitive encodes each part apart', async () => {
    expect(chaveDoCatalogoLi('a', '1', 'grades', null)).toEqual(['a', '1', 'grades', null]);
    // A conta id carrying the encoding's separator is still its own conta.
    const c = { n: 0 };
    await obter('grades', chaveDoCatalogoLi('a|b', '1', 'grades', null), c);
    await obter('grades', chaveDoCatalogoLi('a', 'b|1', 'grades', null), c);
    expect(c.n).toBe(2);
  });

  it('each instance is bounded: 8 / 8 / 8 / 128 entries, least recently used out first', async () => {
    expect(MAX_ENTRADAS_CATALOGO_LI).toEqual({ categorias: 8, marcas: 8, grades: 8, grade: 128 });
    for (const recurso of RECURSOS_CATALOGO_LI) {
      const limite = MAX_ENTRADAS_CATALOGO_LI[recurso];
      for (let i = 0; i <= limite; i += 1) {
        await obter(recurso, chaveDoCatalogoLi(`conta-${String(i)}`, '1', recurso, null));
      }
      const stats = CACHES_DO_CATALOGO_LI[recurso].stats();
      expect(stats.size, recurso).toBe(limite);
      expect(stats.evictions, recurso).toBe(1);
      // The first key in is the one out: reading it again loads again.
      const c = { n: 0 };
      await obter(recurso, chaveDoCatalogoLi('conta-0', '1', recurso, null), c);
      expect(c.n, recurso).toBe(1);
    }
  });

  it('a failed load is never kept: the next request loads again', async () => {
    const chave = chaveDoCatalogoLi('conta-1', '1', 'marcas', null);
    let n = 0;
    const falha = () => {
      n += 1;
      return Promise.reject(new TypeError('falha de teste'));
    };
    await expect(CACHES_DO_CATALOGO_LI.marcas.get(chave, falha)).rejects.toThrow(TypeError);
    await expect(CACHES_DO_CATALOGO_LI.marcas.get(chave, falha)).rejects.toThrow(TypeError);
    expect(n).toBe(2);
  });

  it('a settled-only invalidation spares an in-flight load (it is joined), and drops a settled one', async () => {
    const chave = chaveDoCatalogoLi('conta-1', '1', 'grades', null);
    let soltar: (v: RespostasCatalogoLi['grades']) => void = () => undefined;
    let n = 0;
    const lenta = () => {
      n += 1;
      return new Promise<RespostasCatalogoLi['grades']>((resolve) => {
        soltar = resolve;
      });
    };
    const primeira = CACHES_DO_CATALOGO_LI.grades.get(chave, lenta);
    CACHES_DO_CATALOGO_LI.grades.invalidate(chave, () => true);
    const segunda = CACHES_DO_CATALOGO_LI.grades.get(chave, lenta);
    soltar(VALORES.grades);
    expect(await primeira).toBe(await segunda);
    expect(n).toBe(1);
    // Settled now: the same invalidation drops it.
    CACHES_DO_CATALOGO_LI.grades.invalidate(chave, () => true);
    const c = { n: 0 };
    await obter('grades', chave, c);
    expect(c.n).toBe(1);
  });

  it('never logs a sampled stats line (sampleEvery 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chave = chaveDoCatalogoLi('conta-1', '1', 'categorias', null);
    for (let i = 0; i < 600; i += 1) await obter('categorias', chave);
    expect(warn).not.toHaveBeenCalled();
  });
});
