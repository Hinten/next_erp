import type { Pedido } from '@delfrance/schemas';
import type { FlatItem } from './types';

/**
 * Flatten the grouped `pedido.itens` record into the flat array shape
 * the form's `useFieldArray` consumes. Items keep their fields verbatim
 * and gain a synthetic `_rowId` for stable React keys.
 */
export function flattenItens(grouped: Pedido['itens']): FlatItem[] {
  const out: FlatItem[] = [];
  let idx = 0;
  for (const [, list] of Object.entries(grouped)) {
    for (const item of list) {
      out.push({
        ...item,
        _rowId: `row-${idx++}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }
  }
  out.sort((a, b) => a.ordem - b.ordem);
  return out;
}

/**
 * Make a fresh `_rowId` for a newly-added item. Uses crypto.randomUUID
 * when available (browser + Node 19+); falls back to a Math.random
 * suffix for old runtimes.
 */
export function makeRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
