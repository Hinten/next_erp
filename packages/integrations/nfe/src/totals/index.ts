/**
 * `<ICMSTot>` → modeled numbers. The one place this repo turns an authorized
 * NF-e XML into the totals a Firestore aggregate can read (#1491).
 *
 * ## Browser-safe, and that is the point
 *
 * Three callers need exactly this fold and must not disagree:
 *
 * 1. the emitter (`apps/nfe/lib/nfe/orchestrator/audit.ts`), stamping `totais`
 *    in the same write that persists `xml_nfe_proc`;
 * 2. the backfill (`tools/migrations/src/2026-09-nfe-totais`), reading the same
 *    field out of historical documents;
 * 3. eventually `apps/web/lib/nfe/export/parseNfeReportRow.ts`, which today
 *    hand-rolls the same parse with `DOMParser` for the CSV report.
 *
 * A second copy of a rule like this drifts *toward plausible* — it keeps
 * looking right while disagreeing — so there is one implementation, and it
 * carries no server-only dependency in order to stay reachable from the
 * browser bundle. It is re-exported from `src/http-provider/index.ts` per the
 * playbook in this package's `CLAUDE.md`; do not reach for `@xmldom/xmldom` or
 * `parseProcNFe` here, both of which drag `node:fs` into Turbopack.
 *
 * ## Why regex rather than a DOM
 *
 * The fields are flat, single-occurrence scalars inside one element, and this
 * codebase already reads `nProt` out of `xml_nfe_proc` the same way
 * (`apps/nfe/lib/nfe/orchestrator/cancelar.ts`). `DOMParser` is browser-only
 * and `@xmldom/xmldom` is not browser-safe, so a regex is what both halves can
 * actually run.
 *
 * ⚠️ **Scope before you match.** `vProd` and `vDesc` also appear on EVERY item
 * under `<det><prod>`, and a document-wide match returns the FIRST ITEM's value
 * instead of the note total — a number that is not obviously wrong, on a
 * single-item note is not wrong at all, and silently understates every
 * multi-item note. So `<ICMSTot>` is sliced out first and every read is scoped
 * to that slice. The same hazard is documented in `parseNfeReportRow.ts`.
 */
import { roundReais } from '@delfrance/core/money';
import type { NFeTotais } from '@delfrance/schemas';

/**
 * Slice out the inner text of the first `<tag>…</tag>`, tolerating a namespace
 * prefix. NF-e declares a default namespace with no element prefixes, but a
 * prefixed document is still valid XML and costs nothing to accept.
 */
function elemento(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  return re.exec(xml)?.[1] ?? null;
}

/** Inner text of a leaf `<tag>` within an already-scoped slice. */
function texto(escopo: string, tag: string): string | null {
  const bruto = elemento(escopo, tag);
  return bruto === null ? null : bruto.trim();
}

/**
 * A wire decimal → reais. Wire decimals are ALWAYS dot-separated (see
 * `@delfrance/core/wire`); a comma here would mean the string is not what we
 * think it is, so it is rejected rather than coerced.
 *
 * `roundReais` is applied because it is this repo's canonical money rounding —
 * SEFAZ sends two decimals, so it is a no-op on well-formed input and a
 * consistent answer on anything else.
 */
function decimal(escopo: string, tag: string): number | null {
  const bruto = texto(escopo, tag);
  if (bruto === null || bruto === '') return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(bruto)) return null;
  const n = Number(bruto);
  return Number.isFinite(n) ? roundReais(n) : null;
}

/** An absent optional `<vXxx>` means the note carries none of that value. */
function decimalOuZero(escopo: string, tag: string): number {
  return decimal(escopo, tag) ?? 0;
}

/**
 * Parse the totals out of an `<nfeProc>` / `<NFe>` XML string.
 *
 * Returns `null` — never a partial block — when the document does not carry
 * what a revenue figure needs. `null` is a legible state that the apuração
 * counts and reports (`notasSemTotais`); a half-filled block would be counted
 * as readable and silently understate the month. See {@link NFeTotais}.
 */
export function extrairTotaisNFe(xml: string): NFeTotais | null {
  if (typeof xml !== 'string' || xml.length === 0) return null;

  // ⚠️ Scope first — see the module header. `<ICMSTot>` is the note total;
  // `<det><prod>` carries same-named per-item fields.
  const icmsTot = elemento(xml, 'ICMSTot');
  const ide = elemento(xml, 'ide');
  if (icmsTot === null || ide === null) return null;

  const vProd = decimal(icmsTot, 'vProd');
  const vNF = decimal(icmsTot, 'vNF');
  const tpNFbruto = texto(ide, 'tpNF');
  const finNFebruto = texto(ide, 'finNFe');
  // The four that decide whether this is revenue, and how much. Missing any of
  // them makes the note uncountable, not zero.
  if (vProd === null || vNF === null || tpNFbruto === null || finNFebruto === null) return null;

  if (tpNFbruto !== '0' && tpNFbruto !== '1') return null;
  if (!['1', '2', '3', '4'].includes(finNFebruto)) return null;

  return {
    vProd,
    vDesc: decimalOuZero(icmsTot, 'vDesc'),
    vST: decimalOuZero(icmsTot, 'vST'),
    vIPI: decimalOuZero(icmsTot, 'vIPI'),
    vFrete: decimalOuZero(icmsTot, 'vFrete'),
    vSeg: decimalOuZero(icmsTot, 'vSeg'),
    vOutro: decimalOuZero(icmsTot, 'vOutro'),
    vNF,
    tpNF: Number(tpNFbruto) as NFeTotais['tpNF'],
    finNFe: Number(finNFebruto) as NFeTotais['finNFe'],
  };
}
