/**
 * Orientation-independent helpers shared by the two A4 DANFE renderers
 * (`retrato` + `paisagem`): the INFORMAÇÕES COMPLEMENTARES composition, the
 * lossless height-aware text split that paginates a long `infCpl` across pages,
 * the produtos row paginator, and the page watermark.
 *
 * Retrato and paisagem differ only in page geometry (portrait 21×29.7 vs
 * landscape 29.7×21) and the per-block coordinates; this is the common core they
 * both call, so the splitting/pagination logic lives in exactly one place.
 */
import type { DanfeModel } from '../model';
import { formatDate, formatTimeSeconds } from '../format';
import { cm } from './layout';
import { FONT, type Doc, watermark } from './primitives';

export interface RenderA4Options {
  readonly cancelada?: boolean;
}

/** Human label for each contingency `tpEmis` (MOC Anexo III). */
const TPEMIS_CONTINGENCIA: Record<string, string> = {
  '2': 'FS-IA',
  '4': 'EPEC',
  '5': 'FS-DA',
  '6': 'SVC-AN',
  '7': 'SVC-RS',
  '9': 'OFF-LINE',
};

/**
 * The mandatory contingency note for a tpEmis ≠ 1 NF-e — `dhCont` + `xJust`
 * must be printed on the DANFE (MOC Anexo III). Returns `null` for normal
 * emission.
 */
export function contingencyNote(model: DanfeModel): string | null {
  const { tpEmis, dhCont, xJust } = model.ide;
  if (tpEmis === '1') return null;
  const label = TPEMIS_CONTINGENCIA[tpEmis] ?? `tpEmis ${tpEmis}`;
  const when = dhCont ? ` Início: ${formatDate(dhCont)} ${formatTimeSeconds(dhCont)}.` : '';
  const why = xJust ? ` Justificativa: ${xJust}.` : '';
  return `EMISSÃO EM CONTINGÊNCIA (${label}).${when}${why}`;
}

/**
 * Compose the INFORMAÇÕES COMPLEMENTARES text: the contingency note (when the
 * NF-e was emitted with tpEmis ≠ 1), the contribuinte's `infCpl`, then the
 * referenced NF-e chaves (`NFref. {chave}`), mirroring the legacy layout.
 * `infAdFisco` does NOT belong here — it goes to RESERVADO AO FISCO.
 */
export function composeInfoComplementares(model: DanfeModel): string {
  const parts: string[] = [];
  const contingency = contingencyNote(model);
  if (contingency) parts.push(contingency);
  if (model.infAdic.infCpl) parts.push(model.infAdic.infCpl);
  for (const chave of model.ide.refNFes) parts.push(`NFref. ${chave}`);
  return parts.join(' ');
}

export interface SplitResult {
  /** The leading slice that fits the available box on this page. */
  readonly chunk: string;
  /** The box height (cm) to draw, clamped to `[minBoxCm, available]`. */
  readonly boxHCm: number;
  /** The remainder to carry to the next page (empty when nothing spilled). */
  readonly rest: string;
}

export interface SplitOptions {
  /** Minimum box height (cm) — the dados box never shrinks below this. */
  readonly minBoxCm: number;
  /** Points reserved inside the box for its label + padding. */
  readonly labelPadPt: number;
  /** Body font size (default 6 pt, as the legacy layout). */
  readonly fontSize?: number;
}

/**
 * Split `str` so the leading chunk fits `availBoxPt` (box height in points,
 * minus the label/padding) for the INFORMAÇÕES COMPLEMENTARES box. Returns the
 * chunk, the box height to use (clamped to `[minBoxCm, avail]`), and the rest.
 * Lossless: `chunk + rest` reconstruct the text (modulo the boundary space), so
 * nothing is ever clipped — overflow paginates to the next page instead.
 */
export function measureSplit(
  doc: Doc,
  str: string,
  widthPt: number,
  availBoxPt: number,
  opts: SplitOptions,
): SplitResult {
  const { minBoxCm, labelPadPt, fontSize = 6 } = opts;
  const minPt = cm(minBoxCm);
  if (!str) return { chunk: '', boxHCm: minBoxCm, rest: '' };
  doc.font(FONT).fontSize(fontSize);
  const textAvail = availBoxPt - labelPadPt;
  const fullH = doc.heightOfString(str, { width: widthPt });
  if (fullH <= textAvail) {
    const boxHPt = Math.max(minPt, fullH + labelPadPt);
    return { chunk: str, boxHCm: boxHPt / cm(1), rest: '' };
  }
  // Largest prefix whose wrapped height fits the available text height.
  let lo = 1;
  let hi = str.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.heightOfString(str.slice(0, mid), { width: widthPt }) <= textAvail) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const sp = str.lastIndexOf(' ', best);
  const cut = sp > best * 0.6 ? sp : best; // prefer a word boundary when close
  return {
    chunk: str.slice(0, cut).trimEnd(),
    boxHCm: availBoxPt / cm(1),
    rest: str.slice(cut).trimStart(),
  };
}

/**
 * Split N item rows across pages, reserving footer room. Every returned slice is
 * ≥ 1 (for n ≥ 1) and the slices sum to n — no page can end up with 0 rows
 * (which would render an empty table header and push the footer onto a blank
 * page).
 */
export function paginate(
  n: number,
  rowsFirstFull: number,
  rowsFirstLast: number,
  rowsOtherFull: number,
  rowsOtherLast: number,
): number[] {
  if (n <= rowsFirstLast) return [Math.max(n, 0)];
  // More than one page. Page 1 takes a full page but always leaves ≥1 row for a
  // later (last) page, so no page can end up with 0 rows.
  const first = Math.min(rowsFirstFull, n - 1);
  const pages = [first];
  let rem = n - first;
  while (rem > rowsOtherLast) {
    const take = Math.min(rowsOtherFull, rem - 1);
    pages.push(take);
    rem -= take;
  }
  pages.push(rem);
  return pages;
}

/**
 * Stamp the diagonal translucent watermark when the NF-e is homologação
 * ("SEM VALOR FISCAL") or cancelada ("CANCELADO"). `pageWPt`/`pageHPt` are the
 * page dimensions in points, so the same helper serves portrait and landscape.
 */
export function pageWatermark(
  doc: Doc,
  model: DanfeModel,
  cancelada: boolean,
  pageWPt: number,
  pageHPt: number,
): void {
  if (model.homologacao) watermark(doc, 'SEM VALOR FISCAL', pageWPt, pageHPt);
  else if (cancelada) watermark(doc, 'CANCELADO', pageWPt, pageHPt);
}
