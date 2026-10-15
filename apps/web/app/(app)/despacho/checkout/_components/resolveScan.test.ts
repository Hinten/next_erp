import { describe, expect, it } from 'vitest';
import type { EngineProduto } from '@delfrance/schemas';
import { buildScanIndex, normalizeScanCode, resolveFromIndex } from './resolveScan';

function produto(
  id: string,
  sku: string | null,
  ehKit = false,
  paiId: string | null = null,
): EngineProduto {
  return { id, nome: `Produto ${id}`, sku, ehKit, componentesKit: null, fotos: null, paiId };
}

/** A família-de-um MEMBER: what a pedido line actually names after #1398. */
const membroDe = (id: string, sku: string, paiId = 'pai-1') => produto(id, sku, false, paiId);

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

/**
 * ⛔ The scan has to answer to BOTH forms of a família-de-um's code.
 *
 * A pedido line names the sellable unit — the sole member — whose sku is derived
 * (`<paiSku>-UN`). What is printed on the box, and what the operator scans, is
 * the parent's. Before this, that scan missed the index, fell through to the
 * Firestore probe, matched the PARENT — a produto the order has no line for —
 * and the engine answered `produtoNaoEsperado`: the order could not be checked
 * out at all.
 */
describe('buildScanIndex — a familia de um answers to the parent sku too', () => {
  const membro = membroDe('membro-1', 'CAM-BR-P-UN');

  it('resolves the code printed on the box (the PARENT sku)', () => {
    const idx = buildScanIndex(new Map([[membro.id, membro]]));
    expect(resolveFromIndex('CAM-BR-P', idx)).toBe(membro);
  });

  it('still resolves the member own sku', () => {
    const idx = buildScanIndex(new Map([[membro.id, membro]]));
    expect(resolveFromIndex('CAM-BR-P-UN', idx)).toBe(membro);
  });

  // ⚠️ The near-miss that pins the pass ORDER. A produto that genuinely OWNS the
  // scanned code must win over another produto's derived-parent form — `bySku`
  // is last-wins, so registering the parent form second would let a member
  // hijack a real produto's sku.
  it('an own-sku match beats another produto derived-parent form', () => {
    const proprio = produto('proprio-1', 'CAM-BR-P');
    const idx = buildScanIndex(
      new Map([
        [membro.id, membro],
        [proprio.id, proprio],
      ]),
    );
    expect(resolveFromIndex('CAM-BR-P', idx)).toBe(proprio);
    expect(resolveFromIndex('CAM-BR-P-UN', idx)).toBe(membro);
  });

  /**
   * ⛔ THE near-miss for the gate, and the bug it was shipped with.
   *
   * A ROOT whose own seller code simply ends in `-UN` is not a member and never
   * had a suffix removed. Registering a parent form for it puts `PARAFUSO` in the
   * index pointing at a produto really called `PARAFUSO-UN`, so scanning
   * `PARAFUSO` — a code belonging to some other produto entirely — checks off
   * THIS line and the wrong item ships. `paiId` is the only thing that separates
   * the two, which is why the pass is gated on it and not on the sku's shape.
   */
  it('⛔ registers no parent form for a ROOT whose own sku ends in the suffix', () => {
    const raiz = produto('raiz-1', 'PARAFUSO-UN'); // paiId null ⇒ not a member
    const idx = buildScanIndex(new Map([[raiz.id, raiz]]));
    expect(resolveFromIndex('PARAFUSO-UN', idx)).toBe(raiz);
    // The scan that must MISS, so the caller falls through to the Firestore probe.
    expect(resolveFromIndex('PARAFUSO', idx)).toBeNull();
  });

  // ...and an ordinary produto registers ONE entry, not two.
  it('does not invent an entry for a sku that carries no suffix', () => {
    const idx = buildScanIndex(new Map([['p1', produto('p1', 'SIMPLES')]]));
    expect(idx.bySku.size).toBe(1);
  });
});
