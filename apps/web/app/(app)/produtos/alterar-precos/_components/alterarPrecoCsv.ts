import { CSV_BOM, csvRow } from '@/lib/nfe/export/csv';
import type { ApplyOutcome, PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';

/**
 * CSV export for the bulk manual price editor (#545) — port of the legacy
 * `gerarRelatorioCSV` (`.old/lib/produtos/pages/alterarPrecoMassa.dart:169-193`).
 * Distinct from the sibling #544 screen's `precoCsv.ts`: different header
 * (`Custo`/`Novo Valor` vs. `Diferença`), different null-fallback strings
 * (legacy parity, not the recalculo report's blanks), and an extra
 * outcome-aware Erro column once the apply step has actually run.
 */

export const ALTERAR_PRECO_CSV_HEADER = [
  'Sku',
  'Produto',
  'Custo',
  'Preço Antigo',
  'Novo Valor',
  'Erro',
] as const;

/** Same pt-BR grouped-decimal convention as the sibling `precoCsv.ts`'s `BR_MONEY`. */
const BR_MONEY = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Erro column: a calc-time error (`row.erro`) always wins; otherwise a
 * bounds-skip reports `'Fora dos limites'`; otherwise — once the apply step
 * has run — the row's `ApplyOutcome` fills in why nothing was written
 * (`'pulado (direção)'` for the direction-gate skip, `'sem alteração'` when
 * the fresh price already matched, the write-time error message for a
 * `'erro'` outcome). `'aplicado'` (or no outcome at all, i.e. the pre-apply
 * report) leaves the cell blank. Legacy only ever had the calc-time error —
 * the outcome branch is this port's addition, since this same builder now
 * also produces the POST-apply report (`AplicarDialog`'s "Baixar Relatório").
 */
function erroCell(row: PrecoAlteracao, outcome: ApplyOutcome | undefined): string {
  if (row.erro) return row.erro;
  if (row.foraDosLimites) return 'Fora dos limites';
  if (!outcome) return '';
  switch (outcome.status) {
    case 'pulado':
      return 'pulado (direção)';
    case 'semAlteracao':
      return 'sem alteração';
    case 'erro':
      return outcome.erro ?? 'Erro ao aplicar';
    case 'aplicado':
    default:
      return '';
  }
}

/** Build the full CSV text (BOM + header + one row per produto, in the given order). */
export function buildAlterarPrecoCsv(
  rows: readonly PrecoAlteracao[],
  outcomes?: ReadonlyMap<string, ApplyOutcome>,
): string {
  const lines = [
    csvRow(ALTERAR_PRECO_CSV_HEADER),
    ...rows.map((row) => {
      const outcome = outcomes?.get(row.produtoId);
      return csvRow([
        row.sku ?? 'Sem Sku',
        row.nome,
        row.custo === null ? 'N/A' : BR_MONEY.format(row.custo),
        row.precoAtual === null ? 'N/A' : BR_MONEY.format(row.precoAtual),
        // Legacy typo 'Não foi possível calular' is FIXED here — 'calcular'.
        row.precoNovo === null ? 'Não foi possível calcular' : BR_MONEY.format(row.precoNovo),
        erroCell(row, outcome),
      ]);
    }),
  ];

  return CSV_BOM + lines.join('\r\n');
}

/**
 * `${listaNome}_${y}_${m}_${d}_${h}_${min}_${s}.csv` — local time, NO
 * zero-padding, exactly the legacy template
 * (`'${tabela.nome}_${now.year}_${now.month}_${now.day}_${now.hour}_${now.minute}_${now.second}.csv'`,
 * `alterarPrecoMassa.dart:189`). Dart's plain `int` interpolation never pads
 * either, so `9` stays `9`, not `09` — deliberately NOT the sibling
 * `precoCsv.ts`'s `precoCsvFilename` (which slugifies + zero-pads on a
 * different, non-legacy-matching format).
 */
export function alterarPrecoCsvFilename(listaNome: string, now: Date): string {
  return `${listaNome}_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}.csv`;
}
