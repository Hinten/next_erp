import { describe, expect, it } from 'vitest';
import type { EngineProduto } from '@delfrance/schemas';
import { buildScanIndex, normalizeScanCode, resolveFromIndex } from './resolveScan';

function produto(id: string, sku: string | null, ehKit = false): EngineProduto {
  return { id, nome: `Produto ${id}`, sku, ehKit, componentesKit: null, fotos: null };
}

describe('normalizeScanCode', () => {
  it('trims whitespace', () => {
    expect(normalizeScanCode('  abc  ')).toBe('abc');
  });
  it('strips leading zeros on a numeric code', () => {
    expect(normalizeScanCode('0007')).toBe('7');
    expect(normalizeScanCode('00420')).toBe('420');
  });
  it('collapses an all-zero code to a single 0 (never empty)', () => {
    expect(normalizeScanCode('0000')).toBe('0');
  });
  it('leaves non-numeric / alphanumeric codes untouched', () => {
    expect(normalizeScanCode('SKU-007')).toBe('SKU-007');
    expect(normalizeScanCode('0A1')).toBe('0A1'); // has a non-digit → not zero-stripped
  });
});

describe('buildScanIndex + resolveFromIndex', () => {
  const produtos = new Map<string, EngineProduto>([
    ['p1', produto('p1', 'ABC')],
    ['p2', produto('p2', '0042')],
    ['p3', produto('p3', null)],
  ]);
  const index = buildScanIndex(produtos);

  it('resolves by exact doc id', () => {
    expect(resolveFromIndex('p1', index)?.id).toBe('p1');
  });
  it('resolves by exact SKU', () => {
    expect(resolveFromIndex('ABC', index)?.id).toBe('p1');
  });
  it('resolves a zero-padded scan against a zero-padded SKU (both normalized)', () => {
    // stored sku '0042' → indexed as '42'; scanning '42' or '0042' both hit.
    expect(resolveFromIndex('42', index)?.id).toBe('p2');
    expect(resolveFromIndex('0042', index)?.id).toBe('p2');
  });
  it('returns null on a miss', () => {
    expect(resolveFromIndex('nope', index)).toBeNull();
  });
  it('does not index a null SKU', () => {
    expect(index.bySku.size).toBe(2);
  });
});
