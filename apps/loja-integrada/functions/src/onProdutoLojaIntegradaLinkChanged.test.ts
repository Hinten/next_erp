import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb, type DocData } from '../../lib/lojaIntegrada/testing/fakeDb';

/**
 * The anchor trigger's WIRING (master plan step 9, PR 9-v). What the writes do is the core's suite
 * (`packages/data/src/admin/produtos/integracoesComProduto.test.ts`) and the binding's
 * (`lib/lojaIntegrada/produtos/integracoesComProdutoLi.test.ts`); the real-Firestore positives are
 * `onProdutoLojaIntegradaLinkChanged.tasks.test.ts`. What is only testable HERE is what the
 * trigger decides BEFORE touching Firestore, which arguments it hands the writes, and what it
 * logs.
 *
 * ⚠️ The mock sits on the PROMOTED CORE's two writers, never on the binding: `planLinkChange`,
 * `contaIdFromRef` and `vinculoLiConta` stay REAL — they are the trigger's free gate, and a stub
 * would make every zero-read assertion below pass whatever the trigger did — and the binding's
 * wrappers stay real too, so these assertions also prove what they bind.
 *
 * Absences ("nothing happened") are pinned HERE and only here: an emulator cannot prove that a
 * function did nothing. The deployed options shared by every trigger of this codebase are also
 * walked by `index.test.ts`'s `GATILHOS` loops; the first describe pins this trigger's own.
 */
const core = vi.hoisted(() => ({
  adicionarConta: vi.fn(async () => true),
  removerContaSeOrfa: vi.fn(async () => true),
}));
vi.mock('@delfrance/data/admin/produtos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/produtos')>();
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onProdutoLojaIntegradaLinkChanged } = await import('./onProdutoLojaIntegradaLinkChanged');

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'produto-li-1';
const LINK = '182904918';
const C1 = 'C1';
const C2 = 'C2';
/** The spec's public example produto id. */
const ID_LI = 182904918;
const ADD = '[loja-integrada] onProdutoLojaIntegradaLinkChanged add';
const CHECK = '[loja-integrada] onProdutoLojaIntegradaLinkChanged check';
/** Link values no log line may carry. */
const SKU = 'SKU-QUE-NUNCA-VAI-AO-LOG';
const NOME = 'Nome que nunca vai ao log';

/** A counting link of conta {@link C1}: a store product id, not in the trash. */
function link(over: DocData = {}): DocData {
  return {
    contaLojaIntegrada: `documents/integracao/${C1}`,
    id: ID_LI,
    sku: SKU,
    nome: NOME,
    ativo: true,
    bloqueado: false,
    removido: false,
    ...over,
  };
}

type Snap = { exists: boolean; data: () => DocData };
type Evento = {
  data: { before: Snap; after: Snap } | undefined;
  params: { produtoId: string; linkId: string };
  time: string;
};

function snap(data: DocData | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function disparar(evento: Evento): Promise<unknown> {
  return (onProdutoLojaIntegradaLinkChanged as unknown as { run(e: Evento): Promise<unknown> }).run(
    evento,
  );
}

function run(antes: DocData | null, depois: DocData | null): Promise<unknown> {
  return disparar({
    data: { before: snap(antes), after: snap(depois) },
    params: { produtoId: PRODUTO, linkId: LINK },
    time: '2026-11-04T12:00:00.000Z',
  });
}

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

/**
 * A handle that THROWS on any touch — handed out by `getDb` in the zero-read cases, so a read
 * slipped in anywhere fails the test even if it bypassed the `getDb` call count.
 */
const DB_PROIBIDO = new Proxy(
  {},
  {
    get(_alvo, prop) {
      throw new Error(`teste: o caminho de custo zero tocou o Firestore (${String(prop)})`);
    },
  },
) as Firestore;

/** Both array sentinels, whatever their values — what the binding must hand over. */
const SENTINELAS = {
  arrayUnion: expect.any(Function) as unknown,
  arrayRemove: expect.any(Function) as unknown,
};

/** A read-only `tx`, enough to drive a survivor closure — which only reads. */
function txLeitura(): Transaction {
  return {
    get: (alvo: { get: () => Promise<unknown> }) => alvo.get(),
  } as unknown as Transaction;
}

let fake: FakeDb;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  core.adicionarConta.mockResolvedValue(true);
  core.removerContaSeOrfa.mockResolvedValue(true);
  fake = new FakeDb();
  admin.getDb.mockImplementation(() => asDb(fake));
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

/** Nothing at all happened: no handle, no write, no line. */
function esperarCustoZero(): void {
  expect(admin.getDb).not.toHaveBeenCalled();
  expect(core.adicionarConta).not.toHaveBeenCalled();
  expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
}

/* -------------------------------------------------------------------------- */

describe('onProdutoLojaIntegradaLinkChanged — the deployed binding', () => {
  it("listens on produtos/{produtoId}/produtolojaintegrada/{linkId} in the NAMED 'default' database, with retry and no region, secret, memory or timeout of its own", () => {
    const endpoint = endpointOf(onProdutoLojaIntegradaLinkChanged);
    const gatilho = endpoint.eventTrigger as {
      eventType: string;
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal so the comparison can never be two
    // derivations agreeing on the wrong collection.
    const colecao = produtoLojaIntegradaLinkCollection.resolvePath({ produtoId: '{produtoId}' });
    expect(colecao).toBe('produtos/{produtoId}/produtolojaintegrada');
    expect(gatilho.eventFilterPathPatterns.document).toBe(`${colecao}/{linkId}`);
    // WRITTEN, not created: a removido flip and a delete must reach it too.
    expect(gatilho.eventType).toBe('google.cloud.firestore.document.v1.written');
    // Exact equality on the parsed field — the serialized endpoint always holds
    // `"namespace":"(default)"`, so a substring check passes in every case.
    expect(gatilho.eventFilters.database).toBe('default');
    expect(gatilho.eventFilters.database).not.toBe('(default)');
    expect(gatilho.retry).toBe(true);

    expect(endpoint.region).toBeUndefined();
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });
});

describe('onProdutoLojaIntegradaLinkChanged — the zero-read fast path', () => {
  beforeEach(() => {
    admin.getDb.mockImplementation(() => DB_PROIBIDO);
  });

  it.each([
    ['nome', { nome: 'Outro nome' }],
    ['the mirror fields', { ativo: false, bloqueado: true }],
    ['estadoPublicacao', { estadoPublicacao: 'pa' }],
    [
      'the conta ref rewritten to its other stored form',
      { contaLojaIntegrada: `integracao/${C1}` },
    ],
    ['the id moved to another store product id', { id: ID_LI + 1 }],
  ])('an edit of %s costs ZERO reads and ZERO writes', async (_campo, over) => {
    // THE most valuable assertion in this file. The import refreshes the mirror fields on EVERY
    // run; if the decision were taken after `getDb()`, every one of those would cost a read.
    await run(link(), link(over));

    esperarCustoZero();
  });

  it.each([
    ['in the trash', { removido: true }],
    ['with no store product id', { id: null }],
    ["with a non-canonical id ('07')", { id: '07' }],
    ['with a malformed conta ref', { contaLojaIntegrada: 'documents/categorias/C1' }],
    ['with its conta ref inside an array', { contaLojaIntegrada: [`documents/integracao/${C1}`] }],
    ['with another channel’s field', { contaLojaIntegrada: undefined, contaOuterRef: 'x' }],
  ])('a link created %s counts nothing: ZERO reads', async (_caso, over) => {
    const corpo = Object.fromEntries(Object.entries(link(over)).filter(([, v]) => v !== undefined));
    await run(null, corpo);

    esperarCustoZero();
  });

  it('⛔ an unreadable document never throws — the redelivery cannot get stuck on it', async () => {
    for (const bruto of [
      {},
      { contaLojaIntegrada: null, id: ID_LI },
      { contaLojaIntegrada: 42, id: ID_LI },
      { contaLojaIntegrada: { ref: 'integracao/C1' }, id: ID_LI },
      { contaLojaIntegrada: `documents/integracao/${C1}`, id: { valor: ID_LI } },
    ]) {
      await expect(run(null, bruto)).resolves.toBeUndefined();
      await expect(run(bruto, bruto)).resolves.toBeUndefined();
    }

    esperarCustoZero();
  });

  it('an event with no data at all is a silent no-op', async () => {
    await expect(
      disparar({
        data: undefined,
        params: { produtoId: PRODUTO, linkId: LINK },
        time: '2026-11-04T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    esperarCustoZero();
  });
});

describe('onProdutoLojaIntegradaLinkChanged — what reaches the writes', () => {
  it('a counting link created ADDS its conta to the produto of the PATH', async () => {
    // `produtoId` comes from the event PARAMS: the middle wildcard is the only authority on
    // which produto this subcollection belongs to.
    await run(null, link({ produtoId: 'um-campo-que-nada-le' }));

    expect(admin.getDb).toHaveBeenCalledTimes(1);
    expect(core.adicionarConta).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C1,
      SENTINELAS,
    );
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('a link that stopped counting CHECKS its conta, through THIS binding’s survivor reader', async () => {
    await run(link(), link({ removido: true }));

    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C1,
      expect.any(Function),
      SENTINELAS,
    );

    // ⚠️ And the closure really is the Loja Integrada reader, bound to the path's produto and
    // this conta: `expect.any(Function)` alone would accept one bound to the wrong produto,
    // which would conclude "no survivors" and drop a live conta.
    const [, , , sobrevivem] = core.removerContaSeOrfa.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      (tx: Transaction) => Promise<boolean>,
      unknown,
    ];
    await expect(sobrevivem(txLeitura())).resolves.toBe(false);
    fake.seed(`produtos/${PRODUTO}/produtolojaintegrada/outro`, link());
    await expect(sobrevivem(txLeitura())).resolves.toBe(true);
    expect(fake.consultas.at(-1)).toMatchObject({
      colecao: `produtos/${PRODUTO}/produtolojaintegrada`,
      filtros: [],
    });
  });

  it('a deleted counting link CHECKS the conta it served', async () => {
    await run(link(), null);

    expect(core.removerContaSeOrfa).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C1,
      expect.any(Function),
      SENTINELAS,
    );
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('a conta re-pointed does BOTH: adds the new one, checks the old one — adds first', async () => {
    await run(link(), link({ contaLojaIntegrada: `documents/integracao/${C2}` }));

    expect(core.adicionarConta).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C2,
      SENTINELAS,
    );
    expect(core.removerContaSeOrfa).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C1,
      expect.any(Function),
      SENTINELAS,
    );
    // The over-inclusive order (the docblock's rule-7 paragraph).
    expect(core.adicionarConta.mock.invocationCallOrder[0]).toBeLessThan(
      core.removerContaSeOrfa.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('a link pulled back out of the trash ADDS again', async () => {
    await run(link({ removido: true }), link());

    expect(core.adicionarConta).toHaveBeenCalledExactlyOnceWith(
      asDb(fake),
      PRODUTO,
      C1,
      SENTINELAS,
    );
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('a write that throws propagates to the Eventarc retry, with no line logged', async () => {
    const falha = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    core.adicionarConta.mockRejectedValue(falha);

    await expect(run(null, link())).rejects.toBe(falha);

    expect(info).not.toHaveBeenCalled();
  });
});

describe('onProdutoLojaIntegradaLinkChanged — the log lines', () => {
  it('one line per arm: ids and the outcome, never a link value', async () => {
    core.adicionarConta.mockResolvedValue(false);
    core.removerContaSeOrfa.mockResolvedValue(false);

    await run(link(), link({ contaLojaIntegrada: `documents/integracao/${C2}` }));

    expect(info.mock.calls).toEqual([
      [ADD, { produtoId: PRODUTO, linkId: LINK, contaId: C2, escrito: false }],
      [CHECK, { produtoId: PRODUTO, linkId: LINK, contaId: C1, removido: false }],
    ]);
    const linhas = JSON.stringify(info.mock.calls);
    expect(linhas).not.toContain(SKU);
    expect(linhas).not.toContain(NOME);
  });
});
