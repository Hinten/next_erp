import type { IntegracaoTipo } from '@delfrance/schemas';
import type { MercadoLivreClient } from '@/lib/mercado-livre/client';

/**
 * The marketplace stock-push contract (#819) — the port of the legacy
 * `switch (integracaoTarget.tipo)` in
 * `.old/lib/produtos/pages/enviarEstoqueDialog.dart:261-336`.
 *
 * Deliberately channel-NEUTRAL. Every channel backend answers
 * `POST /api/marketplace/<canal>/enviar-estoque` with the same envelope, so this
 * layer never learns which marketplace replied. See `README.md` for what adding
 * a second channel costs.
 */

/** How one listing ended up. Mirrors the backend's `PushEstoqueOutcome`. */
export type StockPushOutcome = 'enviado' | 'pulado' | 'falha' | 'nao-tentado';

/**
 * One listing's outcome, as the dialog renders it.
 *
 * ⚠️ The unit is the LISTING, not the produto: a produto can carry several live
 * anúncios on ONE conta (the sweep's link join deliberately has no `limit(1)` —
 * see #781), so the legacy dialog's one-row-per-(produto, integração) shape
 * would hide a latched sibling completely.
 */
export interface StockPushRow {
  /** Stable React key: `${produtoId}:${integracaoId}:${anuncioId ?? '-'}`. */
  key: string;
  produtoId: string;
  produtoNome: string | null;
  integracaoId: string | null;
  integracaoNome: string | null;
  anuncioId: string | null;
  /** The link doc id — what the inline "Reverificar anúncio" button needs. */
  linkDocId: string | null;
  outcome: StockPushOutcome;
  /** Machine code (`anuncio-em-erro`, `sem-anuncio`, …). Null on success. */
  motivo: string | null;
  /** Operator-facing pt-BR text. The BACKEND owns this wording — see README. */
  mensagem: string;
  quantidade: number | null;
}

/** What one channel's push returned, already flattened into display rows. */
export interface StockPushChannelResult {
  rows: StockPushRow[];
  /** ISO-8601 when the channel rate-limited us; the rest was not attempted. */
  pausadoAte: string | null;
}

/** The account a push targets, resolved by the orchestrator before dispatch. */
export interface StockPushIntegracao {
  id: string;
  nome: string;
  tipo: IntegracaoTipo;
  ativo: boolean;
}

/** Clients a provider may reach for. One field per channel, added as they land. */
export interface StockPushDeps {
  /** Null while logged out — a provider returns an error row, never throws. */
  mercadoLivre: MercadoLivreClient | null;
}

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
