import { podeTrocar, type EstadoPedido, type ItemDoPedido } from '@delfrance/schemas';

/**
 * Pure mapping for the Devolução (returns) tab. The legacy app records returns in
 * two modes — (A) clone the items of a paid ORIGIN order, or (B) add AVULSO
 * (standalone) items — into `itensDevolvidos`
 * (`Record<originPedidoId|'NONE', Record<produtoUid|'NONE', ItemDoPedido[]>>`,
 * `.old/.../models.dart:3006`). The tab edits a flat list of {@link DevolucaoEditRow}
 * and rebuilds that map; these helpers are the UI-agnostic core (ports of
 * `getItensDevolvidos…TrocaNovoPedido` / `addDevolucaoAvulso` /
 * `itensDevolvidosFromPedidoView`).
 */

/** Origin/produto bucket for avulso items / unknown produtos (legacy `'NONE'`). */
export const NONE_KEY = 'NONE';

export interface DevolucaoEditRow {
  /** Stable React key (not persisted). */
  rowId: string;
  /** Origin pedido id, or `'NONE'` for an avulso item. */
  originId: string;
  /** Human label for the origin group (pedido número, or "Avulso"). */
  originLabel: string;
  /** Produto uid; `null` until an avulso produto is picked (locked for origin rows). */
  produtoUid: string | null;
  nome: string;
  sku: string | null;
  precoDeVenda: number;
  descontoUnitario: number;
  custo: number | null;
  quantidade: number;
  /** Origin sold-qty cap; `null` = avulso (no cap). */
  maxQty: number | null;
  /** The original item, preserved so passthrough fields survive the round-trip. */
  source: ItemDoPedido;
  /** Staged-deletion marker (excluded from the rebuilt map; in-tab undo). */
  _delete: boolean;
}

type ItensDevolvidos = Record<string, Record<string, ItemDoPedido[]>> | null | undefined;

let rowCounter = 0;
function makeRowId(): string {
  rowCounter += 1;
  return `dev-${rowCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAvulso(originId: string): boolean {
  return originId === NONE_KEY;
}

/** Map a produto uid to its bucket key (`'NONE'` when absent). */
function produtoKey(produtoUid: string | null): string {
  return produtoUid && produtoUid !== '' ? produtoUid : NONE_KEY;
}

function rowFromItem(
  item: ItemDoPedido,
  originId: string,
  originLabel: string,
  produtoUid: string | null,
  maxQty: number | null,
): DevolucaoEditRow {
  return {
    rowId: makeRowId(),
    originId,
    originLabel,
    produtoUid,
    nome: item.nomeDeVenda ?? produtoUid ?? '',
    sku: item.sku ?? null,
    precoDeVenda: item.precoDeVenda,
    descontoUnitario: item.descontoUnitario ?? 0,
    custo: item.custo ?? null,
    quantidade: item.quantidade,
    maxQty,
    source: item,
    _delete: false,
  };
}

/**
 * Clone a paid origin order's items into return rows (Mode A): each row starts at
 * the full sold quantity, capped there (`maxQty`), produto locked. Port of
 * `Pedido.getItensDevolvidosAsCleanedDataTrocaNovoPedido` (`models.dart:3096`).
 */
export function clonePedidoItems(
  origin: { itens?: Record<string, ItemDoPedido[]> | null; numero?: string | null },
  originId: string,
): DevolucaoEditRow[] {
  const label = origin.numero ?? `Pedido ${originId}`;
  const rows: DevolucaoEditRow[] = [];
  for (const [uid, list] of Object.entries(origin.itens ?? {})) {
    const produtoUid = uid === NONE_KEY ? null : uid;
    for (const item of list) {
      rows.push(rowFromItem(item, originId, label, produtoUid, item.quantidade));
    }
  }
  return rows;
}

/** A fresh empty avulso row (Mode B); the produto is picked in the UI. */
export function newAvulsoRow(): DevolucaoEditRow {
  return {
    rowId: makeRowId(),
    originId: NONE_KEY,
    originLabel: 'Avulso',
    produtoUid: null,
    nome: '',
    sku: null,
    precoDeVenda: 0.01,
    descontoUnitario: 0,
    custo: null,
    quantidade: 1,
    maxQty: null,
    source: { ordem: 1 } as unknown as ItemDoPedido,
    _delete: false,
  };
}

/** Seed editable rows from a persisted `itensDevolvidos` map (on tab open). */
export function editRowsFromItensDevolvidos(itensDevolvidos: ItensDevolvidos): DevolucaoEditRow[] {
  const rows: DevolucaoEditRow[] = [];
  for (const [originId, porProduto] of Object.entries(itensDevolvidos ?? {})) {
    const label = isAvulso(originId) ? 'Avulso' : `Pedido ${originId}`;
    for (const [uid, list] of Object.entries(porProduto)) {
      const produtoUid = uid === NONE_KEY ? null : uid;
      for (const item of list) {
        // On reload the origin sold qty is unknown; cap at the saved qty.
        rows.push(
          rowFromItem(
            item,
            originId,
            label,
            produtoUid,
            isAvulso(originId) ? null : item.quantidade,
          ),
        );
      }
    }
  }
  return rows;
}

/**
 * Rebuild the `itensDevolvidos` wire map from the edited rows — non-deleted rows
 * with a quantity > 0 (and, for avulso, a picked produto). Returns `null` when
 * empty. Port of `Pedido.itensDevolvidosFromPedidoView` (`models.dart:3118`).
 */
export function buildItensDevolvidos(
  rows: ReadonlyArray<DevolucaoEditRow>,
): Record<string, Record<string, ItemDoPedido[]>> | null {
  const out: Record<string, Record<string, ItemDoPedido[]>> = {};
  for (const row of rows) {
    if (row._delete || row.quantidade <= 0) continue;
    if (isAvulso(row.originId) && !row.produtoUid) continue; // avulso needs a produto
    const item: ItemDoPedido = {
      ...row.source,
      produtoUid: row.produtoUid,
      nomeDeVenda: row.nome.trim() === '' ? null : row.nome,
      sku: row.sku,
      precoDeVenda: row.precoDeVenda,
      descontoUnitario: row.descontoUnitario,
      custo: row.custo,
      quantidade: row.quantidade,
    };
    delete (item as Record<string, unknown>)._rowId;
    const porProduto = (out[row.originId] ??= {});
    const key = produtoKey(row.produtoUid);
    porProduto[key] = [...(porProduto[key] ?? []), item];
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Whether an order can be added as a devolução origin: a sale (`ehSaida`) whose
 * estado allows a return ({@link podeTrocar}), and not already in the picker's
 * exclude set (the current pedido + already-added origins).
 */
export function isReturnableOrigin(
  pedido: { ehSaida?: boolean | null; estado?: EstadoPedido | null },
  id: string,
  excludeIds: ReadonlySet<string>,
): boolean {
  return (
    pedido.ehSaida === true &&
    pedido.estado != null &&
    podeTrocar(pedido.estado) &&
    !excludeIds.has(id)
  );
}
