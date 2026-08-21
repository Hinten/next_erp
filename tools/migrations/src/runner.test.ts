import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchWriter, MigrationArgError, isMainModule, parseArgs } from './runner';

describe('isMainModule', () => {
  const argvOriginal = process.argv[1];
  afterEach(() => {
    process.argv[1] = argvOriginal as string;
  });

  it('matches when the module IS the process entrypoint', () => {
    const entry =
      process.platform === 'win32'
        ? 'C:\\repo\\tools\\migrations\\src\\x\\audit.ts'
        : '/repo/tools/migrations/src/x/audit.ts';
    process.argv[1] = entry;
    expect(isMainModule(pathToFileURL(entry).href)).toBe(true);
  });

  it('⚠️ rejects the two-slash `file://C:/…` shape the old guard produced', () => {
    // The old guard was `import.meta.url === `file://${argv[1].replace(/\\/g,'/')}``.
    // On a Windows drive path that yields `file://C:/…` while the loader gives
    // `file:///C:/…` — three slashes, drive letter after an empty authority. It
    // therefore NEVER matched: `runMigration` was never called and the script
    // exited 0 having done nothing. Green on Linux CI, silent no-op on Windows.
    //
    // Asserted against the literal bad URL rather than by re-deriving it, so the
    // expectation holds on both platforms (on Linux the old template happened to
    // be correct, which is exactly why this shipped).
    process.argv[1] = 'C:\\repo\\tools\\migrations\\src\\x\\audit.ts';
    expect(isMainModule('file://C:/repo/tools/migrations/src/x/audit.ts')).toBe(false);
  });

  it('does not match when the module was merely imported', () => {
    const entry =
      process.platform === 'win32'
        ? 'C:\\repo\\node_modules\\vitest\\x.js'
        : '/repo/nm/vitest/x.js';
    process.argv[1] = entry;
    const outro = process.platform === 'win32' ? 'C:\\repo\\src\\audit.ts' : '/repo/src/audit.ts';
    expect(isMainModule(pathToFileURL(outro).href)).toBe(false);
  });

  it('returns false when there is no entrypoint at all', () => {
    process.argv[1] = undefined as unknown as string;
    expect(isMainModule('file:///whatever.ts')).toBe(false);
    process.argv[1] = '';
    expect(isMainModule('file:///whatever.ts')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('requires --project', () => {
    expect(() => parseArgs([])).toThrow(MigrationArgError);
    expect(() => parseArgs(['--apply'])).toThrow(/--project/);
  });

  it('defaults to a dry-run', () => {
    expect(parseArgs(['--project', 'staging-x'])).toEqual({
      projectId: 'staging-x',
      apply: false,
      reportOnly: false,
      serviceAccountPath: undefined,
      targets: [],
    });
  });

  it('enables writes with --apply', () => {
    expect(parseArgs(['--project', 'staging-x', '--apply']).apply).toBe(true);
  });

  it('accepts the --flag=value form and a service-account override', () => {
    expect(parseArgs(['--project=staging-x', '--service-account=/tmp/sa.json'])).toEqual({
      projectId: 'staging-x',
      apply: false,
      reportOnly: false,
      serviceAccountPath: '/tmp/sa.json',
      targets: [],
    });
  });

  it('parses --target as a trimmed, blank-free list', () => {
    expect(parseArgs(['--project', 'x', '--target', 'clientes, cheque']).targets).toEqual([
      'clientes',
      'cheque',
    ]);
    expect(parseArgs(['--project=x', '--target=clientes']).targets).toEqual(['clientes']);
    expect(parseArgs(['--project=x', '--target=,,']).targets).toEqual([]);
  });

  it('enables the pre-flight shape report with --report-only', () => {
    expect(parseArgs(['--project', 'staging-x', '--report-only']).reportOnly).toBe(true);
  });

  it('refuses --report-only together with --apply', () => {
    // The report writes nothing by definition; combining them would silently
    // pick one, and the operator would not know which.
    expect(() => parseArgs(['--project', 'x', '--report-only', '--apply'])).toThrow(
      /cannot be combined/,
    );
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--project', 'x', '--force'])).toThrow(/Unknown argument/);
  });

  it('rejects a flag where a value is expected (does not consume the next flag)', () => {
    expect(() => parseArgs(['--project', '--apply'])).toThrow(/--project requires a value/);
    expect(() => parseArgs(['--project', 'x', '--service-account', '--apply'])).toThrow(
      /--service-account requires a value/,
    );
    expect(() => parseArgs(['--project', 'x', '--target', '--apply'])).toThrow(
      /--target requires a value/,
    );
  });

  it('rejects a trailing flag with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(MigrationArgError);
  });
});

describe('BatchWriter.updateGuarded — rule 7 tier 1', () => {
  // The patch a migration writes is DERIVED from a snapshot it read, so a blind
  // `update()` holds its decision only at READ time. This asserts the precondition
  // actually reaches Firestore and that a miss is reported rather than thrown.

  type Call = { data: unknown; precondition: unknown };

  function fakeRef(onUpdate?: () => never) {
    const calls: Call[] = [];
    const ref = {
      calls,
      update: async (data: unknown, precondition: unknown) => {
        calls.push({ data, precondition });
        if (onUpdate) onUpdate();
      },
    };
    return ref as unknown as Parameters<BatchWriter['updateGuarded']>[0] & { calls: Call[] };
  }

  const TS = { seconds: 1, nanoseconds: 2 } as unknown as Parameters<
    BatchWriter['updateGuarded']
  >[2];
  const db = {} as never;

  it('sends the lastUpdateTime precondition and counts the write', async () => {
    const w = new BatchWriter(db, true);
    const ref = fakeRef();

    await expect(w.updateGuarded(ref, { a: 1 }, TS)).resolves.toBe(true);

    expect(ref.calls).toHaveLength(1);
    expect(ref.calls[0]!.data).toEqual({ a: 1 });
    // ⚠️ Asserted by SHAPE — a plain `update(data)` with no second argument is the
    // exact regression this guard exists to prevent, and it would still resolve.
    expect(ref.calls[0]!.precondition).toEqual({ lastUpdateTime: TS });
    expect(w.committed).toBe(1);
  });

  it('resolves FALSE on FAILED_PRECONDITION instead of throwing', async () => {
    // A conflict is this document losing a race, not the pass failing — the
    // caller records it and the other 399 documents still go through.
    const w = new BatchWriter(db, true);
    const ref = fakeRef(() => {
      throw Object.assign(new Error('failed precondition'), { code: 9 });
    });

    await expect(w.updateGuarded(ref, { a: 1 }, TS)).resolves.toBe(false);
    expect(w.committed).toBe(0);
  });

  it('RETHROWS any other error — a real fault must not read as a conflict', async () => {
    const w = new BatchWriter(db, true);
    const ref = fakeRef(() => {
      throw Object.assign(new Error('permission denied'), { code: 7 });
    });

    await expect(w.updateGuarded(ref, { a: 1 }, TS)).rejects.toThrow(/permission denied/);
  });

  it('writes NOTHING in dry-run, and still reports success', async () => {
    // Dry-run must reach the same verdicts as `--apply` without touching
    // Firestore, or the rehearsal stops predicting the real run.
    const w = new BatchWriter(db, false);
    const ref = fakeRef();

    await expect(w.updateGuarded(ref, { a: 1 }, TS)).resolves.toBe(true);
    expect(ref.calls).toHaveLength(0);
    expect(w.committed).toBe(0);
  });
});
