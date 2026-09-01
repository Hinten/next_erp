/**
 * Compare the three watch signals against the committed baseline and decide
 * whether anything moved.
 *
 * ⚠️ **This module is what gates the AI step.** `temNovidade()` false means the
 * expensive job never starts, so a bug that makes it permanently false is a
 * watcher that costs nothing and reports nothing — the exact shape of failure
 * this design keeps circling back to. Every path that could return "no news"
 * because of an error instead throws in `watchSignals.ts` first.
 */
import type { ApplicationSnapshot, ConsumptionSnapshot, Notice } from './watchSignals';

/**
 * Percentage-point move in a status's share that counts as news.
 *
 * ⚠️ A threshold is required, not optional. Raw percentages wobble D-to-D on
 * their own, so comparing exactly would open an issue every week and the watch
 * would be muted within a month; comparing not at all would mean only brand-new
 * status codes are ever noticed, missing a 403 rate that quadruples. One
 * percentage point on a corpus of millions of requests is a real change.
 */
export const TOLERANCIA_PONTOS_PERCENTUAIS = 1;

/**
 * Percentage shares, to four decimals.
 *
 * ⚠️ NOT two. ML reports shares to seven decimal places and the interesting ones
 * are tiny — a `502` at `0.0000029` is a real signal that `toFixed(2)` renders
 * as `0.00`, i.e. erases. (Two decimals is also what
 * `delfrance/no-ad-hoc-money-rounding` bans, correctly: these are not money.)
 */
function fmtPct(value: number): string {
  return value.toFixed(4);
}

export interface WatchBaseline {
  /** ⚠️ APPEND-ONLY. See `proximaBaseline`. */
  readonly seenNoticeIds: readonly string[];
  readonly application: ApplicationSnapshot | null;
  readonly consumption: Readonly<Record<string, number>> | null;
}

export interface WatchSignals {
  readonly notices: readonly Notice[];
  readonly application: ApplicationSnapshot;
  readonly consumption: ConsumptionSnapshot;
}

export interface WatchFindings {
  readonly novasNotices: readonly Notice[];
  readonly mudancasApp: readonly string[];
  readonly novosStatus: readonly number[];
  readonly desviosStatus: readonly string[];
  /** Notices already triaged, reported only as a count. */
  readonly noticesJaVistas: number;
}

export const BASELINE_VAZIA: WatchBaseline = {
  seenNoticeIds: [],
  application: null,
  consumption: null,
};

function compararApp(
  antes: ApplicationSnapshot | null,
  agora: ApplicationSnapshot,
): readonly string[] {
  // A first run has nothing to compare against. Reporting every field as
  // "changed" would bury the real signal on the one run nobody reads carefully.
  if (antes === null) return [];

  const mudancas: string[] = [];
  const campo = <T>(nome: string, a: T, b: T): void => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      mudancas.push(`${nome}: ${String(a)} → ${String(b)}`);
  };

  campo('active', antes.active, agora.active);
  campo('max_requests_per_hour', antes.maxRequestsPerHour, agora.maxRequestsPerHour);
  campo('certification_status', antes.certificationStatus, agora.certificationStatus);
  campo('site_id', antes.siteId, agora.siteId);

  const perdidos = antes.scopes.filter((s) => !agora.scopes.includes(s));
  const ganhos = agora.scopes.filter((s) => !antes.scopes.includes(s));
  if (perdidos.length > 0) mudancas.push(`scopes REMOVIDOS: ${perdidos.join(', ')}`);
  if (ganhos.length > 0) mudancas.push(`scopes ADICIONADOS: ${ganhos.join(', ')}`);

  return mudancas;
}

export function diffWatch(baseline: WatchBaseline, signals: WatchSignals): WatchFindings {
  const vistos = new Set(baseline.seenNoticeIds);
  const novasNotices = signals.notices.filter((n) => !vistos.has(n.id));

  const antesConsumo = baseline.consumption;
  const novosStatus: number[] = [];
  const desviosStatus: string[] = [];

  for (const { status, percentage } of signals.consumption.byStatus) {
    const anterior = antesConsumo?.[String(status)];
    if (antesConsumo === null || antesConsumo === undefined) continue; // first run
    if (anterior === undefined) {
      novosStatus.push(status);
      continue;
    }
    const delta = Math.abs(percentage - anterior);
    if (delta >= TOLERANCIA_PONTOS_PERCENTUAIS) {
      desviosStatus.push(
        `HTTP ${status}: ${fmtPct(anterior)}% → ${fmtPct(percentage)}% (${percentage - anterior >= 0 ? '+' : ''}${fmtPct(percentage - anterior)} p.p.)`,
      );
    }
  }

  return {
    novasNotices,
    mudancasApp: compararApp(baseline.application, signals.application),
    novosStatus,
    desviosStatus,
    noticesJaVistas: signals.notices.length - novasNotices.length,
  };
}

/** Whether the expensive AI triage step should run at all. */
export function temNovidade(f: WatchFindings): boolean {
  return (
    f.novasNotices.length > 0 ||
    f.mudancasApp.length > 0 ||
    f.novosStatus.length > 0 ||
    f.desviosStatus.length > 0
  );
}

/**
 * The baseline to commit after a run.
 *
 * ⚠️ `seenNoticeIds` is a UNION, never a replacement. ML returns only notices
 * *vigentes no momento da consulta*, so a notice can vanish from the feed —
 * and rebuilding the list from the current response would drop its id and
 * re-report it as new the next time ML brings it back.
 */
export function proximaBaseline(baseline: WatchBaseline, signals: WatchSignals): WatchBaseline {
  const ids = new Set([...baseline.seenNoticeIds, ...signals.notices.map((n) => n.id)]);
  const consumption: Record<string, number> = {};
  for (const { status, percentage } of signals.consumption.byStatus) {
    consumption[String(status)] = percentage;
  }
  return {
    seenNoticeIds: [...ids].sort(),
    application: signals.application,
    consumption,
  };
}

/** Markdown report — the AI's input, and the body of any issue it opens. */
export function renderReport(f: WatchFindings, signals: WatchSignals): string {
  const linhas: string[] = ['# Mercado Livre — mudanças detectadas', ''];

  if (f.mudancasApp.length > 0) {
    linhas.push('## ⚠️ A aplicação mudou (`GET /applications/{id}`)', '');
    for (const m of f.mudancasApp) linhas.push(`- ${m}`);
    linhas.push('');
  }

  if (f.novosStatus.length > 0 || f.desviosStatus.length > 0) {
    linhas.push('## 📊 Consumo da API mudou (`consumed-applications`, D-1)', '');
    for (const s of f.novosStatus) {
      linhas.push(
        `- **HTTP ${s} apareceu pela primeira vez** (${pct(signals, s)}% das requisições)`,
      );
    }
    for (const d of f.desviosStatus) linhas.push(`- ${d}`);
    linhas.push('');
    linhas.push(`_Total de requisições no período: ${signals.consumption.totalRequests}._`, '');
  }

  if (f.novasNotices.length > 0) {
    linhas.push('## 📣 Comunicados novos (`/communications/notices`)', '');
    for (const n of f.novasNotices) {
      linhas.push(`### ${n.label}`);
      linhas.push('');
      linhas.push(`- **id:** \`${n.id}\``);
      if (n.category !== null) linhas.push(`- **category:** ${n.category}`);
      if (n.subCategory !== null) linhas.push(`- **sub_category:** ${n.subCategory}`);
      if (n.fromDate !== null) linhas.push(`- **from_date:** ${n.fromDate}`);
      if (n.tags.length > 0) linhas.push(`- **tags:** ${n.tags.join(', ')}`);
      for (const l of n.links) linhas.push(`- ${l}`);
      linhas.push('', n.description.trim(), '');
    }
  }

  // ⚠️ Always stated, including when zero. A report that silently omits what it
  // skipped reads as "covered everything".
  linhas.push('---', '');
  linhas.push(
    `_${f.noticesJaVistas} comunicado(s) já triado(s) foram ignorados; ${signals.notices.length} vieram no feed._`,
  );
  return linhas.join('\n');
}

function pct(signals: WatchSignals, status: number): string {
  const row = signals.consumption.byStatus.find((r) => r.status === status);
  return row === undefined ? '?' : fmtPct(row.percentage);
}
