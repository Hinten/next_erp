import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { integracaoCollection } from '@delfrance/data/admin/collections';
import type { DisposicaoIntFrete } from '@delfrance/data/admin/frete';
import { INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import type { DocData } from '../../lib/lojaIntegrada/testing/fakeDb';

/**
 * The step-20 conta trigger's WIRING. What the reconcile DOES is the core's suite
 * (`packages/data/src/admin/frete/intFreteContaSync.test.ts`, which runs the Loja Integrada row
 * through every case), and the real-Firestore positive is `onIntegracaoLojaIntegradaChanged.tasks.test.ts`.
 * What is only testable HERE is what the trigger decides before touching Firestore, which
 * arguments it hands the reconcile, and what it logs.
 *
 * ⚠️ The mock sits on the EFFECT only. `intFreteContaSync` keeps the real binding and swaps just
 * `reconciliarIntFreteDaConta`, so `deveReconciliar` — the gate — is the REAL predicate. A
 * stubbed gate would make every zero-read assertion below pass whatever the trigger did. The
 * Loja Integrada fake cannot model the core's transaction anyway, and this app never spells it.
 *
 * Absences ("nothing happened") are pinned HERE and only here: an emulator cannot prove that a
 * function did nothing.
 *
 * The deployed options shared by every trigger of this codebase (the inherited region, the empty
 * secret set, `retry`, the database, path distinctness) are also walked by `index.test.ts`'s
 * `GATILHOS` loops; the first describe below pins this trigger's own, without `options.ts`.
 */
const core = vi.hoisted(() => ({
  reconciliar: vi.fn<(db: Firestore, integracaoId: string) => Promise<DisposicaoIntFrete>>(),
  /** Every `intFreteContaSync(...)` argument list a module built a binding with. */
  vinculos: [] as unknown[][],
}));
vi.mock('@delfrance/data/admin/frete', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/frete')>();
  return {
    ...real,
    intFreteContaSync: (...args: Parameters<typeof real.intFreteContaSync>) => {
      core.vinculos.push(args);
      return { ...real.intFreteContaSync(...args), reconciliarIntFreteDaConta: core.reconciliar };
    },
  };
});

const DB = { sentinela: 'o db do getDb' } as unknown as Firestore;
const admin = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

/** The depósito arm's producer root (PR 12-g): every enqueue it was handed, recorded. */
const reconcile = vi.hoisted(() => ({
  raiz: vi.fn(),
  enfileirados: [] as { tarefa: unknown; opcoes: unknown }[],
}));
vi.mock('./agendador', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agendador')>();
  return { ...real, criarAgendadorReconcileEstoqueLiDoAmbiente: reconcile.raiz };
});

const { onIntegracaoLojaIntegradaChanged } = await import('./onIntegracaoLojaIntegradaChanged');
const { syncIntFreteLi } = await import('../../lib/lojaIntegrada/frete/intFrete');

/* ---------------------------------- fixtures ------------------------------ */

const CONTA_ID = 'conta-li-1';
const LINHA = '[loja-integrada] onIntegracaoLojaIntegradaChanged';
/** A conta name no log line may carry. */
const NOME = 'Nome de conta que nunca vai ao log';

/** A Loja Integrada conta with every mirrored field present. */
const conta = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.lojaIntegrada,
  nome: NOME,
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  ...over,
});

const contaMl = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.mercadoLivre,
  nome: 'Conta ML',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  ...over,
});

const contaShopee = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.shopee,
  nome: 'Conta Shopee',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  ...over,
});

const DISPOSICAO: DisposicaoIntFrete = {
  action: 'criado',
  intFreteId: `lojaIntegrada-${CONTA_ID}`,
  campos: ['tipo', 'ativo', 'contaLojaIntegradaEnviosOuterRef', 'nome'],
};

type Snap = {
  exists: boolean;
  data: () => DocData;
  updateTime?: { seconds: number; nanoseconds: number };
};
type Evento = {
  data: { before: Snap; after: Snap } | undefined;
  params: { integracaoId: string };
  time: string;
};

/** The after side's commit stamp in every event: 2026-10-15T12:00:00.123456Z. */
const ATUALIZADO_EM = { seconds: 1_760_529_600, nanoseconds: 123_456_000 };

function snap(data: DocData | null): Snap {
  return { exists: data != null, data: () => data ?? {}, updateTime: ATUALIZADO_EM };
}

function disparar(evento: Evento): Promise<unknown> {
  return (onIntegracaoLojaIntegradaChanged as unknown as { run(e: Evento): Promise<unknown> }).run(
    evento,
  );
}

function run(before: DocData | null, after: DocData | null): Promise<unknown> {
  return disparar({
    data: { before: snap(before), after: snap(after) },
    params: { integracaoId: CONTA_ID },
    time: '2026-10-15T12:00:00.000Z',
  });
}

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  reconcile.enfileirados.length = 0;
  reconcile.raiz.mockImplementation(() => ({
    enfileirar: async (tarefa: unknown, opcoes: unknown) => {
      reconcile.enfileirados.push({ tarefa, opcoes });
    },
  }));
  vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
  admin.getDb.mockImplementation(() => DB);
  core.reconciliar.mockResolvedValue(DISPOSICAO);
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  vi.unstubAllEnvs();
});

/** Nothing at all happened: no handle, no reconcile, no line. */
function esperarNadaAconteceu(): void {
  expect(admin.getDb).not.toHaveBeenCalled();
  expect(core.reconciliar).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
}

/** Exactly one reconcile, of this conta, with exactly (db, id). */
function esperarUmaReconciliacao(): void {
  expect(core.reconciliar).toHaveBeenCalledTimes(1);
  expect(core.reconciliar).toHaveBeenCalledWith(DB, CONTA_ID);
}

/* -------------------------------------------------------------------------- */

describe('onIntegracaoLojaIntegradaChanged — the deployed binding', () => {
  it("listens on integracao/{integracaoId} in the NAMED 'default' database, with retry and no region, secret, memory or timeout of its own", () => {
    const endpoint = endpointOf(onIntegracaoLojaIntegradaChanged);
    const gatilho = endpoint.eventTrigger as {
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal so the comparison can never be two
    // derivations agreeing on the wrong collection.
    expect(integracaoCollection.resolvePath({})).toBe('integracao');
    expect(gatilho.eventFilterPathPatterns.document).toBe(
      `${integracaoCollection.resolvePath({})}/{integracaoId}`,
    );
    // Exact equality on the parsed field — the serialized endpoint always holds
    // `"namespace":"(default)"`, so a substring check passes in every case.
    expect(gatilho.eventFilters.database).toBe('default');
    // NEAR-MISS: the sentinel spelling and the absent value, both refused.
    expect(gatilho.eventFilters.database).toBeDefined();
    expect(gatilho.eventFilters.database).not.toBe('(default)');
    expect(gatilho.retry).toBe(true);

    // No per-function knob: the region rides `options.ts`'s global (not imported here, so ANY
    // region on this endpoint would be a literal), and the trigger never calls Loja Integrada,
    // so it binds no secret.
    expect(endpoint.region).toBeUndefined();
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    // Unset, the SDK writes its `RESET_VALUE` sentinel here; a per-function `memory:` /
    // `timeoutSeconds:` would be a NUMBER.
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });

  it('reconciles through the app’s ONE binding: the lojaIntegrada row of VINCULO_INT_FRETE_CONTA and ZERO options', () => {
    // One binding, built once, with exactly ONE argument: an options object (ML's
    // `refTolerante`) would turn on the tolerant scan this channel must never run, and would
    // diverge from the window pass, which binds the same row the same way.
    expect(core.vinculos).toEqual([[VINCULO_INT_FRETE_CONTA.lojaIntegrada]]);
    // And the trigger's reconcile IS that binding's: no second binding was built anywhere.
    expect(syncIntFreteLi.reconciliarIntFreteDaConta).toBe(core.reconciliar);
  });
});

describe('onIntegracaoLojaIntegradaChanged — what reaches the reconcile', () => {
  it('a create calls reconciliar(db, id) with EXACTLY those two arguments', async () => {
    await run(null, conta());

    esperarUmaReconciliacao();
    // No conta snapshot and no event clock: the reconcile re-reads the conta itself, which is
    // what makes a replay unable to roll anything back.
    expect(core.reconciliar.mock.calls[0]).toHaveLength(2);
    expect(admin.getDb).toHaveBeenCalledTimes(1);
  });

  it('a delete reconciles too — the existence check lives in the reconcile, never here', async () => {
    await run(conta(), null);

    esperarUmaReconciliacao();
  });

  it('builds NO binding of its own while handling events — every one reconciles through the module-load binding', async () => {
    // The binding test above reads `vinculos` before any event ran, and this file's mock hands
    // EVERY binding the same reconcile spy — so a second binding built INSIDE the handler (another
    // channel's row, or `{ refTolerante: true }`) would pass every call assertion here. Only the
    // binding count after real events can see it.
    await run(null, conta());
    await run(conta(), conta({ nome: 'Outro nome' }));
    await run(conta(), conta({ tipo: INTEGRACAO_TIPO.shopee }));
    await run(conta(), null);

    expect(core.reconciliar).toHaveBeenCalledTimes(4);
    expect(core.vinculos).toEqual([[VINCULO_INT_FRETE_CONTA.lojaIntegrada]]);
  });

  it.each([
    ['nome', { nome: 'Outro nome' }],
    ['ativo', { ativo: false }],
    ['filialIntegracaoPedidoOuterRef', { filialIntegracaoPedidoOuterRef: 'documents/filiais/f-2' }],
    ['dataCadastro', { dataCadastro: 1_700_000_000_001 }],
  ])('moving %s reconciles', async (_campo, mudanca) => {
    await run(conta(), conta(mudanca));

    esperarUmaReconciliacao();
  });

  it('retyped OUT of Loja Integrada reconciles, with every mirrored field identical', async () => {
    // Only the `ehConta(before) !== ehConta(after)` clause can let this through.
    await run(conta(), conta({ tipo: INTEGRACAO_TIPO.shopee }));

    esperarUmaReconciliacao();
  });

  it('retyped INTO Loja Integrada reconciles, with every mirrored field identical', async () => {
    await run(conta({ tipo: INTEGRACAO_TIPO.shopee }), conta());

    esperarUmaReconciliacao();
  });

  it.each([
    ['a field the freight doc does not mirror', conta(), conta({ tabelasAtacado: ['t-1'] })],
    ['a no-op re-save (or its replay)', conta(), conta()],
  ])(
    'a Loja Integrada write that moves nothing mirrored (%s) costs ZERO reads',
    async (_c, b, a) => {
      await run(b, a);

      esperarNadaAconteceu();
    },
  );

  it.each([
    ['ML created', null, contaMl()],
    ['ML edited', contaMl(), contaMl({ nome: 'Conta ML 2', ativo: false })],
    ['ML deleted', contaMl(), null],
    ['Shopee created', null, contaShopee()],
    ['Shopee deleted', contaShopee(), null],
    // A retype between two OTHER channels never was, and never becomes, ours.
    ['ML → Shopee', contaMl(), contaShopee()],
    // NEAR-MISS on the tipo: the INT enum `3`, never its string.
    ["tipo '3' as a string", null, conta({ tipo: '3' })],
  ])('another channel’s conta (%s) costs ZERO reads', async (_caso, before, after) => {
    await run(before, after);

    esperarNadaAconteceu();
  });

  it('an event with no data at all is a silent no-op', async () => {
    await expect(
      disparar({
        data: undefined,
        params: { integracaoId: CONTA_ID },
        time: '2026-10-15T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    esperarNadaAconteceu();
  });

  it('a reconcile that throws propagates to the Eventarc retry, with no line logged', async () => {
    const falha = Object.assign(new Error('10 ABORTED'), { code: 10 });
    core.reconciliar.mockRejectedValue(falha);

    await expect(run(null, conta())).rejects.toBe(falha);

    expect(info).not.toHaveBeenCalled();
  });
});

describe('onIntegracaoLojaIntegradaChanged — the log line', () => {
  it('logs ONE line: the conta id and the disposition, exactly', async () => {
    await run(null, conta());

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(LINHA, { integracaoId: CONTA_ID, ...DISPOSICAO });
  });

  it.each<[string, DisposicaoIntFrete]>([
    ['atualizado', { action: 'atualizado', intFreteId: 'auto-1', campos: ['nome'] }],
    ['incompleto', { action: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] }],
    ['desativado', { action: 'desativado', intFreteId: 'auto-1', campos: ['ativo'] }],
  ])('carries field NAMES, never the conta’s nome (%s)', async (_acao, disposicao) => {
    core.reconciliar.mockResolvedValue(disposicao);

    await run(conta({ nome: 'Nome antigo' }), conta());

    expect(info).toHaveBeenCalledExactlyOnceWith(LINHA, { integracaoId: CONTA_ID, ...disposicao });
    const linhas = JSON.stringify(info.mock.calls);
    expect(linhas).not.toContain(NOME);
    expect(linhas).not.toContain('Nome antigo');
  });
});

describe('onIntegracaoLojaIntegradaChanged — the DEPÓSITO arm (master plan step 12, PR 12-g)', () => {
  const comDeposito = (ref: unknown, over: DocData = {}) =>
    conta({ depositoOuterRef: ref, ...over });
  const execucao = `estoque-reconcile-deposito-${String(1_760_529_600_123_456)}`;

  it('an UPDATE that re-points the depósito (D1 → D2) enqueues ONE full run, seq 0, at once, named by the after side’s update time — zero reads', async () => {
    await run(comDeposito('documents/depositos/D1'), comDeposito('documents/depositos/D2'));

    expect(reconcile.enfileirados).toEqual([
      {
        tarefa: { tipo: 'estoque-reconcile', execucaoId: execucao, seq: 0 },
        opcoes: { atrasoS: 0 },
      },
    ]);
    // The freight arm sees no mirrored field move: nothing read at all.
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.reconciliar).not.toHaveBeenCalled();
  });

  it('a depósito SET on an existing conta (none → D1) fires too; a redelivery of the same write names the same run', async () => {
    await run(conta(), comDeposito('depositos/D1'));
    await run(conta(), comDeposito('depositos/D1'));
    expect(reconcile.enfileirados.map((e) => e.tarefa)).toEqual([
      { tipo: 'estoque-reconcile', execucaoId: execucao, seq: 0 },
      { tipo: 'estoque-reconcile', execucaoId: execucao, seq: 0 },
    ]);
  });

  it.each([
    [
      '⚠️ a CREATE with a depósito (the nightly run bootstraps it)',
      null,
      comDeposito('documents/depositos/D1'),
    ],
    [
      '⚠️ NEAR-MISS: one depósito in its two spellings',
      comDeposito('documents/depositos/D1'),
      comDeposito('depositos/D1'),
    ],
    ['the depósito removed (D1 → none)', comDeposito('documents/depositos/D1'), conta()],
    ['a delete', comDeposito('documents/depositos/D1'), null],
    [
      'a rename that keeps the depósito',
      comDeposito('depositos/D1'),
      comDeposito('depositos/D1', { nome: 'Outro' }),
    ],
    [
      'an inactive conta after the write',
      comDeposito('depositos/D1'),
      comDeposito('depositos/D2', { ativo: false }),
    ],
    [
      'another channel',
      contaMl({ depositoOuterRef: 'depositos/D1' }),
      contaMl({ depositoOuterRef: 'depositos/D2' }),
    ],
    [
      'retyped out of Loja Integrada',
      comDeposito('depositos/D1'),
      comDeposito('depositos/D2', { tipo: INTEGRACAO_TIPO.shopee }),
    ],
  ])('%s: NOTHING enqueued and nothing read', async (_caso, before, after) => {
    await run(before, after);

    expect(reconcile.enfileirados).toEqual([]);
    expect(reconcile.raiz).not.toHaveBeenCalled();
  });

  it('the stock valve OFF: nothing enqueued, the producer never built, zero reads', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', '');
    await run(comDeposito('depositos/D1'), comDeposito('depositos/D2'));
    expect(reconcile.raiz).not.toHaveBeenCalled();
    expect(admin.getDb).not.toHaveBeenCalled();
  });

  it('both arms on ONE write: the freight doc reconciled AND the run enqueued, independently', async () => {
    await run(comDeposito('depositos/D1'), comDeposito('depositos/D2', { nome: 'Outro nome' }));
    esperarUmaReconciliacao();
    expect(reconcile.enfileirados).toHaveLength(1);
  });

  it('a transient enqueue failure propagates to the Eventarc retry (the name keeps it idempotent)', async () => {
    const falha = new Error('transitória');
    reconcile.raiz.mockImplementation(() => ({
      enfileirar: async () => {
        throw falha;
      },
    }));
    await expect(run(comDeposito('depositos/D1'), comDeposito('depositos/D2'))).rejects.toBe(falha);
  });
});
