import { MICROS_LOWER_BOUND, MILLIS_UPPER_BOUND, coerceToMicros } from '@delfrance/core/datetime';

/**
 * Pre-flight shape report for the µs backfill: what is ACTUALLY stored in each
 * datetime field, counted, before anyone runs `--apply`.
 *
 * A dry-run answers "what would I change?" — which is only the subset the
 * transform already knows how to handle. This answers the prior question: "what
 * shapes are in this corpus at all?" The two rows that decide whether the
 * backfill is safe to run are {@link ShapeBucket} `timestamp-ou-outro` and
 * `zona-morta`, both of which `coerceToMicros` refuses, so the migration SKIPS
 * them and they would stay wrong forever.
 */

export type ShapeBucket =
  /** Absent or null — nothing to convert. */
  | 'ausente'
  /** Already microseconds (>= 1e14). Idempotent no-op. */
  | 'micros'
  /** Millisecond int (<= 9e12) — the legacy Flutter wire format for pedido/frete. */
  | 'millis'
  /** ISO-8601 string — the legacy Flutter wire format for pagamento. */
  | 'iso-string'
  /** A string that is not a parseable date. */
  | 'string-invalida'
  /**
   * A number in the undeterminable gap `(9e12, 1e14)` — year 2255-5138 read as
   * ms, or 1970-1973 read as µs. Unreachable by real ERP data, so a hit here
   * means something else wrote the field.
   */
  | 'zona-morta'
  /**
   * ⚠️ The row that stops the run. A firebase-admin `Timestamp` is NOT
   * `instanceof Date`, so `coerceToMicros` returns null, the migration skips it,
   * and the value stays in a format nothing else in the repo reads. Same for any
   * other unexpected type. A non-zero count means extend the converter first.
   */
  | 'timestamp-ou-outro';

export interface ShapeStats {
  counts: Record<ShapeBucket, number>;
  /** Min/max of the CONVERTED µs value, so an implausible date is visible. */
  minUs: number | null;
  maxUs: number | null;
  /** Digit lengths seen for numeric values — the eyeball check: 13 = ms, 16 = µs. */
  digitos: Record<number, number>;
}

export function emptyStats(): ShapeStats {
  return {
    counts: {
      ausente: 0,
      micros: 0,
      millis: 0,
      'iso-string': 0,
      'string-invalida': 0,
      'zona-morta': 0,
      'timestamp-ou-outro': 0,
    },
    minUs: null,
    maxUs: null,
    digitos: {},
  };
}

export function classify(value: unknown): ShapeBucket {
  if (value == null) return 'ausente';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'timestamp-ou-outro';
    if (value >= MICROS_LOWER_BOUND) return 'micros';
    if (value <= MILLIS_UPPER_BOUND) return 'millis';
    return 'zona-morta';
  }
  if (typeof value === 'string') {
    return Number.isNaN(Date.parse(value)) ? 'string-invalida' : 'iso-string';
  }
  if (value instanceof Date) return 'iso-string';
  // A firebase-admin `Timestamp`, a map, an array — anything the converter
  // refuses. This is the bucket that must read 0 before `--apply`.
  return 'timestamp-ou-outro';
}

export function record(stats: ShapeStats, value: unknown): void {
  const bucket = classify(value);
  stats.counts[bucket] += 1;
  if (bucket === 'ausente') return;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = String(Math.trunc(Math.abs(value))).length;
    stats.digitos[d] = (stats.digitos[d] ?? 0) + 1;
  }

  const us = coerceToMicros(value);
  if (us == null) return;
  if (stats.minUs == null || us < stats.minUs) stats.minUs = us;
  if (stats.maxUs == null || us > stats.maxUs) stats.maxUs = us;
}

const ORDEM: readonly ShapeBucket[] = [
  'micros',
  'millis',
  'iso-string',
  'zona-morta',
  'string-invalida',
  'timestamp-ou-outro',
  'ausente',
];

function iso(us: number | null): string {
  return us == null ? '—' : new Date(Math.trunc(us / 1000)).toISOString();
}

/** A human-readable table, one line per field that was seen at least once. */
export function formatReport(porCampo: ReadonlyMap<string, ShapeStats>): string {
  const linhas: string[] = [];
  let bloqueia = 0;

  for (const [campo, s] of [...porCampo].sort(([a], [b]) => a.localeCompare(b))) {
    const total = Object.values(s.counts).reduce((n, v) => n + v, 0);
    if (total === s.counts.ausente) continue;
    const partes = ORDEM.filter((b) => s.counts[b] > 0).map((b) => `${b}=${s.counts[b]}`);
    const digitos = Object.entries(s.digitos)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([d, n]) => `${d}d×${n}`)
      .join(' ');
    bloqueia += s.counts['timestamp-ou-outro'] + s.counts['zona-morta'];
    linhas.push(
      `  ${campo.padEnd(42)} ${partes.join(' ')}` +
        (digitos ? `  [${digitos}]` : '') +
        `  ${iso(s.minUs)} → ${iso(s.maxUs)}`,
    );
  }

  const veredito =
    bloqueia === 0
      ? 'OK — every stored value is classifiable, --apply is safe to run.'
      : `⚠️  STOP: ${bloqueia} value(s) in \`timestamp-ou-outro\` / \`zona-morta\`. ` +
        'coerceToMicros refuses these, so the backfill would SKIP them and they would stay ' +
        'wrong. Extend the converter before applying.';

  return ['', 'Shape report (nothing was written):', ...linhas, '', veredito, ''].join('\n');
}
