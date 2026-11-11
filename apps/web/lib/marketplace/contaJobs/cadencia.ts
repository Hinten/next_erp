/**
 * The channel-neutral clock of a conta job card: how often a running job is
 * polled, when a run reads as wedged, and how an instant is printed. Pure: no
 * React, no client, no ambient clock.
 *
 * Written for Shopee's two job cards (#1529, step 21-5) and MOVED here, names
 * and behaviour unchanged, when the Loja Integrada product import needed the
 * same rules (master plan step 9): an `app/` folder is private to its route, so
 * a second channel could only have forked them (_register, do not copy_, the
 * `marketplace-integration` skill). What stays per channel is which statuses
 * count as running and what a job's last sign of life is — Shopee's
 * `cadenciaJobsShopee.ts` and Loja Integrada's `lib/loja-integrada/importacao.ts`
 * each decide that over their own status enum, then ask this module.
 *
 * ⚠️ `agora` is always passed IN, and the cards pass the status query's
 * `dataUpdatedAt` — never `Date.now()` read during render. A wedged job answers
 * a structurally EQUAL body on every poll, TanStack then keeps the SAME `data`
 * reference, and a card that only reads `data` never re-renders: a hint keyed
 * on `Date.now()` would never appear. `dataUpdatedAt` moves on every successful
 * poll, so reading it is what re-renders the card.
 */
import { FUSO_FISCAL } from '@delfrance/schemas';

/** Poll cadence while a job is running — Mercado Livre's cards poll at the same 3 s. */
export const INTERVALO_JOB_MS = 3_000;

/**
 * How long a running job may go without a checkpoint before the card says so.
 * A channel adopts it only when its whole retry ladder fits inside it, with
 * margin for clock skew: Shopee's two queues close theirs in 1 800 s
 * (`apps/shopee/functions`' `processMassImport` / `processPriceSync` retry
 * configs); the Loja Integrada import's dispatch checkpoints at least every
 * 100 s and its reads-queue ladder (three attempts of at most 300 s, backoff
 * 60–300 s) ends well inside the half hour.
 */
export const SEM_PROGRESSO_MS = 45 * 60_000;

/**
 * The last instant the run promised activity: its last checkpoint, or — for a
 * parked run — the resume it scheduled, whichever is later. A park is a
 * PROMISE of activity at `retomarEm`, so a long park is not silence.
 */
export function ultimoSinalDeVida(d: {
  readonly updatedAt: number;
  readonly retomarEm?: number | null;
}): number {
  return Math.max(d.updatedAt, d.retomarEm ?? 0);
}

/**
 * Whether `agora` is {@link SEM_PROGRESSO_MS} past a running job's last sign of
 * life. Strictly past: exactly 45 min is still quiet. The caller decides first
 * that the job IS running — a stopped job is never "sem progresso".
 */
export function silencioExcedido(ultimoSinalMs: number, agora: number): boolean {
  return agora - ultimoSinalMs > SEM_PROGRESSO_MS;
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
