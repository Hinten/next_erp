/**
 * Loja Integrada's NAIVE date-times, read and written as text — the order
 * poller's stamps and bounds (master plan step 3, PR 3-e) — and the order
 * import's conversions to µs (step 5, PR 5-b). Pure: no clock, no I/O; the
 * only zone is {@link FUSO_DATAS_LI}, passed explicitly.
 *
 * ## The order import's µs boundary
 *
 * Besides `avisos/avisos.ts`, this is the app's one module that converts to µs
 * (`avisos.test.ts` counts the calls). The order import's three conversions all
 * live here, so the units cannot drift between its mappers:
 *
 *  - {@link dataLiParaMicros} — an INCOMING Loja Integrada stamp, read in
 *    {@link FUSO_DATAS_LI};
 *  - {@link microsArmazenadoLi} — a STORED stamp another writer may have left
 *    in another unit (ms, µs, an ISO string);
 *  - {@link microsDeMillisLi} — an instant the import computed in ms (the
 *    dispatch deadline).
 *
 * ## Two shapes, both fixed width, so string order is time order
 *
 *  - **canonical stamp** (26 characters, `AAAA-MM-DDTHH:MM:SS.ffffff`): a
 *    row's `data_modificacao` after {@link lerDataLi}. `vistos`, the task
 *    payload's `dataModificacaoLi` and every comparison of two stamps use it.
 *  - **naive second** (19 characters, `AAAA-MM-DDTHH:MM:SS`): what the search
 *    filter takes, so the cursor and every window bound use it.
 *    {@link canonicaDoCursorLi} lifts one to a canonical stamp (`.000000`)
 *    before it is compared with a stamp.
 *
 * ## The zone: America/Sao_Paulo, INFERRED and unconfirmed
 *
 * The platform writes every stamp without an offset and documents no zone, and
 * no capture proves which one it is. The order import reads them in
 * {@link FUSO_DATAS_LI} (`America/Sao_Paulo`): a Brazilian storefront's local
 * wall time is the inference, not a measurement. Two things keep a wrong
 * inference cheap, and neither depends on it:
 *
 *  - the POLLER never turns a text into an instant. {@link msIngenuoDeDataLi}
 *    reads the naive fields as if they were UTC, purely to do arithmetic on
 *    them (`Date.UTC` / `getUTC*`, which `no-ambient-timezone` allows), and
 *    {@link renderizarDataLi} writes the result back as naive text; its window
 *    carries a 4 h zone margin (`janelaPoll.ts`). ⚠️ A `msIngenuo` is NOT an
 *    epoch: never compare one with a clock reading, and never store one;
 *  - the IMPORT converts each stamp exactly once, through
 *    {@link dataLiParaMicros}, so two LI stamps it compares were converted the
 *    same way and a constant zone error cancels out of that comparison. What a
 *    wrong zone would shift is the stored instants themselves (dates shown to
 *    an operator, a dispatch deadline).
 *
 * When a capture settles the zone, {@link FUSO_DATAS_LI} is the one constant to
 * change.
 *
 * ## The canonicalisation is a FOLD — what it equates and what it keeps apart
 *
 * Equal: a stamp without a fraction and the same second with `.000000`; a
 * short fraction and its zero-padded form (`.1` ≡ `.100000`). Distinct: any two
 * instants one microsecond apart; `.1` vs `.01`. Refused (`null`, which the
 * poller records as `formato-de-data`): anything else — a space instead of the
 * `T`, an offset or a `Z`, more than six fraction digits, surrounding
 * whitespace, a day the calendar does not have, a non-string. Pinned by
 * `dataLi.test.ts`.
 */
import { coerceToMicros, microsDeDataHoraNoFuso, millisToMicros } from '@delfrance/core/datetime';
import { CURSOR_POLL_LI_REGEX, DATA_MODIFICACAO_LI_REGEX } from '@delfrance/schemas';

/**
 * The zone the order import reads Loja Integrada's naive stamps in — INFERRED,
 * unconfirmed (module header). The one constant to change when a capture
 * settles it.
 */
export const FUSO_DATAS_LI = 'America/Sao_Paulo';

/** A stamp as the platform may send it: whole seconds and an optional 1–6 digit fraction. */
const DATA_LI_ACEITA = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.([0-9]{1,6}))?$/;

/** The naive fields at the head of a cursor or a canonical stamp. */
const CAMPOS = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/;

/**
 * The naive fields of `texto` — a 19-character cursor or a 26-character
 * canonical stamp, nothing else — as milliseconds, read as if UTC; whole
 * seconds (a fraction is ignored). `null` when `texto` has neither shape or
 * names a day the calendar does not have (`2026-02-30`), or a year before 100,
 * which `Date.UTC` would silently move into the 1900s.
 */
export function msIngenuoDeDataLi(texto: string): number | null {
  if (!CURSOR_POLL_LI_REGEX.test(texto) && !DATA_MODIFICACAO_LI_REGEX.test(texto)) return null;
  const m = CAMPOS.exec(texto);
  if (m === null) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const hora = Number(m[4]);
  const minuto = Number(m[5]);
  const segundo = Number(m[6]);
  const ms = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo);
  const d = new Date(ms);
  // A field `Date.UTC` normalised (Feb 30 → Mar 2, year 50 → 1950) does not round-trip.
  const ida =
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia &&
    d.getUTCHours() === hora &&
    d.getUTCMinutes() === minuto &&
    d.getUTCSeconds() === segundo;
  return ida ? ms : null;
}

/**
 * A row's `data_modificacao` as a canonical stamp (26 characters), or `null`
 * when it is not a naive stamp this poller can order — which it records as
 * `formato-de-data`. Never trims, never case-folds, never guesses a zone.
 */
export function lerDataLi(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const m = DATA_LI_ACEITA.exec(bruto);
  if (m === null) return null;
  const canonica = `${bruto.slice(0, 19)}.${(m[1] ?? '').padEnd(6, '0')}`;
  // The field ranges (month 13, hour 24, second 60) and a real calendar day.
  return msIngenuoDeDataLi(canonica) === null ? null : canonica;
}

/**
 * A Loja Integrada stamp as the INSTANT it names, in µs since the epoch, read
 * in {@link FUSO_DATAS_LI} — or `null` when {@link lerDataLi} refuses it (or the
 * instant falls outside the µs safe range). The order import's ONE reading of
 * an incoming stamp: the watermark, `timestamp`, the history dates and the
 * freight dates all go through it, so two stamps it compares were converted the
 * same way.
 *
 * ⚠️ Never {@link microsArmazenadoLi} on an incoming stamp: it reads an
 * offset-less ISO string as UTC, three hours away from this.
 *
 * Fold: the {@link lerDataLi} fold (`X` ≡ `X.000000`, `.1` ≡ `.100000`); one
 * microsecond apart stays distinct.
 */
export function dataLiParaMicros(bruto: unknown): number | null {
  const canonica = lerDataLi(bruto);
  return canonica === null ? null : microsDeDataHoraNoFuso(canonica, FUSO_DATAS_LI);
}

/**
 * A STORED stamp as µs, whatever unit another writer left it in — a µs or ms
 * number (by magnitude), an ISO string, a `Date` — or `null` (absent, or not a
 * stamp). Only ever the stored side of a comparison: a watermark another writer
 * (or the migrated corpus) may hold in another unit.
 */
export function microsArmazenadoLi(valor: unknown): number | null {
  return coerceToMicros(valor);
}

/** An instant the import computed in ms (a dispatch deadline) as µs. */
export function microsDeMillisLi(ms: number): number {
  return millisToMicros(ms);
}

/**
 * `msIngenuo` as a naive second, `AAAA-MM-DDTHH:MM:SS` — FLOORED to the whole
 * second. Given a real epoch, this is that instant in UTC.
 *
 * @throws RangeError when the year falls outside 100–9999 (only a programming
 *   error reaches it: every input is a parsed stamp shifted by hours).
 */
export function renderizarDataLi(msIngenuo: number): string {
  const d = new Date(Math.floor(msIngenuo / 1000) * 1000);
  const ano = d.getUTCFullYear();
  if (!Number.isFinite(msIngenuo) || ano < 100 || ano > 9999) {
    throw new RangeError('renderizarDataLi: fora do intervalo de anos 100–9999');
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(ano).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

/** A canonical stamp floored to its naive second — the cursor it may advance to. */
export function cursorDaDataLi(canonica: string): string {
  return canonica.slice(0, 19);
}

/** A naive second as the canonical stamp of that exact second (`.000000`), for comparisons. */
export function canonicaDoCursorLi(cursor: string): string {
  return `${cursor}.000000`;
}

/**
 * `texto` (a cursor or a canonical stamp) moved by `segundos` on its naive
 * fields, as a naive second. Zone-free arithmetic: no DST can enter it.
 *
 * @throws RangeError when `texto` is not a valid cursor or canonical stamp.
 */
export function deslocarDataLi(texto: string, segundos: number): string {
  const ms = msIngenuoDeDataLi(texto);
  if (ms === null) throw new RangeError('deslocarDataLi: data inválida');
  return renderizarDataLi(ms + segundos * 1000);
}
