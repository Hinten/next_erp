/**
 * The price TRIGGER's work (master plan step 13, PR 13-e), gate by gate, pinned by COUNTING: the
 * reads the fake Firestore served (`leituras`, `consultas`, every `getAll`), the enqueues the
 * producer received (payloads and names), every log line (the injected logger and the app
 * logger's stdout) and the writes (none, ever — checked after every test). An emulator cannot
 * prove that a function did nothing, so the absences are pinned here.
 *
 * No call to Loja Integrada is reachable — the global `fetch` throws in every test, and the trigger
 * builds no client. The producer is either a recording double or the REAL pure producer
 * (`criarAgendadorPrecoLi`) over a fake transport whose failures are the SDK's own classes. Every
 * id and price is invented.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
} from '@delfrance/schemas';

import { type AmbienteLi, VALVULA_ENV_LI } from '../core/valvulas';
import { CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI } from '../estoque/envioManualEstoqueLi';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, espiarStdout } from '../testing/fixtures';
import {
  type AgendadorPrecoLi,
  type FilaPrecoLi,
  LiTarefasTransitoriasError,
  type OpcoesEnfileiramentoPrecoLi,
  criarAgendadorPrecoLi,
  idDaTarefaPrecoLi,
  janelaPrecoLi,
} from './agendadorPreco';
import {
  CAMPOS_FILHO_GATILHO_PRECO_LI,
  CAMPOS_PAI_GATILHO_PRECO_LI,
  CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI,
  type DepsGatilhoPrecoLi,
  type EventoPrecoLi,
  MAX_FILHOS_GATILHO_PRECO_LI,
  __reiniciarGatilhoPrecoParaTestes,
  tratarEventoPrecoLi,
} from './gatilhoPreco';
import { __setRelogioDoMapaTabelasParaTestes } from './mapaTabelasLi';

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

const T0 = AGORA_MS;
const JANELA = janelaPrecoLi(T0);

/** C1 prices at TN1 (+ promo TP1), C2 at TN2; C3 is inactive (TN1); C4 names no normal tabela. */
const C1 = 'conta-li-c1';
const C2 = 'conta-li-c2';
const C3 = 'conta-li-c3';
const C4 = 'conta-li-c4';
const TN1 = 'tab-li-n1';
const TP1 = 'tab-li-p1';
const TN2 = 'tab-li-n2';
const TABELAS = [TN1, TP1, TN2];

const P = 'prod-li-filho';
const PAI = 'prod-li-pai';
const R = 'prod-li-raiz';

function seedConta(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`integracao/${id}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${id}`,
    ativo: true,
    ...over,
  });
}

/** The four contas of every case. C1's normal ref is CANONICAL, its promo BARE. */
function seedContas(db: FakeDb): void {
  seedConta(db, C1, {
    tabelaNormalOuterRef: `documents/listaDePrecos/${TN1}`,
    tabelaPromocionalOuterRef: `listaDePrecos/${TP1}`,
  });
  seedConta(db, C2, { tabelaNormalOuterRef: `listaDePrecos/${TN2}` });
  seedConta(db, C3, { ativo: false, tabelaNormalOuterRef: `listaDePrecos/${TN1}` });
  seedConta(db, C4, { tabelaPromocionalOuterRef: `listaDePrecos/${TP1}` });
}

/** A parent produto as stored: fields the trigger must never need sit beside the two it reads. */
function seedPai(db: FakeDb, over: DocData = {}, id = PAI): void {
  db.seed(`produtos/${id}`, {
    nome: 'Pai inventado',
    custo: 9.99,
    precos: { [TN1]: { valor: 33.33 } },
    propagatePriceToChildren: true,
    integracoesComProduto: [C1],
    ...over,
  });
}

/** A child of `raiz` as stored, whose anchor lists `contas`. */
function seedFilhoDe(db: FakeDb, raiz: string, id: string, contas: readonly string[]): void {
  db.seed(`produtos/${id}`, {
    nome: `Filho ${id}`,
    paiId: raiz,
    precos: { [TN1]: { valor: 22.22 } },
    integracoesComProduto: [...contas],
  });
}

const entradas = (valores: Readonly<Record<string, number | string>>): DocData =>
  Object.fromEntries(Object.entries(valores).map(([t, v]) => [t, { valor: v }]));

/** A child produto's payload: its parent, its own map, its anchor. */
function filho(
  valores: Readonly<Record<string, number | string>>,
  over: DocData = {},
  contas: readonly string[] = [C1],
): DocData {
  return {
    nome: 'Filho inventado',
    custo: 7.77,
    paiId: PAI,
    precos: entradas(valores),
    integracoesComProduto: [...contas],
    ...over,
  };
}

/** A root produto's payload (flag on unless overridden). */
function raiz(
  valores: Readonly<Record<string, number | string>>,
  over: DocData = {},
  contas: readonly string[] = [C1],
): DocData {
  return {
    nome: 'Raiz inventada',
    custo: 8.88,
    precos: entradas(valores),
    propagatePriceToChildren: true,
    integracoesComProduto: [...contas],
    ...over,
  };
}

function evento(antes: DocData | null, depois: DocData | null, produtoId = P): EventoPrecoLi {
  return { produtoId, antes, depois };
}

function tarefa(contaId: string, produtoId: string, baixar: boolean): TarefaPrecoLi {
  return {
    tipo: TIPO_TAREFA_PRECO_LI,
    contaId,
    produtoId,
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    janela: JANELA,
    geracao: 0,
    baixar,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Harness                                    */
/* -------------------------------------------------------------------------- */

interface Enfileirado {
  readonly tarefa: TarefaPrecoLi;
  readonly opcoes: OpcoesEnfileiramentoPrecoLi;
}

type Linha = readonly ['INFO' | 'WARNING' | 'ERROR', string, Record<string, unknown> | undefined];

interface Harness {
  readonly db: FakeDb;
  readonly deps: DepsGatilhoPrecoLi;
  readonly enfileirados: Enfileirado[];
  readonly linhas: Linha[];
  readonly getAll: ReturnType<typeof vi.spyOn>;
  dbs: number;
  agendadores: number;
  relogios: number;
}

const fakes: FakeDb[] = [];
let stdout: ReturnType<typeof espiarStdout>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoMapaTabelasParaTestes(() => T0);
  __reiniciarGatilhoPrecoParaTestes();
  stdout = espiarStdout();
  // No call to the store, per file: nothing here may reach the global `fetch`.
  vi.stubGlobal('fetch', () => {
    throw new Error('gatilhoPreco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  // The trigger writes NOTHING, in every case.
  for (const f of fakes.splice(0)) expect(f.escritas).toEqual([]);
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoMapaTabelasParaTestes();
  __reiniciarGatilhoPrecoParaTestes();
  vi.unstubAllGlobals();
});

function montar(
  o: {
    readonly ambiente?: AmbienteLi;
    readonly agendador?: AgendadorPrecoLi;
    readonly agora?: () => number;
    readonly contas?: boolean;
  } = {},
): Harness {
  const db = new FakeDb();
  fakes.push(db);
  if (o.contas !== false) seedContas(db);
  const enfileirados: Enfileirado[] = [];
  const linhas: Linha[] = [];
  const gravador: AgendadorPrecoLi = {
    async enfileirar(t, opcoes) {
      enfileirados.push({ tarefa: t, opcoes });
    },
  };
  const h: Harness = {
    db,
    enfileirados,
    linhas,
    getAll: vi.spyOn(db, 'getAll'),
    dbs: 0,
    agendadores: 0,
    relogios: 0,
    deps: {
      ambiente: { [VALVULA_ENV_LI.preco]: 'dry-run', ...o.ambiente },
      db: () => {
        h.dbs += 1;
        return asDb(db);
      },
      agendador: () => {
        h.agendadores += 1;
        return o.agendador ?? gravador;
      },
      agoraMs: () => {
        h.relogios += 1;
        return (o.agora ?? (() => T0))();
      },
      logger: {
        info: (m, meta) => linhas.push(['INFO', m, meta]),
        warn: (m, meta) => linhas.push(['WARNING', m, meta]),
        error: (m, meta) => linhas.push(['ERROR', m, meta]),
      },
    },
  };
  return h;
}

/**
 * The deps with a db FACTORY that throws when called (a zero-read gate never even builds the
 * handle) and a producer that must never be built.
 */
function semDb(h: Harness): DepsGatilhoPrecoLi {
  return {
    ...h.deps,
    db: () => {
      throw new Error('teste: um portão de custo zero construiu o Firestore');
    },
    agendador: () => {
      throw new Error('teste: nada a enfileirar');
    },
  };
}

const linhasDe = (h: Harness, sev: Linha[0]) => h.linhas.filter((l) => l[0] === sev);
const consultasEm = (h: Harness, colecao: string) =>
  h.db.consultas.filter((c) => c.colecao === colecao);
const tarefasDe = (h: Harness) => h.enfileirados.map((e) => e.tarefa);

/** What one event cost: map queries, parent reads, family queries, tasks, the `baixar` values. */
function custos(h: Harness) {
  return {
    mapa: consultasEm(h, 'integracao').length,
    pai: h.getAll.mock.calls.length,
    familia: consultasEm(h, 'produtos').length,
    tarefas: h.enfileirados.length,
    baixar: [...new Set(h.enfileirados.map((e) => e.tarefa.baixar))].sort(),
  };
}

/* -------------------------------------------------------------------------- */
/*                       The relevance gate: zero reads                         */
/* -------------------------------------------------------------------------- */

describe('the relevance gate — an irrelevant write costs ZERO reads and logs NOTHING', () => {
  it.each([
    ['a name edit', filho({ [TN1]: 11.11 }), filho({ [TN1]: 11.11 }, { nome: 'Outro nome' })],
    ['a create', null, filho({ [TN1]: 11.11 })],
    ['a delete', filho({ [TN1]: 11.11 }), null],
    ['10 → 10.004 (float residue)', filho({ [TN1]: 10 }), filho({ [TN1]: 10.004 })],
    ['a ghost key 1 → 2', filho({ 'a/b': 1 }), filho({ 'a/b': 2 })],
    ['a custo-only edit', filho({ [TN1]: 11.11 }), filho({ [TN1]: 11.11 }, { custo: 22.22 })],
    [
      'a new counting link only (the anchor gains a conta)',
      filho({ [TN1]: 11.11 }, {}, []),
      filho({ [TN1]: 11.11 }, {}, [C1]),
    ],
    [
      'photos, publicado and a kit rollup',
      filho({ [TN1]: 11.11 }),
      filho({ [TN1]: 11.11 }, { fotos: ['f1'], publicado: true, pesoKg: 1.5 }),
    ],
  ])('%s ⇒ irrelevante', async (_r, antes, depois) => {
    // The valve UNRECOGNISED: relevance is still the FIRST gate, so not even its line is written.
    const h = montar({ ambiente: { [VALVULA_ENV_LI.preco]: 'ON' } });

    expect(await tratarEventoPrecoLi(semDb(h), evento(antes, depois))).toEqual({
      tipo: 'irrelevante',
    });
    expect(h.relogios).toBe(0);
    expect(h.linhas).toEqual([]);
    expect(stdout.escritas()).toEqual([]);
  });

  it('⚠️ NEAR-MISS: another tabela’s VALID key moves on a C1-anchored produto ⇒ the map only (ONE query, cold), processado, nothing else — child and root alike', async () => {
    const h = montar();
    const r1 = await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ 'tab-li-outra': 11.11 }), filho({ 'tab-li-outra': 22.22 })),
    );
    expect(r1).toMatchObject({
      tipo: 'processado',
      caminho: 'filho',
      leiturasDoPai: 0,
      consultas: 0,
      tarefas: 0,
    });
    const r2 = await tratarEventoPrecoLi(
      h.deps,
      evento(raiz({ 'tab-li-outra': 11.11 }), raiz({ 'tab-li-outra': 22.22 }), R),
    );
    expect(r2).toMatchObject({ tipo: 'processado', caminho: 'raiz', consultas: 0, tarefas: 0 });
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 0, baixar: [] });
    expect(h.agendadores).toBe(0);
    expect(h.relogios).toBe(0);
    expect(h.linhas).toEqual([]);
  });

  it('49.99 → 50 on TN1, a child under a NON-propagating parent ⇒ ONE parent read, ONE task baixar:true', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ [TN1]: 49.99 }), filho({ [TN1]: 50 })),
    );
    expect(r).toEqual({
      tipo: 'processado',
      caminho: 'filho',
      contas: [C1],
      leiturasDoPai: 1,
      consultas: 0,
      tarefas: 1,
      recusadas: 0,
      familiasAcimaDoLimite: 0,
      tarefasDesligadas: false,
    });
    expect(tarefasDe(h)).toEqual([tarefa(C1, P, true)]);
  });

  it('⚠️ an unreadable value against a readable one ("10" → 10) on TN1 is RELEVANT (fail-open): the same as a price move', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: '10' }), filho({ [TN1]: 10 })));
    expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The valve                                   */
/* -------------------------------------------------------------------------- */

describe('the valve', () => {
  const movimento = () => evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 }));

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
  ])('%s ⇒ desligado, the db never built, NO line', async (_r, valor) => {
    const h = montar({ ambiente: { [VALVULA_ENV_LI.preco]: valor } });
    expect(await tratarEventoPrecoLi(semDb(h), movimento())).toEqual({ tipo: 'desligado' });
    expect(h.linhas).toEqual([]);
    expect(stdout.escritas()).toEqual([]);
  });

  it.each([['ON'], [' on'], ['dry_run'], ['true']])(
    'an UNRECOGNISED %j ⇒ desligado, 0 reads, and ONE WARNING run-start line per instance (latched)',
    async (valor) => {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.preco]: valor } });
      await tratarEventoPrecoLi(semDb(h), movimento());
      await tratarEventoPrecoLi(semDb(h), movimento());
      const linhas = stdout.escritas().map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ severity: 'WARNING', evento: 'valvula', fluxo: 'preco' });

      // A new instance logs it again.
      __reiniciarGatilhoPrecoParaTestes();
      await tratarEventoPrecoLi(semDb(h), movimento());
      expect(stdout.escritas()).toHaveLength(2);
    },
  );

  it.each([['dry-run'], ['on']])(
    '⚠️ NEAR-MISS: %s goes on to the conta map alike (the trigger reads no canary and no read switch)',
    async (valor) => {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.preco]: valor } });
      seedPai(h.db, { propagatePriceToChildren: false });
      await tratarEventoPrecoLi(h.deps, movimento());
      expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                         The anchor and the conta map                         */
/* -------------------------------------------------------------------------- */

describe('the anchor and the conta map', () => {
  it('an EMPTY anchor on both sides ⇒ fora-do-li, the db never built', async () => {
    const h = montar();
    expect(
      await tratarEventoPrecoLi(
        semDb(h),
        evento(filho({ [TN1]: 11.11 }, {}, []), filho({ [TN1]: 22.22 }, {}, [])),
      ),
    ).toEqual({ tipo: 'fora-do-li' });
    // An anchor that is no array at all reads the same.
    expect(
      await tratarEventoPrecoLi(
        semDb(h),
        evento(
          filho({ [TN1]: 11.11 }, { integracoesComProduto: 'x' }),
          filho({ [TN1]: 22.22 }, { integracoesComProduto: null }),
        ),
      ),
    ).toEqual({ tipo: 'fora-do-li' });
  });

  it.each([
    ['C4 (no normal tabela: inert)', C4],
    ['C3 (inactive)', C3],
    ['a conta that is no Loja Integrada conta at all', 'conta-shopee-x'],
  ])(
    'an anchor naming only %s ⇒ fora-do-li after the ONE map query, no line',
    async (_r, conta) => {
      const h = montar();
      seedPai(h.db, { propagatePriceToChildren: false, integracoesComProduto: [conta] });
      expect(
        await tratarEventoPrecoLi(
          h.deps,
          evento(filho({ [TN1]: 11.11 }, {}, [conta]), filho({ [TN1]: 22.22 }, {}, [conta])),
        ),
      ).toEqual({ tipo: 'fora-do-li' });
      expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 0, baixar: [] });
      expect(h.linhas).toEqual([]);
    },
  );

  it('⚠️ NEAR-MISS: the same write anchored to C1 ⇒ processado', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    expect(
      await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 }))),
    ).toMatchObject({ tipo: 'processado', contas: [C1], tarefas: 1 });
  });

  it('a conta only on the BEFORE side of the anchor (a link removed in the same write) is concerned', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ [TN1]: 11.11 }, {}, [C1]), filho({ [TN1]: 22.22 }, {}, [])),
    );
    expect(tarefasDe(h)).toEqual([tarefa(C1, P, true)]);
  });

  it('the map is cached: a second relevant event in the TTL costs no map query', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 })));
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 22.22 }), filho({ [TN1]: 33.33 })));
    expect(consultasEm(h, 'integracao')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  A child                                     */
/* -------------------------------------------------------------------------- */

describe('a child — at most ONE masked parent read', () => {
  it('an ECHO under propagation, the parent anchored to C1 ⇒ ONE read masked to EXACTLY its flag and anchor, ZERO tasks, ONE INFO line', async () => {
    const h = montar();
    seedPai(h.db);
    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ [TN1]: 33.33 }), filho({ [TN1]: 44.44 })),
    );
    expect(r).toMatchObject({ tipo: 'processado', leiturasDoPai: 1, tarefas: 0 });
    expect(h.getAll).toHaveBeenCalledTimes(1);
    expect(h.getAll.mock.calls[0]?.at(-1)).toEqual({
      fieldMask: ['propagatePriceToChildren', 'integracoesComProduto'],
    });
    expect([...CAMPOS_PAI_GATILHO_PRECO_LI]).toEqual([
      'propagatePriceToChildren',
      'integracoesComProduto',
    ]);
    expect(h.db.leituras).toEqual([`produtos/${PAI}`]);
    expect(h.enfileirados).toEqual([]);
    expect(h.agendadores).toBe(0);
    expect(h.linhas).toEqual([
      [
        'INFO',
        '[loja-integrada/preco] gatilho decidido',
        {
          produtoId: P,
          caminho: 'filho',
          contas: [C1],
          leiturasDoPai: 1,
          consultas: 0,
          tarefas: 0,
          recusadas: 0,
        },
      ],
    ]);
  });

  it('⚠️ NEAR-MISS: the propagating parent’s anchor LACKS C1 ⇒ ONE read, ONE task baixar:true', async () => {
    const h = montar();
    seedPai(h.db, { integracoesComProduto: [C2] });
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 33.33 }), filho({ [TN1]: 44.44 })));
    expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
    expect(tarefasDe(h)).toEqual([tarefa(C1, P, true)]);
  });

  it.each([
    ['its flag false', { propagatePriceToChildren: false }],
    [
      'its flag false, its anchor no array',
      { propagatePriceToChildren: false, integracoesComProduto: 'x' },
    ],
    ['propagating, its anchor no array (it names no conta)', { integracoesComProduto: 'x' }],
  ])(
    'a parent that does not own the family (%s) ⇒ ONE read, ONE task baixar:true',
    async (_r, over) => {
      const h = montar();
      seedPai(h.db, over);
      await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 })));
      expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
    },
  );

  it('a MISSING parent ⇒ ONE read (not found), ONE task baixar:true — the run holds pai-ausente', async () => {
    const h = montar();
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 })));
    expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
    expect(h.db.leituras).toEqual([`produtos/${PAI}`]);
  });

  it.each([['a/b'], ['__x__'], ['.']])(
    'a parent id %j that names NO document ⇒ ZERO reads, ONE task baixar:true',
    async (paiId) => {
      const h = montar();
      const r = await tratarEventoPrecoLi(
        h.deps,
        evento(filho({ [TN1]: 11.11 }, { paiId }), filho({ [TN1]: 22.22 }, { paiId })),
      );
      expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 1, baixar: [true] });
      expect(h.db.leituras).toEqual([]);
      // The result and the line report the read it did NOT make.
      expect(r).toMatchObject({ tipo: 'processado', leiturasDoPai: 0, tarefas: 1 });
      expect(linhasDe(h, 'INFO').map((l) => l[2])).toEqual([
        expect.objectContaining({ leiturasDoPai: 0, tarefas: 1 }),
      ]);
    },
  );

  it.each([
    ["'P' → 'Q'", PAI, 'prod-li-outro-pai'],
    ["'P' → absent", PAI, undefined],
    ["absent → 'P'", undefined, PAI],
  ])(
    'a PARENT move %s ⇒ ZERO reads, no query, ONE task per concerned conta, baixar:false',
    async (_r, a, b) => {
      const h = montar();
      const lado = (paiId: string | undefined) => {
        const d = filho({ [TN1]: 11.11 }, {}, [C1, C2]);
        if (paiId === undefined) delete d.paiId;
        else d.paiId = paiId;
        return d;
      };
      await tratarEventoPrecoLi(h.deps, evento(lado(a), lado(b)));
      expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 2, baixar: [false] });
      expect(tarefasDe(h)).toEqual([tarefa(C1, P, false), tarefa(C2, P, false)]);
      // An event that read nothing beyond the map but ENQUEUED still writes its ONE line.
      expect(h.linhas).toEqual([
        [
          'INFO',
          '[loja-integrada/preco] gatilho decidido',
          {
            produtoId: P,
            caminho: 'filho',
            contas: [C1, C2],
            leiturasDoPai: 0,
            consultas: 0,
            tarefas: 2,
            recusadas: 0,
          },
        ],
      ]);
    },
  );

  it('⚠️ a parent move that ALSO moves TN1 ⇒ still zero reads and baixar:false (the stated precedence)', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ [TN1]: 22.22 }), filho({ [TN1]: 11.11 }, { paiId: 'prod-li-outro-pai' })),
    );
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 1, baixar: [false] });
  });

  it('the child’s OWN flag moved, and no tabela of a concerned conta ⇒ processado, zero reads, no line', async () => {
    const h = montar();
    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(
        filho({ [TN1]: 11.11 }, { propagatePriceToChildren: true }),
        filho({ [TN1]: 11.11 }, { propagatePriceToChildren: false }),
      ),
    );
    expect(r).toMatchObject({ tipo: 'processado', caminho: 'filho', leiturasDoPai: 0 });
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 0, tarefas: 0, baixar: [] });
    expect(h.linhas).toEqual([]);
  });

  it('the conta’s PROMOTIONAL tabela moving is a price move too; a promo of another conta is not', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    await tratarEventoPrecoLi(
      h.deps,
      evento(filho({ [TP1]: 9.99 }, {}, [C1, C2]), filho({ [TP1]: 8.88 }, {}, [C1, C2])),
    );
    expect(tarefasDe(h)).toEqual([tarefa(C1, P, true)]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   A root                                     */
/* -------------------------------------------------------------------------- */

describe('a root — ONE family query per concerned conta', () => {
  it('flag on, TN1 moved, anchored children ⇒ exactly ONE query, its shape spelled out; tasks = the C1-anchored children only', async () => {
    const h = montar();
    seedFilhoDe(h.db, R, 'f-01', [C1]);
    seedFilhoDe(h.db, R, 'f-02', [C1, C2]);
    seedFilhoDe(h.db, R, 'f-03', [C2]); // anchored only to C2
    seedFilhoDe(h.db, R, 'f-04', []); // not anchored
    seedFilhoDe(h.db, 'prod-li-outra-raiz', 'g-01', [C1]); // another root's child

    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R),
    );
    expect(r).toMatchObject({ tipo: 'processado', caminho: 'raiz', consultas: 1, tarefas: 2 });
    expect(consultasEm(h, 'produtos')).toEqual([
      {
        colecao: 'produtos',
        filtros: [
          ['paiId', '==', R],
          ['integracoesComProduto', 'array-contains', C1],
        ],
        ordens: [],
        limite: 51,
        apos: null,
        selecao: ['paiId'],
      },
    ]);
    expect(tarefasDe(h)).toEqual([tarefa(C1, 'f-01', true), tarefa(C1, 'f-02', true)]);
    expect(h.getAll).not.toHaveBeenCalled();
  });

  it('flag OFF + a price move, anchored children ⇒ ONE query, ZERO tasks (no child task, no root task)', async () => {
    const h = montar();
    seedFilhoDe(h.db, R, 'f-01', [C1]);
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: false }),
        raiz({ [TN1]: 66.66 }, { propagatePriceToChildren: false }),
        R,
      ),
    );
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 1, tarefas: 0, baixar: [] });
    expect(linhasDe(h, 'INFO')).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the same flag-off price move on a CHILDLESS root ⇒ ONE query, the root’s own task baixar:true', async () => {
    const h = montar();
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: false }),
        raiz({ [TN1]: 66.66 }, { propagatePriceToChildren: false }),
        R,
      ),
    );
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 1, tarefas: 1, baixar: [true] });
    expect(tarefasDe(h)).toEqual([tarefa(C1, R, true)]);
  });

  it.each([
    ['true → false', true, false],
    ['false → true', false, true],
  ])(
    'a flag flip %s with no tabela moved ⇒ ONE query, the anchored children’s tasks baixar:true',
    async (_r, a, b) => {
      const h = montar();
      seedFilhoDe(h.db, R, 'f-01', [C1]);
      seedFilhoDe(h.db, R, 'f-02', [C1]);
      await tratarEventoPrecoLi(
        h.deps,
        evento(
          raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: a }),
          raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: b }),
          R,
        ),
      );
      expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 1, tarefas: 2, baixar: [true] });
    },
  );

  it('a flag flip on a CHILDLESS root with no own move ⇒ ONE query, ZERO tasks', async () => {
    const h = montar();
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: true }),
        raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: false }),
        R,
      ),
    );
    expect(custos(h)).toEqual({ mapa: 1, pai: 0, familia: 1, tarefas: 0, baixar: [] });
  });

  it.each([
    ["a '' root", ''],
    ['a self-parent root', R],
  ])(
    '%s fans out by its OWN id; nothing reads produtos/ or produtos/""; a self-parent is not its own child',
    async (_r, paiId) => {
      const h = montar();
      if (paiId === R) seedFilhoDe(h.db, R, R, [C1]); // the self-parent root itself, stored
      seedFilhoDe(h.db, R, 'f-01', [C1]);
      await tratarEventoPrecoLi(
        h.deps,
        evento(raiz({ [TN1]: 55.56 }, { paiId }), raiz({ [TN1]: 66.66 }, { paiId }), R),
      );
      expect(consultasEm(h, 'produtos').map((c) => c.filtros[0])).toEqual([['paiId', '==', R]]);
      expect(h.db.leituras).toEqual([]);
      expect(h.db.leituras.some((p) => p === 'produtos/' || p === "produtos/''")).toBe(false);
      expect(tarefasDe(h)).toEqual([tarefa(C1, 'f-01', true)]);
    },
  );

  it('a self-parent CHILDLESS root: its own document matched its own query, and it still gets its own task', async () => {
    const h = montar();
    seedFilhoDe(h.db, R, R, [C1]);
    await tratarEventoPrecoLi(
      h.deps,
      evento(raiz({ [TN1]: 55.56 }, { paiId: R }), raiz({ [TN1]: 66.66 }, { paiId: R }), R),
    );
    expect(tarefasDe(h)).toEqual([tarefa(C1, R, true)]);
  });

  it(`${String(MAX_FILHOS_GATILHO_PRECO_LI + 1)} anchored children ⇒ ${String(MAX_FILHOS_GATILHO_PRECO_LI)} tasks, the first in document-id order, and ONE WARNING familia-excede-limite`, async () => {
    const h = montar();
    const ids = Array.from({ length: 51 }, (_, i) => `f-${String(i).padStart(2, '0')}`);
    for (const id of [...ids].reverse()) seedFilhoDe(h.db, R, id, [C1]);
    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R),
    );
    expect(r).toMatchObject({ tarefas: 50, familiasAcimaDoLimite: 1 });
    expect(tarefasDe(h).map((t) => t.produtoId)).toEqual(ids.slice(0, 50));
    expect(linhasDe(h, 'WARNING')).toEqual([
      [
        'WARNING',
        '[loja-integrada/preco] gatilho família acima do limite — só os primeiros enfileirados',
        { produtoId: R, contaId: C1, limite: 50, motivo: 'familia-excede-limite' },
      ],
    ]);
  });

  it(`⚠️ NEAR-MISS: exactly ${String(MAX_FILHOS_GATILHO_PRECO_LI)} children ⇒ ${String(MAX_FILHOS_GATILHO_PRECO_LI)} tasks, NO WARNING`, async () => {
    const h = montar();
    for (let i = 0; i < 50; i += 1) seedFilhoDe(h.db, R, `f-${String(i).padStart(2, '0')}`, [C1]);
    const r = await tratarEventoPrecoLi(
      h.deps,
      evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R),
    );
    expect(r).toMatchObject({ tarefas: 50, familiasAcimaDoLimite: 0 });
    expect(linhasDe(h, 'WARNING')).toEqual([]);
    expect(MAX_FILHOS_GATILHO_PRECO_LI).toBe(50);
  });

  it('a root anchored to two contas ⇒ TWO queries; each conta’s tasks come from its own query only', async () => {
    const h = montar();
    seedFilhoDe(h.db, R, 'f-01', [C1]);
    seedFilhoDe(h.db, R, 'f-02', [C2]);
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56, [TN2]: 55.56 }, {}, [C1, C2]),
        raiz({ [TN1]: 66.66, [TN2]: 66.66 }, {}, [C1, C2]),
        R,
      ),
    );
    expect(consultasEm(h, 'produtos').map((c) => c.filtros[1])).toEqual([
      ['integracoesComProduto', 'array-contains', C1],
      ['integracoesComProduto', 'array-contains', C2],
    ]);
    expect(tarefasDe(h)).toEqual([tarefa(C1, 'f-01', true), tarefa(C2, 'f-02', true)]);
  });

  it('a root anchored to two contas, only C1’s tabela moved ⇒ ONE query (C2 is not affected)', async () => {
    const h = montar();
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56, [TN2]: 55.56 }, {}, [C1, C2]),
        raiz({ [TN1]: 66.66, [TN2]: 55.56 }, {}, [C1, C2]),
        R,
      ),
    );
    expect(consultasEm(h, 'produtos')).toHaveLength(1);
    expect(tarefasDe(h)).toEqual([tarefa(C1, R, true)]);
  });
});

describe('two contas are isolated', () => {
  it('a child anchored to C1 and C2 whose propagating parent is anchored to C1 only ⇒ ONE task, for C2', async () => {
    const h = montar();
    seedPai(h.db, { integracoesComProduto: [C1] });
    await tratarEventoPrecoLi(
      h.deps,
      evento(
        filho({ [TN1]: 11.11, [TN2]: 11.11 }, {}, [C1, C2]),
        filho({ [TN1]: 22.22, [TN2]: 22.22 }, {}, [C1, C2]),
      ),
    );
    expect(custos(h)).toEqual({ mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] });
    expect(tarefasDe(h)).toEqual([tarefa(C2, P, true)]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Names, the window, the clock                         */
/* -------------------------------------------------------------------------- */

describe('names and the clock', () => {
  it('a baixar:false task and a baixar:true one for the same child in ONE window have two names; the same event repeated has the same name', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    // A: the parent moves (baixar:false). B: its price moves under a non-propagating parent.
    const a = evento(filho({ [TN1]: 11.11 }, { paiId: 'prod-li-antigo' }), filho({ [TN1]: 11.11 }));
    const b = evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 }));
    await tratarEventoPrecoLi(h.deps, a);
    await tratarEventoPrecoLi(h.deps, b);
    await tratarEventoPrecoLi(h.deps, b);
    const [ea, eb1, eb2] = h.enfileirados;
    expect(ea?.tarefa.baixar).toBe(false);
    expect(eb1?.tarefa.baixar).toBe(true);
    expect(ea?.opcoes.id).not.toBe(eb1?.opcoes.id);
    expect(eb1?.opcoes.id).toBe(eb2?.opcoes.id);
    expect(eb1?.opcoes.id).toBe(idDaTarefaPrecoLi(tarefa(C1, P, true)));
  });

  it('the clock is read ONLY inside the enqueues, after EVERY read; the window is the one after the reads', async () => {
    let agora = T0;
    const leiturasAoLerORelogio: number[] = [];
    const h = montar({
      agora: () => {
        leiturasAoLerORelogio.push(h.db.leituras.length + h.db.consultas.length);
        return agora;
      },
    });
    seedFilhoDe(h.db, R, 'f-01', [C1, C2]);
    seedFilhoDe(h.db, R, 'f-02', [C1, C2]);
    // The first family query is answered one minute after the event arrived.
    h.db.antesDaProximaConsulta('produtos', () => {
      agora = T0 + 60_000;
    });

    await tratarEventoPrecoLi(
      h.deps,
      evento(
        raiz({ [TN1]: 55.56, [TN2]: 55.56 }, {}, [C1, C2]),
        raiz({ [TN1]: 66.66, [TN2]: 66.66 }, {}, [C1, C2]),
        R,
      ),
    );

    const total = h.db.leituras.length + h.db.consultas.length;
    expect(total).toBe(3); // the map query and two family queries
    expect(leiturasAoLerORelogio).toEqual([total, total, total, total]);
    expect(h.enfileirados).toHaveLength(4);
    for (const { tarefa: t } of h.enfileirados) expect(t.janela).toBe(JANELA + 1);
  });
});

/* -------------------------------------------------------------------------- */
/*                     What a rejection means (the real producer)               */
/* -------------------------------------------------------------------------- */

describe('enqueue rejections, through the REAL producer', () => {
  function filaQue(falha: (t: TarefaPrecoLi) => Error | null) {
    const chamadas: { tarefa: TarefaPrecoLi; id: string }[] = [];
    const fila: FilaPrecoLi = {
      async enqueue(t, { id }) {
        chamadas.push({ tarefa: t, id });
        const err = falha(t);
        if (err !== null) throw err;
      },
    };
    return { fila, chamadas };
  }

  /** A root whose `n` anchored children all take a task. */
  function familia(h: Harness, n: number): EventoPrecoLi {
    for (let i = 0; i < n; i += 1) seedFilhoDe(h.db, R, `f-${String(i).padStart(2, '0')}`, [C1]);
    return evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R);
  }

  it('an answered task-already-exists is SUCCESS: counted, no warning, no throw', async () => {
    const f = filaQue(() => falhaDoFunctions('task-already-exists', 409));
    const h = montar({
      agendador: criarAgendadorPrecoLi({ fila: () => f.fila, desligado: false }),
    });
    expect(await tratarEventoPrecoLi(h.deps, familia(h, 2))).toMatchObject({ tarefas: 2 });
    expect(linhasDe(h, 'WARNING')).toEqual([]);
    expect(linhasDe(h, 'ERROR')).toEqual([]);
  });

  it('the sweep-only valve closed ⇒ ONE WARNING, the remaining rounds never attempted, resolves', async () => {
    const real = criarAgendadorPrecoLi({
      fila: () => {
        throw new Error('teste: a fila nunca é resolvida com a válvula fechada');
      },
      desligado: true,
    });
    let tentativas = 0;
    const h = montar({
      agendador: {
        enfileirar: (t, o) => {
          tentativas += 1;
          return real.enfileirar(t, o);
        },
      },
    });
    const r = await tratarEventoPrecoLi(h.deps, familia(h, 20));
    expect(tentativas).toBe(CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI);
    expect(r).toMatchObject({ tarefasDesligadas: true, tarefas: 0 });
    expect(linhasDe(h, 'WARNING')).toEqual([
      [
        'WARNING',
        '[loja-integrada/preco] gatilho tarefas desligadas — o resto do evento não foi enfileirado',
        { produtoId: R, caminho: 'raiz', contas: [C1], tarefas: 0, recusadas: 0 },
      ],
    ]);
    expect(linhasDe(h, 'INFO')).toEqual([]);
  });

  it('a strict-schema refusal (a conta id outside its grammar) ⇒ ONE WARNING with field names, that task skipped, recusadas: 1', async () => {
    const f = filaQue(() => null);
    const h = montar({
      agendador: criarAgendadorPrecoLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, 'conta.li', { tabelaNormalOuterRef: `listaDePrecos/${TN1}` });
    const lado = (paiId: string) => filho({ [TN1]: 11.11 }, { paiId }, ['conta.li', C1]);
    expect(
      await tratarEventoPrecoLi(h.deps, evento(lado(PAI), lado('prod-li-outro-pai'))),
    ).toMatchObject({ tarefas: 1, recusadas: 1 });
    expect(f.chamadas.map((c) => c.tarefa.contaId)).toEqual([C1]);
    expect(linhasDe(h, 'WARNING')).toEqual([
      [
        'WARNING',
        '[loja-integrada/preco] gatilho tarefa fora do formato da fila de preço — não enfileirada',
        { produtoId: P, alvoId: P, contaId: 'conta.li', campos: ['contaId'] },
      ],
    ]);
  });

  it('a strict-schema refusal of a PATH id the schema refuses ("__x__") ⇒ recusadas, nothing sent, no throw', async () => {
    const f = filaQue(() => null);
    const h = montar({
      agendador: criarAgendadorPrecoLi({ fila: () => f.fila, desligado: false }),
    });
    const lado = (paiId: string) => filho({ [TN1]: 11.11 }, { paiId });
    expect(
      await tratarEventoPrecoLi(h.deps, evento(lado(PAI), lado('prod-li-outro-pai'), '__x__')),
    ).toMatchObject({ tarefas: 0, recusadas: 1 });
    expect(f.chamadas).toEqual([]);
    expect(linhasDe(h, 'WARNING')[0]?.[2]).toMatchObject({ campos: ['produtoId'] });
  });

  it('a transient Cloud Tasks failure is RETHROWN once its round settled; the next round is never attempted', async () => {
    const f = filaQue((t) =>
      t.produtoId === 'f-00' ? falhaDoFunctions('unknown-error', 503) : null,
    );
    const h = montar({
      agendador: criarAgendadorPrecoLi({ fila: () => f.fila, desligado: false }),
    });
    await expect(tratarEventoPrecoLi(h.deps, familia(h, 12))).rejects.toBeInstanceOf(
      LiTarefasTransitoriasError,
    );
    expect(f.chamadas).toHaveLength(CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI);
    expect(linhasDe(h, 'INFO')).toEqual([]);
  });

  it('anything else (a broken deploy) is rethrown UNTOUCHED, never read as a schema refusal', async () => {
    const quebrado = falhaDoFunctions('permission-denied', 403);
    const f = filaQue(() => quebrado);
    const h = montar({
      agendador: criarAgendadorPrecoLi({ fila: () => f.fila, desligado: false }),
    });
    await expect(tratarEventoPrecoLi(h.deps, familia(h, 1))).rejects.toBe(quebrado);
    expect(linhasDe(h, 'WARNING')).toEqual([]);
  });

  it('50 tasks go in rounds of at most 8 in flight', async () => {
    let emVoo = 0;
    let maximo = 0;
    let feitas = 0;
    const h = montar({
      agendador: {
        async enfileirar() {
          emVoo += 1;
          maximo = Math.max(maximo, emVoo);
          await new Promise((r) => setTimeout(r, 1));
          emVoo -= 1;
          feitas += 1;
        },
      },
    });
    await tratarEventoPrecoLi(h.deps, familia(h, 50));
    expect(feitas).toBe(50);
    expect(maximo).toBe(CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI);
    expect(CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/*                               Read failures                                  */
/* -------------------------------------------------------------------------- */

describe('a read that throws is rethrown, with nothing enqueued', () => {
  const falha = Object.assign(new Error('teste: UNAVAILABLE'), { code: 14 });

  it('the conta-map load', async () => {
    const h = montar();
    h.db.falharConsulta('integracao', falha);
    await expect(
      tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 }))),
    ).rejects.toBe(falha);
    expect(h.agendadores).toBe(0);
  });

  it('the parent read', async () => {
    const h = montar();
    seedPai(h.db, { propagatePriceToChildren: false });
    h.db.falharLeitura(`produtos/${PAI}`, falha);
    await expect(
      tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 11.11 }), filho({ [TN1]: 22.22 }))),
    ).rejects.toBe(falha);
    expect(h.agendadores).toBe(0);
  });

  it('a family query', async () => {
    const h = montar();
    h.db.falharConsulta('produtos', falha);
    await expect(
      tratarEventoPrecoLi(h.deps, evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R)),
    ).rejects.toBe(falha);
    expect(h.agendadores).toBe(0);
    expect(h.relogios).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                        The index the family query rides                      */
/* -------------------------------------------------------------------------- */

describe('the declared indexes', () => {
  it('⚠️ INDEX PIN: the family query rides the declared COLLECTION produtos (paiId, integracoesComProduto, __name__) — the manual push’s SAME constant, all ASCENDING', async () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    const { indexes } = JSON.parse(
      readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8'),
    ) as {
      indexes: {
        collectionGroup: string;
        queryScope: string;
        fields: { fieldPath: string; order?: string }[];
      }[];
    };
    expect(CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI).toEqual(['paiId', 'integracoesComProduto']);
    const declarados = indexes.filter(
      (i) =>
        i.collectionGroup === 'produtos' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields.map((f) => f.fieldPath)) ===
          JSON.stringify([...CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI, '__name__']),
    );
    expect(declarados).toHaveLength(1);
    // `array-contains` rides the ASC entry on Enterprise (the price sweeps' precedent).
    expect(declarados[0]?.fields.every((f) => f.order === 'ASCENDING')).toBe(true);

    // The recorded filters use that constant's order; the projection is the one field filtered on.
    const h = montar();
    await tratarEventoPrecoLi(h.deps, evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R));
    const [consulta] = consultasEm(h, 'produtos');
    expect(consulta?.filtros.map((f) => f[0])).toEqual([...CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI]);
    expect(consulta?.ordens).toEqual([]);
    expect(consulta?.selecao).toEqual([...CAMPOS_FILHO_GATILHO_PRECO_LI]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Lines: ids and counts only                           */
/* -------------------------------------------------------------------------- */

describe('lines carry ids and counts only', () => {
  it('no logged meta holds a price, a tabela id or a fractional number', async () => {
    const h = montar();
    seedPai(h.db);
    for (let i = 0; i < 51; i += 1) seedFilhoDe(h.db, R, `f-${String(i).padStart(2, '0')}`, [C1]);
    await tratarEventoPrecoLi(h.deps, evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R));
    await tratarEventoPrecoLi(h.deps, evento(filho({ [TN1]: 49.99 }), filho({ [TN1]: 50 })));
    expect(linhasDe(h, 'WARNING')).toHaveLength(1);
    expect(linhasDe(h, 'INFO')).toHaveLength(2);

    const valores = (v: unknown): unknown[] =>
      Array.isArray(v)
        ? v.flatMap(valores)
        : typeof v === 'object' && v !== null
          ? Object.values(v).flatMap(valores)
          : [v];
    for (const [, , meta] of h.linhas) {
      for (const v of valores(meta)) {
        if (typeof v === 'number') expect(Number.isInteger(v), String(v)).toBe(true);
        if (typeof v === 'string') for (const t of TABELAS) expect(v).not.toContain(t);
      }
      expect(JSON.stringify(meta)).not.toMatch(/55\.56|66\.66|49\.99|33\.33|22\.22/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                            The cost table, pinned                            */
/* -------------------------------------------------------------------------- */

interface LinhaDeCusto {
  readonly preparar?: (db: FakeDb) => void;
  readonly ambiente?: AmbienteLi;
  readonly antes: DocData | null;
  readonly depois: DocData | null;
  readonly produtoId?: string;
  readonly esperado: ReturnType<typeof custos>;
}

const NADA = { mapa: 0, pai: 0, familia: 0, tarefas: 0, baixar: [] };
const filhos = (db: FakeDb, n: number, contas: readonly string[] = [C1]) => {
  for (let i = 0; i < n; i += 1) seedFilhoDe(db, R, `f-${String(i).padStart(2, '0')}`, contas);
};

const TABELA_DE_CUSTOS: readonly (readonly [string, LinhaDeCusto])[] = [
  ['a create', { antes: null, depois: filho({ [TN1]: 11.11 }), esperado: NADA }],
  ['a delete', { antes: filho({ [TN1]: 11.11 }), depois: null, esperado: NADA }],
  [
    'an anchor write',
    {
      antes: filho({ [TN1]: 11.11 }, {}, [C1]),
      depois: filho({ [TN1]: 11.11 }, {}, [C1, C2]),
      esperado: NADA,
    },
  ],
  [
    '10 → 10.004',
    { antes: filho({ [TN1]: 10 }), depois: filho({ [TN1]: 10.004 }), esperado: NADA },
  ],
  ['a ghost key', { antes: filho({ 'a/b': 1 }), depois: filho({ 'a/b': 2 }), esperado: NADA }],
  [
    'relevant, the valve off',
    {
      ambiente: { [VALVULA_ENV_LI.preco]: undefined },
      antes: filho({ [TN1]: 11.11 }),
      depois: filho({ [TN1]: 22.22 }),
      esperado: NADA,
    },
  ],
  [
    'relevant, the anchor empty on both sides',
    {
      antes: filho({ [TN1]: 11.11 }, {}, []),
      depois: filho({ [TN1]: 22.22 }, {}, []),
      esperado: NADA,
    },
  ],
  [
    'relevant, the anchor names no active conta with a normal tabela',
    {
      antes: filho({ [TN1]: 11.11 }, {}, [C3, C4]),
      depois: filho({ [TN1]: 22.22 }, {}, [C3, C4]),
      esperado: { ...NADA, mapa: 1 },
    },
  ],
  [
    'concerned, but only another tabela moved',
    {
      antes: filho({ [TN2]: 11.11 }),
      depois: filho({ [TN2]: 22.22 }),
      esperado: { ...NADA, mapa: 1 },
    },
  ],
  [
    'a child, the parent moved (k = 2)',
    {
      antes: filho({ [TN1]: 11.11 }, {}, [C1, C2]),
      depois: filho({ [TN1]: 11.11 }, { paiId: 'prod-li-outro-pai' }, [C1, C2]),
      esperado: { mapa: 1, pai: 0, familia: 0, tarefas: 2, baixar: [false] },
    },
  ],
  [
    'a child price move, the parent propagating and anchored to every conta',
    {
      preparar: (db) => seedPai(db, { integracoesComProduto: [C1, C2] }),
      antes: filho({ [TN1]: 11.11, [TN2]: 11.11 }, {}, [C1, C2]),
      depois: filho({ [TN1]: 22.22, [TN2]: 22.22 }, {}, [C1, C2]),
      esperado: { mapa: 1, pai: 1, familia: 0, tarefas: 0, baixar: [] },
    },
  ],
  [
    '… the parent propagating, its anchor lacking one of them',
    {
      preparar: (db) => seedPai(db, { integracoesComProduto: [C2] }),
      antes: filho({ [TN1]: 11.11, [TN2]: 11.11 }, {}, [C1, C2]),
      depois: filho({ [TN1]: 22.22, [TN2]: 22.22 }, {}, [C1, C2]),
      esperado: { mapa: 1, pai: 1, familia: 0, tarefas: 1, baixar: [true] },
    },
  ],
  [
    '… the parent not propagating',
    {
      preparar: (db) => seedPai(db, { propagatePriceToChildren: false }),
      antes: filho({ [TN1]: 11.11, [TN2]: 11.11 }, {}, [C1, C2]),
      depois: filho({ [TN1]: 22.22, [TN2]: 22.22 }, {}, [C1, C2]),
      esperado: { mapa: 1, pai: 1, familia: 0, tarefas: 2, baixar: [true] },
    },
  ],
  [
    '… the parent missing',
    {
      antes: filho({ [TN1]: 11.11, [TN2]: 11.11 }, {}, [C1, C2]),
      depois: filho({ [TN1]: 22.22, [TN2]: 22.22 }, {}, [C1, C2]),
      esperado: { mapa: 1, pai: 1, familia: 0, tarefas: 2, baixar: [true] },
    },
  ],
  [
    '… a parent id naming no document',
    {
      antes: filho({ [TN1]: 11.11, [TN2]: 11.11 }, { paiId: 'a/b' }, [C1, C2]),
      depois: filho({ [TN1]: 22.22, [TN2]: 22.22 }, { paiId: 'a/b' }, [C1, C2]),
      esperado: { mapa: 1, pai: 0, familia: 0, tarefas: 2, baixar: [true] },
    },
  ],
  [
    'a root, flag on, its own tabela moved, three anchored children',
    {
      preparar: (db) => filhos(db, 3),
      antes: raiz({ [TN1]: 55.56 }),
      depois: raiz({ [TN1]: 66.66 }),
      produtoId: R,
      esperado: { mapa: 1, pai: 0, familia: 1, tarefas: 3, baixar: [true] },
    },
  ],
  [
    'a root with no anchored child, its own tabela moved',
    {
      preparar: (db) => filhos(db, 2, [C2]),
      antes: raiz({ [TN1]: 55.56 }),
      depois: raiz({ [TN1]: 66.66 }),
      produtoId: R,
      esperado: { mapa: 1, pai: 0, familia: 1, tarefas: 1, baixar: [true] },
    },
  ],
  [
    'a root, flag off, its own tabela moved, anchored children',
    {
      preparar: (db) => filhos(db, 3),
      antes: raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: false }),
      depois: raiz({ [TN1]: 66.66 }, { propagatePriceToChildren: false }),
      produtoId: R,
      esperado: { mapa: 1, pai: 0, familia: 1, tarefas: 0, baixar: [] },
    },
  ],
  [
    'a root, the flag flipped',
    {
      preparar: (db) => filhos(db, 3),
      antes: raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: false }),
      depois: raiz({ [TN1]: 55.56 }, { propagatePriceToChildren: true }),
      produtoId: R,
      esperado: { mapa: 1, pai: 0, familia: 1, tarefas: 3, baixar: [true] },
    },
  ],
  [
    'a root with a 51st anchored child',
    {
      preparar: (db) => filhos(db, 51),
      antes: raiz({ [TN1]: 55.56 }),
      depois: raiz({ [TN1]: 66.66 }),
      produtoId: R,
      esperado: { mapa: 1, pai: 0, familia: 1, tarefas: 50, baixar: [true] },
    },
  ],
];

describe('the cost table, per event shape (store calls are ALWAYS 0)', () => {
  it.each(TABELA_DE_CUSTOS)('%s', async (_r, linha) => {
    const h = montar({ ...(linha.ambiente === undefined ? {} : { ambiente: linha.ambiente }) });
    linha.preparar?.(h.db);
    await tratarEventoPrecoLi(h.deps, evento(linha.antes, linha.depois, linha.produtoId ?? P));
    expect(custos(h)).toEqual(linha.esperado);
    expect(h.db.escritas).toEqual([]);
  });

  it('a propagating root’s price edit with m anchored children, then the m echo events: one query, m parent reads, m tasks, NO duplicate', async () => {
    const h = montar();
    seedPai(h.db, { integracoesComProduto: [C1] }, R);
    filhos(h.db, 4);
    await tratarEventoPrecoLi(h.deps, evento(raiz({ [TN1]: 55.56 }), raiz({ [TN1]: 66.66 }), R));
    // The ERP's propagation echoes the root's map onto each child, as an Admin update.
    for (let i = 0; i < 4; i += 1) {
      const id = `f-${String(i).padStart(2, '0')}`;
      const antes = filho({ [TN1]: 55.56 }, { paiId: R });
      const depois = filho({ [TN1]: 66.66 }, { paiId: R });
      await tratarEventoPrecoLi(h.deps, evento(antes, depois, id));
    }
    expect(custos(h)).toEqual({ mapa: 1, pai: 4, familia: 1, tarefas: 4, baixar: [true] });
    expect(new Set(h.enfileirados.map((e) => e.opcoes.id)).size).toBe(4);
    expect(linhasDe(h, 'INFO')).toHaveLength(5);
  });
});
