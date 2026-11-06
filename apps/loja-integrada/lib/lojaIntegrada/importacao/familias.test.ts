/**
 * The product import's family assembly and `orfaos` phase (`familias.ts`).
 *
 * Two layers: the PURE assembly over synthetic snapshots (every placement rule, each with its
 * near-miss), and the phases end to end — the listing, the trash list and the orphans' detail
 * reads, through the REAL context loader and client, on the fake Firestore — so "no detail read"
 * is counted on the wire, not assumed.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file, and
 * the context's client calls a scripted store (`testing/produtosLi.ts`) whose every request is
 * recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  type DetalheImportacaoLi,
  ESTADO_DETALHE_IMPORTACAO_LI,
  TIPO_PAGINA_IMPORTACAO_LI,
  importacaoLojaIntegradaSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, gravadorDeLog, seedConta, seedCredencial } from '../testing/fixtures';
import {
  type LojaDeProdutosLi,
  contextoDeTesteLi,
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  respostasDaLojaLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import {
  type MontagemLi,
  type SnapshotDoJobLi,
  executarUnidadeDosOrfaosLi,
  filhosSemLinhaLi,
  indexarSnapshotLi,
  lerSnapshotDoJobLi,
  montarFamiliasDoJobLi,
  montarFamiliasLi,
  naoListadosLi,
  orfaosAExplicarLi,
  proximoOrfaoLi,
  unidadeDosOrfaosLi,
} from './familias';
import { executarUnidadeDaListaLi } from './listagem';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';

const CONTA = 'conta-li-familias';
const JOB = 'job-familias';

let db: FakeDb;
let fetchGlobal: ReturnType<typeof vi.fn>;
let gravador: ReturnType<typeof gravadorDeLog>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchGlobal = vi.fn(() => {
    throw new Error('familias.test: só o fetch roteirizado do contexto pode ser chamado');
  });
  vi.stubGlobal('fetch', fetchGlobal);
  db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  gravador = gravadorDeLog();
});
afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

function snapshot(listagem: readonly DocData[], lixeira: readonly DocData[] = []): SnapshotDoJobLi {
  return { listagem: listagem.map(vistaLi), lixeira: lixeira.map(vistaLi) };
}

/** A stored detail, `lido`, as the job writes one. */
function lido(corpo: DocData): DetalheImportacaoLi {
  const detalhe = vistaDetalhadaLi(corpo);
  return {
    liId: detalhe.id,
    estado: ESTADO_DETALHE_IMPORTACAO_LI.lido,
    detalhe,
    lidoEmMs: AGORA_MS,
  };
}

/** A stored 404. */
function inexistente(liId: number): DetalheImportacaoLi {
  return {
    liId,
    estado: ESTADO_DETALHE_IMPORTACAO_LI.inexistente,
    detalhe: null,
    lidoEmMs: AGORA_MS,
  };
}

function montar(
  listagem: readonly DocData[],
  lixeira: readonly DocData[] = [],
  detalhes: readonly DetalheImportacaoLi[] = [],
): MontagemLi {
  return montarFamiliasLi(
    indexarSnapshotLi(snapshot(listagem, lixeira)),
    new Map(detalhes.map((d) => [d.liId, d])),
  );
}

/** A montagem in a compact, comparable form. */
function resumo(m: MontagemLi) {
  return {
    familias: m.familias.map((f) => ({
      raiz: f.raiz.id,
      filhos: f.filhos.map((x) => [x.linha.id, x.origem]),
      semDetalhe: f.semDetalhe,
      pendencias: f.pendencias.map((p) => [p.codigo, p.liId]),
    })),
    avulsos: m.avulsos.map((a) => [a.linha.id, a.codigo]),
  };
}

function familia(m: MontagemLi, raiz: number) {
  return resumo(m).familias.find((f) => f.raiz === raiz);
}

/** No family root is ever a variation: an orphan is never imported as a simple product. */
function semFilhoComoRaiz(m: MontagemLi): void {
  for (const f of m.familias) expect(f.raiz.tipo).not.toBe('atributo_opcao');
}

function cursorDeLista() {
  return importacaoLojaIntegradaSchema.parse({
    integracaoId: CONTA,
    status: 'executando',
    iniciadoEmMs: AGORA_MS,
  }).listagem;
}

/**
 * The phases end to end against a scripted store: the listing, the trash list, then the `orfaos`
 * phase unit by unit; then the job's assembly. `detalhesLidos` are the detail paths the orphans
 * phase requested.
 */
async function rodarAteAMontagem(loja: LojaDeProdutosLi) {
  const { contexto, chamadas } = await contextoDeTesteLi(
    asDb(db),
    CONTA,
    respostasDaLojaLi(loja),
    gravador.escrever,
  );
  const d = { db: asDb(db), cliente: contexto.cliente, jobId: JOB, agoraMs: () => AGORA_MS };
  for (const tipo of [TIPO_PAGINA_IMPORTACAO_LI.listagem, TIPO_PAGINA_IMPORTACAO_LI.lixeira]) {
    let cursor = cursorDeLista();
    for (let i = 0; ; i += 1) {
      if (i > 100) throw new Error('a lista não terminou');
      const passo = await executarUnidadeDaListaLi(d, tipo, cursor);
      cursor = passo.cursor;
      if (passo.tipo === 'fechada') break;
    }
  }
  const orfaos = orfaosAExplicarLi(indexarSnapshotLi(await lerSnapshotDoJobLi(asDb(db), JOB)));
  const antes = chamadas.length;
  let cursor = { cursorLiId: null as number | null };
  for (let i = 0; ; i += 1) {
    if (i > 100) throw new Error('a fase orfaos não terminou');
    const passo = await executarUnidadeDosOrfaosLi(d, orfaos, cursor);
    if (passo.tipo === 'concluido') break;
    cursor = passo.orfaos;
  }
  const detalhesLidos = chamadas.slice(antes).map((c) => c.caminho);
  const { indice, montagem } = await montarFamiliasDoJobLi(asDb(db), JOB);
  return { chamadas, detalhesLidos, indice, montagem, orfaos };
}

/* -------------------------------------------------------------------------- */
/*                              The snapshot index                             */
/* -------------------------------------------------------------------------- */

describe('the snapshot, indexed', () => {
  it('a row repeated across pages is ONE row: the copy read LAST wins', () => {
    const indice = indexarSnapshotLi(
      snapshot([filhoLi(11, { sku: 'antes' }), linhaProdutoLi(12), filhoLi(11, { sku: 'depois' })]),
    );
    expect([...indice.ativos.keys()].sort()).toEqual([11, 12]);
    expect(indice.ativos.get(11)?.sku).toBe('depois');
  });

  it('a product in BOTH lists counts as trashed (the trash is read after the listing)', () => {
    const indice = indexarSnapshotLi(
      snapshot([paiLi(10, [11]), filhoLi(11)], [paiLi(10, [11], { removido: true })]),
    );
    expect(indice.ativos.has(10)).toBe(false);
    expect(indice.lixeira.has(10)).toBe(true);
    expect(indice.reivindicadosNaLixeira.has(11)).toBe(true);
  });

  it('removido is re-checked on every row of both lists', () => {
    const indice = indexarSnapshotLi(
      snapshot(
        [linhaProdutoLi(1), linhaProdutoLi(2, { removido: true })],
        [paiLi(3, [], { removido: true }), paiLi(4, [], { removido: false })],
      ),
    );
    expect([...indice.ativos.keys()]).toEqual([1]);
    expect([...indice.lixeira.keys()]).toEqual([3]);
  });

  it('only a parent claims: a simple product’s or a variation’s own filhos claim nothing', () => {
    const indice = indexarSnapshotLi(
      snapshot([linhaProdutoLi(1, { filhos: ['/api/v1/produto/5'] }), filhoLi(5)]),
    );
    expect(indice.reivindicacoes.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Families from rows                             */
/* -------------------------------------------------------------------------- */

describe('families from the rows', () => {
  it('a parent with the variation rows its filhos claims; a simple product is a family with none', () => {
    const m = montar([paiLi(10, [12, 11]), filhoLi(11), filhoLi(12), linhaProdutoLi(20)]);
    expect(resumo(m)).toEqual({
      familias: [
        {
          raiz: 10,
          filhos: [
            [11, 'filhos'],
            [12, 'filhos'],
          ],
          semDetalhe: [],
          pendencias: [],
        },
        { raiz: 20, filhos: [], semDetalhe: [], pendencias: [] },
      ],
      avulsos: [],
    });
  });

  it('a family split across pages is assembled whole', async () => {
    const { montagem, detalhesLidos } = await rodarAteAMontagem({
      ativos: [paiLi(10, [11, 12, 13]), filhoLi(11), linhaProdutoLi(20), filhoLi(12), filhoLi(13)],
      limiteAplicado: 2,
    });
    expect(familia(montagem, 10)?.filhos).toEqual([
      [11, 'filhos'],
      [12, 'filhos'],
      [13, 'filhos'],
    ]);
    expect(detalhesLidos).toEqual([]);
  });

  it('a variation seen BEFORE its parent is attached all the same', async () => {
    const { montagem } = await rodarAteAMontagem({
      ativos: [filhoLi(11), filhoLi(12), linhaProdutoLi(20), paiLi(10, [11, 12])],
      limiteAplicado: 2,
    });
    expect(familia(montagem, 10)?.filhos).toEqual([
      [11, 'filhos'],
      [12, 'filhos'],
    ]);
  });

  it('never relies on the order: every permutation of the rows assembles the same families', () => {
    const linhas = [paiLi(10, [11, 12]), filhoLi(11), filhoLi(12), linhaProdutoLi(20), filhoLi(30)];
    const esperado = resumo(montar(linhas));
    const permutacoes = [
      [...linhas].reverse(),
      [linhas[2]!, linhas[4]!, linhas[0]!, linhas[3]!, linhas[1]!],
      [linhas[1]!, linhas[3]!, linhas[2]!, linhas[0]!, linhas[4]!],
    ];
    for (const p of permutacoes) expect(resumo(montar(p))).toEqual(esperado);
  });

  it('a parent with filhos: [] and no variation attached is an EMPTY family', () => {
    const m = montar([paiLi(10, [])]);
    expect(familia(m, 10)).toEqual({
      raiz: 10,
      filhos: [],
      semDetalhe: [],
      pendencias: [['familia-vazia', null]],
    });
  });

  it('an unknown tipo is reported loose, never a family — and a parent’s claim of it attaches nothing', () => {
    const m = montar([paiLi(10, [11, 12]), filhoLi(11), linhaProdutoLi(12, { tipo: 'kit' })]);
    expect(resumo(m).avulsos).toEqual([[12, 'tipo-desconhecido']]);
    expect(familia(m, 10)?.filhos).toEqual([[11, 'filhos']]);
    expect(m.familias.map((f) => f.raiz.id)).toEqual([10]);
    expect(m.contagens.reivindicacoesIgnoradas).toBe(1);
  });

  it('a parent claiming another parent or a simple product attaches neither; both stand on their own', () => {
    const m = montar([paiLi(10, [20, 30]), paiLi(20, []), linhaProdutoLi(30)]);
    expect(m.familias.map((f) => f.raiz.id)).toEqual([10, 20, 30]);
    expect(familia(m, 10)?.filhos).toEqual([]);
    expect(m.contagens.reivindicacoesIgnoradas).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The trash and orphans                          */
/* -------------------------------------------------------------------------- */

describe('variations no listed parent claims', () => {
  it('claimed by a TRASHED parent ⇒ na-lixeira with NO detail read (the trash explains it)', async () => {
    const { montagem, detalhesLidos, orfaos } = await rodarAteAMontagem({
      ativos: [filhoLi(51), filhoLi(52), linhaProdutoLi(20)],
      lixeira: [paiLi(50, [51, 52], { removido: true })],
    });
    expect(orfaos).toEqual([]);
    expect(detalhesLidos).toEqual([]);
    expect(resumo(montagem).avulsos).toEqual([
      [51, 'na-lixeira'],
      [52, 'na-lixeira'],
    ]);
    semFilhoComoRaiz(montagem);
  });

  it('⚠️ NEAR-MISS: unexplained by the trash ⇒ ONE detail read, and its pai attaches it to the listed parent (even one that does not claim it)', async () => {
    const { montagem, detalhesLidos, orfaos } = await rodarAteAMontagem({
      ativos: [paiLi(10, [11]), filhoLi(11), filhoLi(12)],
      lixeira: [paiLi(50, [51], { removido: true })],
      detalhes: new Map([[12, detalheLi(filhoLi(12), 10)]]),
    });
    expect(orfaos).toEqual([12]);
    expect(detalhesLidos).toEqual(['/v1/produto/12/']);
    expect(familia(montagem, 10)?.filhos).toEqual([
      [11, 'filhos'],
      [12, 'pai'],
    ]);
    expect(resumo(montagem).avulsos).toEqual([]);
  });

  it('a pai naming a TRASHED parent ⇒ na-lixeira (never linked, never created)', () => {
    const m = montar(
      [filhoLi(12)],
      [paiLi(50, [], { removido: true })],
      [lido(detalheLi(filhoLi(12), 50))],
    );
    expect(resumo(m).avulsos).toEqual([[12, 'na-lixeira']]);
  });

  it('a detail that says removido ⇒ na-lixeira', () => {
    const m = montar(
      [paiLi(10, []), filhoLi(12)],
      [],
      [lido(detalheLi(filhoLi(12, { removido: true }), 10))],
    );
    expect(resumo(m).avulsos).toEqual([[12, 'na-lixeira']]);
    expect(familia(m, 10)?.filhos).toEqual([]);
  });

  it.each([
    ['no pai', detalheLi(filhoLi(12), null)],
    ['an unreadable pai', detalheLi(filhoLi(12), null, { pai: '/api/v1/produto/None' })],
    ['a pai the store does not list', detalheLi(filhoLi(12), 999)],
    ['a pai that is a SIMPLE product', detalheLi(filhoLi(12), 20)],
  ])('%s ⇒ orfao — reported, never imported as a simple product', (_, corpo) => {
    const m = montar([paiLi(10, []), filhoLi(12), linhaProdutoLi(20)], [], [lido(corpo)]);
    expect(resumo(m).avulsos).toEqual([[12, 'orfao']]);
    semFilhoComoRaiz(m);
  });

  it('a 404, or no usable detail at all ⇒ orfao', () => {
    expect(resumo(montar([filhoLi(12)], [], [inexistente(12)])).avulsos).toEqual([[12, 'orfao']]);
    expect(resumo(montar([filhoLi(12)])).avulsos).toEqual([[12, 'orfao']]);
  });

  it('a 404 through the phase is stored and read back as orfao', async () => {
    const { montagem, detalhesLidos } = await rodarAteAMontagem({ ativos: [filhoLi(12)] });
    expect(detalhesLidos).toEqual(['/v1/produto/12/']);
    expect(resumo(montagem).avulsos).toEqual([[12, 'orfao']]);
  });

  it('a variation TWO listed parents claim is placed by its detail’s pai — in ONE family, never both', () => {
    const linhas = [paiLi(10, [11]), paiLi(20, [11]), filhoLi(11)];
    expect(orfaosAExplicarLi(indexarSnapshotLi(snapshot(linhas)))).toEqual([11]);
    const m = montar(linhas, [], [lido(detalheLi(filhoLi(11), 20))]);
    expect(familia(m, 10)?.filhos).toEqual([]);
    expect(familia(m, 20)?.filhos).toEqual([[11, 'pai']]);
    expect(m.contagens.reivindicacoesDisputadas).toBe(1);
    // With no usable detail it is attached to neither.
    const semDetalhe = montar(linhas);
    expect(resumo(semDetalhe).avulsos).toEqual([[11, 'orfao']]);
    expect(familia(semDetalhe, 20)?.filhos).toEqual([]);
  });

  it('a parent whose only variation is attached through its pai is NOT an empty family', () => {
    const m = montar([paiLi(10, []), filhoLi(12)], [], [lido(detalheLi(filhoLi(12), 10))]);
    expect(familia(m, 10)).toEqual({
      raiz: 10,
      filhos: [[12, 'pai']],
      semDetalhe: [],
      pendencias: [],
    });
  });
});

describe('a parent’s claims that are not rows', () => {
  it('are listed for a detail read — not read yet ⇒ semDetalhe, never an empty family', () => {
    const indice = indexarSnapshotLi(snapshot([paiLi(10, [11, 12]), filhoLi(11)]));
    expect(filhosSemLinhaLi(indice)).toEqual([12]);
    // Not an orphan: the orphans phase does not read it.
    expect(orfaosAExplicarLi(indice)).toEqual([]);
    const m = montarFamiliasLi(indice, new Map());
    expect(familia(m, 10)).toMatchObject({ filhos: [[11, 'filhos']], semDetalhe: [12] });
    // A parent whose ONLY variation is still waiting for its detail is not empty either.
    expect(familia(montar([paiLi(20, [21])]), 20)).toEqual({
      raiz: 20,
      filhos: [],
      semDetalhe: [21],
      pendencias: [],
    });
  });

  it('its detail (pai this parent, or none) is the variation', () => {
    const m = montar(
      [paiLi(10, [12, 13])],
      [],
      [lido(detalheLi(filhoLi(12), 10)), lido(detalheLi(filhoLi(13), null))],
    );
    expect(familia(m, 10)).toEqual({
      raiz: 10,
      filhos: [
        [12, 'filhos'],
        [13, 'filhos'],
      ],
      semDetalhe: [],
      pendencias: [],
    });
    expect(m.familias[0]?.filhos[0]?.detalhe?.paiId).toBe(10);
  });

  it.each([
    ['a 404', inexistente(12), 'orfao'],
    ['a pai naming ANOTHER product', lido(detalheLi(filhoLi(12), 99)), 'orfao'],
    ['a detail that is not a variation', lido(detalheLi(linhaProdutoLi(12), 10)), 'orfao'],
    [
      'a detail that says removido',
      lido(detalheLi(filhoLi(12, { removido: true }), 10)),
      'na-lixeira',
    ],
  ])('%s ⇒ a %s pendência on the family, and the family is empty', (_, detalhe, codigo) => {
    const m = montar([paiLi(10, [12])], [], [detalhe]);
    expect(familia(m, 10)).toEqual({
      raiz: 10,
      filhos: [],
      semDetalhe: [],
      pendencias: [
        [codigo, 12],
        ['familia-vazia', null],
      ],
    });
  });

  it('a claimed id in the TRASH list ⇒ a na-lixeira pendência, with no detail needed', () => {
    const indice = indexarSnapshotLi(
      snapshot([paiLi(10, [11, 12]), filhoLi(11)], [filhoLi(12, { removido: true })]),
    );
    expect(filhosSemLinhaLi(indice)).toEqual([]);
    expect(familia(montarFamiliasLi(indice, new Map()), 10)).toMatchObject({
      filhos: [[11, 'filhos']],
      pendencias: [['na-lixeira', 12]],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Selection                                  */
/* -------------------------------------------------------------------------- */

describe('naoListadosLi', () => {
  it('a selected id the store no longer lists as a family ⇒ nao-listado; one it lists ⇒ not', () => {
    const m = montar(
      [paiLi(10, [11]), filhoLi(11), linhaProdutoLi(20), linhaProdutoLi(30, { tipo: 'kit' })],
      [paiLi(40, [], { removido: true })],
    );
    // 10 and 20 are families; 11 is a variation, 30 an unknown tipo, 40 in the trash, 50 absent.
    expect(naoListadosLi(m, [50, 10, 11, 20, 30, 40, 50])).toEqual([11, 30, 40, 50]);
    expect(naoListadosLi(m, [])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The orfaos phase                              */
/* -------------------------------------------------------------------------- */

describe('the orfaos phase', () => {
  it('the next orphan is the first ABOVE the cursor; with none left the unit calls nothing', () => {
    const orfaos = [12, 15, 30];
    expect(proximoOrfaoLi(orfaos, { cursorLiId: null })).toBe(12);
    expect(proximoOrfaoLi(orfaos, { cursorLiId: 12 })).toBe(15);
    expect(proximoOrfaoLi(orfaos, { cursorLiId: 20 })).toBe(30);
    expect(proximoOrfaoLi(orfaos, { cursorLiId: 30 })).toBeNull();
    expect(unidadeDosOrfaosLi(orfaos, { cursorLiId: 15 })).toBe(UNIDADE_IMPORTACAO_LI.chamada);
    expect(unidadeDosOrfaosLi(orfaos, { cursorLiId: 30 })).toBe(UNIDADE_IMPORTACAO_LI.familia);
    expect(unidadeDosOrfaosLi([], { cursorLiId: null })).toBe(UNIDADE_IMPORTACAO_LI.familia);
  });

  it('ONE detail per unit, ascending; the cursor moves to it; the last unit concludes with no call', async () => {
    const { contexto, chamadas } = await contextoDeTesteLi(
      asDb(db),
      CONTA,
      respostasDaLojaLi({
        ativos: [],
        detalhes: new Map([
          [12, detalheLi(filhoLi(12), 10)],
          [15, detalheLi(filhoLi(15), 10)],
        ]),
      }),
      gravador.escrever,
    );
    const d = { db: asDb(db), cliente: contexto.cliente, jobId: JOB, agoraMs: () => AGORA_MS };
    const p1 = await executarUnidadeDosOrfaosLi(d, [12, 15], { cursorLiId: null });
    expect(p1).toMatchObject({ tipo: 'lido', liId: 12, orfaos: { cursorLiId: 12 } });
    expect(chamadas.map((c) => c.caminho)).toEqual(['/v1/produto/12/']);
    const p2 = await executarUnidadeDosOrfaosLi(d, [12, 15], { cursorLiId: 12 });
    expect(p2).toMatchObject({ tipo: 'lido', liId: 15, orfaos: { cursorLiId: 15 } });
    expect(await executarUnidadeDosOrfaosLi(d, [12, 15], { cursorLiId: 15 })).toEqual({
      tipo: 'concluido',
    });
    expect(chamadas).toHaveLength(2);
  });
});

describe('the snapshot, read back', () => {
  it('reads both lists from the job’s pages in ONE key-ordered query', async () => {
    await rodarAteAMontagem({
      ativos: [linhaProdutoLi(1), linhaProdutoLi(2), linhaProdutoLi(3)],
      lixeira: [paiLi(9, [], { removido: true })],
      limiteAplicado: 2,
    });
    const antes = db.consultas.length;
    const deVolta = await lerSnapshotDoJobLi(asDb(db), JOB);
    expect(deVolta.listagem.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(deVolta.lixeira.map((l) => l.id)).toEqual([9]);
    expect(db.consultas.slice(antes)).toHaveLength(1);
  });
});
