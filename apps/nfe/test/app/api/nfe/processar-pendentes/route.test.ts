/**
 * Route tests for POST /api/nfe/processar-pendentes — focused on the EPEC
 * branch of the anti-loss poller:
 *   - estado 'p' docs are NOT transmitted while the filial's modo is still
 *     'epec' (outage on → counted stillPending);
 *   - once the modo leaves 'epec', the doc rides `transmitirPosEpec` with the
 *     pedidoId recovered from the doc path;
 *   - a 468 result (estado stays 'p') counts stillPending, success recovers;
 *   - a stuck non-EPEC doc is still consulted at the authorizer that owns its
 *     persisted tpEmis (SVC doc → SVC consulta URL).
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
  return { ...actual, consultarSituacaoNFe: vi.fn() };
});

import { consultarSituacaoNFe } from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import { verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { transmitirPosEpec } from '@/lib/nfe/orchestrator/epec';
import { getNFeRuntime, type NFeRuntime } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/processar-pendentes/route';

const CHAVE = '35260614200166000187550010000000091400000010';

function req(body = '{}'): Request {
  return new Request('http://localhost/api/nfe/processar-pendentes', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body,
  });
}

function fakeRuntime(): NFeRuntime {
  return {
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
      collection: (p: string) => ({ doc: (id: string) => ref(`${p}/${id}`) }),
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
  ambiente: '2',
  contingencia_modo: 'epec',
  contingencia_justificativa: 'SEFAZ-SP indisponível desde as 08h',
  contingencia_dataInicio: '2026-06-11T08:00:00.000Z',
};
const CFG_NONE: NFeConfig = {
  ...CFG_EPEC,
  contingencia_modo: 'none',
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
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  } as never);
  vi.mocked(getNFeRuntime).mockReturnValue(fakeRuntime());
});

afterEach(() => {
  vi.clearAllMocks();
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

describe('POST /api/nfe/processar-pendentes — stuck-doc recovery routing', () => {
  it('consults a stuck SVC doc (tpEmis 6) at the SVC, not the home SEFAZ', async () => {
    const { fs, docs } = fakeFirestore({
      'pedidos/PED-2/nfev4/s6': {
        numeracao: 8,
        serie: 1,
        tpEmis: 6,
        estado: ESTADO_NFE.aguardandoResposta,
        filialId: 'F-1',
        chave: CHAVE,
        cStat: '103',
        xMotivo: 'Lote recebido',
        retries: 0,
        // Hours past any stuck timeout.
        ultima_modificacao: '2026-06-10T00:00:00.000Z',
      },
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue({
      tpAmb: '2',
      verAplic: 'SVC_AN',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      cUF: '35',
      dhRecbto: '2026-06-11T09:00:00-03:00',
      chNFe: CHAVE,
      versao: '4.00',
      protNFe: {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'SVC_AN',
          chNFe: CHAVE,
          dhRecbto: '2026-06-11T09:00:00-03:00',
          nProt: '635260000000123',
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
        },
      },
    } as never);

    const res = await POST(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scanned: 1, recovered: 1 });
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/svc-an/cons' }),
      { chave: CHAVE },
    );
    expect((docs['pedidos/PED-2/nfev4/s6'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
  });
});
