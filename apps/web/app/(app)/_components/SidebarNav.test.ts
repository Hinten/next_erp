import { describe, expect, it } from 'vitest';
import { activeHrefFor } from './SidebarNav';

describe('activeHrefFor', () => {
  it('returns null for a null pathname', () => {
    expect(activeHrefFor(null)).toBeNull();
  });

  it('matches a leaf exactly', () => {
    expect(activeHrefFor('/pedidos')).toBe('/pedidos');
    expect(activeHrefFor('/clientes')).toBe('/clientes');
    expect(activeHrefFor('/inicio')).toBe('/inicio');
  });

  it('keeps a detail route on its parent leaf (no more-specific sibling)', () => {
    // The bug this guards against would ALSO need `/pedidos` to stop matching a
    // real sub-route — it must not: these have no dedicated nav entry.
    expect(activeHrefFor('/pedidos/novo')).toBe('/pedidos');
    expect(activeHrefFor('/pedidos/123/editar')).toBe('/pedidos');
  });

  it('picks the MOST specific leaf when one href is a sub-path of another', () => {
    // Regression: `/pedidos/entradas` is nested under `/pedidos`, so a plain
    // prefix test lit BOTH nav items. Only the longest match must win.
    expect(activeHrefFor('/pedidos/entradas')).toBe('/pedidos/entradas');
    expect(activeHrefFor('/pedidos/entradas/novo')).toBe('/pedidos/entradas');
    expect(activeHrefFor('/pedidos/entradas/abc/editar')).toBe('/pedidos/entradas');
  });

  it('does not match a leaf on a partial path segment', () => {
    // `/pedidosX` must not match `/pedidos` (segment boundary only).
    expect(activeHrefFor('/pedidosX')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(activeHrefFor('/does-not-exist')).toBeNull();
  });
});
