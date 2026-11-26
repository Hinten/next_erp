/**
 * The price run document's I/O (step 13, PR 13-e), offline against
 * `testing/fakeDb.ts`: the masked by-id read (the mask on the wire, the
 * defaults of an absent field, a run that does not parse never read as "no
 * run"), the ONE write (a whole run created or replacing the stored one under
 * the read's precondition, a patch under it, a lost precondition re-read under
 * the SAME mask and decided again, at most three attempts, never a blind
 * overwrite) and a page's sums (every counter, the refusals by motivo, the
 * lowest rate limit, the sample cut by the price plan's ranking). The
 * concurrent writer lands through the fake's own write hook, never a timer.
 */
import { describe, expect, it, vi } from 'vitest';
import { ZodError, type z } from 'zod';
import {
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  MAX_AMOSTRA_PRECO_AMAZON,
  contagensExecucaoPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  EXECUCAO_PRECO_INTEIRA,
  ExecucaoPrecoEmConflitoError,
  ExecucaoPrecoInvalidaError,
  MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON,
  escreverExecucaoPrecoAmazon,
  execucaoPrecoAmazonViva,
  lerExecucaoPrecoAmazon,
  mascaraExecucaoPrecoAmazon,
  somarPaginaNaExecucaoPrecoAmazon,
} from './execucaoPrecoFirestore';

const CONTA = 'conta-preco-execucao';
const CAMINHO = `precosAmazon/${CONTA}`;
const AGORA_MS = 1_800_000_000_000;

type EntradaExecucao = z.input<typeof execucaoPrecoAmazonSchema>;

/** A stored run, every default filled. */
function execucao(over: Partial<EntradaExecucao> = {}): ExecucaoPrecoAmazon {
  return execucaoPrecoAmazonSchema.parse({
    execucaoId: 'exec-1',
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: 'uid-operador',
    iniciadaEmMs: AGORA_MS,
    ...over,
  });
}

const FASE = mascaraExecucaoPrecoAmazon(['execucaoId', 'fase']);

function fakeCom(run: ExecucaoPrecoAmazon | null = execucao()): FakeDb {
  const fake = new FakeDb();
  fake.exigirMascaraEm('precosAmazon');
  if (run !== null) fake.seed(CAMINHO, run);
  return fake;
}

/** A field patch decision: `campos` written whenever the run exists. */
const patchar = (campos: Partial<ExecucaoPrecoAmazon>) => (lida: { readonly estado: unknown }) =>
  lida.estado === null
    ? { escrita: null, resposta: 'sem-execucao' }
    : { escrita: { tipo: 'campos' as const, campos }, resposta: 'gravado' };

describe('lerExecucaoPrecoAmazon — by id, masked', () => {
  it('★ a mask reads exactly its fields, ONE getAll, and parses them (a field the run lacks takes its default)', async () => {
    const fake = fakeCom();
    fake.seed(CAMINHO, { execucaoId: 'exec-1', fase: 'decidindo', baixarPreco: true });
    const mascara = mascaraExecucaoPrecoAmazon(['execucaoId', 'fase', 'proximaPagina']);
    const lida = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, mascara);
    expect(lida.estado).toEqual({ execucaoId: 'exec-1', fase: 'decidindo', proximaPagina: 0 });
    expect(lida.updateTime).toBe(fake.carimboDe(CAMINHO));
    expect(fake.leiturasDetalhadas).toEqual([
      {
        caminho: CAMINHO,
        via: 'getAll',
        chamada: 1,
        mascara: ['execucaoId', 'fase', 'proximaPagina'],
      },
    ]);
  });

  it('the whole document is read unmasked, and parses whole', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, execucao({ proximaPagina: 4 }));
    const lida = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, EXECUCAO_PRECO_INTEIRA);
    expect(lida.estado).toEqual(execucao({ proximaPagina: 4 }));
    expect(fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([null]);
  });

  it('no run ⇒ estado null and no precondition (a claim then creates)', async () => {
    const fake = fakeCom(null);
    const lida = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, FASE);
    expect(lida).toMatchObject({ estado: null, updateTime: null });
    expect(lida.readTime).toBeDefined();
  });

  it('★ a stored run that does not parse THROWS, naming the fields and never a value — it never reads as no run', async () => {
    const fake = fakeCom(null);
    fake.seed(CAMINHO, { execucaoId: 'exec/1', fase: 'voando' });
    const erro = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, FASE).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ExecucaoPrecoInvalidaError);
    expect((erro as ExecucaoPrecoInvalidaError).campos).toEqual(['execucaoId', 'fase']);
    expect(String((erro as Error).message)).not.toContain('voando');
  });

  it('NEAR-MISS: a field outside the mask may be anything — it is never read', async () => {
    const fake = fakeCom(null);
    fake.seed(CAMINHO, { execucaoId: 'exec-1', fase: 'paginando', contagens: 'quebrado' });
    const lida = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, FASE);
    expect(lida.estado).toEqual({ execucaoId: 'exec-1', fase: 'paginando' });
  });

  it('a conta outside its grammar is refused before any read', async () => {
    const fake = fakeCom();
    await expect(lerExecucaoPrecoAmazon(asDb(fake), 'a/b', FASE)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(fake.operacoes).toBe(0);
  });

  it('a mask names each field once, and at least one', () => {
    expect(() => mascaraExecucaoPrecoAmazon([])).toThrow(RangeError);
    expect(() => mascaraExecucaoPrecoAmazon(['fase', 'fase'])).toThrow(RangeError);
    expect(mascaraExecucaoPrecoAmazon(['fase', 'execucaoId']).campos).toEqual([
      'fase',
      'execucaoId',
    ]);
  });
});

describe('escreverExecucaoPrecoAmazon — the ONE write (rule 7, tier 1)', () => {
  it('★ no run ⇒ a whole run is CREATED, every default filled', async () => {
    const fake = fakeCom(null);
    const r = await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, () => ({
      escrita: {
        tipo: 'execucao',
        execucao: {
          execucaoId: 'exec-2',
          fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
          baixarPreco: true,
          solicitadaPor: 'uid-operador',
          iniciadaEmMs: AGORA_MS,
        },
      },
      resposta: 'criada',
    }));
    expect(r.resposta).toBe('criada');
    expect(fake.escritas.map((e) => [e.verbo, e.comPrecondicao])).toEqual([['create', false]]);
    expect(fake.ler(CAMINHO)).toEqual(execucao({ execucaoId: 'exec-2', baixarPreco: true }));
    expect(r.writeTime).toBe(fake.carimboDe(CAMINHO));
    expect(r.escrito).toEqual(execucao({ execucaoId: 'exec-2', baixarPreco: true }));
  });

  it('★ a run found ⇒ a whole run REPLACES it under the read’s precondition: its maps and lists whole, nothing of the old run left', async () => {
    const antiga = execucao({
      fase: 'concluida',
      decisao: 'lotes',
      proximaParte: 2,
      itensPorParte: [3, 4],
      amostraReducoes: ['A:10>9'],
      lotes: {
        '0': { execucaoIdLote: 'exec-1-l0', parteInicial: 0, partes: 2, itens: 7 },
      },
      contagens: { enviaveis: 7, porChave: { pai: 2 } },
    });
    const fake = fakeCom(antiga);
    const carimbo = fake.carimboDe(CAMINHO);
    await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, () => ({
      escrita: {
        tipo: 'execucao',
        execucao: {
          execucaoId: 'exec-2',
          fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
          baixarPreco: false,
          solicitadaPor: 'uid-operador',
          iniciadaEmMs: AGORA_MS + 1,
        },
      },
      resposta: null,
    }));
    expect(fake.escritas.map((e) => [e.verbo, e.comPrecondicao])).toEqual([['update', true]]);
    expect(fake.ler(CAMINHO)).toEqual(
      execucao({ execucaoId: 'exec-2', iniciadaEmMs: AGORA_MS + 1 }),
    );
    expect(carimbo).not.toBe(fake.carimboDe(CAMINHO));
  });

  it('★ a patch lands under the read’s precondition, its fields alone', async () => {
    const fake = fakeCom();
    await escreverExecucaoPrecoAmazon(
      asDb(fake),
      CONTA,
      FASE,
      patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }),
    );
    expect(fake.escritas.map((e) => [e.verbo, e.dados, e.comPrecondicao])).toEqual([
      ['update', { fase: 'cancelada' }, true],
    ]);
    expect(fake.ler(CAMINHO)).toEqual(execucao({ fase: 'cancelada' }));
  });

  it('a decision to write nothing writes nothing, and answers', async () => {
    const fake = fakeCom();
    const r = await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, () => ({
      escrita: null,
      resposta: 42,
    }));
    expect(r).toMatchObject({ resposta: 42, writeTime: null, escrito: null });
    expect(fake.escritas).toEqual([]);
  });

  it('a patch decided on NO run is a caller’s bug: TypeError, nothing written', async () => {
    const fake = fakeCom(null);
    await expect(
      escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, () => ({
        escrita: { tipo: 'campos', campos: { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada } },
        resposta: null,
      })),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      escreverExecucaoPrecoAmazon(asDb(fakeCom()), CONTA, FASE, () => ({
        escrita: { tipo: 'campos', campos: {} },
        resposta: null,
      })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fake.escritas).toEqual([]);
  });

  it('a decision the schema refuses writes nothing (ZodError)', async () => {
    const fake = fakeCom();
    await expect(
      escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, () => ({
        escrita: { tipo: 'campos', campos: { proximaParte: 1_001 } },
        resposta: null,
      })),
    ).rejects.toBeInstanceOf(ZodError);
    expect(fake.escritas).toEqual([]);
  });

  it('★ a concurrent write between the read and the write ⇒ the precondition is lost, the run RE-READ under the SAME mask and decided again on what landed', async () => {
    const fake = fakeCom();
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.seed(CAMINHO, execucao({ execucaoId: 'exec-outra' }));
    });
    const vistos: unknown[] = [];
    const r = await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, (lida) => {
      vistos.push(lida.estado);
      if (lida.estado?.execucaoId !== 'exec-1')
        return { escrita: null, resposta: 'nao-e-mais-minha' };
      return {
        escrita: { tipo: 'campos', campos: { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada } },
        resposta: 'cancelada',
      };
    });
    expect(vistos).toEqual([
      { execucaoId: 'exec-1', fase: 'paginando' },
      { execucaoId: 'exec-outra', fase: 'paginando' },
    ]);
    expect(r.resposta).toBe('nao-e-mais-minha');
    expect(fake.escritas).toEqual([]);
    expect(fake.ler(CAMINHO)).toEqual(execucao({ execucaoId: 'exec-outra' }));
    expect(fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([
      ['execucaoId', 'fase'],
      ['execucaoId', 'fase'],
    ]);
  });

  it('NEAR-MISS: re-decided on a run that is still its own ⇒ the patch lands on the NEW precondition', async () => {
    const fake = fakeCom();
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.seed(CAMINHO, execucao({ proximaPagina: 3 }));
    });
    const r = await escreverExecucaoPrecoAmazon(
      asDb(fake),
      CONTA,
      FASE,
      patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }),
    );
    expect(r.resposta).toBe('gravado');
    expect(fake.ler(CAMINHO)).toEqual(execucao({ proximaPagina: 3, fase: 'cancelada' }));
  });

  it('★ a create that meets a concurrent create (ALREADY_EXISTS) re-reads and decides on the run that won', async () => {
    const fake = fakeCom(null);
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.seed(CAMINHO, execucao({ execucaoId: 'exec-vencedora' }));
    });
    const decidir = vi.fn((lida: { readonly estado: { readonly execucaoId: string } | null }) =>
      lida.estado === null
        ? {
            escrita: {
              tipo: 'execucao' as const,
              execucao: {
                execucaoId: 'exec-minha',
                fase: 'paginando' as const,
                baixarPreco: false,
                solicitadaPor: 'uid-operador',
                iniciadaEmMs: AGORA_MS,
              },
            },
            resposta: 'criada',
          }
        : { escrita: null, resposta: lida.estado.execucaoId },
    );
    const r = await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, decidir);
    expect(decidir).toHaveBeenCalledTimes(2);
    expect(r.resposta).toBe('exec-vencedora');
    expect(fake.escritas).toEqual([]);
  });

  it('★ a document gone between the read and the patch (NOT_FOUND or a stale stamp) is re-read: no run ⇒ nothing written', async () => {
    const fake = fakeCom();
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.apagar(CAMINHO);
    });
    const r = await escreverExecucaoPrecoAmazon(
      asDb(fake),
      CONTA,
      FASE,
      patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }),
    );
    expect(r.resposta).toBe('sem-execucao');
    expect(fake.caminhos()).toEqual([]);
  });

  it(`★ every attempt losing ⇒ ExecucaoPrecoEmConflitoError after EXACTLY ${String(MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON)} decisions`, async () => {
    const fake = fakeCom();
    for (let i = 0; i < MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON; i += 1) {
      fake.antesDaProximaEscrita(CAMINHO, () => {
        fake.seed(CAMINHO, execucao({ proximaPagina: i + 1 }));
      });
    }
    const decidir = vi.fn(patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }));
    await expect(
      escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, decidir),
    ).rejects.toBeInstanceOf(ExecucaoPrecoEmConflitoError);
    expect(decidir).toHaveBeenCalledTimes(MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON);
    expect(fake.escritas).toEqual([]);
  });

  it('NEAR-MISS: two losses, then the third attempt lands', async () => {
    const fake = fakeCom();
    for (let i = 0; i < MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON - 1; i += 1) {
      fake.antesDaProximaEscrita(CAMINHO, () => {
        fake.seed(CAMINHO, execucao({ proximaPagina: i + 1 }));
      });
    }
    const decidir = vi.fn(patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }));
    const r = await escreverExecucaoPrecoAmazon(asDb(fake), CONTA, FASE, decidir);
    expect(r.resposta).toBe('gravado');
    expect(decidir).toHaveBeenCalledTimes(MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON);
    expect(fake.ler(CAMINHO)).toMatchObject({ fase: 'cancelada', proximaPagina: 2 });
  });

  it('★ a read handed in (`inicial`) is written on ITS precondition with no read first; a stale one is re-read', async () => {
    const fake = fakeCom();
    const inicial = await lerExecucaoPrecoAmazon(asDb(fake), CONTA, FASE);
    fake.leiturasDetalhadas.length = 0;
    await escreverExecucaoPrecoAmazon(
      asDb(fake),
      CONTA,
      FASE,
      patchar({ proximaPagina: 1 }),
      inicial,
    );
    expect(fake.leiturasDetalhadas).toEqual([]);
    expect(fake.ler(CAMINHO)).toMatchObject({ proximaPagina: 1 });
    // The same read again is stale now: re-read once, then written.
    await escreverExecucaoPrecoAmazon(
      asDb(fake),
      CONTA,
      FASE,
      patchar({ proximaPagina: 2 }),
      inicial,
    );
    expect(fake.leiturasDetalhadas).toHaveLength(1);
    expect(fake.ler(CAMINHO)).toMatchObject({ proximaPagina: 2 });
  });

  it('a Firestore failure other than a lost precondition crosses untouched, nothing re-read', async () => {
    const fake = fakeCom();
    const indisponivel = grpc(14, 'UNAVAILABLE');
    fake.falharEscrita(CAMINHO, indisponivel);
    await expect(
      escreverExecucaoPrecoAmazon(
        asDb(fake),
        CONTA,
        FASE,
        patchar({ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }),
      ),
    ).rejects.toBe(indisponivel);
    expect(fake.leiturasDetalhadas).toHaveLength(1);
  });
});

describe('execucaoPrecoAmazonViva', () => {
  it('a run walking or deciding is live; every end is not', () => {
    expect(
      Object.values(FASE_EXECUCAO_PRECO_AMAZON).filter((f) => execucaoPrecoAmazonViva(f)),
    ).toEqual(['paginando', 'decidindo']);
  });
});

describe('somarPaginaNaExecucaoPrecoAmazon — a page’s sums', () => {
  const contagensDe = (over: Record<string, unknown> = {}) =>
    contagensExecucaoPrecoAmazonSchema.parse(over);

  it('★ every counter of the run is summed; an absent page counter adds 0', () => {
    const contadores = Object.keys(contagensExecucaoPrecoAmazonSchema.shape).filter(
      (c) => c !== 'porChave' && c !== 'limiteTaxa',
    );
    const base = Object.fromEntries(contadores.map((c, i) => [c, i + 1]));
    const pagina = Object.fromEntries(contadores.map((c, i) => [c, 10 * (i + 1)]));
    const r = somarPaginaNaExecucaoPrecoAmazon(
      { contagens: contagensDe(base), amostraReducoes: [] },
      { contagens: pagina, amostra: [] },
    );
    for (const [i, c] of contadores.entries()) {
      expect(r.contagens[c as keyof typeof r.contagens], c).toBe(11 * (i + 1));
    }
    const so = somarPaginaNaExecucaoPrecoAmazon(
      { contagens: contagensDe(base), amostraReducoes: [] },
      { contagens: { enviaveis: 2 }, amostra: [] },
    );
    expect(so.contagens).toEqual(contagensDe({ ...base, enviaveis: (base.enviaveis ?? 0) + 2 }));
  });

  it('★ the refusals by motivo are summed key by key; a new motivo joins', () => {
    const r = somarPaginaNaExecucaoPrecoAmazon(
      { contagens: contagensDe({ porChave: { pai: 2, 'nao-listado': 1 } }), amostraReducoes: [] },
      { contagens: { porChave: { pai: 3, 'asin-divergente': 1 } }, amostra: [] },
    );
    expect(r.contagens.porChave).toEqual({ pai: 5, 'nao-listado': 1, 'asin-divergente': 1 });
  });

  it('★ limiteTaxa is the LOWEST seen; a page that saw none keeps the run’s, and none ever reads 0', () => {
    const somar = (base: number | null, pagina: number | null | undefined) =>
      somarPaginaNaExecucaoPrecoAmazon(
        { contagens: contagensDe({ limiteTaxa: base }), amostraReducoes: [] },
        {
          contagens: pagina === undefined ? {} : { limiteTaxa: pagina },
          amostra: [],
        },
      ).contagens.limiteTaxa;
    expect(somar(5, 2)).toBe(2);
    expect(somar(2, 5)).toBe(2);
    expect(somar(null, 5)).toBe(5);
    expect(somar(5, null)).toBe(5);
    expect(somar(5, undefined)).toBe(5);
    expect(somar(null, null)).toBeNull();
  });

  it('★ the sample keeps the largest decreases of the run and the page, the price plan’s ranking', () => {
    const anteriores = Array.from(
      { length: MAX_AMOSTRA_PRECO_AMAZON },
      (_v, i) => `S${String(i + 1)}:100>${String(100 - (i + 1))}`,
    );
    const r = somarPaginaNaExecucaoPrecoAmazon(
      { contagens: contagensDe(), amostraReducoes: anteriores },
      { contagens: {}, amostra: ['NOVA:100>10', 'SOBE:10>20'] },
    );
    expect(r.amostraReducoes).toHaveLength(MAX_AMOSTRA_PRECO_AMAZON);
    expect(r.amostraReducoes[0]).toBe('NOVA:100>10');
    expect(r.amostraReducoes).not.toContain('S1:100>99');
    expect(r.amostraReducoes).not.toContain('SOBE:10>20');
    expect(r.amostraReducoes).toContain('S20:100>80');
  });

  it('a page count that is not a non-negative safe integer is refused (RangeError)', () => {
    const run = { contagens: contagensDe(), amostraReducoes: [] };
    expect(() =>
      somarPaginaNaExecucaoPrecoAmazon(run, { contagens: { enviaveis: -1 }, amostra: [] }),
    ).toThrow(RangeError);
    expect(() =>
      somarPaginaNaExecucaoPrecoAmazon(run, { contagens: { iguais: 1.5 }, amostra: [] }),
    ).toThrow(RangeError);
    expect(() =>
      somarPaginaNaExecucaoPrecoAmazon(run, { contagens: { porChave: { pai: -2 } }, amostra: [] }),
    ).toThrow(RangeError);
  });

  it('the run it is handed is never mutated', () => {
    const run = { contagens: contagensDe({ porChave: { pai: 1 } }), amostraReducoes: ['A:10>9'] };
    const copia = structuredClone(run);
    somarPaginaNaExecucaoPrecoAmazon(run, {
      contagens: { porChave: { pai: 1 }, iguais: 1 },
      amostra: ['B:10>1'],
    });
    expect(run).toEqual(copia);
  });
});
