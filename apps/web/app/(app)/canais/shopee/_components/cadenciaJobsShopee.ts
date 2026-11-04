/**
 * The clock of the two Shopee job cards (#1529, step 21-5) — how often a card
 * polls, when a run reads as wedged, the import's `update_time` window, and how
 * an instant is printed. Pure: no React, no client, no ambient clock.
 *
 * ⚠️ `agora` is always passed IN, and the cards pass the status query's
 * `dataUpdatedAt` — never `Date.now()` read during render. A wedged job answers
 * a structurally EQUAL body on every poll, TanStack then keeps the SAME `data`
 * reference, and a card that only reads `data` never re-renders: a hint keyed
 * on `Date.now()` would never appear. `dataUpdatedAt` moves on every successful
 * poll, so reading it is what re-renders the card.
 */
import { fimDoDiaNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import {
  ENVIO_PRECO_SHOPEE_STATUS,
  FUSO_FISCAL,
  IMPORTACAO_SHOPEE_STATUS,
  type EnvioPrecoShopeeStatus,
  type ImportacaoShopeeStatus,
} from '@delfrance/schemas';

/** Poll cadence while a job is `running` — Mercado Livre's cards poll at the same 3 s. */
export const INTERVALO_JOB_MS = 3_000;

/**
 * Poll cadence while a price run is PARKED on Shopee's daily quota. A park can
 * last until the next day; 3 s through it is ~28 800 pointless requests per open
 * tab, and the card already says when it resumes.
 */
export const INTERVALO_JOB_ESTACIONADO_MS = 60_000;

/**
 * How long a `running` job may go without a checkpoint before the card says so.
 * Both queues' whole retry ladder fits in 1 800 s (`apps/shopee/functions`'s
 * `processMassImport` / `processPriceSync` retry configs), so 45 min of silence
 * is past anything a healthy run does, with margin for clock skew.
 */
export const SEM_PROGRESSO_MS = 45 * 60_000;

/**
 * `running` in BOTH job vocabularies — {@link semProgresso} serves either card.
 * The `satisfies` is the check: rename it in one enum and this stops compiling.
 */
const EM_ANDAMENTO = IMPORTACAO_SHOPEE_STATUS.running satisfies EnvioPrecoShopeeStatus;

/** The slice of a mass-import status the cadence reads. */
interface EstadoImportacao {
  readonly status: ImportacaoShopeeStatus;
  readonly updatedAt: number;
}

/** The slice of a price-job status (or Histórico row) the cadence reads. */
interface EstadoEnvioPreco {
  readonly status: EnvioPrecoShopeeStatus;
  readonly updatedAt: number;
  /** MILLISECONDS — set while the run is parked on the daily quota. */
  readonly retomarEm: number | null;
}

/** The mass import's `refetchInterval`: 3 s while running, nothing once it stopped. */
export function intervaloImportacao(d: EstadoImportacao | undefined): number | false {
  return d?.status === IMPORTACAO_SHOPEE_STATUS.running ? INTERVALO_JOB_MS : false;
}

/**
 * The price run's `refetchInterval`: nothing once it stopped; 60 s while it is
 * parked with a resume still AHEAD of `agora`; 3 s otherwise — including a resume
 * that is already overdue, which must be seen the moment it happens.
 */
export function intervaloEnvioPreco(
  d: EstadoEnvioPreco | undefined,
  agora: number,
): number | false {
  if (d?.status !== ENVIO_PRECO_SHOPEE_STATUS.running) return false;
  return d.retomarEm !== null && d.retomarEm > agora
    ? INTERVALO_JOB_ESTACIONADO_MS
    : INTERVALO_JOB_MS;
}

/**
 * The last instant the run promised activity: its last checkpoint, or — for a
 * parked price run — the resume it scheduled, whichever is later. A park is a
 * PROMISE of activity at `retomarEm`, so a long park is not silence.
 */
export function ultimoSinalDeVida(d: {
  readonly updatedAt: number;
  readonly retomarEm?: number | null;
}): number {
  return Math.max(d.updatedAt, d.retomarEm ?? 0);
}

/**
 * Whether a RUNNING job has gone {@link SEM_PROGRESSO_MS} past its
 * {@link ultimoSinalDeVida}. Strictly past: exactly 45 min is still quiet.
 * A stopped job, or no data yet, is never "sem progresso".
 */
export function semProgresso(
  d: (EstadoImportacao | EstadoEnvioPreco) | undefined,
  agora: number,
): boolean {
  if (d?.status !== EM_ANDAMENTO) return false;
  return agora - ultimoSinalDeVida(d) > SEM_PROGRESSO_MS;
}

/**
 * The import dialog's date range → the `update_time` window `get_item_list`
 * takes, in **SECONDS** (the wire's unit — `updateTimeFromS` / `updateTimeToS`),
 * both CIVIL days whole and inclusive in São Paulo: from 00:00:00 of `de` to
 * 23:59:59 of `ate`. `null` unless both ends are real `YYYY-MM-DD` dates.
 *
 * ⚠️ Through `@delfrance/core/datetime`, never `new Date('YYYY-MM-DD')`: that
 * parses as UTC midnight, three hours before the operator's midnight, and would
 * pull in the previous evening's edits. The start is "one second after the end
 * of the day before", which is São Paulo's midnight without a second helper.
 */
export function janelaUpdateTimeEmSegundos([de, ate]: readonly [string | null, string | null]):
  | readonly [number, number]
  | null {
  if (de === null || ate === null) return null;
  const vespera = somarDiasCivis(de, -1);
  if (vespera === null) return null;
  const fimDaVespera = fimDoDiaNoFuso(vespera, FUSO_FISCAL);
  const fimDoUltimoDia = fimDoDiaNoFuso(ate, FUSO_FISCAL);
  if (fimDaVespera === null || fimDoUltimoDia === null) return null;
  return [(fimDaVespera + 1_000) / 1_000, fimDoUltimoDia / 1_000];
}

/**
 * ⚠️ São Paulo, with an EXPLICIT zone — the same sentence on every operator's
 * machine, never the browser's ambient zone (the `lib/shopee/falhaDoEnvio.ts`
 * pause suffix makes the same choice). `h23` so midnight prints `00`, not `24`.
 */
const PARTES = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_FISCAL,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * An epoch-ms instant as the cards print it: `dd/MM HH:mm`, or `dd/MM/yyyy HH:mm`
 * with `comAno`. `—` for a value that is not an instant.
 */
export function formatarInstanteJob(ms: number, opts: { comAno?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return '—';
  const partes = Object.fromEntries(
    PARTES.formatToParts(ms).map((p) => [p.type, p.value] as const),
  ) as Partial<Record<Intl.DateTimeFormatPartTypes, string>>;
  const dia = `${partes.day ?? '??'}/${partes.month ?? '??'}`;
  const data = opts.comAno === true ? `${dia}/${partes.year ?? '????'}` : dia;
  return `${data} ${partes.hour ?? '??'}:${partes.minute ?? '??'}`;
}
