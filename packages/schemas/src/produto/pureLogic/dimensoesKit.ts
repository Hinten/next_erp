import type { ComponentesKit } from '../collection/embedded/kit';
import { estimarDimensoes, itensDeComponentesKit, type ProdutoMedidas } from './dimensoes';
import {
  KIT_PESO_BRUTO_FALLBACK_KG,
  KIT_PESO_LIQUIDO_FALLBACK_KG,
  pesoDoKit,
} from './precoCalculo';

/**
 * A kit's derived weight and box — the rollup of its `componentesKit`.
 *
 * ⚠️ THE single implementation. `KitManager` pushes it into the produto form and
 * the `recalcularDimensoesKit` task writes it from the other direction (#1152);
 * if those two ever computed it separately the value would flap every time an
 * operator opened a kit. Both call this function; neither reimplements it.
 *
 * ⚠️ Named "dimensões", never "medidas" — `tabelaDeMedidas` is the moda
 * size-chart collection and the words collide.
 */
export interface DimensoesKit {
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  alturaCm: number | null;
  larguraCm: number | null;
  profundidadeCm: number | null;
}

/** Nothing could be derived — every caller leaves the kit's stored values alone. */
export const DIMENSOES_KIT_INDEFINIDAS: DimensoesKit = {
  pesoBrutoKg: null,
  pesoLiquidoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
};

/**
 * A kit's components are packed together deliberately, so the packing allowance
 * is NOT applied here — see {@link FATOR_OCUPACAO}. The pedido estimator applies
 * it once, to the kit's stored box, when the kit becomes an order line.
 */
export const FATOR_OCUPACAO_KIT = 1;

/** One weight series out of the medidas map, in the shape `pesoDoKit` reads. */
function pesoPorProduto(
  medidasById: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
  eixo: 'pesoBrutoKg' | 'pesoLiquidoKg',
): Record<string, number | null | undefined> {
  const out: Record<string, number | null | undefined> = {};
  for (const [id, medidas] of Object.entries(medidasById)) out[id] = medidas?.[eixo] ?? null;
  return out;
}

function paiPorProduto(
  medidasById: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = {};
  for (const [id, medidas] of Object.entries(medidasById)) out[id] = medidas?.paiId ?? null;
  return out;
}

/**
 * Roll a kit's components up into the five produto fields the kit stores.
 *
 * `medidasById` is keyed by component produto id and must ALSO carry the parent
 * of any component that supplies neither its own weight nor its own box — both
 * fallbacks read from this one map, so the caller batches both waves (see
 * `fetchProdutoPesoMap` in `apps/web`, `carregarDimensoes` in `apps/functions`).
 *
 * ⚠️ The two halves resolve a component DIFFERENTLY and must not be folded
 * together: `resolveComponentPeso` treats a stored `0` as a real own weight and
 * falls back to a crude 0.3/0.25 kg default, while `estimarDimensoes` requires
 * all three axes `> 0` and simply skips a component it cannot resolve.
 *
 * A `null` in the result means "not derivable" — never a value to write. Every
 * caller must skip those fields rather than persist a fabricated default (the
 * estimator's `DIMENSOES_PADRAO` 10x10x11 box would otherwise look like a
 * measurement).
 */
export function dimensoesDoKit(
  componentes: ComponentesKit | null | undefined,
  medidasById: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
): DimensoesKit {
  if (Object.keys(componentes ?? {}).length === 0) return DIMENSOES_KIT_INDEFINIDAS;

  const paiById = paiPorProduto(medidasById);
  const estimativa = estimarDimensoes(itensDeComponentesKit(componentes), medidasById, {
    fatorOcupacao: FATOR_OCUPACAO_KIT,
  });
  // `semDimensoes` means NO component resolved a full box, so the estimator fell
  // back to `DIMENSOES_PADRAO`. Persisting that would turn a guess into a stored
  // measurement the freight quote then trusts.
  const semCaixa = estimativa.aviso === 'semDimensoes';

  return {
    pesoBrutoKg: pesoDoKit(
      componentes,
      pesoPorProduto(medidasById, 'pesoBrutoKg'),
      paiById,
      KIT_PESO_BRUTO_FALLBACK_KG,
    ),
    pesoLiquidoKg: pesoDoKit(
      componentes,
      pesoPorProduto(medidasById, 'pesoLiquidoKg'),
      paiById,
      KIT_PESO_LIQUIDO_FALLBACK_KG,
    ),
    alturaCm: semCaixa ? null : estimativa.dimensoes.altura,
    larguraCm: semCaixa ? null : estimativa.dimensoes.largura,
    // ⚠️ The wire's `comprimento` is produto's `profundidadeCm`.
    profundidadeCm: semCaixa ? null : estimativa.dimensoes.comprimento,
  };
}

/** The produto fields {@link dimensoesDoKit} derives, in a stable order. */
export const CAMPOS_DIMENSOES_KIT = [
  'pesoBrutoKg',
  'pesoLiquidoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
] as const satisfies ReadonlyArray<keyof DimensoesKit>;

export type CampoDimensoesKit = (typeof CAMPOS_DIMENSOES_KIT)[number];
