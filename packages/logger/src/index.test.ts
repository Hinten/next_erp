import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

type Entry = Record<string, unknown>;

/** In-memory pino destination that collects each emitted JSON line. */
function capture() {
  const lines: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        lines.push(s);
      },
    },
    entries: (): Entry[] => lines.map((l) => JSON.parse(l) as Entry),
  };
}

/** First emitted entry, asserting at least one was written (narrows the type). */
function first(sink: { entries: () => Entry[] }): Entry {
  const entry = sink.entries()[0];
  if (!entry) throw new Error('expected at least one log entry');
  return entry;
}

describe('createLogger', () => {
  it('emits structured JSON with the binding name, level and message', () => {
    const sink = capture();
    const log = createLogger('test-mod', { level: 'info', destination: sink.stream });

    log.info('hello');

    const entry = first(sink);
    expect(entry.name).toBe('test-mod');
    expect(entry.msg).toBe('hello');
    expect(entry.level).toBe(30); // pino numeric level for `info`
  });

  it('redacts sensitive keys at the root and one level deep', () => {
    const sink = capture();
    const log = createLogger('redact', { level: 'info', destination: sink.stream });

    log.info({ password: 'hunter2', user: { token: 'abc' }, keep: 'ok' }, 'login');

    const entry = first(sink);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.user).toEqual({ token: '[REDACTED]' });
    expect(entry.keep).toBe('ok');
  });

  it('reduces thrown values to a leak-safe shape via the err serializer', () => {
    const sink = capture();
    const log = createLogger('err', { level: 'info', destination: sink.stream });

    const e = Object.assign(new Error('boom'), {
      code: 'auth/id-token-expired',
      responseBody: 'SIGNED-XML-SECRET',
    });
    log.error({ err: e }, 'failed');

    const entry = first(sink);
    expect(entry.err).toEqual({ name: 'Error', message: 'boom', code: 'auth/id-token-expired' });
    // The arbitrary `responseBody` own-prop must never reach the wire.
    expect(JSON.stringify(entry)).not.toContain('SIGNED-XML-SECRET');
  });

  it('honours the level threshold', () => {
    const sink = capture();
    const log = createLogger('lvl', { level: 'warn', destination: sink.stream });

    log.info('hidden');
    log.warn('shown');

    expect(sink.entries().map((e) => e.msg)).toEqual(['shown']);
  });
});
