/**
 * The `<det>` lines of an authorized NF-e (`nfev4.xml_nfe_proc`) — what a
 * devolução reads to point each of its items at the origin's `det/@nItem`
 * (NT 2025.002 VC02-14, cStat 321, #1683).
 *
 * ## Why the XML, and not the origin pedido
 *
 * `nItem` is a POSITION fixed at emission time, and nothing that survives the
 * emission can recompute it. This app numbers the dets by `naOrdemDoPedido`
 * over the pedido as it stood when the nota was generated; the legacy Flutter
 * app numbered its own flattened list (an unstable sort) and coded `cProd` as
 * `sku ?? gtin ?? produtoUid`. A pedido edited after its nota, a migrated
 * legacy pedido, or two lines with equal `ordem` all number differently today.
 * The authorized XML is the only record of what SEFAZ was told, and a
 * devolução already holds it: `listNFesAprovadas` returns the whole `nfev4`
 * doc, so reading it costs no Firestore read.
 *
 * ## Pure, total, browser-safe — so a regex, not a DOM
 *
 * Both halves need it: `packages/data` (the devolução seed, which runs in the
 * browser and cannot import `@delfrance/integrations-nfe`) and the Fiscal
 * tab. `DOMParser` is browser-only and `@xmldom/xmldom` is server-only, so it
 * reads the way `extractTpAmb` (`nfeEnvioCanal.ts`) and the integrations
 * package's `extrairTotaisNFe` already do. The fields it reads are flat,
 * single-occurrence leaves of `<prod>`.
 *
 * ⚠️ **All or nothing.** It returns `null` — never a partial list — when any
 * line cannot be read. A list missing one det would hand the next line's
 * number to the wrong item, and SEFAZ does not check that a referenced `nItem`
 * exists in the referenced nota, so the mistake would be authorized silently.
 * `null` sends the operator to the Fiscal tab instead.
 */
import { parseWireDecimal } from '@delfrance/core/wire';

/** One `<det>` of an authorized nota, as a devolução needs it. */
export interface ItemDoProc {
  /** `det/@nItem` — 1 to 990. */
  readonly nItem: number;
  /** `det/prod/cProd`, XML entities decoded. */
  readonly cProd: string;
  /** `det/prod/xProd`, XML entities decoded. */
  readonly xProd: string;
  /** `det/prod/uCom`. */
  readonly uCom: string;
  /** `det/prod/qCom`. */
  readonly qCom: number;
  /** `det/prod/vUnCom` — the gross unit price (the discount rides in `vDesc`). */
  readonly vUnCom: number;
}

/** An element prefix, tolerated: NF-e declares a default namespace, but a prefixed document is still valid XML. */
const PREFIXO = '(?:[\\w.-]+:)?';

/** The inner text of the first `<tag>…</tag>` in `escopo`, or null when absent. */
function elemento(escopo: string, tag: string): string | null {
  const re = new RegExp(`<${PREFIXO}${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${PREFIXO}${tag}>`);
  return re.exec(escopo)?.[1] ?? null;
}

const ENTIDADES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode the XML entities a leaf can carry. A `cProd` of `A&B` is serialized
 * `A&amp;B`, and comparing the escaped form against a sku would never match.
 * An unknown named entity leaves the text unreadable (`null`), never guessed.
 */
function decodificar(bruto: string): string | null {
  let ilegivel = false;
  const texto = bruto.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (inteiro, corpo: string) => {
    if (corpo.startsWith('#')) {
      const ponto = corpo.startsWith('#x')
        ? Number.parseInt(corpo.slice(2), 16)
        : Number.parseInt(corpo.slice(1), 10);
      // `fromCodePoint` THROWS past U+10FFFF — this reader is total, so it is unreadable instead.
      if (ponto > 0x10ffff) {
        ilegivel = true;
        return inteiro;
      }
      return String.fromCodePoint(ponto);
    }
    const named = ENTIDADES[corpo];
    if (named === undefined) ilegivel = true;
    return named ?? inteiro;
  });
  return ilegivel ? null : texto;
}

function textoDe(escopo: string, tag: string): string | null {
  const bruto = elemento(escopo, tag);
  if (bruto === null) return null;
  const texto = decodificar(bruto.trim());
  return texto === null || texto === '' ? null : texto;
}

/** `<det …>` openings, any attributes — never `<detPag>` / `<detExport>` (no whitespace after `det`). */
const ABERTURA_DET = new RegExp(`<${PREFIXO}det[\\s>]`, 'g');
const DET = new RegExp(`<${PREFIXO}det(\\s[^>]*)?>([\\s\\S]*?)</${PREFIXO}det>`, 'g');
const ATRIBUTO_NITEM = /\snItem\s*=\s*(["'])(\d+)\1/;

/**
 * The `<det>` lines of an `<nfeProc>` / `<NFe>` XML, in document order, or
 * `null` when the document is absent or ANY line is unreadable — see the module
 * header for why it is never partial.
 */
export function lerItensDoProc(xml: unknown): ItemDoProc[] | null {
  if (typeof xml !== 'string' || xml.length === 0) return null;
  // ⚠️ Scope first: the dets live in `<infNFe>`; nothing outside it is a line.
  const infNFe = elemento(xml, 'infNFe');
  if (infNFe === null) return null;

  const itens: ItemDoProc[] = [];
  const vistos = new Set<number>();
  for (const [, atributos = '', corpo = ''] of infNFe.matchAll(DET)) {
    const nItemBruto = ATRIBUTO_NITEM.exec(atributos)?.[2];
    const nItem = nItemBruto === undefined ? Number.NaN : Number(nItemBruto);
    if (!Number.isInteger(nItem) || nItem < 1 || nItem > 990 || vistos.has(nItem)) return null;
    vistos.add(nItem);

    const prod = elemento(corpo, 'prod');
    if (prod === null) return null;
    const cProd = textoDe(prod, 'cProd');
    const xProd = textoDe(prod, 'xProd');
    const uCom = textoDe(prod, 'uCom');
    const qCom = parseWireDecimal(textoDe(prod, 'qCom'));
    const vUnCom = parseWireDecimal(textoDe(prod, 'vUnCom'));
    if (cProd === null || xProd === null || uCom === null || qCom === null || vUnCom === null) {
      return null;
    }
    itens.push({ nItem, cProd, xProd, uCom, qCom, vUnCom });
  }

  // Every `<det` opening must have become a line: a det the pattern above could
  // not close (or one with no attributes at all) would otherwise vanish.
  const aberturas = infNFe.match(ABERTURA_DET)?.length ?? 0;
  if (itens.length === 0 || itens.length !== aberturas) return null;
  return itens;
}
