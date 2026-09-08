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
 * 2. a historical backfill, once one is written and scheduled for the migration
 *    window (#1491) — no such script exists under `tools/migrations` yet;
 * 3. eventually `apps/web/lib/nfe/export/parseNfeReportRow.ts`, which still
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
 * ⚠️ **A silent zero is as bad as a silent miss, and it cuts BOTH ways.** The
 * block is all-or-nothing precisely because a component that quietly becomes
 * `0` still leaves the note looking readable, so the unreadable-note counter
 * the apuração will keep (#1491) never sees it. Which way the total then moves
 * depends on the component: losing `vDesc` (subtracted) overstates receita
 * bruta and over-declares; losing `vFrete`/`vSeg`/`vOutro` (added) understates
 * it and UNDER-declares. Hence `decimalOpcional` below distinguishes an absent
 * tag from an unparseable one — the first is zero, the second is `null`.
 *
 * ⚠️ **Scope before you match.** `vProd` and `vDesc` also appear on EVERY item
 * under `<det><prod>`, and a document-wide match returns the FIRST ITEM's value
 * instead of the note total — a number that is not obviously wrong, on a
 * single-item note is not wrong at all, and silently understates every
 * multi-item note. So `<ICMSTot>` is sliced out first and every read is scoped
 * to that slice. The same hazard is documented in `parseNfeReportRow.ts`.
 */
import { roundReais } from '@delfrance/core/money';
import type { NFeTotais, NFeTotaisRtc } from '@delfrance/schemas';

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

/**
 * An optional `<vXxx>`: **absent** means the note carries none of that value
 * (`0`); **present but unparseable** means we cannot read this note at all
 * (`null`).
 *
 * ⚠️ The two must not collapse into `0`. A malformed value folded to zero
 * leaves the block looking COMPLETE, so the planned unreadable-note counter
 * (#1491) never sees it — and
 * the error's DIRECTION depends on which component was lost: a dropped `vDesc`
 * overstates receita bruta (higher faixa, over-declared), while a dropped
 * `vFrete`/`vSeg`/`vOutro` understates it (lower faixa, under-declared).
 * Either way the apuração reports success on a number it silently got wrong,
 * which is the exact failure the all-or-nothing rule above exists to prevent.
 */
function decimalOpcional(escopo: string, tag: string): number | null {
  const bruto = texto(escopo, tag);
  // Absent, or an empty `<vST></vST>` — the note simply carries none of it.
  if (bruto === null || bruto === '') return 0;
  // Present: it must parse, or this note is not readable.
  return decimal(escopo, tag);
}

/** Separates "no RTC group here" (`null`) from "present but unreadable". */
const POISON = Symbol('rtc-ilegivel');

/**
 * `<IBSCBSTot>` / `<ISTot>` / `<vNFTot>` — the NT 2025.002 totals, siblings of
 * `<ICMSTot>` inside `<total>`.
 *
 * ⚠️ Captured here rather than "later" for the reason the whole block exists:
 * a note emitted with RTC on stores a `vNF` that is NOT its own grand total
 * (`vNFTot` is — `ICMSTot.vNF` deliberately excludes the por-fora tributes, see
 * `tribute/total.ts`), so leaving these out would need a second pass over every
 * RTC-era note.
 *
 * ⚠️ `vIBS`/`vCBS` also appear on each item's own RTC group, so they are read
 * from the `<IBSCBSTot>` slice — the same scoping hazard as `vProd`. `<ISTot>`
 * is omitted outright when there is no Imposto Seletivo, so absent is `0`.
 */
function extrairRtc(total: string): NFeTotaisRtc | null | typeof POISON {
  const ibsCbsTot = elemento(total, 'IBSCBSTot');
  if (ibsCbsTot === null) return null; // not an RTC emission — a correct absence

  const vBCIBSCBS = decimal(ibsCbsTot, 'vBCIBSCBS');
  const vIBS = decimal(ibsCbsTot, 'vIBS');
  const vCBS = decimal(ibsCbsTot, 'vCBS');
  const vNFTot = decimal(total, 'vNFTot');
  const isTot = elemento(total, 'ISTot');
  const vIS = isTot === null ? 0 : decimal(isTot, 'vIS');

  if (vBCIBSCBS === null || vIBS === null || vCBS === null || vNFTot === null || vIS === null) {
    return POISON;
  }
  return { vBCIBSCBS, vIBS, vCBS, vIS, vNFTot };
}

/**
 * Parse the totals out of an `<nfeProc>` / `<NFe>` XML string.
 *
 * Returns `null` — never a partial block — when the document does not carry
 * what a revenue figure needs. `null` is a legible state the apuração planned
 * in #1491 will be able to count; a half-filled block would be counted as
 * readable and silently understate the month. See {@link NFeTotais}.
 */
export function extrairTotaisNFe(xml: string): NFeTotais | null {
  if (typeof xml !== 'string' || xml.length === 0) return null;

  // ⚠️ Scope first — see the module header. `<det><prod>` and the per-item RTC
  // groups carry fields named exactly like the totals, so every read below is
  // scoped to `<total>` and then to the group that owns the value.
  const total = elemento(xml, 'total');
  const ide = elemento(xml, 'ide');
  if (total === null || ide === null) return null;
  const icmsTot = elemento(total, 'ICMSTot');
  if (icmsTot === null) return null;

  const vProd = decimal(icmsTot, 'vProd');
  const vNF = decimal(icmsTot, 'vNF');
  const vDesc = decimalOpcional(icmsTot, 'vDesc');
  const vST = decimalOpcional(icmsTot, 'vST');
  const vIPI = decimalOpcional(icmsTot, 'vIPI');
  const vFrete = decimalOpcional(icmsTot, 'vFrete');
  const vSeg = decimalOpcional(icmsTot, 'vSeg');
  const vOutro = decimalOpcional(icmsTot, 'vOutro');
  const tpNFbruto = texto(ide, 'tpNF');
  const finNFebruto = texto(ide, 'finNFe');

  // ⚠️ ONE all-or-nothing guard, covering EVERY component — not just the two
  // that decide whether this is revenue. A component that is present and
  // unreadable makes the whole note uncountable; only an ABSENT one is zero
  // (see `decimalOpcional`). Splitting this into "important" and "the rest" is
  // what let a malformed `vST` through while the block still read as complete.
  if (
    vProd === null ||
    vNF === null ||
    vDesc === null ||
    vST === null ||
    vIPI === null ||
    vFrete === null ||
    vSeg === null ||
    vOutro === null ||
    tpNFbruto === null ||
    finNFebruto === null
  ) {
    return null;
  }

  if (tpNFbruto !== '0' && tpNFbruto !== '1') return null;
  if (!['1', '2', '3', '4'].includes(finNFebruto)) return null;

  // Reforma Tributária (NT 2025.002). `<IBSCBSTot>` is emitted only when the
  // filial has `emitirReformaTributaria` on, so its ABSENCE is the ordinary
  // case and means `null`, never zero. When it IS present the same
  // all-or-nothing rule applies.
  const rtc = extrairRtc(total);
  if (rtc === POISON) return null;

  return {
    vProd,
    vDesc,
    vST,
    vIPI,
    vFrete,
    vSeg,
    vOutro,
    vNF,
    tpNF: Number(tpNFbruto) as NFeTotais['tpNF'],
    finNFe: Number(finNFebruto) as NFeTotais['finNFe'],
    rtc,
  };
}
