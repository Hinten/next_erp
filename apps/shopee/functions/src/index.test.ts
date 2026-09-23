import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { SHOPEE_STOCK_SEND_QUEUE } from '../../lib/shopee/estoque/constantesEstoque';
import { LOST_PUSH_RETENTION_HOURS } from '../../lib/shopee/notificacoes/lostPushSweep';
import { SHOPEE_NOTIFICATION_QUEUE } from '../../lib/shopee/notificacoes/notificacao';
import { SHOPEE_MASS_IMPORT_QUEUE } from '../../lib/shopee/produtos/importacaoMassa';

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
  processShopeeMassImport,
  processShopeeNotification,
  reprocessShopeeNotifications,
  sendShopeeStock,
  sweepShopeeAuthorizationExpiry,
  sweepShopeeEscrowSettlement,
  sweepShopeeLostPushes,
  sweepShopeeStock,
  sweepShopeeStockDaily,
  sweepShopeeStockReconciliacao,
  sweepShopeeStuckReservations,
  onProdutoShopeeLinkChanged,
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
  sweepShopeeEscrowSettlement,
  sweepShopeeStuckReservations,
  sweepShopeeStock,
  sweepShopeeStockDaily,
  sweepShopeeStockReconciliacao,
} as const;

/**
 * Every TASK-QUEUE trigger this codebase exports — the sibling map of
 * {@link AGENDAMENTOS}, and it exists for the same reason.
 *
 * ⚠️ The exhaustiveness test below walks `scheduleTrigger` ONLY, so before this
 * map a `taskQueueTrigger` export was invisible to it: `processShopeeNotification`
 * has run every Shopee delivery since step 3 while nothing in this file could
 * see it, and its `timeoutSeconds` went from an implicit 60 to an explicit 300
 * in step 5 with the whole assertion living in one sibling file. The second task
 * function the note above predicted arrived in step 9 (`processShopeeMassImport`,
 * the mass product import) and landed COVERED — the exact-secrets set, the
 * explicit timeout and the ≤ 1800 s ladder below all applied to it the moment it
 * was added here, with no new assertion written.
 *
 * The THIRD arrived in step 12 (`sendShopeeStock`, the stock push) and landed
 * COVERED for the same reason — the exact-secrets set, the explicit timeout and
 * the ≤ 1800 s ladder all applied to it the moment it was added here, with no
 * new assertion written. Its own numbers (120 s, and that the handler never
 * sets `ignoreSyncFlag`) are in `sendStock.test.ts`.
 *
 * Each queue's per-option assertions stay in its own sibling file
 * (`processNotification.test.ts`, `processMassImport.test.ts`,
 * `sendStock.test.ts`), which mock their channels; what lives HERE is the
 * cross-cutting set — the exact secrets, the retry cap, the timeout, the ladder
 * — plus the completeness check.
 */
const FILAS = { processShopeeNotification, processShopeeMassImport, sendShopeeStock } as const;

/**
 * Every FIRESTORE-TRIGGER export of this codebase — the third sibling of
 * {@link AGENDAMENTOS} and {@link FILAS}, and it exists for the same reason.
 *
 * ⚠️ Both exhaustiveness tests below filter on `scheduleTrigger` /
 * `taskQueueTrigger`. A gen2 Firestore trigger carries **`eventTrigger`**, so
 * it is enumerated by NEITHER — before this map an `onDocument*` export had its
 * region, its `database`, its `secrets` and its `retry` read by NOTHING. Step
 * 11 (#1519) added the codebase's first one, which is the third batch to land
 * in a file whose framing once said "the two triggers".
 *
 * The failure this guards is the silent one, and it is the single most
 * expensive typo in the repo: an `onDocument*` that omits `database` — or
 * spells it `(default)` — deploys fine, binds to a database that does not exist
 * and NEVER FIRES, with nothing anywhere to say so.
 */
const GATILHOS = { onProdutoShopeeLinkChanged } as const;

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

function gatilhoDe(fn: unknown): { schedule?: string; timeZone?: string } {
  return endpointOf(fn).scheduleTrigger as { schedule?: string; timeZone?: string };
}

function gatilhoDeEvento(fn: unknown): {
  eventFilters?: Record<string, string>;
  eventFilterPathPatterns?: Record<string, string>;
  retry?: boolean;
} {
  return endpointOf(fn).eventTrigger as {
    eventFilters?: Record<string, string>;
    eventFilterPathPatterns?: Record<string, string>;
    retry?: boolean;
  };
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

describe('sweepShopeeEscrowSettlement', () => {
  it('roda SEMANALMENTE, segunda 05:10 America/Sao_Paulo', () => {
    // Weekly is the cadence of the thing being read: an escrow release lags
    // delivery by 7–15 days, so a daily walk would spend six days out of seven
    // re-reading a window whose every row answers `ignorado-sem-mudanca`. The
    // MINUTE is the other half — :10 keeps the sweep clear of :00/:15/:30/:45
    // (backfill + reprocess) and :20 (lost push), and it sits between the 04:00
    // expiry walk and the 05:45 push monitor, all of which draw on ONE
    // undocumented partner rate-limit budget.
    expect(gatilhoDe(sweepShopeeEscrowSettlement).schedule).toBe('10 5 * * 1');
    expect(gatilhoDe(sweepShopeeEscrowSettlement).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO é um cron diário — a quase-colisão que um `toContain` deixaria passar', () => {
    // `'10 5 * * *'` is ONE character away, reads identically at a glance, and is
    // a real design alternative that was considered and rejected — which is
    // exactly what makes it dangerous. It would multiply `get_escrow_list` and
    // `get_escrow_detail` by seven against an endpoint whose published rate
    // limit is an empty string.
    expect(gatilhoDe(sweepShopeeEscrowSettlement).schedule).not.toBe('10 5 * * *');
  });

  it('tem timeoutSeconds 540 — 300 liquidações sequenciais mais 20 páginas', () => {
    // Each settlement is one `get_escrow_detail` plus one transaction (~1.2 s),
    // so the per-tick budget is ≈ 370 s and 540 is the gen2 ceiling it is sized
    // against. The gen2 60s default cannot absorb it, and a timeout mid-window
    // advances NOTHING — the tick simply repeats.
    expect(endpointOf(sweepShopeeEscrowSettlement).timeoutSeconds).toBe(540);
  });

  it('vincula exatamente as duas credenciais de parceiro', () => {
    // Every `get_escrow_list`/`get_escrow_detail` is HMAC-signed with the partner
    // key even though it is Shop-signed: the token rides in the query, the
    // signature does not.
    const serializado = JSON.stringify(endpointOf(sweepShopeeEscrowSettlement));
    for (const segredo of SEGREDOS) expect(serializado).toContain(segredo);
  });
});

describe('sweepShopeeStuckReservations', () => {
  it('roda SEMANALMENTE, segunda 04:40 America/Sao_Paulo', () => {
    // Weekly is the cadence of the thing being read, twice over. The HORIZON is
    // what bounds the lateness — `SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D` is 7 days
    // and a weekly tick makes that an EFFECTIVE 7–14, since a pedido that goes
    // stale just after a tick waits for the next one — and a daily walk would
    // re-read the SAME stuck population seven times, because a reservation
    // nobody released is still stuck tomorrow. That is seven times the
    // `get_order_detail` budget against an endpoint whose published rate limit
    // is `[0,0,0]`, i.e. unknown. The MINUTE is the other half: :40 keeps it
    // clear of :00/:10/:15/:20/:30/:45 (every sibling schedule) and sits between
    // the 04:00 expiry walk and the 05:10 settlement sweep, all of which draw on
    // ONE undocumented partner rate-limit budget.
    expect(gatilhoDe(sweepShopeeStuckReservations).schedule).toBe('40 4 * * 1');
    expect(gatilhoDe(sweepShopeeStuckReservations).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO é um cron diário — a quase-colisão que um `toContain` deixaria passar', () => {
    // `'40 4 * * *'` is ONE character away, reads identically at a glance, and
    // would multiply the Shopee calls by seven over a population that does not
    // change between ticks — for no extra information at all.
    expect(gatilhoDe(sweepShopeeStuckReservations).schedule).not.toBe('40 4 * * *');
  });

  it('tem timeoutSeconds 540 — 10 páginas, 200 leituras de pagamento e até 204 chamadas por conta', () => {
    // Up to MAX_PAGINAS (10) paged candidate queries of PAGE_LIMIT (200), one
    // whole `pagamentos` subcollection read per candidate (≤ 200), then per
    // conta ⌈200/50⌉ = 4 batched `get_order_detail` calls — up to 204 when an
    // unknown `order_sn` forces the per-order fallback on every batch — plus
    // ≤ 200 enqueues and ≤ 200 aviso round trips, all SEQUENTIAL. That is a
    // ≈ 300 s budget and 540 is the gen2 ceiling it is sized against, so the
    // ceiling is margin rather than a claim that nine minutes is normal. The
    // gen2 60s default cannot absorb even the first batch, and a timeout
    // mid-tick writes nothing partial — there is no cursor document.
    expect(endpointOf(sweepShopeeStuckReservations).timeoutSeconds).toBe(540);
  });

  it('vincula exatamente as duas credenciais de parceiro', () => {
    // Every `get_order_detail` is HMAC-signed with the partner key even though
    // it is Shop-signed: the token rides in the query, the signature does not.
    const serializado = JSON.stringify(endpointOf(sweepShopeeStuckReservations));
    for (const segredo of SEGREDOS) expect(serializado).toContain(segredo);
  });
});

describe('sweepShopeeStock (incremental, passo 12)', () => {
  it('roda a cada quarto de hora nos minutos :10 :25 :40 :55', () => {
    // ⚠️ Os MINUTOS são escolhidos, não herdados, e DUAS sobreposições semanais
    // são aceitas. Dos sete agendamentos que esta codebase já roda, CINCO fixam
    // um minuto — :00 (expiração), :10 (liquidação, segundas 05:10), :20
    // (pushes perdidos), :40 (reservas travadas, segundas 04:40) e :45 (monitor
    // de push, DIÁRIO às 05:45) — e dois são intervalos sem minuto fixo
    // (`every 30 minutes`, `every 15 minutes`). O conjunto ocupado é, portanto,
    // {:00, :10, :15, :20, :30, :40, :45}, e `:10/:25/:40/:55` encontra dois
    // deles: segunda 05:10 com `sweepShopeeEscrowSettlement` (até 300
    // `get_escrow_detail` por conta) e segunda 04:40 com
    // `sweepShopeeStuckReservations` (até 204 `get_order_detail` por conta).
    // Ambas são semanais e ambas sacam do mesmo orçamento por APLICAÇÃO; a
    // saída sem colisão nenhuma é `12,27,42,57`. ⚠️ `monitorShopeePushConfig`
    // NÃO é vizinho deste tique: ele roda `45 5 * * *`.
    expect(gatilhoDe(sweepShopeeStock).schedule).toBe('10,25,40,55 * * * *');
    expect(gatilhoDe(sweepShopeeStock).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ as sobreposições são DERIVADAS dos crons, não afirmadas no comentário', () => {
    // O comentário acima já esteve errado três vezes (um vizinho trocado, dois
    // minutos ausentes do conjunto "ocupado" e uma sobreposição não nomeada), e
    // um comentário é o único registro de por que estes quatro minutos foram
    // sacados de um orçamento que a Shopee não publica. Isto o deriva.
    const minutosFixos = new Map<string, number[]>();
    for (const [nome, fn] of Object.entries(AGENDAMENTOS)) {
      const campo = (gatilhoDe(fn).schedule ?? '').split(' ')[0] ?? '';
      // `every 30 minutes` e `every 15 minutes` não ancoram minuto nenhum.
      if (!/^\d+(,\d+)*$/.test(campo)) continue;
      minutosFixos.set(
        nome,
        campo.split(',').map((m) => Number(m)),
      );
    }
    // Os dois `every N minutes` não ancoram minuto nenhum.
    expect([...minutosFixos.keys()].sort()).toEqual(
      [
        'monitorShopeePushConfig',
        'sweepShopeeAuthorizationExpiry',
        'sweepShopeeEscrowSettlement',
        'sweepShopeeLostPushes',
        'sweepShopeeStock',
        'sweepShopeeStockDaily',
        'sweepShopeeStockReconciliacao',
        'sweepShopeeStuckReservations',
      ].sort(),
    );

    // As três varreduras de estoque são a MESMA família (o tique incremental
    // pula os slots 02:10 e 03:10 em código), então os vizinhos são os outros.
    const daFamilia = new Set([
      'sweepShopeeStock',
      'sweepShopeeStockDaily',
      'sweepShopeeStockReconciliacao',
    ]);
    const doTique = new Set([10, 25, 40, 55]);
    const vizinhos = [...minutosFixos.entries()]
      .filter(([nome, minutos]) => !daFamilia.has(nome) && minutos.some((m) => doTique.has(m)))
      .map(([nome]) => nome)
      .sort();
    // ⚠️ EXATAMENTE os dois semanais que o comentário nomeia — e o monitor de
    // push NÃO está entre eles (`45 5 * * *`, diário).
    expect(vizinhos).toEqual(['sweepShopeeEscrowSettlement', 'sweepShopeeStuckReservations']);
    expect(minutosFixos.get('monitorShopeePushConfig')).toEqual([45]);
    expect(minutosFixos.get('sweepShopeeStock')).toEqual([...doTique]);
  });

  it('⚠️ NÃO é `5,20,35,50` — a quase-colisão medida', () => {
    // O par de quase-falha, e ele existe porque o primeiro desenho ERA este: a
    // varredura de pushes perdidos roda `20 */2 * * *`, então `:20` colide com
    // ela em toda hora par. As duas leriam idênticas numa revisão e o custo é
    // invisível — duas famílias de chamadas Shopee no mesmo minuto, no mesmo
    // orçamento não publicado.
    expect(gatilhoDe(sweepShopeeStock).schedule).not.toBe('5,20,35,50 * * * *');
  });

  it('tem timeoutSeconds 540 — N contas × páginas × enfileiramentos sequenciais', () => {
    // Pior caso por tick: N contas, cada uma com as páginas de descoberta
    // limitadas por `MAX_PAGES_PER_SWEEP` e até `maxTasksPerSweep()`
    // enfileiramentos SEQUENCIAIS no Cloud Tasks. O padrão gen2 de 60 s não
    // absorve isso, e 540 é o mesmo teto das outras varreduras por conta.
    expect(endpointOf(sweepShopeeStock).timeoutSeconds).toBe(540);
  });
});

describe('sweepShopeeStockDaily (diário, passo 12)', () => {
  it('roda 02:10 America/Sao_Paulo', () => {
    // O slot é DELE: o wrapper incremental pula exatamente este tick em código,
    // porque um cron não consegue dizer "a cada quarto de hora EXCETO este".
    // Assim os dois nunca disputam os limites, o documento de estado nem a
    // continuação de uma mesma conta.
    expect(gatilhoDe(sweepShopeeStockDaily).schedule).toBe('10 2 * * *');
    expect(gatilhoDe(sweepShopeeStockDaily).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO roda às 02:00 — o minuto é o que separa os dois blocos de horário', () => {
    // `'0 2 * * *'` é o cron do gêmeo do Mercado Livre e é o que uma cópia
    // traria junto. Aqui ele cairia no minuto :00, que já é um minuto ocupado
    // nesta codebase, e faria os pulos em código do incremental — que testam a
    // faixa [10, 25) — deixarem de casar com o slot do diário.
    expect(gatilhoDe(sweepShopeeStockDaily).schedule).not.toBe('0 2 * * *');
  });
});

describe('sweepShopeeStockReconciliacao (mensal, passo 12)', () => {
  it('roda 03:10 America/Sao_Paulo no dia 1', () => {
    expect(gatilhoDe(sweepShopeeStockReconciliacao).schedule).toBe('10 3 1 * *');
    expect(gatilhoDe(sweepShopeeStockReconciliacao).timeZone).toBe('America/Sao_Paulo');
  });

  it('⚠️ NÃO é um cron DIÁRIO — um caractere separa uma passagem mensal de trinta', () => {
    // `'10 3 * * *'` está a um caractere e leria igual. A reconciliação FORÇA o
    // envio de toda família descoberta (`changedSinceMs = -1`), então rodá-la
    // todo dia é trinta varreduras completas do catálogo por mês contra um
    // limite de chamadas que a Shopee não publica — e não traria informação
    // nova, porque é justamente a deriva lenta que ela corrige.
    expect(gatilhoDe(sweepShopeeStockReconciliacao).schedule).not.toBe('10 3 * * *');
    expect(gatilhoDe(sweepShopeeStockReconciliacao).schedule).not.toBe('10 3 1 * 1');
  });
});

describe('onProdutoShopeeLinkChanged', () => {
  it('escuta produtos/{produtoId}/prodshopee/{linkId}', () => {
    // ⚠️ Pinned against the HANDLE's own path, not a second literal. The leaf
    // name is the VERIFIED Flutter one (#289) — the guessed `produtoshopee`
    // never matched a collection Flutter writes, and the failure was silent:
    // the trigger simply never fires, exactly like a wrong `database`.
    const doHandle = produtoShopeeLinkCollection.resolvePath({ produtoId: '{produtoId}' });

    expect(gatilhoDeEvento(onProdutoShopeeLinkChanged).eventFilterPathPatterns?.document).toBe(
      `${doHandle}/{linkId}`,
    );
    // ÂNCORA: the handle really resolved a wildcard path, so the comparison
    // above cannot be two `undefined`s agreeing.
    expect(doHandle).toBe('produtos/{produtoId}/prodshopee');
  });

  it("⚠️ liga-se ao banco NOMEADO 'default' — não a '(default)'", () => {
    // THE load-bearing assertion of this describe, and it MUST be an exact
    // equality on the parsed field — never a `JSON.stringify(...)
    // .toContain('default')`. The serialized endpoint always carries
    // `"namespace":"(default)"`, and an OMITTED `database` defaults to
    // `"(default)"` too, so a substring check passes in every case and guards
    // nothing. Firestore Enterprise names this project's database literally
    // `default`; a trigger bound to `(default)` deploys fine and never fires.
    expect(gatilhoDeEvento(onProdutoShopeeLinkChanged).eventFilters?.database).toBe('default');
  });

  it("⛔ QUASE-FALHA: um database '(default)' ou ausente é REPROVADO", () => {
    // The near-miss of the assertion above, spelled as the two things a
    // `toContain` cannot distinguish: the sentinel spelling, and no value at
    // all.
    const banco = gatilhoDeEvento(onProdutoShopeeLinkChanged).eventFilters?.database;

    expect(banco).toBeDefined();
    expect(banco).not.toBe('(default)');
  });

  it('declara a região inlinada', () => {
    // ⚠️ Inherited from `setGlobalOptions` (options.ts), NOT declared per
    // function — which is the codebase's own pattern and the reason it is worth
    // asserting: the registration rides the bare `import './options'` at the
    // TOP of index.ts, and a duplicate import further down would merge into it
    // and move the registration AFTER the trigger modules. The functions then
    // deploy fine, to the wrong region (#1108).
    expect(endpointOf(onProdutoShopeeLinkChanged).region).toEqual([process.env.FUNCTIONS_REGION]);
  });

  it('declara retry: true', () => {
    // At-least-once redelivery for TRANSIENT Firestore failures. It is safe
    // ONLY because of how each arm is written: the add is an `arrayUnion`
    // (commutative, idempotent) and the remove re-derives its verdict from a
    // guarded re-read of what is stored NOW — a redelivery replays the ORIGINAL
    // CloudEvent, i.e. the same stale before/after snapshots.
    expect(gatilhoDeEvento(onProdutoShopeeLinkChanged).retry).toBe(true);
  });

  it('NÃO vincula segredo nenhum — nunca chama a Shopee', () => {
    // The sibling of the exact-set assertions below, in the opposite direction.
    // `secrets:` is a whitelist an operator grants one by one, and a needless
    // binding is one more Secret Manager grant that can 403 the function at
    // startup — taking down the owner of `integracoesComProduto`, which is the
    // anchor pre-filter every sweep opens with.
    expect(endpointOf(onProdutoShopeeLinkChanged).secretEnvironmentVariables ?? []).toEqual([]);
  });

  it('⚠️ o id do banco é INLINADO pelo build.mjs, não lido em execução', () => {
    // ⚠️ This has to be a SOURCE assertion, because no runtime assertion can
    // see it: unbundled, `process.env.FIREBASE_DATABASE_ID ?? 'default'`
    // answers `'default'` whether the build inlined anything or not, so the
    // exact-equality test above stays green over the mutation that matters.
    // What breaks in the cloud is narrower — Firebase reads no env during
    // codebase ANALYSIS, so without the `define` the analyzed endpoint carries
    // `undefined` and the trigger is registered against the non-existent
    // `(default)`.
    //
    // ⚠️ `src/lib/admin.ts` reading the same variable at RUNTIME for `getDb()`
    // is a DIFFERENT thing and does not cover this — a reader who sees it there
    // concludes the variable is already handled.
    const build = readFileSync(fileURLToPath(new URL('../build.mjs', import.meta.url)), 'utf8');

    expect(build).toContain("'process.env.FIREBASE_DATABASE_ID': JSON.stringify(databaseId)");
    expect(build).toContain("process.env.FIREBASE_DATABASE_ID || 'default'");
    // ÂNCORA: the file really was read and really is this codebase's build.
    expect(build).toContain("'process.env.FUNCTIONS_REGION': JSON.stringify(region)");
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
    // TEN on the same cron would satisfy every per-function assertion above
    // taken one at a time, and would run one of them twice while the other
    // never ran at all. ⚠️ TEN since step 12 added the three stock sweeps —
    // which are also the likeliest copy-paste pair in the map, since they are
    // three wrappers over one function.
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

  it('todo gatilho de evento exportado está coberto por GATILHOS', () => {
    // A terceira gêmea, e a que fechou o buraco maior: as duas asserções acima
    // percorrem `scheduleTrigger` / `taskQueueTrigger`, então um `onDocument*`
    // exportado não era lido por NADA — nem a região, nem o `database`, nem os
    // segredos, nem o `retry`. O passo 11 (#1519) trouxe o primeiro desta
    // codebase, e é isto que torna crescer o mapa obrigatório em vez de
    // lembrado.
    const exportados = Object.entries(modulo as unknown as Record<string, unknown>)
      .filter(([, valor]) => {
        const endpoint = (valor as { __endpoint?: Record<string, unknown> } | null)?.__endpoint;
        return endpoint !== undefined && endpoint.eventTrigger !== undefined;
      })
      .map(([nome]) => nome);
    expect(exportados.sort()).toEqual(Object.keys(GATILHOS).sort());
  });

  it('as TRÊS famílias são DISJUNTAS — nada é agendamento, fila e gatilho ao mesmo tempo', () => {
    // Um export que aparecesse em dois mapas satisfaria as duas asserções de
    // exaustividade correspondentes e teria as suas opções lidas pelo conjunto
    // errado. Os TRÊS pares, não só o primeiro: com três famílias há três
    // maneiras de duplicar, e duas delas passariam por uma verificação escrita
    // para duas.
    const familias = { AGENDAMENTOS, FILAS, GATILHOS };
    const pares = [
      ['AGENDAMENTOS', 'FILAS'],
      ['AGENDAMENTOS', 'GATILHOS'],
      ['FILAS', 'GATILHOS'],
    ] as const;

    for (const [a, b] of pares) {
      const naPrimeira = new Set(Object.keys(familias[a]));
      for (const nome of Object.keys(familias[b])) {
        expect(naPrimeira.has(nome), `${nome} está em ${a} E em ${b}`).toBe(false);
      }
    }
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

describe('processShopeeMassImport', () => {
  it('é a SEGUNDA fila da codebase', () => {
    // ⚠️ Não é contagem por contagem. Até o passo 9 esta codebase tinha UMA
    // fila, e o docblock do `FILAS` registra o buraco em que ela viveu: o teste
    // de exaustividade percorre `scheduleTrigger`, então um segundo
    // `onTaskDispatched` que ninguém pusesse no mapa subiria, receberia
    // despachos e teria as suas opções lidas por NADA. Esta asserção é o que
    // torna o mapa um fato verificável em vez de uma lista que alguém lembrou
    // de crescer: as filas são exportadas, são DISTINTAS entre si, e o módulo
    // não exporta uma a mais (isso é do teste de exaustividade acima).
    //
    // ⚠️ O passo 12 trouxe a TERCEIRA (`sendShopeeStock`) e é por isto que os
    // dois literais abaixo moram aqui: um mapa que cresce sem que a contagem
    // cresça junto volta a ser uma lista, e a asserção passaria descrevendo
    // uma codebase que não existe mais.
    const comFila = Object.entries(modulo as unknown as Record<string, unknown>)
      .filter(([, valor]) => {
        const endpoint = (valor as { __endpoint?: Record<string, unknown> } | null)?.__endpoint;
        return endpoint !== undefined && endpoint.taskQueueTrigger !== undefined;
      })
      .map(([nome]) => nome);
    expect(comFila.sort()).toEqual([
      'processShopeeMassImport',
      'processShopeeNotification',
      'sendShopeeStock',
    ]);
    expect(Object.keys(FILAS)).toHaveLength(3);
    expect(processShopeeMassImport).not.toBe(processShopeeNotification);
    expect(sendShopeeStock).not.toBe(processShopeeMassImport);
  });

  it('o nome do export é exatamente SHOPEE_MASS_IMPORT_QUEUE', () => {
    // Gêmea da asserção da fila de notificação, e o risco é MAIOR aqui: esta
    // função reenfileira contra a própria fila a cada continuação de varredura
    // ou de dreno, então um rename pela metade não quebra o começo do job —
    // quebra a CONTINUAÇÃO, e o job fica `running` para sempre sem nada que o
    // re-conduza. `index.ts` afirma o par na carga do módulo (a análise de
    // codebase do Firebase falha alto); isto fixa a mesma propriedade offline.
    expect(SHOPEE_MASS_IMPORT_QUEUE in modulo).toBe(true);
    expect((modulo as unknown as Record<string, unknown>)[SHOPEE_MASS_IMPORT_QUEUE]).toBeDefined();
    expect(SHOPEE_MASS_IMPORT_QUEUE).not.toBe(SHOPEE_NOTIFICATION_QUEUE);
  });
});

describe('sendShopeeStock (passo 12)', () => {
  it('é a TERCEIRA fila, e o nome do export é exatamente SHOPEE_STOCK_SEND_QUEUE', () => {
    // Gêmea das duas asserções acima, e aqui o risco é o MAIOR dos três: esta
    // função reenfileira contra a PRÓPRIA fila em dois braços — a conta pausada
    // e o 429 — então um rename pela metade não quebra o primeiro despacho,
    // quebra a varredura NO MEIO. As tasks que saíram antes da pausa chegaram,
    // as reenfileiradas miram uma fila que não existe, e toda superfície segue
    // reportando sucesso enquanto aqueles anúncios ficam com a quantidade
    // antiga. `index.ts` afirma o par na carga do módulo (a análise de codebase
    // do Firebase falha alto); isto fixa a mesma propriedade offline.
    expect(SHOPEE_STOCK_SEND_QUEUE in modulo).toBe(true);
    expect((modulo as unknown as Record<string, unknown>)[SHOPEE_STOCK_SEND_QUEUE]).toBeDefined();
    expect(SHOPEE_STOCK_SEND_QUEUE).not.toBe(SHOPEE_NOTIFICATION_QUEUE);
    expect(SHOPEE_STOCK_SEND_QUEUE).not.toBe(SHOPEE_MASS_IMPORT_QUEUE);
  });

  it('a terceira trava de rename é um `if` PRÓPRIO que nomeia o seu arquivo', () => {
    // ⚠️ O que está sendo fixado não é "existe uma trava" — é que ela nomeia o
    // ARQUIVO a consertar. Um laço sobre as três constantes satisfaria qualquer
    // asserção de "o par foi comparado" e produziria uma mensagem com o caminho
    // INTERPOLADO; quem lê o erro no meio de um deploy precisa do caminho
    // literal, e as três constantes moram em três módulos diferentes.
    //
    // A asserção é textual porque a propriedade é textual: a frase inteira,
    // caminho incluído, tem de existir como UM literal. Um
    // `` `…drift: functions/src/${arquivo} must export…` `` não contém esta
    // substring, e é exatamente esse o mutante.
    const fonte = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

    expect(fonte).toContain(
      "'[shopee] function-name drift: functions/src/sendStock.ts must export a '",
    );
    expect(fonte).toContain('if (!(SHOPEE_STOCK_SEND_QUEUE in stockSendHandlers))');
    // ÂNCORA: as três travas são três, e cada uma nomeia um arquivo diferente —
    // uma frase que aparecesse duas vezes seria uma cópia que esqueceu o nome.
    const travas = fonte.match(/function-name drift: functions\/src\/[A-Za-z]+\.ts/g) ?? [];
    expect(travas.sort()).toEqual([
      'function-name drift: functions/src/processMassImport.ts',
      'function-name drift: functions/src/processNotification.ts',
      'function-name drift: functions/src/sendStock.ts',
    ]);
  });
});
