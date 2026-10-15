/**
 * The ledger movement pre-pass, **as a contract only**.
 *
 * The window's net stock movement per `(produto, depósito)` pair is what lets a
 * sweep answer *did the published number actually change* without a per-family
 * query: one uncorrelated aggregate per tick, then pure arithmetic on top of it
 * ({@link MovimentosDaJanela} feeds `quantidadesAnterioresCore`).
 *
 * ⚠️ **Only the TYPES live here — never the implementation.** The aggregate is
 * a Firestore **Pipelines** execution, and `packages/data` declares no
 * dependency on the admin Firestore SDK's Pipelines package. Worse,
 * `admin/adminBundleSafety.test.ts`
 * scans for `firebase-admin` only, so a pipelines import added here would fail
 * nothing at all and surface as a module-resolution error in whichever app
 * imported it next. Each channel keeps its own {@link FetchMovimentosDaJanela}
 * implementation beside its own query (Mercado Livre's is
 * `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.ts`) and injects
 * it — which is also what makes the whole pre-pass testable, since pipelines
 * never run in the emulator.
 *
 * The `firebase-admin/firestore` import below is `import type` only, erased at
 * emit, exactly as every other module under `admin/` does it (the property
 * `adminBundleSafety.test.ts` asserts for the whole subtree).
 */
import type { Firestore } from 'firebase-admin/firestore';

/** Net movement of one `(produto, depósito)` pair over the sweep's window. */
export interface MovimentoDaJanela {
  /** Σ `movimento` — the signed change in `quantidade`. */
  dq: number;
  /** Σ `movimentoReservada` — the signed change in `quantidadeReservada`. */
  dr: number;
  /**
   * At least one row in the window carries **no `movimento` key**, so the sums
   * above do not account for the whole window and `anterior` cannot be
   * reconstructed. Consumers must treat the pair as *unknown* and send —
   * never as "the sums say it did not move", which is how a legacy row would
   * otherwise silence a real movement.
   *
   * ⚠️ "Unknown" has exactly ONE wire representation: the field is **absent**.
   * `historicoEstoque` v2 writes `movimento` on every row it creates, and the
   * v1→v2 migration OMITS the key on a balanço whose delta it cannot recover
   * rather than storing an explicit `null` — precisely so this single
   * existence test is complete. Keep it that way.
   */
  desconhecido: boolean;
}

/** Map key for {@link MovimentosDaJanela}. Exported so tests build fixtures. */
export function chaveMovimento(produtoId: string, depositoId: string): string {
  return `${produtoId}/${depositoId}`;
}

export type MovimentosDaJanela = ReadonlyMap<string, MovimentoDaJanela>;

export interface FetchMovimentosArgs {
  /** Inclusive lower bound (ms since epoch) — the sweep's frozen window start. */
  desdeMs: number;
  /** Scopes the aggregate to the conta's depósito. */
  depositoId: string;
}

/** The movement seam the sweeps consume — injectable so tests stub it. */
export type FetchMovimentosDaJanela = (
  db: Firestore,
  args: FetchMovimentosArgs,
) => Promise<MovimentosDaJanela>;
