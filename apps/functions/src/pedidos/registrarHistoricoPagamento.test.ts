import { describe, expect, it } from 'vitest';
import { buildPagamentoHistoryEntry } from './registrarHistoricoPagamento';

const EVENT_TIME_MILLIS = Date.parse('2026-08-14T12:00:00.000Z');

describe('buildPagamentoHistoryEntry', () => {
  it('records the opening status on create, even null', () => {
    const entry = buildPagamentoHistoryEntry({
      before: undefined,
      after: { status_pagamento: null },
      usuarioOuterRef: null,
      eventId: 'evt1',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toEqual({
      status_anterior: null,
      status_atual: null,
      usuarioHistoricoPagamentoOuterRef: null,
      timestamp: EVENT_TIME_MILLIS,
      eventId: 'evt1',
    });
  });

  it('records a known status on create', () => {
    const entry = buildPagamentoHistoryEntry({
      before: undefined,
      after: { status_pagamento: 4 },
      usuarioOuterRef: 'documents/usuarios/abc',
      eventId: 'evt2',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toMatchObject({ status_anterior: null, status_atual: 4 });
  });

  it('returns null on delete', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 4 },
      after: undefined,
      usuarioOuterRef: null,
      eventId: 'evt3',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toBeNull();
  });

  it('returns null when status_pagamento is unchanged', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 4, valor: 10 },
      after: { status_pagamento: 4, valor: 20 },
      usuarioOuterRef: null,
      eventId: 'evt4',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toBeNull();
  });

  it('records a transition, carrying anterior + atual', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 0 },
      after: { status_pagamento: 4 },
      usuarioOuterRef: 'documents/usuarios/abc',
      eventId: 'evt5',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toEqual({
      status_anterior: 0,
      status_atual: 4,
      usuarioHistoricoPagamentoOuterRef: 'documents/usuarios/abc',
      timestamp: EVENT_TIME_MILLIS,
      eventId: 'evt5',
    });
  });

  it('records a transition to null (status cleared)', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 4 },
      after: { status_pagamento: null },
      usuarioOuterRef: null,
      eventId: 'evt6',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toMatchObject({ status_anterior: 4, status_atual: null });
  });

  it('skips a row when the new value is not a recognizable status', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 0 },
      after: { status_pagamento: 999 },
      usuarioOuterRef: null,
      eventId: 'evt7',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toBeNull();
  });

  it('falls back the anterior value to null when the old value is garbage', () => {
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 'garbage' },
      after: { status_pagamento: 4 },
      usuarioOuterRef: null,
      eventId: 'evt8',
      eventTimeMillis: EVENT_TIME_MILLIS,
    });
    expect(entry).toMatchObject({ status_anterior: null, status_atual: 4 });
  });
});
