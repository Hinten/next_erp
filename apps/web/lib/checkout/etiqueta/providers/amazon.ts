import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import {
  TIPO_ETIQUETA_AMAZON,
  ehTipoEtiquetaAmazon,
  type AmazonClient,
  type EtiquetaAmazon,
} from '@/lib/amazon/client';
import {
  AmazonBackendError,
  AmazonRedeError,
  mensagemErroEtiquetaAmazon,
} from '@/lib/amazon/erros';
import { saveBlob } from '@/lib/download/saveBlob';

import type {
  CheckoutEtiquetaProvider,
  EtiquetaOutcome,
  EtiquetaProviderDeps,
  EtiquetaProviderInput,
  EtiquetaProviderUi,
} from '../types';

/**
 * Amazon etiqueta provider (step 15) — ONE call to the `apps/amazon` label route
 * (`POST /api/marketplace/amazon/etiqueta`, through `deps.amazonClient`), and
 * the ZPL it answers handed to the print agent.
 *
 * The route decides everything from the pedido and the LIVE Amazon order: for
 * an order whose pickup is scheduled it answers that schedule's label; for one
 * not scheduled yet, with the NF-e accepted, the same call schedules the pickup
 * first (the caller then needs the frete write permission). Nothing is stored,
 * so every print asks Amazon. This provider holds no flow state, no NF-e logic
 * (no resend, no wait loop) and no retry.
 *
 * ## The deadline ({@link PRAZO_ETIQUETA_AMAZON_MS})
 *
 * The call is aborted only after `longo` — LONGER than the backend can run. The
 * route sees no client abort, and the platform keeps running a request its
 * client left, so a client that gave up while the route was still inside its
 * scheduling call would free the operator to click again OVER a first-time
 * schedule still running at Amazon — two concurrent first schedules, which
 * Amazon documents nothing about. So the client waits past the backend's
 * ceiling (App Hosting's 300-s default; `apps/amazon/apphosting.yaml` pins
 * none) plus the margin the #1094 ceiling guard demands
 * (`packages/config-eslint/rules/http-client-timeout-ceiling.test.js` reads
 * this constant). In the common case the route answers in seconds.
 *
 * Every sentence after a timeout, a codeless 5xx, a cut call or a network
 * failure asks for a WAIT of about a minute and a reprint from the order list,
 * never "tente de novo" — the reprint reads the order first and finds the
 * schedule.
 *
 * ## What it never does
 *
 * - It never reads `frete.externalId` or `intFrete`: a migrated pedido may
 *   carry an incomplete freight reference, and the route resolves the conta
 *   and the order from the pedido itself.
 * - It never asks for a PDF: Amazon's label here is ZPL only, so `formato:
 *   'pdf'` prints the ZPL anyway, with a notice.
 * - It never forwards the answer's `Content-Type` to the print agent: the
 *   agent compares the type with `==`, and a parameter a proxy appended
 *   (`; charset=UTF-8`) would match nothing there and print nothing, silently.
 *   The agent always gets {@link TIPO_ETIQUETA_AMAZON}.
 *
 * ⚠️ `reimpressao: 'mesmo-documento'` — the registry skips the posted-risk
 * confirm: for an order Amazon already reads as scheduled, the route's call
 * books nothing new and answers that schedule's label, so a second paid label
 * (the confirm's whole rationale) cannot come out of a reprint. Without the
 * skip the confirm would fire on most reprints (`aguardandoPostagem` is what the
 * order import maps a scheduled pickup to).
 */

/**
 * The label call's budget, the `{ longo }` shape the #1094 ceiling guard reads:
 * the backend's 300-s ceiling plus its 60-s margin (module docblock).
 */
export const PRAZO_ETIQUETA_AMAZON_MS = { longo: 360_000 } as const;

const TITULO = 'Etiqueta Amazon';

/**
 * No client: either no session yet, or — the case a logged-in checkout meets —
 * a page that may not talk to the backend (`useBackendAmazon`'s `inseguro` /
 * `url-invalida`). The order list disables its buttons for the same reason, so
 * the exit is Seller Central. Nothing reached the backend, so a reload is safe.
 */
export const MENSAGEM_SEM_CLIENTE_AMAZON =
  'O ERP não conseguiu falar com o backend da Amazon nesta página (sessão expirada ou ' +
  'endereço do backend não configurado). Recarregue a página; se continuar, imprima a ' +
  'etiqueta pela Seller Central e avise o suporte.';

/** The deadline fired (only past {@link PRAZO_ETIQUETA_AMAZON_MS}): a wait, never a retry. */
export const MENSAGEM_DEMORA_ETIQUETA_AMAZON =
  'A Amazon demorou a responder; aguarde cerca de 1 minuto e reimprima pela lista de pedidos.';

/**
 * A transport failure: the request may have reached the route, and the route may
 * have scheduled the pickup, so it asks for the same wait as a timeout.
 */
export const MENSAGEM_REDE_ETIQUETA_AMAZON =
  'Falha de rede ao contatar o backend da Amazon. A coleta pode já ter sido pedida à Amazon: ' +
  'aguarde cerca de 1 minuto e reimprima pela lista de pedidos.';

/** `formato: 'pdf'` — the label prints anyway, on the thermal printer. */
export const AVISO_SO_ZPL_AMAZON =
  'A Amazon entrega a etiqueta só em ZPL: ela vai para a impressora térmica.';

const erro = (message: string): EtiquetaOutcome => ({ status: 'error', message });

/**
 * An abort-shaped rejection — what the client rejects with once its signal
 * aborted: an `AbortError` `DOMException`, the signal's own reason, since the
 * provider aborts without one (so never a `TimeoutError`). By NAME, never
 * `instanceof DOMException`: under jsdom that class is another realm's.
 */
function ehInterrupcao(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
}

/**
 * Whether `err` is what the label call rejects with once OUR signal aborted:
 * the abort itself (the client rethrows it untouched, in flight and during the
 * body read), or the transport failure a runtime may surface instead when the
 * abort tears the connection down mid-body — a bare `TypeError`, or the
 * client's {@link AmazonRedeError} around one.
 */
function ehFimDoPrazo(err: unknown): boolean {
  return ehInterrupcao(err) || err instanceof TypeError || err instanceof AmazonRedeError;
}

/**
 * The ONE call, under {@link PRAZO_ETIQUETA_AMAZON_MS}. Our deadline is told
 * apart from everything else by `signal.aborted` AND an error of the shapes
 * {@link ehFimDoPrazo} names.
 */
async function buscar(
  client: AmazonClient,
  pedidoId: string,
): Promise<{ ok: true; etiqueta: EtiquetaAmazon } | { ok: false; outcome: EtiquetaOutcome }> {
  const controle = new AbortController();
  const prazo = setTimeout(() => {
    controle.abort();
  }, PRAZO_ETIQUETA_AMAZON_MS.longo);
  try {
    return { ok: true, etiqueta: await client.etiqueta(pedidoId, { signal: controle.signal }) };
  } catch (err) {
    if (controle.signal.aborted && ehFimDoPrazo(err)) {
      return { ok: false, outcome: erro(MENSAGEM_DEMORA_ETIQUETA_AMAZON) };
    }
    // A refusal (409), a permission gap (403), a 5xx, a 2xx that was not a
    // label: the copy is keyed on the route's code and motivo.
    if (err instanceof AmazonBackendError) {
      return { ok: false, outcome: erro(mensagemErroEtiquetaAmazon(err)) };
    }
    if (err instanceof AmazonRedeError) {
      return { ok: false, outcome: erro(MENSAGEM_REDE_ETIQUETA_AMAZON) };
    }
    throw err;
  } finally {
    clearTimeout(prazo);
  }
}

/**
 * Hand the ZPL to the print agent — or, for a type that is not the label's
 * (the client refuses one, so this is a backstop), DOWNLOAD it and say so,
 * never send it to the agent.
 */
async function entregar(
  etiqueta: EtiquetaAmazon,
  deps: EtiquetaProviderDeps,
  ui: EtiquetaProviderUi,
  salvarArquivo: typeof saveBlob,
): Promise<void> {
  if (!ehTipoEtiquetaAmazon(etiqueta.tipo)) {
    salvarArquivo(etiqueta.bytes, etiqueta.nomeArquivo);
    ui.notify({
      title: TITULO,
      message:
        `Formato de etiqueta não reconhecido — o arquivo foi baixado como ` +
        `"${etiqueta.nomeArquivo}" e não foi enviado à impressora.`,
      color: 'yellow',
    });
    return;
  }

  const entrega = await deps.printJob(etiqueta.bytes, {
    fileName: etiqueta.nomeArquivo,
    // ⚠️ The constant, never `etiqueta.tipo` (module docblock).
    contentType: TIPO_ETIQUETA_AMAZON,
    tamanho: 'etq',
  });
  if (entrega === 'downloaded') {
    ui.notify({
      title: TITULO,
      message:
        `Agente de impressão indisponível. O arquivo ZPL foi baixado como ` +
        `"${etiqueta.nomeArquivo}" e precisa ser enviado à Zebra manualmente — não abra no ` +
        'Bloco de Notas, ele imprime o código em vez da etiqueta.',
      color: 'yellow',
    });
  }
}

/** Provider factory with the download seam, for the unit tests. Call sites use {@link amazonProvider}. */
export function createAmazonProvider(
  opts: { salvarArquivo?: typeof saveBlob } = {},
): CheckoutEtiquetaProvider {
  const salvarArquivo = opts.salvarArquivo ?? saveBlob;
  return {
    tipos: [INTEGRACAO_FRETE.amazon],
    reimpressao: 'mesmo-documento',

    async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
      // ⚠️ `frete` and `intFrete` are never read (module docblock).
      const { pedidoId, formato, deps, ui } = input;
      if (deps.amazonClient === null) return erro(MENSAGEM_SEM_CLIENTE_AMAZON);

      const r = await buscar(deps.amazonClient, pedidoId);
      if (!r.ok) return r.outcome;

      if (formato === 'pdf') {
        ui.notify({ title: TITULO, message: AVISO_SO_ZPL_AMAZON, color: 'yellow' });
      }
      await entregar(r.etiqueta, deps, ui, salvarArquivo);
      return { status: 'printed' };
    },
  };
}

export const amazonProvider: CheckoutEtiquetaProvider = createAmazonProvider();
