import { describe, expect, it } from 'vitest';

import { redactWireBody } from './redact';
import { diffShapes, ehQuebra, renderShapeDiff } from './shapeDiff';
import { wireShape } from './wireDigest';

const shapeOf = (v: unknown): ReturnType<typeof wireShape> =>
  wireShape(v as Parameters<typeof wireShape>[0]);

describe('diffShapes', () => {
  it('CONTROL (known-good) — identical bodies report nothing', () => {
    const corpo = { id: 1, buyer: { nickname: 'x' }, payments: [{ id: 2 }] };
    expect(diffShapes(shapeOf(corpo), shapeOf(corpo))).toEqual([]);
  });

  it('CONTROL (known-bad) — reports a field ML stopped sending', () => {
    const deltas = diffShapes(shapeOf({ a: 1, b: 'x' }), shapeOf({ a: 1 }));
    expect(deltas).toEqual([{ path: 'b', kind: 'removido', antes: 'string', depois: '' }]);
    expect(deltas.every(ehQuebra)).toBe(true);
  });

  it('reports a type change', () => {
    const deltas = diffShapes(shapeOf({ paid_amount: 49.9 }), shapeOf({ paid_amount: '49.90' }));
    expect(deltas).toEqual([
      { path: 'paid_amount', kind: 'tipo-mudou', antes: 'number', depois: 'string' },
    ]);
  });

  it('reports a value that became null — present, but no longer carrying a value', () => {
    const deltas = diffShapes(shapeOf({ x: 1 }), shapeOf({ x: null }));
    expect(deltas[0]?.kind).toBe('tipo-mudou');
    expect(deltas[0]?.depois).toBe('null');
  });

  it('⚠️ reports ADDITIONS too, and does not treat them as breakage', () => {
    // Additions are where a new ML capability shows up — and a RENAME presents
    // as removido + novo on the same run, which is exactly how the
    // date_last_modified / date_last_updated split became visible.
    const deltas = diffShapes(
      shapeOf({ payments: [{ date_last_modified: 'x' }] }),
      shapeOf({ payments: [{ date_last_updated: 'x' }] }),
    );
    expect(deltas.map((d) => d.kind).sort()).toEqual(['novo', 'removido']);
    expect(deltas.filter(ehQuebra).map((d) => d.path)).toEqual(['payments[].date_last_modified']);
  });

  it('sees an empty array becoming populated — the UP variations signal', () => {
    const deltas = diffShapes(shapeOf({ variations: [] }), shapeOf({ variations: [{ id: 1 }] }));
    expect(deltas.map((d) => `${d.path}:${d.kind}`).sort()).toEqual([
      'variations:removido',
      'variations[].id:novo',
    ]);
  });

  it('is stable under key reordering, so a diff is never noise', () => {
    expect(diffShapes(shapeOf({ a: 1, b: 2 }), shapeOf({ b: 2, a: 1 }))).toEqual([]);
  });
});

describe('redaction is invisible to the diff', () => {
  it('⭐ a redacted live body compares clean against a redacted baseline', () => {
    // This is why `redact.ts` is type-preserving. The committed corpus is
    // redacted; if redaction changed the SHAPE, every live comparison would
    // report dozens of personal-field differences and bury the one real one.
    const vivo = {
      buyer: { id: 7, nickname: 'OUTRO_COMPRADOR', first_name: 'Joana' },
      destination: { shipping_address: { zip_code: '99999123', latitude: -1.234 } },
      status: 'paid',
    };
    const baseline = {
      buyer: { id: 7, nickname: 'REDACTED', first_name: 'REDACTED' },
      destination: { shipping_address: { zip_code: '00000000', latitude: 0 } },
      status: 'paid',
    };

    expect(diffShapes(shapeOf(baseline), shapeOf(redactWireBody(vivo)))).toEqual([]);
  });

  it('CONTROL — without redacting the live body the shapes still match, because only VALUES differ', () => {
    // The paired control: the digest records types, not values, so this passing
    // does not prove redaction happened. What redaction buys is that the
    // committed corpus is safe to publish — not that the diff works.
    const vivo = { buyer: { nickname: 'OUTRO' } };
    const baseline = { buyer: { nickname: 'REDACTED' } };
    expect(diffShapes(shapeOf(baseline), shapeOf(vivo))).toEqual([]);
  });
});

describe('renderShapeDiff', () => {
  it('says nothing but the filename when a fixture is clean', () => {
    expect(renderShapeDiff('orders-1.json', [])).toBe('✅ orders-1.json');
  });

  it('marks a breakage differently from an addition', () => {
    const texto = renderShapeDiff('orders-1.json', [
      { path: 'a', kind: 'removido', antes: 'string', depois: '' },
      { path: 'b', kind: 'novo', antes: '', depois: 'number' },
    ]);
    expect(texto).toContain('⛔ orders-1.json');
    expect(texto).toContain('⛔ a: string → AUSENTE');
    expect(texto).toContain('ⓘ b: number');
  });

  it('headlines an additions-only diff as information, not breakage', () => {
    const texto = renderShapeDiff('orders-1.json', [
      { path: 'b', kind: 'novo', antes: '', depois: 'number' },
    ]);
    expect(texto.startsWith('ⓘ')).toBe(true);
  });
});
