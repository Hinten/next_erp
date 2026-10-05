import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WAIT_LABELS,
  expectNoRowForEvent,
  waitForTrigger,
  waitForTriggerThenSettle,
} from './emulatorWaits';

/**
 * Offline guards for the shared emulator pollers. Runs in the `@delfrance/functions`
 * unit suite (no emulator), which is the point: a poller that can silently always
 * pass is exactly the failure class this repo builds backstops for, and none of it
 * is observable from the storage suite that uses it.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the delivery trace', () => {
  it('writes nothing when STORAGE_TRIGGER_DELIVERY_LOG is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-trace-'));
    const log = join(dir, 'delivery.tsv');
    vi.stubEnv('STORAGE_TRIGGER_DELIVERY_LOG', undefined);

    await waitForTrigger(
      async () => 1,
      () => true,
      'a value',
      () => 'saw nothing',
      { label: WAIT_LABELS.estadoTrail },
    );

    // Assert the ABSENCE of the file, not merely that nothing threw — the flag is
    // off by default in every CI lane, and "off" has to mean "wrote nothing".
    expect(existsSync(log)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing for a wait that carries no label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-trace-'));
    const log = join(dir, 'delivery.tsv');
    vi.stubEnv('STORAGE_TRIGGER_DELIVERY_LOG', log);

    await waitForTrigger(
      async () => 1,
      () => true,
      'a value',
      () => 'saw nothing',
    );

    expect(existsSync(log)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records one <label>\\t<elapsedMs> line per satisfied wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-trace-'));
    const log = join(dir, 'delivery.tsv');
    vi.stubEnv('STORAGE_TRIGGER_DELIVERY_LOG', log);

    await waitForTrigger(
      async () => 'ready',
      () => true,
      'a value',
      () => 'saw nothing',
      { label: WAIT_LABELS.estadoTrail },
    );

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    // ⚠️ The shape is pinned deliberately. The "a trace line names no identifier"
    // rule is what keeps a pedido id out of a log on a PUBLIC repo, and a rule
    // held only by a comment is one hurried debugging session from rotting.
    expect(lines[0]).toMatch(/^[a-z0-9-]+\t\d+$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no label that could carry an interpolated value', () => {
    // Belt to the WaitLabel union's braces: tsc already rejects a template
    // literal at the call site, but this also fails if someone widens the union.
    for (const label of Object.values(WAIT_LABELS)) {
      expect(label).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('waitForTrigger', () => {
  it('reports what it was waiting for AND what it last saw', async () => {
    await expect(
      waitForTrigger(
        async () => [1],
        (rows) => rows.length >= 2,
        '2 historicoEstadoPedido row(s)',
        (rows) => `saw ${rows.length}`,
        { timeoutMs: 10, stepMs: 5 },
      ),
    ).rejects.toThrow(/2 historicoEstadoPedido row\(s\).*saw 1/s);
  });

  it('settles before returning, so a late arrival is still visible', async () => {
    // The whole point of the quiet window: an exact-count assertion must be able
    // to FAIL. Row 3 lands after the minimum is met; the re-read must see it.
    const rows = [1, 2];
    setTimeout(() => rows.push(3), 10);
    const settled = await waitForTriggerThenSettle(
      async () => [...rows],
      (r) => r.length >= 2,
      '2 rows',
      (r) => `saw ${r.length}`,
      { quietMs: 40, stepMs: 5 },
    );
    expect(settled).toHaveLength(3);
  });
});

describe('expectNoRowForEvent', () => {
  it('THROWS when a row keyed on the event is present', async () => {
    // The anti-vacuity control. A bounded negative that cannot fail is worse than
    // no test, and this one silently could: the two copies it replaces keyed on
    // different fields, so a merged version that guessed would compare
    // `undefined === eventId` and pass forever.
    await expect(
      expectNoRowForEvent(
        async () => [{ eventId: 'evt-1' }],
        (row) => row.eventId,
        'evt-1',
        20,
      ),
    ).rejects.toThrow(/evt-1/);
  });

  it('passes only while no row carries the event id', async () => {
    await expect(
      expectNoRowForEvent(
        async () => [{ eventId: 'other' }],
        (row) => row.eventId,
        'evt-1',
        20,
      ),
    ).resolves.toBeUndefined();
  });

  it('keys on whatever the caller says, doc id included', async () => {
    await expect(
      expectNoRowForEvent(
        async () => [{ id: 'evt-1' }],
        (row) => row.id,
        'evt-1',
        20,
      ),
    ).rejects.toThrow(/evt-1/);
  });
});
