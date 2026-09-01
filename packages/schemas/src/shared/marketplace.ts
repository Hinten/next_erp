import { INTEGRACAO_TIPO, type IntegracaoTipo } from '../integracao';
import type { OrigemConversa } from '../conversa';

/**
 * Marketplace capability table — what replaced the `MarketplaceChannel` plugin
 * contract in #815. See ADR 0015 and the `marketplace-integration` skill.
 *
 * The contract it replaces declared ~25 members a channel "may" implement and
 * left every caller to feature-detect `typeof channel.pushPrice`. That answers
 * the wrong question twice over: it cannot be asked without holding a
 * server-side channel object (so `apps/web` can never ask it), and half of what
 * is worth knowing about a marketplace is not a function at all — whether it has
 * variations, whether it signs its webhooks, whether stock goes out one listing
 * at a time or as a batch.
 *
 * This is the `FREIGHT_TIPO_CAPS` shape (`./frete.ts`), which has thirteen
 * consuming files against that contract's one.
 */

/**
 * ⚠️ **Three-valued on purpose.** Five of the six rows below are channels nobody
 * has researched, and a `boolean` cannot say *"nobody has checked"* — it can only
 * say `false`, which reads as an answer. Putting an unverified claim into a type
 * is exactly the failure #815 exists to undo, so the honest default for an
 * unbuilt channel is `'desconhecido'`, and Phase 0 of the skill (read the
 * provider's documentation) is what converts it.
 *
 * Never guess `'sim'`/`'nao'` to make something compile. `'desconhecido'` exists
 * so you do not have to.
 */
export type Suporte = 'sim' | 'nao' | 'desconhecido';

/**
 * How a channel accepts a stock write. This is the axis on which Mercado Livre
 * is **least** representative, and it changes the whole downstream design:
 *
 * - `'por-anuncio'` — one call per listing (ML: `PUT /items/{id}`; two calls on a
 *   multiorigin conta). Drives one-task-one-write with the quantities baked into
 *   the task payload, and makes per-write cost the reason the sweep is tiered.
 * - `'lote'` — one call carrying up to `loteMax` SKUs, with a per-entry result
 *   array that must be unpacked to attribute a failure.
 * - `'feed-assincrono'` — submit a document, poll a result report later.
 *   ⚠️ NOT a variant of the other two: the notification pipeline's contract is
 *   "deterministic outcomes RETURN, transient failures THROW", and it has no
 *   state for *"submitted, result unknown"*. That protocol needs a submission
 *   record plus a poll sweep, which no channel here has written.
 */
export type EstoqueProtocolo =
  | 'por-anuncio'
  | 'lote'
  | 'feed-assincrono'
  | 'nenhum'
  | 'desconhecido';

export interface EstoqueCapabilities {
  readonly suporte: Suporte;
  readonly protocolo: EstoqueProtocolo;
  /** Max SKUs per call/feed. `null` when not applicable or not yet known. */
  readonly loteMax: number | null;
  /** Per-depósito / per-warehouse stock rather than one pooled quantity. */
  readonly multiDeposito: Suporte;
}

export interface MarketplaceCapabilities {
  /* ---- facts about THIS repo — exact, never 'desconhecido' ---- */
  /** Backend segment for `/api/marketplace/<channel>/*`, or `null` with no app. */
  readonly channel: string | null;
  /** Is there a deployed `apps/<channel>` backend today? */
  readonly implementado: boolean;

  /* ---- facts about the PROVIDER — tri-state ---- */
  readonly auth: 'oauth2' | 'api-key' | 'token-longo' | 'nenhuma' | 'desconhecido';
  /** PKCE (RFC 7636) — usually a per-registered-application toggle, not a global. */
  readonly pkce: Suporte;
  readonly notificacoes: 'push' | 'poll' | 'nenhuma' | 'desconhecido';
  /**
   * ⚠️ Does the provider SIGN its notifications? Mercado Livre does not — which
   * is why its receiver falls back to an `application_id` comparison that fails
   * OPEN. Every other channel here signs, and a signed channel must fail
   * **CLOSED** (secret unset ⇒ 503). Do not copy ML's receiver posture.
   */
  readonly assinaWebhook: Suporte;

  readonly publicarAnuncio: Suporte;
  readonly importarAnuncio: Suporte;
  readonly variacoes: Suporte;
  readonly categoriasEAtributos: Suporte;
  /** Size charts / grades — the ERP side is the `tabMedi` collection. */
  readonly tabelaDeMedidas: Suporte;
  /**
   * Native bundles whose stock the provider derives from the components.
   * ⚠️ ML is `'nao'`, and that is a **per-channel limitation, not a property of
   * virtual kits** — see `produto.ehKitVirtual`, whose docstring says so
   * outright, and #1087, the oversell that came from reading it the other way.
   */
  readonly kitVirtual: Suporte;

  readonly estoque: EstoqueCapabilities;
  readonly enviarPreco: Suporte;

  readonly importarPedido: Suporte;
  readonly importarPagamento: Suporte;
  /** Several orders consolidated into one shipment/pedido (ML packs). */
  readonly consolidaPacote: Suporte;
  /** The buyer's fiscal identity needs a second, gated call (not inline). */
  readonly dadosFiscaisSeparados: Suporte;

  /** `'fetch'` = the marketplace mints it and we download; `'emit'` = we mint it. */
  readonly etiqueta: 'fetch' | 'emit' | 'nenhuma' | 'desconhecido';
  readonly rastreio: 'push' | 'pull' | 'nenhuma' | 'desconhecido';
  readonly enviarNfe: Suporte;

  readonly perguntas: Suporte;
  readonly mensagensPosVenda: Suporte;
  readonly reclamacoes: Suporte;
  /** `OrigemConversa` values this channel writes into the unified inbox. */
  readonly origensConversa: readonly OrigemConversa[];
}

/**
 * The marketplace subset of `IntegracaoTipo`. `nenhuma`, `whatsapp` (messaging
 * only) and `balcao` (the physical counter) are not marketplaces and carry no
 * row.
 */
export type MarketplaceTipo = Exclude<
  IntegracaoTipo,
  typeof INTEGRACAO_TIPO.nenhuma | typeof INTEGRACAO_TIPO.whatsapp | typeof INTEGRACAO_TIPO.balcao
>;

/** Every capability field left `'desconhecido'` — the starting row for a channel. */
const NAO_INVESTIGADO = {
  auth: 'desconhecido',
  pkce: 'desconhecido',
  notificacoes: 'desconhecido',
  assinaWebhook: 'desconhecido',
  publicarAnuncio: 'desconhecido',
  importarAnuncio: 'desconhecido',
  variacoes: 'desconhecido',
  categoriasEAtributos: 'desconhecido',
  tabelaDeMedidas: 'desconhecido',
  kitVirtual: 'desconhecido',
  estoque: {
    suporte: 'desconhecido',
    protocolo: 'desconhecido',
    loteMax: null,
    multiDeposito: 'desconhecido',
  },
  enviarPreco: 'desconhecido',
  importarPedido: 'desconhecido',
  importarPagamento: 'desconhecido',
  consolidaPacote: 'desconhecido',
  dadosFiscaisSeparados: 'desconhecido',
  etiqueta: 'desconhecido',
  rastreio: 'desconhecido',
  enviarNfe: 'desconhecido',
  perguntas: 'desconhecido',
  mensagensPosVenda: 'desconhecido',
  reclamacoes: 'desconhecido',
  origensConversa: [],
} as const satisfies Omit<MarketplaceCapabilities, 'channel' | 'implementado'>;

/**
 * Capability table keyed by every marketplace `IntegracaoTipo`. Because it is a
 * `Record<MarketplaceTipo, …>`, adding a marketplace tipo to
 * `integracaoTipoSchema` without a caps row is a **compile error** — the
 * structural guarantee the `marketplace-integration` skill checklist relies on.
 */
export const MARKETPLACE_TIPO_CAPS: Record<MarketplaceTipo, MarketplaceCapabilities> = {
  /**
   * The one implemented channel. Every value here is observed from the running
   * integration (`apps/mercado-livre`), not read off documentation.
   */
  [INTEGRACAO_TIPO.mercadoLivre]: {
    channel: 'mercado-livre',
    implementado: true,
    auth: 'oauth2',
    // Per-application DevCenter toggle, gated here behind
    // MERCADO_LIVRE_PKCE_ENABLED. ML's docs are explicit that once it is on the
    // parameters become MANDATORY, so the flag and the toggle flip together.
    pkce: 'sim',
    notificacoes: 'push',
    // Confirmed against live traffic 2026-08-19: no signature header of any
    // kind. The `ts=…,v1=…` scheme people find is Mercado Pago's, not ML's.
    assinaWebhook: 'nao',
    publicarAnuncio: 'sim',
    importarAnuncio: 'sim',
    variacoes: 'sim',
    categoriasEAtributos: 'sim',
    tabelaDeMedidas: 'sim',
    // ML Virtual Kits exist (`POST /items/kits`) but are User-Products-only,
    // immutable once published, and cannot represent a produto that HAS
    // variations — so this port never creates one. See `produto.ehKitVirtual`.
    kitVirtual: 'nao',
    estoque: {
      suporte: 'sim',
      // One `PUT /items/{id}` per listing; two calls on a multiorigin conta
      // (`GET /user-products/{id}/stock` for the x-version, then the warehouse PUT).
      protocolo: 'por-anuncio',
      loteMax: null,
      // `warehouse_management` contas, behind MERCADO_LIVRE_STOCK_MULTIORIGEM_ENABLED.
      multiDeposito: 'sim',
    },
    enviarPreco: 'sim',
    importarPedido: 'sim',
    importarPagamento: 'sim',
    consolidaPacote: 'sim',
    // `GET /orders/{id}/billing_info` is a separate call, and the order's own
    // buyer block can arrive masked.
    dadosFiscaisSeparados: 'sim',
    etiqueta: 'fetch',
    rastreio: 'push',
    enviarNfe: 'sim',
    perguntas: 'sim',
    mensagensPosVenda: 'sim',
    reclamacoes: 'sim',
    origensConversa: ['mlperg', 'mlped', 'mlclaims'],
  },

  /**
   * ⚠️ Everything below is UNBUILT. A `'desconhecido'` is not a gap in this file
   * — it is the honest state of the question, and Phase 0 of the skill is what
   * closes it. Only values with a citation are set.
   */
  [INTEGRACAO_TIPO.shopee]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
    notificacoes: 'push',
    // Legacy Flutter carried an HMAC verifier for Shopee pushes
    // (`_verifyPushMsg`) — commented out at both call sites, which is the gap
    // #682 exists to close. Shopee DOES sign; its receiver must fail CLOSED.
    assinaWebhook: 'sim',
    // `tabMedi.tabelasMedidasShopee` already exists in the schema and the
    // migrated corpus carries rows the legacy app wrote, so a Shopee build
    // inherits stored data here rather than starting empty.
    tabelaDeMedidas: 'sim',
  },
  [INTEGRACAO_TIPO.amazon]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  [INTEGRACAO_TIPO.magalu]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  [INTEGRACAO_TIPO.lojaIntegrada]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  /**
   * Facebook/Instagram is messaging-first (Shops catalog + Messenger + page
   * comments, #557) rather than an order marketplace, so several rows here may
   * settle on `'nao'` rather than on a capability. `origensConversa` is a fact
   * about OUR schema — both values already exist in `ORIGEM_CONVERSA`, inherited
   * from the legacy app — not a claim about Meta's API.
   */
  [INTEGRACAO_TIPO.facebook]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
    origensConversa: ['facebook', 'comentario'],
  },
};

/** Capabilities for a marketplace tipo. */
export function marketplaceCapsFor(tipo: MarketplaceTipo): MarketplaceCapabilities {
  return MARKETPLACE_TIPO_CAPS[tipo];
}

/** Narrow an `IntegracaoTipo` to the marketplace subset. */
export function ehMarketplace(tipo: IntegracaoTipo): tipo is MarketplaceTipo {
  return (
    tipo !== INTEGRACAO_TIPO.nenhuma &&
    tipo !== INTEGRACAO_TIPO.whatsapp &&
    tipo !== INTEGRACAO_TIPO.balcao
  );
}

/**
 * Capabilities for any `IntegracaoTipo`, or `null` for a non-marketplace one.
 * The shape `apps/web` wants, where a tipo arrives off a stored document.
 */
export function marketplaceCapsOrNull(tipo: IntegracaoTipo): MarketplaceCapabilities | null {
  return ehMarketplace(tipo) ? MARKETPLACE_TIPO_CAPS[tipo] : null;
}
