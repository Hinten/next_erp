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
 * Blank out comment and string spans, preserving both length and newlines so
 * every index still lines up with the original source (line numbers below are
 * computed from these indices).
 *
 * Two things need this. `onSnapshot(q, cb)` written inside a doc comment is not
 * a call site and must not be flagged; and a string or comment sitting between
 * two arguments must not be mistaken for one.
 *
 * ⚠️ Regex literals are NOT tracked. A regex containing an unbalanced quote or
 * paren near a listener could confuse the scan. That is accepted because the two
 * anchors below run this exact pipeline over the real file, so corruption that
 * ate a genuine call site fails loudly rather than passing vacuously — which is
 * the direction that matters.
 */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  const blank = (at) => {
    if (source[at] !== '\n') out[at] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && next === '*') {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i += 1; // keep the opening quote, so the span is still visibly a string
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') blank(i++);
        if (i < n) blank(i++);
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

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
 * The top-level arguments of the call whose `(` is at `parenIndex`, as source
 * text — a bracket-depth scan splitting on depth-0 commas.
 *
 * ⚠️ Deliberately NOT a per-line read. Prettier does put one argument per line,
 * but it also BREAKS A LONG ARGUMENT across lines, and then the continuation
 * lines look exactly like arguments. The ordinary shape
 *
 *   onSnapshot(
 *     query(
 *       collection(db, 'pedidos'),
 *       where('estado', '==', ESTADO_PEDIDO.pago),
 *     ),
 *     { includeMetadataChanges: true },
 *     (snap) => { ... },
 *   );
 *
 * has `collection(db, 'pedidos'),` as its second LINE and
 * `{ includeMetadataChanges: true }` as its second ARGUMENT. A line-based reader
 * flags that call — telling a contributor who did exactly the right thing that
 * their options argument is `collection(db, 'pedidos'),` and to add a flag they
 * already added. It fails closed, so nothing ships broken, but a guard that
 * misdirects is a guard someone eventually deletes.
 */
function topLevelArgs(source, parenIndex) {
  const args = [];
  let depth = 0;
  let start = parenIndex + 1;
  for (let i = parenIndex; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(start, i));
        return args.map((a) => a.trim());
      }
    } else if (c === ',' && depth === 1) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
  }
  return args.map((a) => a.trim()); // unbalanced source — report what we have
}

/** The options argument: index 1, after the reference/query at index 0. */
function optionsArgument(source, callIndex) {
  return topLevelArgs(source, source.indexOf('(', callIndex))[1] ?? null;
}

/** Whether an options argument declares the flag, directly or via the constant. */
function declaresIntent(arg) {
  return arg !== null && (arg.includes('includeMetadataChanges') || /LISTEN_OPTIONS/.test(arg));
}

function unconfiguredCalls(relPath) {
  return scanSource(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'), relPath);
}

/**
 * Split from the file read so the fixture tests below can drive the parser
 * directly. The repo-state anchors prove it runs over the real tree; the
 * fixtures prove it reads the shapes correctly. Neither substitutes for the
 * other — the line-based reader this replaced passed every anchor.
 */
function scanSource(raw, relPath) {
  // Scan the BLANKED source throughout: it keeps every index, so the line
  // numbers still point at the real file, while a call mentioned only in prose
  // is no longer a call.
  const source = blankCommentsAndStrings(raw);
  const offenders = [];
  for (const match of source.matchAll(CALL_RE)) {
    const arg = optionsArgument(source, match.index);
    if (declaresIntent(arg)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    offenders.push(`${relPath}:${line} — second argument is \`${arg ?? '<none>'}\``);
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
    // Through `blankCommentsAndStrings`, i.e. the pipeline that actually runs —
    // otherwise blanking that ate a real call site would pass this anchor.
    const source = blankCommentsAndStrings(
      readFileSync(resolve(REPO_ROOT, KNOWN_LISTENER_FILE), 'utf8'),
    );
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

describe('the call-site parser reads the options ARGUMENT, not the second LINE', () => {
  // Regression fixtures for shapes Prettier really produces. The first is the
  // one the line-based reader got wrong: it flagged a correctly configured call.
  const flagged = (src) => scanSource(src, 'fixture.ts').length > 0;

  it('accepts a configured call whose FIRST argument spans several lines', () => {
    expect(
      flagged(`const unsub = onSnapshot(
  query(
    collection(db, 'pedidos'),
    where('estado', '==', ESTADO_PEDIDO.pago),
  ),
  { includeMetadataChanges: true },
  (snap) => handle(snap),
);`),
      'A continuation line of argument 0 must not be read as the options argument.',
    ).toBe(false);
  });

  it('still flags that same shape when the options argument is missing', () => {
    // The mirror, proving the fix did not just stop flagging multi-line calls.
    expect(
      flagged(`const unsub = onSnapshot(
  query(
    collection(db, 'pedidos'),
    where('estado', '==', ESTADO_PEDIDO.pago),
  ),
  (snap) => handle(snap),
);`),
    ).toBe(true);
  });

  it('accepts a configured single-line call', () => {
    expect(flagged(`onSnapshot(ref, { includeMetadataChanges: true }, cb);`)).toBe(false);
  });

  it('flags a single-line call with no options argument', () => {
    expect(flagged(`onSnapshot(ref, cb);`)).toBe(true);
  });

  it('accepts the explicit opt-out', () => {
    // The point is that the choice is visible, not that one answer is right.
    expect(flagged(`onSnapshot(ref, { includeMetadataChanges: false }, cb);`)).toBe(false);
  });

  it('ignores a call written inside a comment', () => {
    expect(
      flagged(`/**
 * Do not write onSnapshot(q, cb) and forget the options argument.
 */
onSnapshot(ref, { includeMetadataChanges: true }, cb);`),
      'Prose describing a call is not a call site.',
    ).toBe(false);
  });

  it('ignores a call written inside a string', () => {
    expect(flagged(`const msg = 'call onSnapshot(q, cb) carefully';`)).toBe(false);
  });
});
