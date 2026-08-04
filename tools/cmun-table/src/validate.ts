import { type CMunRange, IBGE_UF_CODES } from './deps';

/**
 * Validation of the production `CMUN` dump.
 *
 * The dump is the ONLY copy of this dataset — there is no CSV, JSON or seed
 * file anywhere in `.old/`, and its provenance is undocumented. So every check
 * here is deliberately fatal and prints the offending rows: a corrupt export
 * has to be caught while a corrected one can still be obtained, not after the
 * table is vendored and a wrong `<cMun>` is on a signed NF-e.
 */

/** A row exactly as the legacy `TabelaoCmun` model stored it. */
export interface CmunDumpRow {
  readonly cepInicial?: unknown;
  readonly cepFinal?: unknown;
  readonly cMun?: unknown;
  readonly nomeMunicipio?: unknown;
  readonly uf?: unknown;
}

export class CmunDumpError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    const shown = issues.slice(0, 25);
    super(
      `O dump do CMUN falhou em ${issues.length} verificação(ões):\n` +
        shown.map((issue) => `  - ${issue}`).join('\n') +
        (issues.length > shown.length ? `\n  … e mais ${issues.length - shown.length}.` : ''),
    );
    this.name = 'CmunDumpError';
    this.issues = issues;
  }
}

export interface Gap {
  readonly from: number;
  readonly to: number;
  readonly size: number;
}

export interface GapReport {
  readonly count: number;
  /** How many CEP values fall in no faixa at all, between the first and last. */
  readonly cepsUncovered: number;
  /** The widest gaps, largest first. */
  readonly largest: readonly Gap[];
}

export interface ValidateResult {
  /** Sorted by `cepInicial`, disjoint, ready for `encodeCMunTable`. */
  readonly ranges: readonly CMunRange[];
  /** Distinct 7-digit códigos represented. */
  readonly codeCount: number;
  /** Exterior rows (`uf: 'EX'` / `cMun: '9999999'`) dropped as unlookupable. */
  readonly droppedExterior: number;
  readonly gaps: GapReport;
  /** Non-fatal observations worth printing. */
  readonly warnings: readonly string[];
}

export interface ValidateOptions {
  /**
   * Enforce the "does this look like the whole of Brazil?" bands. On by default;
   * tests turn it off so they can use three-row fixtures.
   */
  readonly sanityBands?: boolean;
  /** How many gaps to include in the report. */
  readonly largestGaps?: number;
}

const MIN_CEP = 1_000_000;
const MAX_CEP = 99_999_999;

/**
 * Brazil has 5.570 municípios — a hard, known number, so this band is tight and
 * is the REAL truncation guard: a partial export loses municípios.
 */
const MIN_CODE_COUNT = 5_000;
const MAX_CODE_COUNT = 5_600;

/**
 * Faixas per município varies wildly (a small town has one, a capital has
 * dozens), so unlike the código count this is only a coarse smoke check — hence
 * the deliberately loose band. Do NOT tighten it to a guess: a guard that cries
 * wolf on a good export just gets disabled. Duplication is already caught
 * exactly by the overlap check, and truncation by the código count above.
 */
const MIN_RANGE_COUNT = 5_570;
const MAX_RANGE_COUNT = 25_000;

const VALID_UF_PREFIXES = new Set<string>(Object.values(IBGE_UF_CODES));

interface ParsedRow extends CMunRange {
  readonly nomeMunicipio: string;
  readonly uf: string;
  readonly sourceIndex: number;
}

/**
 * `cepInicial`/`cepFinal` MUST arrive as numbers. The legacy import ran
 * `int.parse` on the CSV and stored Firestore integers, so leading zeros are
 * already gone; a string-typed row would mean the dump mixed types and the
 * whole leading-zero assumption behind `Number(cep)` is void.
 */
function requireInteger(value: unknown, field: string, index: number, issues: string[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push(
      `linha ${index}: ${field} deveria ser um inteiro (o legado grava Firestore integer), ` +
        `veio ${typeof value} ${JSON.stringify(value)}`,
    );
    return Number.NaN;
  }
  return value;
}

function parseRow(raw: CmunDumpRow, index: number, issues: string[]): ParsedRow | null {
  const before = issues.length;

  const cepInicial = requireInteger(raw.cepInicial, 'cepInicial', index, issues);
  const cepFinal = requireInteger(raw.cepFinal, 'cepFinal', index, issues);

  const cMunRaw = raw.cMun;
  if (typeof cMunRaw !== 'string' || !/^\d{7}$/.test(cMunRaw)) {
    issues.push(`linha ${index}: cMun deveria ter 7 dígitos, veio ${JSON.stringify(cMunRaw)}`);
  }

  const uf = typeof raw.uf === 'string' ? raw.uf.toUpperCase() : '';
  if (!(uf in IBGE_UF_CODES)) {
    issues.push(`linha ${index}: uf desconhecida ${JSON.stringify(raw.uf)}`);
  }

  if (issues.length > before) return null;

  const cMun = cMunRaw as string;

  if (cepInicial < MIN_CEP || cepFinal > MAX_CEP) {
    issues.push(
      `linha ${index}: faixa fora dos limites de CEP [${MIN_CEP}, ${MAX_CEP}]: ` +
        `${cepInicial}-${cepFinal}`,
    );
    return null;
  }
  if (cepFinal < cepInicial) {
    issues.push(`linha ${index}: faixa invertida ${cepInicial}-${cepFinal}`);
    return null;
  }

  // THE check that catches a corrupt dump: the first 2 digits of an IBGE
  // município code are its state's code, so this cross-validates two columns
  // that were imported independently from the CSV.
  const expectedPrefix = IBGE_UF_CODES[uf as keyof typeof IBGE_UF_CODES];
  if (cMun.slice(0, 2) !== expectedPrefix) {
    issues.push(
      `linha ${index}: cMun ${cMun} não pertence à UF ${uf} ` +
        `(prefixo esperado ${expectedPrefix}, veio ${cMun.slice(0, 2)})`,
    );
    return null;
  }

  return {
    cepInicial,
    cepFinal,
    cMun: Number(cMun),
    nomeMunicipio: typeof raw.nomeMunicipio === 'string' ? raw.nomeMunicipio : '',
    uf,
    sourceIndex: index,
  };
}

function buildGapReport(rows: readonly ParsedRow[], largestGaps: number): GapReport {
  const gaps: Gap[] = [];
  let cepsUncovered = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const from = rows[i - 1]!.cepFinal + 1;
    const to = rows[i]!.cepInicial - 1;
    if (to < from) continue;
    const size = to - from + 1;
    cepsUncovered += size;
    gaps.push({ from, to, size });
  }

  return {
    count: gaps.length,
    cepsUncovered,
    largest: [...gaps].sort((a, b) => b.size - a.size).slice(0, largestGaps),
  };
}

/**
 * Validate + normalize a `CMUN` dump into encodable ranges.
 *
 * Throws {@link CmunDumpError} listing every problem found, rather than the
 * first — one run should tell you everything wrong with the export.
 */
export function validateDump(
  rows: readonly CmunDumpRow[],
  options: ValidateOptions = {},
): ValidateResult {
  const sanityBands = options.sanityBands ?? true;
  const largestGaps = options.largestGaps ?? 20;

  const issues: string[] = [];
  const warnings: string[] = [];

  const parsed: ParsedRow[] = [];
  let droppedExterior = 0;

  rows.forEach((raw, index) => {
    // Exterior rows describe no CEP faixa anyone can look up. Drop them
    // explicitly (and report the count) rather than letting '99…' codes sit in
    // a table whose only job is CEP → município.
    if (raw.uf === 'EX' || raw.cMun === '9999999') {
      droppedExterior += 1;
      return;
    }
    const row = parseRow(raw, index, issues);
    if (row) parsed.push(row);
  });

  // Sort before the overlap check — the dump's document order is arbitrary
  // (the legacy seed used Firestore auto-ids).
  parsed.sort((a, b) => a.cepInicial - b.cepInicial || a.cepFinal - b.cepFinal);

  for (let i = 1; i < parsed.length; i += 1) {
    const previous = parsed[i - 1]!;
    const current = parsed[i]!;
    if (current.cepInicial <= previous.cepFinal) {
      issues.push(
        `faixas sobrepostas: ${previous.cepInicial}-${previous.cepFinal} (${previous.cMun}, ` +
          `linha ${previous.sourceIndex}) e ${current.cepInicial}-${current.cepFinal} ` +
          `(${current.cMun}, linha ${current.sourceIndex})`,
      );
    }
  }

  const codes = new Set(parsed.map((row) => row.cMun));

  if (sanityBands) {
    if (parsed.length < MIN_RANGE_COUNT || parsed.length > MAX_RANGE_COUNT) {
      issues.push(
        `total de faixas fora da banda esperada [${MIN_RANGE_COUNT}, ${MAX_RANGE_COUNT}]: ` +
          `${parsed.length} — o export parece truncado ou duplicado`,
      );
    }
    if (codes.size < MIN_CODE_COUNT || codes.size > MAX_CODE_COUNT) {
      issues.push(
        `municípios distintos fora da banda esperada [${MIN_CODE_COUNT}, ${MAX_CODE_COUNT}]: ` +
          `${codes.size} (o Brasil tem 5.570)`,
      );
    }
  }

  if (issues.length > 0) throw new CmunDumpError(issues);

  // Non-fatal: the same município spelled two ways across its faixas. Harmless
  // today (nothing reads the name) but a tell that the CSV had dirty rows.
  const nameByCode = new Map<number, string>();
  const conflicting = new Set<number>();
  for (const row of parsed) {
    if (row.nomeMunicipio === '') continue;
    const seen = nameByCode.get(row.cMun);
    if (seen === undefined) nameByCode.set(row.cMun, row.nomeMunicipio);
    else if (seen !== row.nomeMunicipio) conflicting.add(row.cMun);
  }
  if (conflicting.size > 0) {
    warnings.push(
      `${conflicting.size} município(s) com nomeMunicipio divergente entre suas faixas ` +
        `(ex.: ${[...conflicting].slice(0, 5).join(', ')})`,
    );
  }
  if (droppedExterior > 0) {
    warnings.push(`${droppedExterior} linha(s) de exterior (uf=EX / cMun=9999999) descartada(s)`);
  }

  return {
    ranges: parsed.map(({ cepInicial, cepFinal, cMun }) => ({ cepInicial, cepFinal, cMun })),
    codeCount: codes.size,
    droppedExterior,
    gaps: buildGapReport(parsed, largestGaps),
    warnings,
  };
}

/** Human-readable gap report — goes in the vendoring PR body. */
export function formatGapReport(gaps: GapReport): string {
  if (gaps.count === 0) return 'Nenhum buraco entre as faixas.';
  const lines = gaps.largest.map(
    (gap) =>
      `  ${String(gap.from).padStart(8, '0')}–${String(gap.to).padStart(8, '0')}  ` +
      `(${gap.size.toLocaleString('pt-BR')} CEPs)`,
  );
  return (
    `${gaps.count.toLocaleString('pt-BR')} buraco(s) entre faixas, ` +
    `${gaps.cepsUncovered.toLocaleString('pt-BR')} CEPs sem faixa.\n` +
    `Maiores:\n${lines.join('\n')}`
  );
}
