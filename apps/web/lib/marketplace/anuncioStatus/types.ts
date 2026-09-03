import type { AcaoStatusAnuncio, IntegracaoTipo } from '@delfrance/schemas';

import type { PushDeps, PushIntegracao, PushOutcome, PushRowBase } from '../push/types';

/**
 * The marketplace PAUSE / REACTIVATE contract — the third operation on the
 * shared produto-scoped push rail (`../push/`), beside stock (#819) and price
 * (#804).
 *
 * Deliberately channel-NEUTRAL, exactly like its two siblings: every channel
 * backend answers `POST /api/marketplace/<canal>/anuncio-status` with the same
 * envelope, so this layer never learns which marketplace replied. Adding a
 * channel is one provider file, one backend route and one `buildProviderMap`
 * row — see `../push/README.md`.
 *
 * ⚠️ Unlike the other two, this operation has **no per-run option**: there is
 * nothing for the operator to tick, the direction IS the action. It keeps its
 * own `types.ts`/`registry.ts` anyway, for the reason `../push/types.ts`
 * states — one `push(input)` with an opaque payload would cost every call site
 * its readable name.
 */

export type AnuncioStatusOutcome = PushOutcome;

/**
 * One listing's outcome.
 *
 * ⚠️ The unit is the LISTING, not the produto: a produto can carry several live
 * anúncios on ONE conta (#781), and a bulk pause that reported one row per
 * produto would hide a sibling it never touched.
 */
export interface AnuncioStatusRow extends PushRowBase {
  /**
   * What ML REPORTS for the listing after the write — never the status that was
   * requested. A reactivate ML answered `paused` + `out_of_stock` for arrives
   * here as `paused`, and the row must read that way.
   */
  statusFinal: string | null;
  /** Member tally for a User-Products family; null for a simple listing. */
  membros: { total: number; aplicados: number } | null;
}

/** What one channel's run returned, already flattened into display rows. */
export interface AnuncioStatusChannelResult {
  rows: AnuncioStatusRow[];
  /** ISO-8601 when the channel rate-limited us; the rest was not attempted. */
  pausadoAte: string | null;
}

export type AnuncioStatusIntegracao = PushIntegracao;
export type AnuncioStatusDeps = PushDeps;

export interface AnuncioStatusInput {
  integracao: AnuncioStatusIntegracao;
  /** Family anchors (or any produto — the backend resolves to the anchor). */
  produtoIds: readonly string[];
  /** Names for the report, so a skip row can still say which produto it was. */
  nomePorProdutoId: ReadonlyMap<string, string>;
  acao: AcaoStatusAnuncio;
  deps: AnuncioStatusDeps;
  /** Aborted when the operator cancels; providers forward it to `fetch`. */
  signal?: AbortSignal;
}

/**
 * One channel's implementation. Registered by the `tipos` it claims; a tipo may
 * be claimed by exactly one provider (the registry throws at module load).
 */
export interface AnuncioStatusProvider {
  readonly tipos: readonly IntegracaoTipo[];
  definirStatus(input: AnuncioStatusInput): Promise<AnuncioStatusChannelResult>;
}
