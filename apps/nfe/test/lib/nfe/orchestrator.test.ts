/**
 * Orchestrator tests — vi.mock the library's SOAP/generator/signer
 * surface and back the Admin SDK with an in-memory Firestore so the
 * flow runs end-to-end without network or filesystem.
 *
 * Two critical assertions for this PR:
 *   - **persist-before-send**: the doc-write spy MUST be called before
 *     the autorizarLote spy.
 *   - **no magic-string fallbacks**: every missing fiscal field surfaces
 *     as a typed error naming the exact item.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    // The IO-bound library calls the orchestrator makes. nextNumeracao,
    // nextIdLote, and buildImpostoXml stay real — those are the
    // numeração + tribute paths we want exercised end-to-end here.
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
  consultarSituacaoNFe,
  generateNFe,
  signNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import {
  consultarPedido,
  emitirPedido,
  NFeBlockedError,
  NFeMissingImpostoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
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

/** Build a valid Imposto blob (Simples Nacional CSOSN 102) for an item. */
function impostoCsosn102(): Record<string, unknown> {
  return {
    origem: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '87120000',
    unidade: 'UN',
    configuracaoICMS: {
      crt: '1',
      csosn: '102',
    },
  };
}

const SEED_NFE_CONFIG: NFeConfig = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: '2',
};

interface FakeFirestoreOptions {
  events: string[];
  pedido?: Record<string, unknown> | null;
  nfeConfig?: NFeConfig | null;
  /** Partial override for `operacao/O-1` — merged onto the default. */
  operacao?: Record<string, unknown>;
  /** Partial override for `clientes/C-1/enderecos/E-1` — merged onto the default. */
  endereco?: Record<string, unknown>;
}

/**
 * Mock Firestore — in-memory map keyed by slash-delimited path. Both the
 * collection().doc() API (used by the orchestrator) and the doc(path)
 * API (used by the firestore-adapter) work. Writes record onto
 * `opts.events` so persist-before-send can be asserted.
 */
function fakeFirestore(opts: FakeFirestoreOptions) {
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
    'pedidos/PED-1': opts.pedido !== undefined ? opts.pedido : defaultPedido,
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
    'filiais/F-1/nfeconfig/default':
      opts.nfeConfig !== undefined
        ? (opts.nfeConfig as Record<string, unknown> | null)
        : (SEED_NFE_CONFIG as unknown as Record<string, unknown>),
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
      ...(opts.operacao ?? {}),
    },
  };

  if (opts.endereco) {
    docs['clientes/C-1/enderecos/E-1'] = {
      ...(docs['clientes/C-1/enderecos/E-1'] ?? {}),
      ...opts.endereco,
    };
  }
  const writes: { path: string; data: Record<string, unknown>; merge?: boolean }[] = [];

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
  let autoIdCounter = 0;
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
        return makeQuery(path, [{ kind: 'orderBy', field, dir }]);
      },
      limit(n: number) {
        return makeQuery(path, [{ kind: 'limit', n }]);
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

const RET_ENVI_103 = {
  tpAmb: '2',
  verAplic: 'SP',
  cStat: '103',
  xMotivo: 'Lote recebido com sucesso',
  cUF: '35',
  dhRecbto: '2026-05-20T10:30:00-03:00',
  infRec: { nRec: '351000000000123', tMed: '1' },
  versao: '4.00',
} as const;

const RET_ENVI_204 = {
  tpAmb: '2',
  verAplic: 'SP',
  cStat: '204',
  xMotivo: 'Rejeicao: Duplicidade de NF-e [nRec:351000000000999]',
  cUF: '35',
  dhRecbto: '2026-05-20T10:30:00-03:00',
  versao: '4.00',
} as const;

const RET_SIT_100 = {
  tpAmb: '2',
  verAplic: 'SP',
  cStat: '100',
  xMotivo: 'Autorizado o uso da NF-e',
  cUF: '35',
  dhRecbto: '2026-05-20T10:30:00-03:00',
  chNFe: CHAVE,
  versao: '4.00',
  protNFe: {
    versao: '4.00',
    infProt: {
      tpAmb: '2',
      verAplic: 'SP',
      chNFe: CHAVE,
      dhRecbto: '2026-05-20T10:30:00-03:00',
      nProt: '135200000000123',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    },
  },
} as const;

beforeEach(() => {
  vi.mocked(generateNFe).mockReturnValue({
    chave: CHAVE,
    cNF: '00000001',
    cDV: 8,
    nfeXml: `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}">…</infNFe></NFe>`,
  });
  vi.mocked(signNFe).mockReturnValue(
    `<NFe xmlns="${NFE_NS}"><infNFe>…signed…</infNFe><Signature>…</Signature></NFe>`,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('emitirPedido — happy paths', () => {
  it('persists estado=enviando BEFORE the SOAP send (anti-loss anchor)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockImplementation(async () => {
      events.push('soap:autorizarLote');
      return RET_ENVI_103;
    });

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const firstNfeSetIndex = events.findIndex((e) => e.startsWith('set:pedidos/PED-1/nfev4/'));
    const soapIndex = events.indexOf('soap:autorizarLote');
    expect(firstNfeSetIndex).toBeGreaterThanOrEqual(0);
    expect(soapIndex).toBeGreaterThanOrEqual(0);
    expect(firstNfeSetIndex).toBeLessThan(soapIndex);

    const firstWrite = writes.find((w) => w.path.startsWith('pedidos/PED-1/nfev4/'));
    expect(firstWrite?.data.estado).toBe(ESTADO_NFE.enviando);
    expect(firstWrite?.data.chave).toBe(CHAVE);
    expect(firstWrite?.data.xml_assinado).toBeTruthy();
  });

  it('reads serie + nNF + idLote from the per-filial NFeConfig doc', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({
      events,
      nfeConfig: { numeracao_atual: 41, serie: 3, idLote: 6, ambiente: '2' },
    });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const firstWrite = writes.find((w) => w.path.startsWith('pedidos/PED-1/nfev4/'));
    expect(firstWrite?.data.numeracao).toBe(42); // 41 + 1
    expect(firstWrite?.data.serie).toBe(3);
    expect(firstWrite?.data.idLote).toBe('7'); // 6 + 1, serialised as string
  });

  it('returns estado=aguardandoResposta on cStat=103', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    const result = await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(result.estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(result.cStat).toBe('103');
    expect(result.nRec).toBe('351000000000123');
    expect(result.chave).toBe(CHAVE);
  });
});

describe('emitirPedido — duplicidade recovery', () => {
  it('on cStat=204 with nRec in xMotivo, calls consultarLote(nRec) inline and re-applies', async () => {
    // 204 carries `[nRec:...]` in xMotivo → recovery branch routes
    // through consReci (preferred when an nRec is known) instead of
    // consSit(chave). consReci returns the lote-processado wrapper
    // (cStat=104) with the per-NFe protocol nested in protNFe[i].
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_204);
    vi.mocked(consultarLote).mockResolvedValue({
      tpAmb: '2' as const,
      verAplic: 'SP',
      nRec: '351000000000999',
      cStat: '104',
      xMotivo: 'Lote processado',
      cUF: '35' as const,
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00' as const,
      protNFe: [
        {
          versao: '4.00' as const,
          infProt: {
            tpAmb: '2' as const,
            verAplic: 'SP',
            chNFe: CHAVE,
            dhRecbto: '2026-05-20T10:30:00-03:00',
            nProt: '135200000000123',
            cStat: '100',
            xMotivo: 'Autorizado o uso da NF-e',
          },
        },
      ],
    });

    const result = await emitirPedido(fs, fakeRuntime(), 'PED-1');

    expect(vi.mocked(consultarLote)).toHaveBeenCalledOnce();
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(result.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.cStat).toBe('100');
  });
});

describe('emitirPedido — guards', () => {
  it('throws NFePedidoNotFoundError when the pedido is missing', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events, pedido: null });
    await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
      NFePedidoNotFoundError,
    );
  });

  it('throws NFeBlockedError when bloquearEmissaoNFe is set', async () => {
    const events: string[] = [];
    const blockedPedido = {
      ehSaida: true,
      estado: 'pago',
      bloquearEmissaoNFe: true,
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
    const { fs } = fakeFirestore({ events, pedido: blockedPedido });
    await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
      NFeBlockedError,
    );
  });
});

describe('emitirPedido — magic-string fallbacks removed', () => {
  function pedidoWithItemMissing(field: string): Record<string, unknown> {
    const baseImposto = impostoCsosn102();
    if (field !== '_keep') delete baseImposto[field];
    return {
      ehSaida: true,
      estado: 'pago',
      itens: {
        'P-1': [
          {
            sku: 'SKU-1',
            nomeDeVenda: field === 'nomeDeVenda' ? null : 'Bicicleta',
            precoDeVenda: 1500,
            quantidade: 1,
            descontoUnitario: 0,
            ...(field === 'imposto' ? {} : { imposto: baseImposto }),
            ...(field === 'sku-and-gtin' ? { sku: null, gtin: null } : {}),
          },
        ],
      },
      filialPedidoOuterRef: 'filiais/F-1',
      clientePedidoOuterRef: 'clientes/C-1',
      operacaoPedidoOuterRef: 'operacao/O-1',
      enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
    };
  }

  it('throws NFeMissingImpostoError when item has no `imposto`', async () => {
    const { fs } = fakeFirestore({ events: [], pedido: pedidoWithItemMissing('imposto') });
    await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
      NFeMissingImpostoError,
    );
  });

  it.each(['cfop', 'NCM', 'unidade'] as const)(
    'throws when BOTH imposto.%s AND operacao.%s are missing (no fallback chain left)',
    async (field) => {
      // The orchestrator resolves field <- item.imposto[field] ?? operacao[field].
      // To prove the terminal error path we have to null out BOTH sources.
      const operacaoOverride: Record<string, unknown> =
        field === 'cfop'
          ? { cfop: null }
          : field === 'NCM'
            ? { NCM: null }
            : { unidade: null };
      const { fs } = fakeFirestore({
        events: [],
        pedido: pedidoWithItemMissing(field),
        operacao: operacaoOverride,
      });
      await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
        NFeOrchestratorError,
      );
    },
  );

  it('throws when item has neither sku nor gtin', async () => {
    const { fs } = fakeFirestore({ events: [], pedido: pedidoWithItemMissing('sku-and-gtin') });
    await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
      NFeOrchestratorError,
    );
  });

  it('throws when nomeDeVenda is missing (no fallback to "Item N")', async () => {
    const { fs } = fakeFirestore({ events: [], pedido: pedidoWithItemMissing('nomeDeVenda') });
    await expect(emitirPedido(fs, fakeRuntime(), 'PED-1')).rejects.toBeInstanceOf(
      NFeOrchestratorError,
    );
  });
});

describe('emitirPedido — operação fallback for fiscal codes', () => {
  /**
   * Build a pedido whose single item carries an Imposto missing one
   * fiscal field (CFOP / NCM / unidade), so the operação fallback
   * fires. `field='_keep'` preserves the full imposto for the
   * "item wins" precedence test.
   */
  function pedidoMissingItemField(field: 'cfop' | 'NCM' | 'unidade' | '_keep'): Record<string, unknown> {
    const baseImposto = impostoCsosn102();
    if (field !== '_keep') delete baseImposto[field];
    return {
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
            imposto: baseImposto,
          },
        ],
      },
      filialPedidoOuterRef: 'filiais/F-1',
      clientePedidoOuterRef: 'clientes/C-1',
      operacaoPedidoOuterRef: 'operacao/O-1',
      enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
    };
  }

  /** Pull `input.itens[0]` from the spy on generateNFe. */
  function lastGenItem(): Record<string, unknown> {
    const calls = vi.mocked(generateNFe).mock.calls;
    const input = calls[calls.length - 1]?.[0];
    if (!input) throw new Error('generateNFe was not called');
    const item = input.itens[0] as unknown as Record<string, unknown>;
    if (!item) throw new Error('generateNFe input had no itens');
    return item;
  }

  beforeEach(() => {
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);
  });

  it('CFOP: item missing + operação set → uses operacao.cfop', async () => {
    const { fs } = fakeFirestore({
      events: [],
      pedido: pedidoMissingItemField('cfop'),
      // operação default already has cfop='5102'
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastGenItem().CFOP).toBe('5102');
  });

  it('CFOP: both set → item-imposto.cfop wins over operacao.cfop', async () => {
    const baseImposto = impostoCsosn102();
    baseImposto.cfop = '5405'; // item override
    const pedido = pedidoMissingItemField('_keep');
    (pedido.itens as Record<string, unknown[]>)['P-1']![0] = {
      ...((pedido.itens as Record<string, unknown[]>)['P-1']![0] as Record<string, unknown>),
      imposto: baseImposto,
    };
    const { fs } = fakeFirestore({
      events: [],
      pedido,
      operacao: { cfop: '5102' },
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastGenItem().CFOP).toBe('5405');
  });

  it('NCM: item missing + operação set → uses operacao.NCM', async () => {
    const { fs } = fakeFirestore({
      events: [],
      pedido: pedidoMissingItemField('NCM'),
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastGenItem().NCM).toBe('87120000');
  });

  it('NCM: both set → item wins', async () => {
    const baseImposto = impostoCsosn102();
    baseImposto.NCM = '61091000';
    const pedido = pedidoMissingItemField('_keep');
    (pedido.itens as Record<string, unknown[]>)['P-1']![0] = {
      ...((pedido.itens as Record<string, unknown[]>)['P-1']![0] as Record<string, unknown>),
      imposto: baseImposto,
    };
    const { fs } = fakeFirestore({ events: [], pedido });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastGenItem().NCM).toBe('61091000');
  });

  it('unidade: item missing + operação set → uses operacao.unidade', async () => {
    const { fs } = fakeFirestore({
      events: [],
      pedido: pedidoMissingItemField('unidade'),
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastGenItem().uCom).toBe('UN');
    expect(lastGenItem().uTrib).toBe('UN');
  });

  it('CEST: optional, item wins, falls back to operação, omitted when neither set', async () => {
    // (a) Both null → CEST omitted from the GeneratorItem entirely.
    const fs1 = fakeFirestore({ events: [], pedido: pedidoMissingItemField('_keep') }).fs;
    await emitirPedido(fs1, fakeRuntime(), 'PED-1');
    expect('CEST' in lastGenItem()).toBe(false);
    vi.clearAllMocks();
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);
    vi.mocked(generateNFe).mockReturnValue({
      chave: CHAVE,
      cNF: '00000001',
      cDV: 8,
      nfeXml: `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}">…</infNFe></NFe>`,
    });
    vi.mocked(signNFe).mockReturnValue(
      `<NFe xmlns="${NFE_NS}"><infNFe>…signed…</infNFe><Signature>…</Signature></NFe>`,
    );

    // (b) Only operação has CEST → CEST is used.
    const fs2 = fakeFirestore({
      events: [],
      pedido: pedidoMissingItemField('_keep'),
      operacao: { CEST: '1003700' },
    }).fs;
    await emitirPedido(fs2, fakeRuntime(), 'PED-1');
    expect(lastGenItem().CEST).toBe('1003700');
  });
});

describe('emitirPedido — CFOP selection by emitente/destinatário UF', () => {
  beforeEach(() => {
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);
  });

  /** Pull `input.itens[0].CFOP` off the generateNFe spy. */
  function lastCFOP(): string {
    const calls = vi.mocked(generateNFe).mock.calls;
    const input = calls[calls.length - 1]?.[0];
    if (!input) throw new Error('generateNFe was not called');
    const item = input.itens[0] as unknown as { CFOP?: string };
    return item.CFOP ?? '';
  }

  it('same UF (intra-state) → uses imposto.cfop (5xxx)', async () => {
    // Default fixture: filial SP, endereço destinatário SP. Item carries
    // cfop='5102' + cfopInterestadual='6102'. Expect 5102 in the genItem.
    const { fs } = fakeFirestore({ events: [] });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastCFOP()).toBe('5102');
  });

  it('different UF (interstate) → uses imposto.cfopInterestadual (6xxx)', async () => {
    // Flip the destinatário UF to MG; expect 6102.
    const { fs } = fakeFirestore({
      events: [],
      endereco: { estado: 'MG' },
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastCFOP()).toBe('6102');
  });

  it('intra-state, item missing cfop → falls back to operacao.cfop', async () => {
    const baseImposto = impostoCsosn102();
    delete baseImposto.cfop;
    const pedido = {
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
            imposto: baseImposto,
          },
        ],
      },
      filialPedidoOuterRef: 'filiais/F-1',
      clientePedidoOuterRef: 'clientes/C-1',
      operacaoPedidoOuterRef: 'operacao/O-1',
      enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
    };
    const { fs } = fakeFirestore({ events: [], pedido });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastCFOP()).toBe('5102'); // from operação default
  });

  it('interstate, item missing cfopInterestadual → falls back to operacao.cfopInterestadual', async () => {
    const baseImposto = impostoCsosn102();
    delete baseImposto.cfopInterestadual;
    const pedido = {
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
            imposto: baseImposto,
          },
        ],
      },
      filialPedidoOuterRef: 'filiais/F-1',
      clientePedidoOuterRef: 'clientes/C-1',
      operacaoPedidoOuterRef: 'operacao/O-1',
      enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
    };
    const { fs } = fakeFirestore({
      events: [],
      pedido,
      endereco: { estado: 'MG' },
    });
    await emitirPedido(fs, fakeRuntime(), 'PED-1');
    expect(lastCFOP()).toBe('6102'); // from operação default
  });
});

// ---------------------------------------------------------------------------
// Dedup — port of Flutter `gerarNFePedidos` pre-check semantics
// (.old/packages/pedido_nfe/lib/src/tasks.dart). The Flutter code keys
// each nfev4 doc by `nFeSaidaIdFromTpEmis(tpEmis) => 's${tpEmis}'` so
// every retry for the same pedido targets the same doc; bloqueada cStats
// (STATUS_BLOQUEADORES) short-circuit; rejeitada / error / never-sent
// reuse the existing numeração and overwrite in place. Before this dedup
// the orchestrator was keying docs by `chave` and allocating a fresh
// numeração on every call — three duplicate nfev4 docs surfaced in a
// real session.
// ---------------------------------------------------------------------------

describe('emitirPedido — dedup (stable s${tpEmis} doc id)', () => {
  it('writes the nfev4 doc at "pedidos/{id}/nfev4/s1" (stable id)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const nfeWrite = writes.find((w) => w.path.startsWith('pedidos/PED-1/nfev4/'));
    expect(nfeWrite?.path).toBe('pedidos/PED-1/nfev4/s1');
  });

  it('returns existing result without re-emitting when cStat is bloqueada (100)', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({ events });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7,
      serie: 1,
      tpEmis: 1,
      estado: ESTADO_NFE.aprovada,
      chave: CHAVE,
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      nRec: '351000000000123',
    };
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    const result = await emitirPedido(fs, fakeRuntime(), 'PED-1');

    expect(result.cStat).toBe('100');
    expect(result.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.chave).toBe(CHAVE);
    expect(result.nRec).toBe('351000000000123');
    expect(result.nfeId).toBe('s1');
    expect(result.reused).toBe(true);
    expect(vi.mocked(autorizarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(generateNFe)).not.toHaveBeenCalled();
    expect(vi.mocked(signNFe)).not.toHaveBeenCalled();
    expect(writes.some((w) => w.path.startsWith('pedidos/PED-1/nfev4/'))).toBe(false);
  });

  it('fresh emit returns reused=false (so the UI shows the regular green toast)', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    const result = await emitirPedido(fs, fakeRuntime(), 'PED-1');

    expect(result.reused).toBe(false);
  });

  it.each(['101', '102', '103', '104', '105', '128', '150', '151', '468'] as const)(
    'skips re-emission for every STATUS_BLOQUEADORES code (cStat=%s)',
    async (cStat) => {
      const events: string[] = [];
      const { fs, docs } = fakeFirestore({ events });
      docs['pedidos/PED-1/nfev4/s1'] = {
        numeracao: 7,
        serie: 1,
        tpEmis: 1,
        estado: ESTADO_NFE.aprovada,
        chave: CHAVE,
        cStat,
        xMotivo: 'bloqueada',
      };
      vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

      await emitirPedido(fs, fakeRuntime(), 'PED-1');

      expect(vi.mocked(autorizarLote)).not.toHaveBeenCalled();
    },
  );

  it('reuses existing numeração + serie when nfev4 is rejeitada (cStat=215)', async () => {
    const events: string[] = [];
    // nfeConfig advanced to 100 — but we expect the orchestrator to reuse
    // the rejeitada doc's numeração (7) instead of calling nextNumeracao.
    const { fs, writes, docs } = fakeFirestore({
      events,
      nfeConfig: { numeracao_atual: 100, serie: 1, idLote: 0, ambiente: '2' },
    });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7,
      serie: 3,
      tpEmis: 1,
      estado: ESTADO_NFE.rejeitada,
      chave: CHAVE,
      cStat: '215',
      xMotivo: 'Falha no Schema XML',
    };
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(nfeWrite?.data.numeracao).toBe(7);
    expect(nfeWrite?.data.serie).toBe(3);
    expect(nfeWrite?.data.estado).toBe(ESTADO_NFE.enviando);
    expect(vi.mocked(autorizarLote)).toHaveBeenCalledOnce();
  });

  it('reuses numeração when existing nfev4 was enviando but crashed (cStat=null)', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({
      events,
      nfeConfig: { numeracao_atual: 50, serie: 1, idLote: 0, ambiente: '2' },
    });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 12,
      serie: 1,
      tpEmis: 1,
      estado: ESTADO_NFE.enviando,
      chave: CHAVE,
      cStat: null,
      xMotivo: null,
    };
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(nfeWrite?.data.numeracao).toBe(12);
  });

  it('advances numeracao_atual + idLote on the per-filial NFeConfig doc in the same transaction', async () => {
    // The user-visible bug this prevents: a crash between counter-bump
    // and NFe doc write would strand a consumed numeração. The whole
    // operation now runs in one Firestore tx — both writes commit or
    // neither does.
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({
      events,
      nfeConfig: { numeracao_atual: 40, serie: 1, idLote: 5, ambiente: '2' },
    });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const cfgWrite = writes.find((w) => w.path === 'filiais/F-1/nfeconfig/default');
    const nfeWrite = writes.find((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    expect(cfgWrite?.data.numeracao_atual).toBe(41); // 40 + 1
    expect(cfgWrite?.data.idLote).toBe(6); // 5 + 1
    expect(nfeWrite?.data.numeracao).toBe(41);
    expect(nfeWrite?.data.idLote).toBe('6');
    // Ordering: the counter doc and the NFe doc are written in the same
    // transaction (same Firestore commit), so persistence-wise they
    // either both land or neither does.
  });

  it('still advances idLote when reusing existing numeração (idLote is per-submission)', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({
      events,
      nfeConfig: { numeracao_atual: 100, serie: 1, idLote: 20, ambiente: '2' },
    });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7, // reuse
      serie: 1,
      tpEmis: 1,
      estado: ESTADO_NFE.rejeitada,
      chave: CHAVE,
      cStat: '215',
      xMotivo: 'Falha no Schema XML',
    };
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const cfgWrite = writes.find((w) => w.path === 'filiais/F-1/nfeconfig/default');
    expect(cfgWrite?.data.numeracao_atual).toBe(100); // unchanged — reused
    expect(cfgWrite?.data.idLote).toBe(21); // 20 + 1 — still bumped
  });
});

// ---------------------------------------------------------------------------
// EnviNFeMsg audit log — port of Flutter's per-Filial enviNfe subcollection
// (.old/packages/nfe_client/lib/src/models.dart:215). Every SEFAZ round-trip
// (lote send, consReci, consSit) appends a new doc; nothing is mutated. This
// is the recoverable source-of-truth for nRec.
// ---------------------------------------------------------------------------

describe('emitirPedido — EnviNFeMsg audit log', () => {
  it('persists an EnviNFeMsg under filiais/{filialId}/enviNfe after autorizarLote', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    const msgWrite = writes.find((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(msgWrite).toBeDefined();
    expect(msgWrite?.data.targetsChnfe).toEqual([CHAVE]);
    expect(msgWrite?.data.idLote).toBe(1); // first lote
    expect(msgWrite?.data.indSinc).toBe('1');
    expect(msgWrite?.data.nRec).toBe('351000000000123');
    expect(msgWrite?.data.cStat).toBe('103');
    expect(msgWrite?.data.estado).toBe('2'); // respondido
    expect(typeof msgWrite?.data.xml_enviado).toBe('string');
    expect(typeof msgWrite?.data.xml_retorno).toBe('string');
  });

  it('persists nRec on the nfev4 doc via persistPatch (NFCell can render it)', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_103);

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    // The patch from cStat=103 carries nRec; persistPatch merges it onto s1.
    const patchWrites = writes.filter((w) => w.path === 'pedidos/PED-1/nfev4/s1');
    const nRecWrite = patchWrites.find((w) => w.data.nRec != null);
    expect(nRecWrite?.data.nRec).toBe('351000000000123');
  });
});

describe('consultarPedido — consReci(nRec) preferred over consSit(chave)', () => {
  const RET_CONS_REC_104 = {
    tpAmb: '2' as const,
    verAplic: 'SP',
    nRec: '351000000000123',
    cStat: '104',
    xMotivo: 'Lote processado',
    cUF: '35' as const,
    dhRecbto: '2026-05-20T10:30:00-03:00',
    versao: '4.00' as const,
    protNFe: [
      {
        versao: '4.00' as const,
        infProt: {
          tpAmb: '2' as const,
          verAplic: 'SP',
          chNFe: CHAVE,
          dhRecbto: '2026-05-20T10:30:00-03:00',
          nProt: '135200000000123',
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
        },
      },
    ],
  };

  it('uses consultarLote when an EnviNFeMsg with nRec exists for the chave', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({ events });
    // Seed an already-emitted nfev4 doc + the matching EnviNFeMsg.
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7, serie: 1, tpEmis: 1,
      estado: ESTADO_NFE.aguardandoResposta,
      chave: CHAVE, cStat: '103', xMotivo: 'Lote recebido',
      nRec: '351000000000123', retries: 0,
    };
    docs['filiais/F-1/enviNfe/seed-1'] = {
      targetsChnfe: [CHAVE], idLote: 1, indSinc: '1',
      xml_enviado: '<NFe>…</NFe>',
      xml_retorno: JSON.stringify(RET_ENVI_103),
      nRec: '351000000000123', cStat: '103',
      xMotivo: 'Lote recebido', error: null, tpEmis: 1,
      estado: '2', timestamp: '2026-05-20T10:30:00.000Z',
      ultima_modificacao: '2026-05-20T10:30:00.000Z',
    };
    vi.mocked(consultarLote).mockResolvedValue(RET_CONS_REC_104);

    const result = await consultarPedido(fs, fakeRuntime(), 'PED-1');

    expect(vi.mocked(consultarLote)).toHaveBeenCalledOnce();
    expect(vi.mocked(consultarLote)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/sefaz/ret' }),
      { nRec: '351000000000123' },
    );
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(result.cStat).toBe('100'); // outcomeFromRetConsRec adopts the protocol's cStat
  });

  it('falls back to consultarSituacaoNFe when no EnviNFeMsg with nRec exists', async () => {
    const events: string[] = [];
    const { fs, docs } = fakeFirestore({ events });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7, serie: 1, tpEmis: 1,
      estado: ESTADO_NFE.aguardandoResposta,
      chave: CHAVE, cStat: null, xMotivo: null,
      nRec: null, retries: 0,
    };
    // No enviNfe seed → no nRec to recover → falls back to consSit.
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_SIT_100);

    await consultarPedido(fs, fakeRuntime(), 'PED-1');

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledOnce();
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  });

  it('appends a new EnviNFeMsg with the consult response (append-only audit log)', async () => {
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({ events });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7, serie: 1, tpEmis: 1,
      estado: ESTADO_NFE.aguardandoResposta,
      chave: CHAVE, cStat: '103', xMotivo: 'Lote recebido',
      nRec: '351000000000123', retries: 0,
    };
    docs['filiais/F-1/enviNfe/seed-1'] = {
      targetsChnfe: [CHAVE], idLote: 1, indSinc: '1',
      xml_enviado: '<NFe>…</NFe>',
      xml_retorno: JSON.stringify(RET_ENVI_103),
      nRec: '351000000000123', cStat: '103',
      xMotivo: 'Lote recebido', error: null, tpEmis: 1,
      estado: '2', timestamp: '2026-05-20T10:30:00.000Z',
      ultima_modificacao: '2026-05-20T10:30:00.000Z',
    };
    vi.mocked(consultarLote).mockResolvedValue(RET_CONS_REC_104);

    await consultarPedido(fs, fakeRuntime(), 'PED-1');

    const enviNfeWrites = writes.filter((w) => w.path.startsWith('filiais/F-1/enviNfe/'));
    expect(enviNfeWrites.length).toBe(1); // ONE new doc for the consult
    const consultMsg = enviNfeWrites[0]!;
    expect(consultMsg.data.targetsChnfe).toEqual([CHAVE]);
    expect(consultMsg.data.idLote).toBeNull();
    expect(consultMsg.data.indSinc).toBeNull();
    expect(consultMsg.data.nRec).toBe('351000000000123'); // forwarded from originator
    expect(consultMsg.data.cStat).toBe('104');
    expect(consultMsg.data.estado).toBe('3'); // concluido
  });

  it('persistPatch with patch.nRec=null preserves the existing nRec on the nfev4 doc', async () => {
    // consSit responses don't carry nRec. Before the fix, persistPatch
    // wrote nRec:null and wiped the original receipt. Now it must omit
    // the field so { merge: true } keeps the existing value.
    const events: string[] = [];
    const { fs, writes, docs } = fakeFirestore({ events });
    docs['pedidos/PED-1/nfev4/s1'] = {
      numeracao: 7, serie: 1, tpEmis: 1,
      estado: ESTADO_NFE.aguardandoResposta,
      chave: CHAVE, cStat: '103', xMotivo: 'Lote recebido',
      nRec: '351000000000123', retries: 0,
    };
    // No enviNfe with nRec → falls back to consSit, whose response
    // doesn't include an nRec → patch.nRec becomes null.
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_SIT_100);

    await consultarPedido(fs, fakeRuntime(), 'PED-1');

    const patchWrites = writes.filter(
      (w) => w.path === 'pedidos/PED-1/nfev4/s1' && w.merge === true,
    );
    // The persistPatch write should NOT carry nRec (preserved by merge).
    for (const w of patchWrites) {
      expect(w.data).not.toHaveProperty('nRec');
    }
    // The in-memory doc still has the original nRec after merge.
    expect((docs['pedidos/PED-1/nfev4/s1'] as { nRec?: unknown }).nRec).toBe('351000000000123');
  });
});
