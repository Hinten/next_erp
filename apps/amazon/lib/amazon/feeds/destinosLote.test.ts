/**
 * The feed core's provider seam table (step 12a, PR 12-c; FACTORY rows since
 * step 12, PR 12-e1): the stock row holds the stock provider's factory (PR
 * 12-f), the price row the price provider's (step 13, PR 13-f). Each row is the factory of
 * its own fluxo's provider, bound ONCE to the root (`vincularDestinosLoteAmazon`),
 * and a price provider with no stock module fits the price row and only that
 * one. Who may import this module is `estrutura.test.ts`'s.
 */
import { MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { FLUXOS_COM_LOTE, FLUXO_AMAZON } from '../core/valvulas';
import { criarProvedorLoteEstoqueAmazon } from '../estoque/provedorLoteEstoque';
import { criarProvedorLotePrecoAmazon } from '../preco/provedorLotePreco';
import {
  DESTINO_LOTE_AMAZON,
  type DestinoLoteAmazon,
  type FabricaProvedorLoteAmazon,
  type ProvedoresLoteAmazon,
  type RaizLoteAmazon,
  vincularDestinosLoteAmazon,
} from './destinosLote';
import { MOTIVO_ABORTO_LOTE, type ProvedorLoteAmazon } from './provedorLote';
import { enviarFeedAmazon } from './enviarFeed';
import { tarefaEnviarFeedAmazonSchema } from './tarefaLote';
import { FakeDb, asDb } from '../testing/fakeDb';
import { AMBIENTE_DESLIGADO, loggerEspiao } from '../testing/fixtures';

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
  it('★ the stock row is the STOCK provider’s factory (PR 12-f); the price row the PRICE provider’s (PR 13-f)', () => {
    expect(DESTINO_LOTE_AMAZON.estoque).toBe(criarProvedorLoteEstoqueAmazon);
    expect(DESTINO_LOTE_AMAZON.preco).toBe(criarProvedorLotePrecoAmazon);
  });

  it('has exactly one row per batch fluxo — every fluxo with a feed, nothing else', () => {
    expect(Object.keys(DESTINO_LOTE_AMAZON).sort()).toEqual([...FLUXOS_COM_LOTE].sort());
    expectTypeOf<keyof DestinoLoteAmazon>().toEqualTypeOf<(typeof FLUXOS_COM_LOTE)[number]>();
    expectTypeOf<keyof ProvedoresLoteAmazon>().toEqualTypeOf<(typeof FLUXOS_COM_LOTE)[number]>();
  });

  it('★ the seam itself binds the stock row to a STOCK provider whose failure aviso is the feed one, and binding calls NOTHING of the root', () => {
    const r = raizQueRecusa();
    const vinculados = vincularDestinosLoteAmazon(r.raiz, DESTINO_LOTE_AMAZON);
    expect(vinculados.preco?.fluxo).toBe(FLUXO_AMAZON.preco);
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

describe('(13-f) the price row: the price provider’s factory, bound like the stock one', () => {
  it('★ binding refuses the STOCK factory in the price row, and the PRICE factory in the stock row', () => {
    const r = raizQueRecusa();
    expect(() =>
      vincularDestinosLoteAmazon(r.raiz, {
        estoque: criarProvedorLoteEstoqueAmazon,
        preco: criarProvedorLoteEstoqueAmazon as unknown as FabricaProvedorLoteAmazon<'preco'>,
      }),
    ).toThrow(TypeError);
    expect(() =>
      vincularDestinosLoteAmazon(r.raiz, {
        estoque: criarProvedorLotePrecoAmazon as unknown as FabricaProvedorLoteAmazon<'estoque'>,
        preco: criarProvedorLotePrecoAmazon,
      }),
    ).toThrow(TypeError);
    // NEAR-MISS: each factory in its own row binds.
    expect(() =>
      vincularDestinosLoteAmazon(r.raiz, {
        estoque: criarProvedorLoteEstoqueAmazon,
        preco: criarProvedorLotePrecoAmazon,
      }),
    ).not.toThrow();
  });

  it('★ the price provider binds over a root with the price producer and calls nothing of it; a stock-only root (no price producer) binds too', () => {
    const r = raizQueRecusa();
    const produtorPreco = vi.fn((): never => {
      throw new Error('teste: o vínculo não constrói o produtor de preço');
    });
    const vinculados = vincularDestinosLoteAmazon(
      { ...r.raiz, produtorPreco },
      DESTINO_LOTE_AMAZON,
    );
    expect(vinculados.preco?.motivoFalha).toBe(MOTIVO_CONTA_AMAZON.feedPrecoFalhou);
    expect(produtorPreco).not.toHaveBeenCalled();
    expect(r.chamados()).toEqual([]);
    // A root built for the stock flow alone (no price producer) still binds the whole table.
    expect(vincularDestinosLoteAmazon(r.raiz, DESTINO_LOTE_AMAZON).preco?.fluxo).toBe(
      FLUXO_AMAZON.preco,
    );
  });

  it('★ the price provider declares the core’s four OPTIONAL members; the stock provider declares none of them', () => {
    const r = raizQueRecusa();
    const { estoque, preco } = vincularDestinosLoteAmazon(r.raiz, DESTINO_LOTE_AMAZON);
    expect(preco?.relatorio).toEqual({ incluir: ['issues'] });
    expect(typeof preco?.issueDeItemRelevante).toBe('function');
    expect(typeof preco?.valvulaEfetiva).toBe('function');
    expect(typeof preco?.aoFimSemEnvio).toBe('function');
    for (const membro of [
      'relatorio',
      'issueDeItemRelevante',
      'valvulaEfetiva',
      'aoFimSemEnvio',
    ] as const) {
      expect(estoque !== null && membro in estoque, membro).toBe(false);
    }
    expect(r.chamados()).toEqual([]);
  });
});

describe('(13-f) the preview flag at the send: only the price row applies it', () => {
  const AGORA = 1_780_000_000_000;
  /** Both pairs on + `*` and the preview flag set; the read switch unset, so E3 refuses. */
  const AMBIENTE = {
    ...AMBIENTE_DESLIGADO,
    AMAZON_MODO_ESTOQUE: 'on',
    AMAZON_CANARIO_ESTOQUE: '*',
    AMAZON_MODO_PRECO: 'on',
    AMAZON_CANARIO_PRECO: '*',
    AMAZON_PRECO_SO_VALIDACAO: '1',
  };
  const tarefa = (fluxo: 'estoque' | 'preco') =>
    tarefaEnviarFeedAmazonSchema.parse({
      v: 1,
      tipo: 'feed-enviar',
      fluxo,
      contaId: 'conta-amz-seam-previa',
      execucaoId: `exec-seam-previa-${fluxo}`,
      origem: fluxo === 'estoque' ? 'reconciliacao' : 'execucao',
      lote: {
        tipo: 'blocos',
        execucaoIdRun: 'run-seam-previa',
        parteInicial: 0,
        partes: 1,
        esperaAteMs: AGORA + 3_600_000,
      },
    });
  async function rodar(fluxo: 'estoque' | 'preco') {
    const vinculados = vincularDestinosLoteAmazon(raizQueRecusa().raiz, DESTINO_LOTE_AMAZON);
    const fake = new FakeDb();
    const log = loggerEspiao();
    const r = await enviarFeedAmazon(asDb(fake), tarefa(fluxo), {
      ambiente: AMBIENTE,
      agora: () => AGORA,
      logger: log.logger,
      increment: (n: number) => n,
      agendador: () => {
        throw new Error('teste: nada é enfileirado aqui');
      },
      provedor: vinculados[fluxo],
      registro: { tentativa: 0, idTarefa: `tarefa-seam-${fluxo}` },
      fetch: (() => Promise.reject(new Error('teste: nenhuma chamada'))) as typeof fetch,
    });
    return { r, log, fake };
  }

  it('★ a STOCK feed-enviar under the flag + on + * keeps the RAW valve: its valve line reads on, no modoLido (NEAR-MISS: the price row’s batch under the same environment reads dry-run)', async () => {
    const estoque = await rodar('estoque');
    expect(estoque.r).toMatchObject({ acao: 'contexto-recusado', modoLido: null });
    expect(estoque.log.linhas.find((l) => l.meta?.evento === 'valvula')?.meta).toMatchObject({
      fluxo: 'estoque',
      modo: 'on',
    });
    expect(estoque.log.linhas.some((l) => l.meta?.veredito === 'validacao-com-todos')).toBe(false);
    expect(estoque.fake.operacoes).toBe(0);

    const preco = await rodar('preco');
    expect(preco.r).toMatchObject({ acao: 'contexto-recusado', modoLido: 'on' });
    expect(preco.log.linhas.find((l) => l.meta?.evento === 'valvula')?.meta).toMatchObject({
      fluxo: 'preco',
      modo: 'dry-run',
    });
  });
});
