/**
 * The feed core's provider seam table (step 12a, PR 12-c; FACTORY rows since
 * step 12, PR 12-e1): the stock row holds the stock provider's factory (PR
 * 12-f), the price row stays empty until step 13. Each row is the factory of
 * its own fluxo's provider, bound ONCE to the root (`vincularDestinosLoteAmazon`),
 * and a price provider with no stock module fits the price row and only that
 * one. Who may import this module is `estrutura.test.ts`'s.
 */
import { MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { FLUXOS_COM_LOTE, FLUXO_AMAZON } from '../core/valvulas';
import { criarProvedorLoteEstoqueAmazon } from '../estoque/provedorLoteEstoque';
import {
  DESTINO_LOTE_AMAZON,
  type DestinoLoteAmazon,
  type FabricaProvedorLoteAmazon,
  type ProvedoresLoteAmazon,
  type RaizLoteAmazon,
  vincularDestinosLoteAmazon,
} from './destinosLote';
import { MOTIVO_ABORTO_LOTE, type ProvedorLoteAmazon } from './provedorLote';

/** A provider of `fluxo` that does nothing: only its identity is observed. */
function provedor<F extends 'estoque' | 'preco'>(fluxo: F): ProvedorLoteAmazon<F, { n: number }> {
  return {
    fluxo,
    membros: () => Promise.resolve({ skus: ['A'], dados: { n: 1 } }),
    montar: () => Promise.resolve({ abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: null }),
    gravarResultado: () => Promise.resolve(),
    recuperar: () => Promise.resolve({ nada: true }),
    repassarParaPatches: (_ctx, _entrada, skus) => Promise.resolve({ tarefas: skus.length }),
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
}

/** A root whose producers REFUSE to be built: binding must never build one. */
function raizQueRecusa() {
  const agendadorLotes = vi.fn((): never => {
    throw new Error('teste: o vínculo não constrói o produtor de lotes');
  });
  const produtorEstoque = vi.fn((): never => {
    throw new Error('teste: o vínculo não constrói o produtor de estoque');
  });
  const esperar = vi.fn((): never => {
    throw new Error('teste: o vínculo não espera');
  });
  const increment = vi.fn((): never => {
    throw new Error('teste: o vínculo não incrementa');
  });
  const gerarExecucaoId = vi.fn((): never => {
    throw new Error('teste: o vínculo não gera execução');
  });
  const ambiente = vi.fn((): never => {
    throw new Error('teste: o vínculo não lê o ambiente');
  });
  const raiz: RaizLoteAmazon = {
    agendadorLotes,
    produtorEstoque,
    esperar,
    increment,
    gerarExecucaoId,
    ambiente,
  };
  /** Every piece of the root that was CALLED (none may be, at bind time). */
  const chamados = () =>
    Object.entries({
      agendadorLotes,
      produtorEstoque,
      esperar,
      increment,
      gerarExecucaoId,
      ambiente,
    })
      .filter(([, f]) => f.mock.calls.length > 0)
      .map(([nome]) => nome);
  return { raiz, agendadorLotes, produtorEstoque, chamados };
}

describe('DESTINO_LOTE_AMAZON — the seam the jobs root binds', () => {
  it('★ the stock row is the STOCK provider’s factory (PR 12-f); the price row is still null', () => {
    expect(DESTINO_LOTE_AMAZON.estoque).toBe(criarProvedorLoteEstoqueAmazon);
    expect(DESTINO_LOTE_AMAZON.preco).toBeNull();
  });

  it('has exactly one row per batch fluxo — every fluxo with a feed, nothing else', () => {
    expect(Object.keys(DESTINO_LOTE_AMAZON).sort()).toEqual([...FLUXOS_COM_LOTE].sort());
    expectTypeOf<keyof DestinoLoteAmazon>().toEqualTypeOf<(typeof FLUXOS_COM_LOTE)[number]>();
    expectTypeOf<keyof ProvedoresLoteAmazon>().toEqualTypeOf<(typeof FLUXOS_COM_LOTE)[number]>();
  });

  it('★ the seam itself binds the stock row to a STOCK provider whose failure aviso is the feed one, and binding calls NOTHING of the root', () => {
    const r = raizQueRecusa();
    const vinculados = vincularDestinosLoteAmazon(r.raiz, DESTINO_LOTE_AMAZON);
    expect(vinculados.preco).toBeNull();
    expect(vinculados.estoque?.fluxo).toBe(FLUXO_AMAZON.estoque);
    // The real motivo, never the stand-in the core's own tests use.
    expect(vinculados.estoque?.motivoFalha).toBe(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou);
    expect(r.chamados()).toEqual([]);
  });

  it('a price provider with no stock module fits the PRICE row, and never the stock row', () => {
    const precos = provedor(FLUXO_AMAZON.preco);
    const fabrica = () => precos;
    expectTypeOf(fabrica).toMatchTypeOf<NonNullable<DestinoLoteAmazon['preco']>>();
    expectTypeOf(fabrica).not.toMatchTypeOf<NonNullable<DestinoLoteAmazon['estoque']>>();
    expectTypeOf(precos).toMatchTypeOf<NonNullable<ProvedoresLoteAmazon['preco']>>();
    expectTypeOf(precos).not.toMatchTypeOf<NonNullable<ProvedoresLoteAmazon['estoque']>>();
    expect(precos.fluxo).toBe(FLUXO_AMAZON.preco);
  });
});

describe('vincularDestinosLoteAmazon — the rows bound ONCE to the root’s producers', () => {
  it('★ each non-null factory is called EXACTLY once, with THE root (both producers), and its provider is the bound row', () => {
    const r = raizQueRecusa();
    const estoque = provedor(FLUXO_AMAZON.estoque);
    const fabricaEstoque = vi.fn<FabricaProvedorLoteAmazon<'estoque'>>(() => estoque);
    const vinculados = vincularDestinosLoteAmazon(r.raiz, {
      estoque: fabricaEstoque,
      preco: null,
    });

    expect(fabricaEstoque).toHaveBeenCalledExactlyOnceWith(r.raiz);
    const [recebida] = fabricaEstoque.mock.calls[0] ?? [];
    expect(recebida?.agendadorLotes).toBe(r.agendadorLotes);
    expect(recebida?.produtorEstoque).toBe(r.produtorEstoque);
    expect(vinculados.estoque).toBe(estoque);
    // NEAR-MISS: a null row stays null — it never becomes another row's provider.
    expect(vinculados.preco).toBeNull();
    // Reading the bound rows again calls nothing: the factory ran once.
    expect(vinculados.estoque).toBe(estoque);
    expect(fabricaEstoque).toHaveBeenCalledOnce();
    // …and binding built no producer: a provider builds one only when it enqueues.
    expect(r.agendadorLotes).not.toHaveBeenCalled();
    expect(r.produtorEstoque).not.toHaveBeenCalled();
  });

  it('both rows filled: each factory once, each row its own fluxo’s provider', () => {
    const r = raizQueRecusa();
    const estoque = provedor(FLUXO_AMAZON.estoque);
    const preco = provedor(FLUXO_AMAZON.preco);
    const fabricaEstoque = vi.fn(() => estoque);
    const fabricaPreco = vi.fn(() => preco);
    const vinculados = vincularDestinosLoteAmazon(r.raiz, {
      estoque: fabricaEstoque,
      preco: fabricaPreco,
    });
    expect(vinculados).toEqual({ estoque, preco });
    expect([fabricaEstoque.mock.calls.length, fabricaPreco.mock.calls.length]).toEqual([1, 1]);
  });

  it('★ a factory whose provider names ANOTHER fluxo is refused at bind time (TypeError), never at a dispatch', () => {
    const r = raizQueRecusa();
    const trocado = provedor(FLUXO_AMAZON.preco) as unknown as ProvedorLoteAmazon<
      'estoque',
      unknown
    >;
    expect(() =>
      vincularDestinosLoteAmazon(r.raiz, { estoque: () => trocado, preco: null }),
    ).toThrow(TypeError);
  });
});
