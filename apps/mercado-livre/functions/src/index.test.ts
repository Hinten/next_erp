import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// #778: the reprocess sweep must bind the ML app credentials + a budget that
// fits its worst-case sequential ML-API-bound drain — exactly like every
// other function that resolves `loadMercadoLivreContext()`. Without them
// every doc it touches throws `MercadoLivreConfigError` (a plain `Error`),
// which the resilience pipeline treats as transient and parks after
// `MAX_TENTATIVAS` — silently destroying the failures-only store in ~2.5h
// (see the issue). `onSchedule` doesn't run the handler at import time — it
// only records the declared options onto `func.__endpoint` — so this is a
// pure config assertion, not a live Firestore/ML-API test (that behaviour is
// already covered by `lib/marketplace/notificacoes/notificacao.test.ts`'s
// `reprocessNotifications` suite). We assert over `JSON.stringify(__endpoint)`
// rather than its internal shape (mirrors `apps/whatsapp/functions/src/sendOutbound.test.ts`)
// since `secretEnvironmentVariables`/`{ key }` is firebase-functions-internal
// and may change shape across versions.
//
// `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
// build.mjs); here we stub it before importing so `options.ts`'s
// `setGlobalOptions` doesn't throw — restored afterwards so it doesn't leak
// into other test files sharing this vitest project. The module reads
// `process.env` at import time via a top-level `const`, so the stub must land
// before the dynamic import (mirrors `mlTasks.test.ts`'s pattern).
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalMlTasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION;
process.env.MERCADO_LIVRE_TASKS_REGION = 'us-central1';

// ⚠️ Keep this import at the TOP LEVEL — do NOT move it into a `beforeAll`.
// `./index` is the heaviest module in this codebase (firebase-functions v2 plus
// every handler + queue module it registers), and Vitest's `hookTimeout`
// defaults to 10 s: inside a hook it flakes under `turbo run test` fan-out,
// while a top-level `await import` is module evaluation and carries no such
// budget. This mirrors `apps/whatsapp/functions/src/sendOutbound.test.ts` and
// the sibling `on*Changed` tests here, which all import at the top level.
const {
  reprocessMercadoLivreNotifications,
  sweepMercadoLivreAnunciosNaoEnumerados,
  sweepMercadoLivreMissedFeeds,
  sweepMercadoLivrePedidosTravados,
  sweepMercadoLivreStockReconciliacao,
} = await import('./index');

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.MERCADO_LIVRE_TASKS_REGION = originalMlTasksRegion;
});

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

describe('reprocessMercadoLivreNotifications (#778)', () => {
  it('binds both ML app secrets and sets timeoutSeconds to 540 (matches the other ML-API-bound sweeps)', () => {
    const endpoint = (
      reprocessMercadoLivreNotifications as unknown as {
        __endpoint: Record<string, unknown>;
      }
    ).__endpoint;
    const serialized = JSON.stringify(endpoint);
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_SECRET');
    expect(endpoint.timeoutSeconds).toBe(540);
  });
});

describe('sweepMercadoLivreMissedFeeds (#812)', () => {
  it('binds both ML app secrets and sets timeoutSeconds to 540', () => {
    // CLIENT_ID does double duty here: the per-conta token refresh AND the
    // `app_id` query param `GET /missed_feeds` requires. Without the secrets
    // bound, every conta throws `MercadoLivreConfigError` and the backstop is
    // silently inert.
    const endpoint = endpointOf(sweepMercadoLivreMissedFeeds);
    const serialized = JSON.stringify(endpoint);
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_SECRET');
    expect(endpoint.timeoutSeconds).toBe(540);
  });

  it('runs DAILY at 05:00 America/Sao_Paulo — the period is load-bearing', () => {
    // ⚠️ Asserted on the parsed trigger fields, not via `toContain` on the JSON
    // blob: every other schedule in this module already uses America/Sao_Paulo,
    // so a substring match would pass no matter what THIS function declares.
    //
    // The literal matters beyond style. `GET /missed_feeds` has no time filter
    // and ML retains an entry for 48h, so the sweep keeps no cursor and coverage
    // rests entirely on `period × 2 ≤ retention`. Lengthening this cron past 24h
    // silently deletes the backstop for anything filed between runs — which is
    // exactly the failure #812 exists to close. If you are changing it, re-read
    // the module doc on `missedFeedsSweep.ts` first.
    const trigger = endpointOf(sweepMercadoLivreMissedFeeds).scheduleTrigger as {
      schedule?: string;
      timeZone?: string;
    };
    expect(trigger.schedule).toBe('0 5 * * *');
    expect(trigger.timeZone).toBe('America/Sao_Paulo');
  });
});

describe('sweepMercadoLivrePedidosTravados (#1087 follow-up)', () => {
  it('runs WEEKLY, clear of the other ML schedules', () => {
    // ⚠️ Asserted on the parsed trigger fields, not `toContain` on the JSON blob:
    // every schedule in this module uses America/Sao_Paulo, so a substring match
    // would pass whatever THIS function declares.
    //
    // Monday 04:00 is deliberate — 02:00 is the daily stock sweep, 03:00 the
    // monthly reconciliation, 05:00 the missed-feeds backstop. Overlapping them
    // would put two ML-API-bound sweeps on the same rate limit.
    const trigger = endpointOf(sweepMercadoLivrePedidosTravados).scheduleTrigger as {
      schedule?: string;
      timeZone?: string;
    };
    expect(trigger.schedule).toBe('0 4 * * 1');
    expect(trigger.timeZone).toBe('America/Sao_Paulo');
  });

  it('binds both ML app secrets and sets timeoutSeconds to 540', () => {
    // It makes one ML round trip per candidate, sequentially, up to the page cap
    // — the gen2 60s default cannot absorb that.
    const endpoint = endpointOf(sweepMercadoLivrePedidosTravados);
    const json = JSON.stringify(endpoint);
    expect(json).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(json).toContain('MERCADO_LIVRE_CLIENT_SECRET');
    expect(endpoint.timeoutSeconds).toBe(540);
  });
});

/** The parsed `scheduleTrigger` of an `onSchedule` export — fields, never a JSON substring. */
function gatilhoDe(fn: unknown): { schedule?: string; timeZone?: string } {
  return endpointOf(fn).scheduleTrigger as { schedule?: string; timeZone?: string };
}

/**
 * A FIXED-TIME cron (`M H DoM Mon DoW`) split into its fields, with the start as
 * seconds after local midnight. Refuses anything else — a step or a list in the
 * minute/hour fields has no single start to compare, and comparing one by
 * accident would be a check that cannot fail.
 */
function cronFixo(schedule: string | undefined): {
  inicioSeg: number;
  diaDoMes: string;
  mes: string;
  diaDaSemana: string;
} {
  const campos = (schedule ?? '').trim().split(/\s+/);
  expect(campos).toHaveLength(5);
  const [minuto = '', hora = '', diaDoMes = '', mes = '', diaDaSemana = ''] = campos;
  expect(minuto).toMatch(/^\d{1,2}$/);
  expect(hora).toMatch(/^\d{1,2}$/);
  return { inicioSeg: Number(hora) * 3600 + Number(minuto) * 60, diaDoMes, mes, diaDaSemana };
}

describe('sweepMercadoLivreAnunciosNaoEnumerados (#1200 — the monthly link audit)', () => {
  it('runs at 02:30 America/Sao_Paulo on the 1st', () => {
    // ⚠️ Parsed trigger fields, not `toContain` on the JSON blob — every schedule
    // in this codebase is America/Sao_Paulo, and '30 2 1 * *' as a substring would
    // also match a cron someone widened around it.
    const trigger = gatilhoDe(sweepMercadoLivreAnunciosNaoEnumerados);
    expect(trigger.schedule).toBe('30 2 1 * *');
    expect(trigger.timeZone).toBe('America/Sao_Paulo');
  });

  it('binds NO ML secret — the audit makes zero ML calls — and sets timeoutSeconds to 540', () => {
    // The trap is `sweepScheduleOptions`, which the three tiers beside it share:
    // it binds both secrets, so reusing it for "one more stock schedule" would
    // hand the ML app credentials to a Firestore-only function (`options.ts`).
    const endpoint = endpointOf(sweepMercadoLivreAnunciosNaoEnumerados);
    const json = JSON.stringify(endpoint);
    expect(json).not.toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(json).not.toContain('MERCADO_LIVRE_CLIENT_SECRET');
    expect(endpoint.timeoutSeconds).toBe(540);
    // ÂNCORA: the same probe DOES see a bound secret on the reconciliação, so the
    // two negatives above are not passing on a serialization that hides secrets.
    expect(JSON.stringify(endpointOf(sweepMercadoLivreStockReconciliacao))).toContain(
      'MERCADO_LIVRE_CLIENT_ID',
    );
  });

  it('finishes before the 03:00 force-all it prepares — same day, same zone, start + timeout < its start', () => {
    // The heal is only worth running BEFORE the full pass re-enumerates the
    // catalogue; a run still going at 03:00 heals families the pass has already
    // walked past, and they wait a month. So the whole window — start plus the
    // declared timeout, the worst case of a run killed at its limit — must close
    // before the reconciliação starts, on the SAME calendar day in the SAME zone.
    // Both crons are parsed from the deployed endpoints, so moving either one
    // re-checks the arithmetic instead of trusting a literal here.
    const auditoria = gatilhoDe(sweepMercadoLivreAnunciosNaoEnumerados);
    const reconciliacao = gatilhoDe(sweepMercadoLivreStockReconciliacao);
    expect(auditoria.timeZone).toBe(reconciliacao.timeZone);

    const a = cronFixo(auditoria.schedule);
    const r = cronFixo(reconciliacao.schedule);
    expect(a.diaDoMes).toBe(r.diaDoMes);
    expect(a.mes).toBe(r.mes);
    expect(a.diaDaSemana).toBe(r.diaDaSemana);

    const timeoutSeconds = endpointOf(sweepMercadoLivreAnunciosNaoEnumerados).timeoutSeconds;
    expect(typeof timeoutSeconds).toBe('number');
    expect(a.inicioSeg + (timeoutSeconds as number)).toBeLessThan(r.inicioSeg);
  });
});

/**
 * Owner decision D2: the audit runs even with `MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED`
 * off — that valve rations ML quota, and the audit spends none. No endpoint field
 * can show what a HANDLER reads, so this reads the source (the
 * `stockSendMaxAttempts.test.ts` technique: the nested functions codebase has no
 * test runner of its own).
 *
 * ⚠️ Scoped to the new export's own text, never the whole file: `sweepStock.ts`
 * legitimately names the flag in the reconciliação's handler right above it, so a
 * whole-file scan could not tell the two apart. The slice runs from the
 * `export const` to the `);` that closes the `onSchedule(` call at column 0.
 */
describe('sweepMercadoLivreAnunciosNaoEnumerados — its handler names no reconciliação valve (D2)', () => {
  const fonte = readFileSync(join(__dirname, 'sweepStock.ts'), 'utf8');

  function trechoDoExport(nome: string): string {
    const inicio = fonte.indexOf(`export const ${nome} = onSchedule(`);
    expect(inicio).toBeGreaterThan(-1);
    const fim = fonte.indexOf('\n);\n', inicio);
    expect(fim).toBeGreaterThan(inicio);
    return fonte.slice(inicio, fim);
  }

  it('reads neither the flag constant nor its literal, and calls no shared helper that could', () => {
    const trecho = trechoDoExport('sweepMercadoLivreAnunciosNaoEnumerados');
    // ÂNCORA: the slice really is the audit's handler, not an empty or foreign span.
    expect(trecho).toContain('runAuditoriaNaoEnumerados(');

    expect(trecho).not.toMatch(/\bSTOCK_RECONCILIACAO_FLAG_ENV\b/);
    expect(trecho).not.toContain('MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED');
    // `runAndLog` drives the ML-bound tiers; routing the audit through it (or any
    // helper defined in this file) would move a gate out of this slice's sight.
    expect(trecho).not.toMatch(/\brunAndLog\(/);
    expect(trecho).not.toMatch(/\bsweepScheduleOptions\(/);
    // Cloud Scheduler does not exist in the ML backend's region (`options.ts`).
    expect(trecho).toMatch(/region:\s*TASKS_SCHEDULER_REGION\b/);
  });

  it('ÂNCORA: the same slicing DOES see the flag in the reconciliação handler', () => {
    // Without this the negatives above could pass on a slicer that returns the
    // wrong span — the reconciliação is the one export known to name the flag.
    expect(trechoDoExport('sweepMercadoLivreStockReconciliacao')).toMatch(
      /\bSTOCK_RECONCILIACAO_FLAG_ENV\b/,
    );
  });
});
