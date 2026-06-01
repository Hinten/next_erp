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
    // The orchestrator's SEFAZ round-trips. cUFFromUF / resolveTpEmis /
    // loadPedidoBundle stay real.
    cancelarNFe: vi.fn(),
    inutilizarNumeracao: vi.fn(),
    consultarSituacaoNFe: vi.fn(),
  };
});

import {
  cancelarNFe,
  consultarSituacaoNFe,
  inutilizarNumeracao as inutilizarNumeracaoSefaz,
  NFeInutilizacaoError,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import {
  cancelarPedido,
  inutilizarNumeracao,
  NFeCancelamentoError,
  NFeOrchestratorError,
} from '../../../lib/nfe/orchestrator';
import type { NFeRuntime } from '../../../lib/nfe/runtime';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

function fakeRuntime(): NFeRuntime {
  return {
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
    diagnostics: {
      subjectCommonName: 'TEST',
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
      chainSource: '/tmp/fake.pem',
    },
  };
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
};

interface FakeOpts {
  events: string[];
  /** Pre-existing nfev4 doc at pedidos/PED-1/nfev4/s1. `null` = absent. */
  nfev4?: Record<string, unknown> | null;
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

  const writes: { path: string; data: Record<string, unknown>; merge?: boolean }[] = [];
  let autoIdCounter = 0;

  function makeRef(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      async get() {
        const data = docs[path];
        return { exists: data != null, id: path.split('/').pop()!, ref: makeRef(path), data: () => data };
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
    | { kind: 'where'; field: string; op: 'array-contains'; value: unknown }
    | { kind: 'orderBy'; field: string; dir: 'asc' | 'desc' }
    | { kind: 'limit'; n: number };

  function makeQuery(path: string, ops: QueryOp[]) {
    return {
      where(field: string, op: 'array-contains', value: unknown) {
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
          .filter(([key, val]) => key.startsWith(prefix) && val != null && !key.slice(prefix.length).includes('/'))
          .map(([key, val]) => ({ id: key.slice(prefix.length), data: val as Record<string, unknown> }));
        for (const op of ops) {
          if (op.kind === 'where' && op.op === 'array-contains') {
            items = items.filter((it) => {
              const v = it.data[op.field];
              return Array.isArray(v) && v.includes(op.value);
            });
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
      where(field: string, op: 'array-contains', value: unknown) {
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

  return {
    fs: {
      collection: (name: string) => makeCollection(name),
      doc: (path: string) => makeRef(path),
      runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        const tx = {
          get: (ref: ReturnType<typeof makeRef>) => ref.get(),
          set: (ref: ReturnType<typeof makeRef>, data: Record<string, unknown>) => {
            writes.push({ path: ref.path, data });
            docs[ref.path] = data;
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
    ultima_modificacao: '2026-05-29T10:00:00.000Z',
  };
}

const RET_SIT_100 = {
  tpAmb: '2',
  verAplic: 'SP',
  cStat: '100',
  xMotivo: 'Autorizado o uso da NF-e',
  cUF: '35',
  dhRecbto: '2026-05-29T10:30:00-03:00',
  chNFe: CHAVE,
  versao: '4.00',
  protNFe: {
    versao: '4.00',
    infProt: {
      tpAmb: '2',
      verAplic: 'SP',
      chNFe: CHAVE,
      dhRecbto: '2026-05-29T10:30:00-03:00',
      nProt: '135200000000123',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    },
  },
} as const;

/** A consSit response for an NF-e that is NOT cancellable (already cancelled). */
const RET_SIT_101 = {
  ...RET_SIT_100,
  cStat: '101',
  xMotivo: 'Cancelamento de NF-e homologado',
  protNFe: {
    versao: '4.00',
    infProt: { ...RET_SIT_100.protNFe.infProt, cStat: '101', xMotivo: 'Cancelamento homologado' },
  },
} as const;

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
        xMotivo: cStat === '102' ? 'Inutilizacao de numero homologada' : 'Rejeicao: numero ja utilizado',
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('cancelarPedido', () => {
  beforeEach(() => {
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_SIT_100 as never);
  });

  it('cStat 135 → persists estado=cancelada + audit-logs both round-trips', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('135') as never);

    const result = await cancelarPedido(fs, fakeRuntime(), 'PED-1', 'Cancelamento por erro de digitacao');

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    expect(result.cStat).toBe('135');
    expect(result.chave).toBe(CHAVE);

    // Persisted estado='c' on the nfev4 doc.
    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(nfeWrite?.data.estado).toBe(ESTADO_NFE.cancelada);
    expect(nfeWrite?.data.cStat).toBe('135');

    // Two enviNfe audit records: the consulta + the cancelamento round-trip.
    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(2);

    expect(consultarSituacaoNFe).toHaveBeenCalledOnce();
    expect(cancelarNFe).toHaveBeenCalledOnce();
  });

  it('cStat 155 (fora de prazo) → also cancelada', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('155') as never);

    const result = await cancelarPedido(fs, fakeRuntime(), 'PED-1', 'Cancelamento fora de prazo ok');

    expect(result.estado).toBe(ESTADO_NFE.cancelada);
    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(nfeWrite?.data.estado).toBe(ESTADO_NFE.cancelada);
  });

  it('throws NFeCancelamentoError when the NF-e is not authorized (consulta cStat != 100)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_SIT_101 as never);

    await expect(
      cancelarPedido(fs, fakeRuntime(), 'PED-1', 'Tentando cancelar nf ja cancelada'),
    ).rejects.toBeInstanceOf(NFeCancelamentoError);

    // No cancelamento sent, and the nfev4 doc is untouched.
    expect(cancelarNFe).not.toHaveBeenCalled();
    expect(writes.some((w) => w.path === 'pedidos/PED-1/nfev4/s1')).toBe(false);
  });

  it('throws NFeCancelamentoError carrying cStat/xMotivo on a SEFAZ rejection (estado unchanged)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events, nfev4: aprovadaNfev4() });
    vi.mocked(cancelarNFe).mockResolvedValue(cancelResult('573') as never);

    const err = await cancelarPedido(
      fs,
      fakeRuntime(),
      'PED-1',
      'Cancelamento apos prazo legal',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NFeCancelamentoError);
    // The cStat + xMotivo ride along so the route/UI can show a clean message.
    expect((err as NFeCancelamentoError).cStat).toBe('573');
    expect((err as NFeCancelamentoError).xMotivo).toBe(
      'Rejeicao: NF-e fora do prazo de cancelamento',
    );
    expect(writes.some((w) => w.path === 'pedidos/PED-1/nfev4/s1')).toBe(false);
  });

  it('throws NFeOrchestratorError when there is no nfev4 doc', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events, nfev4: null });
    await expect(
      cancelarPedido(fs, fakeRuntime(), 'PED-1', 'Cancelamento sem nota emitida'),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
  });

  it('throws NFeOrchestratorError when the nfev4 doc has no chave', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      nfev4: { ...aprovadaNfev4(), chave: null },
    });
    await expect(
      cancelarPedido(fs, fakeRuntime(), 'PED-1', 'Cancelamento sem chave persistida'),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
  });
});

describe('inutilizarNumeracao (orchestrator)', () => {
  it('cStat 102 → returns the protocol + audit-logs + does NOT touch the counter', async () => {
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

    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(1);
    // The NFeConfig counter must be left alone (these números were skipped).
    expect(writes.some((w) => w.path === 'filiais/F-1/nfeconfig/default')).toBe(false);
  });

  it('cStat != 102 → throws NFeInutilizacaoError (still audit-logged)', async () => {
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

    const audits = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(audits).toHaveLength(1);
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
