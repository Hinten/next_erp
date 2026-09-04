/**
 * Pure logic for the webchat `horario_funcionamento` business-hours editor
 * (`webchatFieldOverrides.tsx`) — kept out of the `'use client'` component so
 * it can be unit-tested without pulling in Mantine.
 *
 * Unlike the WhatsApp editor (`../whatsapp/_components/horarioFuncionamento.ts`),
 * webchat's `HorarioWebchat` stores plain wall-clock `{ hour, minute }` pairs —
 * no epoch anchor, no legacy-exact codec needed (see `horarioWebchatSchema`'s
 * doc comment in `@delfrance/schemas` for why: `webchat` is a brand-new
 * collection with no existing corpus to stay wire-compatible with).
 */
import type { HorarioWebchat, PeriodoWebchat } from '@delfrance/schemas';

/** The seven `Periodo` weekday keys, in display order (Sun → Sat). */
export const WEEKDAY_KEYS = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
] as const satisfies readonly (keyof PeriodoWebchat)[];

/**
 * Stored `{ hour, minute }` → `"HH:MM"` for a Mantine `TimeInput`. Empty
 * string for a null/absent value so the input renders blank.
 */
export function toHHMM(hour: number | null | undefined, minute: number | null | undefined): string {
  if (hour == null || minute == null) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `"HH:MM"` → `{ hour, minute }`, or `null` if not a valid time. */
export function fromHHMM(hhmm: string): { hour: number; minute: number } | null {
  const match = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Default open/close a freshly toggled-on weekday gets: 08:00–18:00. */
export function defaultHorario(): HorarioWebchat {
  return { aberturaHora: 8, aberturaMinuto: 0, fechamentoHora: 18, fechamentoMinuto: 0 };
}

/**
 * Apply an edit to a single weekday of `periods[0]` while PRESERVING every
 * additional período (index 1+) VERBATIM — same reasoning as the WhatsApp
 * editor's `applyWeekdayEdit` (a naive whole-array replace would silently
 * drop the rest).
 *
 * Returns the next `horario_funcionamento` value, or `null` only when the
 * schedule is now fully empty AND there are no extra períodos left to keep.
 */
export function applyWeekdayEdit(
  periods: readonly PeriodoWebchat[],
  day: keyof PeriodoWebchat,
  next: HorarioWebchat | null,
): PeriodoWebchat[] | null {
  const period: PeriodoWebchat = periods[0] ?? {};
  const rest = periods.slice(1);
  const nextPeriod: PeriodoWebchat = { ...period, [day]: next };
  const hasAnyDay = WEEKDAY_KEYS.some((key) => nextPeriod[key] != null);
  if (!hasAnyDay && rest.length === 0) return null;
  return [nextPeriod, ...rest];
}
