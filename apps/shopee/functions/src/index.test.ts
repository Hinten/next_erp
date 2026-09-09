import { afterAll, describe, expect, it } from 'vitest';

import { SHOPEE_NOTIFICATION_QUEUE } from '../../lib/shopee/notificacoes/notificacao';

/**
 * The DECLARED options of the two `onSchedule` triggers, which nothing else
 * covers.
 *
 * `DEPLOY.md` names this exact gap: the functions emulator logs both schedules
 * as "ignored because the pubsub emulator does not exist or is not running", so
 * `ci-shopee.yml` loads them and never drives them — their bodies have unit
 * tests, their cron / time zone / timeout / `secrets` had no assertion anywhere.
 * #778 is the worked example of that costing a silently inert sweep: a
 * reprocess sweep shipped without its app secrets, threw a plain `Error` on
 * every document it touched, and the pipeline parked the whole failures-only
 * store in ~2.5 h while every green test kept saying the handler was fine.
 *
 * `onSchedule` does not run the handler at import time — it only records the
 * declared options onto `func.__endpoint` — so this is a pure config assertion,
 * not a live Firestore/Shopee test. We assert over `JSON.stringify(__endpoint)`
 * for the secrets (mirrors `apps/mercado-livre/functions/src/index.test.ts`),
 * because `secretEnvironmentVariables`/`{ key }` is firebase-functions-internal
 * and may change shape across versions — and over the PARSED
 * `scheduleTrigger` fields for the cron and the zone, where a substring match
 * over the blob would pass no matter which function declared what.
 *
 * `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
 * build.mjs); here it is stubbed BEFORE the import so `options.ts`'s
 * `setGlobalOptions` does not throw. `SHOPEE_TASKS_REGION` is saved and restored
 * as well because `options.ts` WRITES it (defaulting the enqueuer's region to
 * the inlined one), and `TASKS_INVOKER_SA` because `processNotification.ts`
 * reads it at module scope — none of the three may leak into other files
 * sharing this vitest project.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalShopeeTasksRegion = process.env.SHOPEE_TASKS_REGION;
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

// ⚠️ Keep this import at the TOP LEVEL — do NOT move it into a `beforeAll`.
// `./index` is the heaviest module in this codebase (firebase-functions v2 plus
// every handler it registers), and Vitest's `hookTimeout` defaults to 10 s:
// inside a hook it flakes under `turbo run test` fan-out, while a top-level
// `await import` is module evaluation and carries no such budget. Mirrors
// `apps/mercado-livre/functions/src/index.test.ts`.
const modulo = await import('./index');
const { reprocessShopeeNotifications, sweepShopeeAuthorizationExpiry } = modulo;

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalShopeeTasksRegion === undefined) delete process.env.SHOPEE_TASKS_REGION;
  else process.env.SHOPEE_TASKS_REGION = originalShopeeTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

function gatilhoDe(fn: unknown): { schedule?: string; timeZone?: string } {
  return endpointOf(fn).scheduleTrigger as { schedule?: string; timeZone?: string };
}

/** The two partner credentials every Shopee-API-bound trigger must bind. */
const SEGREDOS = ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'];

describe('sweepShopeeAuthorizationExpiry', () => {
  it('roda SEMANALMENTE, segunda 04:00 America/Sao_Paulo', () => {
    // The period is load-bearing, not style. The aviso warns at ≤ 30 days and
    // does not nag, so a weekly cadence gives an operator four chances to see a
    // lapse coming; stretching it silently narrows that window, and the sweep
    // is the ONLY thing that reads the authorization clock at all (the legacy
    // Flutter app never did — the first signal was the day everything stopped).
    // 04:00 also keeps it clear of the other schedules on the same rate limit.
    expect(gatilhoDe(sweepShopeeAuthorizationExpiry).schedule).toBe('0 4 * * 1');
    expect(gatilhoDe(sweepShopeeAuthorizationExpiry).timeZone).toBe('America/Sao_Paulo');
  });

  it('NÃO é um cron diário — a quase-colisão que um `toContain` deixaria passar', () => {
    // The near-miss. `'0 4 * * *'` is one character away, reads identically at a
    // glance, and would quietly turn a weekly sweep into a daily walk of every
    // authorized shop — seven times the `get_shops_by_partner` budget for a
    // 30-day horizon that never needed it.
    expect(gatilhoDe(sweepShopeeAuthorizationExpiry).schedule).not.toBe('0 4 * * *');
  });

  it('tem timeoutSeconds 540 — o padrão de 60s não absorve a enumeração', () => {
    // One enumeration page per 100 shops plus a Firestore round trip per shop,
    // sequentially.
    expect(endpointOf(sweepShopeeAuthorizationExpiry).timeoutSeconds).toBe(540);
  });

  it('vincula as duas credenciais de parceiro', () => {
    // Without them the first `get_shops_by_partner` throws `ShopeeConfigError` —
    // and nothing fails at STARTUP, so the symptom is a sweep that logs errors
    // per shop rather than one that names the missing binding.
    const serializado = JSON.stringify(endpointOf(sweepShopeeAuthorizationExpiry));
    for (const segredo of SEGREDOS) expect(serializado).toContain(segredo);
  });
});

describe('reprocessShopeeNotifications', () => {
  it('roda a cada 30 minutos, no mesmo fuso', () => {
    // The hot lane re-drives `failed` pushes older than 1 h; the deferred lane
    // rides the same tick on a 24 h per-doc window. Both are backstops, so the
    // cadence is what bounds how late a lost push is recovered.
    expect(gatilhoDe(reprocessShopeeNotifications).schedule).toBe('every 30 minutes');
    expect(gatilhoDe(reprocessShopeeNotifications).timeZone).toBe('America/Sao_Paulo');
  });

  it('tem timeoutSeconds 540 e vincula as duas credenciais', () => {
    // A re-drive runs the SAME conta arms as the original delivery, so it needs
    // the identical bindings — this is exactly #778's failure.
    const endpoint = endpointOf(reprocessShopeeNotifications);
    const serializado = JSON.stringify(endpoint);
    expect(endpoint.timeoutSeconds).toBe(540);
    for (const segredo of SEGREDOS) expect(serializado).toContain(segredo);
  });
});

describe('as duas quase-falhas que um `toContain` sozinho não pega', () => {
  it('nenhum dos dois agendamentos vincula um TERCEIRO segredo', () => {
    // `secrets:` is a whitelist an operator has to grant one by one. A name that
    // drifts in — a typo, a copied line from another channel — deploys fine and
    // then fails the FUNCTION at startup with a Secret Manager 403, taking both
    // sweeps down at once. `toContain('SHOPEE_PARTNER_ID')` cannot see that; the
    // exact set can.
    for (const fn of [sweepShopeeAuthorizationExpiry, reprocessShopeeNotifications]) {
      const nomes = (
        endpointOf(fn).secretEnvironmentVariables as { key?: string }[] | undefined
      )?.map((s) => s.key);
      expect(nomes).toEqual(SEGREDOS);
    }
  });

  it('os dois agendamentos são DISTINTOS — não são a mesma declaração duas vezes', () => {
    // A copy-paste that left both on the same cron would satisfy every
    // assertion above taken one at a time.
    expect(gatilhoDe(sweepShopeeAuthorizationExpiry).schedule).not.toBe(
      gatilhoDe(reprocessShopeeNotifications).schedule,
    );
  });
});

describe('o nome do export da fila', () => {
  it('é exatamente SHOPEE_NOTIFICATION_QUEUE — o alvo do enqueue', () => {
    // The deployed function name IS the export key, and the receiver enqueues
    // against the constant. `index.ts` asserts the pair at module load (so a
    // half-rename fails Firebase's codebase analysis loudly); this pins the same
    // property offline, where the failure names itself. A drift here is silent
    // in production: the Admin SDK happily enqueues onto a queue path that does
    // not exist and the task simply never arrives.
    expect(SHOPEE_NOTIFICATION_QUEUE in modulo).toBe(true);
    expect((modulo as unknown as Record<string, unknown>)[SHOPEE_NOTIFICATION_QUEUE]).toBeDefined();
  });
});
