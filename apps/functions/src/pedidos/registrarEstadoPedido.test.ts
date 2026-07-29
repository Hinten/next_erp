import { describe, expect, it } from 'vitest';
import { ESTADO_FRETE, ESTADO_PEDIDO } from '@delfrance/schemas';

import {
  buildEstadoHistoryEntry,
  buildFreteHistoryEntry,
  resolveUsuarioOuterRef,
} from './registrarEstadoPedido';

const UID = 'abcDEF0123456789abcDEF01'; // 24 chars, uid-shaped

/** The same instant in both units — the trigger derives them from one
 *  `Date.parse(event.time)`, so the fixtures must agree too. */
const EVENT_MICROS = 1_700_000_000_000_000;
const EVENT_MILLIS = 1_700_000_000_000;

describe('resolveUsuarioOuterRef', () => {
  it('maps a uid-shaped authId to the documents/usuarios outer-ref', () => {
    expect(resolveUsuarioOuterRef('api_key', UID)).toBe(`documents/usuarios/${UID}`);
    // A standard 28-char Firebase Auth uid.
    const uid28 = 'kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';
    expect(resolveUsuarioOuterRef('unknown', uid28)).toBe(`documents/usuarios/${uid28}`);
  });

  it('accepts the _ and - a custom (Admin-SDK-set) uid may carry', () => {
    // `createUser({ uid })` and user imports allow these; dropping such an actor
    // to null would be a silent audit gap.
    const custom = 'tenant_acme-user-000042xyz';
    expect(resolveUsuarioOuterRef('api_key', custom)).toBe(`documents/usuarios/${custom}`);
  });

  it('returns null when there is no authId at all', () => {
    expect(resolveUsuarioOuterRef('api_key', undefined)).toBeNull();
    expect(resolveUsuarioOuterRef(undefined, undefined)).toBeNull();
    expect(resolveUsuarioOuterRef('unknown', '')).toBeNull();
  });

  it('returns null for auth types that can never be an end user', () => {
    // Admin SDK writes: the Mercado Pago webhook, ML import, other functions.
    expect(resolveUsuarioOuterRef('service_account', UID)).toBeNull();
    expect(resolveUsuarioOuterRef('system', UID)).toBeNull();
    expect(resolveUsuarioOuterRef('unauthenticated', UID)).toBeNull();
  });

  it('rejects anything that is not uid-shaped', () => {
    // The emulator hardcodes this one (firebase-tools#7609) — it must NOT
    // become a bogus usuário ref in the audit trail.
    expect(resolveUsuarioOuterRef('unknown', 'fake-auth-id@gmail.com')).toBeNull();
    // Firebase-console writes report the operator's email.
    expect(resolveUsuarioOuterRef('unknown', 'someone@example.com')).toBeNull();
    // A service-account identifier.
    expect(resolveUsuarioOuterRef('unknown', 'my-app@appspot.gserviceaccount.com')).toBeNull();
    // Too short / illegal characters.
    expect(resolveUsuarioOuterRef('api_key', 'short')).toBeNull();
    expect(resolveUsuarioOuterRef('api_key', 'has spaces in it here')).toBeNull();
    expect(resolveUsuarioOuterRef('api_key', 'has/slashes/in/it/abcdef')).toBeNull();
  });
});

describe('buildEstadoHistoryEntry', () => {
  const base = {
    usuarioOuterRef: `documents/usuarios/${UID}`,
    eventId: 'evt-1',
    eventTimeMicros: EVENT_MICROS,
    eventTimeMillis: EVENT_MILLIS,
  };

  it('records the opening estado on create', () => {
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 'iniciado' } }),
    ).toEqual({
      estado: 'iniciado',
      usuarioHistoricoEstadosPedidoOuterRef: `documents/usuarios/${UID}`,
      data: EVENT_MICROS,
      eventId: 'evt-1',
    });
  });

  it('records a transition', () => {
    const entry = buildEstadoHistoryEntry({
      ...base,
      before: { estado: 'iniciado' },
      after: { estado: 'pago' },
    });
    expect(entry).toMatchObject({ estado: 'pago', eventId: 'evt-1' });
  });

  it('stores a null usuário when none could be resolved', () => {
    const entry = buildEstadoHistoryEntry({
      ...base,
      usuarioOuterRef: null,
      before: { estado: 'iniciado' },
      after: { estado: 'pago' },
    });
    expect(entry?.usuarioHistoricoEstadosPedidoOuterRef).toBeNull();
  });

  it('is a no-op when estado did not change', () => {
    // The overwhelmingly common case: any pedido edit that is not a state change.
    expect(
      buildEstadoHistoryEntry({
        ...base,
        before: { estado: 'pago', numero: 'A' },
        after: { estado: 'pago', numero: 'B' },
      }),
    ).toBeNull();
  });

  it('is a no-op on delete', () => {
    expect(
      buildEstadoHistoryEntry({ ...base, before: { estado: 'pago' }, after: undefined }),
    ).toBeNull();
  });

  it('is a no-op when estado is missing or not a known EstadoPedido', () => {
    expect(buildEstadoHistoryEntry({ ...base, before: undefined, after: {} })).toBeNull();
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 'inventado' } }),
    ).toBeNull();
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 42 } }),
    ).toBeNull();
  });
});

describe('buildFreteHistoryEntry', () => {
  const base = {
    usuarioOuterRef: `documents/usuarios/${UID}`,
    eventId: 'evt-1',
    eventTimeMicros: EVENT_MICROS,
    eventTimeMillis: EVENT_MILLIS,
  };

  it('records the opening estado when a pedido is created with a frete block', () => {
    // Legacy parity: `Pedido.save()` appended a row on creation whenever
    // `freteInicial` was non-null, so the trail shows where the shipment began.
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: undefined,
        after: { estado: 'iniciado', freteInicial: { estado: ESTADO_FRETE.iniciado } },
      }),
    ).toEqual({
      estado: ESTADO_FRETE.iniciado,
      obs: null,
      usuarioHistoricoFreteInicialOuterRef: `documents/usuarios/${UID}`,
      // MILLISECONDS — `historicoFtIni.data` is `millisSinceEpoch`, unlike the
      // estado trail's micros.
      data: EVENT_MILLIS,
      eventId: 'evt-1',
    });
  });

  it('records the estado when a frete block first appears on a pedido that had none', () => {
    // The pedido existed without a shipment (`freteInicial: null`) and the Frete
    // tab / an import filled it in. That is the shipment's opening state too.
    const entry = buildFreteHistoryEntry({
      ...base,
      before: { estado: 'iniciado', freteInicial: null },
      after: { estado: 'iniciado', freteInicial: { estado: ESTADO_FRETE.aguardandoAutorizacao } },
    });
    expect(entry).toMatchObject({ estado: ESTADO_FRETE.aguardandoAutorizacao, eventId: 'evt-1' });
  });

  it('records a transition, whether the writer patched the field or the whole block', () => {
    // A dotted `update({'freteInicial.estado': …})` and a whole-block
    // `update({ freteInicial: {…} })` produce IDENTICAL before/after documents —
    // a document observer cannot tell them apart, and must not need to.
    const dotted = buildFreteHistoryEntry({
      ...base,
      before: { freteInicial: { estado: ESTADO_FRETE.empacotado, codRastreio: 'BR1' } },
      after: { freteInicial: { estado: ESTADO_FRETE.postado, codRastreio: 'BR1' } },
    });
    expect(dotted).toMatchObject({ estado: ESTADO_FRETE.postado, obs: null });

    const wholeBlock = buildFreteHistoryEntry({
      ...base,
      before: { freteInicial: { estado: ESTADO_FRETE.postado, codRastreio: 'BR1' } },
      after: { freteInicial: { estado: ESTADO_FRETE.entregue, codRastreio: 'BR1', peso: 2 } },
    });
    expect(wholeBlock).toMatchObject({ estado: ESTADO_FRETE.entregue });
  });

  it('stores a null usuário when none could be resolved', () => {
    // Every marketplace/webhook writer reaches Firestore through the Admin SDK.
    const entry = buildFreteHistoryEntry({
      ...base,
      usuarioOuterRef: null,
      before: { freteInicial: { estado: ESTADO_FRETE.iniciado } },
      after: { freteInicial: { estado: ESTADO_FRETE.despachoAutorizado } },
    });
    expect(entry?.usuarioHistoricoFreteInicialOuterRef).toBeNull();
  });

  it('is a no-op on delete', () => {
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: { freteInicial: { estado: ESTADO_FRETE.postado } },
        after: undefined,
      }),
    ).toBeNull();
  });

  it('is a no-op when the frete block was not touched at all', () => {
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: { numero: 'A', freteInicial: { estado: ESTADO_FRETE.empacotado } },
        after: { numero: 'B', freteInicial: { estado: ESTADO_FRETE.empacotado } },
      }),
    ).toBeNull();
  });

  it('is a no-op when the block was rewritten but estado stayed put', () => {
    // THE case this builder exists to get right. The Melhor Envio webhook emits
    // tracking-only patches, and `mergeFreteInicial` (ML shipment refresh)
    // rewrites the whole block on every poll while PRESERVING estado. A
    // block-level or JSON.stringify diff would append a bogus row every time.
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: { freteInicial: { estado: ESTADO_FRETE.postado, codRastreio: null } },
        after: { freteInicial: { estado: ESTADO_FRETE.postado, codRastreio: 'BR123456789BR' } },
      }),
    ).toBeNull();
  });

  it('is a no-op when the pedido carries no frete block', () => {
    // Retirada na loja and most marketplace-owned freights never write one.
    expect(
      buildFreteHistoryEntry({ ...base, before: undefined, after: { estado: 'iniciado' } }),
    ).toBeNull();
    expect(
      buildFreteHistoryEntry({ ...base, before: undefined, after: { freteInicial: null } }),
    ).toBeNull();
  });

  it('is a no-op when the block is present but carries no estado', () => {
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: undefined,
        after: { freteInicial: { codRastreio: 'BR1' } },
      }),
    ).toBeNull();
  });

  it('is a no-op when the frete block is removed', () => {
    // Nothing to record: the row would name a state the pedido no longer has,
    // and there is no "removed" member of EstadoFrete to write instead.
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: { freteInicial: { estado: ESTADO_FRETE.postado } },
        after: { freteInicial: null },
      }),
    ).toBeNull();
  });

  it('is a no-op when estado is not a known EstadoFrete', () => {
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: undefined,
        after: { freteInicial: { estado: 'inventado' } },
      }),
    ).toBeNull();
    expect(
      buildFreteHistoryEntry({
        ...base,
        before: undefined,
        after: { freteInicial: { estado: 42 } },
      }),
    ).toBeNull();
  });

  it('is a no-op when freteInicial is not an object at all', () => {
    // Raw DocumentData from any writer, including Flutter and console edits.
    expect(
      buildFreteHistoryEntry({ ...base, before: undefined, after: { freteInicial: 'garbage' } }),
    ).toBeNull();
  });
});

describe('the two trails, on one pedido write', () => {
  const base = {
    usuarioOuterRef: null,
    eventId: 'evt-shared',
    eventTimeMicros: EVENT_MICROS,
    eventTimeMillis: EVENT_MILLIS,
  };

  it('records the pedido estado alone when only it moved (the #702 shape)', () => {
    // A full payment transitions the pedido to `pago` while the #702 guard
    // leaves an already-packed shipment exactly where the warehouse put it.
    // Only the estado trail may move.
    const input = {
      ...base,
      before: {
        estado: ESTADO_PEDIDO.iniciado,
        freteInicial: { estado: ESTADO_FRETE.empacotado },
      },
      after: { estado: ESTADO_PEDIDO.pago, freteInicial: { estado: ESTADO_FRETE.empacotado } },
    };
    expect(buildEstadoHistoryEntry(input)).toMatchObject({ estado: ESTADO_PEDIDO.pago });
    expect(buildFreteHistoryEntry(input)).toBeNull();
  });

  it('records both, sharing the event id, when one write moves both', () => {
    // `pedidoReconcile` authorizes despatch in the SAME `tx.update` that flips
    // the pedido to `pago`. Two rows in two different subcollections, keyed on
    // the same event — a correlation key, not a collision.
    const input = {
      ...base,
      before: { estado: ESTADO_PEDIDO.iniciado, freteInicial: { estado: ESTADO_FRETE.iniciado } },
      after: {
        estado: ESTADO_PEDIDO.pago,
        freteInicial: { estado: ESTADO_FRETE.despachoAutorizado },
      },
    };
    expect(buildEstadoHistoryEntry(input)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      eventId: 'evt-shared',
    });
    expect(buildFreteHistoryEntry(input)).toMatchObject({
      estado: ESTADO_FRETE.despachoAutorizado,
      eventId: 'evt-shared',
    });
  });
});
