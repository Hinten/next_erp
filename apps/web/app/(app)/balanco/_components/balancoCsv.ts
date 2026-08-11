import { CSV_BOM, csvRow } from '@/lib/nfe/export/csv';

import { diferenca, type LinhaRevisao } from './balancoTotais';

/**
 * CSV export for a balanço. Keeps legacy's `;` delimiter (Excel pt-BR) and
 * adds what the house primitive already does right: a UTF-8 BOM so accents
 * survive, formula-injection neutralisation, and `\r\n`.
 *
 * Two divergences from legacy worth knowing:
 *  - an uncounted produto exports an EMPTY cell, not the literal string
 *    `"Nada foi lançado"` inside a numeric column;
 *  - numbers use comma decimals throughout (legacy mixed raw doubles in the
 *    finalized export with 2-decimal strings in the live one).
 */
export const BALANCO_CSV_HEADER = [
  'SKU',
  'Nome',
  'Estoque',
  'Quantidade Lançada',
  'Diferença',
] as const;

/** Number → Excel pt-BR decimal. Empty for null (never counted / unknown). */
function num(valor: number | null): string {
  if (valor == null) return '';
  return String(valor).replace('.', ',');
}

export function buildBalancoCsv(linhas: readonly LinhaRevisao[]): string {
  const corpo = linhas.map((linha) =>
    csvRow([
      linha.sku ?? '',
      linha.nome ?? '',
      num(linha.estoque),
      num(linha.contado),
      num(diferenca(linha)),
    ]),
  );
  return CSV_BOM + [csvRow([...BALANCO_CSV_HEADER]), ...corpo].join('\r\n');
}

/** `Balanço <nome> 2026-08-10.csv`, with anything path-hostile stripped. */
export function balancoCsvFilename(nome: string, agora: Date): string {
  const dia = agora.toISOString().slice(0, 10);
  // Legacy embedded a full ISO timestamp — colons and all — in the filename.
  const limpo = nome.replace(/[\\/:*?"<>|]/g, '-').trim();
  return `Balanço ${limpo || 'sem nome'} ${dia}.csv`;
}
