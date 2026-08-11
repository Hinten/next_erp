import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationArgError, isMainModule, parseArgs } from './runner';

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
