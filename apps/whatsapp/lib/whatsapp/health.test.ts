import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthCheck, WhatsappHealth } from './health';

// loadWhatsappContext + the admin collections are mocked; the WhatsAppClient is
// REAL and driven by an injected fake fetch (deps.fetch). The aggregator's own
// folding logic (probe → check rows, verdicts, self-heal) runs real.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  load: vi.fn(),
  merge: vi.fn(async () => undefined),
  conversaGet: vi.fn(),
  countGet: vi.fn(),
  /** `[field, value]` pairs from the notificacoes count query's `.where()`s. */
  notifWhereCalls: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/whatsapp/whatsapp', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/whatsapp')>();
  return { ...actual, loadWhatsappContext: h.loadCtx };
});

vi.mock('@delfrance/data/admin/collections', () => {
  const chain = (
    getFn: () => Promise<unknown>,
    onWhere?: (field: string, value: unknown) => void,
  ): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    b.where = (field: string, _op: string, value: unknown) => {
      onWhere?.(field, value);
      return b;
    };
    b.orderBy = () => b;
    b.limit = () => b;
    b.count = () => ({ get: getFn });
    b.get = getFn;
    return b;
  };
  return {
    conversaCollection: { ref: () => chain(h.conversaGet) },
    notificacoesWhatsappCollection: {
      ref: () => chain(h.countGet, (field, value) => h.notifWhereCalls.push([field, value])),
    },
    integracaoCollection: { merge: h.merge },
  };
});

const { buildWhatsappHealth } = await import('./health');

const NOW = 1_700_000_000_000;

/** Fake fetch: routes the phone-node GET and the subscribed_apps GET by URL. */
function fakeFetch(opts: {
  phone?: { status: number; body: unknown };
  subs?: { status: number; body: unknown };
}) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/subscribed_apps')) {
      const r = opts.subs ?? { status: 200, body: { data: [] } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    const r = opts.phone ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

const FULL_ENV = { WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v' };

function check(health: WhatsappHealth, id: string): HealthCheck {
  const c = health.checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.notifWhereCalls.length = 0;
  h.load.mockResolvedValue({ permanent_token: 'TKN', pin: null });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'i1',
    // `wa_id` carries the same value as phoneNumberId (the documented norm) —
    // the notificacoes_failed check keys on IT, not on phoneNumberId.
    conta: { phoneNumberId: 'PID', wa_id: 'PID', waba_id: 'WABA', verificado: false },
    store: { load: h.load },
  });
  h.conversaGet.mockResolvedValue({
    docs: [{ data: () => ({ ultimaModificacaoIntegracao: NOW - 3_600_000 }) }],
  });
  h.countGet.mockResolvedValue({ data: () => ({ count: 0 }) });
});

describe('buildWhatsappHealth — all green', () => {
  it('produces all-ok checks, canSend/canReceive true, and self-heals verificado', async () => {
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: {
          status: 200,
          body: {
            status: 'CONNECTED',
            quality_rating: 'GREEN',
            code_verification_status: 'VERIFIED',
          },
        },
        subs: {
          status: 200,
          body: { data: [{ whatsapp_business_api_data: { name: 'Meu ERP' } }] },
        },
      }),
      env: FULL_ENV,
      now: () => NOW,
    });

    expect(health.generatedAt).toBe(NOW);
    expect(check(health, 'token').status).toBe('ok');
    expect(check(health, 'phone_status').status).toBe('ok');
    expect(check(health, 'quality').status).toBe('ok');
    expect(check(health, 'code_verification').status).toBe('ok');
    expect(check(health, 'webhook_subscription').status).toBe('ok');
    expect(check(health, 'webhook_subscription').detail).toBe('Meu ERP');
    expect(check(health, 'webhook_secret').status).toBe('ok');
    expect(check(health, 'inbound_recent').status).toBe('ok');
    expect(check(health, 'inbound_recent').detail).toMatch(/há 1 h/);
    expect(check(health, 'notificacoes_failed').status).toBe('ok');
    expect(health.canSend).toBe(true);
    expect(health.canReceive).toBe(true);
    // Graph says VERIFIED but conta.verificado === false → self-heal write.
    expect(h.merge).toHaveBeenCalledWith(expect.anything(), {}, 'i1', { verificado: true });
  });

  it('does not self-heal when the account is already verified', async () => {
    h.loadCtx.mockResolvedValue({
      integracaoId: 'i1',
      conta: { phoneNumberId: 'PID', waba_id: 'WABA', verificado: true },
      store: { load: h.load },
    });
    await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: { status: 200, body: { status: 'CONNECTED', code_verification_status: 'VERIFIED' } },
        subs: { status: 200, body: { data: [{ whatsapp_business_api_data: { name: 'X' } }] } },
      }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(h.merge).not.toHaveBeenCalled();
  });
});

describe('buildWhatsappHealth — token / status matrix', () => {
  it('token fail (reauth) on a 401 probe; downstream phone checks skip; canSend false', async () => {
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 401, body: { error: { code: 190 } } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'token').status).toBe('fail');
    expect(check(health, 'token').detail).toMatch(/reconecte/i);
    expect(check(health, 'phone_status').status).toBe('skip');
    expect(check(health, 'quality').status).toBe('skip');
    expect(check(health, 'code_verification').status).toBe('skip');
    expect(health.canSend).toBe(false);
  });

  it('token fail when no token is stored', async () => {
    h.load.mockResolvedValue(null);
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({}),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'token').status).toBe('fail');
    expect(check(health, 'token').detail).toMatch(/Nenhum token/);
    expect(health.canSend).toBe(false);
  });

  it('phone_status fail (not CONNECTED) surfaces the raw value as detail', async () => {
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 200, body: { status: 'PENDING' } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'phone_status').status).toBe('fail');
    expect(check(health, 'phone_status').detail).toBe('PENDING');
    expect(health.canSend).toBe(false);
  });

  it('quality maps RED→fail, YELLOW/UNKNOWN→warn', async () => {
    const red = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: { status: 200, body: { status: 'CONNECTED', quality_rating: 'RED' } },
      }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(red, 'quality').status).toBe('fail');

    const yellow = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: { status: 200, body: { status: 'CONNECTED', quality_rating: 'YELLOW' } },
      }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(yellow, 'quality').status).toBe('warn');
  });

  it('phone probe skipped when phoneNumberId is null; notificacoes skipped without wa_id', async () => {
    h.loadCtx.mockResolvedValue({
      integracaoId: 'i1',
      conta: { phoneNumberId: null, wa_id: null, waba_id: 'WABA', verificado: false },
      store: { load: h.load },
    });
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({}),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'phone_status').status).toBe('skip');
    expect(check(health, 'notificacoes_failed').status).toBe('skip');
  });

  it('notificacoes_failed keys on wa_id — a receive-only conta (phoneNumberId null) is still counted', async () => {
    h.loadCtx.mockResolvedValue({
      integracaoId: 'i1',
      conta: { phoneNumberId: null, wa_id: 'WEBHOOK_PID', waba_id: 'WABA', verificado: false },
      store: { load: h.load },
    });
    h.countGet.mockResolvedValue({ data: () => ({ count: 2 }) });
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({}),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'notificacoes_failed').status).toBe('warn');
    // The failure docs carry the webhook's metadata.phone_number_id, matched
    // against conta.wa_id by the pipeline — the count MUST filter by wa_id.
    expect(h.notifWhereCalls).toContainEqual(['phoneNumberId', 'WEBHOOK_PID']);
  });
});

describe('buildWhatsappHealth — webhook + verdicts', () => {
  it('subscription skip when waba_id is null → canReceive null', async () => {
    h.loadCtx.mockResolvedValue({
      integracaoId: 'i1',
      conta: { phoneNumberId: 'PID', waba_id: null, verificado: false },
      store: { load: h.load },
    });
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 200, body: { status: 'CONNECTED' } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'webhook_subscription').status).toBe('skip');
    expect(check(health, 'webhook_subscription').detail).toBe('Preencha o WABA ID');
    expect(health.canReceive).toBeNull();
  });

  it('subscription fail (no apps) → canReceive false', async () => {
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: { status: 200, body: { status: 'CONNECTED' } },
        subs: { status: 200, body: { data: [] } },
      }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'webhook_subscription').status).toBe('fail');
    expect(health.canReceive).toBe(false);
  });

  it('webhook_secret fail when an env var is missing → canReceive false', async () => {
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({
        phone: { status: 200, body: { status: 'CONNECTED' } },
        subs: { status: 200, body: { data: [{ whatsapp_business_api_data: { name: 'X' } }] } },
      }),
      env: { WHATSAPP_APP_SECRET: 'SUPERSECRETVALUE' }, // WHATSAPP_VERIFY_TOKEN missing
      now: () => NOW,
    });
    expect(check(health, 'webhook_secret').status).toBe('fail');
    expect(check(health, 'webhook_secret').detail).toMatch(/WHATSAPP_VERIFY_TOKEN/);
    // Presence only — the secret VALUE is never echoed.
    expect(check(health, 'webhook_secret').detail).not.toContain('SUPERSECRETVALUE');
    expect(health.canReceive).toBe(false);
  });

  it('inbound_recent warns when there are no conversas', async () => {
    h.conversaGet.mockResolvedValue({ docs: [] });
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 200, body: { status: 'CONNECTED' } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'inbound_recent').status).toBe('warn');
  });

  it('notificacoes_failed warns with the count when failures exist', async () => {
    h.countGet.mockResolvedValue({ data: () => ({ count: 3 }) });
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 200, body: { status: 'CONNECTED' } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'notificacoes_failed').status).toBe('warn');
    expect(check(health, 'notificacoes_failed').detail).toMatch(/3/);
  });

  it('a query probe failure degrades to a warn row, never a throw', async () => {
    h.conversaGet.mockRejectedValue(new Error('firestore unavailable'));
    h.countGet.mockRejectedValue(new Error('firestore unavailable'));
    const health = await buildWhatsappHealth({} as never, 'i1', {
      fetch: fakeFetch({ phone: { status: 200, body: { status: 'CONNECTED' } } }),
      env: FULL_ENV,
      now: () => NOW,
    });
    expect(check(health, 'inbound_recent').status).toBe('warn');
    expect(check(health, 'notificacoes_failed').status).toBe('warn');
  });
});
