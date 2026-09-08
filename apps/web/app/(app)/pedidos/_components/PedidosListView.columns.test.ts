import { describe, expect, it } from 'vitest';
import { pedidoMeta, pedidoSchema } from '@delfrance/schemas';

import { PEDIDO_VIRTUAL_COLUMNS } from './PedidosListView';

/**
 * Guards the invariant that let the `disputa` column ship invisible.
 *
 * `disputa` (#1322) was declared in `PEDIDO_VIRTUAL_COLUMNS` with a `renderCell`
 * and a `dependsOn`, but its key was never added to
 * `pedidoMeta.defaultQuery.columns` — and `TableView` derives the visible set
 * from `defaultQuery.columns`, not from the virtual-column list. So on a fresh
 * browser the column rendered NOWHERE; the ColumnPicker was its only route on
 * screen, and nothing failed. Its own docstring calls this list "the dispatch
 * surface" and notes every other cell reads healthy while a mediation is open.
 *
 * A declared-but-unlisted column is invisible by construction, so only a test
 * that compares the two lists can catch it.
 */
describe('pedidos list column set', () => {
  const declared = pedidoMeta.defaultQuery?.columns ?? [];
  const virtualKeys = PEDIDO_VIRTUAL_COLUMNS.map((c) => c.key);
  const schemaKeys = Object.keys(pedidoSchema.shape);

  it('renders every virtual column it declares', () => {
    const unreachable = virtualKeys.filter((k) => !declared.includes(k));
    expect(
      unreachable,
      `declared in PEDIDO_VIRTUAL_COLUMNS but missing from pedidoMeta.defaultQuery.columns — they render nowhere`,
    ).toEqual([]);
  });

  it('has no dead entry in defaultQuery.columns', () => {
    const dead = declared.filter((k) => !virtualKeys.includes(k) && !schemaKeys.includes(k));
    expect(
      dead,
      'listed in columns but resolves to neither a schema field nor a virtual column',
    ).toEqual([]);
  });

  it('keeps the projection on — every virtual column declares dependsOn', () => {
    // A visible virtual column WITHOUT `dependsOn` disables the Pipelines
    // `select()` entirely (TableView `selectFields`), turning every row into a
    // full-document read on the heaviest collection in the app.
    const undeclared = PEDIDO_VIRTUAL_COLUMNS.filter((c) => c.dependsOn === undefined).map(
      (c) => c.key,
    );
    expect(
      undeclared,
      'missing dependsOn — this silently disables the select() projection',
    ).toEqual([]);
  });

  it('keeps the row-link column visible', () => {
    // `rowLinkColumn="numero"` (#1503/#1509) names a column that must stay in
    // the visible set, or row navigation silently becomes mouse-only again.
    expect(declared).toContain('numero');
  });
});
