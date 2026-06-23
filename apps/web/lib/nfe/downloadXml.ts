/**
 * Download an NF-e XML straight from the nfev4 document already in hand.
 *
 * Unlike the DANFE (rendered server-side in `apps/nfe`), the XML is persisted
 * on the NF-e doc itself — `xml_nfe_proc` (the nfeProc carrying the SEFAZ
 * authorization protocol), `xml_epec_proc` (the EPEC proc) or, before the
 * transmission lands, `xml_assinado` (the signed-but-not-yet-protocoled NF-e).
 * So the download is a pure client-side blob, no HTTP round-trip.
 */
import type { NotaFiscalEletronica } from '@delfrance/schemas';

/**
 * Pick the most authoritative XML available on the doc: the authorized
 * procNFe first, then the EPEC proc, then the signed anchor. Returns `null`
 * when none is present (no XML has been produced yet).
 */
export function selectNfeXml(nfe: NotaFiscalEletronica): string | null {
  return nfe.xml_nfe_proc ?? nfe.xml_epec_proc ?? nfe.xml_assinado ?? null;
}

/**
 * Trigger a browser download of the NF-e XML via a transient object URL.
 * No-op when the doc carries no XML. Names the file by the chave de acesso
 * when present (the SEFAZ convention), falling back to the NF-e número.
 */
export function downloadNfeXml(nfe: NotaFiscalEletronica): void {
  const xml = selectNfeXml(nfe);
  if (xml == null) return;
  const filename = `${nfe.chave ?? `nfe-${nfe.numeracao}`}.xml`;
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
