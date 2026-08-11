import { describe, expect, it } from 'vitest';
import type { Produto } from '@delfrance/schemas';

import { construirOpcoes, opcaoSelecionada } from './opcoesProduto';

const p = (nome: string | null, sku: string | null) => ({ nome, sku }) as unknown as Produto;

describe('construirOpcoes', () => {
  it('labels a produto with nome and sku', () => {
    expect(construirOpcoes([{ id: 'a', produto: p('Camiseta Azul', 'CAM-1') }])[0]?.value).toBe(
      'Camiseta Azul — CAM-1',
    );
  });

  it('marks a missing sku instead of dropping the produto', () => {
    expect(construirOpcoes([{ id: 'a', produto: p('Camiseta', null) }])[0]?.value).toBe(
      'Camiseta — sem SKU',
    );
  });

  it('falls back to the id when a produto has no nome', () => {
    expect(construirOpcoes([{ id: 'abc', produto: p(null, 'X') }])[0]?.value).toBe('abc — X');
  });

  it('keeps colliding labels distinguishable', () => {
    // Mantine matches options by label, so two produtos with the same nome and
    // no sku would otherwise be one entry — and counting would silently pick
    // whichever came first.
    const opcoes = construirOpcoes([
      { id: 'a', produto: p('Camiseta', null) },
      { id: 'b', produto: p('Camiseta', null) },
    ]);
    expect(opcoes.map((o) => o.value)).toEqual(['Camiseta — sem SKU', 'Camiseta — sem SKU · b']);
    expect(new Set(opcoes.map((o) => o.value)).size).toBe(2);
  });

  it('only disambiguates the repeats, not the first of each label', () => {
    const opcoes = construirOpcoes([
      { id: 'a', produto: p('Camiseta', null) },
      { id: 'b', produto: p('Calça', null) },
      { id: 'c', produto: p('Camiseta', null) },
    ]);
    expect(opcoes.map((o) => o.value)).toEqual([
      'Camiseta — sem SKU',
      'Calça — sem SKU',
      'Camiseta — sem SKU · c',
    ]);
  });
});

describe('opcaoSelecionada', () => {
  const opcoes = construirOpcoes([
    { id: 'a', produto: p('Camiseta Azul', 'CAM-1') },
    { id: 'b', produto: p('Camiseta Verde', 'CAM-2') },
  ]);

  it('recognises a full option label as a selection', () => {
    // This is the regression: Mantine fires onChange with the LABEL when a
    // suggestion is clicked. Treating it as a search term re-queried `nome`
    // with "Camiseta Azul — CAM-1", matched nothing, emptied the list, and left
    // Lançar with nothing to resolve.
    expect(opcaoSelecionada(opcoes, 'Camiseta Azul — CAM-1')?.id).toBe('a');
  });

  it('resolves a disambiguated label to the right produto', () => {
    const ambiguas = construirOpcoes([
      { id: 'a', produto: p('Camiseta', null) },
      { id: 'b', produto: p('Camiseta', null) },
    ]);
    expect(opcaoSelecionada(ambiguas, 'Camiseta — sem SKU · b')?.id).toBe('b');
    expect(opcaoSelecionada(ambiguas, 'Camiseta — sem SKU')?.id).toBe('a');
  });

  it('treats a partial term as a search, not a selection', () => {
    expect(opcaoSelecionada(opcoes, 'Camiseta')).toBeNull();
    expect(opcaoSelecionada(opcoes, 'Camiseta Azul')).toBeNull();
  });

  it('returns null against an empty list', () => {
    expect(opcaoSelecionada([], 'Camiseta Azul — CAM-1')).toBeNull();
  });
});
