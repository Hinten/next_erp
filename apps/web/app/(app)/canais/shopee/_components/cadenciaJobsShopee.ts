/**
 * The Shopee half of the two Shopee job cards' clock (#1529, step 21-5): which
 * statuses poll and how fast, when a run reads as wedged, and the import's
 * `update_time` window. Pure: no React, no client, no ambient clock.
 *
 * The channel-neutral half — the 3 s cadence, the 45-minute rule, the last sign
 * of life and the printed instant — moved to `lib/marketplace/contaJobs/cadencia.ts`
 * (names and behaviour unchanged) when the Loja Integrada import needed it too;
 * its header says why `agora` is always passed IN.
 */
import { fimDoDiaNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import {
  ENVIO_PRECO_SHOPEE_STATUS,
  FUSO_FISCAL,
  IMPORTACAO_SHOPEE_STATUS,
  type EnvioPrecoShopeeStatus,
  type ImportacaoShopeeStatus,
} from '@delfrance/schemas';

import {
  INTERVALO_JOB_MS,
  silencioExcedido,
  ultimoSinalDeVida,
} from '@/lib/marketplace/contaJobs/cadencia';

/**
 * Poll cadence while a price run is PARKED on Shopee's daily quota. A park can
 * last until the next day; 3 s through it is ~28 800 pointless requests per open
 * tab, and the card already says when it resumes.
 */
export const INTERVALO_JOB_ESTACIONADO_MS = 60_000;

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
 * Whether a RUNNING job has gone `SEM_PROGRESSO_MS` (45 min) past its
 * `ultimoSinalDeVida` — a parked price run's resume counts as a sign of life.
 * Strictly past: exactly 45 min is still quiet. A stopped job, or no data yet,
 * is never "sem progresso".
 */
export function semProgresso(
  d: (EstadoImportacao | EstadoEnvioPreco) | undefined,
  agora: number,
): boolean {
  if (d?.status !== EM_ANDAMENTO) return false;
  return silencioExcedido(ultimoSinalDeVida(d), agora);
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
