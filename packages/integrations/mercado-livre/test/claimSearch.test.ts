import { describe, expect, it, vi } from 'vitest';

import {
  CLAIM_SEARCH_DEFAULT_LIMIT,
  CLAIM_SEARCH_FILTER_KEYS,
  CLAIM_SEARCH_MAX_LIMIT,
  CLAIM_SEARCH_WINDOW_MAX,
  MercadoLivreClaimSearchParamsError,
  claimSearchFiltersUsed,
  timestampsSemMilissegundos,
  validateClaimSearchParams,
  type MlClaimSearchParams,
} from '../src';

const SELLER = 3616169770;
/** The one shape that is always valid, used as the base for every near-miss. */
const VALIDO: MlClaimSearchParams = {
  'players.user_id': SELLER,
  'players.role': 'respondent',
  limit: 30,
  offset: 0,
};

function recusa(params: MlClaimSearchParams): MercadoLivreClaimSearchParamsError {
  const erro = (() => {
    try {
      validateClaimSearchParams(params);
      return null;
    } catch (err: unknown) {
      if (err instanceof MercadoLivreClaimSearchParamsError) return err;
      throw err;
    }
  })();
  expect(erro, `esperava recusa para ${JSON.stringify(params)}`).not.toBeNull();
  return erro!;
}

describe('CLAIM_SEARCH_FILTER_KEYS', () => {
  /**
   * ⚠️ This is the distinction the whole module turns on, and getting it wrong is
   * how the fixture capture shipped a query guaranteed to be refused (#1357). ML
   * is explicit: paging and ordering *"não contam como filtro"*.
   */
  it('excludes every paging/ordering key', () => {
    for (const k of ['offset', 'limit', 'sort', 'range'] as const) {
      expect(CLAIM_SEARCH_FILTER_KEYS).not.toContain(k);
    }
  });

  it('carries the 16 names ML lists in its own 400 body', () => {
    expect([...CLAIM_SEARCH_FILTER_KEYS].sort()).toEqual(
      [
        'date_created',
        'id',
        'last_updated',
        'order_id',
        'pack_id',
        'parent_id',
        'payment_id',
        'players.role',
        'players.user_id',
        'reason_id',
        'resource',
        'resource_id',
        'site_id',
        'stage',
        'status',
        'type',
      ].sort(),
    );
  });
});

describe('claimSearchFiltersUsed', () => {
  it('reports only the filters actually carried', () => {
    expect(claimSearchFiltersUsed(VALIDO)).toEqual(['players.role', 'players.user_id']);
  });

  it('ignores paging even when it is all there is', () => {
    expect(claimSearchFiltersUsed({ limit: 30, offset: 0, sort: 'date_created:desc' })).toEqual([]);
  });

  /** A blank string is not a filter — it would reach ML as `&type=` and filter nothing. */
  it('treats an empty or whitespace-only value as absent', () => {
    expect(claimSearchFiltersUsed({ type: '' })).toEqual([]);
    expect(claimSearchFiltersUsed({ type: '   ' })).toEqual([]);
    expect(claimSearchFiltersUsed({ type: 'mediations' })).toEqual(['type']);
  });

  /** `0` is a legitimate value; `presente` must not fold it away as falsy. */
  it('counts a numeric zero as present', () => {
    expect(claimSearchFiltersUsed({ id: 0 })).toEqual(['id']);
  });
});

describe('validateClaimSearchParams — at least one real filter', () => {
  it('accepts the recommended pair', () => {
    expect(() => validateClaimSearchParams(VALIDO)).not.toThrow();
  });

  /**
   * ⭐ **The near-miss that matters.** `limit` and `offset` are present in the
   * valid query above too, so "carries paging" can never be the test — what must
   * be refused is paging with no filter *beside* it. This is the exact query
   * `capture:fixtures` sent on every run.
   */
  it('REFUSES paging with no filter beside it — the #1357 query', () => {
    const erro = recusa({ limit: 50, offset: 0 });
    expect(erro.message).toContain('pelo menos um filtro');
    expect(erro.message).toContain('invalid_query');
  });

  it.each([
    {},
    { sort: 'date_created:desc' },
    { range: 'date_created:after:2026-01-01T00:00:00.000+00:00' },
  ])('REFUSES %j — still no filter', (params) => {
    expect(() => validateClaimSearchParams(params)).toThrow(MercadoLivreClaimSearchParamsError);
  });

  /**
   * ⚠️ **Inefficient is NOT invalid.** ML calls a bare `status` *"tecnicamente
   * válida, porém altamente ineficiente"*, so refusing it would reject a legal
   * call. It warns instead — and the warning is asserted, because a guard whose
   * only observable behaviour is doing nothing is indistinguishable from a
   * missing guard.
   */
  it('ACCEPTS a bare status but warns about the unbounded scan', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => validateClaimSearchParams({ status: 'opened', limit: 30 })).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('rate limiting');
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT warn once the query is bounded by the recommended pair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      validateClaimSearchParams({ ...VALIDO, status: 'opened' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['id', 'type', 'stage', 'order_id', 'reason_id'] as const)(
    'accepts %s as a sufficient filter on its own',
    (key) => {
      const params = { [key]: key.endsWith('_id') && key !== 'reason_id' ? 1 : 'x' };
      expect(() => validateClaimSearchParams(params as MlClaimSearchParams)).not.toThrow();
    },
  );
});

describe('validateClaimSearchParams — the pairwise dependencies', () => {
  it('refuses resource_id without resource', () => {
    expect(recusa({ resource_id: 2000017734643056 }).message).toContain('`resource_id` exige');
  });

  it('refuses resource with neither resource_id nor the players pair', () => {
    expect(recusa({ status: 'opened', resource: 'order' }).message).toContain('`resource` exige');
  });

  it('accepts resource + resource_id', () => {
    expect(() =>
      validateClaimSearchParams({ resource: 'order', resource_id: 9876543210 }),
    ).not.toThrow();
  });

  /** ML's second documented way to satisfy `resource`. */
  it('accepts resource satisfied by the players pair instead', () => {
    expect(() => validateClaimSearchParams({ ...VALIDO, resource: 'order' })).not.toThrow();
  });

  it.each([
    ['players.role', { status: 'opened', 'players.role': 'respondent' }],
    ['players.user_id', { status: 'opened', 'players.user_id': SELLER }],
  ] as const)('refuses %s without its partner', (_name, params) => {
    expect(recusa(params).message).toContain('só valem juntos');
  });

  it('refuses order_id together with pack_id', () => {
    expect(recusa({ order_id: 1, pack_id: 2 }).message).toContain('mutuamente exclusivos');
  });

  it('accepts either of order_id / pack_id alone', () => {
    expect(() => validateClaimSearchParams({ order_id: 1 })).not.toThrow();
    expect(() => validateClaimSearchParams({ pack_id: 2 })).not.toThrow();
  });
});

describe('validateClaimSearchParams — the 10000-row window', () => {
  it('accepts the last page that fits', () => {
    expect(() =>
      validateClaimSearchParams({ ...VALIDO, offset: CLAIM_SEARCH_WINDOW_MAX - 31, limit: 30 }),
    ).not.toThrow();
  });

  /** ML's own example of an invalid one: offset 9950 + limit 50 == 10000. */
  it('refuses a sum EQUAL to the cap, not just greater', () => {
    expect(recusa({ ...VALIDO, offset: 9950, limit: 50 }).message).toContain('10000');
  });

  /**
   * ⚠️ The near-miss on the default: with no `limit` at all the sum looks fine
   * arithmetically, but ML applies its own default of 30 and the request is
   * refused. Reading the absent limit as 0 would let this through.
   */
  it('applies ML default limit of 30 when none is sent', () => {
    expect(CLAIM_SEARCH_DEFAULT_LIMIT).toBe(30);
    const semLimite = { ...VALIDO, limit: undefined, offset: CLAIM_SEARCH_WINDOW_MAX - 10 };
    expect(recusa(semLimite).message).toContain('30');
    // …and one row lower it fits.
    expect(() =>
      validateClaimSearchParams({
        ...VALIDO,
        limit: undefined,
        offset: CLAIM_SEARCH_WINDOW_MAX - 31,
      }),
    ).not.toThrow();
  });

  /**
   * ⚠️ The window is evaluated against the CLAMPED limit, because that is what
   * ML applies (*"Valores maiores que 100 são ajustados automaticamente para
   * 100"*). Summing the raw limit refuses a call ML answers — and refusing a
   * legal call is its own defect. The pair below is the whole point: the same
   * over-100 limit passes at one offset and is still refused at another, so the
   * clamp cannot be mistaken for "large limits are always fine".
   */
  it('sums the CLAMPED limit, so an over-100 limit is not refused on its own', () => {
    expect(CLAIM_SEARCH_MAX_LIMIT).toBe(100);
    // ML sees 9500 + 100 = 9600 and answers.
    expect(() => validateClaimSearchParams({ ...VALIDO, offset: 9500, limit: 1000 })).not.toThrow();
  });

  it('still refuses when even the CLAMPED limit overflows the window', () => {
    // 9950 + min(1000, 100) = 10050.
    const erro = recusa({ ...VALIDO, offset: 9950, limit: 1000 });
    expect(erro.message).toContain('10050');
    // …and it says the limit was adjusted, so the arithmetic is not a mystery.
    expect(erro.message).toContain('100');
  });
});

/**
 * ⚠️ `NaN` passes every comparison in the window rule silently — `NaN + 30 >=
 * 10000` is `false` — so without an explicit finiteness test a broken cursor
 * leaves the process as the literal query string `offset=NaN`.
 * `SyncCursor.token` is opaque and persisted, so `Number(token)` genuinely can
 * be `NaN` in normal operation.
 */
describe('validateClaimSearchParams — offset and limit must be finite', () => {
  /**
   * ⚠️ Every assertion here matches the word `finito`, NOT just the field name.
   * The window rule's message names `offset` too, and `Infinity + 30 >= 10000`
   * is `true` — so asserting the field name alone lets the window rule satisfy
   * a test that claims to pin finiteness, and the test passes with the
   * finiteness check deleted. Mutation-proven: it does.
   */
  it('refuses a NaN offset instead of letting it reach the wire', () => {
    const erro = recusa({ ...VALIDO, offset: Number('nao-e-numero') });
    expect(erro.message).toContain('offset');
    expect(erro.message).toContain('finito');
  });

  it('refuses a NaN limit too', () => {
    const erro = recusa({ ...VALIDO, limit: Number.NaN });
    expect(erro.message).toContain('limit');
    expect(erro.message).toContain('finito');
  });

  it('refuses Infinity, not just NaN — and for BEING infinite, not for overflowing', () => {
    const erro = recusa({ ...VALIDO, offset: Number.POSITIVE_INFINITY });
    expect(erro.message).toContain('offset');
    expect(erro.message).toContain('finito');
  });

  /** `-Infinity` cannot trip the window rule at all, so only finiteness catches it. */
  it('refuses -Infinity, which no other rule would reject', () => {
    const erro = recusa({ ...VALIDO, offset: Number.NEGATIVE_INFINITY });
    expect(erro.message).toContain('finito');
  });

  /** The control: ordinary finite values are untouched by the new rule. */
  it('accepts ordinary finite paging', () => {
    expect(() => validateClaimSearchParams({ ...VALIDO, offset: 0, limit: 30 })).not.toThrow();
    expect(() => validateClaimSearchParams({ ...VALIDO, offset: 60, limit: 30 })).not.toThrow();
  });
});

describe('timestampsSemMilissegundos', () => {
  /** ML's own counter-example from the docs. */
  it('flags the documented bad range value', () => {
    expect(timestampsSemMilissegundos('last_updated:after:2026-03-19T12:31:54+00:00')).toEqual([
      '2026-03-19T12:31:54',
    ]);
  });

  it('passes a value that carries milliseconds', () => {
    expect(timestampsSemMilissegundos('last_updated:after:2026-03-19T12:31:54.000+00:00')).toEqual(
      [],
    );
  });

  /** A range carries TWO bounds, and only one of them may be wrong. */
  it('flags only the offending bound of a two-bound range', () => {
    expect(
      timestampsSemMilissegundos(
        'date_created:after:2024-01-01T00:00:00.000-0300,before:2024-03-01T00:00:00-0300',
      ),
    ).toEqual(['2024-03-01T00:00:00']);
  });

  it('finds nothing in a string with no timestamp at all', () => {
    expect(timestampsSemMilissegundos('date_created:desc')).toEqual([]);
  });
});

describe('validateClaimSearchParams — millisecond-less timestamps', () => {
  it.each(['range', 'date_created', 'last_updated'] as const)('refuses %s without ms', (campo) => {
    const erro = recusa({ ...VALIDO, [campo]: '2026-03-19T12:31:54+00:00' });
    expect(erro.message).toContain('milissegundos');
    expect(erro.message).toContain(campo);
  });

  it('accepts the same fields once the milliseconds are there', () => {
    expect(() =>
      validateClaimSearchParams({
        ...VALIDO,
        range: 'last_updated:after:2026-03-19T12:31:54.000+00:00',
      }),
    ).not.toThrow();
  });
});
