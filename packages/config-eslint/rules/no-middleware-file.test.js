import { describe, expect, it } from 'vitest';

import { gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: no Next app has a `middleware.ts`.
 *
 * Root `CLAUDE.md` rule 5 and `apps/web/CLAUDE.md` rule 2 both state it, in
 * bold, and neither is a mechanism. The auth guard is `useRequireAuth()` and
 * security lives in the generated Firestore rules; a middleware would move an
 * access decision to a server surface that this architecture does not have —
 * `apps/web` is client-first behind auth, and the API-only sibling apps do
 * their own per-route checks.
 *
 * ## Why a test and not a lint rule
 *
 * ESLint sees files that EXIST. This invariant is about a file that must not,
 * and the offending edit is `git add apps/web/middleware.ts` — a new file, in
 * the one location Next.js gives special meaning to, which no rule about the
 * contents of other files can observe. The same reason
 * `apphosting-next-pinned.test.js` is a test.
 *
 * It is also the cheap half of a rule the repo already enforces at the other
 * end: `apps/web`'s `no-restricted-imports` now bans `firebase-admin` in
 * `app/`, `lib/` and `components/`, so a middleware that reached for the Admin
 * SDK would be caught — but only if it imported that. A middleware doing plain
 * redirects would not be, and it is exactly as unwanted.
 *
 * ⚠️ Discovered rather than enumerated, per this directory's own rule: a guard
 * that only checks a hand-written list cannot catch the app nobody remembered
 * to add.
 */
describe('no app declares a Next middleware', () => {
  const middlewares = gitLsFiles(['apps/**/middleware.ts', 'apps/**/middleware.js']).filter(
    (f) => !f.includes('/node_modules/'),
  );

  it('finds none anywhere under apps/', () => {
    expect(middlewares).toEqual([]);
  });
});
