import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareCoverage,
  normalizeMatchPath,
  parseMatchBlocks,
  renderMarkdown,
  type CoverageRow,
} from './legacyCoverage';

/**
 * The parser tests run everywhere. The staleness test at the bottom needs the
 * gitignored `.old/` checkout and skips without it — see the comment there.
 */

// Legacy dialect: no indentation, `{` glued to the path, `perm(request, "xx", n)`,
// four separate actions, and a `{parent=**}` group twin for subcollections.
const LEGACY = `rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
function isAuth(r){return r.auth != null;}
match /integracao/{col0}/tokenDuravel/{doc}{
allow read: if isAuth(request) && perm(request, "m2", 1);
allow create: if isAuth(request) && perm(request, "m2", 2);
allow update: if isAuth(request) && perm(request, "m2", 4);
allow delete: if isAuth(request) && perm(request, "m2", 8);
}
match /{parent=**}/tokenDuravel/{doc}{
allow read: if isAuth(request) && perm(request, "m2", 1);
}
match /questionsML/{doc}{
allow read: if isAuth(request) && perm(request, "mb", 1);
allow delete: if isAuth(request) && perm(request, "mb", 8);
}
match /balanco/{doc}{
allow read: if isAuth(request) && perm(request, "b1", 1);
}
}
}
`;

// Generated dialect: indented, space before `{`, `p('d_x', k)`, create+update fused.
const GENERATED = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function p(d, k) {
      return request.auth != null;
    }

    match /integracao/{integracaoId}/tokenDuravel/{docId} {
      allow read: if isSuperUser() || p('d_integracao', 1);
      allow create, update: if isSuperUser() || p('d_integracao', 2);
      allow delete: if isSuperUser() || p('d_integracao', 4);
    }

    match /questionsML/{docId} {
      allow read: if isSuperUser() || p('d_integracao', 1);
    }

    match /{path=**}/tokenDuravel/{docId} {
      allow read: if isSuperUser() || p('d_integracao', 1);
    }
  }
}
`;

describe('normalizeMatchPath', () => {
  it('collapses differently-named wildcards to one comparable key', () => {
    // This is the whole point: the legacy generator wrote `{col0}` where ours
    // writes `{integracaoId}` for the same collection.
    expect(normalizeMatchPath('/integracao/{col0}/tokenDuravel/{doc}')).toEqual({
      kind: 'collection',
      path: 'integracao/*/tokenDuravel',
    });
    expect(normalizeMatchPath('/integracao/{integracaoId}/tokenDuravel/{docId}')).toEqual({
      kind: 'collection',
      path: 'integracao/*/tokenDuravel',
    });
  });

  it('reduces a collection-group block to its leaf, in either dialect', () => {
    expect(normalizeMatchPath('/{parent=**}/tokenDuravel/{doc}')).toEqual({
      kind: 'group',
      path: 'tokenDuravel',
    });
    expect(normalizeMatchPath('/{path=**}/tokenDuravel/{docId}')).toEqual({
      kind: 'group',
      path: 'tokenDuravel',
    });
  });

  it('flags the databases envelope so it never becomes a row', () => {
    expect(normalizeMatchPath('/databases/{database}/documents').kind).toBe('wrapper');
  });

  it('leaves a top-level collection alone', () => {
    expect(normalizeMatchPath('/questionsML/{doc}')).toEqual({
      kind: 'collection',
      path: 'questionsML',
    });
  });
});

describe('parseMatchBlocks', () => {
  it('reads the legacy dialect: perm code and the four separate actions', () => {
    const blocks = parseMatchBlocks(LEGACY);
    const tokenDuravel = blocks.find(
      (b) => b.kind === 'collection' && b.path.endsWith('tokenDuravel'),
    );
    expect(tokenDuravel).toMatchObject({
      kind: 'collection',
      path: 'integracao/*/tokenDuravel',
      permCode: 'm2',
      actions: ['read', 'create', 'update', 'delete'],
    });
  });

  it('reads the generated dialect, splitting the fused create+update allow', () => {
    const blocks = parseMatchBlocks(GENERATED);
    const tokenDuravel = blocks.find(
      (b) => b.kind === 'collection' && b.path.endsWith('tokenDuravel'),
    );
    expect(tokenDuravel?.actions).toEqual(['read', 'create', 'update', 'delete']);
    // Ours uses `p('d_x', k)`, so there is no legacy perm code to find.
    expect(tokenDuravel?.permCode).toBeNull();
  });

  it('never emits a row for the databases envelope or the helper functions', () => {
    expect(parseMatchBlocks(LEGACY).some((b) => b.kind === 'wrapper')).toBe(false);
    expect(parseMatchBlocks(GENERATED).map((b) => b.path)).not.toContain('databases');
  });
});

describe('compareCoverage', () => {
  const rows = compareCoverage(LEGACY, GENERATED);

  it('flags a legacy collection the generated ruleset does not grant', () => {
    const balanco = rows.find((r) => r.path === 'balanco');
    expect(balanco).toMatchObject({ covered: false, permCode: 'b1' });
  });

  it('matches paths across the two wildcard-naming conventions', () => {
    expect(rows.find((r) => r.path === 'integracao/*/tokenDuravel')?.covered).toBe(true);
    expect(rows.find((r) => r.path === 'questionsML')?.covered).toBe(true);
  });

  it('treats a collection group as its own row, independent of the fixed path', () => {
    const group = rows.filter((r) => r.kind === 'group');
    expect(group).toHaveLength(1);
    expect(group[0]).toMatchObject({ path: 'tokenDuravel', covered: true });
  });

  it('leads with the losses', () => {
    expect(rows[0]?.covered).toBe(false);
  });

  it('does not mistake a covered group for a covered collection', () => {
    // A generated ruleset carrying ONLY the group block must not mark the
    // fixed-path collection as covered — the group grants read, never writes.
    const groupOnly = `service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/tokenDuravel/{docId} {
      allow read: if true;
    }
  }
}
`;
    const partial = compareCoverage(LEGACY, groupOnly);
    expect(partial.find((r) => r.path === 'integracao/*/tokenDuravel')?.covered).toBe(false);
    expect(partial.find((r) => r.kind === 'group')?.covered).toBe(true);
  });
});

describe('renderMarkdown', () => {
  const rows: CoverageRow[] = [
    { path: 'balanco', kind: 'collection', permCode: 'b1', actions: ['read'], covered: false },
    {
      path: 'questionsML',
      kind: 'collection',
      permCode: 'mb',
      actions: ['read'],
      covered: true,
      clientUsage: { model: 'QuestionML', referencedBy: [] },
    },
  ];

  it('counts the losses and separates the two sections', () => {
    const md = renderMarkdown(rows, { withClientUsage: false });
    expect(md).toContain('**1 of 2**');
    expect(md.indexOf('## Not covered')).toBeLessThan(md.indexOf('## Covered'));
    expect(md).toContain('`balanco`');
  });

  it('renders a backend-only model plainly when the scan ran', () => {
    const md = renderMarkdown(rows, { withClientUsage: true });
    expect(md).toContain('`QuestionML` — **backend only**');
    expect(md).toContain('Flutter client usage');
  });

  it('omits the heuristic column (and its caveat) when the scan did not run', () => {
    const md = renderMarkdown(rows, { withClientUsage: false });
    expect(md).not.toContain('Flutter client usage');
    expect(md).not.toContain('heuristic');
  });

  it('is deterministic, so the committed report diffs clean', () => {
    expect(renderMarkdown(rows, { withClientUsage: true })).toBe(
      renderMarkdown(rows, { withClientUsage: true }),
    );
  });
});

/**
 * Staleness guard. `.old/` is gitignored — absent in CI and in every worktree —
 * so this whole block skips there and the parser tests above carry the lane.
 * It bites in a full local checkout, which is exactly where someone would edit
 * a ruleset and forget to regenerate the report.
 */
const REPO_ROOT = new URL('../../../', import.meta.url);
const legacyPath = new URL('.old/firestore.rules', REPO_ROOT);
const reportPath = new URL(
  'apps/docs/src/content/docs/architecture/legacy-rules-coverage.md',
  REPO_ROOT,
);

// Generous timeout: rebuilding the report walks a few thousand Dart files, which
// runs comfortably alone but not against Vitest's 5s default while `turbo run
// test` saturates the machine across every workspace.
describe.skipIf(!existsSync(legacyPath))(
  'committed legacy-rules-coverage.md',
  { timeout: 60_000 },
  () => {
    it('lists every collection the generated ruleset actually fails to cover', async () => {
      const { buildReport } = await import('../scripts/legacy-coverage');
      const fresh = buildReport();
      const committed = readFileSync(reportPath, 'utf8').replaceAll('\r\n', '\n');
      expect(
        committed,
        'stale — regenerate: pnpm --filter @delfrance/rules-gen report:legacy-coverage',
      ).toBe(fresh);
    });

    it('confirms the four Mercado Livre collections are now covered (#783)', () => {
      const legacy = readFileSync(legacyPath, 'utf8');
      const generated = readFileSync(new URL('firestore.rules', REPO_ROOT), 'utf8');
      const rows = compareCoverage(legacy, generated);
      for (const path of [
        'integracao/*/token6h',
        'integracao/*/tokenDuravel',
        'notificacoesMercadoLivre',
        'questionsML',
      ]) {
        expect(rows.find((r) => r.kind === 'collection' && r.path === path)?.covered, path).toBe(
          true,
        );
      }
    });
  },
);
