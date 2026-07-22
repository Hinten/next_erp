import { calcularPreco, type ListaDePrecos } from '@delfrance/schemas';
import { custoEfetivo, pesoEfetivoKg } from './efetivos';
import type { KitResolucao, ProdutoPrecoRow } from './loadCatalogo';
import type { PrecoAlteracao } from './types';

/**
 * Pure engine for the bulk price-recalculation screen (#544) — port of the
 * Flutter `calcularPrecos` stream body
 * (`.old/lib/produtos/pages/alterarPrecoMassa2.dart:388-467`). Error strings
 * are matched verbatim (including the `'Sem Sku'` fallback) so support tickets
 * referencing the legacy message still make sense.
 */

type ListaFormulas = Pick<ListaDePrecos, 'formulasCalculoPreco' | 'formulasPorCategoria'>;

/**
 * Whether a lista de preços has ANY usable formula — the default bucket, or
 * any per-categoria bucket. Broader than `temFormulas` (which checks one
 * specific categoria): this is the up-front gate before recalculating a whole
 * catalog against the lista.
 */
export function listaTemAlgumaFormula(lista: ListaFormulas): boolean {
  const padraoNaoVazia = (lista.formulasCalculoPreco?.length ?? 0) > 0;
  if (padraoNaoVazia) return true;
  return Object.values(lista.formulasPorCategoria ?? {}).some(
    (bucket) => (bucket.formulasCalculoPreco?.length ?? 0) > 0,
  );
}

/** `sku ?? 'Sem Sku'` — the exact legacy null-sku fallback used in every error string. */
function skuOuSemSku(sku: string | null): string {
  return sku ?? 'Sem Sku';
}

/**
 * Compute one produto's recalculated price under `lista` — pure port of the
 * per-produto body of the legacy stream (L398-454). `precoAtual` is read
 * straight off the produto's own `precos` map; a `precoNovo !== precoAtual`
 * is NOT treated as an error here — the apply-mode filter (`deveAplicar`)
 * decides which rows are worth writing.
 */
export function computeRecalculoRow(
  p: ProdutoPrecoRow,
  r: KitResolucao,
  listaId: string,
  lista: ListaFormulas,
): PrecoAlteracao {
  const precoAtual = p.precos?.[listaId]?.valor ?? null;
  // `custoEfetivo` reports a missing KIT COMPONENT cost the same way as a
  // produto with no own cost — both surface as `custo: null` here.
  const { custo } = custoEfetivo(p, r);

  if (custo === null) {
    return {
      produtoId: p.id,
      sku: p.sku,
      nome: p.nome,
      custo: null,
      precoAtual,
      precoNovo: null,
      erro: `Produto sem custo ${skuOuSemSku(p.sku)} - ${p.nome}`,
      precos: p.precos,
    };
  }

  if (custo <= 0) {
    return {
      produtoId: p.id,
      sku: p.sku,
      nome: p.nome,
      custo,
      precoAtual,
      precoNovo: null,
      erro: `Produto com custo no valor de ${custo} - ${skuOuSemSku(p.sku)} - ${p.nome}`,
      precos: p.precos,
    };
  }

  const preco = calcularPreco(lista, custo, {
    idCategoria: p.categoriaId,
    pesoKg: pesoEfetivoKg(p, r),
  });

  if (preco === null) {
    return {
      produtoId: p.id,
      sku: p.sku,
      nome: p.nome,
      custo,
      precoAtual,
      precoNovo: null,
      erro: `Preço nulo para o produto ${skuOuSemSku(p.sku)} - ${p.nome}`,
      precos: p.precos,
    };
  }

  return {
    produtoId: p.id,
    sku: p.sku,
    nome: p.nome,
    custo,
    precoAtual,
    precoNovo: preco.valor,
    erro: null,
    precos: p.precos,
  };
}
