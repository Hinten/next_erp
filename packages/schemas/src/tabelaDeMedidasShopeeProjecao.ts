import { z } from 'zod';

/**
 * The Shopee size-chart PROJECTOR (Shopee step 18, #1526): one template read by
 * `v2.product.get_size_chart_detail` → the table the `/medidas` Shopee tab
 * renders.
 *
 * Shopee answers COLUMN-oriented: each column is a `measurement` header plus a
 * `measurement_value_list`, and a row is implicit — the i-th entry of every
 * column. No row id, no declared row count, and nothing on the API page states
 * that the columns are equally long. So the projection is done ONCE, here, and
 * every way a template can be unreadable is reported as DATA (`problemas`)
 * instead of being guessed around:
 *
 * - **Type-first cells.** A column's `input_type` names the ONE key its cells
 *   carry — the page's own field descriptions select the key by it — and a key
 *   the type does not name is NEVER read. Shape-first ("exactly one non-null
 *   key") is wrong on a known type because Shopee ZERO-FILLS absent numerics
 *   (measured on the SG sandbox, `apps/shopee/lib/shopee/fixtures/__wire__/README.md`):
 *   a live dropdown cell `{ option: 'M', value: 0, min_value: 0, max_value: 0 }`
 *   would read as ambiguous and every cell of the chart would become a problem.
 *   Shape-first survives only for a column whose type is unknown or absent,
 *   paired with ONE column problem saying so.
 * - **Never zipped.** Rows are built only when every readable column has the
 *   same number of cells; otherwise `linhas` is `null` with `tabela-irregular`
 *   and each column keeps its own cells. Padding with blanks or truncating to
 *   the shortest column would put a measurement on the wrong size.
 * - **Verbatim.** `option`, `display_name`, `input_type`, `unit` and
 *   `size_chart_name` are copied as Shopee sent them — an `option` is JUDGED
 *   trimmed (a blank one is no value) but never stored trimmed, a range is never
 *   reordered, and the unit stays on the column (Shopee sends `'cm'` on the
 *   DROPDOWN column too, so appending it to every cell is the renderer's call).
 * - **The requested id.** `sizeChartId` is the id the caller ASKED for; Shopee's
 *   echo only feeds `id-divergente`.
 *
 * Why it lives in `@delfrance/schemas` and not beside the wire schemas in
 * `@delfrance/integrations-shopee`: `apps/web` cannot import that package, so
 * the OUTPUT type would otherwise be declared a second time in the web's wire
 * mirror, unchecked by the compiler. Here the output is ONE exported Zod schema
 * (`tabelaShopeeProjetadaSchema`) that the server route test and the web both
 * parse with, and the only second description is the structural INPUT below,
 * which the compiler checks at its single call site (`apps/shopee` passes the
 * package's parsed `ShopeeSizeChartDetail` into `projetarTabelaShopee`).
 */

/** The three `input_type` spellings the detail page documents — human strings WITH spaces, matched verbatim. */
export const SHOPEE_SIZE_CHART_INPUT_TYPE = {
  opcao: 'Single Dropdown',
  numero: 'Input Single Number',
  faixa: 'Input Range Number',
} as const satisfies Record<string, string>;

/** `celulaTabelaShopeeSchema.tipo` values. A reader treats any other string as `invalida` (deploy skew). */
export const TIPO_CELULA_TABELA_SHOPEE = {
  opcao: 'opcao',
  numero: 'numero',
  faixa: 'faixa',
  invalida: 'invalida',
} as const satisfies Record<string, string>;

/** `problemaTabelaShopeeSchema.codigo` values. A reader renders any other string as a generic line (deploy skew). */
export const PROBLEMA_TABELA_SHOPEE = {
  /** `size_chart_table` / `column_list` null or `[]`, or not one readable column. */
  semColunas: 'sem-colunas',
  /** A column the package could not parse (its `null` sentinel) — EXCLUDED from `colunas`. */
  colunaIlegivel: 'coluna-ilegivel',
  /** `measurement: null` — the column is kept, its cells read shape-first. */
  colunaSemMedida: 'coluna-sem-medida',
  /** `input_type` outside {@link SHOPEE_SIZE_CHART_INPUT_TYPE} or `null` — ONE per column; cells read shape-first. */
  tipoDeEntradaDesconhecido: 'tipo-de-entrada-desconhecido',
  /** A cell the package could not parse (its `null` sentinel) — its position is kept. */
  celulaIlegivel: 'celula-ilegivel',
  /** The key the column's type names is absent (or a blank `option`). */
  celulaSemValor: 'celula-sem-valor',
  /** Shape-first only: more than one shape is present in the cell. */
  celulaAmbigua: 'celula-ambigua',
  /** One bound of a range without the other. */
  faixaIncompleta: 'faixa-incompleta',
  /** The readable columns do not all have the same number of cells — `linhas` is `null`. */
  tabelaIrregular: 'tabela-irregular',
  /** Shopee echoed a `size_chart_id` other than the one requested. */
  idDivergente: 'id-divergente',
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// OUTPUT — the detail route's `tabela`, parsed by the route test AND by
// apps/web. FLAT and tolerant on purpose: `apps/web` and `apps/shopee` deploy
// separately, so `tipo` / `codigo` are plain strings (a newer server's value
// still parses and renders generically) and every object is a plain
// `z.object` (an unknown key is stripped, never a failure).
// ---------------------------------------------------------------------------

export const celulaTabelaShopeeSchema = z.object({
  /** A {@link TIPO_CELULA_TABELA_SHOPEE} value. */
  tipo: z.string(),
  /** Verbatim, never trimmed — non-null iff `tipo` is `opcao`. */
  option: z.string().nullable(),
  /** Non-null iff `tipo` is `numero`. */
  value: z.number().nullable(),
  /** Both bounds non-null iff `tipo` is `faixa` — never reordered. */
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
});

export const colunaTabelaShopeeSchema = z.object({
  /** `measurement.display_name` verbatim (`null` when absent or `measurement` is `null`). */
  displayName: z.string().nullable(),
  /** `measurement.input_type` verbatim — compare it against {@link SHOPEE_SIZE_CHART_INPUT_TYPE}. */
  inputType: z.string().nullable(),
  /** `measurement.unit` verbatim — present on dropdown columns too. */
  unit: z.string().nullable(),
  /** This column's cells in wire order, one per `measurement_value_list` entry. */
  celulas: z.array(celulaTabelaShopeeSchema),
});

/** Every problem carries all seven keys; the ones that do not apply to its `codigo` are `null`. */
export const problemaTabelaShopeeSchema = z.object({
  /** A {@link PROBLEMA_TABELA_SHOPEE} value. */
  codigo: z.string(),
  /** 0-based position in the WIRE `column_list` (an unreadable column keeps the others' positions). */
  coluna: z.number().int().nullable(),
  /** 0-based position in the column's WIRE `measurement_value_list`. */
  linha: z.number().int().nullable(),
  /** `tipo-de-entrada-desconhecido` only (and `null` there when Shopee sent none). */
  inputType: z.string().nullable(),
  /** `tabela-irregular` only — the readable columns' cell counts, column order. */
  comprimentos: z.array(z.number().int()).nullable(),
  /** `id-divergente` only. */
  pedido: z.number().int().nullable(),
  recebido: z.number().int().nullable(),
});

export const tabelaShopeeProjetadaSchema = z.object({
  /** The REQUESTED id, never Shopee's echo. */
  sizeChartId: z.number().int(),
  /** `size_chart_name` verbatim. */
  sizeChartName: z.string().nullable(),
  /** Readable columns only, wire order. */
  colunas: z.array(colunaTabelaShopeeSchema),
  /** Row i = the i-th cell of every column. `null` ⇔ `tabela-irregular` — never zipped, padded or truncated. */
  linhas: z.array(z.array(celulaTabelaShopeeSchema)).nullable(),
  problemas: z.array(problemaTabelaShopeeSchema),
});

export type CelulaTabelaShopee = z.infer<typeof celulaTabelaShopeeSchema>;
export type ColunaTabelaShopee = z.infer<typeof colunaTabelaShopeeSchema>;
export type ProblemaTabelaShopee = z.infer<typeof problemaTabelaShopeeSchema>;
export type TabelaShopeeProjetada = z.infer<typeof tabelaShopeeProjetadaSchema>;

// ---------------------------------------------------------------------------
// INPUT — structural. The package's parsed `ShopeeSizeChartDetail` must be
// assignable to it; the compiler checks that at the one call site in
// apps/shopee (`lerTabelaDeMedidasShopee`).
// ---------------------------------------------------------------------------

export interface CelulaTabelaShopeeEntrada {
  readonly option: string | null;
  readonly value: number | null;
  readonly min_value: number | null;
  readonly max_value: number | null;
}

export interface ColunaTabelaShopeeEntrada {
  readonly measurement: {
    readonly display_name: string | null;
    readonly input_type: string | null;
    readonly unit: string | null;
  } | null;
  readonly measurement_value_list: readonly (CelulaTabelaShopeeEntrada | null)[] | null;
}

export interface DetalheTabelaShopeeEntrada {
  readonly size_chart_id: number | null;
  readonly size_chart_name: string | null;
  readonly size_chart_table: {
    readonly column_list: readonly (ColunaTabelaShopeeEntrada | null)[] | null;
  } | null;
}

type CodigoProblemaTabelaShopee =
  (typeof PROBLEMA_TABELA_SHOPEE)[keyof typeof PROBLEMA_TABELA_SHOPEE];

/** One problem with all seven keys present — the ones `campos` does not name are `null`. */
function problema(
  codigo: CodigoProblemaTabelaShopee,
  campos: {
    readonly coluna?: number;
    readonly linha?: number;
    readonly inputType?: string | null;
    readonly comprimentos?: number[];
    readonly pedido?: number;
    readonly recebido?: number;
  } = {},
): ProblemaTabelaShopee {
  return {
    codigo,
    coluna: campos.coluna ?? null,
    linha: campos.linha ?? null,
    inputType: campos.inputType ?? null,
    comprimentos: campos.comprimentos ?? null,
    pedido: campos.pedido ?? null,
    recebido: campos.recebido ?? null,
  };
}

/** A cell's reading: the cell, plus the code of its problem when it is `invalida`. */
interface LeituraCelula {
  readonly celula: CelulaTabelaShopee;
  readonly problema: CodigoProblemaTabelaShopee | null;
}

/** An `invalida` cell carries NO value — never the half of a range, never a key the type did not name. */
function invalida(codigo: CodigoProblemaTabelaShopee): LeituraCelula {
  return {
    celula: {
      tipo: TIPO_CELULA_TABELA_SHOPEE.invalida,
      option: null,
      value: null,
      minValue: null,
      maxValue: null,
    },
    problema: codigo,
  };
}

/** The four value keys, `undefined` read as `null` so a hand-built input missing a key cannot throw. */
interface ValoresDaCelula {
  readonly option: string | null;
  readonly value: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
}

function valoresDaCelula(celula: CelulaTabelaShopeeEntrada): ValoresDaCelula {
  return {
    option: celula.option ?? null,
    value: celula.value ?? null,
    minValue: celula.min_value ?? null,
    maxValue: celula.max_value ?? null,
  };
}

/** An option is a value when it has a non-blank character. Judged trimmed, stored verbatim. */
function temOpcao(option: string | null): option is string {
  return option !== null && option.trim() !== '';
}

/** `Single Dropdown`: reads ONLY `option`. */
function lerOpcao(v: ValoresDaCelula): LeituraCelula {
  if (!temOpcao(v.option)) return invalida(PROBLEMA_TABELA_SHOPEE.celulaSemValor);
  return {
    celula: {
      tipo: TIPO_CELULA_TABELA_SHOPEE.opcao,
      option: v.option,
      value: null,
      minValue: null,
      maxValue: null,
    },
    problema: null,
  };
}

/** `Input Single Number`: reads ONLY `value`. */
function lerNumero(v: ValoresDaCelula): LeituraCelula {
  if (v.value === null) return invalida(PROBLEMA_TABELA_SHOPEE.celulaSemValor);
  return {
    celula: {
      tipo: TIPO_CELULA_TABELA_SHOPEE.numero,
      option: null,
      value: v.value,
      minValue: null,
      maxValue: null,
    },
    problema: null,
  };
}

/** `Input Range Number`: reads ONLY `min_value` / `max_value`, in the order Shopee sent them. */
function lerFaixa(v: ValoresDaCelula): LeituraCelula {
  if (v.minValue !== null && v.maxValue !== null) {
    return {
      celula: {
        tipo: TIPO_CELULA_TABELA_SHOPEE.faixa,
        option: null,
        value: null,
        minValue: v.minValue,
        maxValue: v.maxValue,
      },
      problema: null,
    };
  }
  if (v.minValue !== null || v.maxValue !== null) {
    return invalida(PROBLEMA_TABELA_SHOPEE.faixaIncompleta);
  }
  return invalida(PROBLEMA_TABELA_SHOPEE.celulaSemValor);
}

/**
 * Unknown / absent type: the cell's SHAPE decides, and only when it is
 * unambiguous. A range counts as one shape whether one or both bounds are
 * present, so a lone bound beside a value is ambiguous, not a half range.
 */
function lerPelaForma(v: ValoresDaCelula): LeituraCelula {
  const opcao = temOpcao(v.option);
  const numero = v.value !== null;
  const faixa = v.minValue !== null || v.maxValue !== null;
  const formas = Number(opcao) + Number(numero) + Number(faixa);
  if (formas === 0) return invalida(PROBLEMA_TABELA_SHOPEE.celulaSemValor);
  if (formas > 1) return invalida(PROBLEMA_TABELA_SHOPEE.celulaAmbigua);
  if (opcao) return lerOpcao(v);
  if (numero) return lerNumero(v);
  return lerFaixa(v);
}

/** The reader a KNOWN `input_type` names, or `null` — matched verbatim (no trim, no case fold). */
function leitorDoTipo(inputType: string | null): ((v: ValoresDaCelula) => LeituraCelula) | null {
  if (inputType === SHOPEE_SIZE_CHART_INPUT_TYPE.opcao) return lerOpcao;
  if (inputType === SHOPEE_SIZE_CHART_INPUT_TYPE.numero) return lerNumero;
  if (inputType === SHOPEE_SIZE_CHART_INPUT_TYPE.faixa) return lerFaixa;
  return null;
}

/**
 * THE echo rule — whether a `get_size_chart_detail` answer is about ANOTHER
 * template than the one asked for. Returns the echoed id when it is present and
 * differs from `sizeChartIdPedido`, else `null`. An ABSENT echo (`null`) proves
 * nothing either way and is NOT a divergence.
 *
 * {@link projetarTabelaShopee} turns a non-null answer into `id-divergente`; the
 * `apps/shopee` list walk uses it to refuse labelling a listed id with another
 * chart's name. One function, so "Ver" and the list cannot disagree (#1369).
 */
export function ecoDivergenteTabelaShopee(
  sizeChartIdPedido: number,
  detalhe: Pick<DetalheTabelaShopeeEntrada, 'size_chart_id'>,
): number | null {
  const eco = detalhe.size_chart_id ?? null;
  return eco !== null && eco !== sizeChartIdPedido ? eco : null;
}

/**
 * Projects one `get_size_chart_detail` response.
 *
 * `problemas` come in discovery order: Shopee's echo (`id-divergente`), then
 * each column in wire order — its own problem first, then its cells' by row —
 * then the table's verdict (`sem-colunas` or `tabela-irregular`).
 *
 * Pure and total — never throws on any value the package schema produced.
 */
export function projetarTabelaShopee(
  sizeChartIdPedido: number,
  detalhe: DetalheTabelaShopeeEntrada,
): TabelaShopeeProjetada {
  const problemas: ProblemaTabelaShopee[] = [];

  const recebido = ecoDivergenteTabelaShopee(sizeChartIdPedido, detalhe);
  if (recebido !== null) {
    problemas.push(
      problema(PROBLEMA_TABELA_SHOPEE.idDivergente, { pedido: sizeChartIdPedido, recebido }),
    );
  }

  const colunas: ColunaTabelaShopee[] = [];
  const colunasDoFio = detalhe.size_chart_table?.column_list ?? [];
  colunasDoFio.forEach((colunaDoFio, coluna) => {
    if (colunaDoFio === null) {
      problemas.push(problema(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna }));
      return;
    }

    const medida = colunaDoFio.measurement ?? null;
    const inputType = medida?.input_type ?? null;
    const leitorConhecido = leitorDoTipo(inputType);
    if (medida === null) {
      problemas.push(problema(PROBLEMA_TABELA_SHOPEE.colunaSemMedida, { coluna }));
    } else if (leitorConhecido === null) {
      problemas.push(
        problema(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, { coluna, inputType }),
      );
    }
    // A column without a measurement has no type to name a key — shape-first, like an unknown type.
    const ler = leitorConhecido ?? lerPelaForma;

    const celulas: CelulaTabelaShopee[] = [];
    (colunaDoFio.measurement_value_list ?? []).forEach((celulaDoFio, linha) => {
      const leitura =
        celulaDoFio === null
          ? invalida(PROBLEMA_TABELA_SHOPEE.celulaIlegivel)
          : ler(valoresDaCelula(celulaDoFio));
      celulas.push(leitura.celula);
      if (leitura.problema !== null) problemas.push(problema(leitura.problema, { coluna, linha }));
    });

    colunas.push({
      displayName: medida?.display_name ?? null,
      inputType,
      unit: medida?.unit ?? null,
      celulas,
    });
  });

  if (colunas.length === 0) {
    problemas.push(problema(PROBLEMA_TABELA_SHOPEE.semColunas));
    return {
      sizeChartId: sizeChartIdPedido,
      sizeChartName: detalhe.size_chart_name ?? null,
      colunas,
      linhas: [],
      problemas,
    };
  }

  const comprimentos = colunas.map((c) => c.celulas.length);
  const altura = comprimentos[0] ?? 0;
  let linhas: CelulaTabelaShopee[][] | null = null;
  if (comprimentos.every((n) => n === altura)) {
    // Every column has exactly `altura` cells here: row i takes the i-th cell of each, column order kept.
    const transposta: CelulaTabelaShopee[][] = Array.from({ length: altura }, () => []);
    for (const c of colunas) c.celulas.forEach((celula, linha) => transposta[linha]?.push(celula));
    linhas = transposta;
  } else {
    problemas.push(problema(PROBLEMA_TABELA_SHOPEE.tabelaIrregular, { comprimentos }));
  }

  return {
    sizeChartId: sizeChartIdPedido,
    sizeChartName: detalhe.size_chart_name ?? null,
    colunas,
    linhas,
    problemas,
  };
}
