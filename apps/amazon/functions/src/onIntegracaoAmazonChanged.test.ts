import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { integracaoCollection } from '@delfrance/data/admin/collections';
import type { DisposicaoIntFrete } from '@delfrance/data/admin/frete';
import { INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import type { DocData } from '../../lib/amazon/testing/fakeDb';
import { espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The step-20 conta trigger's WIRING. What the reconcile DOES is the core's suite
 * (`packages/data/src/admin/frete/intFreteContaSync.test.ts`, which runs the Amazon row through
 * every case), and the real-Firestore positive is `onIntegracaoAmazonChanged.tasks.test.ts`. What
 * is only testable HERE is what the trigger decides before touching Firestore, which arguments it
 * hands the reconcile, and what it logs.
 *
 * ⚠️ The mock sits on the EFFECT only. `intFreteContaSync` keeps the real binding and swaps just
 * `reconciliarIntFreteDaConta`, so `deveReconciliar` — the gate — is the REAL predicate. A stubbed
 * gate would make every zero-read assertion below pass whatever the trigger did.
 *
 * Absences ("nothing happened") are pinned HERE and only here: an emulator cannot prove that a
 * function did nothing.
 *
 * The log goes through the REAL `LOGGER_STDOUT_AMAZON` (the app's one logger), read off stdout,
 * so the line asserted is the line Cloud Logging would receive — after the sink's own narrowing.
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

const { onIntegracaoAmazonChanged } = await import('./onIntegracaoAmazonChanged');
const { syncIntFreteAmazon } = await import('../../lib/amazon/frete/intFrete');

/* ---------------------------------- fixtures ------------------------------ */

const CONTA_ID = 'conta-amz-1';
const MENSAGEM = '[amazon] onIntegracaoAmazonChanged';
/** A conta name no log line may carry. */
const NOME = 'Nome de conta que nunca vai ao log';
const FILIAL = 'documents/filiais/f-sentinela-do-log';

/** An Amazon conta with every mirrored field present. */
const conta = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.amazon,
  nome: NOME,
  ativo: true,
  filialIntegracaoPedidoOuterRef: FILIAL,
  dataCadastro: 1_700_000_000_000,
  ...over,
});

/** Another channel's conta, complete. */
const contaDe = (tipo: number, over: DocData = {}): DocData => ({
  tipo,
  nome: 'Outra conta',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  ...over,
});
const contaMl = (over: DocData = {}) => contaDe(INTEGRACAO_TIPO.mercadoLivre, over);
const contaShopee = (over: DocData = {}) => contaDe(INTEGRACAO_TIPO.shopee, over);
const contaLi = (over: DocData = {}) => contaDe(INTEGRACAO_TIPO.lojaIntegrada, over);

const DISPOSICAO: DisposicaoIntFrete = {
  action: 'criado',
  intFreteId: `amz-${CONTA_ID}`,
  campos: ['tipo', 'ativo', 'contaAmazonContaFreteAmazonOuterRef', 'nome'],
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
  return (onIntegracaoAmazonChanged as unknown as { run(e: Evento): Promise<unknown> }).run(evento);
}

function run(before: DocData | null, after: DocData | null): Promise<unknown> {
  return disparar({
    data: { before: snap(before), after: snap(after) },
    params: { integracaoId: CONTA_ID },
    time: '2026-10-20T12:00:00.000Z',
  });
}

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

let stdout: ReturnType<typeof espiarStdout>;

beforeEach(() => {
  vi.clearAllMocks();
  admin.getDb.mockImplementation(() => DB);
  core.reconciliar.mockResolvedValue(DISPOSICAO);
  stdout = espiarStdout();
});

afterEach(() => {
  stdout.restaurar();
});

/** Every JSON line the app's logger wrote to stdout, parsed. */
function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Nothing at all happened: no handle, no reconcile, no line. */
function esperarNadaAconteceu(): void {
  expect(admin.getDb).not.toHaveBeenCalled();
  expect(core.reconciliar).not.toHaveBeenCalled();
  expect(stdout.linhas()).toEqual([]);
}

/** Exactly one reconcile, of this conta, with exactly (db, id). */
function esperarUmaReconciliacao(): void {
  expect(core.reconciliar).toHaveBeenCalledTimes(1);
  expect(core.reconciliar).toHaveBeenCalledWith(DB, CONTA_ID);
}

/* -------------------------------------------------------------------------- */

describe('onIntegracaoAmazonChanged — the deployed binding', () => {
  it("listens on integracao/{integracaoId} in the NAMED 'default' database, with retry and no region, secret, memory or timeout of its own", () => {
    const endpoint = endpointOf(onIntegracaoAmazonChanged);
    const gatilho = endpoint.eventTrigger as {
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal so the comparison can never be two
    // derivations agreeing on the wrong collection.
    expect(integracaoCollection.resolvePath({})).toBe('integracao');
    expect(gatilho.eventFilterPathPatterns.document).toBe('integracao/{integracaoId}');
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

    // No per-function knob: the region rides `options.ts`'s global (not imported by this file,
    // so ANY region on this endpoint would be a literal), and the trigger never calls Amazon, so
    // it binds no secret.
    expect(endpoint.region).toBeUndefined();
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    // Unset, the SDK writes its `RESET_VALUE` sentinel here; a per-function `memory:` /
    // `timeoutSeconds:` would be a NUMBER.
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });

  it('reconciles through the app’s ONE binding: the amazon row of VINCULO_INT_FRETE_CONTA and ZERO options', () => {
    // One binding, built once at module load, with exactly ONE argument: an options object (ML's
    // `refTolerante`) would turn on the tolerant scan this channel must never run, and would
    // diverge from the window pass, which binds the same row the same way.
    expect(core.vinculos).toEqual([[VINCULO_INT_FRETE_CONTA.amazon]]);
    expect(core.vinculos[0]).toHaveLength(1);
    // And the trigger's reconcile IS that binding's: no second binding was built anywhere.
    expect(syncIntFreteAmazon.reconciliarIntFreteDaConta).toBe(core.reconciliar);
  });
});

describe('onIntegracaoAmazonChanged — what reaches the reconcile', () => {
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
    // channel's row, or `{ refTolerante }`) would pass every call assertion here. Only the
    // binding count after real events can see it.
    await run(null, conta());
    await run(conta(), conta({ nome: 'Outro nome' }));
    await run(conta(), conta({ tipo: INTEGRACAO_TIPO.lojaIntegrada }));
    await run(conta(), null);

    expect(core.reconciliar).toHaveBeenCalledTimes(4);
    expect(core.vinculos).toEqual([[VINCULO_INT_FRETE_CONTA.amazon]]);
  });

  it.each([
    ['nome', { nome: 'Outro nome' }],
    ['ativo', { ativo: false }],
    ['filialIntegracaoPedidoOuterRef', { filialIntegracaoPedidoOuterRef: 'documents/filiais/f-2' }],
    ['dataCadastro', { dataCadastro: 1_700_000_000_001 }],
  ])('NEAR-MISS of the zero-read writes: moving %s reconciles', async (_campo, mudanca) => {
    await run(conta(), conta(mudanca));

    esperarUmaReconciliacao();
  });

  it('retyped OUT of Amazon (8 → 3) reconciles, with every mirrored field identical', async () => {
    // Only the `ehConta(before) !== ehConta(after)` clause can let this through: a gate on the
    // AFTER state alone would never deactivate the freight doc.
    await run(conta(), conta({ tipo: INTEGRACAO_TIPO.lojaIntegrada }));

    esperarUmaReconciliacao();
  });

  it('retyped INTO Amazon (3 → 8) reconciles, with every mirrored field identical', async () => {
    await run(conta({ tipo: INTEGRACAO_TIPO.lojaIntegrada }), conta());

    esperarUmaReconciliacao();
  });

  it.each([
    // The OAuth callback binds the seller to the conta: one field, not mirrored.
    ['the OAuth callback’s seller binding', conta(), conta({ selling_partner_id: 'A1XEMPLO' })],
    ['a save that only restamps ultimaModificacao', conta(), conta({ ultimaModificacao: 2 })],
    ['a cpf_cnpj / idCadIntTran edit', conta(), conta({ cpf_cnpj: '0', idCadIntTran: 'x' })],
    ['a no-op re-save (or its replay)', conta(), conta()],
  ])(
    'an Amazon write that moves nothing mirrored (%s) costs ZERO reads',
    async (_c, before, after) => {
      await run(before, after);

      esperarNadaAconteceu();
    },
  );

  it.each([
    ['ML created', null, contaMl()],
    ['ML edited', contaMl(), contaMl({ nome: 'Conta ML 2', ativo: false })],
    ['ML deleted', contaMl(), null],
    ['Shopee created', null, contaShopee()],
    ['Shopee edited', contaShopee(), contaShopee({ nome: 'Conta Shopee 2' })],
    ['Shopee deleted', contaShopee(), null],
    ['Loja Integrada created', null, contaLi()],
    ['Loja Integrada edited', contaLi(), contaLi({ ativo: false })],
    ['Loja Integrada deleted', contaLi(), null],
    // A retype between two OTHER channels never was, and never becomes, ours.
    ['ML → Shopee', contaMl(), contaShopee()],
    // NEAR-MISS on the tipo: the INT enum `8`, never its string.
    ["tipo '8' as a string, created", null, conta({ tipo: '8' })],
    ["tipo '8' as a string, deleted", conta({ tipo: '8' }), null],
  ])('another channel’s conta (%s) costs ZERO reads', async (_caso, before, after) => {
    await run(before, after);

    esperarNadaAconteceu();
  });

  it('an event with no data at all is a silent no-op', async () => {
    await expect(
      disparar({
        data: undefined,
        params: { integracaoId: CONTA_ID },
        time: '2026-10-20T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    esperarNadaAconteceu();
  });

  it('a reconcile that throws propagates to the Eventarc retry, with no line logged', async () => {
    // A FirebaseError-shaped rejection (gRPC 10 ABORTED): nothing here may swallow it.
    const falha = Object.assign(new Error('10 ABORTED'), { code: 10 });
    core.reconciliar.mockRejectedValue(falha);

    await expect(run(null, conta())).rejects.toBe(falha);

    expect(stdout.linhas()).toEqual([]);
  });
});

describe('onIntegracaoAmazonChanged — the log line', () => {
  it('writes ONE stdout line: the conta in the envelope, the disposition flattened, exactly', async () => {
    await run(null, conta());

    // Exact equality: a disposition spread as-is would write `<nao-primitivo>` for the arrays
    // (and `action` instead of `acao`), and an envelope-less line would lack `conta`.
    expect(linhas()).toEqual([
      {
        acao: 'criado',
        intFreteId: 'amz-conta-amz-1',
        campos: 'tipo,ativo,contaAmazonContaFreteAmazonOuterRef,nome',
        faltando: null,
        evento: 'int-frete',
        conta: 'conta-amz-1',
        severity: 'INFO',
        message: MENSAGEM,
      },
    ]);
  });

  it('`incompleto` is a WARNING, with the missing field NAMES joined', async () => {
    core.reconciliar.mockResolvedValue({
      action: 'incompleto',
      faltando: ['filialIntegracaoPedidoOuterRef', 'dataCadastro'],
    });

    await run(null, conta());

    expect(linhas()).toEqual([
      {
        acao: 'incompleto',
        intFreteId: null,
        campos: null,
        faltando: 'filialIntegracaoPedidoOuterRef,dataCadastro',
        evento: 'int-frete',
        conta: 'conta-amz-1',
        severity: 'WARNING',
        message: MENSAGEM,
      },
    ]);
  });

  it.each<[string, DisposicaoIntFrete]>([
    ['atualizado', { action: 'atualizado', intFreteId: 'amz-conta-amz-1', campos: ['nome'] }],
    ['desativado', { action: 'desativado', intFreteId: 'amz-conta-amz-1', campos: ['ativo'] }],
    ['inalterado', { action: 'inalterado', intFreteId: 'amz-conta-amz-1' }],
    ['nao-encontrado', { action: 'nao-encontrado' }],
  ])('%s is INFO', async (acao, disposicao) => {
    core.reconciliar.mockResolvedValue(disposicao);

    await run(conta({ nome: 'Nome antigo' }), conta());

    expect(linhas()).toEqual([
      expect.objectContaining({ acao, evento: 'int-frete', conta: CONTA_ID, severity: 'INFO' }),
    ]);
  });

  it.each<[string, DisposicaoIntFrete]>([
    ['atualizado', { action: 'atualizado', intFreteId: 'amz-conta-amz-1', campos: ['nome'] }],
    ['incompleto', { action: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] }],
    ['desativado', { action: 'desativado', intFreteId: 'amz-conta-amz-1', campos: ['ativo'] }],
  ])(
    'carries field NAMES, never the conta’s nome or its filial (%s)',
    async (_acao, disposicao) => {
      core.reconciliar.mockResolvedValue(disposicao);

      await run(conta({ nome: 'Nome antigo' }), conta());

      expect(stdout.linhas()).toHaveLength(1);
      const texto = stdout.linhas().join('\n');
      expect(texto).not.toContain(NOME);
      expect(texto).not.toContain('Nome antigo');
      expect(texto).not.toContain(FILIAL);
    },
  );
});
