import { afterEach, describe, expect, it, vi } from 'vitest';
import { e2eRunId, e2eRunSlot, e2eRunSlotSuffix } from '@delfrance/test-fixtures';
import { concurrencyGroupId } from './stale-sweep';
import { e2eUserEmail, getRunId } from './run-id';

/**
 * Backstop for the shard-scoped run key.
 *
 * Splitting a lane across two jobs of ONE workflow run is only safe because
 * `E2E_RUN_SLOT` scopes **three independent axes**, and scoping a subset is
 * strictly worse than scoping none:
 *
 *  - `getRunId()` → `e2ePrefix` + the ephemeral auth user. Shared, the job that
 *    finishes first sweeps `e2e-<runId>-` and deletes its sibling's LIVE
 *    fixtures, then deletes the auth user out from under its session.
 *  - `e2eRunId()` → `e2e_probe/<runId>`. Shared, one job's `runTeardown` 404s
 *    the other's `globalSetup`.
 *  - `concurrencyGroupId()` → the predecessor marker. A scoped run id over an
 *    UNSCOPED group id is the worst case of the three: the second job reads the
 *    first's run id as `previous`, concludes `cancel-in-progress` killed it, and
 *    reclaims its prefix with `maxAgeMs: null` — no age gate, mid-run.
 *
 * Nothing at runtime can see a half-applied version of this: both jobs still go
 * green while deleting each other's data, exactly like the worker-index bug in
 * #1051 that this pattern is copied from. Hence a test rather than a comment.
 */
describe('E2E_RUN_SLOT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The three run-scoped keys, each read through its own public entry point. */
  function axes(): Record<string, string> {
    return {
      getRunId: getRunId(),
      e2eRunId: e2eRunId(),
      concurrencyGroupId: concurrencyGroupId() ?? '<null>',
    };
  }

  function withSlot(slot: string | undefined): Record<string, string> {
    vi.stubEnv('GITHUB_RUN_ID', '33068839807');
    vi.stubEnv('GITHUB_WORKFLOW', 'E2E — Vendas');
    vi.stubEnv('GITHUB_REF', 'refs/pull/1310/merge');
    vi.stubEnv('E2E_RUN_SLOT', slot);
    return axes();
  }

  it('is absent by default, and then every key is byte-identical to the unsharded form', () => {
    const unsharded = withSlot(undefined);

    expect(e2eRunSlot()).toBeNull();
    expect(e2eRunSlotSuffix()).toBe('');
    expect(unsharded).toEqual({
      getRunId: '33068839807',
      e2eRunId: '33068839807',
      concurrencyGroupId: 'E2E — Vendas__refs_pull_1310_merge',
    });
  });

  it('scopes ALL THREE axes — a key left unscoped is the bug this file exists for', () => {
    const unsharded = withSlot(undefined);
    const shard1 = withSlot('1');

    for (const [axis, value] of Object.entries(shard1)) {
      expect(
        value,
        `${axis} did not change when E2E_RUN_SLOT was set — two sharded jobs would share it`,
      ).not.toBe(unsharded[axis]);
    }
  });

  it('gives two shards of one run disjoint keys on every axis', () => {
    const shard1 = withSlot('1');
    const shard2 = withSlot('2');

    for (const axis of Object.keys(shard1)) {
      expect(shard1[axis], `${axis} collides across shards`).not.toBe(shard2[axis]);
    }
    // The auth user hangs off getRunId; assert the derived address directly
    // rather than trusting the composition to stay that way.
    withSlot('1');
    const email1 = e2eUserEmail();
    withSlot('2');
    expect(e2eUserEmail()).not.toBe(email1);
  });

  it('keeps one slot from being a string PREFIX of another', () => {
    // Every sweep is a `>= p && < p+￿` range, i.e. a plain startsWith, and the
    // slot is not fixed-width. Tag-last, `…-s1-` would swallow `…-s11-` — the
    // same positional trap as `w3` ⊂ `w31` in #1051. The trailing separator is
    // what prevents it, so pin the CONCATENATED form callers actually sweep on.
    withSlot('1');
    const sweep1 = `e2e-${getRunId()}-`;
    withSlot('11');
    const sweep11 = `e2e-${getRunId()}-`;

    expect(sweep11.startsWith(sweep1)).toBe(false);
    expect(sweep1.startsWith(sweep11)).toBe(false);
  });

  it('throws on a malformed slot instead of silently reading it as unsharded', () => {
    // Falling back to "" here is precisely how both jobs would land on one key.
    // Stub the full CI env: `concurrencyGroupId` returns null before reading the
    // slot when GITHUB_WORKFLOW/GITHUB_REF are absent, so only the CI path
    // exercises its throw.
    vi.stubEnv('GITHUB_RUN_ID', '33068839807');
    vi.stubEnv('GITHUB_WORKFLOW', 'E2E — Vendas');
    vi.stubEnv('GITHUB_REF', 'refs/pull/1310/merge');
    vi.stubEnv('E2E_RUN_SLOT', 'vendas-1');
    expect(() => e2eRunSlot()).toThrow(/digits only/);
    expect(() => getRunId()).toThrow(/digits only/);
    expect(() => e2eRunId()).toThrow(/digits only/);
    expect(() => concurrencyGroupId()).toThrow(/digits only/);
  });

  it('treats an empty or whitespace slot as unsharded', () => {
    // Actions renders an unset workflow input as the empty string, not as an
    // absent variable — so `E2E_RUN_SLOT: ''` is the normal unsharded case and
    // must not throw.
    for (const blank of ['', '   ']) {
      vi.stubEnv('E2E_RUN_SLOT', blank);
      expect(e2eRunSlot()).toBeNull();
      expect(e2eRunSlotSuffix()).toBe('');
    }
  });
});
