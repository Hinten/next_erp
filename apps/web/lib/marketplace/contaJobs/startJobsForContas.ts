import type { ContaJobOutcome, ContaRef, FanOutResult, JobErrorDescription } from './types';

/**
 * The multi-conta fan-out behind a channel's bulk job actions (#816): one
 * selected conta = one independent job. Kept React-free on purpose, mirroring
 * the `dispatchEmitirNFe` / `useEmitirNFeAction` split in `lib/nfe/bulkEmit.ts`,
 * so the contract that matters — a conta whose start FAILS must not cost the
 * others theirs — is a plain async unit test.
 *
 * Parallel, via `Promise.allSettled`:
 *  - a channel backend's one-job-per-conta guard is scoped to a single
 *    `integracaoId` (Mercado Livre's `startMassImportJob` / `startPriceSyncJob`
 *    are the worked example), so there is no cross-conta contention to
 *    serialize against;
 *  - `allSettled` preserves input order, so the entry list matches the row
 *    order the operator selected;
 *  - and it makes the caller total, which matters because
 *    `useActionRunner.execute` awaits `ActionConfig.run` with NO try/catch — a
 *    rejection there is an unhandled promise rejection, not a caught error.
 *
 * Root `CLAUDE.md` rule 6 (no generic catch) is why `unexpected` exists:
 * anything `describeError` does not recognise is collected rather than
 * swallowed, and the caller rethrows it — but only AFTER committing
 * `outcomes`, because a started job's `jobId` is the only handle the UI has on
 * it and a throw that loses it strands a running job with no progress view.
 */
export async function startJobsForContas(input: {
  readonly contas: readonly ContaRef[];
  readonly start: (contaId: string) => Promise<{ jobId: string }>;
  readonly describeError: (err: unknown) => JobErrorDescription | null;
}): Promise<FanOutResult> {
  const { contas, start, describeError } = input;

  const settled = await Promise.allSettled(
    contas.map(async (conta): Promise<ContaJobOutcome> => {
      try {
        const { jobId } = await start(conta.id);
        return { kind: 'started', conta, jobId };
      } catch (err) {
        const described = describeError(err);
        // Not a failure this channel's error map recognises — hand it back
        // untouched so the caller can rethrow it. Rejecting here (rather than
        // returning an 'error' outcome) is what keeps it out of the
        // operator-facing list.
        if (!described) throw err;
        return { kind: 'error', conta, color: described.color, message: described.message };
      }
    }),
  );

  const outcomes: ContaJobOutcome[] = [];
  const unexpected: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') outcomes.push(result.value);
    else unexpected.push(result.reason);
  }
  return { outcomes, unexpected };
}
