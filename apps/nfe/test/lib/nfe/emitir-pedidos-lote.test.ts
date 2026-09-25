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
  classifyCStat,
  consultarLote,
  consultarSituacaoNFe,
  enviarEpec,
  generateNFe,
  nextConsultaDelayMs,
  RECONCILE_SWEEP_GRACE_MS,
  signNFe,
  type CStatCategory,
  type NextAction,
} from '@delfrance/integrations-nfe';
import {
  CONTINGENCIA_MODO,
  AMBIENTE_NFE,
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  ESTADO_NFE,
  type EstadoNFe,
  type NFeConfig,
} from '@delfrance/schemas';

import {
  CONSUMO_INDEVIDO_ESPERA_MS,
  emitirPedido,
  emitirPedidosLote,
  NFeOrchestratorError,
  patchForLoteSemRecibo,
} from '../../../lib/nfe/orchestrator';
import type { NFeBaseRuntime, NFeRuntime } from '../../../lib/nfe/runtime';
import type { ConsultaTaskInput, TaskScheduler } from '../../../lib/nfe/tasks';
import { assertSignedXmlNeverLost } from '../../helpers/xml-invariant';

/** Fake Cloud Tasks scheduler that records what the orchestrator would enqueue. */
function recordingScheduler(): { scheduler: TaskScheduler; enqueued: ConsultaTaskInput[] } {
  const enqueued: ConsultaTaskInput[] = [];
  return {
    scheduler: {
      async enqueueConsulta(input) {
        enqueued.push(input);
      },
      async enqueueCceVinculo() {
        /* emit path never enqueues a CC-e re-check */
      },
    },
    enqueued,
  };
}

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

/**
 * An imposto that passes impostoSchema (every 900 member is optional) but that
 * the engine's XSD-group guard rejects: CSOSN 900 'ICMS próprio' opened
 * without modBC (#506).
 */
function impostoCsosn900Parcial(): Record<string, unknown> {
  return {
    ...impostoCsosn102(),
    configuracaoICMS: {
      crt: CRT.simplesNacional,
      csosn: CSOSN.outros,
      csosn900: { vBC: 1500, pICMS: 18, vICMS: 270 }, // no modBC
    },
  };
}

/**
 * Stamped imposto whose RTC config is a draft: no cClassTrib, no rates. It
 * passes impostoSchema; with the filial's RTC switch on, the engine rejects it
 * at build time (NFeTributeError → NFeOrchestratorError), with it off the
 * draft is never read.
 */
function impostoRtcRascunho(): Record<string, unknown> {
  return { ...impostoCsosn102(), configuracaoIBSCBS: { CST: '000' } };
}

/**
 * Stamped imposto whose PIS CST 49 carries BOTH rates. It passes impostoSchema
 * (confPISSchema has no pair rule), but PISOutr is an XSD choice —
 * `(vBC + pPIS)` or `(qBCProd + vAliqProd)` — so the engine refuses it at
 * build time (#509).
 */
function impostoPisAmbasAliquotas(): Record<string, unknown> {
  return {
    ...impostoCsosn102(),
    configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
  };
}

const SEED_NFE_CONFIG: NFeConfig = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: AMBIENTE_NFE.homologacao,
  emitirReformaTributaria: false,
  contingencia_modo: CONTINGENCIA_MODO.none,
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
  timestamp: null,
};

/** A filial in EPEC contingency: its NF-es are tpEmis 4 and live at the `s4` slot. */
const EPEC_NFE_CONFIG: NFeConfig = {
  ...SEED_NFE_CONFIG,
  contingencia_modo: CONTINGENCIA_MODO.epec,
  contingencia_justificativa: 'SEFAZ-SP indisponível desde as 08h',
  contingencia_dataInicio: new Date('2026-06-11T08:00:00.000Z').getTime(),
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
  /** Override for the item's stamped imposto; defaults to `impostoCsosn102()`. */
  readonly imposto?: Record<string, unknown>;
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
          imposto: spec.imposto ?? impostoCsosn102(),
        },
      ],
    },
    // Filial resolved via the pedido's integração (see bundle.ts).
    integracaoPedidoOuterRef: `integracao/I-${spec.filialId}`,
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
      docs[`integracao/I-${spec.filialId}`] = {
        nome: 'Canal Teste',
        tipo: 0,
        padrao: false,
        ativo: true,
        filialIntegracaoPedidoOuterRef: `filiais/${spec.filialId}`,
      };
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
        assertSignedXmlNeverLost(path, data, opt?.merge);
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
          // Identical write semantics to a direct ref.set (incl. the #128
          // anchor assert + merge handling) — delegate, don't re-implement.
          set: (
            ref: ReturnType<typeof makeRef>,
            data: Record<string, unknown>,
            setOpts?: { merge?: boolean },
          ) => {
            void ref.set(data, setOpts);
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

/**
 * An async (N>1) lote reply WITHOUT `infRec` (#512): SEFAZ answered but issued
 * no receipt — the lote itself was refused, or the reply is anomalous. `extra`
 * adds fields the XSD allows beside it (e.g. a stray `protNFe`).
 */
function autorizarLoteAsyncSemRecibo(
  cStat: string,
  xMotivo: string,
  extra: Record<string, unknown> = {},
): void {
  vi.mocked(autorizarLote).mockResolvedValue({
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat,
    xMotivo,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    ...extra,
  } as never);
}

beforeEach(() => {
  // Fixtures have no per-filial stored cert — emit with the env cert via the
  // fallback (per-filial resolution is covered in filial-cert.test.ts).
  process.env.NFE_CERT_ENV_FALLBACK = '1';
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
    const { fs, writes } = fakeFirestore({
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
    // #128 — the authorized member's proc write clears the anchor in the
    // very same payload.
    const procWrite = writes.find(
      (w) => w.path === 'pedidos/PED-1/nfev4/s1' && typeof w.data.xml_nfe_proc === 'string',
    );
    expect(procWrite).toBeDefined();
    expect(procWrite?.data.xml_assinado).toBeNull();
  });

  it('multi-pedido (single filial) hands off async without polling', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-1', filialId: 'F-1' },
        { pedidoId: 'PED-2', filialId: 'F-1' },
        { pedidoId: 'PED-3', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1'); // cStat=103, nRec=RECIBO-1, tMed='1'
    // Record each transaction's window over `writes` (the fake's tx.set lands
    // synchronously, so every write made while a callback runs falls inside).
    const txWindows: Array<readonly [number, number]> = [];
    const runTx = fs.runTransaction;
    fs.runTransaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const start = writes.length;
      try {
        return await runTx(fn);
      } finally {
        txWindows.push([start, writes.length]);
      }
    };
    const { scheduler, enqueued } = recordingScheduler();
    const before = Date.now();
    const out = await emitirPedidosLote(
      fs as never,
      fakeRuntime(),
      ['PED-1', 'PED-2', 'PED-3'],
      scheduler,
    );
    expect(out.results).toHaveLength(3);
    // Immediate hand-off: each pedido is aguardandoResposta with the receipt,
    // NOT polled to aprovada in-request.
    for (const r of out.results) {
      expect('estado' in r ? r.estado : null).toBe(ESTADO_NFE.aguardandoResposta);
      expect('nRec' in r ? r.nRec : null).toBe('RECIBO-1');
    }
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].indSinc).toBe('0');
    // The in-request poll is gone — the reconcile task does the consult.
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    // Exactly one reconcile task enqueued for the whole lote, at ~now + tMed.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ filialId: 'F-1', nRec: 'RECIBO-1', attempt: 0 });
    expect(enqueued[0]!.scheduleAtMs).toBeGreaterThanOrEqual(before + 1000);
    // Each doc persisted aguardandoResposta + nRec + a future proximaConsultaEm;
    // no <nfeProc> yet (authorization is confirmed later by the reconciler).
    for (const pedidoId of ['PED-1', 'PED-2', 'PED-3']) {
      const w = writes.find(
        (x) => x.path === `pedidos/${pedidoId}/nfev4/s1` && x.data.nRec === 'RECIBO-1',
      );
      expect(w).toBeDefined();
      expect(w?.data.estado).toBe(ESTADO_NFE.aguardandoResposta);
      expect(typeof w?.data.proximaConsultaEm).toBe('number');
      // #512 regression pin for the nRec path: exactly ONE merge write per doc
      // (the full-overwrite doc writes before the send are not merges),
      // carrying exactly this key set (captured on the pre-#512 code), plus the
      // single enqueue asserted above — and that merge lands OUTSIDE every
      // transaction, i.e. it is still the plain unguarded `persistPatch`, not
      // #512's `persistPatchUnlessFinal`.
      const merges = writes.filter((x) => x.path === `pedidos/${pedidoId}/nfev4/s1` && x.merge);
      expect(merges).toHaveLength(1);
      expect(Object.keys(merges[0]!.data).sort()).toEqual([
        'cStat',
        'estado',
        'nRec',
        'proximaConsultaEm',
        'retries',
        'ultima_modificacao',
        'xMotivo',
      ]);
      const at = writes.indexOf(merges[0]!);
      expect(txWindows.some(([start, end]) => at >= start && at < end)).toBe(false);
    }
    // Near-miss guard for the pin above: the allocation tx IS seen, and its
    // placeholder writes fall inside its window.
    expect(txWindows).toHaveLength(1);
    expect(txWindows[0]![1]).toBeGreaterThan(txWindows[0]![0]);
  });
});

describe('emitirPedidosLote — batch read dedup (PR-δ)', () => {
  it('reads a shared filial + operação (+ regras) once across the batch', async () => {
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
    expect(events.filter((e) => e === 'get:operacao/O-1/regras')).toHaveLength(1);
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

  it('#396: a crash-window member rides the lote with its STORED bytes — no regenerate', async () => {
    const events: string[] = [];
    const STORED_XML =
      '<NFe><infNFe Id="NFe35260514200166000187550010000000007100000009">…stored…</infNFe>' +
      '<Signature><SignedInfo><Reference><DigestValue>D==</DigestValue></Reference></SignedInfo></Signature></NFe>';
    const crashExisting = {
      numeracao: 7,
      serie: 1,
      tpEmis: '1',
      estado: ESTADO_NFE.enviando, // anchor committed, send/outcome lost
      chave: '35260514200166000187550010000000007100000009',
      idLote: '3',
      cStat: null,
      xMotivo: null,
      nRec: null,
      retries: 0,
      data_emissao: new Date().toISOString(),
      xml_assinado: STORED_XML,
    };
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-FRESH', filialId: 'F-1' },
        { pedidoId: 'PED-CRASH', filialId: 'F-1', existingNFe: crashExisting },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-FRESH', 'PED-CRASH']);

    // The stored bytes rode the lote verbatim; only the fresh member was generated.
    const loteArg = vi.mocked(autorizarLote).mock.calls[0]![1] as { NFe: readonly string[] };
    expect(loteArg.NFe).toContain(STORED_XML);
    expect(vi.mocked(generateNFe).mock.calls.some((call) => call[0]?.numeracao === 7)).toBe(false);
    expect(vi.mocked(generateNFe).mock.calls.some((call) => call[0]?.numeracao === 1)).toBe(true);
    // Counter advanced by the fresh count only; crash member consumed no nNF.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(1);
    // The crash member's doc kept its anchor and got the shared idLote stamped.
    const crashDoc = docs['pedidos/PED-CRASH/nfev4/s1'] as Record<string, unknown>;
    expect(crashDoc.xml_assinado).toBe(STORED_XML);
    expect(typeof crashDoc.idLote).toBe('string');
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
    // The lote is async (N=2) so they hand off as aguardandoResposta.
    expect('estado' in good ? good.estado : null).toBe(ESTADO_NFE.aguardandoResposta);
    expect('estado' in good2 ? good2.estado : null).toBe(ESTADO_NFE.aguardandoResposta);
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

  it('rejects an unbuildable tax config before allocation — no nNF consumed, no placeholder (#506)', async () => {
    // Contrast with the generate/sign failure above: an imposto that passes
    // impostoSchema but fails the engine's XSD-group guard (a partial CSOSN 900
    // 'ICMS próprio') is caught by the batch tribute pre-flight, and
    // runChunkAllocateTx fails the member BEFORE counting it as fresh — so the
    // counter advances by 2, not 3, and the bad pedido leaves no chave-less
    // placeholder behind.
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-GOOD', filialId: 'F-1' },
        { pedidoId: 'PED-BADTAX', filialId: 'F-1', imposto: impostoCsosn900Parcial() },
        { pedidoId: 'PED-GOOD2', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-GOOD',
      'PED-BADTAX',
      'PED-GOOD2',
    ]);

    expect(out.results).toHaveLength(3);
    const bad = out.results.find((r) => r.pedidoId === 'PED-BADTAX')!;
    expect('errorCode' in bad ? bad.errorCode : null).toBe('NFeOrchestratorError');
    expect('errorMessage' in bad ? bad.errorMessage : '').toMatch(
      /^pedido 'PED-BADTAX' item 0 \(produto 'P-1'\): .*CSOSN '900'.*ICMS próprio missing: modBC$/,
    );
    // No placeholder: the bad pedido was failed before it was counted as fresh.
    expect(docs['pedidos/PED-BADTAX/nfev4/s1']).toBeUndefined();
    expect(events.some((e) => e.startsWith('set:pedidos/PED-BADTAX/'))).toBe(false);
    // Only the two good pedidos were allocated, generated and sent.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(2);
    expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].NFe).toHaveLength(2);
    const goods = out.results.filter((r) => r.pedidoId !== 'PED-BADTAX');
    expect(goods.map((r) => nnfOf(r)).sort()).toEqual(['000000001', '000000002']);
  });

  it('rejects a both-rates PISOutr config before allocation — no nNF consumed, no placeholder (#509)', async () => {
    // The same pre-flight as the partial CSOSN 900 case above, reached by the
    // PIS/COFINS pair choice: the counter advances by 2 (not 3, as it does for
    // the generate/sign failure), and PED-BADPIS leaves no placeholder behind.
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-GOOD', filialId: 'F-1' },
        { pedidoId: 'PED-BADPIS', filialId: 'F-1', imposto: impostoPisAmbasAliquotas() },
        { pedidoId: 'PED-GOOD2', filialId: 'F-1' },
      ],
    });
    autorizarLoteAsync('RECIBO-1');
    consultarLoteResolvesGenerated();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
      'PED-GOOD',
      'PED-BADPIS',
      'PED-GOOD2',
    ]);

    expect(out.results).toHaveLength(3);
    const bad = out.results.find((r) => r.pedidoId === 'PED-BADPIS')!;
    expect('errorCode' in bad ? bad.errorCode : null).toBe('NFeOrchestratorError');
    const badMessage = 'errorMessage' in bad ? bad.errorMessage : '';
    expect(badMessage).toMatch(/^pedido 'PED-BADPIS' item 0 \(produto 'P-1'\): PIS CST=49/);
    expect(badMessage).toMatch(/not both/);
    // No placeholder: the bad pedido was failed before it was counted as fresh.
    expect(docs['pedidos/PED-BADPIS/nfev4/s1']).toBeUndefined();
    expect(events.some((e) => e.startsWith('set:pedidos/PED-BADPIS/'))).toBe(false);
    // Only the two good pedidos were allocated, generated and sent.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(2);
    expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(autorizarLote).mock.calls[0]?.[1].NFe).toHaveLength(2);
    const goods = out.results.filter((r) => r.pedidoId !== 'PED-BADPIS');
    expect(goods.map((r) => nnfOf(r)).sort()).toEqual(['000000001', '000000002']);
  });

  /**
   * The two unbuildable-config classes the batch pre-flight holds back (#506).
   * Both pass impostoSchema, so prep succeeds and only the engine finds out; the
   * mixed-batch verdict below must not depend on which one it is.
   */
  const UNBUILDABLE = [
    {
      what: 'a partial CSOSN 900 group',
      imposto: impostoCsosn900Parcial,
      emitRtc: false,
      reason: /CSOSN '900'.*ICMS próprio missing: modBC$/,
    },
    {
      what: 'a draft configuracaoIBSCBS with RTC on',
      imposto: impostoRtcRascunho,
      emitRtc: true,
      reason: /Invalid configuracaoIBSCBS \(RTC emission is on for this item\): /,
    },
  ];

  it.each(UNBUILDABLE)(
    'fails an unbuildable member ($what) only where it would regenerate — skip and stored-bytes members keep today’s behaviour (#506)',
    async ({ imposto, emitRtc, reason }) => {
      // Every member below except PED-FRESH resolves to the SAME unbuildable live
      // imposto (an unstamped item is re-resolved on every call, so a config
      // edited after emission gets here). Only PED-REJ would generate — its
      // rejeitada doc regenerates under its own numeração — so only PED-REJ may
      // fail; the others never build a projection.
      const events: string[] = [];
      const STORED_XML =
        `<NFe><infNFe Id="NFe${fakeChave(7, 9)}">…stored…</infNFe>` +
        '<Signature><SignedInfo><Reference><DigestValue>D==</DigestValue></Reference></SignedInfo></Signature></NFe>';
      const base = {
        serie: 1,
        tpEmis: '1',
        idLote: '3',
        retries: 0,
        data_emissao: new Date().toISOString(),
      };
      const { fs, docs } = fakeFirestore({
        events,
        pedidos: [
          { pedidoId: 'PED-FRESH', filialId: 'F-1' },
          {
            pedidoId: 'PED-CRASH',
            filialId: 'F-1',
            imposto: imposto(),
            existingNFe: {
              ...base,
              numeracao: 7,
              estado: ESTADO_NFE.enviando, // anchor committed, send/outcome lost
              chave: fakeChave(7, 9),
              cStat: null,
              xMotivo: null,
              nRec: null,
              xml_assinado: STORED_XML,
            },
          },
          {
            pedidoId: 'PED-BLOCKED',
            filialId: 'F-1',
            imposto: imposto(),
            existingNFe: {
              ...base,
              numeracao: 5,
              estado: ESTADO_NFE.aprovada,
              chave: fakeChave(5, 1),
              cStat: '100', // bloqueada → skip
              xMotivo: 'Autorizado o uso da NF-e',
              nRec: 'OLD',
              xml_assinado: null,
            },
          },
          {
            pedidoId: 'PED-INFLIGHT',
            filialId: 'F-1',
            imposto: imposto(),
            existingNFe: {
              ...base,
              numeracao: 6,
              estado: ESTADO_NFE.aguardandoResposta,
              chave: fakeChave(6, 2),
              cStat: null,
              xMotivo: null,
              nRec: 'RECIBO-OLD', // sent → skip, the reconciler confirms it
              xml_assinado: '<signed/>',
            },
          },
          {
            pedidoId: 'PED-REJ',
            filialId: 'F-1',
            imposto: imposto(),
            existingNFe: {
              ...base,
              numeracao: 8,
              estado: ESTADO_NFE.rejeitada,
              chave: fakeChave(8, 3),
              cStat: '225', // not bloqueada → reuse numeração 8 and REGENERATE
              xMotivo: 'Rejeicao: Falha no Schema XML',
              nRec: null,
              xml_assinado: '<signed/>',
            },
          },
          // An approved EPEC lives at the tpEmis-4 slot, which only a filial in
          // EPEC contingency addresses — so it sits on F-2 (its own chunk), and
          // its doc is seeded at `s4` below.
          { pedidoId: 'PED-EPEC', filialId: 'F-2', imposto: imposto() },
        ],
        nfeConfigByFilial: {
          'F-1': { ...SEED_NFE_CONFIG, emitirReformaTributaria: emitRtc },
          'F-2': { ...EPEC_NFE_CONFIG, emitirReformaTributaria: emitRtc },
        },
      });
      const EPEC_DOC = {
        ...base,
        numeracao: 9,
        tpEmis: 4,
        estado: ESTADO_NFE.epecAprovado,
        // cUF + AAMM + CNPJ + mod + serie + nNF 9 + tpEmis 4 + cNF + DV
        chave: '352606' + '14200166000187' + '55' + '001' + '000000009' + '4' + '00000004' + '8',
        cStat: '136',
        xMotivo: 'Evento registrado, mas nao vinculado a NF-e',
        nRec: null,
        xml_assinado: '<signed/>',
        xml_epec_proc: '<procEventoNFe>…</procEventoNFe>',
      };
      docs['pedidos/PED-EPEC/nfev4/s4'] = EPEC_DOC;
      autorizarLoteAsync('RECIBO-1');

      const out = await emitirPedidosLote(fs as never, fakeRuntime(), [
        'PED-FRESH',
        'PED-CRASH',
        'PED-BLOCKED',
        'PED-INFLIGHT',
        'PED-REJ',
        'PED-EPEC',
      ]);

      expect(out.results).toHaveLength(6);
      const byId = (id: string) => out.results.find((r) => r.pedidoId === id)!;
      // The skip members come back exactly as before: their persisted state.
      expect(byId('PED-BLOCKED')).toMatchObject({ estado: ESTADO_NFE.aprovada, reused: true });
      expect(byId('PED-INFLIGHT')).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        nRec: 'RECIBO-OLD',
        reused: true,
      });
      // The approved EPEC too — no error, no EPEC evento, no write, no nNF.
      expect(byId('PED-EPEC')).toMatchObject({ estado: ESTADO_NFE.epecAprovado, reused: true });
      expect('errorCode' in byId('PED-EPEC')).toBe(false);
      expect(vi.mocked(enviarEpec)).not.toHaveBeenCalled();
      expect(events.some((e) => e.startsWith('set:pedidos/PED-EPEC/'))).toBe(false);
      expect(docs['pedidos/PED-EPEC/nfev4/s4']).toBe(EPEC_DOC);
      expect(
        (docs['filiais/F-2/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
      ).toBe(0);
      // The crash-window member rode the lote with its STORED bytes.
      expect(byId('PED-CRASH')).toMatchObject({ estado: ESTADO_NFE.aguardandoResposta });
      expect('errorCode' in byId('PED-CRASH')).toBe(false);
      expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(1);
      const loteArg = vi.mocked(autorizarLote).mock.calls[0]![1] as { NFe: readonly string[] };
      expect(loteArg.NFe).toHaveLength(2);
      expect(loteArg.NFe).toContain(STORED_XML);
      expect((docs['pedidos/PED-CRASH/nfev4/s1'] as { xml_assinado: unknown }).xml_assinado).toBe(
        STORED_XML,
      );
      // Only the regenerating member fails, and it regenerates nothing.
      const rej = byId('PED-REJ');
      expect(rej).toMatchObject({ errorCode: 'NFeOrchestratorError' });
      const rejMessage = 'errorMessage' in rej ? rej.errorMessage : '';
      expect(rejMessage.startsWith("pedido 'PED-REJ' item 0 (produto 'P-1'): ")).toBe(true);
      expect(rejMessage).toMatch(reason);
      expect(events.some((e) => e.startsWith('set:pedidos/PED-REJ/'))).toBe(false);
      expect(docs['pedidos/PED-REJ/nfev4/s1']).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        numeracao: 8,
      });
      // Only PED-FRESH was generated and consumed an nNF.
      expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(generateNFe).mock.calls[0]![0].numeracao).toBe(1);
      expect(
        (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
      ).toBe(1);
    },
  );
});

describe('emitirPedidosLote — the tribute pre-flight honours the filial emitRtc (#506)', () => {
  it('RTC on: a draft configuracaoIBSCBS fails that member before allocation — no nNF, no placeholder', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-OK', filialId: 'F-1' },
        { pedidoId: 'PED-RTC', filialId: 'F-1', imposto: impostoRtcRascunho() },
      ],
      nfeConfigByFilial: { 'F-1': { ...SEED_NFE_CONFIG, emitirReformaTributaria: true } },
    });
    autorizarLoteAsync('RECIBO-1');

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-OK', 'PED-RTC']);

    expect(out.results).toHaveLength(2);
    const rtc = out.results.find((r) => r.pedidoId === 'PED-RTC')!;
    // parseRtcConfig throws the engine's NFeTributeError, so the draft is the
    // same operator-fixable per-item 400 as a partial CSOSN 900 group.
    expect(rtc).toMatchObject({ errorCode: 'NFeOrchestratorError' });
    expect('errorMessage' in rtc ? rtc.errorMessage : '').toMatch(
      /^pedido 'PED-RTC' item 0 \(produto 'P-1'\): Invalid configuracaoIBSCBS \(RTC emission is on for this item\): /,
    );
    // The verdict is CARRIED to the chunk transaction, which classified its
    // (absent) nfev4 doc first and failed it before counting it as fresh.
    expect(events).toContain('get:pedidos/PED-RTC/nfev4/s1');
    expect(events.some((e) => e.startsWith('set:pedidos/PED-RTC/'))).toBe(false);
    expect(docs['pedidos/PED-RTC/nfev4/s1']).toBeUndefined();
    // Only PED-OK consumed an nNF.
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(1);
    expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(1);
  });

  it('RTC off (near-miss): the same draft is never read — the pedido emits', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [{ pedidoId: 'PED-RTC', filialId: 'F-1', imposto: impostoRtcRascunho() }],
    });
    autorizarLoteAsync('RECIBO-1');

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-RTC']);

    expect(out.results).toHaveLength(1);
    expect('errorCode' in out.results[0]!).toBe(false);
    expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(1);
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(1);
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

// ---------------------------------------------------------------------------
// #512 — an async lote (indSinc='0') whose retEnviNFe carries NO infRec: SEFAZ
// answered but issued no receipt. Each member's outcome is persisted at emit
// time (patchForLoteSemRecibo → persistLoteSemRecibo); nothing is enqueued and
// no SEFAZ call is made beyond the lote itself.
// ---------------------------------------------------------------------------

describe('#512 — async lote reply without nRec', () => {
  const LOTE_PEDIDOS = ['PED-1', 'PED-2', 'PED-3'] as const;
  const nfePath = (pedidoId: string) => `pedidos/${pedidoId}/nfev4/s1`;

  /**
   * Every #512 case is an ASYNC lote to the homologação fake: the one
   * autorizarLote SefazCall carries tpAmb '2', the fake runtime's host and
   * indSinc '0' (a single NF-e would take the sync path instead).
   */
  function expectAsyncHomologacaoCall(): void {
    expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(1);
    const [call, args] = vi.mocked(autorizarLote).mock.calls[0]!;
    expect(call.tpAmb).toBe('2');
    expect(call.url.startsWith('https://example/')).toBe(true);
    expect(args.indSinc).toBe('0');
  }

  /** Emit three FRESH pedidos of one filial against a no-infRec reply. */
  async function emitThreeFresh(cStat: string, xMotivo: string) {
    const { fs, docs, writes } = fakeFirestore({
      events: [],
      pedidos: LOTE_PEDIDOS.map((pedidoId) => ({ pedidoId, filialId: 'F-1' })),
    });
    autorizarLoteAsyncSemRecibo(cStat, xMotivo);
    const { scheduler, enqueued } = recordingScheduler();
    const before = Date.now();
    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS], scheduler);
    const after = Date.now();
    const docOf = (pedidoId: string) => docs[nfePath(pedidoId)] as Record<string, unknown>;
    const resultOf = (pedidoId: string) => out.results.find((r) => r.pedidoId === pedidoId)!;
    /**
     * The #512 reply write: the ONE merge onto a fresh member's doc — the
     * placeholder and the generated doc before the send are full overwrites.
     */
    const replyWriteOf = (pedidoId: string) => {
      const merges = writes.filter((w) => w.path === nfePath(pedidoId) && w.merge);
      expect(merges).toHaveLength(1);
      return merges[0]!.data;
    };
    return { fs, out, docs, writes, enqueued, before, after, docOf, resultOf, replyWriteOf };
  }

  /** Every nfev4 write of the run (placeholders, generated docs, reply merges). */
  const nfev4Writes = (writes: ReadonlyArray<{ path: string; data: Record<string, unknown> }>) =>
    writes.filter((w) => w.path.includes('/nfev4/'));

  /** The estados a lote-level reply must never stamp on a member it says nothing about. */
  const ESTADOS_VEREDITO: ReadonlyArray<EstadoNFe> = [
    ESTADO_NFE.aprovada,
    ESTADO_NFE.cancelada,
    ESTADO_NFE.numeracaoInutilizada,
    ESTADO_NFE.rejeitada,
  ];

  /** No receipt → nothing to reconcile by recibo, and no in-request consSit fan-out. */
  function expectNoConsultNoEnqueue(enqueued: readonly ConsultaTaskInput[]): void {
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  }

  describe('patchForLoteSemRecibo (pure) — fresh vs stored-bytes member', () => {
    interface Esperado {
      readonly estado: EstadoNFe;
      readonly action: NextAction;
      readonly consultaDelayMs: number | null;
    }
    const EM_VOO: Esperado = {
      estado: ESTADO_NFE.enviando,
      action: 'recover-via-consulta',
      consultaDelayMs: null,
    };
    const ANCORA: Esperado = {
      estado: ESTADO_NFE.aguardandoResposta,
      action: 'recover-via-consulta',
      consultaDelayMs: null,
    };
    const REJEITADA: Esperado = {
      estado: ESTADO_NFE.rejeitada,
      action: 'done-rejected',
      consultaDelayMs: null,
    };
    const AGUARDANDO_POLL: Esperado = {
      estado: ESTADO_NFE.aguardandoResposta,
      action: 'poll-lote',
      consultaDelayMs: null,
    };
    const both = (e: Esperado) => ({ fresh: e, stored: e });
    /** A foreign receipt marker in xMotivo — must NEVER be lifted into nRec. */
    const MARKER = 'Rejeicao: Duplicidade de NF-e [nRec:351000000000123]';

    const TABELA: ReadonlyArray<{
      readonly cStat: string;
      readonly xMotivo?: string;
      readonly retries?: number;
      readonly fresh: Esperado;
      readonly stored: Esperado;
    }> = [
      // A received / pending / unknown lote stays awaiting SEFAZ either way.
      { cStat: '103', ...both(AGUARDANDO_POLL) },
      { cStat: '105', retries: 1, ...both(AGUARDANDO_POLL) },
      { cStat: '106', ...both(ANCORA) },
      // Serviço paralisado (SVC 113/114 included): conclusive for a fresh
      // member, never for a crash-window anchor.
      { cStat: '108', fresh: REJEITADA, stored: ANCORA },
      { cStat: '109', fresh: REJEITADA, stored: ANCORA },
      { cStat: '113', fresh: REJEITADA, stored: ANCORA },
      { cStat: '114', fresh: REJEITADA, stored: ANCORA },
      // NEAR-MISS of 108: 107 (serviço em operação) is an anomaly, not a refusal.
      { cStat: '107', ...both(EM_VOO) },
      // 656: a fresh member is error; an anchor waits out the ~1h throttle.
      {
        cStat: '656',
        fresh: { estado: ESTADO_NFE.error, action: 'backoff', consultaDelayMs: null },
        stored: {
          estado: ESTADO_NFE.aguardandoResposta,
          action: 'backoff',
          consultaDelayMs: CONSUMO_INDEVIDO_ESPERA_MS,
        },
      },
      // NEAR-MISS of 656: a generic rejection, no 1h wait.
      { cStat: '1656', fresh: REJEITADA, stored: ANCORA },
      // Per-NF-e verdicts as the LOTE cStat say nothing about any member —
      // never aprovada / cancelada / numeracaoInutilizada / rejeitada.
      ...['100', '150', '101', '151', '102', '110', '301', '302'].map((cStat) => ({
        cStat,
        ...both(EM_VOO),
      })),
      // NEAR-MISSES of 100/101/102/110: 4-digit codes are plain rejections.
      ...['1100', '1101', '1102', '1110'].map((cStat) => ({
        cStat,
        fresh: REJEITADA,
        stored: ANCORA,
      })),
      // NEAR-MISSES of the width rows on the other side: a cStat that is not
      // `TStat` ([0-9]{3,4}) at all — an empty `<cStat/>`, non-numeric text —
      // is an anomaly, never the generic 'rejeitada' classifyCStat files it
      // under (which would make a FRESH member número-reusing).
      ...['', 'abc'].map((cStat) => ({ cStat, ...both(EM_VOO) })),
      // Lote-level rejections (schema, certificate, ambiente, generic, 4-digit).
      ...['225', '215', '252', '280', '297', '999', '1115'].map((cStat) => ({
        cStat,
        fresh: REJEITADA,
        stored: ANCORA,
      })),
      // Anomalies carrying a [nRec:…] marker: the marker is NOT lifted.
      ...['104', '204', '539'].map((cStat) => ({ cStat, xMotivo: MARKER, ...both(EM_VOO) })),
    ];

    const CASOS = TABELA.flatMap((linha) =>
      (['fresh', 'stored'] as const).map((origem) => ({
        titulo: `${linha.cStat === '' ? '<cStat vazio>' : linha.cStat} (${origem}) → estado ${linha[origem].estado}`,
        cStat: linha.cStat,
        xMotivo: linha.xMotivo ?? `xMotivo do lote ${linha.cStat}`,
        retries: linha.retries ?? 0,
        storedBytes: origem === 'stored',
        esperado: linha[origem],
      })),
    );

    it('CONSUMO_INDEVIDO_ESPERA_MS is the ~1h consumo-indevido window', () => {
      expect(CONSUMO_INDEVIDO_ESPERA_MS).toBe(3_600_000);
    });

    it('the table reaches every CStatCategory (the switch is exhaustive by type; this pins it at runtime)', () => {
      // `satisfies Record<CStatCategory, 1>`: a new union member without a key
      // here fails TYPECHECK, so this list can never silently lag the union.
      const TODAS = Object.keys({
        autorizada: 1,
        cancelada: 1,
        inutilizada: 1,
        denegada: 1,
        'lote-recebido': 1,
        'lote-processado': 1,
        'lote-pendente': 1,
        'lote-nao-localizado': 1,
        'servico-em-operacao': 1,
        'servico-paralisado': 1,
        duplicidade: 1,
        'rejeitada-schema': 1,
        'rejeitada-certificado': 1,
        'rejeitada-ambiente': 1,
        'consumo-indevido': 1,
        rejeitada: 1,
      } satisfies Record<CStatCategory, 1>);
      const alcancadas = new Set(TABELA.map((l) => classifyCStat(l.cStat)));
      expect([...alcancadas].sort()).toEqual([...TODAS].sort());
    });

    it.each(CASOS)('$titulo', ({ cStat, xMotivo, retries, storedBytes, esperado }) => {
      const { patch, consultaDelayMs } = patchForLoteSemRecibo({ cStat, xMotivo }, { storedBytes });
      expect(patch).toEqual({
        estado: esperado.estado,
        cStat,
        xMotivo,
        retries,
        nRec: null,
        action: esperado.action,
        tMed: null,
      });
      expect(consultaDelayMs).toBe(esperado.consultaDelayMs);
    });
  });

  it('108 on an all-fresh lote → every member rejeitada with SEFAZ’s cStat/xMotivo; no consult, nothing enqueued', async () => {
    const X = 'Servico Paralisado Momentaneamente (curto prazo)';
    const { out, writes, enqueued, docOf, resultOf, replyWriteOf } = await emitThreeFresh('108', X);

    expectAsyncHomologacaoCall();
    const loteNFe = vi.mocked(autorizarLote).mock.calls[0]![1].NFe;
    expect(out.results).toHaveLength(3);
    for (const pedidoId of LOTE_PEDIDOS) {
      const doc = docOf(pedidoId);
      expect(resultOf(pedidoId)).toEqual({
        nfeId: 's1',
        pedidoId,
        estado: ESTADO_NFE.rejeitada,
        chave: doc.chave,
        nRec: null,
        cStat: '108',
        xMotivo: X,
        reused: false,
      });
      expect(doc).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        cStat: '108',
        xMotivo: X,
        retries: 0,
        proximaConsultaEm: null,
        nRec: null,
      });
      // The reply write adds no nRec key (no receipt exists) …
      expect(replyWriteOf(pedidoId)).not.toHaveProperty('nRec');
      // … and never touches the anchor: the doc still holds the exact bytes
      // the lote carried.
      expect(typeof doc.xml_assinado).toBe('string');
      expect(loteNFe).toContain(doc.xml_assinado);
    }
    // One enviNfe audit row per chave, recording the lote reply (no receipt).
    const auditRows = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(auditRows).toHaveLength(3);
    expect(auditRows.flatMap((w) => w.data.targetsChnfe as string[]).sort()).toEqual(
      LOTE_PEDIDOS.map((p) => docOf(p).chave as string).sort(),
    );
    for (const row of auditRows) {
      expect(row.data).toMatchObject({ cStat: '108', xMotivo: X, nRec: null, indSinc: '0' });
    }
    expectNoConsultNoEnqueue(enqueued);
  });

  it.each(['108', '109', '113', '114'])(
    'lote cStat %s (serviço paralisado, no infRec) → every fresh member rejeitada; persisted = returned estado',
    async (cStat) => {
      const { enqueued, docOf, resultOf } = await emitThreeFresh(
        cStat,
        `Servico paralisado (${cStat})`,
      );

      expectAsyncHomologacaoCall();
      for (const pedidoId of LOTE_PEDIDOS) {
        const r = resultOf(pedidoId);
        expect(r).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat, nRec: null });
        expect(docOf(pedidoId)).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat });
        expect(docOf(pedidoId).estado).toBe('estado' in r ? r.estado : null);
      }
      expectNoConsultNoEnqueue(enqueued);
    },
  );

  it('656 on an all-fresh lote → every member error, not scanned (proximaConsultaEm null); no consult, nothing enqueued', async () => {
    const X = 'Rejeicao: Consumo Indevido';
    const { enqueued, docOf, resultOf } = await emitThreeFresh('656', X);

    expectAsyncHomologacaoCall();
    for (const pedidoId of LOTE_PEDIDOS) {
      expect(resultOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '656',
        xMotivo: X,
        nRec: null,
        reused: false,
      });
      expect(docOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '656',
        xMotivo: X,
        proximaConsultaEm: null,
        nRec: null,
      });
    }
    expectNoConsultNoEnqueue(enqueued);
  });

  it.each([
    { cStat: '225', xMotivo: 'Rejeicao: Falha no Schema XML do lote de NFe' },
    { cStat: '252', xMotivo: 'Rejeicao: Ambiente informado diverge do Ambiente de recebimento' },
    { cStat: '999', xMotivo: 'Rejeicao: Erro nao catalogado (lote)' },
  ])(
    'unexpected lote rejection $cStat → every fresh member rejeitada, cStat/xMotivo persisted verbatim',
    async ({ cStat, xMotivo }) => {
      const { enqueued, docOf, resultOf } = await emitThreeFresh(cStat, xMotivo);

      expectAsyncHomologacaoCall();
      for (const pedidoId of LOTE_PEDIDOS) {
        expect(resultOf(pedidoId)).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat, xMotivo });
        expect(docOf(pedidoId)).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat,
          xMotivo,
          proximaConsultaEm: null,
        });
      }
      expectNoConsultNoEnqueue(enqueued);
    },
  );

  it('103 WITHOUT infRec → aguardandoResposta paced by buildPersistData’s own delay; nothing enqueued', async () => {
    const X = 'Lote recebido com sucesso';
    const { enqueued, before, after, docOf, resultOf } = await emitThreeFresh('103', X);
    // The real defaults buildPersistData applies: first-consult delay (no tMed)
    // plus the sweep grace.
    const esperaMs = nextConsultaDelayMs(0, null) + RECONCILE_SWEEP_GRACE_MS;

    expectAsyncHomologacaoCall();
    for (const pedidoId of LOTE_PEDIDOS) {
      expect(resultOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '103',
        nRec: null,
      });
      const doc = docOf(pedidoId);
      expect(doc).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '103',
        retries: 0,
        nRec: null,
      });
      expect(doc.proximaConsultaEm as number).toBeGreaterThanOrEqual((before + esperaMs) * 1000);
      expect(doc.proximaConsultaEm as number).toBeLessThanOrEqual((after + esperaMs) * 1000);
    }
    expectNoConsultNoEnqueue(enqueued);
  });

  it('105 WITHOUT infRec → aguardandoResposta with retries 1, paced as poll attempt 1; nothing enqueued', async () => {
    const X = 'Lote em processamento';
    const { enqueued, before, after, docOf, resultOf } = await emitThreeFresh('105', X);
    const esperaMs = nextConsultaDelayMs(1, null) + RECONCILE_SWEEP_GRACE_MS;

    expectAsyncHomologacaoCall();
    for (const pedidoId of LOTE_PEDIDOS) {
      expect(resultOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '105',
        nRec: null,
      });
      const doc = docOf(pedidoId);
      expect(doc).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '105',
        retries: 1,
        nRec: null,
      });
      expect(doc.proximaConsultaEm as number).toBeGreaterThanOrEqual((before + esperaMs) * 1000);
      expect(doc.proximaConsultaEm as number).toBeLessThanOrEqual((after + esperaMs) * 1000);
    }
    expectNoConsultNoEnqueue(enqueued);
  });

  it.each([
    // STATUS_BLOQUEADORES members: the recorded cStat makes a re-emit report
    // the doc instead of resending an unknown outcome.
    { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', reemissao: 'reportada' },
    { cStat: '101', xMotivo: 'Cancelamento de NF-e homologado', reemissao: 'reportada' },
    { cStat: '102', xMotivo: 'Inutilizacao de numero homologado', reemissao: 'reportada' },
    // NEAR-MISS: 110 is not a bloqueador, so the in-flight doc is a #396 anchor
    // — a re-emit retransmits the SAME bytes, never regenerates under the
    // possibly-denied número.
    { cStat: '110', xMotivo: 'Uso Denegado', reemissao: 'bytesGuardados' },
  ] as const)(
    'per-NF-e verdict $cStat as the LOTE cStat → every member stays enviando with it recorded; nothing final, no proc',
    async ({ cStat, xMotivo, reemissao }) => {
      const { fs, out, writes, enqueued, docOf, resultOf, replyWriteOf } = await emitThreeFresh(
        cStat,
        xMotivo,
      );

      expectAsyncHomologacaoCall();
      const loteNFe = vi.mocked(autorizarLote).mock.calls[0]![1].NFe;
      expect(out.results).toHaveLength(3);
      for (const pedidoId of LOTE_PEDIDOS) {
        const doc = docOf(pedidoId);
        expect(resultOf(pedidoId)).toEqual({
          nfeId: 's1',
          pedidoId,
          estado: ESTADO_NFE.enviando,
          chave: doc.chave,
          nRec: null,
          cStat,
          xMotivo,
          reused: false,
        });
        expect(doc).toMatchObject({
          estado: ESTADO_NFE.enviando,
          cStat,
          xMotivo,
          retries: 0,
          nRec: null,
          proximaConsultaEm: null,
          xml_nfe_proc: null,
        });
        expect(replyWriteOf(pedidoId)).not.toHaveProperty('nRec');
        expect(typeof doc.xml_assinado).toBe('string');
        expect(loteNFe).toContain(doc.xml_assinado);
      }
      expectNoConsultNoEnqueue(enqueued);

      // Re-emit the same pedidos (an operator retry, or a double click).
      const gerados = vi.mocked(generateNFe).mock.calls.length;
      const assinados = LOTE_PEDIDOS.map((p) => docOf(p).xml_assinado);
      const again = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS]);

      expect(again.results).toHaveLength(3);
      // Nothing is ever regenerated: no new bytes, no new número.
      expect(vi.mocked(generateNFe).mock.calls.length).toBe(gerados);
      if (reemissao === 'reportada') {
        // No blind resend of an unknown outcome: the recorded cStat blocks it.
        expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(1);
        for (const pedidoId of LOTE_PEDIDOS) {
          expect(again.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
            estado: ESTADO_NFE.enviando,
            cStat,
            reused: true,
          });
        }
      } else {
        expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(2);
        const segundoLote = vi.mocked(autorizarLote).mock.calls[1]![1].NFe;
        expect([...segundoLote].sort()).toEqual([...loteNFe].sort());
      }
      expect(LOTE_PEDIDOS.map((p) => docOf(p).xml_assinado)).toEqual(assinados);
      // Across BOTH runs no nfev4 write stamps a verdict or a proc.
      for (const w of nfev4Writes(writes)) {
        expect(ESTADOS_VEREDITO).not.toContain(w.data.estado);
        expect(w.data.xml_nfe_proc ?? null).toBeNull();
      }
    },
  );

  it.each([
    { cStat: '103', xMotivo: 'Lote recebido com sucesso', estado: ESTADO_NFE.aguardandoResposta },
    { cStat: '104', xMotivo: 'Lote processado', estado: ESTADO_NFE.enviando },
    { cStat: '105', xMotivo: 'Lote em processamento', estado: ESTADO_NFE.aguardandoResposta },
  ] as const)(
    'a no-receipt $cStat member is a STATUS_BLOQUEADORES doc: a re-emit on EITHER path reports it reused — no SEFAZ call, no regeneration',
    async ({ cStat, xMotivo, estado }) => {
      const { fs, writes, docOf } = await emitThreeFresh(cStat, xMotivo);
      // Precondition: the shape isCrashWindowAnchor would match (in flight, no
      // nRec, chave + anchor) — but with a bloqueador cStat recorded.
      for (const pedidoId of LOTE_PEDIDOS) {
        expect(docOf(pedidoId)).toMatchObject({ estado, cStat, nRec: null });
        expect(typeof docOf(pedidoId).chave).toBe('string');
        expect(typeof docOf(pedidoId).xml_assinado).toBe('string');
      }
      const gerados = vi.mocked(generateNFe).mock.calls.length;
      const assinados = LOTE_PEDIDOS.map((p) => docOf(p).xml_assinado);
      const escritas = writes.length;

      // Batch path (runChunkAllocateTx) …
      const lote = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS]);
      // … and the single-pedido path (runAllocateGenerateSignTx).
      const single = await emitirPedido(fs as never, fakeRuntime(), 'PED-1');

      for (const r of [...lote.results, single]) {
        // In flight + reused: the web dialog's "Em processamento", never a
        // fresh failure nor a success.
        expect('errorCode' in r).toBe(false);
        expect(r).toMatchObject({
          estado,
          cStat,
          xMotivo,
          nRec: null,
          chave: docOf(r.pedidoId).chave,
          reused: true,
        });
      }
      expect(lote.results).toHaveLength(3);
      // The lote of the FIRST run is the only SEFAZ call ever made.
      expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      // No regeneration and no write on any member: the anchors are untouched.
      expect(vi.mocked(generateNFe).mock.calls.length).toBe(gerados);
      expect(LOTE_PEDIDOS.map((p) => docOf(p).xml_assinado)).toEqual(assinados);
      expect(nfev4Writes(writes.slice(escritas))).toEqual([]);
    },
  );

  it('lote-level 204 whose xMotivo carries an [nRec:…] marker → the marker is never lifted into any nRec', async () => {
    const MARKER_NREC = '351000000000123';
    const X = `Rejeicao: Duplicidade de NF-e [nRec:${MARKER_NREC}]`;
    const { writes, enqueued, docOf, resultOf, replyWriteOf } = await emitThreeFresh('204', X);

    expectAsyncHomologacaoCall();
    for (const pedidoId of LOTE_PEDIDOS) {
      expect(resultOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.enviando,
        cStat: '204',
        xMotivo: X,
        nRec: null,
      });
      expect(docOf(pedidoId)).toMatchObject({
        estado: ESTADO_NFE.enviando,
        cStat: '204',
        xMotivo: X,
        nRec: null,
        proximaConsultaEm: null,
      });
      expect(replyWriteOf(pedidoId)).not.toHaveProperty('nRec');
    }
    // Not on a member doc, and not on an audit row either.
    expect(writes.some((w) => w.data.nRec === MARKER_NREC)).toBe(false);
    expectNoConsultNoEnqueue(enqueued);
  });

  it('a stray protNFe beside a lote-level 104 with no infRec is ignored — no member aprovada, no proc; one redacted warn', async () => {
    const { fs, docs, writes } = fakeFirestore({
      events: [],
      pedidos: LOTE_PEDIDOS.map((pedidoId) => ({ pedidoId, filialId: 'F-1' })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const PROT_XMOTIVO = 'Autorizado o uso da NF-e (protocolo avulso)';
    let alvo = '';
    vi.mocked(autorizarLote).mockImplementation(async (_call, args) => {
      // A protocol for the FIRST member only — smeared over the chunk it would
      // approve every member without a proc.
      alvo = generatedChaves.find((c) => args.NFe[0]!.includes(c)) ?? '';
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
            chNFe: alvo,
            dhRecbto: new Date().toISOString(),
            cStat: '100',
            xMotivo: PROT_XMOTIVO,
            nProt: '135000000000001',
            digVal: 'fake-digval',
          },
        },
      } as never;
    });
    const { scheduler, enqueued } = recordingScheduler();

    const out = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS], scheduler);

    expectAsyncHomologacaoCall();
    expect(alvo).toHaveLength(44);
    const loteNFe = vi.mocked(autorizarLote).mock.calls[0]![1].NFe;
    for (const pedidoId of LOTE_PEDIDOS) {
      const doc = docs[nfePath(pedidoId)] as Record<string, unknown>;
      // The LOTE's cStat (104) is recorded — never the protocol's 100.
      expect(doc).toMatchObject({
        estado: ESTADO_NFE.enviando,
        cStat: '104',
        xMotivo: 'Lote processado',
        xml_nfe_proc: null,
        nRec: null,
      });
      expect(typeof doc.xml_assinado).toBe('string');
      expect(loteNFe).toContain(doc.xml_assinado);
      expect(out.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
        estado: ESTADO_NFE.enviando,
        cStat: '104',
      });
    }
    for (const w of nfev4Writes(writes)) {
      expect(w.data.estado).not.toBe(ESTADO_NFE.aprovada);
      expect(w.data.xml_nfe_proc ?? null).toBeNull();
    }
    // apps/nfe rule 9: one single-template warn — cStat, idLote, count; never
    // the protocol's xMotivo nor its chave.
    const protWarns = warn.mock.calls
      .map((c) => c.map(String).join(' '))
      .filter((m) => m.includes('protNFe'));
    expect(protWarns).toHaveLength(1);
    expect(protWarns[0]).toContain('cStat=104');
    expect(protWarns[0]).not.toContain(PROT_XMOTIVO);
    expect(protWarns[0]).not.toContain(alvo);
    expectNoConsultNoEnqueue(enqueued);
  });

  it('WIDTH pin, not a SEFAZ scenario: a 4-digit lote cStat 1115 is persisted verbatim on every member and audit row', async () => {
    const X = 'Rejeicao: codigo de quatro digitos (pin de largura)';
    const { writes, enqueued, docOf, resultOf } = await emitThreeFresh('1115', X);

    expectAsyncHomologacaoCall();
    for (const pedidoId of LOTE_PEDIDOS) {
      expect(docOf(pedidoId)).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '1115' });
      expect(resultOf(pedidoId)).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '1115' });
    }
    const auditRows = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(auditRows).toHaveLength(3);
    for (const row of auditRows) expect(row.data.cStat).toBe('1115');
    expectNoConsultNoEnqueue(enqueued);
  });

  describe('processChunk → persistLoteSemRecibo wiring', () => {
    const STORED_CHAVE = '35260514200166000187550010000000007100000009';
    const STORED_XML =
      `<NFe><infNFe Id="NFe${STORED_CHAVE}">…stored…</infNFe>` +
      '<Signature><SignedInfo><Reference><DigestValue>D==</DigestValue></Reference></SignedInfo></Signature></NFe>';
    const PARALISADO = 'Servico Paralisado Momentaneamente (curto prazo)';

    /**
     * A FRESH pedido plus a #396 crash-window one (anchor committed, send /
     * outcome lost) — seeded like the bulk-numeração #396 test.
     */
    function seedMixedChunkPedidos(): PedidoSpec[] {
      return [
        { pedidoId: 'PED-FRESH', filialId: 'F-1' },
        {
          pedidoId: 'PED-CRASH',
          filialId: 'F-1',
          existingNFe: {
            numeracao: 7,
            serie: 1,
            tpEmis: '1',
            estado: ESTADO_NFE.enviando, // #396: anchor committed, send/outcome lost
            chave: STORED_CHAVE,
            idLote: '3',
            cStat: null,
            xMotivo: null,
            nRec: null,
            retries: 0,
            data_emissao: new Date().toISOString(),
            xml_assinado: STORED_XML,
          },
        },
      ];
    }
    function seedMixedChunk() {
      return fakeFirestore({ events: [], pedidos: seedMixedChunkPedidos() });
    }

    /** The async lote reply of the race cases: 108, no infRec. */
    function respostaParalisado(): never {
      return {
        versao: '4.00',
        tpAmb: '2',
        verAplic: 'TEST',
        cStat: '108',
        xMotivo: PARALISADO,
        cUF: '35',
        dhRecbto: new Date().toISOString(),
      } as never;
    }

    it.each([
      {
        cStat: '225',
        xMotivo: 'Rejeicao: Falha no Schema XML do lote de NFe',
        estadoFresh: ESTADO_NFE.rejeitada,
        esperaMs: nextConsultaDelayMs(0, null) + RECONCILE_SWEEP_GRACE_MS,
      },
      {
        cStat: '108',
        xMotivo: PARALISADO,
        estadoFresh: ESTADO_NFE.rejeitada,
        esperaMs: nextConsultaDelayMs(0, null) + RECONCILE_SWEEP_GRACE_MS,
      },
      {
        cStat: '656',
        xMotivo: 'Rejeicao: Consumo Indevido',
        estadoFresh: ESTADO_NFE.error,
        esperaMs: CONSUMO_INDEVIDO_ESPERA_MS,
      },
    ])(
      'only the STORED-bytes member stays an anchor on lote cStat $cStat — the fresh one takes the refusal',
      async ({ cStat, xMotivo, estadoFresh, esperaMs }) => {
        const { fs, docs, writes } = seedMixedChunk();
        autorizarLoteAsyncSemRecibo(cStat, xMotivo);
        const { scheduler, enqueued } = recordingScheduler();
        const before = Date.now();
        const out = await emitirPedidosLote(
          fs as never,
          fakeRuntime(),
          ['PED-FRESH', 'PED-CRASH'],
          scheduler,
        );
        const after = Date.now();

        expectAsyncHomologacaoCall();
        expect(vi.mocked(autorizarLote).mock.calls[0]![1].NFe).toContain(STORED_XML);
        // Only the fresh member was generated; the crash one never was.
        expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(generateNFe).mock.calls.some((c) => c[0]?.numeracao === 7)).toBe(false);

        const fresh = docs[nfePath('PED-FRESH')] as Record<string, unknown>;
        expect(fresh).toMatchObject({
          estado: estadoFresh,
          cStat,
          xMotivo,
          proximaConsultaEm: null,
        });
        expect(out.results.find((r) => r.pedidoId === 'PED-FRESH')).toMatchObject({
          estado: estadoFresh,
          cStat,
          xMotivo,
          nRec: null,
        });
        // No write on the anchor ever carried an nRec (no receipt exists).
        const crashWrites = writes.filter((w) => w.path === nfePath('PED-CRASH'));
        expect(crashWrites.length).toBeGreaterThan(0);
        expect(crashWrites.some((w) => 'nRec' in w.data)).toBe(false);

        const crash = docs[nfePath('PED-CRASH')] as Record<string, unknown>;
        expect(crash).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat,
          xMotivo,
          nRec: null,
          xml_assinado: STORED_XML,
        });
        expect(crash.proximaConsultaEm as number).toBeGreaterThanOrEqual(
          (before + esperaMs) * 1000,
        );
        expect(crash.proximaConsultaEm as number).toBeLessThanOrEqual((after + esperaMs) * 1000);
        expect(out.results.find((r) => r.pedidoId === 'PED-CRASH')).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat,
          nRec: null,
        });
        expectNoConsultNoEnqueue(enqueued);
      },
    );

    it('108 on a REGENERATED reuse member + a crash-window member → the reuse one ends rejeitada with its NEW bytes, the anchor keeps its STORED bytes', async () => {
      // A REUSE member (rejeitada earlier → regenerated under its own número
      // and cNF), seeded like the bulk-numeração reuse test.
      const REUSE_CHAVE = fakeChave(5, 42);
      const OLD_XML = `<NFe><infNFe Id="NFe${REUSE_CHAVE}">…rejected bytes…</infNFe></NFe>`;
      const { fs, docs } = fakeFirestore({
        events: [],
        pedidos: [
          {
            pedidoId: 'PED-REUSE',
            filialId: 'F-1',
            existingNFe: {
              numeracao: 5,
              serie: 1,
              tpEmis: '1',
              estado: ESTADO_NFE.rejeitada,
              chave: REUSE_CHAVE,
              idLote: '2',
              cStat: '225', // not bloqueada → regenerate, reusing nNF 5 + cNF
              xMotivo: 'Rejeicao: Falha no Schema XML',
              nRec: null,
              retries: 0,
              data_emissao: new Date().toISOString(),
              xml_assinado: OLD_XML,
            },
          },
          ...seedMixedChunkPedidos().filter((p) => p.pedidoId === 'PED-CRASH'),
        ],
      });
      autorizarLoteAsyncSemRecibo('108', PARALISADO);
      const { scheduler, enqueued } = recordingScheduler();

      const out = await emitirPedidosLote(
        fs as never,
        fakeRuntime(),
        ['PED-REUSE', 'PED-CRASH'],
        scheduler,
      );

      expectAsyncHomologacaoCall();
      // Only the reuse member was regenerated — under its OWN nNF and cNF.
      expect(vi.mocked(generateNFe)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(generateNFe).mock.calls[0]![0]).toMatchObject({
        numeracao: 5,
        cNF: REUSE_CHAVE.slice(35, 43),
      });
      expect(generatedChaves).toEqual([REUSE_CHAVE]);
      const reuse = docs[nfePath('PED-REUSE')] as Record<string, unknown>;
      const novosBytes = reuse.xml_assinado as string;
      expect(novosBytes).not.toBe(OLD_XML);
      // The lote carried the NEW reuse bytes and the anchor's STORED ones.
      expect([...vi.mocked(autorizarLote).mock.calls[0]![1].NFe].sort()).toEqual(
        [novosBytes, STORED_XML].sort(),
      );
      // Its new bytes were never sent before, so the refusal is conclusive for
      // it: rejeitada, keeping the NEW bytes — never the old ones back.
      expect(reuse).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        cStat: '108',
        xMotivo: PARALISADO,
        numeracao: 5,
        chave: REUSE_CHAVE,
        nRec: null,
        proximaConsultaEm: null,
      });
      expect(out.results.find((r) => r.pedidoId === 'PED-REUSE')).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        chave: REUSE_CHAVE,
        cStat: '108',
        nRec: null,
        reused: false,
      });
      // The crash-window member (near-miss: same reply, same fresh-looking
      // shape) stays an anchor with the bytes it was sent with.
      const crash = docs[nfePath('PED-CRASH')] as Record<string, unknown>;
      expect(crash).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '108',
        nRec: null,
      });
      expect(crash.xml_assinado).toBe(STORED_XML);
      expect(out.results.find((r) => r.pedidoId === 'PED-CRASH')).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '108',
        reused: false,
      });
      // Neither member took a fresh número.
      expect(
        (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
      ).toBe(0);
      expectNoConsultNoEnqueue(enqueued);
    });

    it('a member a NEWER lote re-stamped mid-flight is not written — its result is the live doc (reused), receipt included', async () => {
      const { fs, docs } = fakeFirestore({
        events: [],
        pedidos: LOTE_PEDIDOS.map((pedidoId) => ({ pedidoId, filialId: 'F-1' })),
      });
      let restamped: Record<string, unknown> | null = null;
      vi.mocked(autorizarLote).mockImplementation(async () => {
        // A concurrent re-emit retransmitted PED-3 in ANOTHER lote while this
        // one was in flight — and that lote got a receipt.
        restamped = {
          ...docs[nfePath('PED-3')],
          idLote: '999',
          estado: ESTADO_NFE.aguardandoResposta,
          cStat: '103',
          xMotivo: 'Lote recebido com sucesso',
          nRec: 'OUTRO',
        };
        docs[nfePath('PED-3')] = restamped;
        return respostaParalisado();
      });
      const { scheduler, enqueued } = recordingScheduler();

      const out = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS], scheduler);

      expectAsyncHomologacaoCall();
      expect(restamped).not.toBeNull();
      expect(docs[nfePath('PED-3')]).toBe(restamped);
      // The live doc belongs to the OTHER lote's run, so it is reported the way
      // the dedup branch reports a doc it did not write (`reused: true`). The
      // web dialog buckets on exactly these fields: no errorCode, the estado,
      // and `reused`.
      const skipped = out.results.find((r) => r.pedidoId === 'PED-3')!;
      expect('errorCode' in skipped).toBe(false);
      expect(skipped).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '103',
        nRec: 'OUTRO',
        reused: true,
      });
      // Members still on this chunk's idLote are written — and they ARE this
      // run's outcome (near-miss of the skipped member).
      for (const pedidoId of ['PED-1', 'PED-2']) {
        expect(docs[nfePath(pedidoId)]).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat: '108',
        });
        expect(out.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          reused: false,
        });
      }
      expectNoConsultNoEnqueue(enqueued);
    });

    it('656: the anchor’s 1 h pacing binds only the sweep — an immediate operator re-emit retransmits its STORED bytes and gets a receipt', async () => {
      const { fs, docs } = seedMixedChunk();
      autorizarLoteAsyncSemRecibo('656', 'Rejeicao: Consumo Indevido');
      const { scheduler, enqueued } = recordingScheduler();
      const before = Date.now();
      await emitirPedidosLote(fs as never, fakeRuntime(), ['PED-FRESH', 'PED-CRASH'], scheduler);
      const after = Date.now();

      expect(docs[nfePath('PED-FRESH')]).toMatchObject({
        estado: ESTADO_NFE.error,
        cStat: '656',
        proximaConsultaEm: null,
      });
      const crash = docs[nfePath('PED-CRASH')] as Record<string, unknown>;
      expect(crash).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '656',
        nRec: null,
        xml_assinado: STORED_XML,
      });
      expect(crash.proximaConsultaEm as number).toBeGreaterThanOrEqual(
        (before + CONSUMO_INDEVIDO_ESPERA_MS) * 1000,
      );
      expect(crash.proximaConsultaEm as number).toBeLessThanOrEqual(
        (after + CONSUMO_INDEVIDO_ESPERA_MS) * 1000,
      );
      expect(enqueued).toEqual([]);

      // The operator re-emits right away: the emit path does NOT wait out the
      // anchor's `proximaConsultaEm` (that gates the sweep's consult only), so
      // the stored bytes go out again at once.
      autorizarLoteAsync('RECIBO-2');
      const again = await emitirPedidosLote(
        fs as never,
        fakeRuntime(),
        ['PED-FRESH', 'PED-CRASH'],
        scheduler,
      );

      expect(vi.mocked(autorizarLote)).toHaveBeenCalledTimes(2);
      const segundo = vi.mocked(autorizarLote).mock.calls[1]![1];
      expect(segundo.idLote).toBe('2');
      expect(segundo.NFe).toContain(STORED_XML);
      // The anchor was never regenerated — in either run.
      expect(vi.mocked(generateNFe).mock.calls.some((c) => c[0]?.numeracao === 7)).toBe(false);
      expect(docs[nfePath('PED-CRASH')]).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        nRec: 'RECIBO-2',
        idLote: '2',
        xml_assinado: STORED_XML,
      });
      expect(again.results.find((r) => r.pedidoId === 'PED-CRASH')).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        nRec: 'RECIBO-2',
        reused: false,
      });
      // The error member regenerated under its OWN número — no second nNF.
      expect(
        (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
      ).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ filialId: 'F-1', nRec: 'RECIBO-2', attempt: 0 });
    });

    it('a member that went FINAL mid-flight (aprovada + proc) is not overwritten — its result is aprovada, reused (never this run’s success)', async () => {
      const { fs, docs, writes } = fakeFirestore({
        events: [],
        pedidos: LOTE_PEDIDOS.map((pedidoId) => ({ pedidoId, filialId: 'F-1' })),
      });
      const PROC = '<nfeProc>…PED-2…</nfeProc>';
      let aprovadoEm = -1;
      vi.mocked(autorizarLote).mockImplementation(async () => {
        // A concurrent consSit authorized PED-2 and swapped its anchor for the
        // proc while this lote was in flight. idLote is UNCHANGED, so only the
        // final-estado guard can refuse the write (near-miss of the re-stamp race).
        docs[nfePath('PED-2')] = {
          ...docs[nfePath('PED-2')],
          estado: ESTADO_NFE.aprovada,
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
          xml_nfe_proc: PROC,
          xml_assinado: null,
        };
        aprovadoEm = writes.length;
        return respostaParalisado();
      });
      const { scheduler, enqueued } = recordingScheduler();

      const out = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS], scheduler);

      expectAsyncHomologacaoCall();
      expect(aprovadoEm).toBeGreaterThanOrEqual(0);
      expect(writes.slice(aprovadoEm).some((w) => w.path === nfePath('PED-2'))).toBe(false);
      expect(docs[nfePath('PED-2')]).toMatchObject({
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        idLote: '1',
        xml_nfe_proc: PROC,
        xml_assinado: null,
      });
      // A concurrent run authorized it, so this run reports it `reused` — the
      // web dialog then buckets it "Não emitidas", never "Sucesso" (its
      // classifyEmitResult reads exactly: no errorCode, estado, reused).
      const skipped = out.results.find((r) => r.pedidoId === 'PED-2')!;
      expect('errorCode' in skipped).toBe(false);
      expect(skipped).toMatchObject({
        estado: ESTADO_NFE.aprovada,
        cStat: '100',
        nRec: null,
        reused: true,
      });
      for (const pedidoId of ['PED-1', 'PED-3']) {
        expect(docs[nfePath(pedidoId)]).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat: '108',
        });
        expect(out.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat: '108',
          reused: false,
        });
      }
      expectNoConsultNoEnqueue(enqueued);
    });

    it('a member whose doc VANISHED mid-flight fails typed (NFeOrchestratorError) and is not resurrected — the others persist', async () => {
      const { fs, docs, writes } = fakeFirestore({
        events: [],
        pedidos: LOTE_PEDIDOS.map((pedidoId) => ({ pedidoId, filialId: 'F-1' })),
      });
      let apagadoEm = -1;
      vi.mocked(autorizarLote).mockImplementation(async () => {
        delete docs[nfePath('PED-2')];
        apagadoEm = writes.length;
        return respostaParalisado();
      });
      const { scheduler, enqueued } = recordingScheduler();

      const out = await emitirPedidosLote(fs as never, fakeRuntime(), [...LOTE_PEDIDOS], scheduler);

      expectAsyncHomologacaoCall();
      expect(out.results).toHaveLength(3);
      const perdido = out.results.find((r) => r.pedidoId === 'PED-2')!;
      expect(perdido).toMatchObject({ pedidoId: 'PED-2', errorCode: 'NFeOrchestratorError' });
      expect('estado' in perdido).toBe(false);
      expect('errorMessage' in perdido ? perdido.errorMessage : '').toMatch(
        /pedidos\/PED-2\/nfev4\/s1 ausente ao gravar o retorno do lote 1 /,
      );
      // No partial doc minted by a merge onto the missing path.
      expect(apagadoEm).toBeGreaterThanOrEqual(0);
      expect(nfePath('PED-2') in docs).toBe(false);
      expect(writes.slice(apagadoEm).some((w) => w.path === nfePath('PED-2'))).toBe(false);
      for (const pedidoId of ['PED-1', 'PED-3']) {
        expect(docs[nfePath(pedidoId)]).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat: '108',
        });
        expect(out.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
          estado: ESTADO_NFE.rejeitada,
          cStat: '108',
          nRec: null,
        });
      }
      expectNoConsultNoEnqueue(enqueued);
    });
  });

  it('#506 × #512: an unbuildable member is still diverted before allocation when the lote reply has no receipt (108)', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({
      events,
      pedidos: [
        { pedidoId: 'PED-GOOD', filialId: 'F-1' },
        { pedidoId: 'PED-BADTAX', filialId: 'F-1', imposto: impostoCsosn900Parcial() },
        { pedidoId: 'PED-GOOD2', filialId: 'F-1' },
      ],
    });
    const X = 'Servico Paralisado Momentaneamente (curto prazo)';
    autorizarLoteAsyncSemRecibo('108', X);
    const { scheduler, enqueued } = recordingScheduler();

    const out = await emitirPedidosLote(
      fs as never,
      fakeRuntime(),
      ['PED-GOOD', 'PED-BADTAX', 'PED-GOOD2'],
      scheduler,
    );

    expect(out.results).toHaveLength(3);
    // The pre-flight verdict (#506) is untouched by the #512 branch.
    const bad = out.results.find((r) => r.pedidoId === 'PED-BADTAX')!;
    expect(bad).toMatchObject({ errorCode: 'NFeOrchestratorError' });
    expect('estado' in bad).toBe(false);
    expect('errorMessage' in bad ? bad.errorMessage : '').toMatch(
      /^pedido 'PED-BADTAX' item 0 \(produto 'P-1'\): .*CSOSN '900'.*ICMS próprio missing: modBC$/,
    );
    expect(docs[nfePath('PED-BADTAX')]).toBeUndefined();
    expect(events.some((e) => e.startsWith('set:pedidos/PED-BADTAX/'))).toBe(false);
    expect(
      (docs['filiais/F-1/nfeconfig/default'] as { numeracao_atual: number }).numeracao_atual,
    ).toBe(2);
    // The two buildable members rode ONE async lote and took the #512 disposition.
    expectAsyncHomologacaoCall();
    expect(vi.mocked(autorizarLote).mock.calls[0]![1].NFe).toHaveLength(2);
    for (const pedidoId of ['PED-GOOD', 'PED-GOOD2']) {
      expect(docs[nfePath(pedidoId)]).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        cStat: '108',
        xMotivo: X,
        nRec: null,
        proximaConsultaEm: null,
      });
      expect(out.results.find((r) => r.pedidoId === pedidoId)).toMatchObject({
        estado: ESTADO_NFE.rejeitada,
        cStat: '108',
        nRec: null,
        reused: false,
      });
    }
    expectNoConsultNoEnqueue(enqueued);
  });
});
