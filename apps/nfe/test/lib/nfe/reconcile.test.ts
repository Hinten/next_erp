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
 * chave. Every write goes through the guarded `persistPatchUnlessFinal` (rule
 * 7) — a tripwire on every case asserts the plain `persistPatch` is never
 * called — and the race cases run the REAL guard over an in-memory store.
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
  type NFeStatePatch,
  type TRetConsSitNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import {
  buildEnviNFeMsgFromConsulta,
  type GuardedPersistResult,
  type PersistGuard,
  persistPatch,
  persistPatchUnlessFinal,
} from '../../../lib/nfe/orchestrator/audit';
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
function protDoLote(chNFe: string, protCStat: string): unknown {
  return {
    versao: '4.00',
    infProt: {
      tpAmb: '2',
      verAplic: 'TEST',
      chNFe,
      dhRecbto: new Date().toISOString(),
      cStat: protCStat,
      xMotivo: `prot ${protCStat}`,
      nProt: '135000000000000',
      digVal: 'd',
    },
  };
}

/**
 * A `retConsReciNFe` echoing homologação. With `protCStat`, it carries ONE
 * protNFe, for `opts.chNFe` (default CHAVE).
 */
function loteRet(cStat: string, protCStat?: string, opts: { chNFe?: string } = {}): unknown {
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    nRec: 'REC-1',
    cStat,
    xMotivo: `motivo ${cStat}`,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    protNFe: protCStat ? [protDoLote(opts.chNFe ?? CHAVE, protCStat)] : undefined,
  };
}

/** A processed lote (104) carrying a protNFe 100 for each of `chaves` — and for no other. */
function loteRetComProts(chaves: readonly string[]): unknown {
  return { ...(loteRet('104') as object), protNFe: chaves.map((c) => protDoLote(c, '100')) };
}

/**
 * 104 lote whose inner protNFe for our chave is a cStat=539 (duplicidade com
 * chave diferente) — xMotivo asserts a DIFFERENT chave via the `[chNFe:...]`
 * marker the recovery parser reads.
 */
function loteRet539(): unknown {
  const OUTRA_CHAVE = '35260614200166000187550010000000099400000019';
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
          xMotivo: `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${OUTRA_CHAVE}]`,
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

  it('656 (consumo indevido) → terminal error, NEVER retried', async () => {
    seedDoc({ retries: 0 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('656') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.errored).toBe(1);
    expect(r.stillPending).toBe(0); // → caller does NOT re-enqueue
    expect(lastPatch().estado).toBe(ESTADO_NFE.error);
    expect(guardasFor(DOC)).toEqual([guardaDe(0)]);
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

  it.each(['103', '106', '107', '108', '109', '113', '114'])(
    'lote-level %s (no answer about the chave) KEEPS retries instead of zeroing it, no consSit',
    async (cStat) => {
      seedDoc({ retries: 4 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet(cStat) as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: 4 });

      expect(r.stillPending).toBe(1);
      expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
      expect(lastPatch()).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat,
        retries: 4,
      });
      expect(guardasFor(DOC)).toEqual([guardaDe(4)]);
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expectHomologacaoOnly();
    },
  );

  describe('a lote-level non-answer never trips the cap — a doc at MAX stays in flight AT MAX', () => {
    /**
     * The state an INTERRUPTED at-cap 104 round leaves: its counted write
     * (retries MAX, cStat 104) landed, then the consSit threw something not
     * narrowed or the function timed out.
     */
    const interrompidaNoLimite = {
      retries: MAX_RECONCILE_ATTEMPTS,
      cStat: '104',
      xMotivo: `motivo 104 | protNFe desta chave ausente no lote processado nRec REC-1 (consulta ${MAX_RECONCILE_ATTEMPTS}/${MAX_RECONCILE_ATTEMPTS})`,
    };

    /** Round 1 of the at-cap cases: the interrupted at-cap state meets lote-level `cStat`. */
    async function rodadaNaoRespostaNoLimite(cStat: string): Promise<{
      readonly r: ReconcileLoteResult;
      readonly patch: NFeStatePatch;
    }> {
      seedDoc(interrompidaNoLimite);
      vi.mocked(consultarLote).mockResolvedValueOnce(loteRet(cStat) as never);
      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS });
      return { r, patch: lastPatch() };
    }

    /** Re-seed the doc from `patch` — the next round reads what the last one wrote. */
    function reSemear(patch: NFeStatePatch): void {
      seedDoc({
        estado: patch.estado,
        retries: patch.retries,
        cStat: patch.cStat,
        xMotivo: patch.xMotivo,
      });
    }

    it.each(['106', '108'])(
      'retries AT the cap + lote %s → still pending AT MAX (not MAX-1), NEVER a terminal carrying the non-blocking cStat',
      async (cStat) => {
        const { r, patch } = await rodadaNaoRespostaNoLimite(cStat);

        expect(r).toMatchObject({ scanned: 1, stillPending: 1, recovered: 0, errored: 0 });
        expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
        expect(patch).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat,
          retries: MAX_RECONCILE_ATTEMPTS,
        });
        expect(patch.xMotivo).not.toMatch(/verificar manualmente/);
        // Why a terminal here would be wrong: this cStat does not block a
        // re-emission over the número SEFAZ may already have processed.
        expect(isBloqueada(cStat)).toBe(false);
        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS)]);
        expectHomologacaoOnly();
      },
    );

    it('near-miss: retries at MAX-1 + lote 106 → MAX-1 kept exactly (neither lowered nor advanced)', async () => {
      seedDoc({ ...interrompidaNoLimite, retries: MAX_RECONCILE_ATTEMPTS - 1 });
      vi.mocked(consultarLote).mockResolvedValue(loteRet('106') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });

      expect(r).toMatchObject({ stillPending: 1, errored: 0 });
      expect(lastPatch()).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '106',
        retries: MAX_RECONCILE_ATTEMPTS - 1,
      });
      expectHomologacaoOnly();
    });

    it('the next 104-without-our-protNFe sighting ends it with NO consSit: a terminal KEEPING the blocking cStat 104', async () => {
      // Round 1: the interrupted at-cap state meets a lote-level 108 → kept at MAX.
      const rodada1 = (await rodadaNaoRespostaNoLimite('108')).patch;
      expect(rodada1.retries).toBe(MAX_RECONCILE_ATTEMPTS);

      // Round 2, re-seeded from round 1's write: the lote answers 104 without
      // our protNFe again. The at-cap consSit was already spent by the
      // interrupted round, so there is none left to make.
      vi.clearAllMocks();
      reSemear(rodada1);
      vi.mocked(consultarLote).mockResolvedValueOnce(loteRetSemProt() as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', { protCStat: '100' }));

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS + 1 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      const escritas = writesFor(DOC);
      expect(escritas.map((w) => [w.patch.estado, w.patch.retries])).toEqual([
        [ESTADO_NFE.error, MAX_RECONCILE_ATTEMPTS + 1],
      ]);
      const terminal = escritas[0]!.patch;
      expect(terminal.cStat).toBe('104');
      expect(isBloqueada(terminal.cStat)).toBe(true);
      expect(terminal.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(terminal.xMotivo).toMatch(/verificar manualmente/);
      expect(guardasFor(DOC)).toEqual([guardaDe(MAX_RECONCILE_ATTEMPTS)]);
      expectHomologacaoOnly();
    });

    it('a 105 after it still counts past the cap → terminal KEEPING the blocking cStat 105, as before', async () => {
      const rodada1 = (await rodadaNaoRespostaNoLimite('106')).patch;
      expect(rodada1.retries).toBe(MAX_RECONCILE_ATTEMPTS);

      vi.clearAllMocks();
      reSemear(rodada1);
      vi.mocked(consultarLote).mockResolvedValueOnce(loteRet('105') as never);

      const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS + 1 });

      expect(r).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      const terminal = lastPatch();
      expect(terminal).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '105',
        retries: MAX_RECONCILE_ATTEMPTS + 1,
      });
      expect(isBloqueada(terminal.cStat)).toBe(true);
      expect(terminal.xMotivo).toMatch(/verificar manualmente/);
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

  describe('chain simulation — the 104 ceiling is hard (AC)', () => {
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

    it('interleaved with lote-level non-answers (104, 108, 104, 106, 104, 109, …) → retries never drops, ends on the MAX-th 104 sighting', async () => {
      const naoRespostas = ['108', '106', '109'] as const;
      const eh104 = (rodada: number): boolean => rodada % 2 === 1;
      const naoResposta = (rodada: number): string =>
        naoRespostas[(rodada / 2 - 1) % naoRespostas.length]!;
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('108'));

      const rodadas = await rodarCadeia(
        (rodada) => (eh104(rodada) ? loteRetSemProt() : loteRet(naoResposta(rodada))),
        6 * MAX_RECONCILE_ATTEMPTS,
      );

      // MAX sightings of the 104, with one non-answer between each pair.
      expect(rodadas).toHaveLength(2 * MAX_RECONCILE_ATTEMPTS - 1);
      let avistamentos = 0;
      rodadas.forEach(({ r, patch, consSit }, i) => {
        const rodada = i + 1;
        if (i > 0) expect(patch.retries).toBeGreaterThanOrEqual(rodadas[i - 1]!.patch.retries);
        if (eh104(rodada)) {
          avistamentos++;
          expect(consSit).toBe(1);
          expect(patch.retries).toBe(avistamentos);
        } else {
          // Says nothing about the chave: no consSit, the count is kept as is.
          expect(consSit).toBe(0);
          expect(r.stillPending).toBe(1);
          expect(patch).toMatchObject({
            estado: ESTADO_NFE.aguardandoResposta,
            cStat: naoResposta(rodada),
            retries: avistamentos,
          });
        }
      });
      expect(avistamentos).toBe(MAX_RECONCILE_ATTEMPTS);
      const ultima = rodadas.at(-1)!;
      expect(ultima.r).toMatchObject({ stillPending: 0, recovered: 0, errored: 1 });
      expect(ultima.patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
      expect(ultima.patch.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(2 * MAX_RECONCILE_ATTEMPTS - 1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
      expectHomologacaoOnly();
    });

    it('INTERRUPTED rounds (the at-cap one included) interleaved with non-answers → never more than MAX consSit calls; the sighting past the cap makes none', async () => {
      // The 104 sightings whose consSit is interrupted AFTER the counted write
      // (an error the branch rethrows, standing in for a function timeout):
      // an ordinary one, and the at-cap one.
      const interrompidas = new Set([3, MAX_RECONCILE_ATTEMPTS]);
      const naoRespostas = ['108', '106', '109'] as const;
      let avistamentos = 0;
      vi.mocked(consultarSituacaoNFe).mockImplementation(async () => {
        if (interrompidas.has(avistamentos)) throw new Error('timeout simulado da função');
        return consSitRet('108');
      });

      let semente: Record<string, unknown> = { estado: ESTADO_NFE.aguardandoResposta, retries: 0 };
      let fim: ReconcileLoteResult | null = null;
      let rodadas = 0;
      const retriesPorRodada: number[] = [];
      while (fim == null && rodadas < 6 * MAX_RECONCILE_ATTEMPTS) {
        rodadas++;
        const eh104 = rodadas % 2 === 1;
        if (eh104) avistamentos++;
        seedDoc(semente);
        vi.mocked(consultarLote).mockResolvedValueOnce(
          (eh104
            ? loteRetSemProt()
            : loteRet(naoRespostas[(rodadas / 2 - 1) % naoRespostas.length]!)) as never,
        );
        const escritasAntes = writesFor(DOC).length;

        if (eh104 && interrompidas.has(avistamentos)) {
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

      // The count never drops — an interruption or a non-answer included.
      retriesPorRodada.forEach((n, i) => {
        if (i > 0) expect(n).toBeGreaterThanOrEqual(retriesPorRodada[i - 1]!);
      });
      // MAX counted sightings with one consSit each (the interrupted ones
      // spent theirs), then ONE more sighting, past the cap, with none.
      expect(avistamentos).toBe(MAX_RECONCILE_ATTEMPTS + 1);
      expect(rodadas).toBe(2 * MAX_RECONCILE_ATTEMPTS + 1);
      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
      // The non-answer right after the interrupted at-cap round kept it AT MAX.
      expect(retriesPorRodada[2 * MAX_RECONCILE_ATTEMPTS - 1]).toBe(MAX_RECONCILE_ATTEMPTS);
      expect(fim).toMatchObject({ scanned: 1, stillPending: 0, recovered: 0, errored: 1 });
      const terminal = writesFor(DOC).at(-1)!.patch;
      expect(terminal).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '104',
        retries: MAX_RECONCILE_ATTEMPTS + 1,
      });
      expect(isBloqueada(terminal.cStat)).toBe(true);
      expect(terminal.xMotivo).toContain(`após ${MAX_RECONCILE_ATTEMPTS} consultas`);
      expectHomologacaoOnly();
    });
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
