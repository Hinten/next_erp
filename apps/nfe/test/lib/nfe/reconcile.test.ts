/**
 * Unit tests for `reconcileByRecibo` — the async lote reconcile core.
 *
 * Mocks the Firestore collection handle (`nfev4Collection.groupQuery`), the
 * audit writes (`persistPatch` / `persistPatchUnlessFinal` / `enviNfeCollection`
 * / `buildEnviNFeMsgFromConsulta`) and BOTH SEFAZ consult bindings
 * (`consultarLote`, `consultarSituacaoNFe`), so the test exercises the decision
 * logic in isolation: 105 → still pending, 104+autorizada → recovered, 656 →
 * terminal error (NO retry), the attempt cap → terminal error, and the
 * 104-without-our-protNFe branch (#513) → counted, then ONE consSit for the
 * chave. Since #1654 there is ONE decision per round (`decidirRodadaDoRecibo`):
 * every round that leaves a doc in flight counts on its `retries` — the
 * lote-level non-answers, an `enviando` doc, a recovered 539 included — and a
 * duplicidade, a 106 or a lote-level verdict is resolved by chave; the chain
 * simulations pin that every chain ends on exactly round MAX with a BLOCKING
 * cStat. Every write goes through the guarded `persistPatchUnlessFinal` (rule
 * 7) — a tripwire on every case asserts the plain `persistPatch` is never
 * called — and the race cases run the REAL guard over an in-memory store.
 * #1654 §2c/§2d: a vanished doc, a transient Firestore failure and a failed
 * 539-recovery SOAP call are isolated per doc (and nothing else is), the
 * consSit breaker lives in the caller's `disjuntor` cell so a trip survives a
 * later throw, and a recovered 539 swaps its chave only inside the round's own
 * guarded write.
 * `outcomeFromConsReci`, `outcomeFromRetConsSit`, `applyOutcome`,
 * `classifyCStat`, `markAsLost`, the digest-safe proc stitch and `sefazCallFor`
 * run REAL.
 *
 * Homologação only, and offline: the SOAP bindings are `vi.fn` replacements
 * whose call counts every #513 case pins, and the runtime is a hand-written
 * fail-closed fixture (`tpAmb '2'`, `.invalid` hosts, empty cert/agent, SVC/AN
 * resolvers that throw) — `getNFeRuntime()` is never called, so no `.env.local`
 * can inject a real endpoint. `expectHomologacaoOnly` is a tripwire on top.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/data/admin/collections', () => ({
  nfev4Collection: {
    groupQuery: vi.fn(),
    // Passthroughs for the REAL guarded persist the race cases delegate to.
    parseRead: vi.fn((raw: unknown) => raw),
    parseMerge: vi.fn((raw: unknown) => raw),
  },
  enviNfeMsgCollection: {},
}));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  // BOTH consult bindings are mocked: no case may reach the real transport.
  return { ...actual, consultarLote: vi.fn(), consultarSituacaoNFe: vi.fn() };
});
vi.mock('../../../lib/nfe/orchestrator/sefaz-call', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nfe/orchestrator/sefaz-call')>();
  // A delegating spy: the REAL `sefazCallFor` builds each SefazCall from the
  // fixture runtime, so the tripwire can see what every call was aimed at.
  return { ...actual, sefazCallFor: vi.fn(actual.sefazCallFor) };
});
vi.mock('../../../lib/nfe/orchestrator/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nfe/orchestrator/audit')>();
  return {
    ...actual,
    persistPatch: vi.fn(),
    // The real one would open a transaction on the `{}` fs handle.
    persistPatchUnlessFinal: vi.fn(async () => ({ written: true })),
    enviNfeCollection: vi.fn(() => ({ add: vi.fn() })),
    buildEnviNFeMsgFromConsulta: vi.fn(() => ({})),
    // recoverFrom539 (real) looks the SEFAZ-asserted chave up here; null = "not
    // one we emitted" → markAsLost → terminal error, with no further SEFAZ call.
    findLatestEnviNFeMsgWithNRec: vi.fn(async () => null),
  };
});

import {
  consultarLote,
  consultarSituacaoNFe,
  isBloqueada,
  MAX_RECONCILE_ATTEMPTS,
  NFeConsumoIndevidoError,
  NFeTransportError,
  NFeXmlError,
  NFeXsdValidationError,
  RECONCILE_INDISPONIVEL_DELAY_MS,
  RECONCILE_SWEEP_GRACE_MS,
  type NFeStatePatch,
  type TRetConsSitNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  findLatestEnviNFeMsgWithNRec,
  type GuardedPersistResult,
  type PersistGuard,
  persistPatch,
  persistPatchUnlessFinal,
} from '../../../lib/nfe/orchestrator/audit';
import { NFeOrchestratorError } from '../../../lib/nfe/orchestrator/errors';
import type { DisjuntorConsSit } from '../../../lib/nfe/orchestrator/lote-sem-protocolo';
import {
  reconcileByRecibo,
  type ReconcileLoteResult,
} from '../../../lib/nfe/orchestrator/reconcile';
import { sefazCallFor } from '../../../lib/nfe/orchestrator/sefaz-call';
import type { NFeRuntime } from '../../../lib/nfe/runtime';

const CHAVE = '35260614200166000187550010000000091400000010';
/** CHAVE with only its last digit changed — a near-miss, never "ours". */
const CHAVE_QUASE = '35260614200166000187550010000000091400000011';
/** Another número (nNF 10) of the same emitente/série — a second doc of the lote. */
const CHAVE_B = '35260614200166000187550010000000101400000010';
/** Path of the first seeded doc. */
const DOC = 'pedidos/P1/nfev4/s1';
/** Path of the second seeded doc. */
const DOC_B = 'pedidos/P2/nfev4/s2';
/** RFC 6761 — `.invalid` never resolves, so no request can leave the machine. */
const HOST_INVALIDO = 'sefaz.example.invalid';

/**
 * Fail-closed homologação runtime: every endpoint on a `.invalid` host, an
 * empty cert and agent, and SVC/AN resolvers that throw — even a regressed
 * mock could not reach any SEFAZ, homologação or produção.
 */
function fakeHomologacaoRuntime(): NFeRuntime {
  const url = (svc: string): string => `https://${HOST_INVALIDO}/${svc}`;
  return {
    cert: {} as never,
    agent: {} as never,
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {
      NfeAutorizacao: url('NfeAutorizacao'),
      NfeRetAutorizacao: url('NfeRetAutorizacao'),
      NfeConsultaProtocolo: url('NfeConsultaProtocolo'),
      NfeStatusServico: url('NfeStatusServico'),
      NfeInutilizacao: url('NfeInutilizacao'),
      RecepcaoEvento: url('RecepcaoEvento'),
    },
    svc: () => {
      throw new Error('fakeHomologacaoRuntime: SVC is not reachable from this test');
    },
    an: () => {
      throw new Error('fakeHomologacaoRuntime: AN is not reachable from this test');
    },
    diagnostics: { subjectCommonName: 'TEST', notAfter: '2027-01-01', chainSource: 'test' },
  };
}

const RT = fakeHomologacaoRuntime();

/**
 * Tripwire, not the guarantee: every recorded SEFAZ call was built for
 * homologação at the `.invalid` host — i.e. through `sefazCallFor` from the
 * runtime the code was handed.
 */
function expectHomologacaoOnly(): void {
  const calls = [
    ...vi.mocked(consultarLote).mock.calls.map(([call]) => call),
    ...vi.mocked(consultarSituacaoNFe).mock.calls.map(([call]) => call),
  ];
  for (const call of calls) {
    expect(call.tpAmb).toBe('2');
    expect(new URL(call.url).hostname).toBe(HOST_INVALIDO);
  }
}

/**
 * Seed `groupQuery().where().get()` with in-flight docs of the lote (distinct
 * paths). Returns each doc's path and data, as the query hands them out.
 *
 * With `loja` (an in-memory store's docs), each ref's `set` merges into it —
 * so a write that regressed to the plain `persistPatch`, routed to the real
 * one by the race cases, would land over the concurrent writer's doc there
 * instead of vanishing into a mock.
 */
function seedDocs(
  overs: ReadonlyArray<Record<string, unknown>>,
  loja?: Record<string, Record<string, unknown>>,
): ReadonlyArray<{ readonly path: string; readonly data: Record<string, unknown> }> {
  const seeds = overs.map((over, i) => ({
    path: `pedidos/P${i + 1}/nfev4/s${i + 1}`,
    data: {
      estado: ESTADO_NFE.aguardandoResposta,
      chave: CHAVE,
      nRec: 'REC-1',
      retries: 0,
      xml_assinado: null,
      ...over,
    } as Record<string, unknown>,
  }));
  const docs = seeds.map(({ path, data }) => ({
    ref: {
      path,
      set: async (patch: Record<string, unknown>): Promise<void> => {
        if (loja) loja[path] = { ...loja[path], ...patch };
      },
    },
    data: () => data,
  }));
  vi.mocked(nfev4Collection.groupQuery).mockReturnValue({
    where: () => ({ get: async () => ({ docs }) }),
  } as never);
  return seeds;
}

/** Seed ONE in-flight doc for the lote (at {@link DOC}). */
function seedDoc(over: Record<string, unknown> = {}): void {
  seedDocs([over]);
}

/** Capture the patch persisted (through the guarded persist) for the (single) doc. */
function lastPatch(): NFeStatePatch {
  const calls = vi.mocked(persistPatchUnlessFinal).mock.calls;
  return calls[calls.length - 1]![2];
}

/** One persisted write, from either persist helper. */
interface Escrita {
  readonly via: 'persistPatch' | 'persistPatchUnlessFinal';
  readonly patch: NFeStatePatch;
  readonly extras: Record<string, unknown> | undefined;
}

/**
 * Every write to `path`, in call order — merged from the plain `persistPatch`
 * (patch at arg 1) and the guarded `persistPatchUnlessFinal` (patch at arg 2).
 */
function writesFor(path: string): Escrita[] {
  const plain = vi.mocked(persistPatch).mock;
  const guarded = vi.mocked(persistPatchUnlessFinal).mock;
  const out: Array<Escrita & { readonly ordem: number }> = [];
  plain.calls.forEach(([ref, patch, extras], i) => {
    if (ref.path === path) {
      out.push({ via: 'persistPatch', patch, extras, ordem: plain.invocationCallOrder[i]! });
    }
  });
  guarded.calls.forEach(([, ref, patch, extras], i) => {
    if (ref.path === path) {
      out.push({
        via: 'persistPatchUnlessFinal',
        patch,
        extras,
        ordem: guarded.invocationCallOrder[i]!,
      });
    }
  });
  return out
    .sort((a, b) => a.ordem - b.ordem)
    .map(({ via, patch, extras }) => ({ via, patch, extras }));
}

/** The {@link PersistGuard} of every guarded write to `path`, in call order. */
function guardasFor(path: string): Array<PersistGuard | undefined> {
  return vi
    .mocked(persistPatchUnlessFinal)
    .mock.calls.filter(([, ref]) => ref.path === path)
    .map(([, , , , guard]) => guard);
}

/** The guard of a write decided on the doc as the query read it, at `retries`. */
const guardaDe = (retries: number): PersistGuard => ({
  expectedNRec: 'REC-1',
  expectedRetries: retries,
  requireInFlight: true,
});

/** What the guarded persist reports when a concurrent writer already approved the doc. */
const aprovadaConcorrente: GuardedPersistResult = {
  written: false,
  estadoAtual: ESTADO_NFE.aprovada,
  cStatAtual: '100',
  xMotivoAtual: 'Autorizado o uso da NF-e',
  nRecAtual: null,
};

/**
 * An in-memory nfev4 store behind a fake `runTransaction` — the only seam the
 * REAL `persistPatchUnlessFinal` touches — so a race case can land a
 * concurrent write at an exact await and let the real guard judge it on the
 * transaction's own snapshot.
 */
function lojaEmMemoria(inicial: Record<string, Record<string, unknown>> = {}): {
  readonly fs: never;
  readonly docs: Record<string, Record<string, unknown>>;
} {
  const docs: Record<string, Record<string, unknown>> = {};
  for (const [path, data] of Object.entries(inicial)) docs[path] = { ...data };
  const tx = {
    get: async (ref: { readonly path: string }) => ({
      exists: docs[ref.path] != null,
      data: () => docs[ref.path],
    }),
    set: (ref: { readonly path: string }, data: Record<string, unknown>) => {
      docs[ref.path] = { ...docs[ref.path], ...data };
    },
  };
  const fs = { runTransaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
  return { fs: fs as never, docs };
}

/** One `protNFe` of a `retConsReciNFe` fixture, for `chNFe`. */
function protDoLote(chNFe: string, protCStat: string, xMotivo = `prot ${protCStat}`): unknown {
  return {
    versao: '4.00',
    infProt: {
      tpAmb: '2',
      verAplic: 'TEST',
      chNFe,
      dhRecbto: new Date().toISOString(),
      cStat: protCStat,
      xMotivo,
      nProt: '135000000000000',
      digVal: 'd',
    },
  };
}

/**
 * A `retConsReciNFe` echoing homologação. With `protCStat`, it carries ONE
 * protNFe, for `opts.chNFe` (default CHAVE), whose xMotivo is `opts.xMotivoProt`
 * (default `prot <cStat>`).
 */
function loteRet(
  cStat: string,
  protCStat?: string,
  opts: { chNFe?: string; xMotivoProt?: string } = {},
): unknown {
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    nRec: 'REC-1',
    cStat,
    xMotivo: `motivo ${cStat}`,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    protNFe: protCStat ? [protDoLote(opts.chNFe ?? CHAVE, protCStat, opts.xMotivoProt)] : undefined,
  };
}

/** A processed lote (104) carrying a protNFe 100 for each of `chaves` — and for no other. */
function loteRetComProts(chaves: readonly string[]): unknown {
  return { ...(loteRet('104') as object), protNFe: chaves.map((c) => protDoLote(c, '100')) };
}

/** The chave a 539 fixture asserts SEFAZ holds (`[chNFe:…]`) — not ours. */
const OUTRA_CHAVE = '35260614200166000187550010000000099400000019';

/**
 * 104 lote whose inner protNFe for our chave is a cStat=539 (duplicidade com
 * chave diferente) — xMotivo asserts a DIFFERENT chave via the `[chNFe:...]`
 * marker the recovery parser reads. With `nRecMarcador`, the xMotivo also
 * carries the `[nRec:…]` marker SEFAZ appends (the OTHER chave's receipt).
 */
function loteRet539(opts: { readonly nRecMarcador?: string } = {}): unknown {
  const marcador = opts.nRecMarcador != null ? `[nRec:${opts.nRecMarcador}]` : '';
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    nRec: 'REC-1',
    cStat: '104',
    xMotivo: 'Lote processado',
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    protNFe: [
      {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'TEST',
          chNFe: CHAVE,
          dhRecbto: new Date().toISOString(),
          cStat: '539',
          xMotivo: `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${OUTRA_CHAVE}]${marcador}`,
          nProt: '135000000000000',
          digVal: 'd',
        },
      },
    ],
  };
}

/** A processed lote (104) whose reply carries NO protNFe at all. */
function loteRetSemProt(): unknown {
  return loteRet('104');
}

/**
 * A `retConsSitNFe` echoing homologação (`tpAmb '2'`) for CHAVE. With
 * `protCStat`, it carries a protNFe whose `chNFe` is `opts.chNFe` (default
 * CHAVE) and whose `digVal` is `'d'`.
 */
function consSitRet(
  cStat: string,
  opts: { protCStat?: string; chNFe?: string; xMotivo?: string } = {},
): TRetConsSitNFe {
  const dhRecbto = new Date().toISOString();
  const xMotivo = opts.xMotivo ?? `consSit ${cStat}`;
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat,
    xMotivo,
    cUF: '35',
    dhRecbto,
    chNFe: CHAVE,
    ...(opts.protCStat != null
      ? {
          protNFe: {
            versao: '4.00',
            infProt: {
              tpAmb: '2',
              verAplic: 'TEST',
              chNFe: opts.chNFe ?? CHAVE,
              dhRecbto,
              cStat: opts.protCStat,
              xMotivo,
              nProt: '135000000000001',
              digVal: 'd',
            },
          },
        }
      : {}),
  };
}

/** Stored signed bytes whose DigestValue matches the fixtures' `digVal 'd'`. */
const XML_DIGEST_OK =
  '<NFe><infNFe>…</infNFe><Signature><SignedInfo><Reference>' +
  '<DigestValue>d</DigestValue></Reference></SignedInfo></Signature></NFe>';

const baseArgs = {
  fs: {} as never,
  rt: RT,
  filialId: 'F-1',
  nRec: 'REC-1',
  tpEmis: 1 as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — re-pin the ones cases override.
  // mockReset also drops any unconsumed *Once queue a case left behind.
  vi.mocked(persistPatchUnlessFinal)
    .mockReset()
    .mockImplementation(async () => ({ written: true }));
  // The race cases route it to the real one; never let that leak.
  vi.mocked(persistPatch).mockReset();
  vi.mocked(consultarLote).mockReset();
  vi.mocked(consultarSituacaoNFe).mockReset();
});
afterEach(() => vi.restoreAllMocks());
// Tripwire on EVERY case, the pre-#513 ones included.
afterEach(() => expectHomologacaoOnly());
// Rule 7 tripwire on EVERY case: no write of reconcileByRecibo may bypass the
// guard — the 105 / non-answer / 104-with-protNFe / 539 / cap writes included.
afterEach(() => expect(vi.mocked(persistPatch)).not.toHaveBeenCalled());

describe('reconcileByRecibo', () => {
  it('105 (lote em processamento) → still pending, retries incremented', async () => {
    seedDoc({ retries: 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });
    expect(r.stillPending).toBe(1);
    expect(r.recovered).toBe(0);
    expect(r.errored).toBe(0);
    const patch = lastPatch();
    expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(patch.retries).toBe(2);
  });

  it('104 + protNFe autorizada → recovered (aprovada)', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.recovered).toBe(1);
    expect(r.stillPending).toBe(0);
    expect(lastPatch().estado).toBe(ESTADO_NFE.aprovada);
  });

  it('autorizada + stored bytes with MATCHING digest → proc extras persisted (#396)', async () => {
    seedDoc({
      xml_assinado:
        '<NFe><infNFe>…</infNFe><Signature><SignedInfo><Reference>' +
        '<DigestValue>d</DigestValue></Reference></SignedInfo></Signature></NFe>',
    });
    // loteRet's protNFe carries digVal 'd' — matches the stored DigestValue.
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    const last = writesFor(DOC).at(-1)!;
    // swapAnchorForProc extras present → xml_nfe_proc written, the anchor cleared in the same write
    expect(last.extras).toMatchObject({ xml_assinado: null });
    expect(typeof last.extras!.xml_nfe_proc).toBe('string');
    // The proc/anchor swap rides the guarded write, decided on the doc as read.
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
  });

  it('autorizada + stored bytes with digest MISMATCH → NO proc extras, doc stays aprovada (#396)', async () => {
    seedDoc({
      xml_assinado:
        '<NFe><infNFe>…</infNFe><Signature><SignedInfo><Reference>' +
        '<DigestValue>OTHER</DigestValue></Reference></SignedInfo></Signature></NFe>',
    });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.recovered).toBe(1);
    const last = writesFor(DOC).at(-1)!;
    expect(last.patch.estado).toBe(ESTADO_NFE.aprovada);
    expect(last.extras).toBeUndefined(); // no proc — anchor kept for DistDFe/manual fetch
  });

  it('656 (consumo indevido) → terminal error, NEVER retried — with a BLOCKING cStat 103 (#1654)', async () => {
    seedDoc({ retries: 0 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('656') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.errored).toBe(1);
    expect(r.stillPending).toBe(0); // → caller does NOT re-enqueue
    expect(lastPatch().estado).toBe(ESTADO_NFE.error);
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
    // SEFAZ received this lote (it issued the receipt): the número may be held,
    // so the terminal must block re-emission — 656 itself does not.
    expect(isBloqueada('656')).toBe(false);
    expect(lastPatch().cStat).toBe('103');
    expect(isBloqueada(lastPatch().cStat)).toBe(true);
    expect(lastPatch().xMotivo).toContain('cStat 656: motivo 656');
    expect(lastPatch().xMotivo).toMatch(/verificar manualmente/);
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
  });

  it('105 at the attempt cap → terminal error with a manual-review motivo', async () => {
    // retries already at cap-1; the 105 bump reaches the cap → flip to error.
    seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });
    expect(r.errored).toBe(1);
    expect(r.stillPending).toBe(0);
    const patch = lastPatch();
    expect(patch.estado).toBe(ESTADO_NFE.error);
    expect(patch.xMotivo).toMatch(/verificar manualmente/);
    // The cap's terminal keeps the 105 — a blocking cStat.
    expect(patch.cStat).toBe('105');
    expect(isBloqueada(patch.cStat)).toBe(true);
    expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS - 1)]);
  });

  it('539 (duplicidade, chave not in our audit log) → terminal error, never left aguardandoResposta (#243)', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRet539() as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.errored).toBe(1);
    // The whole point of #243: a 539 must NOT keep re-queuing as still-pending.
    expect(r.stillPending).toBe(0);
    expect(lastPatch().estado).toBe(ESTADO_NFE.error);
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
    // Near-miss of the by-chave duplicidades (#1654): 539 keeps its own
    // recovery and is never consulted by chave.
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
  });

  it('no in-flight docs → noop (idempotent re-delivery)', async () => {
    seedDoc({ estado: ESTADO_NFE.aprovada }); // already terminal → filtered out
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.scanned).toBe(0);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  });
});

describe('reconcileByRecibo — 104 without our protNFe (#513)', () => {
  /** The counted write's xMotivo tail for sighting `k`. */
  const contada = (k: number): RegExp =>
    new RegExp(
      `protNFe desta chave ausente no lote processado nRec REC-1 \\(consulta ${k}/${MAX_RECONCILE_ATTEMPTS}\\)`,
    );

  it('the fixture runtime is fail-closed: the REAL sefazCallFor aims every home service at `.invalid`, SVC/AN throw', async () => {
    const real = await vi.importActual<typeof import('../../../lib/nfe/orchestrator/sefaz-call')>(
      '../../../lib/nfe/orchestrator/sefaz-call',
    );
    for (const service of ['NfeConsultaProtocolo', 'NfeRetAutorizacao'] as const) {
      const call = real.sefazCallFor(RT, 1, service);
      expect(new URL(call.url).hostname.endsWith('.invalid')).toBe(true);
      expect(call.tpAmb).toBe('2');
    }
    for (const url of Object.values(RT.endpoints)) {
      expect(new URL(url).hostname.endsWith('.invalid')).toBe(true);
    }
    // No contingency authorizer is reachable either — not even through routing.
    expect(() => RT.svc('svc-an')).toThrow(/not reachable/);
    expect(() => RT.svc('svc-rs')).toThrow(/not reachable/);
    expect(() => RT.an()).toThrow(/not reachable/);
    expect(() => real.sefazCallFor(RT, 6, 'NfeConsultaProtocolo')).toThrow(/not reachable/);
    expect(() => real.sefazCallFor(RT, 7, 'NfeConsultaProtocolo')).toThrow(/not reachable/);
  });

  it('consSit 100 for the chave → counted write FIRST, then aprovada — both guarded', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    const retSit = consSitRet('100', { protCStat: '100' });
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(retSit);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
    const writes = writesFor(DOC);
    expect(writes.map((w) => w.via)).toEqual([
      'persistPatchUnlessFinal',
      'persistPatchUnlessFinal',
    ]);
    expect(writes[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 1,
    });
    expect(writes[0]!.patch.xMotivo).toMatch(contada(1));
    expect(writes[1]!.patch).toMatchObject({
      estado: ESTADO_NFE.aprovada,
      cStat: '100',
      retries: 0,
    });
    expect(vi.mocked(persistPatch)).not.toHaveBeenCalled();
    // The count is durable BEFORE the SEFAZ call, not merely before the second write.
    expect(vi.mocked(persistPatchUnlessFinal).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(consultarSituacaoNFe).mock.invocationCallOrder[0]!,
    );
    // Rule 7: the counted write re-checks the doc as the query read it
    // (retries 0); the follow-up re-checks the state the counted write left.
    expect(guardasFor(DOC)).toEqual([guardaDe(0), guardaDe(1)]);

    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
      chave: CHAVE,
    });
    expect(vi.mocked(sefazCallFor)).toHaveBeenCalledWith(RT, 1, 'NfeConsultaProtocolo');
    // The consSit round-trip is audited like any other — no receipt on it.
    expect(vi.mocked(buildEnviNFeMsgFromConsulta)).toHaveBeenCalledWith(
      expect.objectContaining({ chave: CHAVE, nRec: null, ret: retSit }),
    );
    // One single-argument log line naming the chave, nRec, cStat and disposition.
    const linha = warn.mock.calls.find(([msg]) => String(msg).includes('consSitNFe'));
    expect(linha).toHaveLength(1);
    expect(linha![0]).toContain(CHAVE);
    expect(linha![0]).toContain('REC-1');
    expect(linha![0]).toContain('cStat 100');
    expect(linha![0]).toContain('resolvida');
    expectHomologacaoOnly();
  });

  it('consSit 100 + stored bytes with MATCHING digest → the aprovada write carries the proc (#396)', async () => {
    seedDoc({ xml_assinado: XML_DIGEST_OK });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

    await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    const writes = writesFor(DOC);
    expect(writes[0]!.extras).toBeUndefined(); // the counted write never carries a proc
    const last = writes.at(-1)!;
    expect(last.patch.estado).toBe(ESTADO_NFE.aprovada);
    expect(last.extras).toMatchObject({ xml_assinado: null });
    expect(typeof last.extras!.xml_nfe_proc).toBe('string');
    expectHomologacaoOnly();
  });

  it('consSit 100 + stored bytes with digest MISMATCH → aprovada WITHOUT proc (#396)', async () => {
    seedDoc({ xml_assinado: XML_DIGEST_OK.replace('>d<', '>OTHER<') });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r.recovered).toBe(1);
    const last = writesFor(DOC).at(-1)!;
    expect(last.patch.estado).toBe(ESTADO_NFE.aprovada);
    expect(last.extras).toBeUndefined(); // anchor kept for a DistDFe/manual fetch
    expectHomologacaoOnly();
  });

  it('consSit 217 (não consta na base) → rejeitada 217 — the número is free, the pedido re-emittable', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    // A rejeitada tallies as recovered (terminal, non-error) — as before #513.
    expect(r).toMatchObject({ recovered: 1, stillPending: 0, errored: 0 });
    const last = writesFor(DOC).at(-1)!;
    expect(last.via).toBe('persistPatchUnlessFinal');
    expect(last.patch).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '217' });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expectHomologacaoOnly();
  });

  it.each(['562', '561', '613', '252'])(
    'consSit %s (no usable answer) → terminal error KEEPING cStat 104, motivo names the consSit',
    async (cStat) => {
      const OUTRA = '35260614200166000187550010000000091400000028';
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      const xMotivo =
        cStat === '562'
          ? `Rejeicao: Codigo Numerico informado na Chave de Acesso difere do Codigo Numerico da NF-e [chNFe:${OUTRA}]`
          : `Rejeicao ${cStat}`;
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet(cStat, { xMotivo }));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ errored: 1, stillPending: 0, recovered: 0 });
      const writes = writesFor(DOC);
      expect(writes.map((w) => w.patch.estado)).toEqual([
        ESTADO_NFE.aguardandoResposta,
        ESTADO_NFE.error,
      ]);
      const last = writes.at(-1)!;
      expect(last.via).toBe('persistPatchUnlessFinal');
      // 104 stays: it is in STATUS_BLOQUEADORES, so the pedido cannot be
      // re-emitted over a número SEFAZ may hold under another chave.
      expect(last.patch.cStat).toBe('104');
      expect(last.patch.xMotivo).toContain('protNFe desta chave ausente no lote processado');
      expect(last.patch.xMotivo).toContain(`cStat ${cStat}`);
      expect(last.patch.xMotivo).toContain(xMotivo); // 562 keeps its [chNFe:…]
      expect(last.patch.xMotivo).toMatch(/verificar manualmente/);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    },
  );

  it('consSit 110 (denegada) → rejeitada 110 — parity with every other consSit path', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('110', { protCStat: '110' }));

    await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    const last = writesFor(DOC).at(-1)!;
    expect(last.patch).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '110' });
    expectHomologacaoOnly();
  });

  it('consSit whose protNFe names ANOTHER chave (last digit) → terminal "outra chave", never aprovada', async () => {
    seedDoc({ xml_assinado: XML_DIGEST_OK });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100', chNFe: CHAVE_QUASE }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ errored: 1, recovered: 0, stillPending: 0 });
    const writes = writesFor(DOC);
    expect(writes.some((w) => w.patch.estado === ESTADO_NFE.aprovada)).toBe(false);
    expect(writes.every((w) => w.extras === undefined)).toBe(true); // no proc
    const last = writes.at(-1)!;
    expect(last.patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
    expect(last.patch.xMotivo).toMatch(/outra chave/);
    expect(last.patch.xMotivo).toContain(CHAVE_QUASE);
    expectHomologacaoOnly();
  });

  it('consSit 108 UNDER the cap → exactly one (counted) write, still pending', async () => {
    seedDoc({ retries: 2 });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

    expect(r).toMatchObject({ stillPending: 1, recovered: 0, errored: 0 });
    const writes = writesFor(DOC);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.via).toBe('persistPatchUnlessFinal');
    expect(writes[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 3,
    });
    expect(writes[0]!.patch.xMotivo).toMatch(contada(3));
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expectHomologacaoOnly();
  });

  it('consSit 108 AT the cap → counted to MAX, then terminal "após N consultas"', async () => {
    seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

    expect(r).toMatchObject({ errored: 1, stillPending: 0, recovered: 0 });
    const writes = writesFor(DOC);
    expect(writes.map((w) => [w.patch.estado, w.patch.retries])).toEqual([
      [ESTADO_NFE.aguardandoResposta, MAX_RECONCILE_ATTEMPTS],
      [ESTADO_NFE.error, MAX_RECONCILE_ATTEMPTS],
    ]);
    const last = writes.at(-1)!;
    expect(last.patch.cStat).toBe('104');
    expect(last.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
    expect(last.patch.xMotivo).toContain('cStat 108');
    expect(last.patch.xMotivo).toMatch(/verificar manualmente/);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(guardasFor(DOC)).toEqual([
      guardaDe(MAX_RECONCILE_ATTEMPTS - 1),
      guardaDe(MAX_RECONCILE_ATTEMPTS),
    ]);
    expectHomologacaoOnly();
  });

  it('PAST the cap (a previous at-cap consSit threw) → terminal with NO consSit call', async () => {
    seedDoc({ retries: MAX_RECONCILE_ATTEMPTS });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);

    const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS });

    expect(r).toMatchObject({ errored: 1, stillPending: 0, recovered: 0 });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    const writes = writesFor(DOC);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.via).toBe('persistPatchUnlessFinal');
    expect(writes[0]!.patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
    expect(writes[0]!.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
    expect(writes[0]!.patch.xMotivo).toMatch(/verificar manualmente/);
    // No counted write precedes it, so it re-checks the doc as the query read it.
    expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS)]);
    expectHomologacaoOnly();
  });

  it('counter RESET: a later 104 that carries our protNFe → aprovada, retries 0, no consSit', async () => {
    seedDoc({ retries: 5 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 5 });

    expect(r.recovered).toBe(1);
    expect(lastPatch()).toMatchObject({ estado: ESTADO_NFE.aprovada, retries: 0 });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    // ONE write — the aprovada — guarded on the retries it was decided from.
    expect(guardasFor(DOC)).toEqual([guardaDe(5)]);
    expectHomologacaoOnly();
  });

  it('SHARED counter: a 104-without-our-protNFe round and a 105 round advance the same retries', async () => {
    // Round 1: 104 without our prot + consSit 108 → counted 5 → 6.
    seedDoc({ retries: 5 });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));
    await reconcileByRecibo({ ...baseArgs, attempt: 5 });
    const round1 = writesFor(DOC).at(-1)!.patch;
    expect(round1.retries).toBe(6);
    expectHomologacaoOnly(); // before the clear below drops round 1's calls

    // Round 2, re-seeded from round 1's write: a 105 → 6 → 7, the unchanged path.
    vi.clearAllMocks();
    seedDoc({ estado: round1.estado, retries: round1.retries });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 6 });

    expect(r.stillPending).toBe(1);
    expect(lastPatch()).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 7 });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expectHomologacaoOnly();
  });

  /** The xMotivo tail of a counted lote-level non-answer on round `k` (#1654). */
  const semResposta = (k: number): RegExp =>
    new RegExp(
      `sem resposta para a chave no recibo REC-1 \\(consulta ${k}/${MAX_RECONCILE_ATTEMPTS}\\)`,
    );

  // REWRITTEN on purpose (#1654). Under #513 this case pinned the OPPOSITE: a
  // lote-level non-answer kept `retries` as read — which is what let a pure
  // 106/108 chain run forever. Now every in-flight round counts; 106 left the
  // table, since a lote não localizado is resolved by chave (see below).
  it.each(['103', '107', '108', '109', '113', '114'])(
    'lote-level %s (no answer about the chave) COUNTS the round: retries+1, no consSit (#1654)',
    async (cStat) => {
      seedDoc({ retries: 4 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 4 });

      expect(r.stillPending).toBe(1);
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
      expect(lastPatch()).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat,
        retries: 5,
      });
      expect(lastPatch().xMotivo).toMatch(semResposta(5));
      expect(guardasFor(DOC)).toEqual([guardaDe(4)]);
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    },
  );

  // REWRITTEN on purpose (#1654). Under #513 this block pinned that a lote-level
  // non-answer NEVER tripped the cap (its terminal would have carried the
  // non-blocking cStat), so a doc at MAX stayed in flight AT MAX. The terminal
  // now carries a BLOCKING cStat (the round's own 103/104/105, else 103 — SEFAZ
  // issued this receipt), with the real cStat in xMotivo, so the cap applies to
  // every in-flight round.
  describe('a lote-level non-answer counts like any in-flight round — the cap ends it with a BLOCKING cStat (#1654)', () => {
    /**
     * The state an INTERRUPTED at-cap round leaves: its counted write (retries
     * MAX, cStat 104) landed, then the consSit threw something not narrowed or
     * the function timed out.
     */
    const interrompidaNoLimite = {
      retries: MAX_RECONCILE_ATTEMPTS,
      cStat: '104',
      xMotivo: `motivo 104 | protNFe desta chave ausente no lote processado nRec REC-1 (consulta ${MAX_RECONCILE_ATTEMPTS}/${MAX_RECONCILE_ATTEMPTS})`,
    };

    it.each(['108', '107', '109', '113', '114'])(
      'retries MAX-1 + lote %s → terminal on round MAX: error, cStat 103 (blocking), the real cStat in xMotivo, no consSit',
      async (cStat) => {
        seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

        expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
        const patch = lastPatch();
        expect(patch).toMatchObject({
          estado: ESTADO_NFE.error,
          cStat: '103',
          retries: MAX_RECONCILE_ATTEMPTS,
        });
        // Why the cStat is converted: this one does not block a re-emission
        // over the número SEFAZ may already hold.
        expect(isBloqueada(cStat)).toBe(false);
        expect(isBloqueada(patch.cStat)).toBe(true);
        expect(patch.xMotivo).toContain(`cStat ${cStat}: motivo ${cStat}`);
        expect(patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
        expect(patch.xMotivo).toMatch(/verificar manualmente/);
        expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS - 1)]);
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        expectHomologacaoOnly();
      },
    );

    it('retries MAX-1 + lote 103 → terminal KEEPING cStat 103 — already blocking, so no prefix', async () => {
      seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('103') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

      expect(r).toMatchObject({ stillPending: 0, errored: 1 });
      const patch = lastPatch();
      expect(patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '103' });
      expect(patch.xMotivo.startsWith('motivo 103 | ')).toBe(true);
      expect(patch.xMotivo).not.toMatch(/cStat 103:/);
      expectHomologacaoOnly();
    });

    it.each(['108', '106'])(
      'an INTERRUPTED at-cap round (retries MAX) + lote %s → terminal at once, retries MAX+1, cStat 103, NO consSit',
      async (cStat) => {
        seedDoc(interrompidaNoLimite);
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

        const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS });

        expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        const escritas = writesFor(DOC);
        expect(escritas).toHaveLength(1);
        expect(escritas[0]!.patch).toMatchObject({
          estado: ESTADO_NFE.error,
          cStat: '103',
          retries: MAX_RECONCILE_ATTEMPTS + 1,
        });
        expect(escritas[0]!.patch.xMotivo).toContain(`cStat ${cStat}:`);
        expect(escritas[0]!.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
        // No counted write precedes it: it re-checks the doc as the query read it.
        expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS)]);
        expectHomologacaoOnly();
      },
    );

    it('near-miss: retries MAX-2 + lote 108 → counted to MAX-1, still pending — no terminal before the cap', async () => {
      seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 2 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('108') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 2 });

      expect(r).toMatchObject({ stillPending: 1, errored: 0 });
      expect(lastPatch()).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '108',
        retries: MAX_RECONCILE_ATTEMPTS - 1,
      });
      expect(lastPatch().xMotivo).not.toMatch(/verificar manualmente/);
      expectHomologacaoOnly();
    });

    it('a 105 on the interrupted at-cap state still ends with cStat 105 and today’s text — unchanged', async () => {
      seedDoc(interrompidaNoLimite);
      vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS });

      expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      const terminal = lastPatch();
      expect(terminal).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '105',
        retries: MAX_RECONCILE_ATTEMPTS + 1,
        xMotivo: `motivo 105 | lote não processado após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`,
      });
      expect(isBloqueada(terminal.cStat)).toBe(true);
      expectHomologacaoOnly();
    });
  });

  describe('byte-identity of the paths #513 must not touch — the SAME patch, now through the guarded persist', () => {
    /** The single guarded write of the case: [fs, ref, patch, extras, guard]. */
    function unicaGravacaoGuardada(): Parameters<typeof persistPatchUnlessFinal> {
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
      return vi.mocked(persistPatchUnlessFinal).mock.calls[0]!;
    }

    it('105 → the full pre-#513 patch, guarded on the retries as read', async () => {
      seedDoc({ retries: 1 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);

      await reconcileByRecibo({ ...baseArgs, attempt: 1 });

      const [, ref, patch, extras, guard] = unicaGravacaoGuardada();
      expect(ref.path).toBe(DOC);
      expect(patch).toEqual({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '105',
        xMotivo: 'motivo 105',
        retries: 2,
        nRec: 'REC-1',
        action: 'poll-lote',
        tMed: null,
      });
      expect(extras).toBeUndefined();
      expect(guard).toEqual(guardaDe(1));
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    });

    it('104 + our protNFe 100 → the full pre-#513 aprovada patch, guarded on the retries as read', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);

      await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      const [, ref, patch, extras, guard] = unicaGravacaoGuardada();
      expect(ref.path).toBe(DOC);
      expect(patch).toEqual({
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        xMotivo: 'prot 100',
        retries: 0,
        nRec: null,
        action: 'done-authorized',
        tMed: null,
      });
      expect(extras).toBeUndefined(); // xml_assinado null → no proc to stitch
      expect(guard).toEqual(guardaDe(0));
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    });

    it('104 + our protNFe 100 + matching stored bytes → the same patch AND the proc/anchor swap, in ONE guarded write', async () => {
      seedDoc({ retries: 3, xml_assinado: XML_DIGEST_OK });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);

      await reconcileByRecibo({ ...baseArgs, attempt: 3 });

      const [, ref, patch, extras, guard] = unicaGravacaoGuardada();
      expect(ref.path).toBe(DOC);
      expect(patch).toEqual({
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        xMotivo: 'prot 100',
        retries: 0,
        nRec: null,
        action: 'done-authorized',
        tMed: null,
      });
      // Rule 1 of apps/nfe: the anchor is cleared in the SAME write that
      // persists the proc embedding it — never apart from it.
      expect(extras).toMatchObject({ xml_assinado: null });
      expect(extras!.xml_nfe_proc).toEqual(expect.stringContaining('DigestValue>d<'));
      expect(guard).toEqual(guardaDe(3));
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    });
  });

  describe('chain simulation — every chain ends on exactly round MAX (AC, #513 + #1654)', () => {
    /** One reconcile round of a simulated chain. */
    interface Rodada {
      readonly r: ReconcileLoteResult;
      /** The doc's last write of the round — the next round is seeded from it. */
      readonly patch: NFeStatePatch;
      /** consSit calls made in this round. */
      readonly consSit: number;
    }

    /**
     * Drive the chain the way the task queue does: each round re-seeds the doc
     * from the LAST write of the previous one, and another round runs while
     * `stillPending > 0` (runReconcile's re-enqueue). `limite` bounds a chain
     * that would never end, so a regression fails on a count, not a hang.
     */
    async function rodarCadeia(
      respostaDoLote: (rodada: number) => unknown,
      limite: number,
    ): Promise<Rodada[]> {
      const rodadas: Rodada[] = [];
      let semente: Record<string, unknown> = { estado: ESTADO_NFE.aguardandoResposta, retries: 0 };
      for (let rodada = 1; rodada <= limite; rodada++) {
        seedDoc(semente);
        vi.mocked(consultarLote).mockResolvedValueOnce(respostaDoLote(rodada) as never);
        const consSitAntes = vi.mocked(consultarSituacaoNFe).mock.calls.length;
        const escritasAntes = writesFor(DOC).length;

        const r = await reconcileByRecibo({ ...baseArgs, attempt: rodada - 1 });

        const escritas = writesFor(DOC);
        // Every round writes the doc — else the re-seed would replay an old write.
        expect(escritas.length).toBeGreaterThan(escritasAntes);
        const patch = escritas.at(-1)!.patch;
        rodadas.push({
          r,
          patch,
          consSit: vi.mocked(consultarSituacaoNFe).mock.calls.length - consSitAntes,
        });
        if (r.stillPending === 0) break;
        semente = {
          estado: patch.estado,
          retries: patch.retries,
          cStat: patch.cStat,
          xMotivo: patch.xMotivo,
        };
      }
      return rodadas;
    }

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('lote always 104 without our prot + consSit always 108 → terminal on EXACTLY the MAX-th round', async () => {
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

      const rodadas = await rodarCadeia(() => loteRetSemProt(), 3 * MAX_RECONCILE_ATTEMPTS);

      expect(rodadas).toHaveLength(MAX_RECONCILE_ATTEMPTS);
      rodadas.slice(0, -1).forEach(({ r, patch, consSit }, i) => {
        expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
        expect(patch).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat: '104',
          retries: i + 1,
        });
        expect(consSit).toBe(1);
      });
      const ultima = rodadas.at(-1)!;
      expect(ultima.r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      expect(ultima.patch).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '104',
        retries: MAX_RECONCILE_ATTEMPTS,
      });
      expect(ultima.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(ultima.patch.xMotivo).toMatch(/verificar manualmente/);
      expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
      expectHomologacaoOnly();
    });

    // REWRITTEN on purpose (#1654). Under #513 this chain pinned that a
    // lote-level non-answer kept the count as read, so the chain ended only on
    // the MAX-th 104 SIGHTING (2·MAX-1 rounds). Every round now counts, so it
    // ends on round MAX; a 106 round past the doc's first one consults by chave.
    it('interleaved with lote-level non-answers (104, 108, 104, 106, 104, 109, …) → EVERY round counts, ends on exactly round MAX', async () => {
      const naoRespostas = ['108', '106', '109'] as const;
      const eh104 = (rodada: number): boolean => rodada % 2 === 1;
      const naoResposta = (rodada: number): string =>
        naoRespostas[(rodada / 2 - 1) % naoRespostas.length]!;
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

      const rodadas = await rodarCadeia(
        (rodada) => (eh104(rodada) ? loteRetSemProt() : loteRet(naoResposta(rodada))),
        6 * MAX_RECONCILE_ATTEMPTS,
      );

      expect(rodadas).toHaveLength(MAX_RECONCILE_ATTEMPTS);
      let consSitEsperadas = 0;
      rodadas.forEach(({ r, patch, consSit }, i) => {
        const rodada = i + 1;
        // Exactly one per round — never lowered, never skipped.
        expect(patch.retries).toBe(rodada);
        // A 104 and a 106 (never on the doc's first round here) consult by
        // chave; a 108/109 says nothing and makes no call.
        const porChave = eh104(rodada) || naoResposta(rodada) === '106';
        expect(consSit).toBe(porChave ? 1 : 0);
        if (porChave) consSitEsperadas++;
        if (rodada < MAX_RECONCILE_ATTEMPTS) {
          expect(r.stillPending).toBe(1);
          expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
        }
      });
      const ultima = rodadas.at(-1)!;
      expect(ultima.r).toMatchObject({ stillPending: 0, recovered: 0, errored: 1 });
      expect(ultima.patch.estado).toBe(ESTADO_NFE.error);
      expect(isBloqueada(ultima.patch.cStat)).toBe(true);
      expect(ultima.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(consSitEsperadas);
      expect(consSitEsperadas).toBeLessThanOrEqual(MAX_RECONCILE_ATTEMPTS);
      expectHomologacaoOnly();
    });

    // REWRITTEN on purpose (#1654). Under #513 the non-answer rounds between
    // the interruptions kept the count, so the chain took 2·MAX+1 rounds. Every
    // round now counts: the interrupted at-cap round leaves the doc in flight
    // AT MAX, and the one round after it ends it with no consSit.
    it('INTERRUPTED rounds (the at-cap one included) interleaved with non-answers → retries +1 per round, never more than MAX consSit, one final round past the cap with none', async () => {
      // The rounds whose consSit is interrupted AFTER the counted write (an
      // error the branch rethrows, standing in for a function timeout): a 104
      // one, and the at-cap one (round MAX is a 106, consulted by chave).
      const interrompidas = new Set([3, MAX_RECONCILE_ATTEMPTS]);
      const naoRespostas = ['108', '106', '109'] as const;
      const naoResposta = (rodada: number): string =>
        naoRespostas[(rodada / 2 - 1) % naoRespostas.length]!;
      expect(naoResposta(MAX_RECONCILE_ATTEMPTS)).toBe('106'); // the fixture's premise
      let rodadas = 0;
      vi.mocked(consultarSituacaoNFe).mockImplementation(async () => {
        if (interrompidas.has(rodadas)) throw new Error('timeout simulado da função');
        return consSitRet('108');
      });

      let semente: Record<string, unknown> = { estado: ESTADO_NFE.aguardandoResposta, retries: 0 };
      let fim: ReconcileLoteResult | null = null;
      const retriesPorRodada: number[] = [];
      while (fim == null && rodadas < 6 * MAX_RECONCILE_ATTEMPTS) {
        rodadas++;
        const eh104 = rodadas % 2 === 1;
        seedDoc(semente);
        vi.mocked(consultarLote).mockResolvedValueOnce(
          (eh104 ? loteRetSemProt() : loteRet(naoResposta(rodadas))) as never,
        );
        const escritasAntes = writesFor(DOC).length;

        if (interrompidas.has(rodadas)) {
          await expect(reconcileByRecibo({ ...baseArgs, attempt: rodadas - 1 })).rejects.toThrow(
            'timeout simulado',
          );
        } else {
          const r = await reconcileByRecibo({ ...baseArgs, attempt: rodadas - 1 });
          if (r.stillPending === 0) fim = r;
        }

        // Every round writes the doc (an interrupted one: its counted write).
        const escritas = writesFor(DOC);
        expect(escritas.length).toBeGreaterThan(escritasAntes);
        const patch = escritas.at(-1)!.patch;
        retriesPorRodada.push(patch.retries);
        semente = {
          estado: patch.estado,
          retries: patch.retries,
          cStat: patch.cStat,
          xMotivo: patch.xMotivo,
        };
      }

      // Exactly one per round, an interruption included.
      expect(retriesPorRodada).toEqual(
        Array.from({ length: MAX_RECONCILE_ATTEMPTS + 1 }, (_, i) => i + 1),
      );
      expect(rodadas).toBe(MAX_RECONCILE_ATTEMPTS + 1);
      // The consSit calls: every 104 round up to MAX, plus the 106 rounds.
      const porChave = Array.from({ length: MAX_RECONCILE_ATTEMPTS }, (_, i) => i + 1).filter(
        (k) => k % 2 === 1 || naoResposta(k) === '106',
      );
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(porChave.length);
      expect(porChave.length).toBeLessThanOrEqual(MAX_RECONCILE_ATTEMPTS);
      expect(fim).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      const terminal = writesFor(DOC).at(-1)!.patch;
      // Round MAX+1 is a 104 past the cap: the hard stop, with no consSit.
      expect(terminal).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '104',
        retries: MAX_RECONCILE_ATTEMPTS + 1,
      });
      expect(isBloqueada(terminal.cStat)).toBe(true);
      expect(terminal.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expectHomologacaoOnly();
    });

    /** A `retConsSitNFe` answering `cStat` with a protNFe of our chave when it is a final one. */
    const consSit = (cStat: string): TRetConsSitNFe =>
      ['100', '101', '110'].includes(cStat)
        ? consSitRet(cStat, { protCStat: cStat })
        : consSitRet(cStat);

    /** Every in-flight lote answer, in rotation — a round of each kind, #1654's whole table. */
    const rotacao: ReadonlyArray<() => unknown> = [
      () => loteRet('105'),
      () => loteRet('108'),
      () => loteRetSemProt(),
      () => loteRet('106'),
      () => loteRet('103'),
      () => loteRet('107'),
      () => loteRet('104', '204', { xMotivoProt: 'Rejeicao: Duplicidade de NF-e [nRec:999]' }),
      () => loteRet('109'),
      () => loteRet('104', '635'),
      () => loteRet('113'),
      () => loteRet('114'),
      () => loteRet('204'),
      () => loteRet('100'),
      () => loteRet(''),
    ];

    it.each<[string, (rodada: number) => unknown, string, string, number]>([
      ['105 every round', () => loteRet('105'), '108', '105', 0],
      ['lote 108 every round', () => loteRet('108'), '108', '103', 0],
      ['lote 103 every round', () => loteRet('103'), '108', '103', 0],
      ['lote 107 every round', () => loteRet('107'), '108', '103', 0],
      ['a non-TStat lote cStat every round', () => loteRet(''), '108', '103', 0],
      // Round 1 only counts; every later one consults.
      [
        'lote 106 every round, consSit 108',
        () => loteRet('106'),
        '108',
        '103',
        MAX_RECONCILE_ATTEMPTS - 1,
      ],
      [
        'our protNFe 204 [nRec:X] in a 104, consSit 108',
        () => loteRet('104', '204', { xMotivoProt: 'Rejeicao: Duplicidade de NF-e [nRec:999]' }),
        '108',
        '104',
        MAX_RECONCILE_ATTEMPTS,
      ],
      [
        'our protNFe 635 in a 104, consSit 217',
        () => loteRet('104', '635'),
        '217',
        '104',
        MAX_RECONCILE_ATTEMPTS,
      ],
      ['lote-level 204, consSit 108', () => loteRet('204'), '108', '103', MAX_RECONCILE_ATTEMPTS],
      [
        'lote-level 100 without protNFe, consSit 108',
        () => loteRet('100'),
        '108',
        '103',
        MAX_RECONCILE_ATTEMPTS,
      ],
      [
        'every in-flight answer in rotation, consSit 108',
        (rodada) => rotacao[(rodada - 1) % rotacao.length]!(),
        '108',
        // Round MAX lands on index MAX-1 of the rotation: lote 113 → 103.
        '103',
        // 104-without / 106 (not on round 1) / 204-in-104 / 635-in-104 each consult once.
        4,
      ],
    ])(
      '%s → retries +1 on every round, terminal on EXACTLY round MAX with a blocking cStat',
      async (_nome, respostaDoLote, consSitCStat, cStatFinal, consSitEsperadas) => {
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSit(consSitCStat));

        const rodadas = await rodarCadeia(respostaDoLote, 3 * MAX_RECONCILE_ATTEMPTS);

        expect(rodadas).toHaveLength(MAX_RECONCILE_ATTEMPTS);
        expect(rodadas.map(({ patch }) => patch.retries)).toEqual(
          Array.from({ length: MAX_RECONCILE_ATTEMPTS }, (_, i) => i + 1),
        );
        rodadas.slice(0, -1).forEach(({ r, patch }) => {
          expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
          expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
        });
        const ultima = rodadas.at(-1)!;
        expect(ultima.r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
        expect(ultima.patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: cStatFinal });
        expect(isBloqueada(ultima.patch.cStat)).toBe(true);
        expect(ultima.patch.xMotivo).toMatch(/verificar manualmente/);
        expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(consSitEsperadas);
        expectHomologacaoOnly();
      },
    );
  });

  describe('per-run consSit breaker — a 104 lote with NO protNFe, docs A then B', () => {
    /** Seed A (CHAVE, at DOC) then B (CHAVE_B, at DOC_B) — the loop visits them in that order. */
    function seedAB(b: Record<string, unknown> = {}): void {
      seedDocs([{}, { chave: CHAVE_B, ...b }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    }

    /**
     * consSit answers A with `respostaA`. B, were it ever consulted, would get
     * a conclusive 100 for its own chave — so a breaker that failed to trip
     * shows up as an extra call AND an aprovada B.
     */
    function consSitParaA(respostaA: () => Promise<TRetConsSitNFe>): void {
      vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, { chave }) =>
        chave === CHAVE ? respostaA() : consSitRet('100', { protCStat: '100', chNFe: CHAVE_B }),
      );
    }

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it.each<[string, () => Promise<TRetConsSitNFe>]>([
      ['answered', async () => consSitRet('656', { xMotivo: 'Rejeicao: Consumo Indevido' })],
      [
        'thrown',
        async () => {
          throw new NFeConsumoIndevidoError({
            cStat: '656',
            xMotivo: 'Rejeicao: Consumo Indevido',
            source: 'reconcile.test',
          });
        },
      ],
    ])('consSit(A) 656 (%s) → A and B terminal, ONE call', async (_modo, respostaA) => {
      seedAB();
      consSitParaA(respostaA);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 2, errored: 2, stillPending: 0, recovered: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      const a = writesFor(DOC).at(-1)!.patch;
      expect(a).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
      expect(a.xMotivo).toContain('cStat 656');
      const b = writesFor(DOC_B);
      expect(b).toHaveLength(1); // straight to terminal: never counted, never consulted
      expect(b[0]!.via).toBe('persistPatchUnlessFinal');
      expect(b[0]!.patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104', retries: 1 });
      expect(b[0]!.patch.xMotivo).toMatch(/suspensa nesta rodada após cStat 656/);
      expect(b[0]!.patch.xMotivo).toContain(CHAVE);
      expect(b[0]!.patch.xMotivo).toMatch(/verificar manualmente/);
      // B was never counted this round: its terminal re-checks B as read.
      expect(guardasFor(DOC_B)).toEqual([guardaDe(0)]);
      expectHomologacaoOnly();
    });

    it.each<[string, () => Promise<TRetConsSitNFe>]>([
      ['consSit 108', async () => consSitRet('108')],
      [
        'NFeTransportError',
        async () => {
          throw new NFeTransportError('socket hang up', undefined, '<soap:Fault/>');
        },
      ],
    ])('A unavailable (%s) → B counted with NO call; both pending', async (_modo, respostaA) => {
      seedAB({ retries: 3 });
      consSitParaA(respostaA);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 2, stillPending: 2, recovered: 0, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      const a = writesFor(DOC);
      expect(a).toHaveLength(1);
      expect(a[0]!.patch).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 1 });
      const b = writesFor(DOC_B);
      expect(b).toHaveLength(1);
      expect(b[0]!.via).toBe('persistPatchUnlessFinal');
      expect(b[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 4,
      });
      expect(b[0]!.patch.xMotivo).toMatch(contada(4));
      expectHomologacaoOnly();
    });

    it('A unavailable + B at MAX-1 → B terminal "após N consultas" with NO call', async () => {
      seedAB({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
      consSitParaA(async () => consSitRet('108'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 2, stillPending: 1, errored: 1, recovered: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      const b = writesFor(DOC_B);
      expect(b).toHaveLength(1);
      expect(b[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '104',
        retries: MAX_RECONCILE_ATTEMPTS,
      });
      expect(b[0]!.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(b[0]!.patch.xMotivo).toContain('indisponível nesta rodada (consSit cStat 108)');
      expect(b[0]!.patch.xMotivo).toMatch(/verificar manualmente/);
      expect(guardasFor(DOC_B)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS - 1)]);
      expectHomologacaoOnly();
    });

    it('A unavailable + B finalized concurrently → B’s guarded count (no call) is REFUSED: B tallied recovered, A pending', async () => {
      seedAB({ retries: 3 });
      consSitParaA(async () => consSitRet('108'));
      vi.mocked(persistPatchUnlessFinal)
        .mockResolvedValueOnce({ written: true }) // A's counted write
        .mockResolvedValueOnce(aprovadaConcorrente); // B's count, refused

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      // B reports its LIVE estado (aprovada), never the count it tried to write.
      expect(r).toMatchObject({ scanned: 2, stillPending: 1, recovered: 1, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      const b = writesFor(DOC_B);
      expect(b).toHaveLength(1); // attempted once, refused, nothing further
      expect(b[0]!.patch).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 4 });
      expect(guardasFor(DOC_B)).toEqual([guardaDe(3)]);
      expectHomologacaoOnly();
    });

    it.each<[string, () => Error]>([
      [
        'NFeXsdValidationError',
        () =>
          new NFeXsdValidationError('retConsSitNFe', [{ message: 'cvc-complex-type', line: 1 }]),
      ],
      ['NFeXmlError', () => new NFeXmlError('unexpected close tag')],
    ])(
      'consSit(A) throws %s → A counted, the breaker is NOT tripped: B is still consulted (two calls)',
      async (nome, erro) => {
        seedAB();
        consSitParaA(async () => {
          throw erro();
        });

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

        expect(r).toMatchObject({ scanned: 2, stillPending: 1, recovered: 1, errored: 0 });
        expect(vi.mocked(consultarSituacaoNFe).mock.calls.map(([, args]) => args.chave)).toEqual([
          CHAVE,
          CHAVE_B,
        ]);
        const a = writesFor(DOC);
        expect(a).toHaveLength(1); // counted, then left pending
        expect(a[0]!.patch).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 1 });
        expect(a[0]!.patch.xMotivo).toMatch(contada(1));
        expect(writesFor(DOC_B).at(-1)!.patch).toMatchObject({
          estado: ESTADO_NFE.aprovada,
          cStat: '100',
        });
        // Logged by name + message only (rule 9), never the raw error.
        expect(vi.mocked(console.error)).toHaveBeenCalledWith(
          expect.stringContaining('consSitNFe falhou'),
          expect.objectContaining({ name: nome }),
        );
        expectHomologacaoOnly();
      },
    );

    it.each<[string, TRetConsSitNFe, EstadoNFe]>([
      ['100', consSitRet('100', { protCStat: '100' }), ESTADO_NFE.aprovada],
      ['217', consSitRet('217'), ESTADO_NFE.rejeitada],
      ['562', consSitRet('562'), ESTADO_NFE.error],
    ])(
      'a conclusive consSit(A) %s trips nothing → B is consulted too (two calls)',
      async (_cStat, retA, estadoA) => {
        seedAB();
        consSitParaA(async () => retA);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

        expect(r.scanned).toBe(2);
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(consultarSituacaoNFe).mock.calls.map(([, args]) => args.chave)).toEqual([
          CHAVE,
          CHAVE_B,
        ]);
        expect(writesFor(DOC).at(-1)!.patch.estado).toBe(estadoA);
        expect(writesFor(DOC_B).at(-1)!.patch).toMatchObject({
          estado: ESTADO_NFE.aprovada,
          cStat: '100',
        });
        expectHomologacaoOnly();
      },
    );
  });

  describe('consSit failures', () => {
    it('NFeTransportError under the cap → resolves; the doc stays counted and pending', async () => {
      seedDoc({ retries: 2 });
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockRejectedValue(new NFeTransportError('ECONNRESET'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      const writes = writesFor(DOC);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 3,
      });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });

    it.each<[string, () => Error]>([
      ['NFeTransportError', () => new NFeTransportError('ECONNRESET')],
      [
        'NFeXsdValidationError',
        () =>
          new NFeXsdValidationError('retConsSitNFe', [{ message: 'cvc-complex-type', line: 1 }]),
      ],
      ['NFeXmlError', () => new NFeXmlError('unexpected close tag')],
    ])(
      '%s AT the cap → counted to MAX, then terminal "após N consultas" naming the error, KEEPING cStat 104',
      async (nome, erro) => {
        seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
        vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
        vi.mocked(consultarSituacaoNFe).mockRejectedValue(erro());
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

        expect(r).toMatchObject({ scanned: 1, errored: 1, stillPending: 0, recovered: 0 });
        const writes = writesFor(DOC);
        expect(writes.map((w) => [w.patch.estado, w.patch.retries])).toEqual([
          [ESTADO_NFE.aguardandoResposta, MAX_RECONCILE_ATTEMPTS],
          [ESTADO_NFE.error, MAX_RECONCILE_ATTEMPTS],
        ]);
        const last = writes.at(-1)!.patch;
        expect(last.cStat).toBe('104');
        expect(isBloqueada(last.cStat)).toBe(true);
        expect(last.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
        expect(last.xMotivo).toContain(nome);
        expect(last.xMotivo).toMatch(/verificar manualmente/);
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
        expect(guardasFor(DOC)).toEqual([
          guardaDe(MAX_RECONCILE_ATTEMPTS - 1),
          guardaDe(MAX_RECONCILE_ATTEMPTS),
        ]);
        expectHomologacaoOnly();
      },
    );

    it('an unexpected error (plain Error) → reconcileByRecibo rejects, but the count is already durable', async () => {
      seedDoc({ retries: 2 });
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockRejectedValue(new Error('boom'));

      await expect(reconcileByRecibo({ ...baseArgs, attempt: 2 })).rejects.toThrow('boom');

      const writes = writesFor(DOC);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.via).toBe('persistPatchUnlessFinal');
      expect(writes[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 3,
      });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });
  });

  describe('races — a doc finalized concurrently wins over this branch', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('the COUNTED write is refused (doc already aprovada) → NO consSit, tallied recovered', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(persistPatchUnlessFinal).mockResolvedValueOnce(aprovadaConcorrente);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(persistPatch)).not.toHaveBeenCalled();
      // One single-argument line names the chave and the live estado.
      const recusa = vi
        .mocked(console.warn)
        .mock.calls.find(([msg]) => String(msg).includes('gravação recusada'));
      expect(recusa).toHaveLength(1);
      expect(recusa![0]).toContain(CHAVE);
      expect(recusa![0]).toContain(`estado=${ESTADO_NFE.aprovada}`);
      expectHomologacaoOnly();
    });

    it('the TERMINAL write after consSit 562 is refused (doc already aprovada) → tallied recovered, not errored', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('562'));
      vi.mocked(persistPatchUnlessFinal)
        .mockResolvedValueOnce({ written: true })
        .mockResolvedValueOnce(aprovadaConcorrente);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
      // The terminal error WAS attempted — the guard refused it.
      expect(writesFor(DOC).map((w) => w.patch.estado)).toEqual([
        ESTADO_NFE.aguardandoResposta,
        ESTADO_NFE.error,
      ]);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });
  });

  describe('races against the REAL guard — the premise is re-derived on the tx snapshot (rule 7)', () => {
    /**
     * Seed ONE doc for the query AND the same doc in an in-memory store, and
     * route the guarded persist to the real one over that store. The query's
     * `data` is the pre-read; a concurrent writer mutates only the store.
     */
    async function comGuardaReal(
      over: Record<string, unknown> = {},
    ): Promise<ReturnType<typeof lojaEmMemoria>> {
      const loja = lojaEmMemoria();
      const [semente] = seedDocs([over], loja.docs);
      loja.docs[semente!.path] = { ...semente!.data };
      const real = await vi.importActual<typeof import('../../../lib/nfe/orchestrator/audit')>(
        '../../../lib/nfe/orchestrator/audit',
      );
      vi.mocked(persistPatchUnlessFinal).mockImplementation(real.persistPatchUnlessFinal);
      // The plain persist, too, writes into the store (through the seeded
      // ref's `set`): a write that regressed to it would land over the
      // concurrent writer — visibly — besides tripping the file's tripwire.
      vi.mocked(persistPatch).mockImplementation(real.persistPatch);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      return loja;
    }

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('control: with NO concurrent writer the real guard lets the count and the verdict through', async () => {
      const loja = await comGuardaReal();
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(2);
      expect(loja.docs[DOC]).toMatchObject({ estado: ESTADO_NFE.aprovada, cStat: '100' });
      expectHomologacaoOnly();
    });

    it.each<[string, Record<string, unknown>, Partial<ReconcileLoteResult>]>([
      [
        'terminal error (a 656 from another runner)',
        { estado: ESTADO_NFE.error, cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' },
        { errored: 1, recovered: 0, stillPending: 0 },
      ],
      [
        'rejeitada 217 (another runner’s consSit)',
        { estado: ESTADO_NFE.rejeitada, cStat: '217', xMotivo: 'Rejeicao: NF-e nao consta' },
        { errored: 0, recovered: 1, stillPending: 0 },
      ],
    ])(
      'a concurrent %s lands during the consReciNFe await → the counted write is REFUSED, NO consSit',
      async (_caso, concorrente, contagem) => {
        const loja = await comGuardaReal();
        vi.mocked(consultarLote).mockImplementation(async () => {
          loja.docs[DOC] = { ...loja.docs[DOC], ...concorrente }; // the other runner commits
          return loteRetSemProt() as never;
        });
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

        const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

        expect(r).toMatchObject({ scanned: 1, ...contagem });
        expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1); // attempted, refused
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        // Nothing was written over the concurrent terminal.
        expect(loja.docs[DOC]).toMatchObject({ ...concorrente, retries: 0 });
        expectHomologacaoOnly();
      },
    );

    it('another runner COUNTED the same sighting first (retries 0 → 1) → our count is refused, NO second consSit', async () => {
      const loja = await comGuardaReal();
      const outroRunner = 'motivo 104 | contada pelo outro runner (consulta 1/10)';
      vi.mocked(consultarLote).mockImplementation(async () => {
        loja.docs[DOC] = { ...loja.docs[DOC], retries: 1, cStat: '104', xMotivo: outroRunner };
        return loteRetSemProt() as never;
      });
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      // Still in flight — the other runner owns this sighting and its consSit.
      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(loja.docs[DOC]).toMatchObject({ retries: 1, xMotivo: outroRunner });
      expectHomologacaoOnly();
    });

    it('a concurrent rejeitada 217 lands during the consSit await → our terminal (consSit 562) is REFUSED', async () => {
      const loja = await comGuardaReal();
      vi.mocked(consultarSituacaoNFe).mockImplementation(async () => {
        loja.docs[DOC] = { ...loja.docs[DOC], estado: ESTADO_NFE.rejeitada, cStat: '217' };
        return consSitRet('562');
      });

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, recovered: 1, errored: 0, stillPending: 0 });
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(2); // count + refused terminal
      expect(loja.docs[DOC]).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '217' });
      expectHomologacaoOnly();
    });

    // ---- the SIBLING writes (105 / non-answer / 104-with-protNFe / cap) ----

    it('control: with NO concurrent writer the real guard lets a 105 poll write through', async () => {
      const loja = await comGuardaReal({ retries: 2 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 2 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      expect(loja.docs[DOC]).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '105',
        xMotivo: 'motivo 105',
        retries: 3,
        nRec: 'REC-1',
      });
      expectHomologacaoOnly();
    });

    it.each<[string, Record<string, unknown>, Partial<ReconcileLoteResult>]>([
      [
        'a #513 terminal (error, cStat 104)',
        {
          estado: ESTADO_NFE.error,
          cStat: '104',
          retries: 1,
          xMotivo:
            'motivo 104 | protNFe desta chave ausente no lote processado nRec REC-1; ' +
            'consulta por chave: cStat 562 — verificar manualmente',
        },
        { errored: 1, recovered: 0, stillPending: 0 },
      ],
      [
        'a #513 rejeitada 217',
        { estado: ESTADO_NFE.rejeitada, cStat: '217', retries: 0, xMotivo: 'consSit 217' },
        { errored: 0, recovered: 1, stillPending: 0 },
      ],
    ])(
      '%s lands during the consReciNFe await and the lote answers 108 → the non-answer write is REFUSED; the store keeps it, tallied by its live estado',
      async (_caso, concorrente, contagem) => {
        const loja = await comGuardaReal();
        vi.mocked(consultarLote).mockImplementation(async () => {
          loja.docs[DOC] = { ...loja.docs[DOC], ...concorrente }; // the other runner commits
          return loteRet('108') as never;
        });

        const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

        // Never `stillPending` — that would re-enqueue a doc that is done.
        expect(r).toMatchObject({ scanned: 1, ...contagem });
        expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1); // attempted, refused
        expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
        // Nothing was written over the concurrent terminal (no cStat 108 on it).
        expect(loja.docs[DOC]).toMatchObject(concorrente);
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        // One single-argument line names the chave, the receipt and the live estado.
        const recusa = vi
          .mocked(console.warn)
          .mock.calls.find(([msg]) => String(msg).includes('recusada'));
        expect(recusa).toHaveLength(1);
        expect(recusa![0]).toContain(CHAVE);
        expect(recusa![0]).toContain('REC-1');
        expect(recusa![0]).toContain(`estado=${String(concorrente.estado)}`);
        expectHomologacaoOnly();
      },
    );

    it('another runner’s COUNTED write lands during the consReciNFe await and the lote answers 105 → our 105 write is REFUSED (no double count, nothing overwritten)', async () => {
      const loja = await comGuardaReal();
      const outroRunner = {
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '105',
        xMotivo: 'motivo 105 | gravado pelo outro runner',
        retries: 1,
        proximaConsultaEm: 123,
      };
      vi.mocked(consultarLote).mockImplementation(async () => {
        loja.docs[DOC] = { ...loja.docs[DOC], ...outroRunner };
        return loteRet('105') as never;
      });

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      // Still in flight — the other runner's round owns this 105.
      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
      // Our write was decided on retries 0 — the store holds 1.
      expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
      expect(loja.docs[DOC]).toMatchObject(outroRunner);
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    });
  });

  it('near-miss in the LOTE: a protNFe 100 for CHAVE with its last digit changed → missing; consSit for OUR chave; the foreign 100 never applied', async () => {
    seedDoc({ xml_assinado: XML_DIGEST_OK });
    vi.mocked(consultarLote).mockResolvedValue(
      loteRet('104', '100', { chNFe: CHAVE_QUASE }) as never,
    );
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
      chave: CHAVE,
    });
    expect(vi.mocked(persistPatch)).not.toHaveBeenCalled();
    const writes = writesFor(DOC);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 1,
    });
    expect(writes.every((w) => w.patch.cStat !== '100' && w.extras === undefined)).toBe(true);
    expectHomologacaoOnly();
  });

  it('mixed lote: A carries its protNFe → aprovada (guarded); B is missing → ONE consSit, for B', async () => {
    seedDocs([{}, { chave: CHAVE_B }]);
    vi.mocked(consultarLote).mockResolvedValue(loteRetComProts([CHAVE]) as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 2, recovered: 1, stillPending: 1, errored: 0 });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
      chave: CHAVE_B,
    });
    const a = writesFor(DOC);
    expect(a.map((w) => w.via)).toEqual(['persistPatchUnlessFinal']);
    expect(a[0]!.patch).toMatchObject({ estado: ESTADO_NFE.aprovada, cStat: '100', retries: 0 });
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
    const b = writesFor(DOC_B);
    expect(b.map((w) => w.via)).toEqual(['persistPatchUnlessFinal']);
    expect(b[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 1,
    });
    expectHomologacaoOnly();
  });

  it("an 'enviando' doc with an nRec → written as aguardandoResposta, tallied pending (never recovered)", async () => {
    seedDoc({ estado: ESTADO_NFE.enviando });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
    const writes = writesFor(DOC);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 1,
    });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expectHomologacaoOnly();
  });

  it('a legacy doc with retries null → counted as sighting 1', async () => {
    seedDoc({ retries: null });
    vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r.stillPending).toBe(1);
    const writes = writesFor(DOC);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 1 });
    expect(writes[0]!.patch.xMotivo).toMatch(contada(1));
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expectHomologacaoOnly();
  });
});

describe('reconcileByRecibo — one decision per consReci round (#1654)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** The "(consulta k/N)" tail of the counted write of round `k`. */
  const consulta = (k: number): string => `(consulta ${k}/${MAX_RECONCILE_ATTEMPTS})`;

  describe('pacing — a paralisado receipt waits RECONCILE_INDISPONIVEL_DELAY_MS, in the doc AND the task', () => {
    it.each(['108', '109', '113', '114'])(
      'lote %s → the counted write carries proximaConsultaEm = now + 1 h + the sweep grace',
      async (cStat) => {
        seedDoc({ retries: 2 });
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

        const antes = Date.now();
        await reconcileByRecibo({ ...baseArgs, attempt: 2 });
        const depois = Date.now();

        const escritas = writesFor(DOC);
        expect(escritas).toHaveLength(1);
        const prox = escritas[0]!.extras?.proximaConsultaEm as number;
        const folga = RECONCILE_INDISPONIVEL_DELAY_MS + RECONCILE_SWEEP_GRACE_MS;
        expect(prox).toBeGreaterThanOrEqual((antes + folga) * 1000);
        expect(prox).toBeLessThanOrEqual((depois + folga) * 1000);
        // Only the due-gate rides along — never a proc, never an anchor change.
        expect(escritas[0]!.extras).toEqual({ proximaConsultaEm: prox });
        expectHomologacaoOnly();
      },
    );

    it.each(['105', '103', '107'])(
      'pin: lote %s keeps the default pacing — no extras on the write',
      async (cStat) => {
        seedDoc({ retries: 2 });
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

        await reconcileByRecibo({ ...baseArgs, attempt: 2 });

        expect(writesFor(DOC)[0]!.extras).toBeUndefined();
        expectHomologacaoOnly();
      },
    );

    it('the terminal at the cap leaves flight — no pacing rides on it', async () => {
      seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('108') as never);

      await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

      const w = writesFor(DOC).at(-1)!;
      expect(w.patch.estado).toBe(ESTADO_NFE.error);
      expect(w.extras).toBeUndefined();
      expectHomologacaoOnly();
    });
  });

  it("an 'enviando' doc with an nRec + lote 108 → written aguardandoResposta, counted, paced, tallied PENDING (never recovered)", async () => {
    seedDoc({ estado: ESTADO_NFE.enviando, retries: 0 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('108') as never);

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
    const escritas = writesFor(DOC);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.patch).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '108',
      retries: 1,
    });
    expect(escritas[0]!.extras?.proximaConsultaEm).toEqual(expect.any(Number));
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
    expectHomologacaoOnly();
  });

  it('a non-TStat lote cStat (empty) says nothing → counted in flight, never a número-freeing rejeitada', async () => {
    seedDoc({ retries: 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('') as never);

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });

    expect(r).toMatchObject({ stillPending: 1, recovered: 0, errored: 0 });
    expect(lastPatch()).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta, retries: 2 });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expectHomologacaoOnly();
  });

  it('our protNFe with a non-TStat cStat (empty) in a 104 is read as ABSENT → resolved by chave (one consSit), never a número-freeing rejeitada', async () => {
    seedDoc({ retries: 1 });
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));
    // `loteRet` omits a falsy protCStat — put our protNFe with `<cStat/>` in.
    vi.mocked(consultarLote).mockResolvedValue({
      ...(loteRet('104') as object),
      protNFe: [protDoLote(CHAVE, '')],
    } as never);

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });

    expect(r).toMatchObject({ stillPending: 1, recovered: 0, errored: 0 });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    for (const { patch } of writesFor(DOC)) {
      expect(patch.estado).not.toBe(ESTADO_NFE.rejeitada);
    }
    expect(lastPatch()).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      retries: 2,
    });
    expectHomologacaoOnly();
  });

  describe('lote 106 (lote não localizado) — resolved by chave, but never on the doc’s first round', () => {
    it('first round (retries 0) → counted only: retries 1, NO consSit (the receipt may not be indexed yet)', async () => {
      seedDoc({ retries: 0 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('106') as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      const escritas = writesFor(DOC);
      expect(escritas).toHaveLength(1);
      expect(escritas[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '106',
        retries: 1,
        nRec: 'REC-1',
      });
      expect(escritas[0]!.patch.xMotivo).toContain(consulta(1));
      expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
      expectHomologacaoOnly();
    });

    it.each<[string, TRetConsSitNFe, Partial<NFeStatePatch>, Partial<ReconcileLoteResult>]>([
      [
        '100 → aprovada',
        consSitRet('100', { protCStat: '100' }),
        { estado: ESTADO_NFE.aprovada, cStat: '100' },
        { recovered: 1 },
      ],
      [
        '217 → rejeitada (the número is free)',
        consSitRet('217'),
        { estado: ESTADO_NFE.rejeitada, cStat: '217' },
        { recovered: 1 },
      ],
      [
        '562 → terminal error, BLOCKING cStat 103',
        consSitRet('562'),
        { estado: ESTADO_NFE.error, cStat: '103' },
        { errored: 1 },
      ],
      [
        '110 (denegada) → terminal error 103 — its número is consumed',
        consSitRet('110', { protCStat: '110' }),
        { estado: ESTADO_NFE.error, cStat: '103' },
        { errored: 1 },
      ],
    ])(
      'a later round (retries 1): counted write, then ONE consSit — %s',
      async (_caso, retSit, final, contagem) => {
        seedDoc({ retries: 1 });
        vi.mocked(consultarLote).mockResolvedValue(loteRet('106') as never);
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(retSit);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });

        expect(r).toMatchObject({ scanned: 1, stillPending: 0, ...contagem });
        const escritas = writesFor(DOC);
        expect(escritas).toHaveLength(2);
        expect(escritas[0]!.patch).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat: '106',
          retries: 2,
        });
        expect(escritas[1]!.patch).toMatchObject(final);
        if (final.estado === ESTADO_NFE.error) {
          expect(isBloqueada(escritas[1]!.patch.cStat)).toBe(true);
          expect(escritas[1]!.patch.xMotivo).toContain('cStat 106: motivo 106');
          expect(escritas[1]!.patch.xMotivo).toContain(`cStat ${retSit.cStat}`);
          expect(escritas[1]!.patch.xMotivo).toMatch(/verificar manualmente/);
        }
        expect(guardasFor(DOC)).toEqual([guardaDe(1), guardaDe(2)]);
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
          chave: CHAVE,
        });
        // The count is durable BEFORE the SEFAZ call.
        expect(vi.mocked(persistPatchUnlessFinal).mock.invocationCallOrder[0]!).toBeLessThan(
          vi.mocked(consultarSituacaoNFe).mock.invocationCallOrder[0]!,
        );
        expectHomologacaoOnly();
      },
    );

    it('a later round, consSit 100 + matching stored digest → the aprovada write carries the proc', async () => {
      seedDoc({ retries: 1, xml_assinado: XML_DIGEST_OK });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('106') as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

      await reconcileByRecibo({ ...baseArgs, attempt: 1 });

      const last = writesFor(DOC).at(-1)!;
      expect(last.patch.estado).toBe(ESTADO_NFE.aprovada);
      expect(last.extras).toMatchObject({ xml_assinado: null });
      expect(typeof last.extras!.xml_nfe_proc).toBe('string');
      expectHomologacaoOnly();
    });

    it('a later round, consSit 108 → counted, and the NEXT doc of the lote gets no call (the breaker)', async () => {
      seedDocs([{ retries: 1 }, { chave: CHAVE_B, retries: 1 }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRet('106') as never);
      vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, { chave }) =>
        chave === CHAVE
          ? consSitRet('108')
          : consSitRet('100', { protCStat: '100', chNFe: CHAVE_B }),
      );

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });

      expect(r).toMatchObject({ scanned: 2, stillPending: 2, recovered: 0, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      const b = writesFor(DOC_B);
      expect(b).toHaveLength(1);
      expect(b[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '106',
        retries: 2,
      });
      expectHomologacaoOnly();
    });
  });

  describe('our protNFe carries a non-539 duplicidade inside a 104 — resolved by chave, never re-keyed', () => {
    /** A duplicidade xMotivo carrying ANOTHER receipt in its marker. */
    const DUPLICIDADE = 'Rejeicao: Duplicidade de NF-e [nRec:351000000000999]';

    it('the counted write keeps the RECEIPT (nRec REC-1, cStat 104) — the [nRec:X] marker never re-keys the doc; then ONE consSit', async () => {
      seedDoc({ retries: 2 });
      vi.mocked(consultarLote).mockResolvedValue(
        loteRet('104', '204', { xMotivoProt: DUPLICIDADE }) as never,
      );
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
      const escritas = writesFor(DOC);
      expect(escritas).toHaveLength(1);
      expect(escritas[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 3,
        nRec: 'REC-1',
      });
      // The protNFe's own answer stays visible to the operator.
      expect(escritas[0]!.patch.xMotivo).toContain(DUPLICIDADE);
      expect(escritas[0]!.patch.xMotivo).toContain(consulta(3));
      expect(guardasFor(DOC)).toEqual([guardaDe(2)]);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
        chave: CHAVE,
      });
      expectHomologacaoOnly();
    });

    it.each<[string, string, TRetConsSitNFe, Partial<NFeStatePatch>]>([
      [
        '204',
        '100 → aprovada',
        consSitRet('100', { protCStat: '100' }),
        { estado: ESTADO_NFE.aprovada, cStat: '100' },
      ],
      [
        '204',
        '217 → terminal error 104 (539 is facultative: the número may be held under another chave)',
        consSitRet('217'),
        { estado: ESTADO_NFE.error, cStat: '104' },
      ],
      [
        '205',
        '110 (denegada) → terminal error 104, NOT rejeitada',
        consSitRet('110', { protCStat: '110' }),
        { estado: ESTADO_NFE.error, cStat: '104' },
      ],
      [
        '218',
        '101 → cancelada',
        consSitRet('101', { protCStat: '100' }),
        { estado: ESTADO_NFE.cancelada, cStat: '101' },
      ],
    ])('protNFe %s + consSit %s', async (protCStat, _caso, retSit, final) => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(
        loteRet('104', protCStat, { xMotivoProt: DUPLICIDADE }) as never,
      );
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(retSit);

      await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      const escritas = writesFor(DOC);
      expect(escritas).toHaveLength(2);
      expect(escritas[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 1,
        nRec: 'REC-1',
      });
      expect(escritas[1]!.patch).toMatchObject(final);
      if (final.estado === ESTADO_NFE.error) {
        expect(isBloqueada(escritas[1]!.patch.cStat)).toBe(true);
        expect(escritas[1]!.patch.xMotivo).toContain(`cStat ${retSit.cStat}`);
        expect(escritas[1]!.patch.xMotivo).toMatch(/verificar manualmente/);
      }
      expect(guardasFor(DOC)).toEqual([guardaDe(0), guardaDe(1)]);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });
  });

  describe('our protNFe 635 (aguardando processamento) — a consSit 217 means "wait", never rejeitada', () => {
    it('consSit 217 → still aguardandoResposta, counted, NO breaker: the next doc of the lote is still consulted', async () => {
      seedDocs([{ retries: 1 }, { chave: CHAVE_B }]);
      // One protNFe (635) for A; none for B.
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '635') as never);
      vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, { chave }) =>
        chave === CHAVE
          ? consSitRet('217')
          : consSitRet('100', { protCStat: '100', chNFe: CHAVE_B }),
      );

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });

      expect(r).toMatchObject({ scanned: 2, stillPending: 1, recovered: 1, errored: 0 });
      expect(vi.mocked(consultarSituacaoNFe).mock.calls.map(([, args]) => args.chave)).toEqual([
        CHAVE,
        CHAVE_B,
      ]);
      const a = writesFor(DOC);
      expect(a).toHaveLength(1); // counted, then left in flight
      expect(a[0]!.patch).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '104',
        retries: 2,
      });
      expect(a.some((w) => w.patch.estado === ESTADO_NFE.rejeitada)).toBe(false);
      expect(writesFor(DOC_B).at(-1)!.patch.estado).toBe(ESTADO_NFE.aprovada);
      expectHomologacaoOnly();
    });

    it('at retries MAX-1 → consSit 217 → terminal error 104 "ainda aguardando processamento"', async () => {
      seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '635') as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      const escritas = writesFor(DOC);
      expect(escritas.map((w) => [w.patch.estado, w.patch.retries])).toEqual([
        [ESTADO_NFE.aguardandoResposta, MAX_RECONCILE_ATTEMPTS],
        [ESTADO_NFE.error, MAX_RECONCILE_ATTEMPTS],
      ]);
      const terminal = escritas[1]!.patch;
      expect(terminal.cStat).toBe('104');
      expect(terminal.xMotivo).toContain('ainda aguardando processamento');
      expect(terminal.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(terminal.xMotivo).toMatch(/verificar manualmente/);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });
  });

  describe('a per-NF-e verdict at LOTE level never lands without a protocol', () => {
    it.each(['100', '101', '102', '110'])(
      'lote-level %s without protNFe → by chave (counted + ONE consSit), never its own estado',
      async (cStat) => {
        seedDoc();
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

        expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
        const escritas = writesFor(DOC);
        expect(escritas).toHaveLength(1);
        expect(escritas[0]!.patch).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat,
          retries: 1,
        });
        expect(escritas[0]!.extras).toBeUndefined(); // no proc without a protocol
        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
        expectHomologacaoOnly();
      },
    );

    it('lote-level 100 + consSit 100 for our chave → aprovada from the CONSULTED protocol, proc stitched', async () => {
      seedDoc({ xml_assinado: XML_DIGEST_OK });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('100') as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r.recovered).toBe(1);
      const last = writesFor(DOC).at(-1)!;
      expect(last.patch.estado).toBe(ESTADO_NFE.aprovada);
      expect(typeof last.extras!.xml_nfe_proc).toBe('string');
      expectHomologacaoOnly();
    });

    it('lote-level 204 + consSit 217 → terminal error with the BLOCKING cStat 103 (duplicidade: the número may be held)', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRet('204') as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ errored: 1, recovered: 0 });
      const last = writesFor(DOC).at(-1)!.patch;
      expect(last).toMatchObject({ estado: ESTADO_NFE.error, cStat: '103' });
      expect(last.xMotivo).toContain('cStat 204: motivo 204');
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });
  });

  describe('a refused consReci query or a 656 → BLOCKING terminal with no consSit', () => {
    it.each(['252', '215', '280', '999'])(
      'lote %s (the query itself was refused) → error cStat 103, never a número-freeing rejeitada',
      async (cStat) => {
        seedDoc({ retries: 2 });
        vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

        expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
        const patch = lastPatch();
        expect(patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '103' });
        expect(isBloqueada(patch.cStat)).toBe(true);
        expect(patch.xMotivo).toContain(`cStat ${cStat}: motivo ${cStat}`);
        expect(patch.xMotivo).toMatch(/verificar manualmente/);
        expect(guardasFor(DOC)).toEqual([guardaDe(2)]);
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        expectHomologacaoOnly();
      },
    );

    it('our protNFe 656 inside a 104 → terminal error KEEPING the lote’s 104, no consSit', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '656') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ errored: 1, stillPending: 0 });
      const patch = lastPatch();
      expect(patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
      expect(patch.xMotivo).toContain('cStat 656: prot 656');
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    });
  });

  it('a 539 recovered into its earlier lote, which answers 105 → counted on the doc’s OWN retries (data.retries+1), never restarted at 1', async () => {
    seedDoc({ retries: 3 });
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValueOnce({ nRec: 'REC-0' } as never);
    vi.mocked(consultarLote).mockImplementation(async (_call, { nRec }) =>
      nRec === 'REC-1'
        ? (loteRet539() as never)
        : ({ ...(loteRet('105') as object), nRec: 'REC-0' } as never),
    );

    const r = await reconcileByRecibo({ ...baseArgs, attempt: 3 });

    expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
    expect(vi.mocked(consultarLote).mock.calls.map(([, args]) => args.nRec)).toEqual([
      'REC-1',
      'REC-0',
    ]);
    expect(vi.mocked(findLatestEnviNFeMsgWithNRec)).toHaveBeenCalledWith(
      expect.anything(),
      'F-1',
      OUTRA_CHAVE,
    );
    expect(lastPatch()).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '105',
      retries: 4,
    });
    expect(guardasFor(DOC)).toEqual([guardaDe(3)]);
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expectHomologacaoOnly();
  });

  it.each(['2040', '6350', '5390'])(
    'near-miss: our protNFe %s (a 4-digit rejection, not a duplicidade) → rejeitada as before, no consSit',
    async (protCStat) => {
      seedDoc({ retries: 2 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('104', protCStat) as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

      expect(r).toMatchObject({ recovered: 1, stillPending: 0, errored: 0 });
      expect(lastPatch()).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        cStat: protCStat,
        retries: 0,
      });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    },
  );

  it('real guard: another runner COUNTED the round during the consReciNFe await and the lote answers 108 → our count is REFUSED; retries neither lowered nor double-counted', async () => {
    const loja = lojaEmMemoria();
    const [semente] = seedDocs([{}], loja.docs);
    loja.docs[semente!.path] = { ...semente!.data };
    const real = await vi.importActual<typeof import('../../../lib/nfe/orchestrator/audit')>(
      '../../../lib/nfe/orchestrator/audit',
    );
    vi.mocked(persistPatchUnlessFinal).mockImplementation(real.persistPatchUnlessFinal);
    vi.mocked(persistPatch).mockImplementation(real.persistPatch);
    const outroRunner = {
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '108',
      xMotivo: 'motivo 108 | contada pelo outro runner (consulta 1/10)',
      retries: 1,
    };
    vi.mocked(consultarLote).mockImplementation(async () => {
      loja.docs[DOC] = { ...loja.docs[DOC], ...outroRunner };
      return loteRet('108') as never;
    });

    const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

    expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
    expect(loja.docs[DOC]).toMatchObject(outroRunner);
    expectHomologacaoOnly();
  });
});

// ---------------------------------------------------------------------------
// #1654 §2c/§2d — a failing doc does not take the round down with it, the
// consSit breaker lives in the CALLER's cell (so a trip survives a later
// throw), and a recovered 539's chave swap rides the round's own guarded write.
// ---------------------------------------------------------------------------

describe('reconcileByRecibo — per-doc isolation, the breaker cell and the 539 swap (#1654)', () => {
  /** An Admin-SDK Firestore failure: an `Error` carrying the numeric gRPC `code`. */
  const grpc = (code: number): Error => Object.assign(new Error(`${code} gRPC status`), { code });

  /** Route the guarded persist (and the plain one, for the tripwire) to the REAL audit module. */
  async function persistReal(): Promise<void> {
    const real = await vi.importActual<typeof import('../../../lib/nfe/orchestrator/audit')>(
      '../../../lib/nfe/orchestrator/audit',
    );
    vi.mocked(persistPatchUnlessFinal).mockImplementation(real.persistPatchUnlessFinal);
    vi.mocked(persistPatch).mockImplementation(real.persistPatch);
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('a doc that fails does not abort the round — only the named causes are isolated', () => {
    it('doc A deleted between the query and its write, next to doc B → A skipped (no partial doc), B aprovada, the call resolves', async () => {
      const loja = lojaEmMemoria();
      const [a, b] = seedDocs([{}, { chave: CHAVE_B }], loja.docs);
      // B is in the store; A was deleted after the in-flight query read it.
      loja.docs[b!.path] = { ...b!.data };
      await persistReal();
      vi.mocked(consultarLote).mockResolvedValue(loteRetComProts([CHAVE, CHAVE_B]) as never);

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      // A is neither pending nor recovered: there is nothing left to reconcile.
      expect(r).toMatchObject({ scanned: 2, recovered: 1, stillPending: 0, errored: 0 });
      expect(loja.docs[a!.path]).toBeUndefined();
      expect(loja.docs[b!.path]).toMatchObject({ estado: ESTADO_NFE.aprovada, cStat: '100' });
      // One single-argument line names the vanished path and the receipt.
      const aviso = vi
        .mocked(console.warn)
        .mock.calls.find(([msg]) => String(msg).includes('sumiu'));
      expect(aviso).toHaveLength(1);
      expect(aviso![0]).toContain(a!.path);
      expect(aviso![0]).toContain('REC-1');
      expectHomologacaoOnly();
    });

    it.each([4, 8, 10, 13, 14])(
      "a TRANSIENT Firestore failure (gRPC %i) on A's audit add → A left pending and unwritten, B reconciled, the call resolves",
      async (code) => {
        seedDocs([{ retries: 2 }, { chave: CHAVE_B, retries: 2 }]);
        vi.mocked(consultarLote).mockResolvedValue(loteRetComProts([CHAVE, CHAVE_B]) as never);
        vi.mocked(enviNfeCollection).mockReturnValueOnce({
          add: vi.fn().mockRejectedValue(grpc(code)),
        } as never);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 2 });

        // A's live state is unknown — pending, so the task re-reads it next round.
        expect(r).toMatchObject({ scanned: 2, stillPending: 1, recovered: 1, errored: 0 });
        expect(writesFor(DOC)).toEqual([]);
        expect(writesFor(DOC_B).map((w) => w.patch.estado)).toEqual([ESTADO_NFE.aprovada]);
        // Redacted through safeLog: a label naming the chave and the receipt,
        // then the error's name/message/code only.
        const log = vi
          .mocked(console.error)
          .mock.calls.find(([msg]) => String(msg).includes('falhou'));
        expect(log![0]).toContain(CHAVE);
        expect(log![0]).toContain('REC-1');
        expect(log![1]).toEqual({ name: 'Error', message: `${code} gRPC status`, code });
        expectHomologacaoOnly();
      },
    );

    it("a transient failure (gRPC 10, ABORTED) on A's GUARDED WRITE → A pending, B reconciled", async () => {
      seedDocs([{}, { chave: CHAVE_B }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetComProts([CHAVE, CHAVE_B]) as never);
      vi.mocked(persistPatchUnlessFinal).mockRejectedValueOnce(grpc(10));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 2, stillPending: 1, recovered: 1, errored: 0 });
      expect(writesFor(DOC_B).map((w) => w.patch.estado)).toEqual([ESTADO_NFE.aprovada]);
      expectHomologacaoOnly();
    });

    it.each<[string, () => Error]>([
      ['gRPC 3 (INVALID_ARGUMENT)', () => grpc(3)],
      ['gRPC 9 (FAILED_PRECONDITION)', () => grpc(9)],
      ['gRPC 7 (PERMISSION_DENIED)', () => grpc(7)],
      [
        'a TypeError (a bug)',
        () => new TypeError("Cannot read properties of undefined (reading 'x')"),
      ],
      [
        'a plain NFeOrchestratorError — NOT the vanished-doc subclass',
        () => new NFeOrchestratorError('outra falha'),
      ],
    ])(
      "near-miss: %s on A's write → the call REJECTS with it, and B is never reached",
      async (_caso, erro) => {
        seedDocs([{}, { chave: CHAVE_B }]);
        vi.mocked(consultarLote).mockResolvedValue(loteRetComProts([CHAVE, CHAVE_B]) as never);
        const e = erro();
        vi.mocked(persistPatchUnlessFinal).mockRejectedValueOnce(e);

        await expect(reconcileByRecibo({ ...baseArgs, attempt: 0 })).rejects.toBe(e);

        expect(writesFor(DOC_B)).toEqual([]);
        expectHomologacaoOnly();
      },
    );
  });

  describe("the consSit breaker lives in the CALLER's cell — a trip survives a later throw", () => {
    it("A's consSit answers 656, then B's terminal write throws gRPC 3 → the call rejects, and the caller's cell holds consumo-indevido", async () => {
      seedDocs([{}, { chave: CHAVE_B }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, { chave }) =>
        chave === CHAVE
          ? consSitRet('656', { xMotivo: 'Rejeicao: Consumo Indevido' })
          : consSitRet('100', { protCStat: '100', chNFe: CHAVE_B }),
      );
      const falha = grpc(3);
      vi.mocked(persistPatchUnlessFinal).mockImplementation(async (_fs, ref) => {
        if (ref.path === DOC_B) throw falha;
        return { written: true };
      });
      const disjuntor: DisjuntorConsSit = { bloqueio: null };

      await expect(reconcileByRecibo({ ...baseArgs, attempt: 0, disjuntor })).rejects.toBe(falha);

      // The trip is the caller's to keep, although no result ever came back.
      expect(disjuntor.bloqueio).toEqual({
        tipo: 'consumo-indevido',
        chave: CHAVE,
        xMotivo: 'Rejeicao: Consumo Indevido',
      });
      // B went terminal WITHOUT a consSit — the breaker held inside the run too.
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(writesFor(DOC_B).map((w) => w.patch.estado)).toEqual([ESTADO_NFE.error]);
      expectHomologacaoOnly();
    });

    it("A's consSit THROWS the 656 and A's OWN terminal write then throws gRPC 3 → the call rejects, and the caller's cell already holds consumo-indevido", async () => {
      seedDocs([{}, { chave: CHAVE_B }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockRejectedValue(
        new NFeConsumoIndevidoError({
          cStat: '656',
          xMotivo: 'Rejeicao: Consumo Indevido',
          source: 'reconcile.test',
        }),
      );
      const falha = grpc(3);
      // A's writes, in order: the durable count (lands), then the 656 terminal.
      let escritasDeA = 0;
      vi.mocked(persistPatchUnlessFinal).mockImplementation(async (_fs, ref) => {
        if (ref.path === DOC && ++escritasDeA === 2) throw falha;
        return { written: true };
      });
      const disjuntor: DisjuntorConsSit = { bloqueio: null };

      await expect(reconcileByRecibo({ ...baseArgs, attempt: 0, disjuntor })).rejects.toBe(falha);

      // The trip was written BEFORE the terminal write's await that failed.
      expect(escritasDeA).toBe(2);
      expect(disjuntor.bloqueio).toEqual({
        tipo: 'consumo-indevido',
        chave: CHAVE,
        xMotivo: 'Rejeicao: Consumo Indevido',
      });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(writesFor(DOC_B)).toEqual([]);
      expectHomologacaoOnly();
    });

    it("A's consSit answers 656 and THAT answer's audit add fails transiently → A pending, yet the trip holds: B terminal with no consSit", async () => {
      seedDocs([{}, { chave: CHAVE_B }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, { chave }) =>
        chave === CHAVE
          ? consSitRet('656', { xMotivo: 'Rejeicao: Consumo Indevido' })
          : consSitRet('100', { protCStat: '100', chNFe: CHAVE_B }),
      );
      // A's audits, in order: its receipt round (ok), then its consSit (fails).
      vi.mocked(enviNfeCollection)
        .mockReturnValueOnce({ add: vi.fn() } as never)
        .mockReturnValueOnce({ add: vi.fn().mockRejectedValue(grpc(14)) } as never);
      const disjuntor: DisjuntorConsSit = { bloqueio: null };

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0, disjuntor });

      // The answer tripped the breaker BEFORE the await that failed.
      expect(disjuntor.bloqueio).toMatchObject({ tipo: 'consumo-indevido', chave: CHAVE });
      expect(r).toMatchObject({ scanned: 2, stillPending: 1, errored: 1 });
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(writesFor(DOC_B).map((w) => w.patch.estado)).toEqual([ESTADO_NFE.error]);
      expectHomologacaoOnly();
    });

    it("an outage trip (consSit 108 on A) lands in the caller's cell, and the result reports the same breaker", async () => {
      seedDocs([{}, { chave: CHAVE_B }]);
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));
      const disjuntor: DisjuntorConsSit = { bloqueio: null };

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0, disjuntor });

      expect(r).toMatchObject({ scanned: 2, stillPending: 2 });
      expect(disjuntor.bloqueio).toEqual({ tipo: 'indisponivel', detalhe: 'consSit cStat 108' });
      expect(r.bloqueioConsSit).toEqual(disjuntor.bloqueio);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expectHomologacaoOnly();
    });

    it('a cell the caller already tripped (a 656 on an earlier lote of the filial) → no consSit at all; the doc terminal', async () => {
      seedDoc();
      vi.mocked(consultarLote).mockResolvedValue(loteRetSemProt() as never);
      const disjuntor: DisjuntorConsSit = {
        bloqueio: {
          tipo: 'consumo-indevido',
          chave: CHAVE_B,
          xMotivo: 'Rejeicao: Consumo Indevido',
        },
      };

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 0, disjuntor });

      expect(r).toMatchObject({ scanned: 1, errored: 1 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(lastPatch().xMotivo).toMatch(/suspensa nesta rodada após cStat 656/);
      expect(lastPatch().xMotivo).toContain(CHAVE_B);
      expectHomologacaoOnly();
    });
  });

  describe("the 539 recovery's own SOAP call fails → the round is COUNTED, never thrown", () => {
    /** Lote REC-1 answers our 539; the earlier receipt REC-0 fails with `erro`. */
    function recuperacaoFalha(erro: () => Error): void {
      vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValueOnce({ nRec: 'REC-0' } as never);
      vi.mocked(consultarLote).mockImplementation(async (_call, { nRec }) => {
        if (nRec === 'REC-1') return loteRet539() as never;
        throw erro();
      });
    }

    it.each<[string, () => Error]>([
      ['NFeTransportError', () => new NFeTransportError('ECONNRESET')],
      [
        'NFeXsdValidationError',
        () => new NFeXsdValidationError('retConsReciNFe', [{ message: 'campo inválido', line: 1 }]),
      ],
      ['NFeXmlError', () => new NFeXmlError('XML malformado')],
    ])(
      '%s on the earlier receipt → aguardandoResposta, retries+1 on the doc’s own count, guarded on the retries as read, no swap',
      async (nome, erro) => {
        seedDoc({ retries: 3 });
        recuperacaoFalha(erro);

        const r = await reconcileByRecibo({ ...baseArgs, attempt: 3 });

        expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
        expect(vi.mocked(consultarLote).mock.calls.map(([, args]) => args.nRec)).toEqual([
          'REC-1',
          'REC-0',
        ]);
        const escritas = writesFor(DOC);
        expect(escritas).toHaveLength(1);
        expect(escritas[0]!.patch).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          retries: 4,
        });
        expect(escritas[0]!.patch.xMotivo).toContain(`recuperação do 539 falhou (${nome})`);
        expect(escritas[0]!.patch.xMotivo).toContain(`(consulta 4/${MAX_RECONCILE_ATTEMPTS})`);
        expect(escritas[0]!.extras?.chave).toBeUndefined();
        expect(guardasFor(DOC)).toEqual([guardaDe(3)]);
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        expectHomologacaoOnly();
      },
    );

    it('at the cap → terminal error with the round’s BLOCKING cStat 104, the 539 in xMotivo — the chain ends', async () => {
      seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
      recuperacaoFalha(() => new NFeTransportError('ECONNRESET'));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      const patch = lastPatch();
      expect(patch).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '104',
        retries: MAX_RECONCILE_ATTEMPTS,
      });
      expect(isBloqueada(patch.cStat)).toBe(true);
      expect(patch.xMotivo).toContain('cStat 539');
      expect(patch.xMotivo).toContain('recuperação do 539 falhou');
      expect(patch.xMotivo).toMatch(/verificar manualmente/);
      expectHomologacaoOnly();
    });

    it.each<[string, number, EstadoNFe]>([
      ['under the cap', 3, ESTADO_NFE.aguardandoResposta],
      ['at the cap', MAX_RECONCILE_ATTEMPTS - 1, ESTADO_NFE.error],
    ])(
      'our 539 carries an [nRec:] marker (%s) → the stored doc STAYS on this receipt REC-1, never re-keyed onto the other chave’s lote (real guard)',
      async (_caso, retries, estado) => {
        // Numeric, as SEFAZ's receipts are (`RE_NREC` reads digits only).
        const MARCADOR = '351000000000777';
        const loja = lojaEmMemoria();
        const [semente] = seedDocs([{ retries }], loja.docs);
        loja.docs[semente!.path] = { ...semente!.data };
        await persistReal();
        vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValueOnce({ nRec: 'REC-0' } as never);
        vi.mocked(consultarLote).mockImplementation(async (_call, { nRec }) => {
          if (nRec === 'REC-1') return loteRet539({ nRecMarcador: MARCADOR }) as never;
          throw new NFeTransportError('ECONNRESET');
        });

        const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: retries });

        expect(r.scanned).toBe(1);
        // The marker really was there to re-key with — no vacuous pass.
        expect(lastPatch().xMotivo).toContain(`[nRec:${MARCADOR}]`);
        expect(loja.docs[DOC]).toMatchObject({
          estado,
          retries: retries + 1,
          nRec: 'REC-1',
          chave: CHAVE,
        });
        expectHomologacaoOnly();
      },
    );

    it('near-miss: a TypeError from the recovery is NOT counted — the call rejects', async () => {
      seedDoc({ retries: 3 });
      const bug = new TypeError("Cannot read properties of undefined (reading 'cStat')");
      recuperacaoFalha(() => bug);

      await expect(reconcileByRecibo({ ...baseArgs, attempt: 3 })).rejects.toBe(bug);

      expect(writesFor(DOC)).toEqual([]);
      expectHomologacaoOnly();
    });
  });

  describe('§2d — a recovered 539 swaps the chave in the round’s OWN guarded write (real guard)', () => {
    /**
     * One doc in the store; lote REC-1 answers our 539, and the earlier receipt
     * REC-0 authorizes the chave SEFAZ asserted. With `concorrente`, another
     * writer's terminal lands during that recovery's `consReciNFe`.
     */
    async function com539Recuperavel(
      concorrente?: Record<string, unknown>,
      over: Record<string, unknown> = {},
    ): Promise<ReturnType<typeof lojaEmMemoria>> {
      const loja = lojaEmMemoria();
      const [semente] = seedDocs([over], loja.docs);
      loja.docs[semente!.path] = { ...semente!.data };
      await persistReal();
      vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValueOnce({ nRec: 'REC-0' } as never);
      vi.mocked(consultarLote).mockImplementation(async (_call, { nRec }) => {
        if (nRec === 'REC-1') return loteRet539() as never;
        if (concorrente) loja.docs[DOC] = { ...loja.docs[DOC], ...concorrente };
        return { ...(loteRet('104', '100', { chNFe: OUTRA_CHAVE }) as object), nRec } as never;
      });
      return loja;
    }

    it('control: ONE guarded write carries the recovered estado AND the chave — and no proc, though the stored digest matches', async () => {
      // Stored bytes whose digest matches the fixtures' digVal: only the swap
      // keeps a proc off this write (our signed XML is for the OLD chave).
      const loja = await com539Recuperavel(undefined, { xml_assinado: XML_DIGEST_OK });

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
      const escritas = writesFor(DOC);
      expect(escritas).toHaveLength(1);
      expect(escritas[0]).toMatchObject({
        via: 'persistPatchUnlessFinal',
        patch: { estado: ESTADO_NFE.aprovada, cStat: '100' },
      });
      expect(escritas[0]!.extras).toEqual({ chave: OUTRA_CHAVE });
      expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
      expect(loja.docs[DOC]).toMatchObject({
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        chave: OUTRA_CHAVE,
        xml_assinado: XML_DIGEST_OK,
      });
      expectHomologacaoOnly();
    });

    it('a concurrent aprovada lands during the recovery’s consReciNFe → the write is REFUSED and the chave is NOT swapped', async () => {
      const concorrente = {
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        xMotivo: 'Autorizado o uso da NF-e (outro runner)',
      };
      const loja = await com539Recuperavel(concorrente);

      const r = await reconcileByRecibo({ ...baseArgs, fs: loja.fs, attempt: 0 });

      // Tallied by the live estado; nothing of this round reached the doc.
      expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errored: 0 });
      expect(loja.docs[DOC]).toMatchObject({ ...concorrente, chave: CHAVE });
      expectHomologacaoOnly();
    });
  });
});
