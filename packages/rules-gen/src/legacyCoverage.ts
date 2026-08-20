/**
 * Legacy-vs-generated ruleset coverage.
 *
 * A database has exactly one ruleset. The day the generated `firestore.rules`
 * replaces the legacy Flutter one, every collection the legacy ruleset granted
 * and the generated ruleset does not becomes **default-denied for the Flutter
 * client** — silently, with no error the operator can act on. Issue #783 found
 * that the hard way for Mercado Livre; this module turns "which collections does
 * the Flutter app lose?" into a mechanical diff instead of a manual audit.
 *
 * Pure parsing/diffing/rendering only — file discovery and the Dart source scan
 * live in `scripts/legacy-coverage.ts`, so everything here is unit-testable
 * without `.old/` (which is gitignored and absent in CI and in worktrees).
 */

/** One `match` block's target, normalized. */
export interface MatchTarget {
  /** The raw path as written, e.g. `/integracao/{col0}/token6h/{doc}`. */
  raw: string;
  /**
   * - `collection` — a concrete path with every wildcard segment normalized to
   *   a star and the trailing document wildcard stripped, so the legacy
   *   `/integracao/{col0}/token6h/{doc}` and our
   *   `/integracao/{integracaoId}/token6h/{docId}` collapse to one key.
   * - `group` — a collection-group block (`{parent=**}` / `{path=**}`); `path`
   *   is the leaf collection name.
   * - `wrapper` — the `databases/{database}/documents` envelope; ignored.
   */
  kind: 'collection' | 'group' | 'wrapper';
  /** Normalized collection path (or the leaf name, for `group`). */
  path: string;
  /** Legacy permission code from the block body (`perm(request, "m2", 1)`). */
  permCode: string | null;
  /** Actions the block allows at least one caller, in rule order. */
  actions: string[];
}

/** One row of the coverage report. */
export interface CoverageRow {
  path: string;
  kind: 'collection' | 'group';
  permCode: string | null;
  actions: string[];
  covered: boolean;
  /** Populated by the CLI's Dart scan; `null` when the scan did not run. */
  clientUsage?: ClientUsage | null;
}

/** Heuristic verdict on whether the Flutter CLIENT touches a collection. */
export interface ClientUsage {
  /** The Dart model class the legacy generator derived the block from. */
  model: string | null;
  /** Files under `.old/lib` referencing that model, excluding generated code. */
  referencedBy: string[];
}

const MATCH_LINE = /^\s*match\s+(.+?)\s*\{\s*$/;
const WILDCARD_SEGMENT = /^\{.*\}$/;
const RECURSIVE_WILDCARD = /^\{[A-Za-z][A-Za-z0-9_]*=\*\*\}$/;
const PERM_CALL = /\bperm\(\s*request\s*,\s*"([^"]+)"/;
const ALLOW_LINE = /^\s*allow\s+([a-z,\s]+?)\s*:/;

/**
 * Normalize a `match` path. Named wildcards are positional noise — the legacy
 * generator emitted `{col0}` where ours emits `{integracaoId}` for the same
 * collection — so both collapse to `*` and the trailing document wildcard is
 * dropped, leaving a comparable collection path.
 */
export function normalizeMatchPath(raw: string): Pick<MatchTarget, 'kind' | 'path'> {
  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments[0] === 'databases') return { kind: 'wrapper', path: raw };

  const isGroup = segments.some((s) => RECURSIVE_WILDCARD.test(s));
  // Drop the document wildcard the block binds (`{doc}` / `{docId}`).
  const withoutDoc =
    segments.length > 0 && WILDCARD_SEGMENT.test(segments[segments.length - 1]!)
      ? segments.slice(0, -1)
      : segments;

  if (isGroup) {
    const leaf = withoutDoc.filter((s) => !RECURSIVE_WILDCARD.test(s)).join('/');
    return { kind: 'group', path: leaf };
  }
  return {
    kind: 'collection',
    path: withoutDoc.map((s) => (WILDCARD_SEGMENT.test(s) ? '*' : s)).join('/'),
  };
}

/**
 * Extract every `match` block from a ruleset source. Both rulesets are flat (a
 * single `databases/{database}/documents` envelope wrapping sibling blocks), so
 * a line scan is sufficient and immune to the two files' different formatting —
 * the legacy generator wrote `match /x/{doc}{`, ours writes `match /x/{docId} {`.
 */
export function parseMatchBlocks(source: string): MatchTarget[] {
  const targets: MatchTarget[] = [];
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const header = MATCH_LINE.exec(lines[i]!);
    if (!header) continue;

    const raw = header[1]!;
    const { kind, path } = normalizeMatchPath(raw);
    if (kind === 'wrapper') continue;

    // Body = everything up to the next `match` header or a closing brace at the
    // block's own nesting level. Scanning to the next header is enough here and
    // keeps the parser independent of brace-counting across two dialects.
    const actions: string[] = [];
    let permCode: string | null = null;
    for (let j = i + 1; j < lines.length && !MATCH_LINE.test(lines[j]!); j += 1) {
      const line = lines[j]!;
      const allow = ALLOW_LINE.exec(line);
      if (allow) {
        for (const action of allow[1]!.split(',')) {
          const trimmed = action.trim();
          if (trimmed && !actions.includes(trimmed)) actions.push(trimmed);
        }
      }
      if (permCode === null) {
        const perm = PERM_CALL.exec(line);
        if (perm) permCode = perm[1]!;
      }
    }

    targets.push({ raw, kind, path, permCode, actions });
  }

  return targets;
}

/**
 * Every collection the legacy ruleset grants, flagged with whether the generated
 * ruleset grants it too. Rows are sorted uncovered-first, then by path, so the
 * report leads with the losses.
 */
export function compareCoverage(legacySource: string, generatedSource: string): CoverageRow[] {
  const generated = parseMatchBlocks(generatedSource);
  const generatedCollections = new Set(
    generated.filter((t) => t.kind === 'collection').map((t) => t.path),
  );
  const generatedGroups = new Set(generated.filter((t) => t.kind === 'group').map((t) => t.path));

  const rows = new Map<string, CoverageRow>();
  for (const target of parseMatchBlocks(legacySource)) {
    if (target.kind === 'wrapper') continue;
    const key = `${target.kind}:${target.path}`;
    // A collection can appear twice in the legacy file (fixed path + group);
    // keep the first, which carries the full action set.
    if (rows.has(key)) continue;
    rows.set(key, {
      path: target.path,
      kind: target.kind,
      permCode: target.permCode,
      actions: target.actions,
      covered:
        target.kind === 'group'
          ? generatedGroups.has(target.path)
          : generatedCollections.has(target.path),
    });
  }

  return [...rows.values()].sort((a, b) => {
    if (a.covered !== b.covered) return a.covered ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === 'collection' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function usageCell(usage: ClientUsage | null | undefined): string {
  if (usage === undefined || usage === null) return '—';
  if (usage.model === null) return '_model not found_';
  if (usage.referencedBy.length === 0) return `\`${usage.model}\` — **backend only**`;
  const shown = usage.referencedBy.slice(0, 3).map((f) => `\`${f}\``);
  const extra = usage.referencedBy.length - shown.length;
  return `\`${usage.model}\` — ${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`;
}

export interface RenderOptions {
  /** Set when the CLI ran the `.old` Dart scan, so the column means something. */
  withClientUsage: boolean;
}

/** Render the committed report. Deterministic — no timestamps, so it diffs clean. */
export function renderMarkdown(rows: CoverageRow[], options: RenderOptions): string {
  const uncovered = rows.filter((r) => !r.covered);
  const covered = rows.filter((r) => r.covered);

  const lines: string[] = [
    '---',
    'title: Legacy ruleset coverage',
    'description: Which Flutter-era Firestore collections the generated ruleset does not grant.',
    '---',
    '',
    // Starlight renders these pages as plain Markdown, so a JSX-style comment
    // would print verbatim — the banner is deliberately visible instead.
    ':::caution[Generated file]',
    'Produced by `pnpm --filter @delfrance/rules-gen report:legacy-coverage`, which needs',
    'the gitignored `.old/` checkout. Do not hand-edit.',
    ':::',
    '',
    'A Firestore database has exactly one ruleset. When the generated `firestore.rules`',
    'replaces the legacy Flutter one, every collection listed as **not covered** below',
    'becomes default-denied — silently — for any caller the legacy ruleset used to',
    'admit. This page is the mechanical diff behind that cutover decision (issue #783).',
    '⚠️ Read it as "what the migrated users lose", not as "what the Flutter app can no',
    'longer do": there is no dual run, and the legacy app is off once the cutover lands',
    '(root `CLAUDE.md` rule 8).',
    '',
    `**${uncovered.length} of ${rows.length}** legacy match blocks have no counterpart in the`,
    'generated ruleset.',
    '',
  ];

  if (options.withClientUsage) {
    lines.push(
      '> The **Flutter client usage** column is a heuristic: it maps each legacy block to the',
      '> Dart model behind its `permCode`, then looks for references under `.old/lib` (the',
      '> Flutter app), skipping generated `*.g.dart`. "backend only" means the model is used',
      '> exclusively by the Cloud Run / Functions code, which runs on the Admin SDK and',
      '> bypasses rules — so losing the rules block costs nothing. **Confirm before acting:**',
      '> a model reached indirectly through a shared package will read as backend-only.',
      '',
    );
  }

  const header = options.withClientUsage
    ? '| Collection | Kind | Legacy perm | Actions | Flutter client usage |'
    : '| Collection | Kind | Legacy perm | Actions |';
  const divider = options.withClientUsage
    ? '| --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- |';

  const row = (r: CoverageRow): string => {
    const cells = [
      `\`${r.path}\``,
      r.kind === 'group' ? 'collection group' : 'collection',
      r.permCode === null ? '—' : `\`${r.permCode}\``,
      r.actions.length > 0 ? r.actions.join(', ') : '—',
    ];
    if (options.withClientUsage) cells.push(usageCell(r.clientUsage));
    return `| ${cells.join(' | ')} |`;
  };

  lines.push('## Not covered by the generated ruleset', '');
  if (uncovered.length === 0) {
    lines.push('_None — the generated ruleset covers every legacy collection._', '');
  } else {
    lines.push(header, divider, ...uncovered.map(row), '');
  }

  lines.push('## Covered', '');
  lines.push(header, divider, ...covered.map(row), '');

  return lines.join('\n');
}
