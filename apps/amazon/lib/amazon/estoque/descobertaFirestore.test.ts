/**
 * The stock discovery's reads, against the counting fake Firestore: the window
 * query's exact shape (both bounds, `==` per ref form, the key order, the
 * projection), the page budget and truncation, the produto and link-partition
 * reads with their masks and their bounds, the deadline, and what the pure
 * planner makes of the rows. The real server's half (a projected row still
 * carries its commit time; the cursor; the bounds) is
 * `descobertaFirestore.firestore.test.ts`.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON, makeEstoqueUid } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  type JanelaEstoqueAmazon,
  LINHAS_POR_PAGINA_JANELA,
  TETO_PAGINAS_JANELA,
  janelaDaRecuperacao,
  janelaDoTick,
} from './descobertaEstoque';
import {
  CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON,
  CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON,
  CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON,
  type ContextoDescobertaEstoqueAmazon,
  DESFECHO_DESCOBERTA_ESTOQUE_AMAZON,
  type DescobertaEstoqueAmazon,
  ETAPA_DESCOBERTA_ESTOQUE_AMAZON,
  descobrirJanelaEstoqueAmazon,
} from './descobertaFirestore';
import {
  LARGURA_PARTICOES_ESTOQUE_AMAZON,
  MAX_REFS_GETALL_ESTOQUE_AMAZON,
} from './familiaEstoqueFirestore';

const CONTA = 'conta-amz-descoberta';
const OUTRA_CONTA = 'conta-amz-outra';
const DEP = 'dep-descoberta-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
/** A window over these tests' stamps: `(1000, 2000]`, keeping every row by stamp, never forcing. */
const JANELA: JanelaEstoqueAmazon = {
  desdeMs: 1_000,
  ateMs: 2_000,
  manterDesdeMs: 1_000,
  commitAposMs: null,
  forcarPorCommit: false,
};
const AGORA = 5_000;
/** A deadline that never passes in these tests unless a case moves the clock. */
const SEM_PRAZO = { prazoMs: Number.MAX_SAFE_INTEGER };

let fake: FakeDb;

beforeEach(() => {
  fake = new FakeDb();
});

function ctx(agora: () => number = () => AGORA): ContextoDescobertaEstoqueAmazon {
  return { db: asDb(fake), contaId: CONTA, depositoId: DEP, agora };
}

/** An estoque row of `produto` at the depósito (canonical id, canonical form by default). */
function linha(
  produto: string,
  ultimaModificacao: number,
  { ref = CANONICA, doc = makeEstoqueUid(produto, DEP) }: { ref?: string; doc?: string } = {},
): string {
  const caminho = `produtos/${produto}/estoques/${doc}`;
  fake.seed(caminho, { depositoOuterRef: ref, ultimaModificacao, quantidade: 1 });
  return caminho;
}

function produto(id: string, dados: Record<string, unknown> = {}): void {
  fake.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

/** A link doc on `dono` for `sku`, of the conta (canonical ref) unless told otherwise. */
function vinculo(dono: string, id: string, sku: string, conta = REF_CONTA): void {
  fake.seed(`produtos/${dono}/prodAmazon/${id}`, {
    contaAmazonOuterRef: conta,
    sku,
    productDataJson: '{"pesado":true}',
  });
}

function completa(r: DescobertaEstoqueAmazon) {
  if (r.tipo !== DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.completa) {
    throw new Error(`esperado completa, veio ${r.tipo}`);
  }
  return r;
}

const skusDe = (r: DescobertaEstoqueAmazon) => completa(r).observacoes.map((o) => o.sku);
const consultasDaJanela = () => fake.consultas.filter((q) => q.colecao === 'estoques');
const listagens = () => fake.consultas.filter((q) => q.colecao.endsWith('/prodAmazon'));

describe('★ the window query, spied: both bounds, `==` per ref form, never `in`', () => {
  it('one query per stored form, canonical first: depósito ==, stamp > desde and <= ate, ordered by the stamp then the key, the stamp alone, 300 a page', async () => {
    await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    const [campoDeposito, campoCarimbo] = CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON;
    expect(consultasDaJanela()).toEqual(
      [CANONICA, NUA].map((forma) => ({
        colecao: 'estoques',
        grupo: true,
        filtros: [
          [campoDeposito, forma],
          [`${campoCarimbo} >`, JANELA.desdeMs],
          [`${campoCarimbo} <=`, JANELA.ateMs],
        ],
        ordens: [
          [campoCarimbo, 'asc'],
          [CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON, 'asc'],
        ],
        limite: LINHAS_POR_PAGINA_JANELA,
        apos: null,
        selecao: [campoCarimbo],
      })),
    );
    // NEAR-MISS guards, by the log's labels: no disjunction, no open range.
    const rotulos = consultasDaJanela().flatMap((q) => q.filtros.map(([r]) => r));
    expect(rotulos.filter((r) => r.endsWith(' in'))).toEqual([]);
    expect(rotulos.filter((r) => r === 'ultimaModificacao <=')).toHaveLength(2);
  });

  it('the key order is the document key, the index’s trailing field', () => {
    expect(CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON).toBe('__name__');
  });
});

describe('★ the cost of a window', () => {
  it('idle: EXACTLY two empty window queries — no produto read, no link listing, nothing else', async () => {
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    linha('P', 999); // just below the window: the tick’s overlap already read it
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(skusDe(r)).toEqual([]);
    expect(fake.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 2, escritas: 0 });
    expect(r.contagem).toEqual({
      paginas: 2,
      linhas: 0,
      mantidas: 0,
      foraDeProduto: 0,
      produtos: 0,
      sondas: 0,
    });
  });

  it('active: the window, ONE masked getAll of the moved produtos, one projected listing per distinct probe', async () => {
    fake.exigirMascaraEm('produtos');
    fake.exigirMascaraEm('prodAmazon');
    fake.exigirMascaraEm('estoques');
    produto('A');
    produto('B');
    linha('A', 1_500);
    linha('B', 1_600);
    vinculo('A', 'la', 'SKU-A');
    vinculo('B', 'lb', 'SKU-B');
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(skusDe(r)).toEqual(['SKU-A', 'SKU-B']);
    expect(fake.contagem).toEqual({ leituras: 2, chamadasGetAll: 1, consultas: 4, escritas: 0 });
    expect(fake.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      ['produtos/A', [...CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON]],
      ['produtos/B', [...CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON]],
    ]);
    expect(CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON).toEqual(['paiId']);
    expect(listagens().map((q) => [q.colecao, q.filtros, q.ordens, q.limite, q.selecao])).toEqual([
      ['produtos/A/prodAmazon', [], [], null, [...CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON]],
      ['produtos/B/prodAmazon', [], [], null, [...CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON]],
    ]);
    expect(r.contagem).toEqual({
      paginas: 2,
      linhas: 2,
      mantidas: 2,
      foraDeProduto: 0,
      produtos: 2,
      sondas: 2,
    });
  });

  it('★ the produtos are read in getAll slices of at most 300, and every probe partition once', async () => {
    const n = MAX_REFS_GETALL_ESTOQUE_AMAZON + 1;
    for (let i = 0; i < n; i += 1) linha(`p${String(i).padStart(4, '0')}`, 1_500);
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(completa(r).contagem).toMatchObject({ produtos: n, sondas: n });
    const chamadas = new Map<number, number>();
    for (const l of fake.leiturasDetalhadas) {
      chamadas.set(l.chamada ?? 0, (chamadas.get(l.chamada ?? 0) ?? 0) + 1);
    }
    expect([...chamadas.values()]).toEqual([MAX_REFS_GETALL_ESTOQUE_AMAZON, 1]);
    expect(new Set(listagens().map((q) => q.colecao)).size).toBe(n);
    expect(listagens()).toHaveLength(n);
  });
});

describe('from rows to the conta’s SKUs', () => {
  it('★ both stored ref forms of the depósito are read: a row in the bare form maps too; another depósito’s row never does', async () => {
    produto('A');
    produto('B');
    produto('C');
    linha('A', 1_500);
    linha('B', 1_500, { ref: NUA, doc: 'auto-legado' });
    linha('C', 1_500, { ref: 'documents/depositos/dep-outro' });
    vinculo('A', 'la', 'SKU-A');
    vinculo('B', 'lb', 'SKU-B');
    vinculo('C', 'lc', 'SKU-C');
    expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO))).toEqual([
      'SKU-A',
      'SKU-B',
    ]);
  });

  it('★ only the conta’s links, in both stored conta forms; another conta’s link on the same produto is not a SKU of it', async () => {
    produto('A');
    linha('A', 1_500);
    vinculo('A', 'l1', 'SKU-CANONICA');
    vinculo('A', 'l2', 'SKU-NUA', `integracao/${CONTA}`);
    vinculo('A', 'l3', 'SKU-OUTRA', `documents/integracao/${OUTRA_CONTA}`);
    expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO))).toEqual([
      'SKU-CANONICA',
      'SKU-NUA',
    ]);
  });

  it('★ a family-of-one wrapper’s link is found from its MEMBER’s estoque move (the probe set holds the parent); NEAR-MISS: a member without the pointer finds nothing', async () => {
    produto('W');
    produto('M', { paiId: 'W' });
    linha('M', 1_500);
    vinculo('W', 'lw', 'SKU-W');
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(skusDe(r)).toEqual(['SKU-W']);
    expect(listagens().map((q) => q.colecao)).toEqual([
      'produtos/M/prodAmazon',
      'produtos/W/prodAmazon',
    ]);
    // NEAR-MISS: the same move with no parent pointer probes the member alone.
    fake = new FakeDb();
    produto('W');
    produto('M');
    linha('M', 1_500);
    vinculo('W', 'lw', 'SKU-W');
    expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO))).toEqual([]);
  });

  it('★ the probes are DEDUPLICATED: two moved members of one parent list the parent’s partition once', async () => {
    produto('W');
    produto('M1', { paiId: 'W' });
    produto('M2', { paiId: 'W' });
    linha('M1', 1_500);
    linha('M2', 1_600);
    vinculo('W', 'lw', 'SKU-W');
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(skusDe(r)).toEqual(['SKU-W']);
    expect(listagens().map((q) => q.colecao)).toEqual([
      'produtos/M1/prodAmazon',
      'produtos/W/prodAmazon',
      'produtos/M2/prodAmazon',
    ]);
    // The SKU's observation is the NEWER of its two members' commits.
    expect(completa(r).observacoes[0]?.updateTime).toEqual(
      fake.carimboDe(`produtos/M2/estoques/${makeEstoqueUid('M2', DEP)}`),
    );
  });

  it('★ a kit sale (its own estoque stamp moves) maps to the kit’s SKU; a component sale does NOT (the accepted residue)', async () => {
    produto('K', { ehKit: true, componentesKit: { C: { quantidade: 2 } } });
    produto('C');
    vinculo('K', 'lk', 'SKU-KIT');
    linha('K', 1_500);
    expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO))).toEqual([
      'SKU-KIT',
    ]);
    fake = new FakeDb();
    produto('K', { ehKit: true, componentesKit: { C: { quantidade: 2 } } });
    produto('C');
    vinculo('K', 'lk', 'SKU-KIT');
    linha('C', 1_500);
    expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO))).toEqual([]);
  });

  it('a moved produto whose document is gone probes itself alone; a row outside a produto’s estoques is counted, never mapped', async () => {
    linha('SUMIDO', 1_500);
    vinculo('SUMIDO', 'ls', 'SKU-S');
    fake.seed('outros/x/estoques/y', { depositoOuterRef: CANONICA, ultimaModificacao: 1_500 });
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(skusDe(r)).toEqual(['SKU-S']);
    expect(r.contagem).toMatchObject({ linhas: 2, mantidas: 2, foraDeProduto: 1, produtos: 1 });
  });
});

describe('★ observations: the commit, never the stamp', () => {
  it('each SKU’s observation is its row’s commit updateTime as the query snapshot carried it', async () => {
    produto('A');
    const caminho = linha('A', 1_500);
    vinculo('A', 'la', 'SKU-A');
    const [obs] = completa(
      await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO),
    ).observacoes;
    expect(obs?.updateTime).toEqual(fake.carimboDe(caminho));
    expect(obs?.forcar).toBe(false);
  });

  it('★ the same row read by two overlapping windows gives ONE identical observation; written again it gives a NEW one', async () => {
    produto('A');
    const caminho = linha('A', 1_500);
    vinculo('A', 'la', 'SKU-A');
    const primeira = completa(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO));
    const sobreposta = completa(
      await descobrirJanelaEstoqueAmazon(
        ctx(),
        { ...JANELA, desdeMs: 1_400, manterDesdeMs: 1_400, ateMs: 2_500 },
        SEM_PRAZO,
      ),
    );
    expect(sobreposta.observacoes).toEqual(primeira.observacoes);
    // ★ Inverted clocks: a later write whose clock lost the max leaves the stamp
    // EQUAL, and its commit still moves: a new observation (NEAR-MISS: by the
    // stamp the two would be one).
    fake.seed(caminho, { depositoOuterRef: CANONICA, ultimaModificacao: 1_500, quantidade: 7 });
    const depois = completa(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO));
    expect(depois.observacoes.map((o) => o.sku)).toEqual(['SKU-A']);
    expect(depois.observacoes[0]?.updateTime).not.toEqual(primeira.observacoes[0]?.updateTime);
    expect(depois.observacoes[0]?.updateTime).toEqual(fake.carimboDe(caminho));
  });

  it('★ the window’s KEEP rule is applied per row: a recovery keeps and FORCES only rows committed after its margin, and a row it drops costs no produto read', async () => {
    produto('A');
    produto('B');
    const caminhoA = linha('A', 1_500);
    vinculo('A', 'la', 'SKU-A');
    vinculo('B', 'lb', 'SKU-B');
    const corte = fake.carimboDe(caminhoA)?.toMillis() ?? 0;
    // B committed in a LATER millisecond than A (the fake's clock moves by µs).
    for (let i = 0; i < 1_000; i += 1) fake.seed('relogio/x', { i });
    linha('B', 1_500);
    const recuperacao: JanelaEstoqueAmazon = {
      desdeMs: 1_000,
      ateMs: 2_000,
      manterDesdeMs: null,
      commitAposMs: corte,
      forcarPorCommit: true,
    };
    const r = completa(await descobrirJanelaEstoqueAmazon(ctx(), recuperacao, SEM_PRAZO));
    expect(r.observacoes.map((o) => [o.sku, o.forcar])).toEqual([['SKU-B', true]]);
    expect(r.contagem).toMatchObject({ linhas: 2, mantidas: 1, produtos: 1, sondas: 1 });
    expect(fake.leituras).toEqual(['produtos/B']);
  });

  it('the real planners’ windows ride through unchanged: a tick window and a recovery window', async () => {
    produto('A');
    linha('A', 1_500);
    vinculo('A', 'la', 'SKU-A');
    const tick = janelaDoTick({ cursorMs: 1_200, agoraMs: 2_000 });
    const rec = janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: 1_100, agoraMs: 2_000 });
    if (tick === null || rec === null) throw new Error('fixture: janelas esperadas');
    for (const j of [tick, rec]) {
      fake.consultas.length = 0;
      expect(skusDe(await descobrirJanelaEstoqueAmazon(ctx(), j, SEM_PRAZO))).toEqual(['SKU-A']);
      expect(consultasDaJanela()[0]?.filtros.slice(1)).toEqual([
        ['ultimaModificacao >', j.desdeMs],
        ['ultimaModificacao <=', j.ateMs],
      ]);
    }
  });
});

describe('★ the page budget and truncation', () => {
  /** `n` rows of distinct produtos at the canonical form, all inside the window. */
  function linhas(n: number, carimbo = 1_500): void {
    for (let i = 0; i < n; i += 1) linha(`p${String(i).padStart(5, '0')}`, carimbo);
  }

  it('★ 3,001 rows ⇒ TRUNCATED after ten pages: ZERO produto reads and ZERO partition listings', async () => {
    linhas(3_001);
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(r.tipo).toBe(DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada);
    expect(consultasDaJanela()).toHaveLength(TETO_PAGINAS_JANELA);
    expect(listagens()).toEqual([]);
    expect(fake.contagem).toMatchObject({ leituras: 0, chamadasGetAll: 0 });
    expect(r.contagem).toMatchObject({ paginas: TETO_PAGINAS_JANELA, produtos: 0, sondas: 0 });
  });

  // The whole mapping runs here (2,699 produtos, as many partition listings in
  // the fake): about a second alone, past the default 5 s under a parallel run.
  it(
    'NEAR-MISS: a window that ends inside the budget is complete — nine short of a page at one form, the other form answering empty',
    { timeout: 30_000 },
    async () => {
      linhas(9 * LINHAS_POR_PAGINA_JANELA - 1);
      const r = completa(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO));
      expect(consultasDaJanela()).toHaveLength(TETO_PAGINAS_JANELA);
      expect(r.contagem).toMatchObject({ paginas: 10, linhas: 2_699, produtos: 2_699 });
    },
  );

  it('a full tenth page, or a form never read, is TRUNCATED: no eleventh page is read to tell', async () => {
    linhas(9 * LINHAS_POR_PAGINA_JANELA);
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO);
    expect(r.tipo).toBe(DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada);
    // Nine pages of the canonical form, the ninth full, then the tenth page to
    // confirm it is done: the bare form is left unread.
    expect(consultasDaJanela().map((q) => q.filtros[0]?.[1])).toEqual(
      Array.from({ length: 10 }, () => CANONICA),
    );
  });

  it('★ the cursor resumes EXACTLY after the last row: 301 rows of one stamp are read once each, across the page boundary', async () => {
    linhas(LINHAS_POR_PAGINA_JANELA + 1);
    const r = completa(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO));
    expect(r.contagem).toMatchObject({ paginas: 3, linhas: 301, produtos: 301 });
    expect(consultasDaJanela().map((q) => q.apos)).toEqual([
      null,
      `produtos/p00299/estoques/${makeEstoqueUid('p00299', DEP)}`,
      null,
    ]);
  });

  it('a tick window the 24-hour clamp already cut answers truncated with ZERO reads', async () => {
    linhas(1);
    const r = await descobrirJanelaEstoqueAmazon(ctx(), { ...JANELA, truncada: true }, SEM_PRAZO);
    expect(r.tipo).toBe(DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada);
    expect(fake.operacoes).toBe(0);
    // NEAR-MISS: an uncut tick window reads.
    await descobrirJanelaEstoqueAmazon(ctx(), { ...JANELA, truncada: false }, SEM_PRAZO);
    expect(fake.operacoes).toBeGreaterThan(0);
  });
});

describe('★ the deadline: checked before every page, every produto getAll and every batch of listings', () => {
  it('passed before the first page ⇒ prazo at the window, ZERO operations', async () => {
    linha('A', 1_500);
    const r = await descobrirJanelaEstoqueAmazon(ctx(), JANELA, { prazoMs: AGORA });
    expect(r).toMatchObject({ tipo: 'prazo', etapa: ETAPA_DESCOBERTA_ESTOQUE_AMAZON.janela });
    expect(fake.operacoes).toBe(0);
    // NEAR-MISS: one ms later and it reads.
    await descobrirJanelaEstoqueAmazon(ctx(), JANELA, { prazoMs: AGORA + 1 });
    expect(fake.operacoes).toBeGreaterThan(0);
  });

  it('passing between two pages stops before the second', async () => {
    produto('A');
    linha('A', 1_500);
    // The clock reaches the deadline once the first query ran.
    const r = await descobrirJanelaEstoqueAmazon(
      ctx(() => AGORA + fake.consultas.length),
      JANELA,
      { prazoMs: AGORA + 1 },
    );
    expect(r).toMatchObject({ tipo: 'prazo', etapa: 'janela', contagem: { paginas: 1 } });
    expect(consultasDaJanela()).toHaveLength(1);
  });

  it('passing after the window stops before the produto read', async () => {
    produto('A');
    linha('A', 1_500);
    const r = await descobrirJanelaEstoqueAmazon(
      ctx(() => AGORA + fake.consultas.length),
      JANELA,
      { prazoMs: AGORA + 2 },
    );
    expect(r).toMatchObject({ tipo: 'prazo', etapa: ETAPA_DESCOBERTA_ESTOQUE_AMAZON.produtos });
    expect(fake.contagem).toMatchObject({ consultas: 2, leituras: 0 });
  });

  it('★ the listings go in batches of at most 16: a deadline passing after the first batch leaves EXACTLY 16 listed of 17', async () => {
    const n = LARGURA_PARTICOES_ESTOQUE_AMAZON + 1;
    for (let i = 0; i < n; i += 1) linha(`p${String(i).padStart(2, '0')}`, 1_500);
    const r = await descobrirJanelaEstoqueAmazon(
      ctx(() => AGORA + listagens().length),
      JANELA,
      { prazoMs: AGORA + 1 },
    );
    expect(r).toMatchObject({
      tipo: 'prazo',
      etapa: ETAPA_DESCOBERTA_ESTOQUE_AMAZON.vinculos,
      contagem: { sondas: LARGURA_PARTICOES_ESTOQUE_AMAZON },
    });
    expect(listagens()).toHaveLength(LARGURA_PARTICOES_ESTOQUE_AMAZON);
    // NEAR-MISS: with no deadline every probe is listed.
    fake.consultas.length = 0;
    const tudo = completa(await descobrirJanelaEstoqueAmazon(ctx(), JANELA, SEM_PRAZO));
    expect(tudo.contagem.sondas).toBe(n);
  });
});

describe('what it refuses before any read', () => {
  it.each<[string, Partial<ContextoDescobertaEstoqueAmazon>, Partial<JanelaEstoqueAmazon>]>([
    ['a conta id outside the grammar', { contaId: 'conta/x' }, {}],
    ['a depósito id that is no document id', { depositoId: 'a/b' }, {}],
    ['a µs-shaped or fractional bound', {}, { desdeMs: 1.5 }],
    ['a negative bound', {}, { ateMs: -1 }],
  ])('%s ⇒ RangeError, nothing read', async (_c, contexto, janela) => {
    await expect(
      descobrirJanelaEstoqueAmazon({ ...ctx(), ...contexto }, { ...JANELA, ...janela }, SEM_PRAZO),
    ).rejects.toThrow(RangeError);
    expect(fake.operacoes).toBe(0);
  });
});
