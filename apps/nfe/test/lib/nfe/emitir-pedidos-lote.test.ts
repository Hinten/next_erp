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
    enviarEpec: vi.fn(),
  };
});

import {
  autorizarLote,
  consultarLote,
  enviarEpec,
  generateNFe,
  signNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import { emitirPedidosLote, NFeOrchestratorError } from '../../../lib/nfe/orchestrator';
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

/** Sentinel xProd that makes the generateNFe mock throw (simulates a raw
 * fiscal-field error that slips past flattenAndValidate). */
const FAIL_GEN_XPROD = '__FAIL_GEN__';

interface PedidoSpec {
  readonly pedidoId: string;
  readonly filialId: string;
  /** If `true`, do not seed pedido.itens[*].imposto so the resolver path engages (not used in batch tests). */
  readonly noImposto?: boolean;
  /** Pre-existing nfev4 doc (used to test bloqueada short-circuit). */
  readonly existingNFe?: Record<string, unknown>;
  /** If `true`, the item's xProd is the sentinel so generateNFe throws for this pedido. */
  readonly failGenerate?: boolean;
}

function pedidoDoc(spec: PedidoSpec): Record<string, unknown> {
  return {
    ehSaida: true,
    estado: 'pago',
    itens: {
      'P-1': [
        {
          sku: `SKU-${spec.pedidoId}`,
          nomeDeVenda: spec.failGenerate ? FAIL_GEN_XPROD : 'Bicicleta',
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
        seed === null ? null : (seed as unknown as Record<string, unknown>);
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
        opts.events.push(`get:${path}`);
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
        opts.events.push(`get:${path}`);
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
  let cNFCounter = 0;
  vi.mocked(generateNFe).mockImplementation((input) => {
    // Simulate a raw fiscal-field error for the sentinel pedido — this is
    // exactly the per-pedido failure that must NOT sink the whole chunk.
    if (input.itens.some((it) => it.xProd === FAIL_GEN_XPROD)) {
      throw new Error('generateNFe failed: fiscal field overflow (test)');
    }
    // Honor an explicit `input.cNF` (rejeitada-retry path) so the
    // regenerated chave matches the one already on the existing doc.
    const cNF = input.cNF != null ? Number(input.cNF) : ++cNFCounter;
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
  vi.mocked(consultarLote).mockImplementation(
    async () =>
      ({
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
      }) as never,
  );
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
    await expect(emitirPedidosLote(fs as never, fakeRuntime(), [])).rejects.toBeInstanceOf(
      NFeOrchestratorError,
    );
  });

  it('throws on >50 pedidoIds', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `PED-${i}`);
    const { fs } = fakeFirestore({ events: [], pedidos: [] });
    await expect(emitirPedidosLote(fs as never, fakeRuntime(), ids)).rejects.toThrow(
      /MAX_PEDIDOS_PER_BATCH/,
    );
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
    vi.mocked(consultarLote).mockImplementation(
      async () =>
        ({
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
        }) as never,
    );
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-1', 'PED-2', 'PED-3']);
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect('estado' in r ? r.estado : null).toBe(ESTADO_NFE.aprovada);
    }
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].indSinc).toBe('0');
    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
  });
});

describe('emitirPedidosLote — batch read dedup (PR-δ)', () => {
  it('reads a shared filial + operação (+ regraimposto) once across the batch', async () => {
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
    vi.mocked(consultarLote).mockImplementation(
      async () =>
        ({
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
        }) as never,
    );

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-1', 'PED-2', 'PED-3']);
    expect(out.results).toHaveLength(3);

    // The three pedidos share filial F-1 and operação O-1. Without the
    // batch read context each loadPedidoBundle would re-fetch them — the
    // context collapses those to a single read apiece. The per-pedido
    // pedido doc is still read three times (one per id).
    expect(events.filter((e) => e === 'get:filiais/F-1')).toHaveLength(1);
    expect(events.filter((e) => e === 'get:operacao/O-1')).toHaveLength(1);
    expect(events.filter((e) => e === 'get:operacao/O-1/regraimposto')).toHaveLength(1);
    expect(events.filter((e) => e === 'get:pedidos/PED-1')).toHaveLength(1);
    expect(events.filter((e) => e === 'get:pedidos/PED-2')).toHaveLength(1);
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
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-A', 'PED-B']);
    expect(out.results).toHaveLength(2);
    expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(2);
  });
});

describe('emitirPedidosLote — bulk numeração (PR-δ win #5)', () => {
  function consultarLoteResolvesGenerated(): void {
    vi.mocked(consultarLote).mockImplementation(
      async () =>
        ({
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
        }) as never,
    );
  }

  /** nNF lives at chave[25..34) for the test's fakeChave layout. */
  const nnfOf = (r: { pedidoId: string; chave?: string }): string | null =>
    r.chave ? r.chave.slice(25, 34) : null;

  it('advances numeracao_atual by the fresh count only — skip/reuse burn no nNF — and writes nfeconfig once', async () => {
    const events: string[] = [];
    const blockedExisting = {
      numeracao: 5,
      serie: 1,
      tpEmis: '1',
      estado: ESTADO_NFE.aprovada,
      chave: '35260514200166000187550010000000005100000001',
      idLote: '1',
      cStat: '100', // bloqueada → skip
      xMotivo: 'Autorizado o uso da NF-e',
      nRec: 'OLD',
      retries: 0,
      data_emissao: new Date().toISOString(),
      xml_assinado: '<signed/>',
    };
    const reuseExisting = {
      numeracao: 7,
      serie: 1,
      tpEmis: '1',
      estado: ESTADO_NFE.rejeitada,
      chave: '35260514200166000187550010000000007100000009',
      idLote: '3',
      cStat: '225', // not bloqueada → reuse numeração 7
      xMotivo: 'Rejeicao: Falha no Schema XML',
      nRec: null,
      retries: 0,
      data_emissao: new Date().toISOString(),
      xml_assinado: '<signed/>',
    };
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-FRESH', filialId: 'F-1' },
        { pedidoId: 'PED-BLOCKED', filialId: 'F-1', existingNFe: blockedExisting },
        { pedidoId: 'PED-REUSE', filialId: 'F-1', existingNFe: reuseExisting },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-FRESH',
      'PED-BLOCKED',
      'PED-REUSE',
    ]);

    // Only PED-FRESH is fresh → counter 0 → 1; PED-BLOCKED (skip) and
    // PED-REUSE (keeps nNF 7) consume nothing.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(1);
    // The whole chunk advances the counter in exactly one write (was one
    // idLote tx + one tx per pedido before PR-δ).
    expect(events.filter((e) => e === 'set:filiais/F-1/nfeconfig/default')).toHaveLength(1);

    const fresh = out.results.find((r) => r.pedidoId === 'PED-FRESH')!;
    const reuse = out.results.find((r) => r.pedidoId === 'PED-REUSE')!;
    const blocked = out.results.find((r) => r.pedidoId === 'PED-BLOCKED')!;
    expect(nnfOf(fresh)).toBe('000000001');
    expect(nnfOf(reuse)).toBe('000000007');
    expect('reused' in blocked ? blocked.reused : null).toBe(true);

    // PED-REUSE: the cNF baked into reuseExisting.chave (offsets [35,43))
    // must be forwarded to generateNFe so the regenerated chave is stable.
    const reuseCNF = reuseExisting.chave.slice(35, 43);
    const reuseGenCall = vi.mocked(generateNFe).mock.calls.find((c) => c[0]?.numeracao === 7);
    expect(reuseGenCall?.[0].cNF).toBe(reuseCNF);
    // PED-FRESH: no chave to preserve → cNF stays undefined and the
    // generator draws a fresh random one.
    const freshGenCall = vi.mocked(generateNFe).mock.calls.find((c) => c[0]?.numeracao === 1);
    expect(freshGenCall?.[0].cNF).toBeUndefined();
  });

  it('allocates contiguous fresh nNFs for an all-fresh chunk', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-1', filialId: 'F-1' },
        { pedidoId: 'PED-2', filialId: 'F-1' },
        { pedidoId: 'PED-3', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-1', 'PED-2', 'PED-3']);
    expect(out.results).toHaveLength(3);
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(3);
    expect(events.filter((e) => e === 'set:filiais/F-1/nfeconfig/default')).toHaveLength(1);
    const nnfs = out.results.map((r) => nnfOf(r)).sort();
    expect(nnfs).toEqual(['000000001', '000000002', '000000003']);
  });

  it('isolates a per-pedido generate/sign failure — the rest of the chunk still emits', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-GOOD', filialId: 'F-1' },
        { pedidoId: 'PED-BADGEN', filialId: 'F-1', failGenerate: true },
        { pedidoId: 'PED-GOOD2', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-GOOD',
      'PED-BADGEN',
      'PED-GOOD2',
    ]);

    expect(out.results).toHaveLength(3);
    const bad = out.results.find((r) => r.pedidoId === 'PED-BADGEN')!;
    const good = out.results.find((r) => r.pedidoId === 'PED-GOOD')!;
    const good2 = out.results.find((r) => r.pedidoId === 'PED-GOOD2')!;

    // The bad pedido is an isolated EmitError (generateNFe threw)...
    expect('errorCode' in bad).toBe(true);
    expect('estado' in bad).toBe(false);
    // ...while the other two still emit (the chunk is NOT sunk by one bad pedido).
    expect('estado' in good ? good.estado : null).toBe(ESTADO_NFE.aprovada);
    expect('estado' in good2 ? good2.estado : null).toBe(ESTADO_NFE.aprovada);
    // Only the two good NF-es rode the lote.
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].NFe).toHaveLength(2);
    // All three were fresh → the counter advanced by 3; the bad pedido's
    // nNF stays anchored in its placeholder doc for recovery.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(3);
    // The bad pedido's placeholder persists with its numeração but no chave
    // (the generate/sign step that would have stamped them threw).
    const badDoc = docs['pedidos/PED-BADGEN/nfev4/s1'] as {
      chave: unknown;
      numeracao: number;
    } | null;
    expect(badDoc?.chave).toBeNull();
    expect(badDoc?.numeracao).toBe(2);
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
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-OK', 'PED-MISSING']);
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
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-DONE', 'PED-NEW']);
    const done = out.results.find((r) => r.pedidoId === 'PED-DONE')!;
    const fresh = out.results.find((r) => r.pedidoId === 'PED-NEW')!;
    expect('reused' in done ? done.reused : null).toBe(true);
    expect('reused' in fresh ? fresh.reused : null).toBe(false);
    // Only ONE entry in the autorizarLote NFe[] — bloqueada didn't ride.
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].NFe).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EPEC contingency mode — no lote: each pedido's NF-e becomes its own EPEC
// evento at the Ambiente Nacional (one evento per envEvento in v1).
// ---------------------------------------------------------------------------

describe('emitirPedidosLote — contingência EPEC', () => {
  const EPEC_NFE_CONFIG: NFeConfig = {
    ...SEED_NFE_CONFIG,
    contingencia_modo: 'epec',
    contingencia_justificativa: 'SEFAZ-SP indisponível desde as 08h',
    contingencia_dataInicio: '2026-06-11T08:00:00.000Z',
  };

  const EPEC_CHAVE = '35260614200166000187550010000000091400000010';

  /** signNFe output parseable by the REAL extractEpecInputFromNFe. */
  const EPEC_SIGNED_NFE =
    '<NFe xmlns="http://www.portalfiscal.inf.br/nfe">' +
    `<infNFe Id="NFe${EPEC_CHAVE}" versao="4.00">` +
    '<ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>9</nNF>' +
    '<dhEmi>2026-06-11T08:30:00-03:00</dhEmi><tpNF>1</tpNF><tpEmis>4</tpEmis>' +
    '<tpAmb>2</tpAmb><verProc>erp-next 1.0</verProc></ide>' +
    '<emit><CNPJ>14200166000187</CNPJ><IE>111111111111</IE></emit>' +
    '<dest><CNPJ>99999999000191</CNPJ><enderDest><UF>SP</UF></enderDest><IE>222222222</IE></dest>' +
    '<total><ICMSTot><vICMS>0.00</vICMS><vST>0.00</vST><vNF>1500.00</vNF></ICMSTot></total>' +
    '</infNFe><Signature>…</Signature></NFe>';

  function epecResult(cStat: string) {
    return {
      ret: {
        idLote: '1',
        tpAmb: '2',
        verAplic: 'AN_EVENTOS',
        cOrgao: '91',
        cStat: '128',
        xMotivo: 'Lote de Evento Processado',
        versao: '1.00',
        retEvento: [
          {
            versao: '1.00',
            infEvento: {
              tpAmb: '2',
              verAplic: 'AN_EVENTOS',
              cOrgao: '91',
              cStat,
              xMotivo: 'Evento registrado',
              chNFe: EPEC_CHAVE,
              tpEvento: '110140',
              nSeqEvento: '1',
              dhRegEvento: '2026-06-11T08:31:00-03:00',
              nProt: '891260000012345',
            },
          },
        ],
      },
      signedEventoXml: '<evento>…</evento>',
      procEventoNFe: '<procEventoNFe>…EPEC…</procEventoNFe>',
      rawResponse: '<retEnvEvento>…</retEnvEvento>',
    };
  }

  it('fans out one EPEC evento per pedido — no autorizarLote, every result estado p', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-1', filialId: 'F-1' },
        { pedidoId: 'PED-2', filialId: 'F-1' },
      ],
      nfeConfigByFilial: { 'F-1': EPEC_NFE_CONFIG },
    });
    vi.mocked(signNFe).mockImplementation(() => EPEC_SIGNED_NFE);
    vi.mocked(enviarEpec).mockResolvedValue(epecResult('135') as never);

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-1', 'PED-2']);

    expect(vi.mocked(autorizarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(enviarEpec)).toHaveBeenCalledTimes(2);
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect('estado' in r ? r.estado : null).toBe(ESTADO_NFE.epecAprovado);
    }
    // The anchors live at the EPEC doc slot (s4) and carry tpEmis 4.
    expect((docs['pedidos/PED-1/nfev4/s4'] as { tpEmis: number }).tpEmis).toBe(4);
    expect((docs['pedidos/PED-1/nfev4/s4'] as { estado: string }).estado).toBe(
      ESTADO_NFE.epecAprovado,
    );
    expect(docs['pedidos/PED-1/nfev4/s1']).toBeUndefined();
  });

  it('skips an already EPEC-approved pedido (reports it; the transmission belongs to the poller)', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-PENDING', filialId: 'F-1' },
        { pedidoId: 'PED-NEW', filialId: 'F-1' },
      ],
      nfeConfigByFilial: { 'F-1': EPEC_NFE_CONFIG },
    });
    // Pre-existing approved EPEC at the s4 slot (the harness helper seeds s1,
    // so seed the EPEC slot directly).
    docs['pedidos/PED-PENDING/nfev4/s4'] = {
      numeracao: 5,
      serie: 1,
      tpEmis: 4,
      estado: ESTADO_NFE.epecAprovado,
      chave: EPEC_CHAVE,
      idLote: '2',
      cStat: '136',
      xMotivo: 'Evento registrado, mas nao vinculado a NF-e',
      nRec: null,
      retries: 0,
      data_emissao: new Date().toISOString(),
      xml_assinado: EPEC_SIGNED_NFE,
      xml_epec_proc: '<procEventoNFe>…</procEventoNFe>',
    };
    vi.mocked(signNFe).mockImplementation(() => EPEC_SIGNED_NFE);
    vi.mocked(enviarEpec).mockResolvedValue(epecResult('135') as never);

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-PENDING', 'PED-NEW']);

    // Only the fresh pedido sent an EPEC; the approved one was reported as-is.
    expect(vi.mocked(enviarEpec)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(autorizarLote)).not.toHaveBeenCalled();
    const pending = out.results.find((r) => r.pedidoId === 'PED-PENDING')!;
    const fresh = out.results.find((r) => r.pedidoId === 'PED-NEW')!;
    expect('reused' in pending ? pending.reused : null).toBe(true);
    expect('estado' in pending ? pending.estado : null).toBe(ESTADO_NFE.epecAprovado);
    expect('estado' in fresh ? fresh.estado : null).toBe(ESTADO_NFE.epecAprovado);
    // The approved EPEC's doc was not touched by the batch.
    expect(events.filter((e) => e === 'set:pedidos/PED-PENDING/nfev4/s4')).toHaveLength(0);
  });
});
