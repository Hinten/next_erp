import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { abrirPrazo, ehTempoEsgotadoNoGateway } from './index';

describe('abrirPrazo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not esgotado until the full window has passed, then aborts with a TimeoutError', async () => {
    const prazo = abrirPrazo(1_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(prazo.esgotado()).toBe(false);
    expect(prazo.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(prazo.esgotado()).toBe(true);
    expect(prazo.signal.aborted).toBe(true);
    // ⚠️ NOT 'AbortError': callers read an AbortError cause as "the operator
    // cancelled" (apps/web/lib/mercado-livre/errors.ts), and a timeout that
    // looked like one would be swallowed as a clean cancel.
    expect((prazo.signal.reason as { name?: unknown }).name).toBe('TimeoutError');
    prazo.liberar();
  });

  it('liberar() clears the timer, so a fast request leaves nothing pending', () => {
    const prazo = abrirPrazo(60_000);
    expect(vi.getTimerCount()).toBe(1);
    prazo.liberar();
    expect(vi.getTimerCount()).toBe(0);
    // Idempotent: the finally block may run it after an early exit already did.
    prazo.liberar();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a released deadline never fires', async () => {
    const prazo = abrirPrazo(1_000);
    prazo.liberar();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prazo.esgotado()).toBe(false);
    expect(prazo.signal.aborted).toBe(false);
  });

  it('a linked caller abort aborts with the CALLER reason and is never esgotado', async () => {
    const caller = new AbortController();
    const prazo = abrirPrazo(1_000, { vincular: caller.signal });
    const motivo = new DOMException('cancelado', 'AbortError');

    caller.abort(motivo);
    expect(prazo.signal.aborted).toBe(true);
    expect(prazo.signal.reason).toBe(motivo);
    expect(prazo.esgotado()).toBe(false);

    // The timer firing afterwards must not re-label the caller's cancel as ours.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prazo.esgotado()).toBe(false);
    prazo.liberar();
  });

  it('an already-aborted caller signal aborts at once', () => {
    const caller = new AbortController();
    caller.abort('antes');
    const prazo = abrirPrazo(1_000, { vincular: caller.signal });
    expect(prazo.signal.aborted).toBe(true);
    expect(prazo.signal.reason).toBe('antes');
    expect(prazo.esgotado()).toBe(false);
    prazo.liberar();
  });

  it('a caller abort AFTER the deadline fired leaves it esgotado', async () => {
    const caller = new AbortController();
    const prazo = abrirPrazo(1_000, { vincular: caller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    expect(prazo.esgotado()).toBe(true);
    prazo.liberar();
  });

  it('liberar() detaches from the caller signal', () => {
    const caller = new AbortController();
    const prazo = abrirPrazo(1_000, { vincular: caller.signal });
    prazo.liberar();
    caller.abort();
    expect(prazo.signal.aborted).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses an unusable window (%s ms) instead of firing at once',
    (ms) => {
      expect(() => abrirPrazo(ms)).toThrow(RangeError);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('ehTempoEsgotadoNoGateway', () => {
  it('reads a 504 without our envelope as the platform gateway', () => {
    expect(ehTempoEsgotadoNoGateway(504, null)).toBe(true); // HTML / empty body
    expect(ehTempoEsgotadoNoGateway(504, { error: 'upstream request timeout' })).toBe(true);
    expect(ehTempoEsgotadoNoGateway(504, ['x'])).toBe(true);
  });

  it('keeps a 504 carrying our coded envelope as a route answer', () => {
    // The Mercado Livre AI routes answer `504 {code:'AI_TIMEOUT'}` on purpose.
    expect(ehTempoEsgotadoNoGateway(504, { error: 'IA demorou', code: 'AI_TIMEOUT' })).toBe(false);
  });

  it('never fires for another status', () => {
    expect(ehTempoEsgotadoNoGateway(502, null)).toBe(false);
    expect(ehTempoEsgotadoNoGateway(503, null)).toBe(false);
    expect(ehTempoEsgotadoNoGateway(500, null)).toBe(false);
  });
});
