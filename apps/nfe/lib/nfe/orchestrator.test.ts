/**
 * Orchestrator tests — vi.mock the Firestore Admin SDK + the library's
 * SOAP/generator/signer surface so the flow runs end-to-end without
 * network or filesystem.
 *
 * The critical assertion is **persist-before-send**: the doc-write spy
 * MUST be called before the `autorizarLote` spy. We assert that by
 * recording invocation order onto a shared list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    // The four library calls the orchestrator makes against external IO.
    generateNFe: vi.fn(),
    signNFe: vi.fn(),
    autorizarLote: vi.fn(),
    consultarSituacaoNFe: vi.fn(),
  };
});

import {
  applyOutcome,
  autorizarLote,
  consultarSituacaoNFe,
  generateNFe,
  signNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';

import {
  emitirPedido,
  NFeBlockedError,
  NFePedidoNotFoundError,
} from './orchestrator';
import type { NFeRuntime } from './runtime';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

function fakeRuntime(): NFeRuntime {
  return {
    cert: {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST',
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

/** Mock Firestore. Tracks call order on `events` so we can assert
 *  the persist-before-send invariant. */
function fakeFirestore(opts: {
  events: string[];
  pedido?: Record<string, unknown> | null;
  filial?: Record<string, unknown>;
  cliente?: Record<string, unknown>;
  endereco?: Record<string, unknown>;
  operacao?: Record<string, unknown>;
}) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'pedidos/PED-1': opts.pedido !== undefined ? opts.pedido : {
      ehSaida: true,
      estado: 'pago',
      itens: { 'P-1': [{ sku: 'SKU-1', nomeDeVenda: 'Bicicleta', precoDeVenda: 1500, quantidade: 1, descontoUnitario: 0 }] },
      filialPedidoOuterRef: 'filiais/F-1',
      clientePedidoOuterRef: 'clientes/C-1',
      operacaoPedidoOuterRef: 'operacao/O-1',
      enderecoFiscalOuterRef: 'clientes/C-1/enderecos/E-1',
    },
    'filiais/F-1': opts.filial ?? {
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
    'clientes/C-1': opts.cliente ?? {
      tipo: '1',
      nome: 'Distribuidora X LTDA',
      cpf_cnpj: '99999999000191',
      idEstrangeiro: null,
      ie: '222222222',
      imun: null,
      isUF: null,
      email: null,
    },
    'clientes/C-1/enderecos/E-1': opts.endereco ?? {
      logradouro: 'Av B',
      numero: '1',
      bairro: 'Centro',
      cep: '01001000',
      codigoMunicipio: '3550308',
      cidade: 'Sao Paulo',
      estado: 'SP',
      complemento: null,
    },
    'operacao/O-1': opts.operacao ?? {
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
  const counters: Record<string, { next: number }> = {};
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
  function makeCollection(path: string) {
    return {
      doc(id: string) {
        return makeRef(`${path}/${id}`);
      },
    };
  }
  return {
    fs: {
      collection: (name: string) => makeCollection(name),
      doc: (path: string) => makeRef(path),
      runTransaction: async <T>(fn: (tx: { get: typeof getTx; set: typeof setTx }) => Promise<T>) => {
        async function getTx(ref: ReturnType<typeof makeRef>) {
          return ref.get();
        }
        function setTx(
          ref: ReturnType<typeof makeRef>,
          data: { next: number },
          opt?: { merge?: boolean },
        ) {
          void opt;
          counters[ref.path] = data;
          docs[ref.path] = data as unknown as Record<string, unknown>;
        }
        return fn({ get: getTx, set: setTx });
      },
    } as never,
    writes,
    counters,
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
  vi.mocked(signNFe).mockReturnValue(`<NFe xmlns="${NFE_NS}"><infNFe>…signed…</infNFe><Signature>…</Signature></NFe>`);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('emitirPedido — happy paths', () => {
  it('persists estado=enviando BEFORE the SOAP send', async () => {
    const events: string[] = [];
    const { fs, writes } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockImplementation(async () => {
      events.push('soap:autorizarLote');
      return RET_ENVI_103;
    });

    await emitirPedido(fs, fakeRuntime(), 'PED-1');

    // The first set on the nfev4 doc must precede the SOAP call.
    const firstSetIndex = events.findIndex((e) =>
      e.startsWith('set:pedidos/PED-1/nfev4/'),
    );
    const soapIndex = events.indexOf('soap:autorizarLote');
    expect(firstSetIndex).toBeGreaterThanOrEqual(0);
    expect(soapIndex).toBeGreaterThanOrEqual(0);
    expect(firstSetIndex).toBeLessThan(soapIndex);

    // And that first write carries estado='enviando' + the chave.
    const firstWrite = writes.find((w) =>
      w.path.startsWith('pedidos/PED-1/nfev4/'),
    );
    expect(firstWrite?.data.estado).toBe(ESTADO_NFE.enviando);
    expect(firstWrite?.data.chave).toBe(CHAVE);
    expect(firstWrite?.data.xml_assinado).toBeTruthy();
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
  it('on cStat=204, calls consultarSituacaoNFe inline and re-applies', async () => {
    const events: string[] = [];
    const { fs } = fakeFirestore({ events });
    vi.mocked(autorizarLote).mockResolvedValue(RET_ENVI_204);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_SIT_100);

    const result = await emitirPedido(fs, fakeRuntime(), 'PED-1');

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledOnce();
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
      itens: { 'P-1': [{ sku: 'SKU-1', nomeDeVenda: 'Bicicleta', precoDeVenda: 1500, quantidade: 1, descontoUnitario: 0 }] },
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

describe('applyOutcome integration sanity', () => {
  // Confirms the orchestrator's expectations about applyOutcome's
  // contract — not a real test of applyOutcome (covered in
  // packages/integrations/nfe/src/state). Failing here means an
  // applyOutcome refactor broke the orchestrator's assumptions.
  it("treats cStat=103 as 'poll-lote' → estado=aguardandoResposta", () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.enviando, retries: 0 },
      { cStat: '103', xMotivo: 'Lote recebido', nRec: '351000000000123' },
    );
    expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(patch.action).toBe('poll-lote');
  });
});
