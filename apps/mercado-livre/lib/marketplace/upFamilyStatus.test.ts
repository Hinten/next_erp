import { describe, expect, it } from 'vitest';

import { foldFamilyStatus } from './upFamilyStatus';

/**
 * The fold is the whole reason a family member's status is not written straight
 * through to the parent link. Its one job is to be conservative about `closed`,
 * because `estado 'c'` drops the produto out of `integracoesComProduto` and so
 * out of BOTH ML sweeps' anchor query — a failure with no error and no log.
 *
 * Cases are written out one by one rather than iterated over a table of the
 * ladder itself: a loop over the ranking cannot notice a rung that was deleted.
 */
describe('foldFamilyStatus', () => {
  it('a live member outranks a closed sibling — the transition this exists for', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'active', subStatus: null },
      ]),
    ).toEqual({ status: 'active', subStatus: null });
  });

  it('closes the family only when EVERY observed member is closed', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'closed', subStatus: ['deleted'] },
      ]),
    ).toEqual({ status: 'closed', subStatus: null });
  });

  it('refuses to conclude when the only observed members are closed and one was never observed', () => {
    // Writing `closed` here would be a guess about the unobserved member, and the
    // cost of guessing wrong is a silent sweep outage. Null leaves the parent as-is.
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: null, subStatus: null },
      ]),
    ).toBeNull();
  });

  it('an unobserved member does NOT block a live conclusion', () => {
    // Only the all-closed reading is unsafe; a live member is proof on its own.
    expect(
      foldFamilyStatus([
        { status: null, subStatus: null },
        { status: 'paused', subStatus: null },
      ]),
    ).toEqual({ status: 'paused', subStatus: null });
  });

  it('nothing observed at all → no conclusion', () => {
    expect(foldFamilyStatus([{ status: null, subStatus: null }])).toBeNull();
    expect(foldFamilyStatus([])).toBeNull();
  });

  it('ranks active over paused over under_review', () => {
    const all = [
      { status: 'under_review', subStatus: null },
      { status: 'paused', subStatus: null },
      { status: 'active', subStatus: null },
    ];
    expect(foldFamilyStatus(all)?.status).toBe('active');
    expect(foldFamilyStatus(all.slice(0, 2))?.status).toBe('paused');
    expect(foldFamilyStatus(all.slice(0, 1))?.status).toBe('under_review');
  });

  it('an unrecognised status still outranks closed — it is evidence of a listing, not of a dead one', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'some_new_ml_status', subStatus: null },
      ])?.status,
    ).toBe('some_new_ml_status');
  });

  it('carries the winning member sub_status, so estado/status/sub_status describe ONE listing', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: ['deleted'] },
        { status: 'paused', subStatus: ['out_of_stock'] },
      ]),
    ).toEqual({ status: 'paused', subStatus: ['out_of_stock'] });
  });
});
