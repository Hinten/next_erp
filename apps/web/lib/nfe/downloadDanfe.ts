/**
 * Download a DANFE artifact from `apps/nfe` and save it to disk.
 *
 * The PDF (`simplificado`) and the ZPL label (`zpl2`) both come back as a Blob
 * with a server-provided filename (`Content-Disposition`); this triggers a
 * browser download via a transient object URL. The web bundle never imports the
 * pdfkit/bwip-js renderers — only this thin HTTP path.
 */
import type { NFeDanfeFormat, NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

/** Fetch + save the DANFE for an NF-e. Throws the client's typed HTTP errors. */
export async function downloadDanfe(
  client: NFeHttpClient,
  pedidoId: string,
  nfeId: string,
  format: NFeDanfeFormat,
): Promise<void> {
  const artifact = await client.danfe(pedidoId, nfeId, format);
  const url = URL.createObjectURL(artifact.blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
