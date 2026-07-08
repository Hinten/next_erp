import { saveBlob } from '../nfe/saveBlob';

/**
 * Local print-agent client. Silent printing to the warehouse Zebra/laser needs
 * a local daemon (WebUSB fails on Windows driver-claim; ZPL-only alternatives
 * and Chrome kiosk-printing can't route between two printers). This ports the
 * legacy Flutter client (`.old/lib/global/imprimir.dart` +
 * `.old/packages/global/lib/src/printing/printRequest.dart`) EXACTLY so the
 * already-deployed agent keeps working, with a browser-download fallback.
 */

/** Paper size the agent routes on: A4 sheet vs 10×15cm etiqueta. */
export type TamanhoFolha = 'a4' | 'etq';

/** The exact JSON body the deployed agent (`PrintRequest.fromJson`) expects. */
export interface PrintAgentRequest {
  docName: string;
  docDataBase64: string;
  /** the DOCUMENT's MIME type (application/pdf, text/plain, …) — the agent routes on it. */
  contentType: string;
  tamanhoFolhaImpressao: TamanhoFolha;
  /** legacy always sends null (`jobTime?.toIso8601String()` with no jobTime). */
  jobTime: string | null;
}

const AGENT_URL = process.env.NEXT_PUBLIC_PRINT_AGENT_URL ?? 'http://localhost:8888';

export interface PrintJobOptions {
  fileName: string;
  /** the document's MIME type. */
  contentType: string;
  tamanho: TamanhoFolha;
}

/**
 * POST a document to the local print agent. Falls back to a browser download
 * when the agent is unreachable (fetch rejects with a `TypeError`) or returns a
 * non-OK status; any other error (e.g. a base64-encoding failure) propagates.
 * Returns which path ran so the UI can toast accordingly.
 *
 * The POST is a CORS **simple request** (`text/plain` body, no custom headers →
 * no preflight), mirroring the Flutter `http.post(uri, body: <string>)` default
 * so the deployed agent — which already serves permissive CORS (legacy web read
 * the status) — needs no change. We deliberately do NOT retry with
 * `mode:'no-cors'`: an opaque response reads as success and would risk a double
 * print (agent prints + browser downloads).
 */
export async function printJob(
  blob: Blob,
  opts: PrintJobOptions,
  deps: { fetch?: typeof fetch; saveBlob?: typeof saveBlob } = {},
): Promise<'printed' | 'downloaded'> {
  const doFetch = deps.fetch ?? fetch;
  const doSave = deps.saveBlob ?? saveBlob;

  const request: PrintAgentRequest = {
    docName: opts.fileName,
    docDataBase64: await blobToBase64(blob),
    contentType: opts.contentType,
    tamanhoFolhaImpressao: opts.tamanho,
    jobTime: null,
  };

  try {
    const res = await doFetch(AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      doSave(blob, opts.fileName);
      return 'downloaded';
    }
    return 'printed';
  } catch (err) {
    // An unreachable / down agent rejects fetch with a TypeError (also the CORS
    // rejection shape). Fall back to a download; rethrow anything unexpected.
    if (err instanceof TypeError) {
      doSave(blob, opts.fileName);
      return 'downloaded';
    }
    throw err;
  }
}

/**
 * Base64-encode a Blob. Chunks the byte array through `btoa` (spreading the whole
 * array into `String.fromCharCode` overflows the call stack on large labels).
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x2000; // 8 KB per fromCharCode call — safely under the arg-count limit
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
