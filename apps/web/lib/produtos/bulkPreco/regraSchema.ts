import { z } from 'zod';

/**
 * FORM-ONLY validation for the bulk price-editor's single strategy picker
 * (#545) — field-for-field mirror of `EstrategiaPreco`/`RegraBounds` in
 * `strategies.ts`, with the legacy default values baked in as Zod
 * `.default()`s (`.old/lib/produtos/pages/alterarPrecoMassa.dart`, the
 * `initialValue`s on each strategy's `DoubleField`s, L1043-1275/1306-1373/
 * 1399-1494/1524-1566).
 *
 * NEVER registered in `ALL_DOMAINS`, NEVER `.pick()`ed — see the
 * `zod4-pick-refine-runtime-crash` note. This schema's own `superRefine`
 * would make a `.pick()` crash at runtime anyway; only pass it to a form's
 * `zodResolver`.
 */

const BOUNDS_MIN_DEFAULT = 0;
const BOUNDS_MAX_DEFAULT = 99_999_999;

/**
 * Every percent field shares the same 0..1 validity band and message — legacy
 * validates every percent `DoubleField` with the identical
 * `'Valor de Percentual de 0 a 1'` string (e.g. `lucro` L1097-1106,
 * `comissao` L1152-1161). Kept lowercase here per the field's own message
 * convention in this port.
 */
function percentField(defaultValue: number) {
  return z
    .number()
    .min(0, 'Valor de percentual de 0 a 1')
    .max(1, 'Valor de percentual de 0 a 1')
    .default(defaultValue);
}

/** Shared by every strategy variant — legacy defaults 0 / 99999999 on every
 * `valorMinimo`/`valorMaximo` pair (e.g. L1043-1085). */
const boundsShape = {
  valorMinimo: z.number().default(BOUNDS_MIN_DEFAULT),
  valorMaximo: z.number().default(BOUNDS_MAX_DEFAULT),
};

/** Legacy defaults (`CalculoPrecoDetalhado`, L1095-1273): lucro .6, tarifaFixa
 * 6, comissao/imposto(`simplesNacional` in legacy)/frete/marketing .2 each,
 * margemSeguranca .2. The legacy `'magemSeguranca'` `onChanged` key typo
 * (L1269) is NOT ported — this schema only ever uses the correct key. */
const detalhadoSchema = z.object({
  tipo: z.literal('detalhado'),
  lucro: percentField(0.6),
  tarifaFixa: z.number().default(6),
  comissao: percentField(0.2),
  imposto: percentField(0.2),
  frete: percentField(0.2),
  marketing: percentField(0.2),
  margemSeguranca: percentField(0.2),
  ...boundsShape,
});

/** No legacy default for `novoPreco` (`ValorFixo`, L1352-1369) — required input. */
const valorFixoSchema = z.object({
  tipo: z.literal('valorFixo'),
  novoPreco: z.number(),
  ...boundsShape,
});

/** Legacy defaults (`ComBaseNoPrecoAntigo`, L1449-1494): percentual .6, valorFixo 5. */
const precoAtualSchema = z.object({
  tipo: z.literal('precoAtual'),
  percentual: percentField(0.6),
  valorFixo: z.number().default(5),
  ...boundsShape,
});

/** `outraListaId` required — legacy's `SeletorTabelaDePrecosWidget` has no
 * default selection either (`CopiarOutraTabela`, L1570-1574). */
const copiarOutraTabelaSchema = z.object({
  tipo: z.literal('copiarOutraTabela'),
  outraListaId: z.string().min(1, 'Selecione a tabela de origem'),
  ...boundsShape,
});

export const regraSchema = z
  .discriminatedUnion('tipo', [
    detalhadoSchema,
    valorFixoSchema,
    precoAtualSchema,
    copiarOutraTabelaSchema,
  ])
  .superRefine((regra, ctx) => {
    if (regra.valorMinimo > regra.valorMaximo) {
      ctx.addIssue({
        code: 'custom',
        path: ['valorMinimo'],
        message: 'Valor mínimo não pode ser maior que o máximo',
      });
    }

    // NEW guard (owner-approved deviation, not in the legacy source): the
    // detalhado formula divides by `(1 - soma)` with no floor — legacy
    // silently produced `Infinity`/a negative price when the taxas summed to
    // 1 or more (`alterarPrecoMassa.dart:601-602`). `strategies.ts`'s pure
    // `calcularPrecoEstrategia` carries the identical guard so it's caught
    // even when called outside this form.
    if (regra.tipo === 'detalhado') {
      const soma = regra.comissao + regra.imposto + regra.frete + regra.marketing;
      if (soma >= 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['comissao'],
          message: 'A soma de comissão, imposto, frete e marketing deve ser menor que 1',
        });
      }
    }
  });

/** Pre-defaults shape (as typed by the strategy picker before `.default()` fills in). */
export type RegraInput = z.input<typeof regraSchema>;
/** Fully-resolved shape (what `handleSubmit`/`calcularPrecoEstrategia` receive). */
export type RegraOutput = z.output<typeof regraSchema>;
export type RegraTipo = RegraOutput['tipo'];

/**
 * Fully-resolved default values for a strategy, keyed by `tipo` — what the
 * form seeds when the user switches strategies. Kept as literals (rather than
 * parsed through the schema above) because `valorFixo`/`copiarOutraTabela`
 * each have one REQUIRED field with no legacy default —
 * `novoPreco`/`outraListaId` — that a bare `{ tipo }` parse would reject.
 * Both seed an EMPTY value the schema rejects (`null`/`''`), so the freshly
 * switched form stays INVALID until the user fills them — the legacy blank
 * required `DoubleField` UX. (A `0` seed for `novoPreco` would be
 * schema-valid: the preview would instantly recompute every produto to
 * R$ 0,00 with Aplicar enabled.) The `null` is what `RegraForm`'s
 * NumberInputs emit for an emptied field anyway (`parseRegraNumber`); the
 * localized cast keeps the declared output type while the resolver rejects
 * the value at runtime.
 */
export function defaultsFor(tipo: RegraTipo): RegraOutput {
  switch (tipo) {
    case 'detalhado':
      return {
        tipo: 'detalhado',
        lucro: 0.6,
        tarifaFixa: 6,
        comissao: 0.2,
        imposto: 0.2,
        frete: 0.2,
        marketing: 0.2,
        margemSeguranca: 0.2,
        valorMinimo: BOUNDS_MIN_DEFAULT,
        valorMaximo: BOUNDS_MAX_DEFAULT,
      };
    case 'valorFixo':
      return {
        tipo: 'valorFixo',
        novoPreco: null as unknown as number, // empty input — invalid until filled (see doc above)
        valorMinimo: BOUNDS_MIN_DEFAULT,
        valorMaximo: BOUNDS_MAX_DEFAULT,
      };
    case 'precoAtual':
      return {
        tipo: 'precoAtual',
        percentual: 0.6,
        valorFixo: 5,
        valorMinimo: BOUNDS_MIN_DEFAULT,
        valorMaximo: BOUNDS_MAX_DEFAULT,
      };
    case 'copiarOutraTabela':
      return {
        tipo: 'copiarOutraTabela',
        outraListaId: '',
        valorMinimo: BOUNDS_MIN_DEFAULT,
        valorMaximo: BOUNDS_MAX_DEFAULT,
      };
    default: {
      const _exhaustive: never = tipo;
      throw new Error(`Tipo de regra desconhecido: ${String(_exhaustive)}`);
    }
  }
}
