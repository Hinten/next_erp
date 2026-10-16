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
 *
 * Channel-neutral (#1529): Mercado Livre and Shopee store the SAME relatório row
 * (`linhaRelatorioEnvioPrecoSchema`), so both channels' downloads build through
 * this one module rather than two copies free to drift on the trailer.
 */
import { ENVIO_PRECO_RESULTADO, type LinhaRelatorioEnvioPreco } from '@delfrance/schemas';
import { CSV_BOM, csvRow } from '@/lib/nfe/export/csv';

/**
 * Bound on the download loop. A report past this is truncated AND SAYS SO in the
 * trailer — a silent cap is the failure this whole area keeps guarding against.
 */
export const MAX_PAGINAS_RELATORIO_PRECO = 100;

/**
 * One CSV row: the stored row's columns (`linhaRelatorioEnvioPrecoSchema`, shared
 * by both channels) plus the three every relatório route JOINS or RENDERS at
 * read time. Both channels' wire rows are assignable — the stored columns this
 * builder never reads (`linkDocId`, `variacoes`) are left out on purpose, so a
 * page that omits them still builds.
 */
export type LinhaEnvioPrecoCsv = Pick<
  LinhaRelatorioEnvioPreco,
  | 'produtoId'
  | 'variacaoProdutoId'
  | 'anuncioId'
  | 'resultado'
  | 'fase'
  | 'motivo'
  | 'erro'
  | 'preco'
  | 'precoAnterior'
> & {
  readonly produtoNome: string | null;
  readonly sku: string | null;
  readonly mensagem: string | null;
};

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

const RESULTADO_LABEL: Record<LinhaEnvioPrecoCsv['resultado'], string> = {
  enviado: 'Enviado',
  pulado: 'Pulado',
  falha: 'Falha',
  'nao-tentado': 'Não tentado',
};

const FASE_LABEL: Record<LinhaEnvioPrecoCsv['fase'], string> = {
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
const ORDEM: Record<LinhaEnvioPrecoCsv['resultado'], number> = {
  falha: 0,
  'nao-tentado': 1,
  pulado: 2,
  enviado: 3,
};

function comparar(a: LinhaEnvioPrecoCsv, b: LinhaEnvioPrecoCsv): number {
  const porResultado = ORDEM[a.resultado] - ORDEM[b.resultado];
  if (porResultado !== 0) return porResultado;
  if (a.sku === null && b.sku === null) return 0;
  if (a.sku === null) return 1;
  if (b.sku === null) return -1;
  return a.sku.localeCompare(b.sku);
}

/**
 * The job-level facts the trailer needs. A channel's download hook passes them
 * straight through from its own wire (`useBaixarRelatorioPreco`: the relatório
 * page), never re-counting them from the rows.
 *
 * ⚠️ It used to hand-spell the `status` union, with a comment saying it "has to
 * track the schema". That is the root `CLAUDE.md` smell: a comment asserting what
 * another copy does, which reads correct right up until the two disagree.
 * `cancelled` (#1144) was remembered here, and the next member would have been a
 * coin flip. The trailer only ever INTERPOLATES `status`, so it is a plain
 * `string`: any status either channel's wire returns is printable by
 * construction, and there is no union left to drift.
 */
export interface EnvioPrecoCsvResumo {
  readonly status: string;
  readonly relatorioCompleto: boolean;
  readonly filaRestante: number;
  readonly planejados: number;
  readonly enviados: number;
  readonly pulados: number;
  readonly falhas: number;
}

/** Build the whole CSV text. Pure — the caller hands it to `saveBlob`. */
export function buildEnvioPrecoCsv(
  linhas: readonly LinhaEnvioPrecoCsv[],
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
      l.resultado === ENVIO_PRECO_RESULTADO.enviado && l.preco !== null && l.precoAnterior !== null
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
