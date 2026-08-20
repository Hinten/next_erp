import {
  buildEtiquetaGenericaModel,
  renderEtiquetaGenericaPdf,
  renderEtiquetaGenericaZpl,
} from '@/lib/etiqueta-generica';

import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from '../types';

/**
 * Generic-label provider for the carrier-less freight tipos (retiradaNaLoja /
 * motoboy / fob / outros) — port of the `default:` branch of
 * `emitirOuImprimirFrete.dart`, which rendered `EtiquetaFreteGenericaPDF` and
 * printed it. There is no carrier API, so the app builds the 10×15cm label from
 * the pedido data and sends it to the print agent (which falls back to a
 * browser download when the agent is offline).
 *
 * Both formats are real here. `pdf` draws the label with jsPDF; `zpl2` emits
 * ZPL for a Zebra. Legacy only pretended to support ZPL2: it toasted "ainda não
 * implementado" and printed the PDF instead, on the format that was the
 * operator's DEFAULT.
 */

/**
 * The agent routes on contentType, and `text/plain` is its raw channel:
 * `printJob.dart:268` sends it to `_printPlainText`, a Win32 spooler write with
 * `pDatatype = 'RAW'` — no driver, no rasterisation, exactly what a Zebra wants.
 *
 * ⚠️ **This is the first caller in this repo to send a top-level `text/plain`.**
 * `_printPlainText` itself is exercised in production, but reached the other
 * way: a marketplace label arrives as `application/zip` (`mercadoLivre.ts`
 * forwards ML's own content type, and ML returns a ZIP for BOTH formats), and
 * `_printFromZip:220` routes each `.txt` entry inside it to the same function.
 * So the function is proven and the entry point is not, which is also why
 * `nfeFlow.ts` still downloads the DANFE ZPL rather than printing it. The
 * agent-down path below is what surfaces it if this entry point turns out to be
 * wrong: an agent that rejects the content type answers non-OK, `printJob`
 * falls back to a download, and the operator gets told.
 */
const ZPL_CONTENT_TYPE = 'text/plain;charset=utf-8';

export const genericLabelProvider: CheckoutEtiquetaProvider = {
  tipos: ['retiradaNaLoja', 'motoboy', 'fob', 'outros'],

  async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
    const { db, pedido, pedidoId, frete, intFrete, formato, deps, ui } = input;

    try {
      const model = await buildEtiquetaGenericaModel(db, pedido, pedidoId, frete, intFrete);
      const base = `etiqueta-${pedido.numero ?? pedidoId}`;
      const artifact =
        formato === 'zpl2'
          ? {
              // A ZPL string, so the bytes are the label — no rasterisation, and
              // the Blob carries UTF-8 so `^CI28` finds the accents it expects.
              blob: new Blob([renderEtiquetaGenericaZpl(model)], { type: ZPL_CONTENT_TYPE }),
              fileName: `${base}.zpl2`,
              contentType: ZPL_CONTENT_TYPE,
            }
          : {
              blob: await renderEtiquetaGenericaPdf(model),
              fileName: `${base}.pdf`,
              contentType: 'application/pdf',
            };

      // A print (agent up) or a download (agent down) both DELIVER the label, so
      // either way the action succeeded — both map to 'printed'.
      const delivery = await deps.printJob(artifact.blob, {
        fileName: artifact.fileName,
        contentType: artifact.contentType,
        tamanho: 'etq',
      });
      // …but they are not the same thing to the operator, and the row action is
      // deliberately silent on a successful print. Without this, an agent that
      // is down looks EXACTLY like a successful print: the click appears to do
      // nothing and the label is sitting in Downloads.
      //
      // ⚠️ The two formats fail differently. A downloaded PDF is annoying but
      // usable — double-click, Ctrl+P. A downloaded `.zpl2` is a text file no
      // Windows handler owns, and opening it in Notepad prints the literal
      // `^XA^CI28…` source, so it needs its own instruction.
      if (delivery === 'downloaded') {
        ui.notify({
          title: 'Etiqueta genérica',
          message:
            formato === 'zpl2'
              ? `Agente de impressão indisponível. O arquivo ZPL foi baixado como "${artifact.fileName}" e precisa ser enviado à Zebra manualmente — não abra no Bloco de Notas, ele imprime o código em vez da etiqueta.`
              : `Agente de impressão indisponível. A etiqueta foi baixada como "${artifact.fileName}" e precisa ser impressa manualmente.`,
          color: 'yellow',
        });
      }
      return { status: 'printed' };
    } catch (err) {
      // The Firestore derefs and the jsPDF render throw plain
      // Errors; keep the post-save contract best-effort — surface a toast and
      // return an `error` outcome instead of rejecting the caller (the checkout
      // is already committed). A genuinely non-Error still propagates.
      if (!(err instanceof Error)) throw err;
      ui.notify({
        title: 'Etiqueta genérica',
        message: `Falha ao gerar a etiqueta: ${err.message}`,
        color: 'red',
      });
      return { status: 'error', message: err.message };
    }
  },
};
