import type { Firestore } from 'firebase/firestore';
import type { FreteDoPedido, IntFrete, IntegracaoFrete, Pedido } from '@delfrance/schemas';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

import type { MercadoLivreClient } from '@/lib/mercado-livre/client';
import type { printJob } from '@/lib/print-agent/printJob';
import type { ShopeeClient } from '@/lib/shopee/client';
import type { EnderecoDeColeta } from '@/lib/shopee/wire';

/**
 * The etiqueta (shipping-label) provider contract for the checkout screen.
 *
 * Port of the legacy `emitirOuImprimirFrete` dispatch
 * (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart`), which was one
 * carrier-`tipo`-switched action that either bought/printed a Melhor Envio
 * label, fetched a marketplace label, or rendered a generic PDF. Here that
 * switch is a **registry of providers** keyed by `IntegracaoFrete` tipo; the
 * shared pre-gates (`gates.ts`) and the resolution/dispatch (`registry.ts`)
 * are carrier-agnostic, so a new carrier is one provider file + one registry
 * row (see `README.md`).
 *
 * The provider is **pure of UI**: every side effect it can't do itself — a
 * confirm dialog, a toast, opening a URL, driving the ME buy modal — is an
 * injected `ui.*` callback, mirroring how `nfeFlow.ts` keeps the flow logic
 * testable with fakes. Firebase reads/writes go through the injected `db` +
 * `deps` clients, never a module singleton.
 */

/** A toast the provider asks the UI to show (Mantine `notifications.show` shape). */
export interface NotifyInput {
  readonly title: string;
  readonly message: string;
  /** Mantine color token (e.g. `'red'`, `'yellow'`); UI picks a default when absent. */
  readonly color?: string;
}

/**
 * What the UI's ME buy bridge needs to open the real `EtiquetaComprarModal`
 * (wired in a later PR). Deliberately minimal — the modal already re-resolves
 * the cart from the pedido doc, so the provider only forwards routing ids.
 */
export interface ComprarEtiquetaInput {
  /** The Melhor Envio `int_frete` account id (the modal's `intFreteId`). */
  readonly intFreteId: string;
  readonly pedidoId: string;
  /** The live frete block (carries `printLabelId` / `externalOptionData`). */
  readonly frete: FreteDoPedido;
  /** True when the frete is already posted → the modal shows the risk ack. */
  readonly needsPostedConfirm: boolean;
}

/**
 * The buy bridge's result. The SERVER persists `printLabelId` + the frete
 * `estado` on a successful buy — the client writes nothing — so the provider
 * only needs to know whether a printable label came back.
 */
export type ComprarEtiquetaOutcome =
  /** The operator completed the buy; `printUrl` is the label to open when present. */
  | { readonly status: 'bought'; readonly printUrl?: string }
  /** The operator closed the modal without buying. */
  | { readonly status: 'cancelled' };

/** The UI capabilities a provider drives — all injected so the flow stays testable. */
export interface EtiquetaProviderUi {
  /**
   * Ask the operator to confirm a risky action (the already-posted reprint).
   * A single boolean keeps the contract simple; the UI implements the legacy
   * two-step "estou ciente do risco" → "tem certeza absoluta" dialog behind it.
   */
  confirmRisk(msg: string): Promise<boolean>;
  /** Show a toast. */
  notify(n: NotifyInput): void;
  /** Open a URL (a bought/printed label) in a new tab. */
  openUrl(url: string): void;
  /** Drive the ME buy modal to completion and report whether a label was bought. */
  comprarEtiqueta(input: ComprarEtiquetaInput): Promise<ComprarEtiquetaOutcome>;
  /**
   * Ask the operator how ONE Shopee package ships (#1523): a pickup address and
   * slot, or a drop-off at the agency. `null` = the operator cancelled. The
   * options are the server's 202 `escolher-envio` body, verbatim; the provider
   * adds the package itself when it sends the answer back.
   *
   * ⚠️ REQUIRED, not optional: an optional member would let a UI forget it and
   * still compile, and that screen's Shopee label would then die on the first
   * pickup question — SPX is a PICKUP channel, so the question is the main
   * path, not an edge.
   */
  escolherEnvio(p: {
    pacoteRotulo: string | null;
    mensagem: string;
    enderecos: readonly EnderecoDeColeta[];
    permiteDropoff: boolean;
    escolhaInvalida: boolean;
  }): Promise<
    { modo: 'pickup'; enderecoId: string; horarioId: string | null } | { modo: 'dropoff' } | null
  >;
}

/** The clients + print helper a provider issues its network / device I/O through. */
export interface EtiquetaProviderDeps {
  /** Freight HTTP client (`imprimir` / `comprar`); `null` while logged out. */
  readonly freightClient: FreightHttpClient | null;
  /** NF-e HTTP client (reserved for marketplace/fiscal label providers); may be `null`. */
  readonly nfeClient: NFeHttpClient | null;
  /** Mercado Livre HTTP client (label fetch + NF-e resend); `null` while logged out. */
  readonly mercadoLivreClient: MercadoLivreClient | null;
  /**
   * Shopee HTTP client (label fetch, #1523); `null` while logged out. REQUIRED
   * so every construction site has to say which client it threads — a site
   * that forgot it would otherwise compile and quietly answer "cliente
   * indisponível" on every Shopee label.
   */
  readonly shopeeClient: ShopeeClient | null;
  /** Local print-agent bridge (falls back to a browser download). */
  readonly printJob: typeof printJob;
  /** Injectable wait (the ML invoice-pending retry); providers default to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The freight integration an etiqueta action dispatches on — what
 * `resolverIntFrete` (`intFrete.ts`) answers, in two shapes:
 *
 *   - `'doc'`   — the pedido's `int_frete` document, read through
 *                 `integracaoFreteOuterRef` (today's only shape);
 *   - `'bloco'` — NO document: the frete block's `externalOptionIntegracao`
 *                 names a marketplace-owned tipo, and that is the whole
 *                 identity. A Shopee pedido has no `int_frete` ref at all, and
 *                 an ML pedido whose ref was degraded to null on import is the
 *                 same case (#1523, R-q).
 *
 * ⚠️ A provider that needs the DOCUMENT (its id or its data) must narrow on
 * `fonte === 'doc'` first — Melhor Envio passes `id` to its HTTP client, the
 * generic label prints the account's `nome` in its subtitle. The union makes
 * forgetting that a compile error rather than a `null` sent to a carrier.
 */
export type IntFreteResolvido =
  | {
      readonly fonte: 'doc';
      readonly id: string;
      readonly tipo: IntegracaoFrete;
      readonly data: IntFrete;
    }
  | {
      readonly fonte: 'bloco';
      readonly id: null;
      readonly tipo: IntegracaoFrete;
      readonly data: null;
    };

/**
 * Everything a provider receives. `frete` is the LIVE `pedido.freteInicial`
 * (not the checkout snapshot); `intFrete` is the already-resolved integration
 * (the CALLER resolves it through `resolverIntFrete` before the registry runs,
 * so providers never re-read it).
 */
export interface EtiquetaProviderInput {
  readonly db: Firestore;
  readonly pedido: Pedido;
  readonly pedidoId: string;
  /** The live `freteInicial` block of the pedido. */
  readonly frete: FreteDoPedido;
  /** The resolved freight integration — its doc, or only the block's marketplace tipo. */
  readonly intFrete: IntFreteResolvido;
  /** The requested label format (the checkout dropdown). */
  readonly formato: 'pdf' | 'zpl2';
  readonly deps: EtiquetaProviderDeps;
  readonly ui: EtiquetaProviderUi;
}

/**
 * The result of an etiqueta action. `printed`/`opened` are the delivered
 * happy paths; `skipped` is a silent no-op (semFrete, or the operator
 * declined a risky reprint); `needs-quote` sends the operator to the pedido
 * editor to pick a service first; `unsupported` is a carrier with no label
 * flow yet; `error` carries a ready-to-toast message.
 */
export type EtiquetaOutcome =
  | { status: 'printed' | 'opened' | 'skipped' }
  | { status: 'needs-quote'; editorHref: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; message: string };

/** A carrier's etiqueta implementation. Registered by the `tipos` it claims. */
export interface CheckoutEtiquetaProvider {
  /** The `IntegracaoFrete` tipos this provider is registered for. */
  readonly tipos: readonly IntegracaoFrete[];
  /**
   * What a reprint of an already-posted frete produces. `'pode-duplicar'` (the
   * default when absent) = a reprint can yield a SECOND paid label, so the
   * gates ask the posted-risk confirm; `'mesmo-documento'` = the carrier hands
   * back the same document every time and refuses a second shipment itself, so
   * the confirm would only cry wolf (Shopee, #1523 R-f).
   */
  readonly reimpressao?: 'pode-duplicar' | 'mesmo-documento';
  /** Emit or (re)print the label for one pedido. Assumes the shared gates ran. */
  emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome>;
}
