/**
 * Pure logic for the `horario_funcionamento` business-hours editor
 * (`whatsappFieldOverrides.tsx`) — kept out of the `'use client'` component so
 * it can be unit-tested without pulling in Mantine / Firebase. The wire codec
 * itself (`encodeHorarioMs`/`decodeHorarioMs`, the legacy year-0/local anchor)
 * lives in `@delfrance/schemas` next to `horarioWhatsappSchema`; this module
 * only adds the UI-string adapters and the array-merge that preserves extra
 * `Periodo_Whatsapp` entries.
 */
import {
  decodeHorarioMs,
  encodeHorarioMs,
  type HorarioWhatsapp,
  type PeriodoWhatsapp,
} from '@delfrance/schemas';

/** The seven `Periodo_Whatsapp` weekday keys, in display order (Sun → Sat). */
export const WEEKDAY_KEYS = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
] as const satisfies readonly (keyof PeriodoWhatsapp)[];

/**
 * Stored ms → `"HH:MM"` for a Mantine `TimeInput`, via the legacy-exact codec
 * (LOCAL wall clock — same value the legacy screen shows). Empty string for a
 * null/absent/NaN value so the input renders blank.
 */
export function msToHHMM(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '';
  const { hour, minute } = decodeHorarioMs(ms);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `"HH:MM"` → stored ms (legacy-exact codec), or `null` if not a valid time. */
export function hhmmToMs(hhmm: string): number | null {
  const match = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return encodeHorarioMs(Number(match[1]), Number(match[2]));
}

/** Default open/close a freshly toggled-on weekday gets: 08:00–18:00 (local). */
export function defaultHorario(): HorarioWhatsapp {
  return { abertura: encodeHorarioMs(8, 0), fechamento: encodeHorarioMs(18, 0) };
}

/**
 * Apply an edit to a single weekday of `period[0]` while PRESERVING every
 * additional `Periodo_Whatsapp` (index 1+) VERBATIM.
 *
 * The legacy model supports multiple stacked periods; this editor only surfaces
 * the first (#528). A naive whole-array replace (`[nextPeriod]`) silently
 * deleted the rest — the data-loss bug this fixes. `periods.slice(1)` keeps the
 * exact same element references, so the extra periods round-trip byte-identical.
 *
 * Returns the next `horario_funcionamento` value, or `null` only when the
 * schedule is now fully empty AND there are no extra periods left to keep (so an
 * all-days-off edit still collapses to `null` in the common single-period case).
 */
export function applyWeekdayEdit(
  periods: readonly PeriodoWhatsapp[],
  day: keyof PeriodoWhatsapp,
  next: HorarioWhatsapp | null,
): PeriodoWhatsapp[] | null {
  const period: PeriodoWhatsapp = periods[0] ?? {};
  const rest = periods.slice(1);
  const nextPeriod: PeriodoWhatsapp = { ...period, [day]: next };
  const hasAnyDay = WEEKDAY_KEYS.some((key) => nextPeriod[key] != null);
  if (!hasAnyDay && rest.length === 0) return null;
  return [nextPeriod, ...rest];
}
