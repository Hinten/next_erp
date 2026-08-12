import { roundReais } from '@delfrance/core/money';
import type { PrecosMap } from '@delfrance/schemas';
import type { PrecoAlteracao } from './types';

/**
 * Manual bulk price-editor strategy engine (#545) — port of the Flutter
 * `_calcularPreco*` family (`.old/lib/produtos/pages/alterarPrecoMassa.dart:577-705`).
 * Unlike the sibling #544 recalculation screen (`computeRecalculo.ts`, which
 * drives the lista's own formula engine), this is a SINGLE user-picked
 * strategy applied once per produto — the issue deliberately drops legacy's
 * regra-stacking (`_calcularPreco`'s loop over multiple regras, L517-574).
 *
 * Every strategy is bounded by `valorMinimo`/`valorMaximo` — including
 * `copiarOutraTabela`, which legacy rendered bounds inputs for but never
 * actually checked (`alterarPrecoMassa.dart:680-705` — `_calcularPrecoCopiarOutraTabela`
 * never reads `regras['valorMinimo']`/`regras['valorMaximo']` after validating
 * they're present). The issue says all four strategies are bounded, so this
 * port applies the bound to strategy 4 too; that is a deliberate deviation
 * from the legacy behavior, not a bug in this port.
 */

/** Shared min/max band every strategy is checked against, post-rounding. */
export interface RegraBounds {
  valorMinimo: number;
  valorMaximo: number;
}

/**
 * Cálculo detalhado — full cost-plus-margin formula
 * (`_calcularPrecoDetalhado`, L577-616):
 * `(custo + lucro*custo + tarifaFixa) / (1 - (comissao + imposto + frete + marketing))
 * * (1 + margemSeguranca)`.
 * Uses the produto's RAW `custo` — NOT kit-accounted, unlike #544's
 * `custoEfetivo` (legacy L586 reads `produtoInstance.custo` directly, no kit
 * resolution here either).
 */
export interface DetalhadoEstrategia extends RegraBounds {
  tipo: 'detalhado';
  lucro: number;
  tarifaFixa: number;
  comissao: number;
  imposto: number;
  frete: number;
  marketing: number;
  margemSeguranca: number;
}

/** Valor fixo — the new price IS the input, no formula (`_calcularPrecoValorFixo`, L618-643). */
export interface ValorFixoEstrategia extends RegraBounds {
  tipo: 'valorFixo';
  novoPreco: number;
}

/**
 * Com base no preço atual — `valorAtual + valorAtual*percentual + valorFixo`
 * (`_calcularPrecoComBaseNoPrecoAtual`, L645-678). `valorAtual` is the
 * produto's EXISTING price under the target lista; a produto with none there
 * yet errors (legacy L659-661), it isn't just skipped.
 */
export interface PrecoAtualEstrategia extends RegraBounds {
  tipo: 'precoAtual';
  percentual: number;
  valorFixo: number;
}

/**
 * Copiar de outra tabela — copies `produto.precos[outraListaId].valor`
 * verbatim (`_calcularPrecoCopiarOutraTabela`, L680-705). A produto with no
 * price in the source lista errors (legacy L694-696).
 */
export interface CopiarOutraTabelaEstrategia extends RegraBounds {
  tipo: 'copiarOutraTabela';
  outraListaId: string;
}

export type EstrategiaPreco =
  | DetalhadoEstrategia
  | ValorFixoEstrategia
  | PrecoAtualEstrategia
  | CopiarOutraTabelaEstrategia;

/** Per-produto inputs `calcularPrecoEstrategia` needs — resolved by the caller
 * (`buildPreviewRows` resolves these from the produto's own `precos` map). */
export interface EstrategiaInput {
  custo: number | null;
  precoAtual: number | null;
  precoOutraTabela: number | null;
}

/**
 * Result of applying one strategy to one produto:
 * - `novo` set → a usable price (already rounded, inside bounds).
 * - `erro` set → the strategy couldn't compute a price at all (missing
 *   custo/preço — the legacy `throw`s at L589/L660/L695).
 * - `foraDosLimites: true` → a price WAS computed but fell outside
 *   `valorMinimo`/`valorMaximo` — skipped, not an error (legacy `return null`
 *   at L605-607/L630-633/L665-668, extended here to strategy 4 too).
 */
export type EstrategiaResultado =
  | { novo: number; erro: null; foraDosLimites: false }
  | { novo: null; erro: string; foraDosLimites: false }
  | { novo: null; erro: null; foraDosLimites: true };

/** Exact legacy error strings — matched verbatim (support tickets/tests may reference them). */
const ERRO_CUSTO_NAO_ENCONTRADO = 'Custo do produto não encontrado';
const ERRO_SEM_PRECO_NA_TABELA = 'Este produto não possui preço cadastrado na tabela';
const ERRO_SEM_PRECO_NA_OUTRA_TABELA =
  'Este produto não possui preço na tabela selecionada para copiar';

/**
 * NEW guard (owner-approved deviation, not in the legacy source): when the
 * detalhado taxas sum to 1 or more, the formula's denominator
 * `(1 - soma)` is zero or negative — legacy silently produced `Infinity`/a
 * negative price instead of failing. This surfaces it as a proper `erro`
 * string; `regraSchema.ts`'s `superRefine` blocks it at the form level too
 * (belt-and-suspenders — this pure fn is also callable directly).
 */
export const ERRO_TAXAS_SOMA =
  'A soma de comissão, imposto, frete e marketing deve ser menor que 1';

/** Round the raw formula output and apply the strict min/max band. */
function bounded(novoRaw: number, bounds: RegraBounds): EstrategiaResultado {
  const novo = roundReais(novoRaw);
  if (novo < bounds.valorMinimo || novo > bounds.valorMaximo) {
    return { novo: null, erro: null, foraDosLimites: true };
  }
  return { novo, erro: null, foraDosLimites: false };
}

/** Compute one produto's new price under the chosen strategy. Pure — no
 * Firestore, no React. */
export function calcularPrecoEstrategia(
  estrategia: EstrategiaPreco,
  input: EstrategiaInput,
): EstrategiaResultado {
  switch (estrategia.tipo) {
    case 'detalhado': {
      if (input.custo === null) {
        return { novo: null, erro: ERRO_CUSTO_NAO_ENCONTRADO, foraDosLimites: false };
      }
      const taxas =
        estrategia.comissao + estrategia.imposto + estrategia.frete + estrategia.marketing;
      if (taxas >= 1) {
        return { novo: null, erro: ERRO_TAXAS_SOMA, foraDosLimites: false };
      }
      const raw =
        ((input.custo + estrategia.lucro * input.custo + estrategia.tarifaFixa) / (1 - taxas)) *
        (1 + estrategia.margemSeguranca);
      return bounded(raw, estrategia);
    }

    case 'valorFixo': {
      return bounded(estrategia.novoPreco, estrategia);
    }

    case 'precoAtual': {
      if (input.precoAtual === null) {
        return { novo: null, erro: ERRO_SEM_PRECO_NA_TABELA, foraDosLimites: false };
      }
      const raw =
        input.precoAtual + input.precoAtual * estrategia.percentual + estrategia.valorFixo;
      return bounded(raw, estrategia);
    }

    case 'copiarOutraTabela': {
      if (input.precoOutraTabela === null) {
        return { novo: null, erro: ERRO_SEM_PRECO_NA_OUTRA_TABELA, foraDosLimites: false };
      }
      return bounded(input.precoOutraTabela, estrategia);
    }

    default: {
      const _exhaustive: never = estrategia;
      throw new Error(`Estratégia desconhecida: ${String((_exhaustive as EstrategiaPreco).tipo)}`);
    }
  }
}

/**
 * Direction gate — mirrors `aplicarNaDatabase`'s per-produto guard exactly
 * (`alterarPrecoMassa.dart:209-222`). A produto with NO existing price
 * (`precoAtual === null`) always passes, even with both toggles off — there is
 * nothing to compare against, so the new price always "wins" (matches legacy:
 * the `if (precoInicial != null)` block wraps every check). When a price DOES
 * exist, both toggles off skips unconditionally (even if `novo === precoAtual`
 * — legacy's `!baixar && !aumentar` check runs before the equality is ever
 * considered).
 */
export function passaDirecao(
  precoAtual: number | null,
  novo: number,
  dir: { aumentar: boolean; baixar: boolean },
): boolean {
  if (precoAtual === null) return true;

  const { aumentar, baixar } = dir;
  if (!baixar && !aumentar) return false;
  if (!baixar && precoAtual > novo) return false;
  if (!aumentar && precoAtual < novo) return false;
  return true;
}

/** The slim produto shape `buildPreviewRows` needs — a subset of `ProdutoPrecoRow`. */
export interface ProdutoParaPreview {
  id: string;
  sku: string | null;
  nome: string;
  custo: number | null;
  precos: PrecosMap;
}

/**
 * Build one preview row per produto for the chosen strategy — resolves
 * `precoAtual` (target lista) and `precoOutraTabela` (source lista, only for
 * `copiarOutraTabela`) from each produto's own `precos` map, null-safe on a
 * produto with no `precos` at all. Bounds-skipped rows are flagged via
 * `foraDosLimites` — the direction gate (`passaDirecao`) and the apply step
 * never see them (legacy's `aplicarNaDatabase` dereferences `preco!.valor`
 * assuming a non-null result, L214/218 — a `foraDosLimites` row must be
 * partitioned out BEFORE the gate runs, never fed to it).
 */
export function buildPreviewRows(
  produtos: ReadonlyArray<ProdutoParaPreview>,
  targetListaId: string,
  estrategia: EstrategiaPreco,
): PrecoAlteracao[] {
  return produtos.map((produto) => {
    const precoAtual = produto.precos?.[targetListaId]?.valor ?? null;
    const precoOutraTabela =
      estrategia.tipo === 'copiarOutraTabela'
        ? (produto.precos?.[estrategia.outraListaId]?.valor ?? null)
        : null;

    const resultado = calcularPrecoEstrategia(estrategia, {
      custo: produto.custo,
      precoAtual,
      precoOutraTabela,
    });

    return {
      produtoId: produto.id,
      sku: produto.sku,
      nome: produto.nome,
      custo: produto.custo,
      precoAtual,
      precoNovo: resultado.novo,
      erro: resultado.erro,
      foraDosLimites: resultado.foraDosLimites,
      precos: produto.precos,
    };
  });
}
