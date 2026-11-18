/**
 * The stock TRIGGER's work (master plan step 12, PR 12-f), gate by gate, pinned by COUNTING: the
 * reads the fake Firestore served (`leituras`, `consultas`, every `getAll`), the enqueues the
 * producer received (payloads and names), every log line (the injected logger and the app
 * logger's stdout) and the writes (none, ever — checked after every test). An emulator cannot
 * prove that a function did nothing, so the absences are pinned here.
 *
 * No call to Loja Integrada is reachable before the cutover — the global `fetch` throws in every test, and the
 * trigger builds no client. The producer is either a recording double or the REAL pure producer
 * (`criarAgendadorEstoqueLi`) over a fake transport whose failures are the SDK's own classes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueKitsLi,
  type TarefaEstoqueLi,
  type TarefaFilaEstoqueLi,
} from '@delfrance/schemas';

import { type AmbienteLi, VALVULA_ENV_LI } from '../core/valvulas';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, espiarStdout } from '../testing/fixtures';
import {
  type AgendadorEstoqueLi,
  type FilaEstoqueLi,
  LiTarefasTransitoriasError,
  type OpcoesEnfileiramentoEstoqueLi,
  agendamentoEstoqueLi,
  criarAgendadorEstoqueLi,
  idDaTarefaEstoqueKitsLi,
  idDaTarefaEstoqueLi,
  janelaEstoqueLi,
} from './agendadorEstoque';
import { TETO_ESTOQUE_ENV_LI, TETO_KITS_IMEDIATOS_ENV_LI } from './configEstoqueLi';
import { __setRelogioDoMapaDepositosParaTestes } from './depositosLi';
import {
  CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI,
  type DepsGatilhoEstoqueLi,
  type EventoEstoqueLi,
  __reiniciarGatilhoEstoqueParaTestes,
  tratarEventoEstoqueLi,
} from './gatilhoEstoque';

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

const T0 = AGORA_MS;
const JANELA = janelaEstoqueLi(T0);
const CONTA_A = 'conta-li-a';
const CONTA_B = 'conta-li-b';
const DEP = 'dep-li';
const DOC = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const OUTRO = 'documents/depositos/dep-outro';
const P = 'p-blank';
const E = `est-${P}-${DEP}`;
const EXEC = 'estoque-reconcile-20270115';
const LISTAGEM = `produtos/${P}/produtolojaintegrada`;

const canonico = (produtoId: string) => `est-${produtoId}-${DEP}`;
const caminho = (produtoId: string, id = canonico(produtoId)) =>
  `produtos/${produtoId}/estoques/${id}`;
const cabecalhoPath = (conta: string, produtoId = P) =>
  `sincEstoqueLojaIntegrada/${conta}/kits/${produtoId}`;

/** A stock record at the conta's depósito (documents form unless overridden). */
const reg = (quantidade: unknown, over: DocData = {}): DocData => ({
  depositoOuterRef: DOC,
  quantidade,
  quantidadeReservada: 0,
  localizacao: 'corredor-3',
  ...over,
});

function seedConta(db: FakeDb, id: string, ref: unknown = DOC): void {
  db.seed(`integracao/${id}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${id}`,
    ativo: true,
    depositoOuterRef: ref,
  });
}

/** A child link of `conta` on `produtoId`, in the stored wire shape. */
function seedLink(
  db: FakeDb,
  conta: string,
  over: DocData = {},
  produtoId = P,
  linkId?: string,
): void {
  db.seed(`produtos/${produtoId}/produtolojaintegrada/${linkId ?? `link-${conta}`}`, {
    contaLojaIntegrada: `documents/integracao/${conta}`,
    id: 182_904_918,
    paiProdutoIntegradaId: 900_001,
    ...over,
  });
}

function seedCabecalho(db: FakeDb, conta: string, over: DocData, produtoId = P): void {
  db.seed(cabecalhoPath(conta, produtoId), {
    execucaoId: EXEC,
    F: 1,
    qMax: 1,
    comps: {},
    kits: null,
    fatias: 0,
    ...over,
  });
}

/** An inline header whose kits are `kits` (kit id → its components' quantities). */
function cabecalhoEmLinha(
  kits: Readonly<Record<string, Readonly<Record<string, number>>>>,
  comps: Readonly<Record<string, string | null>>,
  qMax = 1,
): DocData {
  const ids = Object.keys(kits);
  return {
    F: ids.length,
    qMax,
    comps,
    kits: Object.fromEntries(ids.map((k, i) => [k, { i: String(5000 + i), q: kits[k] }])),
    fatias: 0,
  };
}

/** A sharded header (more than 30 kits): the kits live in shards, never read by the trigger. */
const cabecalhoEmFatias = (F = 31, qMax = 2): DocData => ({
  F,
  qMax,
  comps: { [P]: E },
  kits: null,
  fatias: 1,
});

function evento(
  antes: DocData | null,
  depois: DocData | null,
  produtoId = P,
  estoqueId = canonico(produtoId),
): EventoEstoqueLi {
  return { produtoId, estoqueId, antes, depois };
}

function tarefaDireta(conta: string, over: Partial<TarefaEstoqueLi> = {}): TarefaEstoqueLi {
  return {
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
    contaId: conta,
    produtoId: P,
    origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
    janela: JANELA,
    estoqueId: E,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Harness                                    */
/* -------------------------------------------------------------------------- */

interface Enfileirado {
  readonly tarefa: TarefaFilaEstoqueLi;
  readonly opcoes: OpcoesEnfileiramentoEstoqueLi;
}

type Linha = readonly ['INFO' | 'WARNING' | 'ERROR', string, Record<string, unknown> | undefined];

interface Harness {
  readonly db: FakeDb;
  readonly deps: DepsGatilhoEstoqueLi;
  readonly enfileirados: Enfileirado[];
  readonly linhas: Linha[];
  readonly getAll: ReturnType<typeof vi.spyOn>;
  dbs: number;
  agendadores: number;
}

const fakes: FakeDb[] = [];
let stdout: ReturnType<typeof espiarStdout>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoMapaDepositosParaTestes(() => T0);
  __reiniciarGatilhoEstoqueParaTestes();
  stdout = espiarStdout();
  // No call to the store, per file: nothing here may reach the global `fetch`.
  vi.stubGlobal('fetch', () => {
    throw new Error('gatilhoEstoque.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  // The trigger writes NOTHING, in every case.
  for (const f of fakes.splice(0)) expect(f.escritas).toEqual([]);
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoMapaDepositosParaTestes();
  __reiniciarGatilhoEstoqueParaTestes();
  vi.unstubAllGlobals();
});

function montar(
  o: {
    readonly ambiente?: AmbienteLi;
    readonly agendador?: AgendadorEstoqueLi;
    readonly agora?: () => number;
  } = {},
): Harness {
  const db = new FakeDb();
  fakes.push(db);
  const enfileirados: Enfileirado[] = [];
  const linhas: Linha[] = [];
  const gravador: AgendadorEstoqueLi = {
    async enfileirar(tarefa, opcoes) {
      enfileirados.push({ tarefa, opcoes });
    },
  };
  const h: Harness = {
    db,
    enfileirados,
    linhas,
    getAll: vi.spyOn(db, 'getAll'),
    dbs: 0,
    agendadores: 0,
    deps: {
      ambiente: { [VALVULA_ENV_LI.estoque]: 'dry-run', ...o.ambiente },
      db: () => {
        h.dbs += 1;
        return asDb(db);
      },
      agendador: () => {
        h.agendadores += 1;
        return o.agendador ?? gravador;
      },
      agoraMs: o.agora ?? (() => T0),
      logger: {
        info: (m, meta) => linhas.push(['INFO', m, meta]),
        warn: (m, meta) => linhas.push(['WARNING', m, meta]),
        error: (m, meta) => linhas.push(['ERROR', m, meta]),
      },
    },
  };
  return h;
}

/** A Firestore handle that throws on ANY touch. */
const DB_PROIBIDO = new Proxy(
  {},
  {
    get(_alvo, prop) {
      throw new Error(`teste: o portão de custo zero tocou o Firestore (${String(prop)})`);
    },
  },
) as Firestore;

const linhasDe = (h: Harness, sev: Linha[0]) => h.linhas.filter((l) => l[0] === sev);
const colecoes = (h: Harness) => h.db.consultas.map((c) => c.colecao);

/* -------------------------------------------------------------------------- */
/*                     Gate 1: irrelevant events touch no db                    */
/* -------------------------------------------------------------------------- */

describe('gate 1 — an irrelevant write costs ZERO reads and logs NOTHING', () => {
  it.each([
    ['a localizacao-only edit', reg(5), reg(5, { localizacao: 'corredor-9' })],
    ['the kit stamp (ultimaModificacao only)', reg(5), reg(5, { ultimaModificacao: 1 })],
    [
      'the paid → shipped pair (quantity and reservation both −2)',
      reg(5, { quantidadeReservada: 2 }),
      reg(3, { quantidadeReservada: 0 }),
    ],
    ['nothing changed at all', reg(5), reg(5)],
    ['both sides absent', null, null],
  ])('%s', async (_r, antes, depois) => {
    // The valve UNRECOGNISED and the cap unreadable: relevance is still the FIRST gate, so not
    // even their lines are written.
    const h = montar({
      ambiente: { [VALVULA_ENV_LI.estoque]: 'ON', [TETO_ESTOQUE_ENV_LI]: 'abc' },
    });
    const deps: DepsGatilhoEstoqueLi = {
      ...h.deps,
      db: () => DB_PROIBIDO,
      agendador: () => {
        throw new Error('teste: nada a enfileirar');
      },
    };

    expect(await tratarEventoEstoqueLi(deps, evento(antes, depois))).toEqual({
      tipo: 'irrelevante',
    });
    expect(h.linhas).toEqual([]);
    expect(stdout.escritas()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                Gate 2: the valve                             */
/* -------------------------------------------------------------------------- */

describe('gate 2 — the valve', () => {
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
  ])('%s ⇒ desligado, the db never built, NO line', async (_r, valor) => {
    const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: valor } });
    expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toEqual({
      tipo: 'desligado',
    });
    expect(h.dbs).toBe(0);
    expect(h.linhas).toEqual([]);
    expect(stdout.escritas()).toEqual([]);
  });

  it.each([['OFF'], [' on'], ['dry_run'], ['true']])(
    'an UNRECOGNISED %j ⇒ desligado, 0 reads, and ONE WARNING run-start line per instance (latched)',
    async (valor) => {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: valor } });
      await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
      await tratarEventoEstoqueLi(h.deps, evento(reg(4), reg(3)));
      expect(h.dbs).toBe(0);
      const linhas = stdout.escritas().map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ severity: 'WARNING', evento: 'valvula', fluxo: 'estoque' });

      // A new instance logs it again.
      __reiniciarGatilhoEstoqueParaTestes();
      await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
      expect(stdout.escritas()).toHaveLength(2);
    },
  );

  it.each([['dry-run'], ['on']])(
    '%s goes on to the depósito gate alike (the trigger reads no canary and no read switch)',
    async (valor) => {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: valor } });
      seedConta(h.db, CONTA_A, OUTRO);
      expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toEqual({
        tipo: 'fora-do-li',
      });
      expect(colecoes(h)).toEqual(['integracao']);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                        Gate 3: the depósito, cached                          */
/* -------------------------------------------------------------------------- */

describe('gate 3 — the depósito, exact and cached', () => {
  it.each([
    ['documents form', 'documents/depositos/dep-outro'],
    ['bare form', 'depositos/dep-outro'],
  ])(
    'a relevant write at ANOTHER depósito (%s): cold = the ONE contas query; warm = nothing',
    async (_r, ref) => {
      const h = montar();
      seedConta(h.db, CONTA_A);
      seedLink(h.db, CONTA_A);

      const r1 = await tratarEventoEstoqueLi(
        h.deps,
        evento(reg(5, { depositoOuterRef: ref }), reg(4, { depositoOuterRef: ref })),
      );
      expect(r1).toEqual({ tipo: 'fora-do-li' });
      expect(colecoes(h)).toEqual(['integracao']);
      expect(h.db.leituras).toEqual([]);

      await tratarEventoEstoqueLi(
        h.deps,
        evento(reg(4, { depositoOuterRef: ref }), reg(3, { depositoOuterRef: ref })),
      );
      expect(colecoes(h)).toEqual(['integracao']);
      expect(h.db.leituras).toEqual([]);
      expect(h.enfileirados).toEqual([]);
      expect(h.linhas).toEqual([]);
    },
  );

  it.each([
    ['documents form', DOC],
    ['bare form', NUA],
  ])('EQUAL: a record at the conta’s depósito in the %s concerns it', async (_r, ref) => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    await tratarEventoEstoqueLi(
      h.deps,
      evento(reg(5, { depositoOuterRef: ref }), reg(4, { depositoOuterRef: ref })),
    );
    expect(h.enfileirados.map((e) => e.tarefa.contaId)).toEqual([CONTA_A]);
  });

  it.each([
    ['a leading slash', `/documents/depositos/${DEP}`],
    ['a case change', 'documents/depositos/DEP-LI'],
    ['a trailing space', `documents/depositos/${DEP} `],
  ])(
    '⚠️ NEAR-MISS: a record at a FOLDED spelling of the depósito (%s) concerns no conta — the run could not find it',
    async (_r, ref) => {
      const h = montar();
      seedConta(h.db, CONTA_A);
      seedLink(h.db, CONTA_A);
      expect(
        await tratarEventoEstoqueLi(
          h.deps,
          evento(reg(5, { depositoOuterRef: ref }), reg(4, { depositoOuterRef: ref })),
        ),
      ).toEqual({ tipo: 'fora-do-li' });
      expect(colecoes(h)).toEqual(['integracao']);
      expect(h.db.leituras).toEqual([]);
    },
  );

  it('a conta whose own ref is in the bare form is matched as well', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A, NUA);
    seedLink(h.db, CONTA_A);
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados).toHaveLength(1);
  });
});

describe('the cap — read as none for relevance, reported only past the depósito gate', () => {
  it.each(['0', 'abc', ' 5'])(
    'LOJA_INTEGRADA_ESTOQUE_MAX=%j at an LI depósito ⇒ ONE ERROR teto-invalido, only the contas query, nothing enqueued',
    async (valor) => {
      const h = montar({ ambiente: { [TETO_ESTOQUE_ENV_LI]: valor } });
      seedConta(h.db, CONTA_A);
      seedLink(h.db, CONTA_A);

      expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toEqual({
        tipo: 'teto-invalido',
      });
      expect(colecoes(h)).toEqual(['integracao']);
      expect(h.db.leituras).toEqual([]);
      expect(h.agendadores).toBe(0);
      expect(h.linhas).toEqual([
        [
          'ERROR',
          expect.stringContaining('teto') as unknown as string,
          {
            produtoId: P,
            estoqueId: E,
            contas: [CONTA_A],
            motivo: 'teto-invalido',
            variavel: TETO_ESTOQUE_ENV_LI,
          },
        ],
      ]);
      expect(JSON.stringify(h.linhas)).not.toContain(`"${valor}"`);
    },
  );

  it('⚠️ the same unreadable cap at a NON-LI depósito logs NOTHING (no ERP-wide noise)', async () => {
    const h = montar({ ambiente: { [TETO_ESTOQUE_ENV_LI]: 'abc' } });
    seedConta(h.db, CONTA_A, OUTRO);
    expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toEqual({
      tipo: 'fora-do-li',
    });
    expect(h.linhas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     Gate 4: the links and the direct task                    */
/* -------------------------------------------------------------------------- */

describe('gate 4 — the direct task: only a linked CHILD of a concerned conta', () => {
  it('the cost contract: [contas query, the produto’s own links]; [the header]; ONE task; nothing written', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);

    const r = await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    expect(colecoes(h)).toEqual(['integracao', LISTAGEM]);
    expect(h.db.consultas[1]).toMatchObject({ filtros: [], ordens: [], limite: null });
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    expect(h.getAll).toHaveBeenCalledTimes(1);
    const esperada = tarefaDireta(CONTA_A);
    expect(h.enfileirados).toEqual([
      {
        tarefa: esperada,
        opcoes: {
          id: idDaTarefaEstoqueLi(esperada),
          agendarParaMs: agendamentoEstoqueLi(JANELA, P),
        },
      },
    ]);
    expect(r).toEqual({
      tipo: 'processado',
      contas: [CONTA_A],
      diretas: 1,
      kits: 0,
      fanouts: 0,
      recusadas: 0,
      tarefasDesligadas: false,
    });
    expect(linhasDe(h, 'INFO')).toEqual([
      [
        'INFO',
        expect.stringContaining('enfileirado') as unknown as string,
        {
          produtoId: P,
          estoqueId: E,
          contas: [CONTA_A],
          diretas: 1,
          kits: 0,
          fanouts: 0,
          recusadas: 0,
        },
      ],
    ]);
  });

  it('a create and a delete: apagado from the side that is GONE', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    await tratarEventoEstoqueLi(h.deps, evento(null, reg(3)));
    await tratarEventoEstoqueLi(h.deps, evento(reg(3), null));
    expect(h.enfileirados.map((e) => (e.tarefa as TarefaEstoqueLi).apagado)).toEqual([false, true]);
  });

  it.each([
    ['a parent link only (a root with grades)', { paiProdutoIntegradaId: null, grades: [1] }],
    ['a root without grades', { paiProdutoIntegradaId: null }],
    ['a trashed link', { removido: true }],
    ['another conta’s link', { contaLojaIntegrada: `documents/integracao/${CONTA_B}` }],
  ])('%s ⇒ no direct task, and the header is still read', async (_r, over) => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A, over);
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados).toEqual([]);
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    expect(h.agendadores).toBe(0);
  });

  it('two contas on ONE depósito, each with its own child link ⇒ ONE listing, the two headers in ONE getAll, TWO tasks', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedConta(h.db, CONTA_B, NUA);
    seedLink(h.db, CONTA_A, { id: 111 });
    seedLink(h.db, CONTA_B, { id: 222 });

    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    expect(colecoes(h)).toEqual(['integracao', LISTAGEM]);
    expect(h.getAll).toHaveBeenCalledTimes(1);
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), cabecalhoPath(CONTA_B)]);
    expect(h.enfileirados.map((e) => e.tarefa)).toEqual([
      tarefaDireta(CONTA_A),
      tarefaDireta(CONTA_B),
    ]);
  });

  it.each([
    ['−3 → −2 (a quotient may move; the own row publishes 0 on both sides)', {}, reg(-3), reg(-2)],
    ['7 → 8 above a cap of 5', { [TETO_ESTOQUE_ENV_LI]: '5' }, reg(7), reg(8)],
  ])(
    'relevant but NOT direct: %s ⇒ no links listing at all, the header still read, no task',
    async (_r, ambiente, antes, depois) => {
      const h = montar({ ambiente });
      seedConta(h.db, CONTA_A);
      seedLink(h.db, CONTA_A);
      await tratarEventoEstoqueLi(h.deps, evento(antes, depois));
      expect(colecoes(h)).toEqual(['integracao']);
      expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
      expect(h.enfileirados).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                         Gate 5: the kits, eager or not                       */
/* -------------------------------------------------------------------------- */

/** 29 kits bound by a LOW sibling (at 2) and one by a HIGH one (at 10), all needing 1 of P. */
function trintaKits(): DocData {
  const kits: Record<string, Record<string, number>> = {};
  for (let i = 0; i < 29; i++) kits[`kit-${String(i).padStart(2, '0')}`] = { [P]: 1, 's-baixo': 1 };
  kits['kit-alto'] = { [P]: 1, 's-alto': 1 };
  return cabecalhoEmLinha(kits, {
    [P]: E,
    's-baixo': canonico('s-baixo'),
    's-alto': canonico('s-alto'),
  });
}

describe('gate 5 — F at most the eager ceiling: the siblings, then the tie-inclusive filter', () => {
  it('F = 30 with the default ceiling ⇒ EAGER: exactly the deduplicated siblings in ONE getAll, one task per flagged kit', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, trintaKits());
    h.db.seed(caminho('s-baixo'), reg(2));
    h.db.seed(caminho('s-alto'), reg(10));

    const r = await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), caminho('s-alto'), caminho('s-baixo')]);
    expect(h.getAll).toHaveBeenCalledTimes(2);
    const esperada: TarefaEstoqueLi = {
      tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
      contaId: CONTA_A,
      produtoId: 'kit-alto',
      origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
      janela: JANELA,
      estoqueId: null,
      apagado: false,
      estoqueIds: { [P]: E, 's-alto': canonico('s-alto') },
      geracao: 0,
    };
    expect(h.enfileirados).toEqual([
      {
        tarefa: esperada,
        opcoes: {
          id: idDaTarefaEstoqueLi(esperada),
          agendarParaMs: agendamentoEstoqueLi(JANELA, 'kit-alto'),
        },
      },
    ]);
    expect(r).toMatchObject({ diretas: 0, kits: 1, fanouts: 0 });
    expect(linhasDe(h, 'INFO')[0]).toEqual([
      'INFO',
      expect.stringContaining('kits') as unknown as string,
      {
        produtoId: P,
        estoqueId: E,
        contaId: CONTA_A,
        F: 30,
        caminho: 'imediato',
        irmaosLidos: 2,
        sinalizados: 1,
      },
    ]);
  });

  it('F = 31 (kits in shards) ⇒ ZERO-CROSSING only: no sibling, no shard read; ONE estoque-kits task on 1 → 0', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmFatias());

    const r = await tratarEventoEstoqueLi(h.deps, evento(reg(1), reg(0)));

    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    const esperada: TarefaEstoqueKitsLi = {
      tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
      contaId: CONTA_A,
      componenteId: P,
      janela: JANELA,
    };
    expect(h.enfileirados).toEqual([
      {
        tarefa: esperada,
        opcoes: {
          id: idDaTarefaEstoqueKitsLi(esperada),
          agendarParaMs: agendamentoEstoqueLi(JANELA, P),
        },
      },
    ]);
    expect(r).toMatchObject({ kits: 0, fanouts: 1 });
  });

  it.each([
    ['5 → 6 (a rise)', 5, 6],
    ['5 → 4 (still above every kit’s need)', 5, 4],
  ])('⚠️ NEAR-MISS F = 31: %s ⇒ no fan-out, no other read', async (_r, a, d) => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmFatias(31, 2));
    await tratarEventoEstoqueLi(h.deps, evento(reg(a), reg(d)));
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    expect(h.enfileirados).toEqual([]);
  });

  it.each([
    ['29', 'zerados', 1],
    ['30', 'imediato', 3],
  ])(
    'F = 30 under a ceiling of %s ⇒ the %s path (the ceiling is inclusive)',
    async (teto, caminhoEsperado, leituras) => {
      const h = montar({ ambiente: { [TETO_KITS_IMEDIATOS_ENV_LI]: teto } });
      seedConta(h.db, CONTA_A);
      seedCabecalho(h.db, CONTA_A, trintaKits());
      h.db.seed(caminho('s-baixo'), reg(2));
      h.db.seed(caminho('s-alto'), reg(10));
      await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
      expect(h.db.leituras).toHaveLength(leituras);
      expect(linhasDe(h, 'INFO')[0]?.[2]).toMatchObject({ caminho: caminhoEsperado });
    },
  );

  it('ceiling 0 ⇒ even ONE inline kit takes the zero-crossing path: no sibling read, one estoque-kits on 3 → 0', async () => {
    const h = montar({ ambiente: { [TETO_KITS_IMEDIATOS_ENV_LI]: '0' } });
    seedConta(h.db, CONTA_A);
    seedCabecalho(
      h.db,
      CONTA_A,
      cabecalhoEmLinha({ k: { [P]: 1, s: 1 } }, { [P]: E, s: canonico('s') }),
    );
    await tratarEventoEstoqueLi(h.deps, evento(reg(3), reg(0)));
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    expect(h.enfileirados.map((e) => e.tarefa.tipo)).toEqual([TIPO_TAREFA_ESTOQUE_LI.estoqueKits]);
    expect(linhasDe(h, 'WARNING')).toEqual([]);
  });

  it.each(['31', 'abc'])(
    'ceiling %j ⇒ the same as 0, plus ONE WARNING naming the variable (never the value)',
    async (teto) => {
      const h = montar({ ambiente: { [TETO_KITS_IMEDIATOS_ENV_LI]: teto } });
      seedConta(h.db, CONTA_A);
      seedCabecalho(
        h.db,
        CONTA_A,
        cabecalhoEmLinha({ k: { [P]: 1, s: 1 } }, { [P]: E, s: canonico('s') }),
      );
      await tratarEventoEstoqueLi(h.deps, evento(reg(3), reg(0)));
      expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
      expect(h.enfileirados.map((e) => e.tarefa.tipo)).toEqual([
        TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
      ]);
      expect(linhasDe(h, 'WARNING')).toEqual([
        [
          'WARNING',
          expect.any(String) as unknown as string,
          { produtoId: P, estoqueId: E, variavel: TETO_KITS_IMEDIATOS_ENV_LI },
        ],
      ]);
    },
  );

  it('a header that does not parse ⇒ ONE WARNING with field names, no kit work', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, { ...cabecalhoEmLinha({ k: { [P]: 1 } }, { [P]: E }), F: 2 });
    await tratarEventoEstoqueLi(h.deps, evento(reg(1), reg(0)));
    expect(h.enfileirados).toEqual([]);
    expect(linhasDe(h, 'WARNING')).toEqual([
      [
        'WARNING',
        expect.any(String) as unknown as string,
        { produtoId: P, estoqueId: E, contaId: CONTA_A, campos: ['kits'] },
      ],
    ]);
  });
});

describe('the TIE: a kit sale moves every component in ONE commit', () => {
  const KIT = { k: { blank: 1, print: 1 } };
  const COMPS = { blank: canonico('blank'), print: canonico('print') };

  function cena(printAgora: number): Harness {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, COMPS), 'blank');
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, COMPS), 'print');
    h.db.seed(caminho('blank'), reg(4));
    h.db.seed(caminho('print'), reg(printAgora));
    return h;
  }

  it('{blank, print} both 5 → 4: the event of EITHER component flags the kit (each sees the other already at 4)', async () => {
    const h = cena(4);
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4), 'blank'));
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4), 'print'));
    expect(
      h.enfileirados.map((e) => [e.tarefa.tipo, (e.tarefa as TarefaEstoqueLi).produtoId]),
    ).toEqual([
      [TIPO_TAREFA_ESTOQUE_LI.estoque, 'k'],
      [TIPO_TAREFA_ESTOQUE_LI.estoque, 'k'],
    ]);
  });

  it('⚠️ NEAR-MISS: the other component STRICTLY below both sides (print at 3) ⇒ blank’s 5 → 4 does not flag', async () => {
    const h = cena(3);
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4), 'blank'));
    expect(h.enfileirados).toEqual([]);
  });
});

describe('fail open: a sibling the trigger cannot read flags its kit', () => {
  const KIT = { k: { [P]: 1, s: 1 } };

  it.each([
    ['comps names no record for it', { s: null }, null],
    ['its record is NOT_FOUND', { s: canonico('s') }, undefined],
    [
      'its record is at ANOTHER depósito',
      { s: canonico('s') },
      reg(2, { depositoOuterRef: OUTRO }),
    ],
    [
      'its record is at a FOLDED spelling of ours',
      { s: canonico('s') },
      reg(2, { depositoOuterRef: `/${DOC}` }),
    ],
    ['its quantity is unreadable', { s: canonico('s') }, reg('2')],
  ])('%s ⇒ flagged', async (_r, compsDoIrmao, registro) => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, ...compsDoIrmao }));
    if (registro !== null && registro !== undefined) h.db.seed(caminho('s'), registro);
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual(['k']);
  });

  it('⚠️ NEAR-MISS: the same sibling at OUR depósito strictly below both sides ⇒ not flagged', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: canonico('s') }));
    h.db.seed(caminho('s'), reg(2));
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados).toEqual([]);
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), caminho('s')]);
  });
});

describe('a sibling is resolved as the send run resolves it: the canonical record wins', () => {
  const KIT = { k: { [P]: 1, s: 1 } };
  const LEGADO = caminho('s', 'legado-1');

  it('comps names a LEGACY record at 0 and the canonical one sits at 10 ⇒ both in ONE getAll, the canonical wins, the kit flags', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: 'legado-1' }));
    h.db.seed(LEGADO, reg(0));
    h.db.seed(caminho('s'), reg(10));

    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    expect(h.getAll).toHaveBeenCalledTimes(2);
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), LEGADO, caminho('s')]);
    expect(h.enfileirados.map((e) => e.tarefa)).toEqual([
      expect.objectContaining({ produtoId: 'k', estoqueIds: { [P]: E, s: 'legado-1' } }),
    ]);
  });

  it('⚠️ NEAR-MISS: the legacy record ALONE at 0 still bounds the kit (the run would read it) ⇒ not flagged', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: 'legado-1' }));
    h.db.seed(LEGADO, reg(0));
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados).toEqual([]);
    // The cost: one more point read (here NOT_FOUND) per legacy-named sibling.
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), LEGADO, caminho('s')]);
  });

  it('a canonical record at ANOTHER depósito does not win: the legacy one at ours answers', async () => {
    const h = montar();
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: 'legado-1' }));
    h.db.seed(LEGADO, reg(0));
    h.db.seed(caminho('s'), reg(10, { depositoOuterRef: OUTRO }));
    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));
    expect(h.enfileirados).toEqual([]);
  });
});

describe('the zero-cost skip (active only with a finite cap)', () => {
  const KIT = { k: { [P]: 2, s: 1 } };

  it('cap 5, qMax 2, 40 → 30 ⇒ ⌊30/2⌋ > 5: NO sibling read, no kit task, no links listing (not direct)', async () => {
    const h = montar({ ambiente: { [TETO_ESTOQUE_ENV_LI]: '5' } });
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: canonico('s') }, 2));
    h.db.seed(caminho('s'), reg(10));
    await tratarEventoEstoqueLi(h.deps, evento(reg(40), reg(30)));
    expect(colecoes(h)).toEqual(['integracao']);
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A)]);
    expect(h.enfileirados).toEqual([]);
  });

  it('⚠️ NEAR-MISS: 12 → 10 ⇒ ⌊10/2⌋ = 5 is not above the cap: the sibling is read', async () => {
    const h = montar({ ambiente: { [TETO_ESTOQUE_ENV_LI]: '5' } });
    seedConta(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(KIT, { [P]: E, s: canonico('s') }, 2));
    h.db.seed(caminho('s'), reg(10));
    await tratarEventoEstoqueLi(h.deps, evento(reg(12), reg(10)));
    expect(h.db.leituras).toEqual([cabecalhoPath(CONTA_A), caminho('s')]);
  });
});

/* -------------------------------------------------------------------------- */
/*                           The clock and the names                            */
/* -------------------------------------------------------------------------- */

describe('the clock is read AFTER every read, inside each enqueue', () => {
  it('every clock read sees every read already made; the window is the one AFTER the reads', async () => {
    let agora = T0;
    const leiturasAoLerORelogio: number[] = [];
    const h = montar({
      agora: () => {
        leiturasAoLerORelogio.push(h.db.leituras.length + h.db.consultas.length);
        return agora;
      },
    });
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    seedCabecalho(
      h.db,
      CONTA_A,
      cabecalhoEmLinha({ k: { [P]: 1, s: 1 } }, { [P]: E, s: canonico('s') }),
    );
    h.db.seed(caminho('s'), reg(10));
    // The links listing is answered one minute later than the event arrived.
    h.db.antesDaProximaConsulta(LISTAGEM, () => {
      agora = T0 + 60_000;
    });

    await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    const total = h.db.leituras.length + h.db.consultas.length;
    expect(total).toBe(4); // contas query, links listing, header, sibling
    expect(leiturasAoLerORelogio).toEqual([total, total]);
    expect(h.enfileirados).toHaveLength(2);
    for (const { tarefa, opcoes } of h.enfileirados) {
      expect(tarefa.janela).toBe(JANELA + 1);
      expect(opcoes.agendarParaMs).toBeGreaterThanOrEqual((JANELA + 3) * 60_000);
    }
  });
});

describe('the naming property: an enqueue never meets a task that may already have dispatched', () => {
  /** Cloud Tasks, as far as names go: a name enqueued again is refused; dispatched once due. */
  function cloudTasks(relogio: () => number) {
    const agendadas = new Map<string, number>();
    const perdidas: string[] = [];
    const fila: FilaEstoqueLi = {
      async enqueue(_tarefa, { id, scheduleTime }) {
        const existente = agendadas.get(id);
        if (existente !== undefined) {
          // The event this enqueue carries is LOST when the task already dispatched.
          if (relogio() >= existente) perdidas.push(id);
          throw falhaDoFunctions('task-already-exists', 409);
        }
        agendadas.set(id, scheduleTime.getTime());
      },
    };
    return { fila, agendadas, perdidas };
  }

  it('a late redelivery is named by its PROCESSING window: a NEW task — while event-time naming would hit the dispatched one', async () => {
    let agora = T0;
    const ct = cloudTasks(() => agora);
    const h = montar({
      agora: () => agora,
      agendador: criarAgendadorEstoqueLi({ fila: () => ct.fila, desligado: false }),
    });
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    const ev = evento(reg(5), reg(4));

    await tratarEventoEstoqueLi(h.deps, ev);
    const [primeira] = [...ct.agendadas.entries()];
    expect(primeira).toBeDefined();

    // Five minutes later the first task has dispatched; the same event arrives again.
    agora = T0 + 5 * 60_000;
    expect(agora).toBeGreaterThanOrEqual(primeira?.[1] ?? Number.POSITIVE_INFINITY);
    await tratarEventoEstoqueLi(h.deps, ev);

    expect(ct.agendadas.size).toBe(2);
    expect(ct.perdidas).toEqual([]);

    // ⚠️ NEAR-MISS: a name built from the EVENT's own window is the dispatched task's name.
    const peloEvento = idDaTarefaEstoqueLi(tarefaDireta(CONTA_A, { janela: janelaEstoqueLi(T0) }));
    expect(peloEvento).toBe(primeira?.[0]);
    await expect(
      ct.fila.enqueue(tarefaDireta(CONTA_A), { id: peloEvento, scheduleTime: new Date(agora) }),
    ).rejects.toThrow();
    expect(ct.perdidas).toEqual([peloEvento]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     What a rejection means (the real producer)               */
/* -------------------------------------------------------------------------- */

describe('enqueue rejections, through the REAL producer', () => {
  function filaQue(falha: () => Error | null) {
    const chamadas: { tarefa: TarefaFilaEstoqueLi; id: string }[] = [];
    const fila: FilaEstoqueLi = {
      async enqueue(tarefa, { id }) {
        chamadas.push({ tarefa, id });
        const err = falha();
        if (err !== null) throw err;
      },
    };
    return { fila, chamadas };
  }

  it('an answered task-already-exists is SUCCESS: counted, no warning, no throw', async () => {
    const f = filaQue(() => falhaDoFunctions('task-already-exists', 409));
    const h = montar({
      agendador: criarAgendadorEstoqueLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toMatchObject({
      diretas: 1,
    });
    expect(linhasDe(h, 'WARNING')).toEqual([]);
    expect(linhasDe(h, 'ERROR')).toEqual([]);
  });

  it('the sweep-only valve closed ⇒ ONE WARNING, the remaining rounds never attempted, resolves', async () => {
    const real = criarAgendadorEstoqueLi({
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
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    // Ten kits every one of which flags (the sibling is unknown), plus the direct task: 11 sends.
    const kits = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`kit-${String(i)}`, { [P]: 1, s: 1 }]),
    );
    seedCabecalho(h.db, CONTA_A, cabecalhoEmLinha(kits, { [P]: E, s: null }));

    const r = await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)));

    expect(tentativas).toBe(CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI);
    expect(r).toMatchObject({ tarefasDesligadas: true, diretas: 0, kits: 0 });
    expect(linhasDe(h, 'WARNING')).toHaveLength(1);
    expect(linhasDe(h, 'INFO').some((l) => l[1].includes('enfileirado'))).toBe(false);
  });

  it('a transient Cloud Tasks failure is RETHROWN (Eventarc retries) — and the fan-out is never attempted after a failed send', async () => {
    const f = filaQue(() => falhaDoFunctions('unknown-error', 503));
    const h = montar({
      agendador: criarAgendadorEstoqueLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, CONTA_A);
    seedConta(h.db, CONTA_B);
    seedLink(h.db, CONTA_A);
    seedCabecalho(h.db, CONTA_B, cabecalhoEmFatias());

    await expect(tratarEventoEstoqueLi(h.deps, evento(reg(1), reg(0)))).rejects.toBeInstanceOf(
      LiTarefasTransitoriasError,
    );
    expect(f.chamadas.map((c) => c.tarefa.tipo)).toEqual([TIPO_TAREFA_ESTOQUE_LI.estoque]);
  });

  it('with every send accepted, the fan-out goes LAST', async () => {
    const f = filaQue(() => null);
    const h = montar({
      agendador: criarAgendadorEstoqueLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, CONTA_A);
    seedConta(h.db, CONTA_B);
    seedLink(h.db, CONTA_B);
    seedCabecalho(h.db, CONTA_A, cabecalhoEmFatias());

    expect(await tratarEventoEstoqueLi(h.deps, evento(reg(1), reg(0)))).toMatchObject({
      diretas: 1,
      fanouts: 1,
    });
    expect(f.chamadas.map((c) => [c.tarefa.tipo, c.tarefa.contaId])).toEqual([
      [TIPO_TAREFA_ESTOQUE_LI.estoque, CONTA_B],
      [TIPO_TAREFA_ESTOQUE_LI.estoqueKits, CONTA_A],
    ]);
  });

  it('a payload the strict schema refuses (a conta id outside its grammar) ⇒ ONE WARNING with field names, that task skipped, no throw', async () => {
    const f = filaQue(() => null);
    const h = montar({
      agendador: criarAgendadorEstoqueLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, 'conta.li');
    seedConta(h.db, CONTA_A);
    seedLink(h.db, 'conta.li', { id: 111 });
    seedLink(h.db, CONTA_A, { id: 222 });

    expect(await tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).toMatchObject({
      diretas: 1,
      recusadas: 1,
    });
    expect(f.chamadas.map((c) => c.tarefa.contaId)).toEqual([CONTA_A]);
    expect(linhasDe(h, 'WARNING')).toEqual([
      [
        'WARNING',
        expect.any(String) as unknown as string,
        {
          produtoId: P,
          estoqueId: E,
          contaId: 'conta.li',
          tipoTarefa: 'estoque',
          campos: ['contaId'],
        },
      ],
    ]);
  });

  it('anything else (a broken deploy) is rethrown UNTOUCHED', async () => {
    const quebrado = falhaDoFunctions('permission-denied', 403);
    const f = filaQue(() => quebrado);
    const h = montar({
      agendador: criarAgendadorEstoqueLi({ fila: () => f.fila, desligado: false }),
    });
    seedConta(h.db, CONTA_A);
    seedLink(h.db, CONTA_A);
    await expect(tratarEventoEstoqueLi(h.deps, evento(reg(5), reg(4)))).rejects.toBe(quebrado);
  });
});
