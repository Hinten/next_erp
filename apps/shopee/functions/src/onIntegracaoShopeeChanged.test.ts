import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { integracaoCollection } from '@delfrance/data/admin/collections';
import type { DisposicaoIntFrete } from '@delfrance/data/admin/frete';
import { INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import type { RedriveSemContaResult } from '../../lib/shopee/notificacoes/notificacao';
import { FakeDb, asDb, grpc, type DocData } from '../../lib/shopee/testing/fakeDb';

/**
 * The step-20 conta trigger's WIRING (reconcile §2.4, tests T36–T45). What the
 * two arms DO has its own coverage — the reconcile in
 * `packages/data/src/admin/frete/intFreteContaSync.test.ts`, the re-drive in
 * `lib/shopee/notificacoes/notificacao.redriveSemConta.test.ts`, the
 * resolvable predicate in `lib/shopee/core/contaCache.test.ts` — so what is
 * only testable HERE is what the trigger decides before touching Firestore,
 * which arguments it hands each arm, and in which order.
 *
 * ⚠️ The mocks sit on the two EFFECTS only. `intFreteContaSync` keeps the real
 * binding and swaps just `reconciliarIntFreteDaConta`, so `deveReconciliar` —
 * the arm-1 gate — is the REAL predicate; `shopIdResolvivel` and
 * `motivoSemConta` stay real (only the re-drive is stubbed). A stubbed gate
 * would make every zero-read assertion below pass whatever the trigger did.
 *
 * `getDb` hands back the shared Shopee `FakeDb`. The reconcile is mocked, so
 * the ONLY reads that can reach it are arm 2's fresh conta re-read — which is
 * what lets `db.opLog` count them exactly.
 *
 * The deployed options shared by every trigger of this codebase (`retry`, the
 * inlined region, the empty secret set, path distinctness) are also walked by
 * `index.test.ts`'s `GATILHOS` loops (T46); T36 pins this trigger's own.
 */
const core = vi.hoisted(() => ({
  reconciliar: vi.fn<(db: Firestore, integracaoId: string) => Promise<DisposicaoIntFrete>>(),
  /** Every `intFreteContaSync(...)` argument list the trigger module built a binding with. */
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

const notif = vi.hoisted(() => ({
  redriveDeferredSemContaForShopId:
    vi.fn<(db: Firestore, shopId: number) => Promise<RedriveSemContaResult>>(),
}));
vi.mock('../../lib/shopee/notificacoes/notificacao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/shopee/notificacoes/notificacao')>();
  return { ...real, ...notif };
});

const admin = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onIntegracaoShopeeChanged } = await import('./onIntegracaoShopeeChanged');

/* ---------------------------------- fixtures ------------------------------ */

const CONTA_ID = 'int-1';
const CONTA_PATH = integracaoCollection.docPath({}, CONTA_ID);
const LOJA = 987654;
const OUTRA_LOJA = 987655;

const LINHA_SYNC = '[shopee] onIntegracaoShopeeChanged';
const LINHA_REDRIVE = '[shopee] conta resolvível — notificações sem-conta reprocessadas';
const LINHA_IGNORADO = '[shopee] redrive ignorado — a conta não resolve mais esta loja';

/**
 * A Shopee conta with every mirrored field present, NOT yet connected: no
 * `shop_id`, so it resolves for no shop and arm 2 never fires on it.
 */
const conta = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.shopee,
  nome: 'Loja Shopee',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  shop_id: null,
  main_account_id: null,
  ...over,
});

/** The same conta once the OAuth callback stamped its shop — resolvable for {@link LOJA}. */
const conectada = (over: DocData = {}): DocData => conta({ shop_id: LOJA, ...over });

/** `conta()` without the `ativo` KEY — absent, not false. */
function semAtivo(over: DocData = {}): DocData {
  const { ativo: _ativo, ...resto } = conta(over);
  return resto;
}

/**
 * A Mercado Livre conta. ⚠️ It carries a `shop_id` equal to {@link LOJA} on
 * purpose: arm 2 must refuse it by `tipo`, not by the absence of the field.
 */
const contaMl = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.mercadoLivre,
  nome: 'Loja ML',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  user_id: 123,
  shop_id: LOJA,
  ...over,
});

const contaWhatsapp = (over: DocData = {}): DocData => ({
  tipo: INTEGRACAO_TIPO.whatsapp,
  nome: 'WhatsApp',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/f-1',
  dataCadastro: 1_700_000_000_000,
  ...over,
});

const DISPOSICAO: DisposicaoIntFrete = {
  action: 'criado',
  intFreteId: 'shopee-int-1',
  campos: ['tipo', 'ativo', 'contaShopeeFreteOuterRef', 'nome'],
};

const NADA_A_MOVER: RedriveSemContaResult = {
  encontradas: 0,
  semConta: 0,
  redirecionadas: 0,
  truncado: false,
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
  return (onIntegracaoShopeeChanged as unknown as { run(e: Evento): Promise<unknown> }).run(evento);
}

function run(before: DocData | null, after: DocData | null): Promise<unknown> {
  return disparar({
    data: { before: snap(before), after: snap(after) },
    params: { integracaoId: CONTA_ID },
    time: '2026-10-13T12:00:00.000Z',
  });
}

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

/** Every read the FakeDb served, as `op path` — the reconcile is mocked, so only arm 2 can read. */
function leituras(): string[] {
  return db.opLog.map((o) => `${o.op} ${o.path}`);
}

let db: FakeDb;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  admin.getDb.mockImplementation(() => asDb(db));
  core.reconciliar.mockResolvedValue(DISPOSICAO);
  notif.redriveDeferredSemContaForShopId.mockResolvedValue(NADA_A_MOVER);
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

/** Nothing at all happened: no handle, no reconcile, no re-drive, no line. */
function esperarNadaAconteceu(): void {
  expect(admin.getDb).not.toHaveBeenCalled();
  expect(core.reconciliar).not.toHaveBeenCalled();
  expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
}

/* -------------------------------------------------------------------------- */

describe('onIntegracaoShopeeChanged — the deployed binding (T36)', () => {
  it('T36: escuta integracao/{integracaoId} no banco NOMEADO default, com retry e sem região/segredo/memória próprios', () => {
    const endpoint = endpointOf(onIntegracaoShopeeChanged);
    const gatilho = endpoint.eventTrigger as {
      eventFilters: Record<string, string>;
      eventFilterPathPatterns: Record<string, string>;
      retry: boolean;
    };

    // Derived from the HANDLE, plus an anchor literal so the comparison can
    // never be two derivations agreeing on the wrong collection.
    expect(integracaoCollection.resolvePath({})).toBe('integracao');
    expect(gatilho.eventFilterPathPatterns.document).toBe(
      `${integracaoCollection.resolvePath({})}/{integracaoId}`,
    );
    // Exact equality on the parsed field — the serialized endpoint always holds
    // `"namespace":"(default)"`, so a substring check passes in every case.
    expect(gatilho.eventFilters.database).toBe('default');
    expect(gatilho.eventFilters.database).not.toBe('(default)');
    expect(gatilho.retry).toBe(true);

    // No per-function knob: the region rides `options.ts`'s global (not
    // imported here, so ANY region on this endpoint would be a literal), and
    // the trigger never calls Shopee, so it binds no secret.
    expect(endpoint.region).toBeUndefined();
    expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    // Unset, the SDK writes its `RESET_VALUE` sentinel here; a per-function
    // `memory:` / `timeoutSeconds:` would be a NUMBER.
    expect(typeof endpoint.availableMemoryMb).not.toBe('number');
    expect(typeof endpoint.timeoutSeconds).not.toBe('number');
  });

  it('T36: amarra o núcleo com a linha shopee de VINCULO_INT_FRETE_CONTA e ZERO opções — a mesma da janela', () => {
    // One binding, built once at module load, with exactly ONE argument: an
    // options object (ML's `refTolerante`) would turn on the tolerant scan the
    // Shopee path must never run, and would diverge from the window pass.
    expect(core.vinculos).toEqual([[VINCULO_INT_FRETE_CONTA.shopee]]);
  });
});

describe('onIntegracaoShopeeChanged — arm 1, the int_frete sync', () => {
  it('T37: uma criação chama reconciliar(db, id) com EXATAMENTE esses dois argumentos', async () => {
    await run(null, conta());

    expect(core.reconciliar).toHaveBeenCalledTimes(1);
    expect(core.reconciliar).toHaveBeenCalledWith(asDb(db), CONTA_ID);
    // No conta snapshot and no event clock: the reconcile re-reads the conta
    // itself, which is what makes a replay unable to roll anything back.
    expect(core.reconciliar.mock.calls[0]).toHaveLength(2);
  });

  it('T37: registra a disposição numa linha, com o integracaoId', async () => {
    await run(null, conta());

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(LINHA_SYNC, { integracaoId: CONTA_ID, ...DISPOSICAO });
  });

  it.each([
    ['nome', { nome: 'Loja Shopee 2' }],
    ['ativo', { ativo: false }],
    ['filialIntegracaoPedidoOuterRef', { filialIntegracaoPedidoOuterRef: 'documents/filiais/f-2' }],
    ['dataCadastro', { dataCadastro: 1_700_000_000_001 }],
  ])('T38: mover %s reconcilia', async (_campo, mudanca) => {
    await run(conta(), conta(mudanca));

    expect(core.reconciliar).toHaveBeenCalledTimes(1);
    expect(core.reconciliar).toHaveBeenCalledWith(asDb(db), CONTA_ID);
  });

  it.each([
    ['tabelasAtacado', conta(), conta({ tabelasAtacado: ['documents/tabelaPrecos/t-1'] })],
    // The OAuth callback's `mergeIfExists({ main_account_id })`.
    ['main_account_id', conta(), conta({ main_account_id: 777 })],
    // A no-op re-save (and a replay of one): before ≡ after.
    ['nada', conectada(), conectada()],
  ])(
    'T38: uma escrita Shopee que só move %s NÃO chama getDb nem reconcilia',
    async (_o, before, after) => {
      await run(before, after);

      esperarNadaAconteceu();
    },
  );

  it.each([
    ['ML criada', null, contaMl()],
    ['ML editada', contaMl(), contaMl({ nome: 'Loja ML 2', ativo: false })],
    ['ML apagada', contaMl(), null],
    ['WhatsApp criada', null, contaWhatsapp()],
    ['WhatsApp editada', contaWhatsapp(), contaWhatsapp({ nome: 'WhatsApp 2' })],
    ['WhatsApp apagada', contaWhatsapp(), null],
    // A tipo edit between two OTHER channels never was, and never becomes, ours.
    ['ML → WhatsApp', contaMl(), contaWhatsapp()],
  ])('T39: conta de outro canal (%s) custa ZERO leituras', async (_caso, before, after) => {
    await run(before, after);

    esperarNadaAconteceu();
    expect(leituras()).toEqual([]);
  });

  it('T40: tipo editado PARA FORA da Shopee reconcilia, mesmo sem nenhum campo espelhado mudar', async () => {
    // Every mirrored field is identical on both sides: only the
    // `ehConta(before) !== ehConta(after)` clause can let this through.
    await run(conta(), conta({ tipo: INTEGRACAO_TIPO.mercadoLivre }));

    expect(core.reconciliar).toHaveBeenCalledWith(asDb(db), CONTA_ID);
  });

  it('T40: tipo editado DE VOLTA para Shopee reconcilia, mesmo sem nenhum campo espelhado mudar', async () => {
    await run(conta({ tipo: INTEGRACAO_TIPO.mercadoLivre }), conta());

    expect(core.reconciliar).toHaveBeenCalledWith(asDb(db), CONTA_ID);
  });

  it('T41: um delete reconcilia e não lê NADA mais — a checagem de existência mora no reconciliar', async () => {
    // A CONNECTED conta on purpose: after a delete `after` is null, so arm 2
    // must stay shut even though `before` resolved.
    await run(conectada(), null);

    expect(core.reconciliar).toHaveBeenCalledTimes(1);
    expect(core.reconciliar).toHaveBeenCalledWith(asDb(db), CONTA_ID);
    expect(leituras()).toEqual([]);
    expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalled();
  });

  it('um evento sem data nenhuma é um no-op silencioso', async () => {
    await expect(
      disparar({
        data: undefined,
        params: { integracaoId: CONTA_ID },
        time: '2026-10-13T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    esperarNadaAconteceu();
  });
});

describe('onIntegracaoShopeeChanged — arm 2, the #808 re-drive', () => {
  it.each([
    ['shop_id null → 987654', conta(), conectada(), LOJA],
    ['ativo false → true', conectada({ ativo: false }), conectada(), LOJA],
    ['uma criação já com shop_id', null, conectada(), LOJA],
    ['X → Y re-drive Y', conectada({ shop_id: OUTRA_LOJA }), conectada(), LOJA],
  ])(
    'T42: dispara em %s, depois de UMA releitura que ainda resolve',
    async (_caso, before, after, loja) => {
      db.seed(CONTA_PATH, after as DocData);

      await run(before, after);

      expect(notif.redriveDeferredSemContaForShopId).toHaveBeenCalledTimes(1);
      // Exactly (db, shopId): the default page/limit, never a caller-chosen one.
      expect(notif.redriveDeferredSemContaForShopId).toHaveBeenCalledWith(asDb(db), loja);
      expect(notif.redriveDeferredSemContaForShopId.mock.calls[0]).toHaveLength(2);
      expect(leituras()).toEqual([`get ${CONTA_PATH}`]);
    },
  );

  it('T42: no X → Y, a loja ANTIGA nunca é re-conduzida', async () => {
    db.seed(CONTA_PATH, conectada({ shop_id: OUTRA_LOJA }));

    await run(conectada(), conectada({ shop_id: OUTRA_LOJA }));

    expect(notif.redriveDeferredSemContaForShopId).toHaveBeenCalledWith(asDb(db), OUTRA_LOJA);
    expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalledWith(asDb(db), LOJA);
  });

  it.each([
    // Already resolvable on both sides: the edge is not in this write.
    [
      'uma edição sem relação numa conta já resolvível',
      conectada(),
      conectada({ nome: 'Outro nome' }),
    ],
    ['um replay da conta já resolvível', conectada(), conectada()],
    ['uma desativação', conectada(), conectada({ ativo: false })],
    ['só o main_account_id', conectada(), conectada({ main_account_id: 777 })],
    // Absent `ativo` reads as NOT resolvable — the receiver's `ativo == true`
    // query excludes it — even though the int_frete mirror reads it as true.
    ['um shop_id que chega com ativo AUSENTE', semAtivo(), semAtivo({ shop_id: LOJA })],
    // ML carries a numeric `shop_id` equal to LOJA, refused by its tipo.
    ['uma conta ML com shop_id', contaMl({ shop_id: null }), contaMl()],
  ])('T43: NÃO dispara em %s — e não relê a conta', async (_caso, before, after) => {
    db.seed(CONTA_PATH, after);

    await run(before, after);

    expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalled();
    // The gate is the PAYLOAD edge: a level check would fire here and only the
    // fresh re-read would stop it — which is a read this write must not cost.
    expect(leituras()).toEqual([]);
    expect(info).not.toHaveBeenCalledWith(LINHA_IGNORADO, expect.anything());
  });

  it.each([
    ['inativa', conectada({ ativo: false })],
    ['apagada', null],
    ['em OUTRA loja', conectada({ shop_id: OUTRA_LOJA })],
    ['movida para outro canal', conectada({ tipo: INTEGRACAO_TIPO.mercadoLivre })],
  ])(
    'T43b: o payload diz resolvível mas a releitura encontra a conta %s ⇒ nada re-conduzido, uma linha',
    async (_caso, atual) => {
      if (atual != null) db.seed(CONTA_PATH, atual);

      // `shop_id` landing: a mirrored-field no-op, so arm 1 stays shut and the
      // ONLY read is arm 2's re-read.
      await run(conta(), conectada());

      expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalled();
      expect(leituras()).toEqual([`get ${CONTA_PATH}`]);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(LINHA_IGNORADO, { integracaoId: CONTA_ID, shopId: LOJA });
    },
  );

  it('T44: quando o re-drive lança, o reconciliar JÁ rodou e o erro sobe para o retry', async () => {
    db.seed(CONTA_PATH, conectada());
    const falha = grpc(14, 'UNAVAILABLE');
    notif.redriveDeferredSemContaForShopId.mockRejectedValue(falha);

    await expect(run(null, conectada())).rejects.toBe(falha);

    // ORDER is what isolates the two arms — not a catch: the load-bearing sync
    // ran first and was not skipped by the latency-only re-drive's failure.
    expect(core.reconciliar).toHaveBeenCalledTimes(1);
    expect(notif.redriveDeferredSemContaForShopId).toHaveBeenCalledTimes(1);
    const [ordemSync] = core.reconciliar.mock.invocationCallOrder;
    const [ordemRedrive] = notif.redriveDeferredSemContaForShopId.mock.invocationCallOrder;
    expect(ordemSync).toBeLessThan(ordemRedrive!);
    expect(info).toHaveBeenCalledWith(LINHA_SYNC, { integracaoId: CONTA_ID, ...DISPOSICAO });
  });

  it('T44: quando o reconciliar lança, o erro sobe — e o re-drive espera o retry', async () => {
    db.seed(CONTA_PATH, conectada());
    const falha = grpc(10, 'ABORTED');
    core.reconciliar.mockRejectedValue(falha);

    await expect(run(null, conectada())).rejects.toBe(falha);

    expect(notif.redriveDeferredSemContaForShopId).not.toHaveBeenCalled();
    expect(leituras()).toEqual([]);
  });

  it('T45: uma escrita que o braço 1 PULA (o shop_id chegando) ainda re-conduz', async () => {
    db.seed(CONTA_PATH, conectada());

    await run(conta(), conectada());

    // A positive gate, never an early `return`: the OAuth stamp moves no
    // mirrored field, and it is exactly the write arm 2 exists for.
    expect(core.reconciliar).not.toHaveBeenCalled();
    expect(notif.redriveDeferredSemContaForShopId).toHaveBeenCalledWith(asDb(db), LOJA);
  });
});

describe('onIntegracaoShopeeChanged — the re-drive log line', () => {
  it('nada sem-conta e nada truncado ⇒ NENHUMA linha', async () => {
    db.seed(CONTA_PATH, conectada());
    notif.redriveDeferredSemContaForShopId.mockResolvedValue({
      encontradas: 4,
      semConta: 0,
      redirecionadas: 0,
      truncado: false,
    });

    await run(conta(), conectada());

    expect(info).not.toHaveBeenCalled();
  });

  it('linhas sem-conta movidas ⇒ UMA linha com os seis campos exatos', async () => {
    db.seed(CONTA_PATH, conectada());
    notif.redriveDeferredSemContaForShopId.mockResolvedValue({
      encontradas: 5,
      semConta: 3,
      redirecionadas: 2,
      truncado: false,
    });

    await run(conta(), conectada());

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(LINHA_REDRIVE, {
      integracaoId: CONTA_ID,
      shopId: LOJA,
      encontradas: 5,
      semConta: 3,
      redirecionadas: 2,
      truncado: false,
    });
  });

  it('sem-conta achadas mas NENHUMA movida ⇒ a linha AINDA sai (o gate é semConta, nunca redirecionadas)', async () => {
    // Every matched row was gone before `mergeIfExists` (a concurrent daily
    // sweep processed and removed it): the line is the only trace that
    // sem-conta rows existed, so it must not be gated on what moved.
    db.seed(CONTA_PATH, conectada());
    notif.redriveDeferredSemContaForShopId.mockResolvedValue({
      encontradas: 2,
      semConta: 2,
      redirecionadas: 0,
      truncado: false,
    });

    await run(conta(), conectada());

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(LINHA_REDRIVE, {
      integracaoId: CONTA_ID,
      shopId: LOJA,
      encontradas: 2,
      semConta: 2,
      redirecionadas: 0,
      truncado: false,
    });
  });

  it('truncado sem nenhuma sem-conta na página ⇒ a linha AINDA sai', async () => {
    db.seed(CONTA_PATH, conectada());
    notif.redriveDeferredSemContaForShopId.mockResolvedValue({
      encontradas: 500,
      semConta: 0,
      redirecionadas: 0,
      truncado: true,
    });

    await run(conta(), conectada());

    expect(info).toHaveBeenCalledWith(LINHA_REDRIVE, {
      integracaoId: CONTA_ID,
      shopId: LOJA,
      encontradas: 500,
      semConta: 0,
      redirecionadas: 0,
      truncado: true,
    });
  });
});
