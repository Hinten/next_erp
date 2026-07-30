import type { Firestore } from 'firebase/firestore';
import type { FreteDoPedido, IntFrete, IntegracaoFrete, Pedido } from '@delfrance/schemas';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

import type { MercadoLivreClient } from '@/lib/mercado-livre/client';
import type { printJob } from '@/lib/print-agent/printJob';

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
}

/** The clients + print helper a provider issues its network / device I/O through. */
export interface EtiquetaProviderDeps {
  /** Freight HTTP client (`imprimir` / `comprar`); `null` while logged out. */
  readonly freightClient: FreightHttpClient | null;
  /** NF-e HTTP client (reserved for marketplace/fiscal label providers); may be `null`. */
  readonly nfeClient: NFeHttpClient | null;
  /** Mercado Livre HTTP client (label fetch + NF-e resend); `null` while logged out. */
  readonly mercadoLivreClient: MercadoLivreClient | null;
  /** Local print-agent bridge (falls back to a browser download). */
  readonly printJob: typeof printJob;
  /** Injectable wait (the ML invoice-pending retry); providers default to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Everything a provider receives. `frete` is the LIVE `pedido.freteInicial`
 * (not the checkout snapshot); `intFrete` is the already-resolved integration
 * (the registry resolves it before gates, so providers never re-read it).
 */
export interface EtiquetaProviderInput {
  readonly db: Firestore;
  readonly pedido: Pedido;
  readonly pedidoId: string;
  /** The live `freteInicial` block of the pedido. */
  readonly frete: FreteDoPedido;
  /** The resolved freight integration (id + tipo + its doc). */
  readonly intFrete: {
    readonly id: string;
    readonly tipo: IntegracaoFrete;
    readonly data: IntFrete;
  };
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
  /** Emit or (re)print the label for one pedido. Assumes the shared gates ran. */
  emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome>;
}
