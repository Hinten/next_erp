'use client';

/**
 * The state machinery both Mercado Livre bulk actions share (#816): the
 * per-conta outcome ledger, the in-flight flag, and the one sequence that must
 * NOT diverge between the two flows — commit the outcomes, THEN rethrow
 * whatever `describeError` did not recognise (root `CLAUDE.md` rule 6). A
 * throw that jumps the commit would strand a job that really did start: its
 * `jobId` is the only handle the UI has on it.
 *
 * Only the machinery is shared. The two flows keep their own hooks, dialogs
 * and cards — they differ in start call, options, copy and error map, which is
 * most of the code, and `precoSync.ts` already sets the in-repo precedent of
 * cloning the mass-import flow rather than generalising it.
 */
import { useCallback, useState } from 'react';

import type { JobErrorDescription } from './mercadoLivreJobErrors';
import { type ContaJobOutcome, type ContaRef, startJobsForContas } from './startJobsForContas';

export interface ContaJobFan {
  /** One entry per conta touched this session, newest run's result per conta. */
  readonly entries: readonly ContaJobOutcome[];
  /** A fan-out is in flight — drives the dialog's submit spinner. */
  readonly busy: boolean;
  readonly run: (
    contas: readonly ContaRef[],
    start: (contaId: string) => Promise<{ jobId: string }>,
  ) => Promise<void>;
  readonly dismiss: (contaId: string) => void;
}

export function useContaJobFan(
  describeError: (err: unknown) => JobErrorDescription | null,
): ContaJobFan {
  const [entries, setEntries] = useState<readonly ContaJobOutcome[]>([]);
  const [busy, setBusy] = useState(false);

  const dismiss = useCallback((contaId: string) => {
    setEntries((cur) => cur.filter((e) => e.conta.id !== contaId));
  }, []);

  const run = useCallback<ContaJobFan['run']>(
    async (contas, start) => {
      setBusy(true);
      try {
        const { outcomes, unexpected } = await startJobsForContas({
          contas,
          start,
          describeError,
        });
        setEntries((cur) => mergeByConta(cur, outcomes));
        if (unexpected.length > 0) throw unexpected[0];
      } finally {
        setBusy(false);
      }
    },
    [describeError],
  );

  return { entries, busy, run, dismiss };
}

/**
 * Replace a conta's previous entry in place, append the rest. Keyed by conta
 * so re-running for an account swaps its card instead of stacking a stale
 * progress card next to a fresh "já em andamento" row.
 */
function mergeByConta(
  current: readonly ContaJobOutcome[],
  incoming: readonly ContaJobOutcome[],
): ContaJobOutcome[] {
  const byConta = new Map(incoming.map((o) => [o.conta.id, o]));
  const merged = current.map((existing) => byConta.get(existing.conta.id) ?? existing);
  const seen = new Set(current.map((e) => e.conta.id));
  return [...merged, ...incoming.filter((o) => !seen.has(o.conta.id))];
}
