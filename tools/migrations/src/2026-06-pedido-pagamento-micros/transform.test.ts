import { describe, expect, it } from 'vitest';
import {
  buildUpdate,
  transformMetodoPgto,
  transformPagamento,
  transformPedido,
  type FieldChange,
} from './transform';

const MS = 1_700_000_000_000; // ~2023, a real millisecond timestamp
const US = MS * 1000; // its microsecond form
const ISO = '2026-06-16T12:00:00.000Z';
const ISO_US = Date.parse(ISO) * 1000;
const GAP = 5e13; // between MILLIS_UPPER_BOUND and MICROS_LOWER_BOUND — undeterminable

/** Apply a transform's changes to a clone, mimicking the Firestore write. */
function applyChanges(
  data: Record<string, unknown>,
  changes: FieldChange[],
): Record<string, unknown> {
  const out = structuredClone(data);
  for (const c of changes) {
    let obj: Record<string, unknown> = out;
    for (let i = 0; i < c.path.length - 1; i += 1) obj = obj[c.path[i]!] as Record<string, unknown>;
    obj[c.path[c.path.length - 1]!] = c.to;
  }
  return out;
}

describe('transformPedido', () => {
  it('scales ms top-level timestamps to µs', () => {
    const t = transformPedido({ timestamp: MS, ultimaModificacao: MS });
    expect(t.changes).toEqual(
      expect.arrayContaining([
        { path: ['timestamp'], from: MS, to: US },
        { path: ['ultimaModificacao'], from: MS, to: US },
      ]),
    );
  });

  it('is a no-op on already-µs values (idempotent)', () => {
    const t = transformPedido({ timestamp: US, dtImpressao: US });
    expect(t.changes).toHaveLength(0);
    expect(t.skips).toHaveLength(0);
  });

  it('leaves null / absent fields untouched', () => {
    const t = transformPedido({ timestamp: null });
    expect(t.changes).toHaveLength(0);
    expect(t.skips).toHaveLength(0);
  });

  it('skips an undeterminable-gap value instead of guessing', () => {
    const t = transformPedido({ timestamp: GAP });
    expect(t.changes).toHaveLength(0);
    expect(t.skips).toEqual([{ path: ['timestamp'], value: GAP }]);
  });

  it('converts embedded frete ms fields', () => {
    const t = transformPedido({ freteInicial: { prazoDespacho: MS, timestamp: null } });
    expect(t.changes).toEqual([{ path: ['freteInicial', 'prazoDespacho'], from: MS, to: US }]);
  });

  it('rewrites the whole itens map when an item.timestamp (ISO) changes', () => {
    const t = transformPedido({ itens: { ABC: [{ sku: 'x', timestamp: ISO }] } });
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]!.path).toEqual(['itens']);
    expect(t.changes[0]!.to).toEqual({ ABC: [{ sku: 'x', timestamp: ISO_US }] });
  });

  it('rewrites nested itensDevolvidos item timestamps', () => {
    const t = transformPedido({ itensDevolvidos: { v1: { ABC: [{ timestamp: MS }] } } });
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]!.path).toEqual(['itensDevolvidos']);
    expect(t.changes[0]!.to).toEqual({ v1: { ABC: [{ timestamp: US }] } });
  });

  it('round-trips to a fixed point: applying the changes yields no further changes', () => {
    const data = {
      timestamp: MS,
      ultimaModificacao: MS,
      dtImpressao: null,
      freteInicial: { prazoDespacho: MS, dataEntrega: ISO, externalOptionSelectionDate: null },
      itens: { ABC: [{ timestamp: ISO }, { timestamp: US }] },
    };
    const t1 = transformPedido(data);
    expect(t1.changes.length).toBeGreaterThan(0);
    const t2 = transformPedido(applyChanges(data, t1.changes));
    expect(t2.changes).toHaveLength(0);
    expect(t2.skips).toHaveLength(0);
  });
});

describe('transformPagamento', () => {
  it('converts the five ISO datetime fields to µs', () => {
    const t = transformPagamento({ vencimento: ISO, dataAprovacao: ISO, valor: 10 });
    expect(t.changes).toEqual(
      expect.arrayContaining([
        { path: ['vencimento'], from: ISO, to: ISO_US },
        { path: ['dataAprovacao'], from: ISO, to: ISO_US },
      ]),
    );
  });

  it('is idempotent once stored as µs', () => {
    expect(transformPagamento({ vencimento: US }).changes).toHaveLength(0);
  });
});

describe('transformMetodoPgto', () => {
  it('converts dataCadastro', () => {
    expect(transformMetodoPgto({ dataCadastro: ISO }).changes).toEqual([
      { path: ['dataCadastro'], from: ISO, to: ISO_US },
    ]);
  });
});

describe('buildUpdate', () => {
  it('dot-joins nested paths and keeps top-level keys', () => {
    expect(
      buildUpdate([
        { path: ['timestamp'], from: 1, to: 2 },
        { path: ['freteInicial', 'prazoDespacho'], from: 3, to: 4 },
      ]),
    ).toEqual({ timestamp: 2, 'freteInicial.prazoDespacho': 4 });
  });
});
