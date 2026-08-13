/**
 * Test-only primitives shared across workspaces — imported by `*.test.ts`
 * files, never by shipped code.
 *
 * It sits in `src/` rather than in a `test/` folder because four different
 * workspaces import it (`packages/ui`, `apps/web`, `apps/whatsapp`,
 * `apps/mercado-livre`) and a package's `exports` map can only point at paths
 * that ship. Nothing here imports `firebase` or `firebase-admin`, so pulling
 * this subpath into a bundle would cost a few hundred bytes of dead code and
 * nothing else — but there is no reason to: no `src/**` module outside this
 * folder may import it, which `testingIsolation.test.ts` pins.
 */
export {
  deferred,
  OccAbortedError,
  OccEngine,
  type Deferred,
  type OccAttemptLogEntry,
  type OccBeforeCommitCtx,
  type OccBufferedWrite,
  type OccEngineOptions,
  type OccHost,
  type OccOpKind,
  type OccReadable,
  type OccRef,
  type OccTransaction,
  type OccWriteKind,
} from './occTransaction';
