/**
 * Brazil timezone helpers for SEFAZ fiscal dates — TZ-independent by
 * construction (#395).
 *
 * The NF-e wire carries the ISSUER's local wall-clock (`dhEmi`, `dhCont`,
 * `dhEvento` — `AAAA-MM-DDThh:mm:ss±hh:mm`), and SEFAZ cross-checks the chave
 * `AAMM` against the `dhEmi` string. Deriving those from the PROCESS timezone
 * (`getHours`/`getTimezoneOffset`) silently shifts the fiscal date on a UTC
 * deploy (Firebase App Hosting / Cloud Run default to UTC): a 22:30 BRT sale
 * gets the next day's `dhEmi`, and at month-end the chave lands in the next
 * fiscal month — wrong Simples Nacional competência.
 *
 * So nothing here reads the process timezone: callers pass an explicit offset
 * derived from the issuer's UF, and the math is pure epoch-shift + `getUTC*`.
 * Brazil abolished DST in 2019, so per-UF offsets are constants.
 */
import type { UF } from '@delfrance/schemas';

export class NFeTzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeTzError';
  }
}

/** UF letter → IBGE 2-digit code (chave `cUF` / `ide.cUF`). */
export const UF_TO_IBGE: Record<UF, string> = {
  AC: '12',
  AL: '27',
  AM: '13',
  AP: '16',
  BA: '29',
  CE: '23',
  DF: '53',
  ES: '32',
  GO: '52',
  MA: '21',
  MG: '31',
  MS: '50',
  MT: '51',
  PA: '15',
  PB: '25',
  PE: '26',
  PI: '22',
  PR: '41',
  RJ: '33',
  RN: '24',
  RO: '11',
  RR: '14',
  RS: '43',
  SC: '42',
  SE: '28',
  SP: '35',
  TO: '17',
  EX: '99',
};

/**
 * UTC offset (minutes) of each UF's legal time. Permanent since Lei
 * 13.985/2019 abolished DST: Acre −05:00; Amazonas, Mato Grosso, Mato Grosso
 * do Sul, Rondônia and Roraima −04:00; every other UF (incl. DF) −03:00.
 * `EX` (exterior placeholder — never a real emitter) falls back to −03:00.
 */
export const UF_UTC_OFFSET_MINUTES: Record<UF, number> = {
  AC: -300,
  AM: -240,
  MT: -240,
  MS: -240,
  RO: -240,
  RR: -240,
  AL: -180,
  AP: -180,
  BA: -180,
  CE: -180,
  DF: -180,
  ES: -180,
  GO: -180,
  MA: -180,
  MG: -180,
  PA: -180,
  PB: -180,
  PE: -180,
  PI: -180,
  PR: -180,
  RJ: -180,
  RN: -180,
  RS: -180,
  SC: -180,
  SE: -180,
  SP: -180,
  TO: -180,
  EX: -180,
};

/** UTC offset (minutes) for a UF; throws on an unknown UF. */
export function offsetForUF(uf: UF): number {
  const offset = UF_UTC_OFFSET_MINUTES[uf];
  if (offset === undefined) {
    throw new NFeTzError(`No UTC offset known for UF '${uf}'`);
  }
  return offset;
}

/** IBGE code → UF lookup (inverse of {@link UF_TO_IBGE}). */
const IBGE_TO_UF: ReadonlyMap<string, UF> = new Map(
  Object.entries(UF_TO_IBGE).map(([uf, code]) => [code, uf as UF]),
);

/**
 * UTC offset (minutes) for an IBGE `cUF` code — e.g. the first 2 digits of a
 * chave de acesso, which identify the ISSUER's UF. Used by the evento builders
 * (cancelamento / CC-e / EPEC), whose only issuer datum is the chave.
 */
export function offsetForCUF(cUF: string): number {
  const uf = IBGE_TO_UF.get(cUF);
  if (uf === undefined) {
    throw new NFeTzError(`No UF known for IBGE cUF code '${cUF}'`);
  }
  return offsetForUF(uf);
}

/**
 * Format an instant as the SEFAZ date-time lexical
 * (`AAAA-MM-DDThh:mm:ss±hh:mm`) in the GIVEN fixed offset — never the process
 * timezone. Implementation: shift the epoch by the offset and read `getUTC*`
 * components, so the result is identical on any runner/deploy TZ.
 */
export function formatSefazDateTime(instant: Date, offsetMinutes: number): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = pad(shifted.getUTCMonth() + 1);
  const dd = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const min = pad(shifted.getUTCMinutes());
  const ss = pad(shifted.getUTCSeconds());
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const tzh = pad(Math.floor(abs / 60));
  const tzm = pad(abs % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${sign}${tzh}:${tzm}`;
}

/**
 * The wall-clock date parts of an instant in the given fixed offset. Feeds the
 * chave `AAMM` (must match the `dhEmi` string — SEFAZ cross-checks) and the
 * inutilização `ano`.
 */
export function datePartsInOffset(
  instant: Date,
  offsetMinutes: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
