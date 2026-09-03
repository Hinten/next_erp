import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Integracao } from '@delfrance/schemas';

/**
 * The vocabulary of a multi-conta job fan-out: one selected account, one job,
 * one outcome each.
 *
 * Channel-neutral by construction — the only schema type here is `Integracao`,
 * which every channel shares, and the two things that differ per channel (the
 * start call and the error narrowing) are injected. It lives here rather than
 * under `canais/mercado-livre/_components/` because a second channel would
 * otherwise fork it, which is what #1430 asked to prevent.
 */

/**
 * How a contained per-conta failure is rendered: a colour plus its copy.
 *
 * The PORT, not the implementation. Each channel supplies its own
 * `(err: unknown) => JobErrorDescription | null` — Mercado Livre's pair lives
 * in `canais/mercado-livre/_components/mercadoLivreJobErrors.ts`, next to the
 * client whose error classes it narrows. `null` means "not mine": root
 * `CLAUDE.md` rule 6, narrow and rethrow everything else.
 */
export interface JobErrorDescription {
  readonly color: 'yellow' | 'red';
  readonly message: string;
}

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
