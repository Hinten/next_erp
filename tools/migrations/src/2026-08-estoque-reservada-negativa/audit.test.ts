import { describe, expect, it } from 'vitest';
import { MigrationArgError, type MigrationContext } from '../runner';
import { run } from './audit';

/**
 * The README promises `--apply` is REJECTED rather than ignored. That promise is
 * the only thing standing between this report and a bulk write over real stock
 * counters, so it is asserted rather than assumed.
 *
 * Importing `audit.ts` is safe under vitest: its entrypoint guard compares
 * `import.meta.url` to `process.argv[1]`, which is the vitest binary here, so
 * `runMigration` does not fire.
 */
function ctx(over: Partial<MigrationContext> = {}): MigrationContext {
  return {
    // Never reached — the guard throws before any Firestore access, which is
    // precisely the property under test.
    db: null as unknown as MigrationContext['db'],
    apply: false,
    reportOnly: false,
    sink: null as unknown as MigrationContext['sink'],
    writer: null as unknown as MigrationContext['writer'],
    args: { projectId: 'p', apply: false, reportOnly: false, targets: [] },
    ...over,
  };
}

describe('estoque-reservada-negativa audit', () => {
  it('⚠️ REJECTS --apply instead of silently ignoring it', async () => {
    await expect(run(ctx({ apply: true }))).rejects.toThrow(MigrationArgError);
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/AUDIT, not a migration/);
  });

  it('says WHY, naming rule 8 — so nobody assumes the flag just needs a retry', async () => {
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/cutover window/);
  });
});
