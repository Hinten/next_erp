import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitGrep } from './lib/repo-scan.js';

/**
 * Repo invariant: every CLIENT-SDK `onSnapshot(...)` listener passes an explicit
 * `SnapshotListenOptions` — in practice `includeMetadataChanges: true`.
 *
 * ## Why this needs a guard
 *
 * `fromCache` looks like a property of each snapshot. It is really a property of
 * the LISTENER, and by default the interesting half of it is never delivered.
 * The SDK decides in `QueryListener.shouldRaiseEvent`: a snapshot carrying no
 * document changes is raised only when `syncStateChanged` — the cache -> server
 * transition — coincides with `includeMetadataChanges === true`. Otherwise the
 * event is dropped.
 *
 * The consequence is the opposite of what the call site reads like. Without the
 * flag a consumer observes `fromCache: false` ONLY when the server's copy also
 * differs in DATA from the cached one. Open a record whose cache is already
 * correct — the common case once anything has been viewed in the session — and
 * the listener never fires again. `fromCache` stays `true` for the life of that
 * listener, and every gate written as `fromCache === false` silently never runs.
 *
 * That is not hypothetical: it shipped. Four gates read the signal and all four
 * were dead on that path — `useServerTruthSeed` (the ObjectView re-seed and
 * `baseline.current`, which IS the ADR 0011 tier-3 concurrency guard, so a null
 * baseline means the save goes out unguarded), `useCollectionMonitor`, the
 * produto editor's server-truth seed, and `RecalcularPrecosScreen`'s preselect.
 * Nothing failed. The screens looked right, because on that path the cached value
 * already WAS the right one — the guards were the only casualty, and guards are
 * invisible when they do not fire.
 *
 * Nothing else catches it. It is not a type error (the options argument is
 * optional), not a lint error, and not visible in any unit test that mocks the
 * hook rather than the SDK. The behaviour lives in the SDK, so a test could only
 * assert the argument we passed — which is exactly what this asserts, for every
 * call site at once, including ones added later.
 *
 * A deliberate opt-out is still available and still explicit: pass
 * `{ includeMetadataChanges: false }`. What this rejects is passing nothing,
 * where the default is silently the surprising one.
 */

/**
 * Where a client Firestore listener may legitimately live. `apps/*​/functions`
 * and the Admin SDK are out of scope — Admin's `onSnapshot` is a METHOD on a
 * reference (`ref.onSnapshot(cb)`), takes no such option, and has no local cache
 * for the flag to mean anything about.
 */
const SCAN_PATHSPECS = [
  ':(glob)packages/**/src/**/*.ts',
  ':(glob)packages/**/src/**/*.tsx',
  ':(glob)apps/**/*.ts',
  ':(glob)apps/**/*.tsx',
  `:(exclude,glob)apps/*/functions/${'**'}`,
  `:(exclude,glob)${'**'}/*.test.ts`,
  `:(exclude,glob)${'**'}/*.test.tsx`,
  `:(exclude,glob)${'**'}/*.spec.ts`,
];

/**
 * The file that must always be found. An anchor, not the scope: a NEW listener
 * anywhere is covered by the pathspec above and does not need adding here. This
 * exists so a pathspec that stops matching fails loudly instead of passing
 * vacuously over an empty set.
 */
const KNOWN_LISTENER_FILE = 'packages/data/src/hooks/useSnapshot.ts';

/**
 * Bare `onSnapshot(` as a CALL, not `.onSnapshot(` (the Admin SDK method) and
 * not the import specifier. `[^.\w]` before it rules out both `ref.onSnapshot(`
 * and any identifier ending in those letters.
 */
const CALL_RE = /(^|[^.\w])onSnapshot\(/g;

/**
 * Discovery only — a literal-string search, so no regex dialect is involved.
 * (`basic` mode would read `\\(` as a GROUP, not a paren, and fail outright.)
 * The precise per-call-site matching is `CALL_RE`, in JS, where the dialect is
 * one I control.
 */
function listenerFiles() {
  return gitGrep({ patterns: 'onSnapshot(', pathspecs: SCAN_PATHSPECS, mode: 'fixed' });
}

/**
 * The options argument of an `onSnapshot(` call, as source text.
 *
 * Deliberately positional rather than "does this file mention the flag
 * anywhere": a file with two listeners where only one is configured is exactly
 * the bug this is for, and a file-level `includes()` would pass it. Prettier
 * formats every multi-line call one argument per line, so the argument that
 * matters is the second non-empty line after the opening paren; a single-line
 * call is read from the same line. Returns `null` when there is no second
 * argument at all.
 */
function optionsArgument(source, callIndex) {
  const afterParen = source.slice(source.indexOf('(', callIndex) + 1);
  const [firstLine, ...rest] = afterParen.split('\n');
  // Single-line call: `onSnapshot(ref, opts, cb)` — split what follows the paren.
  if (firstLine.includes(')') || firstLine.split(',').length > 2) {
    const parts = firstLine.split(',');
    return parts.length > 1 ? (parts[1]?.trim() ?? null) : null;
  }
  // Comment lines are not arguments. A call whose options argument carries an
  // explanation above it — which is the shape this guard actively wants, since
  // the whole point is that the choice be visible — would otherwise have its
  // own comment counted as the argument and be reported as an offender.
  //
  // `args[1]`, not `args[0]`: index 0 is the reference/query. Getting that wrong
  // reports every correctly-configured call, which at least fails loudly — the
  // anti-vacuity anchors above are what stop the mirror-image mistake (a parser
  // that finds nothing) from passing silently.
  const args = rest
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
  return args[1] ?? null;
}

function unconfiguredCalls(relPath) {
  const source = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  const offenders = [];
  for (const match of source.matchAll(CALL_RE)) {
    const arg = optionsArgument(source, match.index);
    // An options argument is anything naming the flag, directly or through the
    // shared constant. A callback (`(snap` / `snap =>`) means none was passed.
    const configured =
      arg !== null && (arg.includes('includeMetadataChanges') || /LISTEN_OPTIONS/.test(arg));
    if (!configured) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${relPath}:${line} — second argument is \`${arg ?? '<none>'}\``);
    }
  }
  return offenders;
}

describe('client onSnapshot listeners declare their metadata-change behaviour', () => {
  it('the scan still finds the known listener file', () => {
    // Anchor. If this fails, the pathspec stopped matching and every assertion
    // below is passing over an empty set.
    expect(
      listenerFiles(),
      [
        `\`${KNOWN_LISTENER_FILE}\` was not found by the git pathspec.`,
        'Either it moved (update KNOWN_LISTENER_FILE) or SCAN_PATHSPECS no longer',
        'matches it — in which case this whole guard stopped checking anything.',
      ].join('\n'),
    ).toContain(KNOWN_LISTENER_FILE);
  });

  it('the call-site parser actually finds calls in that file', () => {
    // Second anchor, and the one that matters most: the assertion below reports
    // OFFENDERS, so a parser that silently found zero calls would pass it. This
    // proves the regex still matches real source.
    const source = readFileSync(resolve(REPO_ROOT, KNOWN_LISTENER_FILE), 'utf8');
    const found = [...source.matchAll(CALL_RE)];
    expect(
      found.length,
      `The \`onSnapshot(\` pattern matched nothing in ${KNOWN_LISTENER_FILE}. The parser is broken, not the source.`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('every client listener passes an explicit options argument', () => {
    const offenders = listenerFiles().flatMap(unconfiguredCalls);
    expect(
      offenders,
      [
        'These client `onSnapshot(...)` calls pass no `SnapshotListenOptions`, so the',
        'SDK drops the cache -> server transition whenever the document data is',
        'unchanged and `fromCache` never becomes `false` for that listener:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'Fix: pass `{ includeMetadataChanges: true }` as the second argument (in',
        '`packages/data/src/hooks/useSnapshot.ts`, the shared',
        '`SERVER_SYNC_LISTEN_OPTIONS`). If you genuinely want the default, say so',
        'explicitly with `{ includeMetadataChanges: false }` — the point is that the',
        'choice is visible at the call site, not that one answer is always right.',
      ].join('\n'),
    ).toEqual([]);
  });
});
