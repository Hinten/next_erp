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

type Snap = { exists: boolean; data: () => DocData };
type Evento = {
  data: { before: Snap; after: Snap } | undefined;
  params: { integracaoId: string };
  time: string;
};

function snap(data: DocData | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
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
  admin.getDb.mockImplementation(() => DB);
  core.reconciliar.mockResolvedValue(DISPOSICAO);
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
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
