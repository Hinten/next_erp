import { TRUNCATED_VALUE_KEY } from '@delfrance/core';
import { diffPrecos, type PrecosMap } from '@delfrance/schemas';

/**
 * One `historicoDeModificacoes` doc, narrowed to the single `changes.<field>`
 * side `ProdutoHistoryButton` asked for (via the pipeline `select` / classic
 * `changes[field]` read). `change` is `undefined` when the projected field is
 * absent from the doc (shouldn't happen given the `campos array-contains`
 * filter that selected it, but tolerated defensively).
 */
export interface HistoryEntryRow {
  /** Document id — `eventId`, unique per row, used as the React key base. */
  id: string;
  change: { old: unknown; new: unknown } | undefined;
  timestamp: number | null;
}

/**
 * One side (old or new) of a displayed change. `truncated` marks a value that
 * `diffDocumentFields` (`@delfrance/core`) replaced with the
 * `TRUNCATED_VALUE_KEY` sentinel because it was too large to store verbatim —
 * `value` is `null` in that case, and the caller renders an em-dash + tooltip
 * instead of treating it as "no value".
 */
export interface HistoryValue {
  value: number | null;
  truncated: boolean;
}

/** A single displayed row of the history table. */
export interface HistoryDisplayRow {
  key: string;
  timestamp: number | null;
  original: HistoryValue;
  final: HistoryValue;
}

function isTruncationSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[TRUNCATED_VALUE_KEY] === true
  );
}

function precoValorPara(map: PrecosMap, listaId: string): number | null {
  return map?.[listaId]?.valor ?? null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Builds the price-history rows for a single lista out of the
 * `changes.precos` side of every `historicoDeModificacoes` entry. Each entry's
 * `{old, new}` precos maps are diffed with `diffPrecos` and filtered down to
 * `listaId` — a lista untouched by that particular event produces no row
 * (`diffPrecos` returns no entry for it, or the filter drops it).
 *
 * When either side of the map was too large to store (`TRUNCATED_VALUE_KEY`
 * sentinel), there is no map to diff — the affected side(s) render as a
 * truncated value on a single row rather than being silently dropped, since
 * we can't rule out that `listaId`'s price changed too.
 */
export function buildPrecoHistoryRows(
  rows: readonly HistoryEntryRow[],
  listaId: string,
): HistoryDisplayRow[] {
  const out: HistoryDisplayRow[] = [];
  for (const row of rows) {
    if (!row.change) continue;
    const { old: oldRaw, new: newRaw } = row.change;
    const oldTruncated = isTruncationSentinel(oldRaw);
    const newTruncated = isTruncationSentinel(newRaw);

    if (oldTruncated || newTruncated) {
      out.push({
        key: row.id,
        timestamp: row.timestamp,
        original: {
          value: oldTruncated ? null : precoValorPara(oldRaw as PrecosMap, listaId),
          truncated: oldTruncated,
        },
        final: {
          value: newTruncated ? null : precoValorPara(newRaw as PrecosMap, listaId),
          truncated: newTruncated,
        },
      });
      continue;
    }

    const changes = diffPrecos(oldRaw as PrecosMap, newRaw as PrecosMap).filter(
      (change) => change.listaId === listaId,
    );
    for (const change of changes) {
      out.push({
        key: `${row.id}:${change.listaId}`,
        timestamp: row.timestamp,
        original: { value: change.valorOriginal, truncated: false },
        final: { value: change.valorFinal, truncated: false },
      });
    }
  }
  return out;
}

/**
 * Builds the cost-history rows out of the `changes.custo` side of every
 * `historicoDeModificacoes` entry — one row per entry, old value -> new
 * value (unlike the legacy `historicoDeCusto` docs, which only kept the new
 * value).
 */
export function buildCustoHistoryRows(rows: readonly HistoryEntryRow[]): HistoryDisplayRow[] {
  const out: HistoryDisplayRow[] = [];
  for (const row of rows) {
    if (!row.change) continue;
    const { old: oldRaw, new: newRaw } = row.change;
    const oldTruncated = isTruncationSentinel(oldRaw);
    const newTruncated = isTruncationSentinel(newRaw);
    out.push({
      key: row.id,
      timestamp: row.timestamp,
      original: { value: oldTruncated ? null : asNumberOrNull(oldRaw), truncated: oldTruncated },
      final: { value: newTruncated ? null : asNumberOrNull(newRaw), truncated: newTruncated },
    });
  }
  return out;
}
