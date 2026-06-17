import { coerceToMicros } from '@delfrance/core/datetime';

/**
 * Per-doc transforms for the pedido / pagamento → microseconds backfill.
 *
 * Pure functions over plain document data — no Firestore — so they are fully
 * unit-tested (idempotency + every legacy shape). The walk in `migrate.ts`
 * applies the returned changes. See `tools/migrations/pedido-pagamento-micros.README.md`.
 */

/** Top-level pedido datetime fields (legacy: ms ints). */
export const PEDIDO_FIELDS = [
  'timestamp',
  'ultimaModificacao',
  'dataFinalExpedicao',
  'dataIndisponivelEstoque',
  'dataRemocaoEstoque',
  'lastMarketplaceUpdate',
  'dtImpressao',
] as const;

/** Embedded `freteInicial` datetime fields (legacy: ms ints). */
export const FRETE_FIELDS = [
  'timestamp',
  'ultimaModificacao',
  'prazoDespacho',
  'dataEntrega',
  'dataPrevisaoEntrega',
  'externalOptionSelectionDate',
] as const;

/** Pagamento datetime fields (legacy: ISO-8601 strings). */
export const PAGAMENTO_FIELDS = [
  'vencimento',
  'ultimaModificacao',
  'dataCancelamento',
  'dataAprovacao',
  'dataCadastro',
] as const;

export interface FieldChange {
  /** FieldPath segments, e.g. `['freteInicial', 'timestamp']`. */
  path: string[];
  from: unknown;
  to: unknown;
}

export interface FieldSkip {
  path: string[];
  value: unknown;
}

export interface DocTransform {
  changes: FieldChange[];
  skips: FieldSkip[];
}

type Classified = { kind: 'change'; to: number } | { kind: 'none' } | { kind: 'skip' };

/**
 * Classify one stored value against the canonical µs form. `null`/absent is
 * left untouched; an already-µs value is a no-op (idempotent re-run); an
 * unparseable or undeterminable-gap value is skipped (logged, never guessed).
 */
function classify(value: unknown): Classified {
  if (value == null) return { kind: 'none' };
  const next = coerceToMicros(value);
  if (next == null) return { kind: 'skip' }; // unparseable / ms-µs gap
  if (next === value) return { kind: 'none' }; // already microseconds
  return { kind: 'change', to: next };
}

function classifyInto(
  source: Record<string, unknown>,
  field: string,
  prefix: string[],
  out: DocTransform,
): void {
  const r = classify(source[field]);
  if (r.kind === 'change')
    out.changes.push({ path: [...prefix, field], from: source[field], to: r.to });
  else if (r.kind === 'skip') out.skips.push({ path: [...prefix, field], value: source[field] });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Transform an array of `ItemDoPedido`, rewriting each item's `timestamp`. */
function transformItemArray(
  items: unknown,
  skips: FieldSkip[],
  skipPath: string[],
): { changed: boolean; value: unknown } {
  if (!Array.isArray(items)) return { changed: false, value: items };
  let changed = false;
  const value = items.map((item) => {
    if (!isPlainObject(item)) return item;
    const r = classify(item.timestamp);
    if (r.kind === 'change') {
      changed = true;
      return { ...item, timestamp: r.to };
    }
    if (r.kind === 'skip') skips.push({ path: skipPath, value: item.timestamp });
    return item;
  });
  return { changed, value };
}

/** Transform `itens`: Record<produtoUid, ItemDoPedido[]>. */
function transformItensMap(
  itens: unknown,
  skips: FieldSkip[],
  skipPath: string[],
): { changed: boolean; value: unknown } {
  if (!isPlainObject(itens)) return { changed: false, value: itens };
  let changed = false;
  const value: Record<string, unknown> = {};
  for (const [key, arr] of Object.entries(itens)) {
    const r = transformItemArray(arr, skips, skipPath);
    value[key] = r.value;
    if (r.changed) changed = true;
  }
  return { changed, value };
}

/** Transform a pedido document (top-level + embedded frete + itens + devolvidos). */
export function transformPedido(data: Record<string, unknown>): DocTransform {
  const out: DocTransform = { changes: [], skips: [] };

  for (const field of PEDIDO_FIELDS) classifyInto(data, field, [], out);

  if (isPlainObject(data.freteInicial)) {
    for (const field of FRETE_FIELDS) classifyInto(data.freteInicial, field, ['freteInicial'], out);
  }

  // itens — whole map is rewritten when any nested item.timestamp changes
  // (Firestore can't path into array elements).
  const itens = transformItensMap(data.itens, out.skips, ['itens']);
  if (itens.changed) out.changes.push({ path: ['itens'], from: data.itens, to: itens.value });

  // itensDevolvidos — Record<x, Record<produtoUid, ItemDoPedido[]>>
  if (isPlainObject(data.itensDevolvidos)) {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(data.itensDevolvidos)) {
      const r = transformItensMap(inner, out.skips, ['itensDevolvidos']);
      value[key] = r.value;
      if (r.changed) changed = true;
    }
    if (changed)
      out.changes.push({ path: ['itensDevolvidos'], from: data.itensDevolvidos, to: value });
  }

  return out;
}

/** Transform a pagamento document (the five ISO-string datetime fields). */
export function transformPagamento(data: Record<string, unknown>): DocTransform {
  const out: DocTransform = { changes: [], skips: [] };
  for (const field of PAGAMENTO_FIELDS) classifyInto(data, field, [], out);
  return out;
}

/** Transform a metodo_pgto document (`dataCadastro`). */
export function transformMetodoPgto(data: Record<string, unknown>): DocTransform {
  const out: DocTransform = { changes: [], skips: [] };
  classifyInto(data, 'dataCadastro', [], out);
  return out;
}

/**
 * Build a Firestore `update()` payload from a doc's changes. Keys are
 * dot-joined field paths (every segment is a fixed, dot-free field name, so
 * the dot-path form is unambiguous); the whole `itens` / `itensDevolvidos` map
 * is replaced wholesale.
 */
export function buildUpdate(changes: FieldChange[]): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const c of changes) update[c.path.join('.')] = c.to;
  return update;
}
