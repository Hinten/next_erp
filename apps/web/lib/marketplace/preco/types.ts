import type { IntegracaoTipo } from '@delfrance/schemas';

import type { PushDeps, PushIntegracao, PushOutcome, PushRowBase } from '../push/types';

/**
 * The marketplace price-push contract (#804) — the port of the legacy
 * per-channel `switch` inside `EnviarPrecoDialog`
 * (`.old/lib/produtos/pages/produtoTableView.dart:531-1000`), which dispatched
 * one produto's price to Mercado Livre / Shopee / Loja Integrada / Amazon /
 * Magalu in turn.
 *
 * Deliberately channel-NEUTRAL. Every channel backend answers
 * `POST /api/marketplace/<canal>/enviar-precos` with the same envelope, so this
 * layer never learns which marketplace replied. See `README.md` for what adding
 * a second channel costs.
 */

/** How one listing ended up. Mirrors the backend's `PushPrecoOutcome`. */
export type PricePushOutcome = PushOutcome;

/**
 * One listing's outcome, as the dialog renders it.
 *
 * ⚠️ The unit is the LISTING, not the produto — same reason as the stock side
 * (#781): a produto can carry several live anúncios on ONE conta, and a
 * produto-scoped row would hide all but the first.
 */
export interface PricePushRow extends PushRowBase {
  /** The price actually sent; null when nothing was sent. */
  preco: number | null;
  /** What the listing carried before, when the run got far enough to read it. */
  precoAnterior: number | null;
}

/** What one channel's push returned, already flattened into display rows. */
export interface PricePushChannelResult {
  rows: PricePushRow[];
  /** ISO-8601 when the channel rate-limited us; the rest was not attempted. */
  pausadoAte: string | null;
}

/** The account a push targets, resolved by the orchestrator before dispatch. */
export type PricePushIntegracao = PushIntegracao;

/** Clients a provider may reach for. Shared with the stock push. */
export type PricePushDeps = PushDeps;

export interface PricePushInput {
  integracao: PricePushIntegracao;
  /** Family anchors (or any produto — the backend resolves to the anchor). */
  produtoIds: readonly string[];
  /** Names for the report, so a skip row can still say which produto it was. */
  nomePorProdutoId: ReadonlyMap<string, string>;
  /**
   * Allow the send to LOWER a listing's price. Defaulted ON by the produtos
   * table, unlike the account-wide job — hand-picking produtos IS the explicit
   * intent, and it is what the legacy per-produto action did unconditionally
   * (`produtoTableView.dart:607`).
   */
  baixarPreco: boolean;
  /**
   * Send even when the produto is `publicado: false` (oculto) in the ERP.
   *
   * ⚠️ Defaults ON in the dialog, and the backend treats an ABSENT value as
   * true — the inverse of `baixarPreco`. `publicado` is an ERP catalogue flag,
   * not a statement about the anúncio, and refusing on it left ML advertising a
   * stale price on a live listing. Unticked, those produtos come back as
   * `NAO_PUBLICADO` skip rows.
   */
  incluirNaoPublicados: boolean;
  deps: PricePushDeps;
  /** Aborted when the operator cancels; providers forward it to `fetch`. */
  signal?: AbortSignal;
}

/**
 * One channel's price-push implementation. Registered by the `tipos` it claims;
 * a tipo may be claimed by exactly one provider (the registry throws at module
 * load otherwise).
 */
export interface PricePushProvider {
  readonly tipos: readonly IntegracaoTipo[];
  enviarPreco(input: PricePushInput): Promise<PricePushChannelResult>;
}
