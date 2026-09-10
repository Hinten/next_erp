import { afterAll, describe, expect, it } from 'vitest';

import { LOST_PUSH_RETENTION_HOURS } from '../../lib/shopee/notificacoes/lostPushSweep';
import { SHOPEE_NOTIFICATION_QUEUE } from '../../lib/shopee/notificacoes/notificacao';

/**
 * The DECLARED options of every `onSchedule` trigger in this codebase, which
 * nothing else covers.
 *
 * `DEPLOY.md` names this exact gap: the functions emulator logs each schedule
 * as "ignored because the pubsub emulator does not exist or is not running", so
 * `ci-shopee.yml` loads them and never drives them — their bodies have unit
 * tests, their cron / time zone / timeout / `secrets` had no assertion anywhere.
 * #778 is the worked example of that costing a silently inert sweep: a
 * reprocess sweep shipped without its app secrets, threw a plain `Error` on
 * every document it touched, and the pipeline parked the whole failures-only
 * store in ~2.5 h while every green test kept saying the handler was fine.
 *
 * ⚠️ The enumeration is a MAP, and the last test in this file asserts it is
 * COMPLETE — every exported trigger carrying a `scheduleTrigger` must be a key
 * of `AGENDAMENTOS`. Step 4 added three schedules at once to a file whose
 * framing said "the two triggers", and without that test each of them would
 * have been uncovered until someone remembered to grow this file; a fourth
 * batch would be uncovered again.
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
const {
  backfillShopeeOrders,
  monitorShopeePushConfig,
  processShopeeNotification,
  reprocessShopeeNotifications,
  sweepShopeeAuthorizationExpiry,
  sweepShopeeLostPushes,
} = modulo;

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalShopeeTasksRegion === undefined) delete process.env.SHOPEE_TASKS_REGION;
  else process.env.SHOPEE_TASKS_REGION = originalShopeeTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

/**
 * Every scheduled trigger this codebase exports. Adding one here is what puts
 * it under the cross-cutting assertions below (the exact secret set, cron
 * distinctness); the exhaustiveness test is what makes adding it mandatory.
 */
const AGENDAMENTOS = {
  sweepShopeeAuthorizationExpiry,
  reprocessShopeeNotifications,
  sweepShopeeLostPushes,
  monitorShopeePushConfig,
  backfillShopeeOrders,
} as const;

/**
 * Every TASK-QUEUE trigger this codebase exports — the sibling map of
 * {@link AGENDAMENTOS}, and it exists for the same reason.
 *
 * ⚠️ The exhaustiveness test below walks `scheduleTrigger` ONLY, so before this
 * map a `taskQueueTrigger` export was invisible to it: `processShopeeNotification`
 * has run every Shopee delivery since step 3 while nothing in this file could
 * see it, and its `timeoutSeconds` went from an implicit 60 to an explicit 300
 * in step 5 with the whole assertion living in one sibling file. A second task
 * function (step 9's mass import is the likely one) would arrive uncovered the
 * same way three schedules nearly did.
 *
 * Its per-option assertions stay in `processNotification.test.ts`, which mocks
 * the channel; what lives HERE is the cross-cutting set — the exact secrets,
 * the retry cap, the timeout — plus the completeness check.
 */
const FILAS = { processShopeeNotification } as const;

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

describe('sweepShopeeLostPushes', () => {
  it('roda a cada 2 horas, aos :20, America/Sao_Paulo', () => {
    // The :20 is deliberate: it keeps the sweep clear of the reprocess sweep's
    // :00/:30 and of the Monday 04:00 walk, all three of which draw on the same
    // undocumented partner rate-limit budget (`rate_limit` is published EMPTY
    // on both push pages).
    expect(gatilhoDe(sweepShopeeLostPushes).schedule).toBe('20 */2 * * *');
    expect(gatilhoDe(sweepShopeeLostPushes).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO roda a cada 2 MINUTOS — a quase-colisão que um `toContain` deixaria passar', () => {
    // `'*/2 * * * *'` differs by one field, reads almost the same, and would
    // call `get_lost_push_message` 720 times a day against an endpoint whose
    // published rate limit is an empty string — i.e. unknown, so the only safe
    // assumption is that it exists.
    expect(gatilhoDe(sweepShopeeLostPushes).schedule).not.toBe('*/2 * * * *');
  });

  /**
   * The tick period in hours, read off the cron LITERAL rather than off a
   * constant beside it: both invariants below are about what Cloud Scheduler
   * will actually do.
   */
  const periodoEmHoras = (): number => {
    const campoDaHora = gatilhoDe(sweepShopeeLostPushes).schedule?.split(' ')[1] ?? '';
    const passo = /^\*\/(\d+)$/.exec(campoDaHora);
    expect(passo).not.toBeNull();
    const horas = Number(passo?.[1]);
    expect(Number.isInteger(horas)).toBe(true);
    return horas;
  };

  it('o período cabe DUAS vezes dentro da janela de retenção de 3 dias', () => {
    // Shopee holds a lost push for `LOST_PUSH_RETENTION_HOURS` and then drops
    // it for good, so the cadence has to leave room for at least one missed
    // tick — otherwise a single failed execution is a permanent loss with
    // nothing to re-read.
    expect(periodoEmHoras() * 2).toBeLessThanOrEqual(LOST_PUSH_RETENTION_HOURS);
  });

  it('⚠️ e a cadência rende EXATAMENTE 36 ticks na janela — o número que o docblock afirma', () => {
    // ⚠️ Propriedade SEPARADA, e mais apertada: a invariante acima tem 34 h de
    // folga (qualquer período até 36 h a satisfaz), então ela sozinha não
    // falharia se alguém trocasse `*/2` por `*/12` — e o docblock de
    // `sweepShopeeLostPushes` diz "36 ticks dentro da janela de 3 dias", que é
    // o que sustenta a margem de "perder 30 ticks seguidos ainda deixa 12 h".
    // Uma afirmação em prosa que nada verifica é a deriva que o CLAUDE.md raiz
    // nomeia; esta é a asserção que a prende.
    expect(LOST_PUSH_RETENTION_HOURS / periodoEmHoras()).toBe(36);
  });

  it('tem timeoutSeconds 540 — 5 páginas × 100 enfileiramentos sequenciais', () => {
    // Plus two provider round trips per page (the read and the confirm). The
    // gen2 60s default cannot absorb that, and a timeout mid-page means the
    // page is simply not confirmed — safe, but it repeats forever if the budget
    // is never enough.
    expect(endpointOf(sweepShopeeLostPushes).timeoutSeconds).toBe(540);
  });
});

describe('monitorShopeePushConfig', () => {
  it('roda diariamente às 05:45 America/Sao_Paulo', () => {
    // One Public GET on a minute nothing else here shares, fresh when the
    // operator's day starts.
    expect(gatilhoDe(monitorShopeePushConfig).schedule).toBe('45 5 * * *');
    expect(gatilhoDe(monitorShopeePushConfig).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO é semanal — `45 5 * * 1` lê igual e daria UMA leitura por semana', () => {
    // A suspension loses every push not already in the 3-day queue, so the
    // reading has to be at most a day old. The weekly near-miss is one
    // character and would leave a suspended subscription unreported for up to
    // six days — past the retention window of the only queue that could have
    // recovered anything.
    expect(gatilhoDe(monitorShopeePushConfig).schedule).not.toBe('45 5 * * 1');
  });

  it('tem timeoutSeconds 120 — uma chamada Public, não uma varredura', () => {
    // ⚠️ Deliberately NOT the 540 every other schedule here carries. One GET
    // plus at most three aviso round trips; 540 would claim this might
    // legitimately take nine minutes and would hide a hang for that long
    // (`shopeeCall` carries no timeout of its own).
    expect(endpointOf(monitorShopeePushConfig).timeoutSeconds).toBe(120);
  });
});

describe('backfillShopeeOrders', () => {
  it('roda a cada 15 minutos, no mesmo fuso', () => {
    // The cadence bounds how late an order missed by BOTH the push and the
    // lost-push queue is imported — and a suspended subscription is exactly
    // that case, since Shopee never replays what it did not deliver.
    expect(gatilhoDe(backfillShopeeOrders).schedule).toBe('every 15 minutes');
    expect(gatilhoDe(backfillShopeeOrders).timeZone).toBe('America/Sao_Paulo');
  });

  it('tem timeoutSeconds 540 — 20 páginas por conta mais um enqueue por pedido', () => {
    expect(endpointOf(backfillShopeeOrders).timeoutSeconds).toBe(540);
  });

  it('vincula exatamente as duas credenciais de parceiro', () => {
    // Every `get_order_list` is HMAC-signed with the partner key even though it
    // is Shop-signed: the token rides in the query, the signature does not.
    const serializado = JSON.stringify(endpointOf(backfillShopeeOrders));
    for (const segredo of SEGREDOS) expect(serializado).toContain(segredo);
  });
});

describe('as quase-falhas que um `toContain` sozinho não pega', () => {
  it('nenhum dos agendamentos vincula um TERCEIRO segredo', () => {
    // `secrets:` is a whitelist an operator has to grant one by one. A name that
    // drifts in — a typo, a copied line from another channel — deploys fine and
    // then fails the FUNCTION at startup with a Secret Manager 403, taking that
    // schedule down entirely. `toContain('SHOPEE_PARTNER_ID')` cannot see that;
    // the exact set can.
    for (const [nome, fn] of Object.entries(AGENDAMENTOS)) {
      const nomes = (
        endpointOf(fn).secretEnvironmentVariables as { key?: string }[] | undefined
      )?.map((s) => s.key);
      expect(nomes, nome).toEqual(SEGREDOS);
    }
  });

  it('os agendamentos são DISTINTOS — nenhum PAR compartilha um cron', () => {
    // All-pairs, not "the first two differ": a copy-paste that left two of the
    // five on the same cron would satisfy every per-function assertion above
    // taken one at a time, and would run one of them twice while the other
    // never ran at all.
    const crons = Object.values(AGENDAMENTOS).map((fn) => gatilhoDe(fn).schedule);
    expect(new Set(crons).size).toBe(crons.length);
  });

  it('nenhuma FILA vincula um terceiro segredo — a mesma whitelist dos agendamentos', () => {
    for (const [nome, fn] of Object.entries(FILAS)) {
      const nomes = (
        endpointOf(fn).secretEnvironmentVariables as { key?: string }[] | undefined
      )?.map((s) => s.key);
      expect(nomes, nome).toEqual(SEGREDOS);
    }
  });

  it('toda FILA declara retry, vazão e um timeout explícito', () => {
    // Um `onTaskDispatched` sem `timeoutSeconds` roda com o padrão gen2 de 60 s
    // — o que já foi o caso desta função, e o que a importação de pedido do
    // passo 5 estoura. Nada aqui afirma QUAL é o número (isso é de
    // `processNotification.test.ts`); o que se afirma é que existe um, junto
    // com as duas metades da escada de re-tentativa.
    for (const [nome, fn] of Object.entries(FILAS)) {
      const endpoint = endpointOf(fn);
      const trigger = endpoint.taskQueueTrigger as {
        retryConfig?: { maxAttempts?: number; maxBackoffSeconds?: number };
        rateLimits?: { maxConcurrentDispatches?: number };
      };
      expect(typeof endpoint.timeoutSeconds, nome).toBe('number');
      expect(trigger.retryConfig?.maxAttempts, nome).toBeGreaterThan(0);
      expect(trigger.rateLimits?.maxConcurrentDispatches, nome).toBeGreaterThan(0);
      // ⚠️ A invariante que liga os três: a escada inteira — N execuções e os
      // N-1 backoffs ENTRE elas — tem de fechar em no máximo meia janela da
      // varredura quente (que re-conduz um `failed` de mais de 1 h). É a
      // margem, não o "cabe numa hora", que distingue um orçamento honesto de
      // um que só esconde um travamento por mais tempo.
      const tentativas = trigger.retryConfig?.maxAttempts ?? 0;
      const escadaSegundos =
        tentativas * (endpoint.timeoutSeconds as number) +
        Math.max(tentativas - 1, 0) * (trigger.retryConfig?.maxBackoffSeconds ?? 0);
      expect(escadaSegundos, nome).toBeLessThanOrEqual(1800);
    }
  });

  it('todo onTaskDispatched exportado está coberto por FILAS', () => {
    // A gêmea da asserção de exaustividade abaixo, para o outro tipo de
    // gatilho. Sem ela, uma função de fila nova sobe, recebe entregas e nenhum
    // teste jamais lê as suas opções — que é exatamente o buraco em que
    // `processShopeeNotification` viveu do passo 3 ao 5.
    const exportados = Object.entries(modulo as unknown as Record<string, unknown>)
      .filter(([, valor]) => {
        const endpoint = (valor as { __endpoint?: Record<string, unknown> } | null)?.__endpoint;
        return endpoint !== undefined && endpoint.taskQueueTrigger !== undefined;
      })
      .map(([nome]) => nome);
    expect(exportados.sort()).toEqual(Object.keys(FILAS).sort());
  });

  it('as duas famílias são DISJUNTAS — nada é agendamento e fila ao mesmo tempo', () => {
    // Um export que aparecesse nos dois mapas satisfaria as duas asserções de
    // exaustividade e teria as suas opções lidas pelo conjunto errado.
    const agendamentos = new Set(Object.keys(AGENDAMENTOS));
    for (const nome of Object.keys(FILAS)) expect(agendamentos.has(nome)).toBe(false);
  });

  it('todo onSchedule exportado está coberto por um describe acima', () => {
    // THE exhaustiveness assertion. Without it, a new schedule is uncovered
    // until somebody remembers to grow this file — which is precisely what
    // happened between step 3 and step 4, and the failure mode is silent: the
    // function deploys, fires on whatever cron it declared, and no test ever
    // reads it. It enumerates the module's own exports rather than a list, so
    // there is nothing to keep in sync but `AGENDAMENTOS` itself.
    const exportados = Object.entries(modulo as unknown as Record<string, unknown>)
      .filter(([, valor]) => {
        const endpoint = (valor as { __endpoint?: Record<string, unknown> } | null)?.__endpoint;
        return endpoint !== undefined && endpoint.scheduleTrigger !== undefined;
      })
      .map(([nome]) => nome);
    expect(exportados.sort()).toEqual(Object.keys(AGENDAMENTOS).sort());
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
