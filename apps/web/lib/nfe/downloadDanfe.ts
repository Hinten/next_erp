/**
 * Download a DANFE artifact from `apps/nfe` and save it to disk.
 *
 * The PDF (`simplificado`) and the ZPL label (`zpl2`) both come back as a Blob
 * with a server-provided filename (`Content-Disposition`); this triggers a
 * browser download via a transient object URL. The web bundle never imports the
 * pdfkit/bwip-js renderers — only this thin HTTP path.
 */
import type {
  NFeDanfeArtifact,
  NFeDanfeFormat,
  NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';

import { saveBlob } from './saveBlob';
import { printJob as defaultPrintJob, type TamanhoFolha } from '../print-agent/printJob';

/** Trigger a browser download of an already-fetched artifact via a transient object URL. */
function saveArtifact(artifact: NFeDanfeArtifact): void {
  saveBlob(artifact.blob, artifact.filename);
}

/** Fetch + save the DANFE for an NF-e. Throws the client's typed HTTP errors. */
export async function downloadDanfe(
  client: NFeHttpClient,
  pedidoId: string,
  nfeId: string,
  format: NFeDanfeFormat,
): Promise<void> {
  saveArtifact(await client.danfe(pedidoId, nfeId, format));
}

/**
 * Fetch a DANFE and send it to the local print agent (checkout station), with a
 * browser-download fallback baked into `printJob`. Same `client.danfe` fetch as
 * `downloadDanfe`; returns which delivery path ran. `printJobFn` is injectable
 * for tests. (Existing `downloadDanfe` / callers are untouched.)
 */
export async function printDanfe(
  client: NFeHttpClient,
  pedidoId: string,
  nfeId: string,
  format: NFeDanfeFormat,
  tamanho: TamanhoFolha,
  printJobFn: typeof defaultPrintJob = defaultPrintJob,
): Promise<'printed' | 'downloaded'> {
  const artifact = await client.danfe(pedidoId, nfeId, format);
  return printJobFn(artifact.blob, {
    fileName: artifact.filename,
    contentType: artifact.contentType,
    tamanho,
  });
}

/** Fetch + save the Carta de Correção PDF for a registrada CC-e. */
export async function downloadCartaCorrecao(
  client: NFeHttpClient,
  pedidoId: string,
  nfeId: string,
  cceId: string,
): Promise<void> {
  saveArtifact(await client.cartaCorrecaoDanfe(pedidoId, nfeId, cceId));
}
