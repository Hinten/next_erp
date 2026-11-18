/**
 * The stock TRIGGER as deployed (master plan step 12, PR 12-f): what it listens on, which database,
 * with which options — and what one event binds: the LIVE environment, the codebase's Firestore
 * handle and the stock producer's root, the last two LAZILY. The gates themselves are pinned by
 * `lib/lojaIntegrada/estoque/gatilhoEstoque.test.ts`; this file drives the exported function
 * through its `run`, with the two roots mocked. D17: the global `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { estoqueCollection } from '@delfrance/data/admin/collections';
import {
  INTEGRACAO_TIPO,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueLi,
  type TarefaFilaEstoqueLi,
} from '@delfrance/schemas';

import type {
  AgendadorEstoqueLi,
  OpcoesEnfileiramentoEstoqueLi,
} from '../../lib/lojaIntegrada/estoque/agendadorEstoque';
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
vi.mock('./agendadorEstoque', () => ({
  criarAgendadorEstoqueLiDoAmbiente: () => {
    h.agendadores += 1;
    return h.agendador;
  },
}));

const { onEstoqueLojaIntegrada } = await import('./onEstoqueLojaIntegrada');

const CONTA = 'conta-li-gatilho';
const DEP = 'dep-li';
const P = 'p-1';
const E = `est-${P}-${DEP}`;

let fake: FakeDb;
let enfileirados: { tarefa: TarefaFilaEstoqueLi; opcoes: OpcoesEnfileiramentoEstoqueLi }[];

beforeEach(() => {
  __resetAllReadCaches();
  h.dbs = 0;
  h.agendadores = 0;
  fake = new FakeDb();
  h.db = asDb(fake);
  enfileirados = [];
  const agendador: AgendadorEstoqueLi = {
    async enfileirar(tarefa, opcoes) {
      enfileirados.push({ tarefa, opcoes });
    },
  };
  h.agendador = agendador;
  vi.stubGlobal('fetch', () => {
    throw new Error('onEstoqueLojaIntegrada.test: o fetch global não pode ser chamado');
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
  return (onEstoqueLojaIntegrada as unknown as { run(e: unknown): Promise<unknown> }).run({
    data: { before: snap(antes), after: snap(depois) },
    params: { produtoId: P, estoqueId: E },
    time: '2027-01-15T15:00:00.000Z',
  });
}

const reg = (quantidade: number): DocData => ({
  depositoOuterRef: `documents/depositos/${DEP}`,
  quantidade,
  quantidadeReservada: 0,
});

function semear(): void {
  fake.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja',
    ativo: true,
    depositoOuterRef: `depositos/${DEP}`,
  });
  fake.seed(`produtos/${P}/produtolojaintegrada/l1`, {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: 182_904_918,
    paiProdutoIntegradaId: 900_001,
  });
}

describe('onEstoqueLojaIntegrada — the declared options', () => {
  it("listens on WRITES of produtos/{produtoId}/estoques/{estoqueId}, in the NAMED 'default' database, with retry and no region, secret, memory or timeout of its own", () => {
    const endpoint = endpointOf(onEstoqueLojaIntegrada);
    const gatilho = endpoint.eventTrigger as {
      eventType: string;
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal, so the comparison can never be two
    // derivations agreeing on the wrong collection.
    const colecao = estoqueCollection.resolvePath({ produtoId: '{produtoId}' });
    expect(colecao).toBe('produtos/{produtoId}/estoques');
    expect(gatilho.eventFilterPathPatterns.document).toBe(`${colecao}/{estoqueId}`);
    // WRITTEN: a create, an update and a delete all move stock.
    expect(gatilho.eventType).toBe('google.cloud.firestore.document.v1.written');
    expect(gatilho.eventFilters.database).toBe('default');
    expect(gatilho.eventFilters.database).not.toBe('(default)');
    expect(gatilho.retry).toBe(true);

    expect(endpoint.region).toBeUndefined();
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });
});

describe('onEstoqueLojaIntegrada — what one event binds', () => {
  it('the valve is read from the LIVE environment: unset ⇒ neither the db nor the producer is ever built', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', undefined);
    semear();
    expect(await disparar(reg(5), reg(4))).toEqual({ tipo: 'desligado' });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
  });

  it('an irrelevant write (localizacao only) builds nothing, even with the valve open', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
    semear();
    expect(
      await disparar({ ...reg(5), localizacao: 'A' }, { ...reg(5), localizacao: 'B' }),
    ).toEqual({
      tipo: 'irrelevante',
    });
    expect(h.dbs).toBe(0);
    expect(h.agendadores).toBe(0);
  });

  it('dry-run: the event reads through the codebase db and enqueues through the producer root — ids from the PATH', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
    semear();

    await disparar(reg(5), reg(4));

    expect(h.dbs).toBe(1);
    expect(h.agendadores).toBe(1);
    expect(enfileirados.map((e) => e.tarefa)).toEqual([
      expect.objectContaining<Partial<TarefaEstoqueLi>>({
        tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
        contaId: CONTA,
        produtoId: P,
        estoqueId: E,
        apagado: false,
      }),
    ]);
  });

  it('a delete arrives as before-only: apagado', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
    semear();
    await disparar(reg(3), null);
    expect(enfileirados.map((e) => (e.tarefa as TarefaEstoqueLi).apagado)).toEqual([true]);
  });
});
