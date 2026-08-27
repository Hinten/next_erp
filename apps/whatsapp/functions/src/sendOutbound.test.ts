import { afterAll, describe, expect, it, vi } from 'vitest';

// `sendOutbound.ts` takes its `region:` from `./options`, which is where the
// build-time-inlined FUNCTIONS_REGION is validated once — so the region cannot be
// a per-function literal that quietly outvotes that check. Unbundled, that
// validation is exactly what throws, so stub the variable before the dynamic
// import below and restore it afterwards so it does not leak into other files
// sharing this vitest project. Mirrors the sibling pattern in
// apps/mercado-livre/functions/src/index.test.ts.
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
});

// Isolate the trigger wiring from the disposition + admin singleton (both have
// their own coverage). Mirrors how the pipeline's pure cores are tested apart
// from their thin `functions/src` wrappers.
const outbound = vi.hoisted(() => ({ dispatchOutbound: vi.fn(async () => ({ kind: 'sent' })) }));
vi.mock('../../lib/whatsapp/outbound', () => ({ dispatchOutbound: outbound.dispatchOutbound }));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { sendOutbound } = await import('./sendOutbound');

type RunnableEvent = {
  data: { data: () => Record<string, unknown> } | undefined;
  params: { conversaId: string; mensagemId: string };
};

function run(event: RunnableEvent): Promise<unknown> {
  return (sendOutbound as unknown as { run(e: RunnableEvent): Promise<unknown> }).run(event);
}

describe('sendOutbound trigger wiring', () => {
  it('delegates the created snapshot to dispatchOutbound with the named db + params', async () => {
    const snapData = { estadoEnvio: 1, tipo: 'c', conteudo: 'oi', mid: null };
    await run({
      data: { data: () => snapData },
      params: { conversaId: 'conv-1', mensagemId: 'msg-1' },
    });
    expect(outbound.dispatchOutbound).toHaveBeenCalledWith(admin.db, 'conv-1', 'msg-1', snapData);
  });

  it('is a no-op when the create event carries no snapshot', async () => {
    outbound.dispatchOutbound.mockClear();
    await run({ data: undefined, params: { conversaId: 'c', mensagemId: 'm' } });
    expect(outbound.dispatchOutbound).not.toHaveBeenCalled();
  });

  it('binds to the named default database and the chat/mensagem path', () => {
    const endpoint = (sendOutbound as unknown as { __endpoint: Record<string, unknown> })
      .__endpoint;
    expect(JSON.stringify(endpoint)).toContain('chat/{conversaId}/mensagem/{mensagemId}');
    // `database` must be set (gotcha #8) — an omitted database binds to
    // `(default)` and the trigger never fires.
    expect(JSON.stringify(endpoint)).toContain('default');
  });
});
