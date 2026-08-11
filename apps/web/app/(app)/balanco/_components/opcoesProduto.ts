'use client';

import type { Produto } from '@delfrance/schemas';

/** One produto offered by the manual-entry autocomplete. */
export interface OpcaoProduto {
  /** The label Mantine renders AND matches on — must be unique in the list. */
  value: string;
  id: string;
  produto: Produto;
}

/**
 * Build the autocomplete options for a page of produtos.
 *
 * ⚠️ Mantine's `Autocomplete` identifies an option **by its label string**
 * ("Values must be unique") — it has no notion of an id. Two produtos sharing a
 * nome and a sku, or two both missing a sku, would therefore collapse into one
 * indistinguishable entry and whichever the lookup found first would be counted.
 * On a stock-count screen that is worse than any error message, so a repeated
 * label is disambiguated with the produto id rather than left ambiguous.
 */
export function construirOpcoes(produtos: Array<{ id: string; produto: Produto }>): OpcaoProduto[] {
  const vistos = new Map<string, number>();
  return produtos.map(({ id, produto }) => {
    const base = `${produto.nome ?? id} — ${produto.sku ?? 'sem SKU'}`;
    const anterior = vistos.get(base) ?? 0;
    vistos.set(base, anterior + 1);
    return { value: anterior === 0 ? base : `${base} · ${id}`, id, produto };
  });
}

/**
 * The option a search term already names, or `null` when the term is a genuine
 * search.
 *
 * This is the whole fix for a silent no-op: clicking a suggestion makes Mantine
 * fire `onChange` with the option's **label** ("Nome — SKU"), not the text the
 * operator typed. Feeding that label back into the produto search runs it as a
 * `nome` prefix range, which matches nothing (the real `nome` is only the first
 * half of the label), so the option list is emptied — and the option list is
 * what "Lançar" resolves the chosen produto against. The button then did
 * nothing at all, except in the brief window before the re-query resolved.
 *
 * A term that exactly equals a listed option is a *selection*, not a new query.
 */
export function opcaoSelecionada(opcoes: OpcaoProduto[], termo: string): OpcaoProduto | null {
  return opcoes.find((o) => o.value === termo) ?? null;
}
