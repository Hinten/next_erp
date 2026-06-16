/**
 * Orchestrator tests for cancelarPedido + inutilizarNumeracao. vi.mock the
 * library's SEFAZ surface (cancelarNFe / inutilizarNumeracao /
 * consultarSituacaoNFe) and back the Admin SDK with the same in-memory
 * Firestore fake as `orchestrator.test.ts`, so the flow runs end-to-end
 * without network or filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    // The orchestrator's SEFAZ round-trips. cUFFromUF / resolveTpEmis stay real.
    // cancelarNFeService no longer consults SEFAZ — it reads estado from the DB.
    cancelarNFe: vi.fn(),
    inutilizarNumeracao: vi.fn(),
  };
});

import {
  cancelarNFe,
  inutilizarNumeracao as inutilizarNumeracaoSefaz,
  NFeInutilizacaoError,
} from '@delfrance/integrations-nfe';
import { ESTADO_ENVI_NFE_MSG, ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import {
  cancelarNFeService,
  inutilizarNumeracao,
  NFeCancelamentoError,
  NFeInutilizacaoAbortedError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '../../../lib/nfe/orchestrator';
import type { NFeBaseRuntime, NFeRuntime } from '../../../lib/nfe/runtime';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

function fakeRuntime(): NFeRuntime & NFeBaseRuntime {
  const rt: NFeRuntime = {
    cert: {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST:99999999000191',
      cnpj: '99999999000191',
      notAfter: new Date(Date.now() + 86_400_000),
      pfxBuffer: Buffer.from(''),
      password: '',
    },
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
    diagnostics: {
      subjectCommonName: 'TEST',
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
      chainSource: '/tmp/fake.pem',
    },
  };
  // Base runtime for the entry points; the fallback path (no stored cert)
  // resolves to this same fake via `envRuntime`.
  return { ...rt, envRuntime: () => rt };
}

function impostoCsosn102(): Record<string, unknown> {
  return {
    origem: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '87120000',
    unidade: 'UN',
    configuracaoICMS: { crt: '1', csosn: '102' },
  };
}

const SEED_NFE_CONFIG: NFeConfig = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: '2',
  contingencia_modo: 'none',
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
};

interface FakeOpts {
  events: string[];
  /** Pre-existing nfev4 doc at pedidos/PED-1/nfev4/s1. `null` = absent. */
  nfev4?: Record<string, unknown> | null;
  /** Extra nfev4 docs by id (e.g. a second NF-e at s2). */
  nfev4ById?: Record<string, Record<string, unknown>>;
}

/** In-memory Firestore — same shape as orchestrator.test.ts. */
function fakeFirestore(opts: FakeOpts) {
  const defaultPedido: Record<string, unknown> = {
    ehSaida: true,
    estado: 'pago',
    itens: {
      'P-1': [
        {
          sku: 'SKU-1',
          nomeDeVenda: 'Bicicleta',
          precoDeVenda: 1500,
          quantidade: 1,
          descontoUnitario: 0,
          imposto: impostoCsosn102(),
        },
      ],
    },
    filialPedidoOuterRef: 'filiais/F-1',
    clientePedidoOuterRef: 'clientes/C-1',
    operacaoPedidoOuterRef: 'operacao/O-1',
    enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
  };

  const docs: Record<string, Record<string, unknown> | null> = {
    'pedidos/PED-1': defaultPedido,
    'filiais/F-1': {
      razaoSocial: 'ACME LTDA',
      cnpj: '14200166000187',
      ie: '111111111111',
      fantasia: null,
      cnae: null,
      iest: null,
      imun: null,
      sede: {
        logradouro: 'Rua A',
        numero: '1',
        bairro: 'Centro',
        cep: '01001000',
        codigoMunicipio: '3550308',
        cidade: 'Sao Paulo',
        estado: 'SP',
        complemento: null,
      },
    },
    'filiais/F-1/nfeconfig/default': SEED_NFE_CONFIG as unknown as Record<string, unknown>,
    'clientes/C-1': {
      tipo: '1',
      nome: 'Distribuidora X LTDA',
      cpf_cnpj: '99999999000191',
      idEstrangeiro: null,
      ie: '222222222',
      imun: null,
      isUF: null,
      email: null,
    },
    'clientes/C-1/enderecos/E-1': {
      logradouro: 'Av B',
      numero: '1',
      bairro: 'Centro',
      cep: '01001000',
      codigoMunicipio: '3550308',
      cidade: 'Sao Paulo',
      estado: 'SP',
      complemento: null,
    },
    'operacao/O-1': {
      nome: 'Venda',
      naturezaDaOperacao: 'Venda de mercadoria',
      tipo: 1,
      ehServico: false,
      ehExterior: false,
      ehConsumidorFinal: false,
      padrao: false,
      ativo: true,
      movimentaEstoque: true,
      movimentaIndisponivelEstoque: true,
      ehFiscal: true,
      finNFe: 1,
      indPres: '2',
      indIntermed: '0',
      cfop: '5102',
      cfopInterestadual: '6102',
      NCM: '87120000',
      CEST: null,
      unidade: 'UN',
      infCpl: null,
    },
  };
  // tpEmis = resolveTpEmis('SP') = 1 → doc id 's1'.
  if (opts.nfev4 !== undefined) {
    docs['pedidos/PED-1/nfev4/s1'] = opts.nfev4;
  }
  for (const [id, doc] of Object.entries(opts.nfev4ById ?? {})) {
    docs[`pedidos/PED-1/nfev4/${id}`] = doc;
  }

  const writes: { path: string; data: Record<string, unknown>; merge?: boolean }[] = [];
  let autoIdCounter = 0;

  function makeRef(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      async get() {
        const data = docs[path];
        return {
          exists: data != null,
          id: path.split('/').pop()!,
          ref: makeRef(path),
          data: () => data,
        };
      },
      async set(data: Record<string, unknown>, opt?: { merge?: boolean }) {
        writes.push({ path, data, merge: opt?.merge });
        docs[path] = opt?.merge ? { ...(docs[path] ?? {}), ...data } : data;
        opts.events.push(`set:${path}`);
      },
      collection(sub: string) {
        return makeCollection(`${path}/${sub}`);
      },
    };
  }

  type QueryOp =
    | { kind: 'where'; field: string; op: string; value: unknown }
    | { kind: 'orderBy'; field: string; dir: 'asc' | 'desc' }
    | { kind: 'limit'; n: number };

  function matchWhere(v: unknown, op: string, value: unknown): boolean {
    switch (op) {
      case '==':
        return v === value;
      case '>=':
        return typeof v === 'number' && typeof value === 'number' && v >= value;
      case '<=':
        return typeof v === 'number' && typeof value === 'number' && v <= value;
      case 'array-contains':
        return Array.isArray(v) && v.includes(value);
      default:
        return false;
    }
  }

  function makeQuery(path: string, ops: QueryOp[]) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(path, [...ops, { kind: 'where', field, op, value }]);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(path, [...ops, { kind: 'orderBy', field, dir }]);
      },
      limit(n: number) {
        return makeQuery(path, [...ops, { kind: 'limit', n }]);
      },
      async get() {
        const prefix = `${path}/`;
        let items = Object.entries(docs)
          .filter(
            ([key, val]) =>
              key.startsWith(prefix) && val != null && !key.slice(prefix.length).includes('/'),
          )
          .map(([key, val]) => ({
            id: key.slice(prefix.length),
            data: val as Record<string, unknown>,
          }));
        for (const op of ops) {
          if (op.kind === 'where') {
            items = items.filter((it) => matchWhere(it.data[op.field], op.op, op.value));
          } else if (op.kind === 'orderBy') {
            items.sort((a, b) => {
              const av = a.data[op.field] as string | number | null | undefined;
              const bv = b.data[op.field] as string | number | null | undefined;
              if (av === bv) return 0;
              if (av == null) return 1;
              if (bv == null) return -1;
              const cmp = av < bv ? -1 : 1;
              return op.dir === 'desc' ? -cmp : cmp;
            });
          } else if (op.kind === 'limit') {
            items = items.slice(0, op.n);
          }
        }
        return {
          docs: items.map((it) => ({
            id: it.id,
            ref: makeRef(`${path}/${it.id}`),
            data: () => it.data,
            exists: true,
          })),
          empty: items.length === 0,
          size: items.length,
        };
      },
    };
  }

  function makeCollection(path: string) {
    return {
      doc(id: string) {
        return makeRef(`${path}/${id}`);
      },
      async add(data: Record<string, unknown>) {
        autoIdCounter += 1;
        const ref = makeRef(`${path}/auto-${autoIdCounter}`);
        await ref.set(data);
        return ref;
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(path, [{ kind: 'where', field, op, value }]);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(path, [{ kind: 'orderBy', field, dir }]);
      },
      limit(n: number) {
        return makeQuery(path, [{ kind: 'limit', n }]);
      },
      get() {
        return makeQuery(path, []).get();
      },
    };
  }

  // Collection-group query — spans every collection named `groupId` regardless
  // of parent (a doc at `.../{groupId}/{docId}`). Supports `where` (==, >=, <=).
  function makeGroupQuery(groupId: string, ops: QueryOp[]) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeGroupQuery(groupId, [...ops, { kind: 'where', field, op, value }]);
      },
      async get() {
        let items = Object.entries(docs)
          .filter(([key, val]) => {
            if (val == null) return false;
            const parts = key.split('/');
            return parts.length >= 2 && parts[parts.length - 2] === groupId;
          })
          .map(([key, val]) => ({
            path: key,
            id: key.split('/').pop()!,
            data: val as Record<string, unknown>,
          }));
        for (const op of ops) {
          if (op.kind === 'where') {
            items = items.filter((it) => matchWhere(it.data[op.field], op.op, op.value));
          }
        }
        return {
          docs: items.map((it) => ({
            id: it.id,
            ref: makeRef(it.path),
            data: () => it.data,
            exists: true,
          })),
          empty: items.length === 0,
          size: items.length,
        };
      },
    };
  }

  return {
    fs: {
      collection: (name: string) => makeCollection(name),
      collectionGroup: (name: string) => makeGroupQuery(name, []),
      doc: (path: string) => makeRef(path),
      batch: () => {
        const queued: {
          ref: ReturnType<typeof makeRef>;
          data: Record<string, unknown>;
          opt?: { merge?: boolean };
        }[] = [];
        return {
          set(
            ref: ReturnType<typeof makeRef>,
            data: Record<string, unknown>,
            opt?: { merge?: boolean },
          ) {
            queued.push({ ref, data, opt });
          },
          async commit() {
            for (const q of queued) {
              writes.push({ path: q.ref.path, data: q.data, merge: q.opt?.merge });
              docs[q.ref.path] = q.opt?.merge ? { ...(docs[q.ref.path] ?? {}), ...q.data } : q.data;
              opts.events.push(`set:${q.ref.path}`);
            }
          },
        };
      },
      runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        const tx = {
          get: (ref: ReturnType<typeof makeRef>) => ref.get(),
          set: (
            ref: ReturnType<typeof makeRef>,
            data: Record<string, unknown>,
            opt?: { merge?: boolean },
          ) => {
            writes.push({ path: ref.path, data, merge: opt?.merge });
            docs[ref.path] = opt?.merge ? { ...(docs[ref.path] ?? {}), ...data } : data;
            opts.events.push(`set:${ref.path}`);
          },
        };
        return fn(tx);
      },
    } as never,
    writes,
    docs,
  };
}

/** An aprovada nfev4 doc (the cancellable state). */
function aprovadaNfev4(): Record<string, unknown> {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: CHAVE,
    numeracao: 1,
    serie: 1,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    tpEmis: 1,
    // The proc envelope carries the authorization protocol the service reads.
    xml_nfe_proc:
      `<nfeProc xmlns="${NFE_NS}" versao="4.00"><NFe>…</NFe>` +
      `<protNFe versao="4.00"><infProt><chNFe>${CHAVE}</chNFe>` +
      `<nProt>135200000000123</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`,
    ultima_modificacao: '2026-05-29T10:00:00.000Z',
  };
}

/** Build a CancelarNFeResult for a given per-evento cStat. */
function cancelResult(cStat: string) {
  return {
    ret: {
      idLote: '1',
      tpAmb: '2' as const,
      verAplic: 'SP_EVENTOS',
      cOrgao: '35' as const,
      cStat: '128',
      xMotivo: 'Lote de Evento Processado',
      versao: '1.00',
      retEvento: [
        {
          versao: '1.00',
          infEvento: {
            tpAmb: '2' as const,
            verAplic: 'SP_EVENTOS',
            cOrgao: '35' as const,
            cStat,
            xMotivo:
              cStat === '135'
                ? 'Evento registrado e vinculado a NF-e'
                : cStat === '155'
                  ? 'Evento registrado e vinculado a NF-e fora de prazo'
                  : cStat === '573'
                    ? 'Rejeicao: Duplicidade de Evento'
                    : 'Rejeicao: NF-e fora do prazo de cancelamento',
            chNFe: CHAVE,
            tpEvento: '110111',
            nSeqEvento: '1',
            dhRegEvento: '2026-05-29T10:30:00-03:00',
            nProt: '135200000099999',
          },
        },
      ],
    },
    signedEventoXml: `<evento xmlns="${NFE_NS}" versao="1.00"><infEvento Id="ID110111${CHAVE}01">…</infEvento><Signature>…</Signature></evento>`,
    procEventoNFe: '<procEventoNFe>…</procEventoNFe>',
    rawResponse: '<retEnvEvento>…</retEnvEvento>',
  };
}

/** Build an InutilizarResult for a given infInut cStat. */
function inutResult(cStat: string) {
  return {
    ret: {
      infInut: {
        tpAmb: '2' as const,
        verAplic: 'SP_NFE',
        cStat,
        xMotivo:
          cStat === '102' ? 'Inutilizacao de numero homologada' : 'Rejeicao: numero ja utilizado',
        cUF: '35' as const,
        ano: '26',
        CNPJ: '14200166000187',
        mod: '55' as const,
        serie: '9',
        nNFIni: '5',
        nNFFin: '12',
        dhRecbto: '2026-05-29T10:30:00-03:00',
        nProt: cStat === '102' ? '135200000088888' : undefined,
      },
      versao: '4.00',
    },
    signedXml: `<inutNFe xmlns="${NFE_NS}" versao="4.00"><infInut>…</infInut><Signature>…</Signature></inutNFe>`,
    rawResponse: '<retInutNFe>…</retInutNFe>',
  };
}

/**
 * A nfev4 doc occupying a número in série 9 (the inutilização range tests).
 * Attributed to F-1 by default via `filialId`; override via `extra`.
 */
function rangeNfev4(
  estado: string,
  numeracao: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    estado,
    serie: 9,
    numeracao,
    filialId: 'F-1',
    chave: null,
    cStat: null,
    xMotivo: null,
    tpEmis: 1,
    ultima_modificacao: '2026-05-29T10:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  // Fixtures have no per-filial stored cert — cancel/inutilizar with the env
  // cert via the fallback (per-filial resolution covered in filial-cert.test.ts).
  process.env.NFE_CERT_ENV_FALLBACK = '1';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NFE_CERT_ENV_FALLBACK;
});

describe('cancelarNFeService', () => {
  const XJUST = 'Cancelamento por erro de digitacao no pedido';

  it('routes a tpEmis=6 (SVC-AN) NF-e to the SVC RecepcaoEvento endpoint', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4ById: { s6: { ...aprovadaNfev4(), tpEmis: 6 } },
    });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    const result = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's6', XJUST);

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect(vi.mocked(cancelarNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/svc-an/rec' }),
      expect.anything(),
    );
  });

  it('routes a tpEmis=7 (SVC-RS) NF-e to the SVRS RecepcaoEvento endpoint', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4ById: { s7: { ...aprovadaNfev4(), tpEmis: 7 } },
    });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's7', XJUST);

    expect(vi.mocked(cancelarNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/svc-rs/rec' }),
      expect.anything(),
    );
  });

  it('routes a tpEmis=1 NF-e to the home SEFAZ RecepcaoEvento endpoint', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(vi.mocked(cancelarNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/sefaz/rec' }),
      expect.anything(),
    );
  });

  it("EPEC-approved (estado 'p') → rejected with the transmit-first message, no event sent (#86)", async () => {
    // An EPEC-approved NF-e has no autorização at the home SEFAZ yet — there
    // is nothing to cancel until the full NF-e is transmitted.
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4ById: { s4: { ...aprovadaNfev4(), tpEmis: 4, estado: ESTADO_NFE.epecAprovado } },
    });

    await expect(cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's4', XJUST)).rejects.toThrow(
      /transmita a NF-e completa/,
    );
    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's4', XJUST),
    ).rejects.toBeInstanceOf(NFeCancelamentoError);
    expect(vi.mocked(cancelarNFe)).not.toHaveBeenCalled();
  });

  it('cStat 135 → persists estado=cancelada (transaction) + 1 audit record, no SEFAZ consult', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    const result = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect(result.cStat).toBe('135');
    expect(result.chave).toBe(CHAVE);

    // Persisted estado='c' on the targeted nfev4 doc (transactional write).
    expect((docs['pedidos/PED-1/nfev4/s1'] as { estado: string }).estado).toBe(
      ESTADO_NFE.cancelada,
    );
    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(nfeWrite?.data.estado).toBe(ESTADO_NFE.cancelada);
    expect(nfeWrite?.data.cStat).toBe('135');

    // Exactly ONE enviNfe record (the cancelamento) — no consulta round-trip.
    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(1);
    expect(cancelarNFe).toHaveBeenCalledOnce();
  });

  it('cStat 155 (fora de prazo) → also cancelada', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('155') as never);

    const result = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect((docs['pedidos/PED-1/nfev4/s1'] as { estado: string }).estado).toBe(
      ESTADO_NFE.cancelada,
    );
  });

  it('cStat 573 (duplicidade de evento) → reconciles to cancelada', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('573') as never);

    const result = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect(result.cStat).toBe('573');
    expect((docs['pedidos/PED-1/nfev4/s1'] as { estado: string }).estado).toBe(
      ESTADO_NFE.cancelada,
    );
  });

  it('already cancelada in the DB → idempotent: NO event sent, returns cancelada', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), estado: ESTADO_NFE.cancelada, cStat: '135' },
    });

    const result = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect(result.reused).toBe(true);
    // No SEFAZ event, no audit, no write.
    expect(cancelarNFe).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('estado not aprovada (rejeitada) → throws, no event', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), estado: ESTADO_NFE.rejeitada },
    });

    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST),
    ).rejects.toBeInstanceOf(NFeCancelamentoError);
    expect(cancelarNFe).not.toHaveBeenCalled();
  });

  it('no nProt in xml_nfe_proc → throws, no event (never consults SEFAZ)', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), xml_nfe_proc: null },
    });

    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST),
    ).rejects.toBeInstanceOf(NFeCancelamentoError);
    expect(cancelarNFe).not.toHaveBeenCalled();
  });

  it('a real rejection cStat (e.g. 236) → throws with cStat/xMotivo, estado unchanged', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('236') as never);

    const err = await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NFeCancelamentoError);
    expect((err as NFeCancelamentoError).cStat).toBe('236');
    expect((err as NFeCancelamentoError).xMotivo).toBeTruthy();
    expect((docs['pedidos/PED-1/nfev4/s1'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
  });

  it('throws NFePedidoNotFoundError (→ 404) when the nfev4 doc id does not exist', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events, nfev4: null });
    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST),
    ).rejects.toBeInstanceOf(NFePedidoNotFoundError);
  });

  it('uses the denormalized filialId on the nfev4 doc (skips the pedido read)', async () => {
    const events: string[] = [];
    // `filialId` on the doc differs from the pedido's outer-ref filial (F-1);
    // the audit must land under the doc's filial, proving no pedido read happened.
    const { fs, writes } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), filialId: 'F-9' },
    });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect(writes.some((w) => w.path.startsWith('filiais/F-9/enviNfe/'))).toBe(true);
    expect(writes.some((w) => w.path.startsWith('filiais/F-1/enviNfe/'))).toBe(false);
  });

  it('legacy doc without filialId + pedido gone → NFePedidoNotFoundError (→ 404)', async () => {
    const events: string[] = [];
    // No `filialId` on the doc AND the pedido doc is absent → the legacy fallback
    // read finds nothing → NFePedidoNotFoundError (→ 404).
    const { fs, docs } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    docs['pedidos/PED-1'] = null;
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);
    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST),
    ).rejects.toBeInstanceOf(NFePedidoNotFoundError);
  });

  it('throws NFeOrchestratorError when the nfev4 doc has no chave', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), chave: null },
    });
    await expect(
      cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
  });

  it('targets the doc by nfeId: with two NF-es, cancelling s1 leaves s2 untouched', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      nfev4ById: { s1: aprovadaNfev4(), s2: aprovadaNfev4() },
    });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    await cancelarNFeService(fs, fakeRuntime(), 'PED-1', 's1', XJUST);

    expect((docs['pedidos/PED-1/nfev4/s1'] as { estado: string }).estado).toBe(
      ESTADO_NFE.cancelada,
    );
    expect((docs['pedidos/PED-1/nfev4/s2'] as { estado: string }).estado).toBe(ESTADO_NFE.aprovada);
  });
});

describe('inutilizarNumeracao (orchestrator)', () => {
  it('cStat 102 → returns the protocol + records the inutilização + does NOT touch the counter', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(inutResult('102') as never);

    const result = await inutilizarNumeracao(fs, fakeRuntime(), {
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });

    expect(result.cStat).toBe('102');
    expect(result.nProt).toBe('135200000088888');
    expect(result.serie).toBe(9);

    // The inutilização record is the single source of truth — exactly one is
    // written, and there is NO redundant generic `enviNfe` audit entry.
    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(0);
    const recs = writes.filter((w) => w.path.startsWith('filiais/F-1/inutilizacao/'));
    expect(recs).toHaveLength(1);
    // The NFeConfig counter must be left alone (these números were skipped).
    expect(writes.some((w) => w.path === 'filiais/F-1/nfeconfig/default')).toBe(false);
  });

  it('cStat 102 with an empty <nProt/> → stores nProt as null (record write does not throw)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    const res = inutResult('102');
    res.ret.infInut.nProt = ''; // SEFAZ returned a present-but-empty protocol element
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(res as never);

    const result = await inutilizarNumeracao(fs, fakeRuntime(), {
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });

    // Empty element is normalized to null — the record schema rejects '' (min 1).
    expect(result.nProt).toBeNull();
    const recs = writes.filter((w) => w.path.startsWith('filiais/F-1/inutilizacao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.nProt).toBeNull();
  });

  it('cStat != 102 → throws NFeInutilizacaoError (still records the inutilização)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(inutResult('563') as never);

    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoError);

    // No generic enviNfe audit entry — only the durable inutilização record.
    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(0);
    const recs = writes.filter((w) => w.path.startsWith('filiais/F-1/inutilizacao/'));
    expect(recs).toHaveLength(1);
  });

  it('aborts (no SEFAZ send) when an in-range número is already aprovada', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4ById: { ap: rangeNfev4(ESTADO_NFE.aprovada, 7, { chave: CHAVE }) },
    });

    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoAbortedError);
    expect(inutilizarNumeracaoSefaz).not.toHaveBeenCalled();
  });

  it('aborts when an in-range número belongs to a cancelada NF-e (número já consumido)', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4ById: { ca: rangeNfev4(ESTADO_NFE.cancelada, 8) },
    });

    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoAbortedError);
    expect(inutilizarNumeracaoSefaz).not.toHaveBeenCalled();
  });

  it('attributes a legacy doc (no filialId) by the chave CNPJ and still aborts', async () => {
    const events: string[] = [];
    // No `filialId`; the chave's CNPJ (positions 6-20) is F-1's cnpj.
    const legacy = rangeNfev4(ESTADO_NFE.aprovada, 7, { chave: CHAVE });
    delete legacy.filialId;
    const { fs } = fakeFirestore({ events, nfev4ById: { legacy } });

    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoAbortedError);
    expect(inutilizarNumeracaoSefaz).not.toHaveBeenCalled();
  });

  it('cStat 102 → persists an inutilizacao record AND flips non-authorized in-range docs to inutilizada', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({
      events,
      nfev4ById: {
        rej: rangeNfev4(ESTADO_NFE.rejeitada, 7),
        ger: rangeNfev4(ESTADO_NFE.gerado, 8),
      },
    });
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(inutResult('102') as never);

    const result = await inutilizarNumeracao(fs, fakeRuntime(), {
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });

    expect(result.aprovada).toBe(true);
    expect(result.reconciled).toBe(2);
    expect((docs['pedidos/PED-1/nfev4/rej'] as { estado: string }).estado).toBe(
      ESTADO_NFE.numeracaoInutilizada,
    );
    expect((docs['pedidos/PED-1/nfev4/ger'] as { estado: string }).estado).toBe(
      ESTADO_NFE.numeracaoInutilizada,
    );
    const recs = writes.filter((w) => w.path.startsWith('filiais/F-1/inutilizacao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.concluido);
    expect(recs[0]?.data.nProt).toBe('135200000088888');
  });

  it('cStat != 102 → persists an error inutilizacao record and flips nothing', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({
      events,
      nfev4ById: { rej: rangeNfev4(ESTADO_NFE.rejeitada, 7) },
    });
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(inutResult('563') as never);

    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoError);

    const recs = writes.filter((w) => w.path.startsWith('filiais/F-1/inutilizacao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.error);
    // No homologação → the in-range doc keeps its estado.
    expect((docs['pedidos/PED-1/nfev4/rej'] as { estado: string }).estado).toBe(
      ESTADO_NFE.rejeitada,
    );
  });

  it('reconciliation is filial-scoped: another filial sharing serie+número is untouched', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      nfev4ById: {
        mine: rangeNfev4(ESTADO_NFE.rejeitada, 7),
        foreign: rangeNfev4(ESTADO_NFE.rejeitada, 7, { filialId: 'F-2', chave: null }),
      },
    });
    vi.mocked(inutilizarNumeracaoSefaz).mockResolvedValue(inutResult('102') as never);

    const result = await inutilizarNumeracao(fs, fakeRuntime(), {
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });

    expect(result.reconciled).toBe(1);
    expect((docs['pedidos/PED-1/nfev4/mine'] as { estado: string }).estado).toBe(
      ESTADO_NFE.numeracaoInutilizada,
    );
    expect((docs['pedidos/PED-1/nfev4/foreign'] as { estado: string }).estado).toBe(
      ESTADO_NFE.rejeitada,
    );
  });

  it('throws NFeOrchestratorError on an inverted range (before any SEFAZ call)', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-1',
        serie: 9,
        nNFIni: 20,
        nNFFin: 10,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
    expect(inutilizarNumeracaoSefaz).not.toHaveBeenCalled();
  });

  it('throws NFeOrchestratorError when the filial is missing', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    await expect(
      inutilizarNumeracao(fs, fakeRuntime(), {
        filialId: 'F-NOPE',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
    expect(inutilizarNumeracaoSefaz).not.toHaveBeenCalled();
  });
});
