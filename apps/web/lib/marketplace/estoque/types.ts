import type { IntegracaoTipo } from '@delfrance/schemas';

import type { PushDeps, PushIntegracao, PushOutcome, PushRowBase } from '../push/types';

/**
 * The marketplace stock-push contract (#819) — the port of the legacy
 * `switch (integracaoTarget.tipo)` in
 * `.old/lib/produtos/pages/enviarEstoqueDialog.dart:261-336`.
 *
 * Deliberately channel-NEUTRAL. Every channel backend answers
 * `POST /api/marketplace/<canal>/enviar-estoque` with the same envelope, so this
 * layer never learns which marketplace replied. See `README.md` for what adding
 * a second channel costs.
 *
 * Everything an operation-agnostic layer can own now lives in `../push/types`;
 * what stays here is the stock payload and this operation's own vocabulary.
 */

/** How one listing ended up. Mirrors the backend's `PushEstoqueOutcome`. */
export type StockPushOutcome = PushOutcome;

/**
 * One listing's outcome, as the dialog renders it.
 *
 * ⚠️ The unit is the LISTING, not the produto: a produto can carry several live
 * anúncios on ONE conta (the sweep's link join deliberately has no `limit(1)` —
 * see #781), so the legacy dialog's one-row-per-(produto, integração) shape
 * would hide a latched sibling completely.
 */
export interface StockPushRow extends PushRowBase {
  quantidade: number | null;
}

/** What one channel's push returned, already flattened into display rows. */
export interface StockPushChannelResult {
  rows: StockPushRow[];
  /** ISO-8601 when the channel rate-limited us; the rest was not attempted. */
  pausadoAte: string | null;
}

/** The account a push targets, resolved by the orchestrator before dispatch. */
export type StockPushIntegracao = PushIntegracao;

/** Clients a provider may reach for. One field per channel, added as they land. */
export type StockPushDeps = PushDeps;

export interface StockPushInput {
  integracao: StockPushIntegracao;
  /** Family anchors (or any produto — the backend resolves to the anchor). */
  produtoIds: readonly string[];
  /** Names for the report, so a skip row can still say which produto it was. */
  nomePorProdutoId: ReadonlyMap<string, string>;
  /** Re-verify a latched listing against the channel before sending. */
  reenviarComErro: boolean;
  deps: StockPushDeps;
  /** Aborted when the operator cancels; providers forward it to `fetch`. */
  signal?: AbortSignal;
}

/**
 * One channel's stock-push implementation. Registered by the `tipos` it claims;
 * a tipo may be claimed by exactly one provider (the registry throws at module
 * load otherwise).
 */
export interface StockPushProvider {
  readonly tipos: readonly IntegracaoTipo[];
  enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult>;
}
