/**
 * The price TRIGGER as deployed (master plan step 13, PR 13-e): what it listens on, which
 * database, with which options — and what one event binds: the LIVE environment, the codebase's
 * Firestore handle and the price producer's root (the last two LAZILY), the live clock and the
 * functions logger; and that a create and a delete each hand over `null`. The gates themselves are
 * pinned by `lib/lojaIntegrada/preco/gatilhoPreco.test.ts`; this file drives the exported function
 * through its `run`, with the two roots mocked. No call to the store before the cutover: the
 * global `fetch` throws. Every id and price is invented.
 */
import { logger as loggerDoFunctions } from 'firebase-functions/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
} from '@delfrance/schemas';

import {
  type AgendadorPrecoLi,
  type OpcoesEnfileiramentoPrecoLi,
  janelaPrecoLi,
} from '../../lib/lojaIntegrada/preco/agendadorPreco';
import { __reiniciarGatilhoPrecoParaTestes } from '../../lib/lojaIntegrada/preco/gatilhoPreco';
import { FakeDb, asDb, type DocData } from '../../lib/lojaIntegrada/testing/fakeDb';

const h = vi.hoisted(() => ({
  db: null as unknown,
  agendador: null as unknown,
  dbs: 0,
  agendadores: 0,
}));
vi.mock('./lib/admin', () => ({
  getDb: () => {
    h.dbs += 1;
    return h.db;
  },
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendadorPreco', () => ({
  criarAgendadorPrecoLiDoAmbiente: () => {
    h.agendadores += 1;
    return h.agendador;
  },
}));

const { onPrecoLojaIntegrada } = await import('./onPrecoLojaIntegrada');

const VALVULA = 'LOJA_INTEGRADA_MODO_PRECO';
const CONTA = 'conta-li-gatilho-preco';
const TN = 'tab-li-gatilho-preco-normal';
const PAI = 'p-li-gatilho-preco-pai';
/** The produto id comes from the PATH: the payload never names it. */
const P = 'p-li-gatilho-preco-filho';

let fake: FakeDb;
let enfileirados: { tarefa: TarefaPrecoLi; opcoes: OpcoesEnfileiramentoPrecoLi }[];

beforeEach(() => {
  __resetAllReadCaches();
  __reiniciarGatilhoPrecoParaTestes();
  h.dbs = 0;
  h.agendadores = 0;
  fake = new FakeDb();
  h.db = asDb(fake);
  enfileirados = [];
  const agendador: AgendadorPrecoLi = {
    async enfileirar(tarefa, opcoes) {
      enfileirados.push({ tarefa, opcoes });
    },
  };
  h.agendador = agendador;
  vi.stubGlobal('fetch', () => {
    throw new Error('onPrecoLojaIntegrada.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  expect(fake.escritas).toEqual([]);
  __resetAllReadCaches();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

function snap(dados: DocData | null) {
  return { exists: dados !== null, data: () => (dados === null ? undefined : { ...dados }) };
}

function disparar(antes: DocData | null, depois: DocData | null): Promise<unknown> {
  return (onPrecoLojaIntegrada as unknown as { run(e: unknown): Promise<unknown> }).run({
    data: { before: snap(antes), after: snap(depois) },
    params: { produtoId: P },
    time: '2027-01-15T15:00:00.000Z',
  });
}

/** A child of {@link PAI} anchored to {@link CONTA}, its normal entry at `valor`. */
const filho = (valor: number, over: DocData = {}): DocData => ({
  nome: 'Filho inventado',
  paiId: PAI,
  precos: { [TN]: { valor } },
  integracoesComProduto: [CONTA],
  ...over,
});

/** The conta (its normal tabela BARE) and a parent that does NOT propagate. */
function semear(): void {
  fake.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja',
    ativo: true,
    tabelaNormalOuterRef: `listaDePrecos/${TN}`,
  });
  fake.seed(`produtos/${PAI}`, {
    precos: { [TN]: { valor: 33.33 } },
    propagatePriceToChildren: false,
    integracoesComProduto: [CONTA],
  });
}

describe('onPrecoLojaIntegrada — the declared options', () => {
  it("listens on WRITES of produtos/{produtoId}, in the NAMED 'default' database, with retry and no region, secret, instance cap, memory or timeout of its own", () => {
    const endpoint = endpointOf(onPrecoLojaIntegrada);
    const gatilho = endpoint.eventTrigger as {
      eventType: string;
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal, so the comparison can never be two
    // derivations agreeing on the wrong collection.
    const colecao = produtoCollection.resolvePath({});
    expect(colecao).toBe('produtos');
    expect(gatilho.eventFilterPathPatterns.document).toBe(`${colecao}/{produtoId}`);
    // WRITTEN: an update is what can move a price (a create and a delete are judged irrelevant
    // by the work, at zero reads — never by the event filter).
    expect(gatilho.eventType).toBe('google.cloud.firestore.document.v1.written');
    expect(gatilho.eventFilters.database).toBe('default');
    expect(gatilho.eventFilters.database).not.toBe('(default)');
    expect(gatilho.retry).toBe(true);

    // Inherited from options.ts (not loaded on this bare module): the region, and the
    // codebase's `maxInstances` 10, which `index.test.ts` pins on the analysed export.
    expect(endpoint.region).toBeUndefined();
    expect(typeof endpoint.maxInstances).not.toBe('number');
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });
});

describe('onPrecoLojaIntegrada — what one event binds', () => {
  it('the valve is read from the LIVE environment: unset ⇒ neither the db nor the producer is ever built', async () => {
    vi.stubEnv(VALVULA, undefined);
    semear();
    expect(await disparar(filho(49.99), filho(50))).toEqual({ tipo: 'desligado' });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
  });

  it('an irrelevant write (the name only) builds nothing, even with the valve open', async () => {
    vi.stubEnv(VALVULA, 'dry-run');
    semear();
    expect(await disparar(filho(22.22), filho(22.22, { nome: 'Outro nome' }))).toEqual({
      tipo: 'irrelevante',
    });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
  });

  it('dry-run: a child price move under a non-propagating parent reads through the codebase db and enqueues ONE task through the producer root — the id from the PATH', async () => {
    vi.stubEnv(VALVULA, 'dry-run');
    semear();

    const r = await disparar(filho(49.99), filho(50));

    expect(r).toMatchObject({ tipo: 'processado', caminho: 'filho', leiturasDoPai: 1 });
    expect(h.dbs).toBe(1);
    expect(h.agendadores).toBe(1);
    expect(enfileirados.map((e) => e.tarefa)).toEqual([
      expect.objectContaining<Partial<TarefaPrecoLi>>({
        tipo: TIPO_TAREFA_PRECO_LI,
        contaId: CONTA,
        produtoId: P,
        origem: ORIGEM_TAREFA_PRECO_LI.evento,
        geracao: 0,
        baixar: true,
      }),
    ]);
  });

  it('a delete arrives as before-only: irrelevant, nothing built', async () => {
    vi.stubEnv(VALVULA, 'dry-run');
    semear();
    expect(await disparar(filho(49.99), null)).toEqual({ tipo: 'irrelevante' });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
  });

  it('a create arrives as after-only: irrelevant, nothing built — its absent before side is null, never an empty object', async () => {
    vi.stubEnv(VALVULA, 'dry-run');
    semear();
    // A create naming a parent, a price and an anchored conta: relevant (a parent move) if the
    // missing before side were read as an empty object.
    expect(await disparar(null, filho(50))).toEqual({ tipo: 'irrelevante' });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
    expect(enfileirados).toEqual([]);
  });

  it('the clock is the LIVE Date.now(): the task is named by the window of the moment it was enqueued', async () => {
    vi.stubEnv(VALVULA, 'dry-run');
    semear();
    const antes = Date.now();
    await disparar(filho(49.99), filho(50));
    const depois = Date.now();
    const janelas = enfileirados.map((e) => e.tarefa.janela);
    expect(janelas).toHaveLength(1);
    expect(janelas[0]).toBeGreaterThanOrEqual(janelaPrecoLi(antes));
    expect(janelas[0]).toBeLessThanOrEqual(janelaPrecoLi(depois));
  });

  it('the event’s lines go to the functions logger: ONE INFO "decidido" for a processed event, nothing else', async () => {
    const info = vi.spyOn(loggerDoFunctions, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(loggerDoFunctions, 'warn').mockImplementation(() => undefined);
    try {
      vi.stubEnv(VALVULA, 'dry-run');
      semear();
      await disparar(filho(49.99), filho(50));
      expect(info.mock.calls.map((c) => c[0])).toEqual(['[loja-integrada/preco] gatilho decidido']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('the live environment is read PER EVENT: a value set after the module loaded takes effect, both ways', async () => {
    semear();
    vi.stubEnv(VALVULA, 'dry-run');
    expect(await disparar(filho(49.99), filho(50))).toMatchObject({ tipo: 'processado' });
    expect(enfileirados).toHaveLength(1);

    // NEAR-MISS: the same event once the valve is off again returns before any read.
    vi.stubEnv(VALVULA, 'off');
    const dbsAntes = h.dbs;
    expect(await disparar(filho(49.99), filho(50))).toEqual({ tipo: 'desligado' });
    expect(h.dbs).toBe(dbsAntes);
    expect(enfileirados).toHaveLength(1);
  });
});
