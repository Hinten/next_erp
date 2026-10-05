import { describe, expect, it } from 'vitest';
import { resetControlLabel, resolveListMode, type ResolveListModeInput } from './resolveListMode';

/** The one input that yields `live` — every case below perturbs exactly one field. */
const LIVE: ResolveListModeInput = {
  hasQueryOverride: false,
  hasDeclaredQuery: true,
  columnFilterCount: 0,
  extraFilterCount: 0,
  searchTerm: '',
  idRestrictionActive: false,
  orderBySerial: 'timestamp:desc',
  declaredOrderBySerial: 'timestamp:desc',
};

const mode = (over: Partial<ResolveListModeInput> = {}) => resolveListMode({ ...LIVE, ...over });

describe('resolveListMode', () => {
  it('streams the declared query', () => {
    expect(mode()).toEqual({ mode: 'live', reason: null });
  });

  // Each of these is a shape the index guards do NOT assert an index for, so
  // each must be refused the live path. Table-driven so adding a new input
  // field without deciding its mode is visible.
  it.each([
    ['a caller-owned query', { hasQueryOverride: true }, 'override'],
    ['no declared query', { hasDeclaredQuery: false }, 'no-declared-query'],
    ['a column filter', { columnFilterCount: 1 }, 'filter'],
    ['a page-owned extra filter', { extraFilterCount: 1 }, 'filter'],
    ['a search term', { searchTerm: 'abc' }, 'search'],
    ['an id restriction', { idRestrictionActive: true }, 'ids'],
    ['a different sort field', { orderBySerial: 'nome:asc' }, 'sort'],
    ['the same field, other direction', { orderBySerial: 'timestamp:asc' }, 'sort'],
  ] as const)('is static under %s', (_label, over, reason) => {
    expect(mode(over)).toEqual({ mode: 'static', reason });
  });

  it('reports the most actionable reason when several apply', () => {
    // The operator can only act on one control at a time; naming the id
    // restriction ahead of the sort matches what they would clear first.
    expect(mode({ idRestrictionActive: true, orderBySerial: 'nome:asc' }).reason).toBe('ids');
  });

  /**
   * ⚠️ TRIPWIRE — do not "fix" this by relaxing the assertion.
   *
   * It pins that a SORT alone is enough to leave the live path. Widening the
   * rule so a non-declared sort (or a filter) keeps streaming turns today's
   * one-off unindexed scan into a PERSISTENT watch over a full collection scan:
   * Firestore Enterprise raises no error for a missing index, it silently
   * full-scans and bills data scanned, so nothing else in this repo would say a
   * word. `/clientes` has eight indexes and none on `tipo`.
   *
   * Before loosening this, `deriveRequiredIndex`
   * (`packages/config-eslint/rules/lib/required-index.js`) must first learn to
   * derive one index per DECLARED filter and per DECLARED sort — plural — and
   * those must be declared on `CollectionDefaultQuery` so
   * `defaultQuery.indexes.test.ts` can assert them. Only shapes that guard can
   * see may stream. `764c77fd` is the precedent: hand-written composites went
   * orphaned precisely because that test derives only the base where/orderBy.
   */
  it('refuses to stream a sort the index guard has not seen', () => {
    expect(mode({ orderBySerial: 'nome:asc' }).mode).toBe('static');
    expect(mode({ columnFilterCount: 1 }).mode).toBe('static');
  });
});

describe('resetControlLabel', () => {
  it('offers to clear whatever is the operator’s', () => {
    expect(resetControlLabel(true, 'live')).toMatch(/^Limpa a ordenação/);
    expect(resetControlLabel(true, 'static')).toMatch(/^Limpa a ordenação/);
  });

  it('separates "already on the declared query" from "this screen froze it"', () => {
    // ⚠️ The branch keyed on the POLICY, and the reason it must be. The badge
    // beside this control reads the TRANSPORT, and the two disagree under
    // `queryOverride`: `pipeline` is null there so the badge correctly says
    // "Tempo real", while the issued query is the CALLER's, not the declared
    // one. Keyed on the transport, this told the operator the list was already
    // on the default query when it was not, and the message written for the
    // override case was unreachable from the override case.
    expect(resetControlLabel(false, 'live')).toBe(
      'Nada para limpar: a lista já está na consulta padrão.',
    );
    expect(resetControlLabel(false, 'static')).toBe(
      'Nada para limpar aqui — o resultado fixo vem desta tela, não de um filtro seu.',
    );
  });
});
