import { describe, expect, it } from 'vitest';

import { ReplayArgError, compareCounts, isAfter, parseReplayArgs, parseSince } from './transform';

const base = ['--source-project', 'legacy', '--project', 'novo', '--since', '2026-12-17T03:00:00Z'];

describe('parseReplayArgs', () => {
  it('parses the replay contract, dry-run by default', () => {
    expect(parseReplayArgs(base)).toMatchObject({
      sourceProjectId: 'legacy',
      projectId: 'novo',
      since: { seconds: Date.parse('2026-12-17T03:00:00Z') / 1000, nanoseconds: 0 },
      apply: false,
      verify: false,
      groups: [],
    });
    expect(parseReplayArgs([...base, '--apply']).apply).toBe(true);
  });

  it('accepts the --flag=value form', () => {
    expect(
      parseReplayArgs(['--source-project=legacy', '--project=novo', '--since=2026-12-17T03:00Z']),
    ).toMatchObject({ sourceProjectId: 'legacy', projectId: 'novo' });
  });

  it.each([
    [['--project', 'novo', '--since', '2026-12-17T03:00:00Z'], /--source-project/],
    [['--source-project', 'legacy', '--since', '2026-12-17T03:00:00Z'], /--project/],
    [['--source-project', 'legacy', '--project', 'novo'], /--since/],
    [
      ['--source-project', 'x', '--project', 'x', '--since', '2026-12-17T03:00:00Z'],
      /two different/,
    ],
    [[...base, '--verify', '--apply'], /--verify writes nothing/],
    [['--source-project', '--project', 'novo'], /requires a value/],
    [[...base, '--target', 'x'], /Unknown argument/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseReplayArgs(argv)).toThrow(message);
  });

  it('does not need --since for --verify, and splits --groups', () => {
    expect(
      parseReplayArgs([
        '--source-project',
        'legacy',
        '--project',
        'novo',
        '--verify',
        '--groups',
        'nfev4, estoques',
      ]),
    ).toMatchObject({ verify: true, groups: ['nfev4', 'estoques'] });
  });
});

describe('parseSince', () => {
  it('reads a whole minute with a zone', () => {
    expect(parseSince('2026-12-17T00:00:00-03:00')).toEqual({
      seconds: Date.parse('2026-12-17T03:00:00Z') / 1000,
      nanoseconds: 0,
    });
  });

  it.each(['2026-12-17T03:00:00', '2026-12-17T03:00:30Z', '2026-12-17', 'ontem'])(
    'refuses %j — no zone, not a whole minute, or not a time',
    (value) => {
      expect(() => parseSince(value)).toThrow(ReplayArgError);
    },
  );
});

describe('isAfter', () => {
  const t0 = { seconds: 1000, nanoseconds: 0 };

  it('selects a change after T0, even by one nanosecond', () => {
    expect(isAfter({ seconds: 1000, nanoseconds: 1 }, t0)).toBe(true);
    expect(isAfter({ seconds: 1001, nanoseconds: 0 }, t0)).toBe(true);
  });

  it('leaves out a change AT or before T0 — the export already holds it (near-miss)', () => {
    expect(isAfter({ seconds: 1000, nanoseconds: 0 }, t0)).toBe(false);
    expect(isAfter({ seconds: 999, nanoseconds: 999_999_999 }, t0)).toBe(false);
  });
});

describe('compareCounts', () => {
  it('classifies equal, different and one-sided collections, and ignores the watermarks', () => {
    const rows = compareCounts(
      new Map([
        ['pedidos', 10],
        ['clientes', 5],
        ['velha', 1],
      ]),
      new Map([
        ['pedidos', 10],
        ['clientes', 4],
        ['nova', 2],
        ['_mirrorWatermarks', 99],
      ]),
      new Set(['_mirrorWatermarks']),
    );

    expect(rows).toEqual([
      { collection: 'clientes', legacy: 5, novo: 4, status: 'diferente' },
      { collection: 'nova', legacy: null, novo: 2, status: 'so-novo' },
      { collection: 'pedidos', legacy: 10, novo: 10, status: 'igual' },
      { collection: 'velha', legacy: 1, novo: null, status: 'so-legado' },
    ]);
  });

  it('keeps a zero count distinct from an absent collection (near-miss)', () => {
    const [row] = compareCounts(new Map([['x', 0]]), new Map(), new Set());
    expect(row).toMatchObject({ legacy: 0, novo: null, status: 'so-legado' });
  });
});
