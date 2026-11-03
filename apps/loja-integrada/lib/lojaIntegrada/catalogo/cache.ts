/**
 * The catalogue's process-scoped caches (master plan step 10): one per resource the four
 * catalogue routes answer, each holding the PROJECTED answer (`@delfrance/schemas`'
 * `catalogoLojaIntegrada.ts`), never a wire row. Used by `catalogo.ts` ONLY.
 *
 * ## The key: `[conta, credential version, resource, grade]`
 *
 * The credential VERSION is part of the key (`core/contexto.ts`'s `versaoCredencial`, the
 * save's own stamp, never the ref or the fingerprint): a token saved for the conta — maybe
 * another store's — starts a fresh key at once, instead of serving the old store's lists for the
 * rest of the TTL. A version that changes DURING a load is the core's to refuse (`catalogo.ts`):
 * such a load fails, and a failure is never kept. {@link SEM_VERSAO_CATALOGO_LI} stands in for a
 * stamp with no version form.
 *
 * ## None of the forbidden reads
 *
 * Nothing here is read inside a multi-document atomic write, written back, or a credential: the
 * values are Loja Integrada's lists as answered, and the token stays uncached inside the context's
 * client getter. A name copied from a cached list is a label; the ids are the identity.
 *
 * ## Staleness
 *
 * `READ_CACHE_TTL.config` (15 min) IS the bound: a grade or option created in the painel shows
 * after the TTL, or at once through the route's `?atualizar=1`, which evicts this instance's
 * SETTLED copy only (another warm instance waits out its TTL). `negativeTtlMs: 0` and no value is
 * ever negative: there is no negative caching, and a 404 on a grade is a failure, never a value.
 * `sampleEvery: 0`: the built-in sampler logs through `console.warn`, the wrong severity for a
 * metric.
 *
 * ⚠️ A cached value is SHARED by reference between requests: never mutate one.
 */
import { READ_CACHE_TTL, type ReadCache, createReadCache } from '@delfrance/data/admin/cache';
import type {
  RespostaCategoriasLi,
  RespostaGradeLi,
  RespostaGradesLi,
  RespostaMarcasLi,
} from '@delfrance/schemas';

/** The four catalogue resources, in the order the routes list them. */
export const RECURSOS_CATALOGO_LI = ['categorias', 'marcas', 'grades', 'grade'] as const;
export type RecursoCatalogoLi = (typeof RECURSOS_CATALOGO_LI)[number];

/** What each resource answers: the route contract's body. */
export interface RespostasCatalogoLi {
  readonly categorias: RespostaCategoriasLi;
  readonly marcas: RespostaMarcasLi;
  readonly grades: RespostaGradesLi;
  readonly grade: RespostaGradeLi;
}

/** The key's version part when the credential's stamp has no version form. */
export const SEM_VERSAO_CATALOGO_LI = '-';

/** `[conta, credential version, resource, grade id or null]`. */
export type ChaveCatalogoLi = readonly [string, string, RecursoCatalogoLi, string | null];

/** One catalogue key. The grade id is `null` on the three lists. */
export function chaveDoCatalogoLi(
  contaId: string,
  versao: string,
  recurso: RecursoCatalogoLi,
  gradeId: string | null,
): ChaveCatalogoLi {
  return [contaId, versao, recurso, gradeId];
}

/**
 * How many entries each instance holds: a few contas' lists, and many grades (one per grade a
 * linker opens).
 */
export const MAX_ENTRADAS_CATALOGO_LI = {
  categorias: 8,
  marcas: 8,
  grades: 8,
  grade: 128,
} as const satisfies Record<RecursoCatalogoLi, number>;

/**
 * Injectable clock. `createReadCache` captures `opts.now` once, at construction — import time for
 * a module-scope cache — so each instance goes through this binding via an arrow. Production never
 * moves it.
 */
let relogioDoCatalogo: () => number = Date.now;

function criar<V>(recurso: RecursoCatalogoLi): ReadCache<ChaveCatalogoLi, V> {
  return createReadCache<ChaveCatalogoLi, V>({
    name: `li:catalogo-${recurso}`,
    ttlMs: READ_CACHE_TTL.config,
    maxEntries: MAX_ENTRADAS_CATALOGO_LI[recurso],
    negativeTtlMs: 0,
    now: () => relogioDoCatalogo(),
    sampleEvery: 0,
  });
}

/** The four instances, at module scope (the primitive's contract). */
export const CACHES_DO_CATALOGO_LI: {
  readonly [R in RecursoCatalogoLi]: ReadCache<ChaveCatalogoLi, RespostasCatalogoLi[R]>;
} = {
  categorias: criar<RespostaCategoriasLi>('categorias'),
  marcas: criar<RespostaMarcasLi>('marcas'),
  grades: criar<RespostaGradesLi>('grades'),
  grade: criar<RespostaGradeLi>('grade'),
};

/**
 * Test-only. The caches are module-scope, so `now` cannot be passed per test. Pair it with
 * `__resetAllReadCaches()`.
 */
export function __setRelogioDoCatalogoParaTestes(now: () => number = Date.now): void {
  relogioDoCatalogo = now;
}
