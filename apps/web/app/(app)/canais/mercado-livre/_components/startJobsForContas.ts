/**
 * The multi-conta fan-out behind both Mercado Livre bulk actions (#816): one
 * selected conta = one independent job. Kept React-free on purpose, mirroring
 * the `dispatchEmitirNFe` / `useEmitirNFeAction` split in `lib/nfe/bulkEmit.ts`,
 * so the contract that matters — a conta whose start FAILS must not cost the
 * others theirs — is a plain async unit test.
 *
 * Parallel, via `Promise.allSettled`:
 *  - the backend's one-job-per-conta guard is scoped to a single
 *    `integracaoId` (`startMassImportJob` / `startPriceSyncJob`), so there is
 *    no cross-conta contention to serialize against;
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
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Integracao } from '@delfrance/schemas';

import type { JobErrorDescription } from './mercadoLivreJobErrors';

/** The minimum a selected TableView row contributes: an id and a display label. */
export interface ContaRef {
  readonly id: string;
  readonly nome: string;
}

/**
 * A selected row as the job list needs it. `nome` is read defensively even
 * though the type promises a string: TableView projects only the columns the
 * user has visible, so hiding the Nome column strips the field at runtime
 * (the trap `useDevolucaoIntegralAction` documents). It is a display label
 * here, not an eligibility input, so it falls back to the id rather than
 * costing a fresh read per selected conta.
 */
export function contaRefFromRow(row: SnapshotRow<Integracao>): ContaRef {
  const nome: unknown = row.data.nome;
  return {
    id: row.id,
    nome: typeof nome === 'string' && nome.length > 0 ? nome : row.id,
  };
}

/** What became of one conta's start attempt. */
export type ContaJobOutcome =
  | { readonly kind: 'started'; readonly conta: ContaRef; readonly jobId: string }
  | {
      readonly kind: 'error';
      readonly conta: ContaRef;
      readonly color: JobErrorDescription['color'];
      readonly message: string;
    };

export interface FanOutResult {
  /** One entry per input conta, in input order. */
  readonly outcomes: readonly ContaJobOutcome[];
  /** Throwables `describeError` returned `null` for — the caller rethrows the first. */
  readonly unexpected: readonly unknown[];
}

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
        // Not a Mercado Livre client failure — hand it back untouched so the
        // caller can rethrow it. Rejecting here (rather than returning an
        // 'error' outcome) is what keeps it out of the operator-facing list.
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
