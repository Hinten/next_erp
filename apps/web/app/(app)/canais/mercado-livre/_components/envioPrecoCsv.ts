/**
 * The "Atualizar preços" result as a CSV — semicolon-delimited with a UTF-8 BOM
 * and comma decimals, the combination Excel pt-BR opens correctly.
 *
 * This restores a legacy feature the port dropped: `atualizarPrecosDialog` had a
 * "Baixar CSV de erros" button (`.old/lib/canaisDeVenda/atualizarPreco.dart:12`),
 * and #543 lists it as an acceptance criterion. It carries more than the legacy
 * one did — every produto rather than only the errors, and `de → para` prices —
 * because the bulk job now records them.
 *
 * ⚠️ **The file ENDS with a totals trailer, and that is a correctness feature.**
 * A truncated CSV is missing the block, so an incomplete report is visibly
 * detectable rather than silently short — the same discipline as the NF-e
 * report's trailer and as `RECONCILIACAO_INCOMPLETA`. When the run did not cover
 * everything the trailer says so in words, not just in numbers.
 */
import type {
  MercadoLivreRelatorioEnvioPrecoLinha,
  MercadoLivreRelatorioEnvioPrecoPagina,
} from '@/lib/mercado-livre/client';
import { CSV_BOM, csvRow } from '@/lib/nfe/export/csv';

/**
 * ⚠️ `Intl.NumberFormat`, NOT `centsToBr`. These prices are REAIS (the job
 * stores `roundReais`'d floats, the same shape `fila` carries), so the cents
 * helper would divide every one of them by 100. Mirrors
 * `lib/produtos/bulkPreco/precoCsv.ts`, which formats the same kind of value.
 */
const BR_MONEY = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function brMoney(value: number | null): string {
  return value === null ? '' : BR_MONEY.format(value);
}

const RESULTADO_LABEL: Record<MercadoLivreRelatorioEnvioPrecoLinha['resultado'], string> = {
  enviado: 'Enviado',
  pulado: 'Pulado',
  falha: 'Falha',
  'nao-tentado': 'Não tentado',
};

const FASE_LABEL: Record<MercadoLivreRelatorioEnvioPrecoLinha['fase'], string> = {
  plano: 'Planejamento',
  envio: 'Envio',
  reconciliacao: 'Conferência',
};

export const ENVIO_PRECO_CSV_HEADER = [
  'Resultado',
  'Fase',
  'SKU',
  'Produto',
  'ID Produto',
  'Variação',
  'Anúncio',
  'Preço anterior',
  'Preço calculado',
  'Diferença',
  'Motivo',
  'Detalhe',
  'Erro',
] as const;

/** Ordered so the rows a human acts on come first, then by SKU (nulls last). */
const ORDEM: Record<MercadoLivreRelatorioEnvioPrecoLinha['resultado'], number> = {
  falha: 0,
  'nao-tentado': 1,
  pulado: 2,
  enviado: 3,
};

function comparar(
  a: MercadoLivreRelatorioEnvioPrecoLinha,
  b: MercadoLivreRelatorioEnvioPrecoLinha,
): number {
  const porResultado = ORDEM[a.resultado] - ORDEM[b.resultado];
  if (porResultado !== 0) return porResultado;
  if (a.sku === null && b.sku === null) return 0;
  if (a.sku === null) return 1;
  if (b.sku === null) return -1;
  return a.sku.localeCompare(b.sku);
}

/**
 * The job-level facts the trailer needs — DERIVED from the relatório page rather
 * than re-spelled, because that page is literally where every one of them comes
 * from (`useBaixarRelatorioPreco` passes them straight through).
 *
 * ⚠️ It used to hand-spell them, and the `status` union carried a comment saying
 * it "has to track the schema". That is the root `CLAUDE.md` smell: a comment
 * asserting what another copy does, which reads correct right up until the two
 * disagree. `cancelled` (#1144) was remembered here, and the next member would
 * have been a coin flip. `Pick` makes the compiler carry the rule instead — and
 * a status the wire can return is now, by construction, a status the trailer can
 * print.
 */
export type EnvioPrecoCsvResumo = Pick<
  MercadoLivreRelatorioEnvioPrecoPagina,
  'status' | 'relatorioCompleto' | 'filaRestante' | 'planejados' | 'enviados' | 'pulados' | 'falhas'
>;

/** Build the whole CSV text. Pure — the caller hands it to `saveBlob`. */
export function buildEnvioPrecoCsv(
  linhas: readonly MercadoLivreRelatorioEnvioPrecoLinha[],
  resumo: EnvioPrecoCsvResumo,
  opts: { truncado?: boolean } = {},
): string {
  const ordenadas = [...linhas].sort(comparar);
  const corpo = ordenadas.map((l) =>
    csvRow([
      RESULTADO_LABEL[l.resultado],
      FASE_LABEL[l.fase],
      l.sku ?? '',
      l.produtoNome ?? '',
      l.produtoId,
      l.variacaoProdutoId ?? '',
      l.anuncioId ?? '',
      brMoney(l.precoAnterior),
      // ⚠️ 'calculado', not 'enviado': `preco` is the price the plan INTENDED, and a
      // `pulado`/`falha` row carries it too ("we wanted 50 and ML refused"). Naming
      // the column 'enviado' would assert it landed.
      brMoney(l.preco),
      // ⚠️ Keyed off `resultado`, never off both prices being non-null. A refused
      // send has both — listing at 90, intended 50 — so the unconditional version
      // printed a -40,00 movement for a listing that never moved, which is the
      // exact false claim this report exists to prevent.
      l.resultado === 'enviado' && l.preco !== null && l.precoAnterior !== null
        ? brMoney(l.preco - l.precoAnterior)
        : '',
      l.motivo ?? '',
      l.mensagem ?? '',
      l.erro ?? '',
    ]),
  );

  return (
    CSV_BOM +
    [
      csvRow([...ENVIO_PRECO_CSV_HEADER]),
      ...corpo,
      ...trailer(ordenadas.length, resumo, opts),
    ].join('\r\n')
  );
}

/**
 * The closing block — also the completeness marker. Its absence is what makes a
 * truncated file detectable; its wording is what stops a partial run from
 * reading as a clean one.
 */
function trailer(
  linhasNoArquivo: number,
  resumo: EnvioPrecoCsvResumo,
  opts: { truncado?: boolean },
): string[] {
  const linhas = [
    '',
    csvRow([`Total de linhas no arquivo: ${String(linhasNoArquivo)}`]),
    csvRow([
      `Planejados: ${String(resumo.planejados)}`,
      `Enviados: ${String(resumo.enviados)}`,
      `Pulados: ${String(resumo.pulados)}`,
      `Falhas: ${String(resumo.falhas)}`,
    ]),
  ];

  if (!resumo.relatorioCompleto) {
    linhas.push(
      csvRow([
        `RELATORIO INCOMPLETO — o envio terminou em "${resumo.status}"` +
          (resumo.filaRestante > 0
            ? `; ${String(resumo.filaRestante)} itens não foram tentados.`
            : '.'),
      ]),
    );
  }
  if (opts.truncado === true) {
    // A client-side page cap was hit. Saying so is the difference between a
    // short file and a short file that looks complete.
    linhas.push(csvRow(['DOWNLOAD TRUNCADO — o relatório é maior que o limite desta tela.']));
  }
  return linhas;
}

/** `Envio de precos - <conta> - 2026-08-28 15-30.csv`, path-hostile chars stripped. */
export function envioPrecoCsvFilename(contaNome: string, startedAt: number): string {
  const d = new Date(startedAt);
  const stamp = Number.isNaN(d.getTime())
    ? 'sem-data'
    : `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const conta = contaNome.replace(/[\\/:*?"<>|]/g, '').trim();
  return `Envio de precos - ${conta === '' ? 'conta' : conta} - ${stamp}.csv`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
