/**
 * Browser-safe procNFe field extractor for the CSV report (#11).
 *
 * The authoritative parser (`parseProcNFe`, `@delfrance/integrations-nfe`) is
 * server-only — its kitchen-sink subpath pulls `node:fs`/`soap`/`xmllint-wasm`
 * and would break the web bundle. The report needs only ~9 scalar fields, so we
 * read them with the native `DOMParser`. NF-e XML declares a single default
 * namespace with **no element prefixes**, so `getElementsByTagName('vProd')`
 * matches by local name directly.
 *
 * Reads are scoped to the element that uniquely owns each field to avoid
 * collisions: `xNome` also appears under `<emit>`/`<transporta>`, and `vProd`/
 * `vDesc` also appear per item under `<det><prod>` — so the totals are read from
 * `<ICMSTot>`, the buyer from `<dest>`, the header from `<ide>`.
 */

export interface NfeReportRow {
  readonly natOp: string;
  /** `'0'` = entrada, `'1'` = saída, `''` = unknown. */
  readonly tpNF: string;
  readonly finNFe: string;
  readonly destNome: string;
  readonly destUF: string;
  readonly vProd: string;
  readonly vFrete: string;
  readonly vDesc: string;
  readonly vNF: string;
}

function firstText(scope: Element | null, tag: string): string {
  if (!scope) return '';
  const el = scope.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? '';
}

/** Parse a procNFe (`<nfeProc>`/`<NFe>`) XML string into the report columns. */
export function parseNfeReportRow(xml: string): NfeReportRow {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const infNFe = doc.getElementsByTagName('infNFe')[0] ?? null;
  if (!infNFe) {
    throw new Error('procNFe inválido: elemento <infNFe> ausente');
  }
  const ide = infNFe.getElementsByTagName('ide')[0] ?? null;
  const dest = infNFe.getElementsByTagName('dest')[0] ?? null;
  const enderDest = dest?.getElementsByTagName('enderDest')[0] ?? null;
  const icmsTot = infNFe.getElementsByTagName('ICMSTot')[0] ?? null;

  return {
    natOp: firstText(ide, 'natOp'),
    tpNF: firstText(ide, 'tpNF'),
    finNFe: firstText(ide, 'finNFe'),
    destNome: firstText(dest, 'xNome'),
    destUF: firstText(enderDest, 'UF'),
    vProd: firstText(icmsTot, 'vProd'),
    vFrete: firstText(icmsTot, 'vFrete'),
    vDesc: firstText(icmsTot, 'vDesc'),
    vNF: firstText(icmsTot, 'vNF'),
  };
}
