/**
 * The `invoker` option shared by every `onTaskDispatched` in this codebase.
 *
 * Side-effect free ON PURPOSE: `options.ts` throws when `FUNCTIONS_REGION` was
 * not inlined, so importing this from a task module must not drag that in.
 *
 * ⚠️ Keep this file IDENTICAL across the five functions codebases —
 * `packages/config-eslint/rules/tasks-invoker-inventory.test.js` fails on drift.
 * A partial fix across copy-pasted call sites, each pinned by its own passing
 * test, is exactly how #1108 shipped four broken queues while CI stayed green.
 */

/**
 * `{ invoker: [...] }` from the build-time `TASKS_INVOKER_SA`, or an EMPTY
 * object when it was not inlined.
 *
 * ⚠️ The SDK's docstring ("who can enqueue tasks for this function") undersells
 * it. firebase-tools applies this list to BOTH legs of the trip:
 * `roles/run.invoker` on the function's Cloud Run service — the DISPATCH leg,
 * whose absence fails invisibly, because the enqueue already returned success
 * and our code never sees the 403 — and `roles/cloudtasks.enqueuer` on the
 * queue.
 *
 * ⚠️ The list is AUTHORITATIVE for both bindings: a deploy REPLACES their
 * members, so an identity left out LOSES the role. It must name every enqueuer
 * — the App Hosting runtime SA (the receiver routes) AND the functions runtime
 * SA (the sweeps, the Firestore triggers and every self-continuation). The
 * project-level grants are a different resource and are unaffected. See
 * DEPLOY.md.
 *
 * ⚠️ Returns `{}`, never `{ invoker: undefined }`. firebase-functions copies the
 * key on `hasOwnProperty`, so an explicitly-undefined one still reaches
 * `convertInvoker(undefined)` and throws during codebase analysis. Unset must
 * degrade to today's behaviour — the manual gcloud grants, which are
 * documented — never to a guess.
 *
 * ⚠️ A BLANK value does NOT throw, and that is why `filter(Boolean)` below is
 * load-bearing rather than tidiness. Measured against firebase-functions@7.3.2's
 * `convertInvoker`:
 *
 *   absent          no `invoker` key          <- what this returns when unset
 *   undefined       THROWS at codebase analysis
 *   `[]`            THROWS "Must be a non-empty array."
 *   `''`            ACCEPTED -> `invoker: [""]`
 *   `['', 'a@...']` ACCEPTED -> the blank member SURVIVES
 *
 * Its blank-member guard is `invoker.find((inv) => inv.length === 0)`, which
 * returns `''` — FALSY — so the "Must be a non-empty string" branch beside it is
 * unreachable. A blank therefore sails through analysis and fails one stage
 * later, in firebase-tools' `formatServiceAccount` at DEPLOY time. Producing an
 * empty-string member here would look valid locally and break the deploy.
 *
 * Inlined at build time by `build.mjs` (esbuild `define`) for the same reason as
 * the region: function options are read during Firebase's codebase analysis,
 * before any env exists. ⚠️ Never assign back to `process.env.TASKS_INVOKER_SA`
 * — the define already covers every read, and esbuild warns on `"x" = "x"`.
 */
export function tasksInvokerOptions(): { invoker?: string[] } {
  const serviceAccounts = (process.env.TASKS_INVOKER_SA ?? '')
    .split(',')
    .map((sa) => sa.trim())
    .filter(Boolean);
  return serviceAccounts.length > 0 ? { invoker: serviceAccounts } : {};
}
