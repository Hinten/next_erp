/**
 * Route tests for POST /api/nfe/processar-pendentes — focused on the EPEC
 * branch of the anti-loss poller:
 *   - estado 'p' docs are NOT transmitted while the filial's modo is still
 *     'epec' (outage on → counted stillPending);
 *   - once the modo leaves 'epec', the doc rides `transmitirPosEpec` with the
 *     pedidoId recovered from the doc path;
 *   - a 468 result (estado stays 'p') counts stillPending, success recovers;
 *   - a stuck non-EPEC doc is still consulted at the authorizer that owns its
 *     persisted tpEmis (SVC doc → SVC consulta URL);
 *   - the docs an async lote reply WITHOUT infRec leaves behind (#512) are
 *     consulted by chave only once their own pacing says so, and a refused
 *     fresh member (rejeitada / error) is never scanned at all.
 * Auth, runtime, Firestore and the EPEC transmit are mocked; the scan logic,
 * `loadNfeConfigForEmission` and `sefazCallFor` run REAL against an in-memory
 * fake that supports `collectionGroup`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn() }));
vi.mock('@/lib/nfe/orchestrator/epec', () => ({ transmitirPosEpec: vi.fn() }));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  // Both SEFAZ consult bindings are mocked: an offline test must never reach
  // the real transport, even at a fake `https://example/…` host.
  return { ...actual, consultarLote: vi.fn(), consultarSituacaoNFe: vi.fn() };
});
vi.mock('@/lib/nfe/filial-cert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/filial-cert')>();
  return { ...actual, resolveFilialRuntimeByCnpj: vi.fn() };
});

import { nowMicros } from '@delfrance/core/datetime';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  consultarLote,
  consultarSituacaoNFe,
  DEFAULT_STUCK_TIMEOUT_MS,
  RECONCILE_BASE_DELAY_MS,
  RECONCILE_SWEEP_GRACE_MS,
} from '@delfrance/integrations-nfe';
import { CONTINGENCIA_MODO, AMBIENTE_NFE, ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import { verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { resolveFilialRuntimeByCnpj } from '@/lib/nfe/filial-cert';
import { persistPatch } from '@/lib/nfe/orchestrator/audit';
import { CONSUMO_INDEVIDO_ESPERA_MS, patchForLoteSemRecibo } from '@/lib/nfe/orchestrator/emitir';
import { transmitirPosEpec } from '@/lib/nfe/orchestrator/epec';
import { getNFeRuntime, type NFeBaseRuntime, type NFeRuntime } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/processar-pendentes/route';
import { assertSignedXmlNeverLost } from '../../../../helpers/xml-invariant';

const CHAVE = '35260614200166000187550010000000091400000010';

function req(body = '{}'): Request {
  return new Request('http://localhost/api/nfe/processar-pendentes', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body,
  });
}

function fakeRuntime(): NFeRuntime & NFeBaseRuntime {
  const rt: NFeRuntime = {
    cert: {} as never,
    agent: {} as never,
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {
      NfeAutorizacao: 'https://example/sefaz/aut',
      NfeRetAutorizacao: 'https://example/sefaz/ret',
      NfeConsultaProtocolo: 'https://example/sefaz/cons',
      NfeStatusServico: 'https://example/sefaz/sta',
      NfeInutilizacao: 'https://example/sefaz/inu',
      RecepcaoEvento: 'https://example/sefaz/rec',
    },
    svc: (authorizer) => ({
      endpoints: {
        NfeAutorizacao: `https://example/${authorizer}/aut`,
        NfeRetAutorizacao: `https://example/${authorizer}/ret`,
        NfeConsultaProtocolo: `https://example/${authorizer}/cons`,
        NfeStatusServico: `https://example/${authorizer}/sta`,
        RecepcaoEvento: `https://example/${authorizer}/rec`,
      },
      agent: {} as never,
    }),
    an: () => ({
      endpoints: { RecepcaoEvento: 'https://example/an/rec' },
      agent: {} as never,
    }),
    diagnostics: { subjectCommonName: 'TEST', notAfter: '2027-01-01', chainSource: 'x' },
  };
  return { ...rt, envRuntime: () => rt };
}

/**
 * In-memory Firestore for the route: `doc(path).get/set` (config reads +
 * recovery patches) and a `collectionGroup` that filters seeded docs by their
 * parent collection name + the `estado in [...]` constraint.
 */
function fakeFirestore(seed: Record<string, Record<string, unknown> | null>) {
  const docs: Record<string, Record<string, unknown> | null> = { ...seed };
  const writes: { path: string; data: Record<string, unknown>; merge?: boolean }[] = [];

  function ref(path: string): Record<string, unknown> {
    const segments = path.split('/');
    return {
      path,
      id: segments[segments.length - 1]!,
      // doc.ref.parent (collection) → .parent (the pedido doc) — the route
      // recovers the pedidoId from this chain.
      parent: {
        path: segments.slice(0, -1).join('/'),
        parent: segments.length > 2 ? ref(segments.slice(0, -2).join('/')) : null,
      },
      async get() {
        const data = docs[path];
        return { exists: data != null, id: segments[segments.length - 1]!, data: () => data };
      },
      async set(data: Record<string, unknown>, opt?: { merge?: boolean }) {
        assertSignedXmlNeverLost(path, data, opt?.merge);
        writes.push({ path, data, merge: opt?.merge });
        docs[path] = opt?.merge ? { ...(docs[path] ?? {}), ...data } : data;
      },
    };
  }

  function collectionGroup(groupId: string) {
    let estados: unknown[] | null = null;
    const q = {
      where(field: string, _op: string, value: unknown) {
        if (field === 'estado') estados = value as unknown[];
        return q;
      },
      limit(_n: number) {
        return q;
      },
      async get() {
        const items = Object.entries(docs)
          .filter(([k, v]) => v != null && k.split('/').at(-2) === groupId)
          .filter(([, v]) => !estados || estados.includes((v as { estado?: unknown }).estado))
          .map(([k, v]) => ({
            id: k.split('/').pop()!,
            ref: ref(k),
            data: () => v,
            exists: true,
          }));
        return { docs: items, size: items.length, empty: items.length === 0 };
      },
    };
    return q;
  }

  return {
    fs: {
      doc: (p: string) => ref(p),
      collection: (p: string) => ({
        doc: (id: string) => ref(`${p}/${id}`),
        // The receipt path audits each consult as a new enviNfe doc.
        async add(data: Record<string, unknown>) {
          const path = `${p}/auto-${writes.length}`;
          writes.push({ path, data });
          docs[path] = data;
          return ref(path);
        },
      }),
      collectionGroup,
    } as never,
    docs,
    writes,
  };
}

const CFG_EPEC: NFeConfig = {
  numeracao_atual: 9,
  serie: 1,
  idLote: 3,
  ambiente: AMBIENTE_NFE.homologacao,
  emitirReformaTributaria: false,
  contingencia_modo: CONTINGENCIA_MODO.epec,
  contingencia_justificativa: 'SEFAZ-SP indisponível desde as 08h',
  contingencia_dataInicio: new Date('2026-06-11T08:00:00.000Z').getTime(),
  timestamp: null,
};
const CFG_NONE: NFeConfig = {
  ...CFG_EPEC,
  contingencia_modo: CONTINGENCIA_MODO.none,
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
};

/** An EPEC-approved (estado 'p') nfev4 doc waiting for the pós-EPEC transmit. */
function pDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numeracao: 9,
    serie: 1,
    tpEmis: 4,
    estado: ESTADO_NFE.epecAprovado,
    filialId: 'F-1',
    chave: CHAVE,
    cStat: '136',
    xMotivo: 'Evento registrado, mas nao vinculado a NF-e',
    retries: 0,
    xml_assinado: '<NFe>…signed…</NFe>',
    xml_epec_proc: '<procEventoNFe>…</procEventoNFe>',
    ultima_modificacao: '2026-06-11T08:31:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  // Pendentes docs' filiais have no per-filial stored cert here — recover with
  // the env cert via the fallback (per-filial resolution covered elsewhere).
  process.env.NFE_CERT_ENV_FALLBACK = '1';
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  } as never);
  vi.mocked(getNFeRuntime).mockReturnValue(fakeRuntime());
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NFE_CERT_ENV_FALLBACK;
});

describe('POST /api/nfe/processar-pendentes — EPEC (estado p)', () => {
  it("keeps a 'p' doc pending while the filial's modo is still 'epec' (outage on)", async () => {
    const { fs } = fakeFirestore({
      'filiais/F-1/nfeconfig/default': CFG_EPEC as unknown as Record<string, unknown>,
      'pedidos/PED-1/nfev4/s4': pDoc(),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scanned: 1, recovered: 0, stillPending: 1, errors: [] });
    expect(vi.mocked(transmitirPosEpec)).not.toHaveBeenCalled();
  });

  it("transmits the full NF-e once the modo left 'epec' — pedidoId comes from the doc path", async () => {
    const { fs } = fakeFirestore({
      'filiais/F-1/nfeconfig/default': CFG_NONE as unknown as Record<string, unknown>,
      'pedidos/PED-1/nfev4/s4': pDoc(),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(transmitirPosEpec).mockResolvedValue({
      nfeId: 's4',
      pedidoId: 'PED-1',
      estado: ESTADO_NFE.aprovada,
      chave: CHAVE,
      nRec: null,
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      reused: false,
    });

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errors: [] });
    expect(vi.mocked(transmitirPosEpec)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transmitirPosEpec)).toHaveBeenCalledWith(
      expect.objectContaining({ pedidoId: 'PED-1', filialId: 'F-1' }),
    );
  });

  it("counts a 468 outcome (estado stays 'p') as stillPending, not recovered", async () => {
    const { fs } = fakeFirestore({
      'filiais/F-1/nfeconfig/default': CFG_NONE as unknown as Record<string, unknown>,
      'pedidos/PED-1/nfev4/s4': pDoc(),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(transmitirPosEpec).mockResolvedValue({
      nfeId: 's4',
      pedidoId: 'PED-1',
      estado: ESTADO_NFE.epecAprovado,
      chave: CHAVE,
      nRec: null,
      cStat: '468',
      xMotivo: 'Rejeição: EPEC não Sincronizado na Base de Dados da SEFAZ Autorizadora',
      reused: false,
    });

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 0, stillPending: 1 });
  });

  it("records an error for a 'p' doc with no filialId instead of crashing the run", async () => {
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s4': pDoc({ filialId: null }),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as { errors: ReadonlyArray<{ error: string }> };

    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.error).toContain('filialId');
    expect(vi.mocked(transmitirPosEpec)).not.toHaveBeenCalled();
  });
});

/** A stuck doc (hours past any timeout) for the consult-recovery branch. */
function stuckDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numeracao: 8,
    serie: 1,
    tpEmis: 6,
    estado: ESTADO_NFE.aguardandoResposta,
    filialId: 'F-1',
    chave: CHAVE,
    cStat: '103',
    xMotivo: 'Lote recebido',
    retries: 0,
    xml_assinado: '<NFe>…signed…</NFe>',
    ultima_modificacao: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function consSitRet(cStat: string, withProt: boolean): Record<string, unknown> {
  return {
    tpAmb: '2',
    verAplic: 'SVC_AN',
    cStat,
    xMotivo: cStat === '100' ? 'Autorizado o uso da NF-e' : 'Uso Denegado',
    cUF: '35',
    dhRecbto: '2026-06-11T09:00:00-03:00',
    chNFe: CHAVE,
    versao: '4.00',
    ...(withProt
      ? {
          protNFe: {
            versao: '4.00',
            infProt: {
              tpAmb: '2',
              verAplic: 'SVC_AN',
              chNFe: CHAVE,
              dhRecbto: '2026-06-11T09:00:00-03:00',
              nProt: '635260000000123',
              cStat,
              xMotivo: cStat === '100' ? 'Autorizado o uso da NF-e' : 'Uso Denegado',
            },
          },
        }
      : {}),
  };
}

describe('POST /api/nfe/processar-pendentes — stuck-doc recovery routing', () => {
  it('consults a stuck SVC doc (tpEmis 6) at the SVC, not the home SEFAZ', async () => {
    const { fs, docs, writes } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc(),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', true) as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 1 });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/svc-an/cons' }),
      { chave: CHAVE },
    );
    expect((docs['pedidos/PED-2/nfev4/s6'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
    // #128 — the recovery merge persists the nfeProc (so the doc can render
    // a DANFE) and clears the anchor in the very same payload.
    const recoveryWrite = writes.find((w) => w.path === 'pedidos/PED-2/nfev4/s6');
    expect(recoveryWrite?.data.xml_nfe_proc).toEqual(expect.any(String));
    expect(recoveryWrite?.data.xml_nfe_proc).toContain('<nfeProc ');
    expect(recoveryWrite?.data.xml_nfe_proc).toContain('<NFe>…signed…</NFe>');
    expect(recoveryWrite?.data.xml_nfe_proc).toContain('<nProt>635260000000123</nProt>');
    expect(recoveryWrite?.data.xml_assinado).toBeNull();
  });

  it('#396: digest MISMATCH between stored bytes and the recovered protNFe → aprovada WITHOUT proc, anchor kept', async () => {
    const storedWithDigest =
      '<NFe><infNFe>…signed…</infNFe><Signature><SignedInfo><Reference>' +
      '<DigestValue>StoredDigest==</DigestValue></Reference></SignedInfo></Signature></NFe>';
    const { fs, docs, writes } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc({ xml_assinado: storedWithDigest }),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const ret = consSitRet('100', true) as { protNFe: { infProt: Record<string, unknown> } };
    ret.protNFe.infProt.digVal = 'OtherDigest=='; // authorized DIFFERENT bytes
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(ret as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 1 });
    expect((docs['pedidos/PED-2/nfev4/s6'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
    // No proc persisted; the anchor survives for a DistDFe/manual fetch.
    const recoveryWrite = writes.find((w) => w.path === 'pedidos/PED-2/nfev4/s6');
    expect(recoveryWrite?.data.xml_nfe_proc).toBeUndefined();
    expect(recoveryWrite?.data.xml_assinado).toBeUndefined(); // not cleared
    expect((docs['pedidos/PED-2/nfev4/s6'] as { xml_assinado: string }).xml_assinado).toBe(
      storedWithDigest,
    );
  });

  it('a stuck doc with nRec + filialId is reconciled by receipt, never consSit — and keeps its nRec', async () => {
    // This case used to reach the REAL consultarLote (the binding was not
    // mocked) and passed only because the sweep's catch swallowed the transport
    // failure. It now asserts the receipt path actually ran.
    const { fs, docs } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc({ nRec: 'REC-103' }),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(consultarLote).mockResolvedValue({
      versao: '4.00',
      tpAmb: '2',
      verAplic: 'SVC_AN',
      nRec: 'REC-103',
      cStat: '105',
      xMotivo: 'Lote em processamento',
      cUF: '35',
      dhRecbto: '2026-06-11T09:00:00-03:00',
    } as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scanned: 1, stillPending: 1, errors: [] });
    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarLote)).toHaveBeenCalledWith(
      expect.objectContaining({ tpAmb: '2', url: 'https://example/svc-an/ret' }),
      { nRec: 'REC-103' },
    );
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    const doc = docs['pedidos/PED-2/nfev4/s6'] as { cStat: string; retries: number; nRec: string };
    expect(doc.cStat).toBe('105');
    expect(doc.retries).toBe(1);
    expect(doc.nRec).toBe('REC-103');
  });

  it('preserves the nRec saved on cStat=103 when a legacy doc (no filialId) is recovered by consSit', async () => {
    // No filialId → the receipt path cannot resolve a cert, so the sweep consults
    // by chave with the cert resolved from the emit CNPJ inside the chave.
    const { fs, docs } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc({ nRec: 'REC-103', filialId: null }),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(resolveFilialRuntimeByCnpj).mockResolvedValueOnce(fakeRuntime());
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', true) as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scanned: 1, recovered: 1, errors: [] });
    expect(vi.mocked(resolveFilialRuntimeByCnpj)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      CHAVE.slice(6, 20),
    );
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    // persistPatch omits nRec when the patch lacks one — the receipt the
    // lote response saved must survive the recovery merge.
    expect((docs['pedidos/PED-2/nfev4/s6'] as { nRec: string }).nRec).toBe('REC-103');
  });

  it('a consult landing denegada (110) leaves the anchor and writes no proc', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc(),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('110', true) as never);

    const res = await POST(req());
    expect(res.status).toBe(200);

    const docWrites = writes.filter((w) => w.path === 'pedidos/PED-2/nfev4/s6');
    expect(docWrites.length).toBeGreaterThan(0);
    expect(docWrites.some((w) => typeof w.data.xml_nfe_proc === 'string')).toBe(false);
    expect(docWrites.some((w) => w.data.xml_assinado === null)).toBe(false);
  });

  it('a doc without xml_assinado (crashed placeholder) recovers to aprovada without a proc', async () => {
    const { fs, docs, writes } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': stuckDoc({ xml_assinado: null }),
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', true) as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 1 });
    expect((docs['pedidos/PED-2/nfev4/s6'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
    // Nothing to pair — no signed XML to embed, so no proc and no clearing.
    const docWrites = writes.filter((w) => w.path === 'pedidos/PED-2/nfev4/s6');
    expect(docWrites.some((w) => typeof w.data.xml_nfe_proc === 'string')).toBe(false);
    expect(docWrites.some((w) => w.data.xml_assinado === null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #512 — what the backstop sweep does with the docs an async lote reply
// WITHOUT infRec leaves behind. The emit path persists one disposition per
// member and enqueues nothing, so this sweep is the ONLY thing that ever
// consults them — and it must do so only where the disposition asks for it,
// once per doc, by chave (there is no receipt).
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** `buildPersistData`'s own pacing for a first (retries 0, no tMed) `aguardandoResposta`. */
const DEFAULT_PACING_MS = RECONCILE_BASE_DELAY_MS + RECONCILE_SWEEP_GRACE_MS;

/** A distinct 44-digit chave per seeded member: `nNF` in positions 26–34. Shape only — no cDV. */
function chaveDe(nNF: number): string {
  return CHAVE.slice(0, 25) + String(nNF).padStart(9, '0') + CHAVE.slice(34);
}

interface LoteSemReciboSeed {
  readonly nNF: number;
  /** The LOTE-level cStat/xMotivo of the retEnviNFe that carried no infRec. */
  readonly cStat: string;
  readonly xMotivo: string;
  /** A #396 crash-window member — retransmitted with its STORED signed bytes. */
  readonly storedBytes: boolean;
  /** How long before the sweep runs the reply was persisted. */
  readonly persistedAgoMs: number;
}

/**
 * An nfev4 doc EXACTLY as #512 leaves it, built by the real code rather than
 * written by hand, so a change to the disposition moves these seeds with it:
 *  1. the pre-send anchor — the fields `buildNfeDocWrite` stamps, through the
 *     same `nfev4Collection` schema, so `ultima_modificacao` is the ms NUMBER
 *     real docs carry (the ISO strings in the older fixtures above are the
 *     legacy shape);
 *  2. the reply merged over it through the REAL `patchForLoteSemRecibo` and the
 *     `buildPersistData` mapping — via `persistPatch`, which writes the payload
 *     `persistPatchUnlessFinal` writes inside its transaction
 *     (audit.persist.test.ts pins the two equal); the explicit
 *     `proximaConsultaEm` is computed exactly as `persistLoteSemRecibo` does.
 * Both run with the clock frozen `persistedAgoMs` before the sweep, so the
 * doc's OWN pacing is what the sweep judges. The crash-window member's anchor
 * really predates this lote (only its `idLote` was re-stamped); every field the
 * sweep reads is the same either way.
 */
async function seedLoteSemRecibo(
  seed: LoteSemReciboSeed,
): Promise<{ doc: Record<string, unknown>; persistedAt: number }> {
  const persistedAt = Date.now() - seed.persistedAgoMs;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(persistedAt);
    const agora = new Date().toISOString();
    let doc: Record<string, unknown> = nfev4Collection.parse({
      numeracao: seed.nNF,
      serie: 1,
      tpEmis: 1,
      estado: ESTADO_NFE.enviando,
      filialId: 'F-1',
      chave: chaveDe(seed.nNF),
      idLote: '4',
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: `<NFe>…signed nNF ${seed.nNF}…</NFe>`,
      nRec: null,
      retries: 0,
      cStat: null,
      xMotivo: null,
      data_emissao: agora,
      data_autorizacao: null,
      dataContingencia: null,
      justificativaContingencia: null,
      error: null,
      ultima_modificacao: agora,
    });
    const { patch, consultaDelayMs } = patchForLoteSemRecibo(
      { cStat: seed.cStat, xMotivo: seed.xMotivo },
      { storedBytes: seed.storedBytes },
    );
    const captureRef = {
      async set(data: Record<string, unknown>, opt?: { merge?: boolean }) {
        expect(opt?.merge).toBe(true);
        doc = { ...doc, ...data };
      },
    };
    await persistPatch(
      captureRef as never,
      patch,
      consultaDelayMs != null
        ? { proximaConsultaEm: nowMicros() + consultaDelayMs * 1000 }
        : undefined,
    );
    return { doc, persistedAt };
  } finally {
    vi.useRealTimers();
  }
}

/** A consSit that authorizes exactly the chave it was asked about. */
function autorizadaPara(chave: string): never {
  const ret = consSitRet('100', true) as {
    chNFe: string;
    protNFe: { infProt: { chNFe: string } };
  };
  ret.chNFe = chave;
  ret.protNFe.infProt.chNFe = chave;
  return ret as never;
}

function pathDe(nNF: number): string {
  return `pedidos/PED-${nNF}/nfev4/s${nNF}`;
}

/** The consSit requests the sweep made, by chave — each MUST be at the home SEFAZ in homologação. */
function consultedChaves(): string[] {
  return vi.mocked(consultarSituacaoNFe).mock.calls.map(([call, body]) => {
    expect(call).toEqual(
      expect.objectContaining({ tpAmb: '2', url: 'https://example/sefaz/cons' }),
    );
    return body.chave;
  });
}

describe('POST /api/nfe/processar-pendentes — docs an async lote without infRec leaves (#512)', () => {
  beforeEach(() => {
    vi.mocked(consultarSituacaoNFe).mockImplementation(async (_call, body) =>
      autorizadaPara(body.chave),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a FRESH member the lote refused (656 → error, 108 → rejeitada) is never scanned, even hours later', async () => {
    const erro = await seedLoteSemRecibo({
      nNF: 11,
      cStat: '656',
      xMotivo: 'Rejeição: Consumo Indevido',
      storedBytes: false,
      persistedAgoMs: 3 * HOUR_MS,
    });
    const rejeitada = await seedLoteSemRecibo({
      nNF: 12,
      cStat: '108',
      xMotivo: 'Serviço Paralisado Momentaneamente (curto prazo)',
      storedBytes: false,
      persistedAgoMs: 3 * HOUR_MS,
    });
    // Precondition — the shapes #512 persists for a fresh refused member.
    expect(erro.doc).toMatchObject({
      estado: ESTADO_NFE.error,
      cStat: '656',
      nRec: null,
      proximaConsultaEm: null,
      chave: chaveDe(11),
      xml_assinado: expect.any(String),
    });
    expect(rejeitada.doc).toMatchObject({
      estado: ESTADO_NFE.rejeitada,
      cStat: '108',
      nRec: null,
      proximaConsultaEm: null,
      chave: chaveDe(12),
      xml_assinado: expect.any(String),
    });
    const { fs, writes } = fakeFirestore({ [pathDe(11)]: erro.doc, [pathDe(12)]: rejeitada.doc });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ scanned: 0, recovered: 0, stillPending: 0, errors: [] });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  // Each in-flight disposition, one minute either side of its own pacing. The
  // 656 anchor's "before" is the near-miss that pins the 1 h wait actually
  // reaching the sweep: under the default pacing it would be due at 59 min.
  describe.each<[string, Pick<LoteSemReciboSeed, 'cStat' | 'xMotivo' | 'storedBytes'>, number]>([
    [
      '103 without infRec (fresh) → aguardandoResposta',
      { cStat: '103', xMotivo: 'Lote recebido com sucesso', storedBytes: false },
      DEFAULT_PACING_MS,
    ],
    [
      '#396 crash-window anchor refused with 225 → aguardandoResposta',
      { cStat: '225', xMotivo: 'Rejeição: Falha no Schema XML da NFe', storedBytes: true },
      DEFAULT_PACING_MS,
    ],
    [
      '#396 crash-window anchor refused with 656 → aguardandoResposta paced 1 h',
      { cStat: '656', xMotivo: 'Rejeição: Consumo Indevido', storedBytes: true },
      CONSUMO_INDEVIDO_ESPERA_MS,
    ],
  ])('%s', (_caso, seed, pacingMs) => {
    it('is still pending one minute before its pacing ends — not consulted', async () => {
      const { doc, persistedAt } = await seedLoteSemRecibo({
        ...seed,
        nNF: 21,
        persistedAgoMs: pacingMs - MINUTE_MS,
      });
      expect(doc).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: seed.cStat,
        nRec: null,
        retries: 0,
        proximaConsultaEm: (persistedAt + pacingMs) * 1000,
        xml_assinado: expect.any(String),
      });
      const { fs, writes } = fakeFirestore({ [pathDe(21)]: doc });
      vi.mocked(getAdminFirestore).mockReturnValue(fs);

      const res = await POST(req());
      const body = (await res.json()) as Record<string, unknown>;

      expect(body).toEqual({ scanned: 1, recovered: 0, stillPending: 1, errors: [] });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

    it('is consulted by chave exactly once one minute after it — never by receipt', async () => {
      const { doc } = await seedLoteSemRecibo({
        ...seed,
        nNF: 22,
        persistedAgoMs: pacingMs + MINUTE_MS,
      });
      const { fs, docs } = fakeFirestore({ [pathDe(22)]: doc });
      vi.mocked(getAdminFirestore).mockReturnValue(fs);

      const res = await POST(req());
      const body = (await res.json()) as Record<string, unknown>;

      expect(body).toEqual({ scanned: 1, recovered: 1, stillPending: 0, errors: [] });
      expect(consultedChaves()).toEqual([chaveDe(22)]);
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      // The consult's verdict lands, and the proc is stitched from the bytes
      // the doc kept — for a crash-window member, its STORED bytes (#396).
      const after = docs[pathDe(22)] as Record<string, unknown>;
      expect(after.estado).toBe(ESTADO_NFE.aprovada);
      expect(after.xml_nfe_proc).toContain(`<NFe>…signed nNF 22…</NFe>`);
      expect(after.xml_assinado).toBeNull();
    });
  });

  it('deferral: an enviando doc with a per-NF-e cStat at lote level (100) has no pacing; the sweep consults it by chave exactly once', async () => {
    const { doc } = await seedLoteSemRecibo({
      nNF: 31,
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      storedBytes: false,
      persistedAgoMs: 3 * HOUR_MS,
    });
    // Precondition: NOT aprovada (no protNFe was read), unpaced, and the
    // timestamp in the unit real docs store — a ms number, not an ISO string.
    expect(doc).toMatchObject({
      estado: ESTADO_NFE.enviando,
      cStat: '100',
      nRec: null,
      proximaConsultaEm: null,
      xml_nfe_proc: null,
      xml_assinado: expect.any(String),
    });
    expect(typeof doc.ultima_modificacao).toBe('number');
    const { fs, docs } = fakeFirestore({ [pathDe(31)]: doc });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({ scanned: 1, recovered: 1, stillPending: 0, errors: [] });
    expect(consultedChaves()).toEqual([chaveDe(31)]);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect((docs[pathDe(31)] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
  });

  it('near-miss: an enviando doc with a lote-level 107 persisted ONE minute ago — well inside DEFAULT_STUCK_TIMEOUT_MS — is consulted on THIS tick (today’s behaviour)', async () => {
    const { doc, persistedAt } = await seedLoteSemRecibo({
      nNF: 32,
      cStat: '107',
      xMotivo: 'Servico em Operacao',
      storedBytes: false,
      persistedAgoMs: MINUTE_MS,
    });
    // Precondition: unpaced, and `ultima_modificacao` is the ms NUMBER real
    // docs store — one minute old.
    expect(doc).toMatchObject({
      estado: ESTADO_NFE.enviando,
      cStat: '107',
      nRec: null,
      proximaConsultaEm: null,
      ultima_modificacao: persistedAt,
    });
    expect(MINUTE_MS).toBeLessThan(DEFAULT_STUCK_TIMEOUT_MS);
    const { fs, docs } = fakeFirestore({ [pathDe(32)]: doc });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    // PINS TODAY'S BEHAVIOUR, which is NOT the intent: with no
    // `proximaConsultaEm` the sweep falls back to `isStuckEnviando`, whose
    // `Date.parse` on the stored ms NUMBER yields NaN — and NaN is treated as
    // stuck. So a one-minute-old doc is consulted at once instead of after the
    // stuck timeout. A separate, pre-existing defect (every ms-stamped doc
    // without `proximaConsultaEm` hits it), not #512's; when it is fixed this
    // expectation flips to `stillPending: 1` with no consult.
    expect(body).toEqual({ scanned: 1, recovered: 1, stillPending: 0, errors: [] });
    expect(consultedChaves()).toEqual([chaveDe(32)]);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect((docs[pathDe(32)] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
  });

  it('one sweep tick over every #512 shape consults only the due in-flight docs, once each', async () => {
    // [nNF, lote cStat, crash-window (stored bytes)?, persisted how long ago]
    const seeds: ReadonlyArray<readonly [number, string, boolean, number]> = [
      // Refused fresh members — out of the scan.
      [41, '656', false, 3 * HOUR_MS],
      [42, '108', false, 3 * HOUR_MS],
      // Paced and not yet due.
      [43, '103', false, 0],
      [44, '656', true, 30 * MINUTE_MS],
      // Due.
      [45, '225', true, 3 * MINUTE_MS],
      [46, '100', false, 3 * HOUR_MS],
      // "Due" only through the NaN defect pinned in the near-miss above: an
      // unpaced enviando doc one minute old.
      [47, '107', false, MINUTE_MS],
    ];
    const seed: Record<string, Record<string, unknown>> = {};
    for (const [nNF, cStat, storedBytes, persistedAgoMs] of seeds) {
      const xMotivo = `lote cStat ${cStat}`;
      const s = { nNF, cStat, xMotivo, storedBytes, persistedAgoMs };
      seed[pathDe(nNF)] = (await seedLoteSemRecibo(s)).doc;
    }
    const { fs } = fakeFirestore(seed);
    vi.mocked(getAdminFirestore).mockReturnValue(fs);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({ scanned: 5, recovered: 3, stillPending: 2, errors: [] });
    expect(consultedChaves().sort()).toEqual([chaveDe(45), chaveDe(46), chaveDe(47)]);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  });
});
