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
  /** ISO-8601 string that carries its zone (`Z` / `±hh[:mm]`) — read exactly. */
  | 'iso-string'
  /**
   * ISO-8601 string with NO zone — `2024-05-01T00:00:00.000`, or date-only. It is
   * what Dart's `toIso8601String()` emits for a local `DateTime`. `coerceToMicros`
   * converts it, resolving it as UTC by design, so a value a São Paulo device wrote
   * lands 3h early: local midnight becomes the previous day at 21:00. It converts,
   * so it is not a STOP — `formatReport` flags it with a CHECK line instead.
   */
  | 'iso-sem-fuso'
  /**
   * A string `coerceToMicros` refuses — not ISO-8601 (`June 16, 2026`,
   * `2024/05/01`), or not a date at all. Decided by the converter itself, never by
   * `Date.parse`, so this report agrees with `--apply` by construction: the two
   * disagree in both directions (`Date.parse` takes human formats Temporal
   * refuses, and refuses `,5Z` / a bare `-03` offset that Temporal takes).
   */
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
  /**
   * Does the microsecond precision actually EXIST, or is it padding?
   *
   * A value ending in `000` carries no more information than a millisecond one.
   * That is the normal case for anything we stamped ourselves — `nowMicros()` is
   * `Date.now() * 1000`, so its low three digits are structurally zero — and it
   * was also the case for EVERY provider value until the ISO parser was fixed,
   * because `Date.parse` truncated to milliseconds and the `× 1000` refilled the
   * gap with zeros.
   *
   * So this split answers the question the migration's own README used to get
   * wrong: how much real sub-millisecond precision is there at rest? A field that
   * is 100% padded gains nothing from being stored in microseconds; a field with
   * a non-zero `reais` count is carrying provider precision that a millisecond
   * representation would destroy.
   */
  microsPadded: number;
  microsReais: number;
  /**
   * Counted for intelligence only: `--apply` never converts this field. Its
   * refused values therefore cannot be "left wrong by the backfill", and "extend
   * the converter" would not clear them — so they stay OUT of the OK/STOP verdict
   * and get their own CHECK line.
   */
  reportOnly: boolean;
}

export function emptyStats(reportOnly = false): ShapeStats {
  return {
    counts: {
      ausente: 0,
      micros: 0,
      millis: 0,
      'iso-string': 0,
      'iso-sem-fuso': 0,
      'string-invalida': 0,
      'zona-morta': 0,
      'timestamp-ou-outro': 0,
    },
    minUs: null,
    maxUs: null,
    digitos: {},
    microsPadded: 0,
    microsReais: 0,
    reportOnly,
  };
}

/** RFC 9557 suffix annotations (`[America/Sao_Paulo]`, `[u-ca=iso8601]`) — they never carry the offset. */
const ANOTACOES = /(?:\[[^\]]*\])+$/;

/**
 * A zone designator that follows a TIME (`hh`, `hh:mm`, `hhmmss`, fractions with
 * `.` or `,`). Anchoring it after the time is the point: a date-only `2024-05-01`
 * ends in `-01`, which is the day, not a `-01` offset — and a date-only string has
 * no zone either.
 */
const ZONA_APOS_HORA = /[T ]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

export function classify(value: unknown): ShapeBucket {
  if (value == null) return 'ausente';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'timestamp-ou-outro';
    if (value >= MICROS_LOWER_BOUND) return 'micros';
    if (value <= MILLIS_UPPER_BOUND) return 'millis';
    return 'zona-morta';
  }
  if (typeof value === 'string') {
    if (coerceToMicros(value) == null) return 'string-invalida';
    return ZONA_APOS_HORA.test(value.trim().replace(ANOTACOES, '')) ? 'iso-string' : 'iso-sem-fuso';
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

  // Measured on the CONVERTED value, so it covers every inbound shape — an ISO
  // string with a `.123456` fraction now counts as real, where before the parser
  // fix it would have arrived here as `…123000` and counted as padded.
  if (us % 1000 === 0) stats.microsPadded += 1;
  else stats.microsReais += 1;
}

const ORDEM: readonly ShapeBucket[] = [
  'micros',
  'millis',
  'iso-string',
  'iso-sem-fuso',
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
  const semFuso: string[] = [];
  const recusadosSomenteLeitura: string[] = [];

  for (const [campo, s] of [...porCampo].sort(([a], [b]) => a.localeCompare(b))) {
    const total = Object.values(s.counts).reduce((n, v) => n + v, 0);
    if (total === s.counts.ausente) continue;
    const partes = ORDEM.filter((b) => s.counts[b] > 0).map((b) => `${b}=${s.counts[b]}`);
    const digitos = Object.entries(s.digitos)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([d, n]) => `${d}d×${n}`)
      .join(' ');
    const recusados = s.counts['timestamp-ou-outro'] + s.counts['zona-morta'];
    // The verdict is scoped to what `--apply` converts: a report-only field's
    // refusals go on their own CHECK line instead.
    if (!s.reportOnly) bloqueia += recusados;
    else if (recusados > 0) recusadosSomenteLeitura.push(campo);
    if (s.counts['iso-sem-fuso'] > 0) semFuso.push(campo);
    // Precision census — NOT part of the verdict, purely intelligence about
    // whether this field's microseconds carry information or are padding.
    const convertidos = s.microsPadded + s.microsReais;
    const precisao =
      convertidos === 0
        ? ''
        : s.microsReais === 0
          ? `  µs=PADDING (${s.microsPadded}/${convertidos} end in 000)`
          : `  µs=REAL (${s.microsReais}/${convertidos} sub-ms)`;
    linhas.push(
      `  ${campo.padEnd(42)} ${partes.join(' ')}` +
        (digitos ? `  [${digitos}]` : '') +
        `  ${iso(s.minUs)} → ${iso(s.maxUs)}` +
        precisao +
        (s.reportOnly ? '  (report-only)' : ''),
    );
  }

  const veredito =
    bloqueia === 0
      ? 'OK — every stored value is classifiable, --apply is safe to run.'
      : `⚠️  STOP: ${bloqueia} value(s) in \`timestamp-ou-outro\` / \`zona-morta\`. ` +
        'coerceToMicros refuses these, so the backfill would SKIP them and they would stay ' +
        'wrong. Extend the converter before applying.';

  // Both deliberately OUTSIDE the verdict: an offset-less string converts fine, it
  // may just convert to the wrong instant; a report-only field is never converted.
  const avisos: string[] = [];
  if (semFuso.length > 0) {
    avisos.push(
      `⚠️  CHECK: offset-less ISO string(s) (\`iso-sem-fuso\`) in ${semFuso.join(', ')}. ` +
        'coerceToMicros reads them as UTC, so a value a São Paulo device wrote lands 3h ' +
        'early (local midnight → the previous day at 21:00). The verdict above does not ' +
        "count these — confirm the writer's zone before --apply or before trusting the field.",
    );
  }
  if (recusadosSomenteLeitura.length > 0) {
    avisos.push(
      '⚠️  CHECK: report-only field(s) holding values coerceToMicros refuses ' +
        `(\`timestamp-ou-outro\` / \`zona-morta\`) in ${recusadosSomenteLeitura.join(', ')}. ` +
        '--apply never converts them, so the verdict above does not count them — but their ' +
        'schema reader cannot parse them either. Look at those documents by hand.',
    );
  }

  return [
    '',
    'Shape report (nothing was written):',
    ...linhas,
    '',
    veredito,
    '',
    ...avisos.flatMap((a) => [a, '']),
  ].join('\n');
}
