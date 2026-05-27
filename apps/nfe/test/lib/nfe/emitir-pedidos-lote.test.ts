/**
 * `emitirPedidosLote` tests. Mocks the library's SOAP + generator +
 * signer surface (same pattern as `orchestrator.test.ts`) and backs
 * Firestore with a slim in-memory fake. Focused on the batch
 * orchestration contract: filial grouping, 20-pedido chunking,
 * shared idLote per chunk, per-pedido success/failure aggregation,
 * async polling, and the `jaAprovadas` skip-path mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    generateNFe: vi.fn(),
    signNFe: vi.fn(),
    autorizarLote: vi.fn(),
    consultarLote: vi.fn(),
    consultarSituacaoNFe: vi.fn(),
  };
});

import {
  autorizarLote,
  consultarLote,
  generateNFe,
  signNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import {
  emitirPedidosLote,
  NFeOrchestratorError,
} from '../../../lib/nfe/orchestrator';
import type { NFeRuntime } from '../../../lib/nfe/runtime';

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

function filialDoc(): Record<string, unknown> {
  return {
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
  };
}

function clienteDoc(): Record<string, unknown> {
  return {
    tipo: '1',
    nome: 'Distribuidora X LTDA',
    cpf_cnpj: '99999999000191',
    idEstrangeiro: null,
    ie: '222222222',
    imun: null,
    isUF: null,
    email: null,
  };
}

function enderecoDoc(): Record<string, unknown> {
  return {
    logradouro: 'Av B',
    numero: '1',
    bairro: 'Centro',
    cep: '01001000',
    codigoMunicipio: '3550308',
    cidade: 'Sao Paulo',
    estado: 'SP',
    complemento: null,
  };
}

function operacaoDoc(): Record<string, unknown> {
  return {
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
  };
}

interface PedidoSpec {
  readonly pedidoId: string;
  readonly filialId: string;
  /** If `true`, do not seed pedido.itens[*].imposto so the resolver path engages (not used in batch tests). */
  readonly noImposto?: boolean;
  /** Pre-existing nfev4 doc (used to test bloqueada short-circuit). */
  readonly existingNFe?: Record<string, unknown>;
}

function pedidoDoc(spec: PedidoSpec): Record<string, unknown> {
  return {
    ehSaida: true,
    estado: 'pago',
    itens: {
      'P-1': [
        {
          sku: `SKU-${spec.pedidoId}`,
          nomeDeVenda: 'Bicicleta',
          precoDeVenda: 1500,
          quantidade: 1,
          descontoUnitario: 0,
          imposto: impostoCsosn102(),
        },
      ],
    },
    filialPedidoOuterRef: `filiais/${spec.filialId}`,
    clientePedidoOuterRef: 'clientes/C-1',
    operacaoPedidoOuterRef: 'operacao/O-1',
    enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
  };
}

interface BatchHarnessOpts {
  readonly events: string[];
  readonly pedidos: ReadonlyArray<PedidoSpec>;
  /** Per-filial NFeConfig seed override. Defaults to `SEED_NFE_CONFIG`. */
  readonly nfeConfigByFilial?: Record<string, NFeConfig | null>;
}

/**
 * Slim Firestore fake — supports the operations emitirPedidosLote
 * needs: doc/get/set, collection().doc(), collection().get(),
 * collection().add(), runTransaction, and the where().array-contains
 * filter for the audit log lookup. No collection-group needed here
 * (processar-pendentes lives in its own test).
 */
function fakeFirestore(opts: BatchHarnessOpts) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'clientes/C-1': clienteDoc(),
    'clientes/C-1/enderecos/E-1': enderecoDoc(),
    'operacao/O-1': operacaoDoc(),
  };

  // Seed filiais + per-filial NFeConfig.
  const seededFiliais = new Set<string>();
  for (const spec of opts.pedidos) {
    if (!seededFiliais.has(spec.filialId)) {
      seededFiliais.add(spec.filialId);
      docs[`filiais/${spec.filialId}`] = filialDoc();
      const cfg = opts.nfeConfigByFilial?.[spec.filialId];
      const seed = cfg !== undefined ? cfg : SEED_NFE_CONFIG;
      docs[`filiais/${spec.filialId}/nfeconfig/default`] =
        seed === null
          ? null
          : (seed as unknown as Record<string, unknown>);
    }
  }
  // Seed pedidos + their pre-existing nfev4 docs.
  for (const spec of opts.pedidos) {
    docs[`pedidos/${spec.pedidoId}`] = pedidoDoc(spec);
    if (spec.existingNFe) {
      docs[`pedidos/${spec.pedidoId}/nfev4/s1`] = spec.existingNFe;
    }
  }

  const writes: { path: string; data: Record<string, unknown>; merge?: boolean }[] = [];
  let autoIdCounter = 0;

  type QueryOp =
    | { kind: 'where'; field: string; op: 'array-contains'; value: unknown }
    | { kind: 'orderBy'; field: string; dir: 'asc' | 'desc' }
    | { kind: 'limit'; n: number };

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
          .filter(
            ([key, val]) =>
              key.startsWith(prefix) && val != null && !key.slice(prefix.length).includes('/'),
          )
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
        const id = `auto-${autoIdCounter}`;
        const ref = makeRef(`${path}/${id}`);
        await ref.set(data);
        return ref;
      },
      where(field: string, op: 'array-contains', value: unknown) {
        return makeQuery(path, [{ kind: 'where', field, op, value }]);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(path, [...ops_seed(), { kind: 'orderBy', field, dir }]);
      },
      limit(n: number) {
        return makeQuery(path, [{ kind: 'limit', n }]);
      },
      get() {
        return makeQuery(path, []).get();
      },
    };
  }

  function ops_seed(): QueryOp[] {
    return [];
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
    },
    docs,
    writes,
  };
}

/** Build a deterministic 44-char chave the test fakes can pattern-match on. */
function fakeChave(nNF: number, cNF: number): string {
  // cUF(35) + AAMM(2605) + CNPJ(14200166000187) + mod(55) + serie(001)
  //   + nNF(9-padded) + tpEmis(1) + cNF(8-padded) + DV(8) = 44 chars.
  return (
    '352605' +
    '14200166000187' +
    '55' +
    '001' +
    String(nNF).padStart(9, '0') +
    '1' +
    String(cNF).padStart(8, '0') +
    '8'
  );
}

const generatedChaves: string[] = [];

function mockGenerateAndSign() {
  generatedChaves.length = 0;
  let cNF = 0;
  vi.mocked(generateNFe).mockImplementation((input) => {
    cNF += 1;
    const chave = fakeChave(input.numeracao, cNF);
    generatedChaves.push(chave);
    return {
      chave,
      nfeXml: `<NFe id="${chave}"/>`,
      infNFe: { chave } as never,
      digestValue: 'fake-digest',
      cleanInfo: '',
    } as never;
  });
  vi.mocked(signNFe).mockImplementation((nfeXml: string) => `<signed>${nfeXml}</signed>`);
}

function autorizarLoteSync(chaves: ReadonlyArray<string>): void {
  // For sync (single-NFe) chunks — retEnvi carries protNFe singular.
  vi.mocked(autorizarLote).mockImplementation(async (_call, _args) => {
    const chave = chaves[0]!;
    return {
      versao: '4.00',
      tpAmb: '2',
      verAplic: 'TEST',
      cStat: '104',
      xMotivo: 'Lote processado',
      cUF: '35',
      dhRecbto: new Date().toISOString(),
      protNFe: {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'TEST',
          chNFe: chave,
          dhRecbto: new Date().toISOString(),
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
          nProt: `135${chave.slice(0, 12)}`,
          digVal: 'fake-digval',
        },
      },
    } as never;
  });
}

function autorizarLoteAsync(nRec: string): void {
  // For async (N>1) chunks — retEnvi carries cStat=103 + nRec, no protNFe.
  vi.mocked(autorizarLote).mockResolvedValue({
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat: '103',
    xMotivo: 'Lote recebido com sucesso',
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    infRec: { nRec, tMed: '1' },
  } as never);
}

function consultarLoteResolves(chaves: ReadonlyArray<string>): void {
  vi.mocked(consultarLote).mockImplementation(async () => ({
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat: '104',
    xMotivo: 'Lote processado',
    cUF: '35',
    protNFe: chaves.map((ch, i) => ({
      versao: '4.00',
      infProt: {
        tpAmb: '2',
        verAplic: 'TEST',
        chNFe: ch,
        dhRecbto: new Date().toISOString(),
        cStat: '100',
        xMotivo: 'Autorizado o uso da NF-e',
        nProt: `135${ch.slice(0, 9)}${i}`,
        digVal: `dig-${i}`,
      },
    })),
  } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateAndSign();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('emitirPedidosLote — input validation', () => {
  it('throws on empty pedidoIds', async () => {
    const { fs } = fakeFirestore({ events: [], pedidos: [] });
    await expect(
      emitirPedidosLote(fs as never, fakeRuntime(), []),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
  });

  it('throws on >50 pedidoIds', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `PED-${i}`);
    const { fs } = fakeFirestore({ events: [], pedidos: [] });
    await expect(
      emitirPedidosLote(fs as never, fakeRuntime(), ids),
    ).rejects.toThrow(/MAX_PEDIDOS_PER_BATCH/);
  });
});

describe('emitirPedidosLote — single filial happy path', () => {
  it('single pedido routes through indSinc=1 path', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      pedidos: [{ pedidoId: 'PED-1', filialId: 'F-1' }],
    });
    autorizarLoteSync(['35260514200166000187550010000000001100000001']);
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-1']);
    expect(out.results).toHaveLength(1);
    const first = out.results[0]!;
    expect('estado' in first ? first.estado : null).toBe(ESTADO_NFE.aprovada);
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].indSinc).toBe('1');
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  });

  it('multi-pedido (single filial, no resolution drift) goes async + polls once', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-1', filialId: 'F-1' },
        { pedidoId: 'PED-2', filialId: 'F-1' },
        { pedidoId: 'PED-3', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    // Resolve the lote via the chaves the generateNFe mock pushed to
    // `generatedChaves` — captured at generate-time, no XML regex needed.
    vi.mocked(consultarLote).mockImplementation(async () => ({
      versao: '4.00',
      tpAmb: '2',
      verAplic: 'TEST',
      cStat: '104',
      xMotivo: 'Lote processado',
      cUF: '35',
      protNFe: generatedChaves.map((ch, i) => ({
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'TEST',
          chNFe: ch,
          dhRecbto: new Date().toISOString(),
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
          nProt: `135${i.toString().padStart(15, '0')}`,
          digVal: `dig-${i}`,
        },
      })),
    } as never));
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-1',
      'PED-2',
      'PED-3',
    ]);
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect('estado' in r ? r.estado : null).toBe(ESTADO_NFE.aprovada);
    }
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].indSinc).toBe('0');
    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
  });
});

describe('emitirPedidosLote — multi-filial fan-out', () => {
  it('groups by filial and fires one autorizarLote per filial-group', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-A', filialId: 'F-1' },
        { pedidoId: 'PED-B', filialId: 'F-2' },
      ],
    });
    // Both filiais get the single-pedido sync path.
    vi.mocked(autorizarLote).mockImplementation(async (_call, args) => {
      // Each filial-group emits 1 NFe → indSinc='1' → the protNFe
      // singular wraps the chave that was just generated for this call.
      // Look it up via `generatedChaves` rather than parsing the XML.
      const xml = args.NFe[0] ?? '';
      const chave = generatedChaves.find((c) => xml.includes(c)) ?? '';
      return {
        versao: '4.00',
        tpAmb: '2',
        verAplic: 'TEST',
        cStat: '104',
        xMotivo: 'Lote processado',
        cUF: '35',
        protNFe: {
          versao: '4.00',
          infProt: {
            tpAmb: '2',
            verAplic: 'TEST',
            chNFe: chave,
            dhRecbto: new Date().toISOString(),
            cStat: '100',
            xMotivo: 'Autorizado o uso da NF-e',
            nProt: `135${chave.slice(0, 12)}`,
            digVal: 'fake-digval',
          },
        },
      } as never;
    });
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-A',
      'PED-B',
    ]);
    expect(out.results).toHaveLength(2);
    expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(2);
  });
});

describe('emitirPedidosLote — partial-failure aggregation', () => {
  it('prepareEmission failure for one pedido lands as EmitError; the rest proceed', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-OK', filialId: 'F-1' },
        // PED-MISSING will not exist in the fake — prepareEmission's
        // loadPedidoBundle throws NFePedidoNotFoundError.
      ],
    });
    autorizarLoteSync(['35260514200166000187550010000000001100000001']);
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-OK',
      'PED-MISSING',
    ]);
    expect(out.results).toHaveLength(2);
    const okResult = out.results.find((r) => r.pedidoId === 'PED-OK')!;
    const missingResult = out.results.find((r) => r.pedidoId === 'PED-MISSING')!;
    expect('estado' in okResult ? okResult.estado : null).toBe(ESTADO_NFE.aprovada);
    expect('errorCode' in missingResult ? missingResult.errorCode : null).toBe(
      'NFePedidoNotFoundError',
    );
  });

  it('bloqueada nfev4 short-circuits as reused EmitResult (jaAprovadas bucket)', async () => {
    const events: string[] = [];
    const existingApproved = {
      numeracao: 5,
      serie: 1,
      tpEmis: '1',
      estado: ESTADO_NFE.aprovada,
      chave: '35260514200166000187550010000000005100000001',
      idLote: '1',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      nRec: 'OLD-NREC',
      retries: 0,
      data_emissao: new Date().toISOString(),
      data_autorizacao: new Date().toISOString(),
      xml_assinado: '<signed/>',
    };
    const { fs } = fakeFirestore({
      events,
      pedidos: [
        {
          pedidoId: 'PED-DONE',
          filialId: 'F-1',
          existingNFe: existingApproved,
        },
        { pedidoId: 'PED-NEW', filialId: 'F-1' },
      ],
    });
    autorizarLoteSync(['35260514200166000187550010000000001100000002']);
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-DONE',
      'PED-NEW',
    ]);
    const done = out.results.find((r) => r.pedidoId === 'PED-DONE')!;
    const fresh = out.results.find((r) => r.pedidoId === 'PED-NEW')!;
    expect('reused' in done ? done.reused : null).toBe(true);
    expect('reused' in fresh ? fresh.reused : null).toBe(false);
    // Only ONE entry in the autorizarLote NFe[] — bloqueada didn't ride.
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].NFe).toHaveLength(1);
  });
});
