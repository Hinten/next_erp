import { describe, expect, it } from 'vitest';
import { MigrationArgError, parseArgs } from './runner';

describe('parseArgs', () => {
  it('requires --project', () => {
    expect(() => parseArgs([])).toThrow(MigrationArgError);
    expect(() => parseArgs(['--apply'])).toThrow(/--project/);
  });

  it('defaults to a dry-run', () => {
    expect(parseArgs(['--project', 'staging-x'])).toEqual({
      projectId: 'staging-x',
      apply: false,
      serviceAccountPath: undefined,
    });
  });

  it('enables writes with --apply', () => {
    expect(parseArgs(['--project', 'staging-x', '--apply']).apply).toBe(true);
  });

  it('accepts the --flag=value form and a service-account override', () => {
    expect(parseArgs(['--project=staging-x', '--service-account=/tmp/sa.json'])).toEqual({
      projectId: 'staging-x',
      apply: false,
      serviceAccountPath: '/tmp/sa.json',
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--project', 'x', '--force'])).toThrow(/Unknown argument/);
  });
});
