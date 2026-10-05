/**
 * `loadPedidoBundle`'s outer-ref reading and the delivery address (#422).
 *
 * The stored ref forms are `documents/<col>/<id>` (canonical — what the app's
 * own writers store) and the bare `<col>/<id>`. The Admin SDK's `doc()` refuses
 * the canonical one (odd segment count), and the loader used to hand it over
 * verbatim, so every app-written pedido failed to load while every fixture —
 * seeded with bare paths — passed. The fake below throws like the SDK does.
 */
import { describe, expect, it } from 'vitest';

import { NFeOrchestratorError } from '../../../lib/nfe/orchestrator/errors';
import { lerRef, loadPedidoBundle, refToPath } from '../../../lib/nfe/orchestrator/bundle';

describe('lerRef / refToPath', () => {
  it('reads the canonical, the bare and the legacy {path} forms onto ONE bare path', () => {
    for (const ref of [
      'documents/clientes/C-1/enderecos/E-1',
      'clientes/C-1/enderecos/E-1',
      { path: 'clientes/C-1/enderecos/E-1' },
      { path: 'documents/clientes/C-1/enderecos/E-1' },
    ]) {
      expect(lerRef(ref)).toEqual({ tipo: 'caminho', path: 'clientes/C-1/enderecos/E-1' });
    }
  });

  it('an unset field is ABSENT, and refToPath returns null for it', () => {
    for (const ref of [null, undefined, '']) {
      expect(lerRef(ref)).toEqual({ tipo: 'ausente' });
      expect(refToPath(ref, 'x')).toBeNull();
    }
  });

  it('a set but unusable ref is MALFORMED, and refToPath names the field — never "missing"', () => {
    for (const ref of ['documents/clientes', 'clientes/C-1/enderecos', 'C-1', 42, {}]) {
      expect(lerRef(ref).tipo).toBe('malformada');
      let message = '';
      try {
        refToPath(ref, "pedido 'P'.clientePedidoOuterRef");
      } catch (err) {
        if (!(err instanceof NFeOrchestratorError)) throw err;
        message = err.message;
      }
      expect(message).toMatch(/^pedido 'P'\.clientePedidoOuterRef: malformed reference /);
      expect(message).not.toContain('missing');
    }
  });
});

// ---------------------------------------------------------------------------

const ENDERECO_SP = {
  logradouro: 'Av B',
  numero: '1',
  bairro: 'Centro',
  cep: '01001000',
  codigoMunicipio: '3550308',
  cidade: 'Sao Paulo',
  estado: 'SP',
  complemento: null,
};
const ENDERECO_RJ = {
  ...ENDERECO_SP,
  cep: '20040030',
  codigoMunicipio: '3304557',
  cidade: 'Rio de Janeiro',
  estado: 'RJ',
};

function fakeFs(docs: Record<string, Record<string, unknown>>, reads: string[]) {
  function ref(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      async get() {
        reads.push(path);
        const data = docs[path];
        return { exists: data != null, id: path.split('/').pop()!, data: () => data };
      },
      collection: (sub: string) => col(`${path}/${sub}`),
    };
  }
  function col(path: string) {
    return {
      doc: (id: string) => ref(`${path}/${id}`),
      async get() {
        reads.push(path);
        return { docs: [], size: 0, empty: true };
      },
    };
  }
  return {
    collection: (name: string) => col(name),
    doc: (path: string) => {
      if (path.split('/').filter(Boolean).length % 2 !== 0) {
        throw new Error(`Value for argument "documentPath" must point to a document: "${path}"`);
      }
      return ref(path);
    },
  } as never;
}

function seed(
  pedido: Record<string, unknown>,
  extra: Record<string, Record<string, unknown>> = {},
) {
  return {
    'pedidos/PED-1': {
      itens: {},
      integracaoPedidoOuterRef: 'documents/integracao/I-1',
      clientePedidoOuterRef: 'documents/clientes/C-1',
      operacaoPedidoOuterRef: 'documents/operacao/O-1',
      enderecoFiscalOuterRef: 'documents/clientes/C-1/enderecos/E-1',
      ...pedido,
    },
    'integracao/I-1': { tipo: 0, filialIntegracaoPedidoOuterRef: 'documents/filiais/F-1' },
    'filiais/F-1': { cnpj: '14200166000187', sede: ENDERECO_SP },
    'clientes/C-1': { tipo: '1', nome: 'X', cpf_cnpj: '99999999000191' },
    'clientes/C-1/enderecos/E-1': ENDERECO_SP,
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
    ...extra,
  };
}

const frete = (ref: unknown) => ({ freteInicial: { enderecoFreteOuterReference: ref } });

describe('loadPedidoBundle — canonical refs and the delivery address (#422)', () => {
  it('loads a pedido whose every ref is canonical', async () => {
    const reads: string[] = [];
    const bundle = await loadPedidoBundle(fakeFs(seed({}), reads), 'PED-1');
    expect(bundle.filialId).toBe('F-1');
    expect(bundle.clienteId).toBe('C-1');
    expect(bundle.enderecoDest.estado).toBe('SP');
    expect(reads.some((p) => p.startsWith('documents/'))).toBe(false);
  });

  it('no frete / no delivery ref → the fiscal address', async () => {
    const bundle = await loadPedidoBundle(fakeFs(seed({}), []), 'PED-1');
    expect(bundle.entrega).toEqual({ tipo: 'enderecoFiscal' });
  });

  it('a delivery ref to the fiscal document in the OTHER form costs no extra read', async () => {
    const reads: string[] = [];
    const bundle = await loadPedidoBundle(
      fakeFs(seed(frete('clientes/C-1/enderecos/E-1')), reads),
      'PED-1',
    );
    expect(bundle.entrega).toEqual({ tipo: 'enderecoFiscal' });
    expect(reads.filter((p) => p === 'clientes/C-1/enderecos/E-1')).toHaveLength(1);
  });

  it('a different document is read and returned with its UF', async () => {
    const bundle = await loadPedidoBundle(
      fakeFs(
        seed(frete('documents/clientes/C-1/enderecos/E-2'), {
          'clientes/C-1/enderecos/E-2': ENDERECO_RJ,
        }),
        [],
      ),
      'PED-1',
    );
    expect(bundle.entrega.tipo).toBe('outroEndereco');
    if (bundle.entrega.tipo !== 'outroEndereco') return;
    expect(bundle.entrega.path).toBe('clientes/C-1/enderecos/E-2');
    expect(bundle.entrega.endereco.estado).toBe('RJ');
    // enderDest stays the fiscal address.
    expect(bundle.enderecoDest.estado).toBe('SP');
  });

  // An unusable delivery address must NOT fail the load: `consultarPedido` and
  // the stored-bytes retransmit share this loader. It is kept as data and
  // refused only where a nota is generated.
  it.each([
    ['a missing document', frete('documents/clientes/C-1/enderecos/GONE'), {}, /not found/],
    ['a malformed ref', frete('documents/clientes/C-1/enderecos'), {}, /malformed reference/],
    [
      'an estado that is not a UF',
      frete('clientes/C-1/enderecos/E-X'),
      { 'clientes/C-1/enderecos/E-X': { ...ENDERECO_RJ, estado: 'Rio' } },
      /estado "Rio" is not a UF/,
    ],
  ])('%s → irresolvivel, and the loader does not throw', async (_label, pedido, extra, motivo) => {
    const bundle = await loadPedidoBundle(fakeFs(seed(pedido, extra), []), 'PED-1');
    expect(bundle.entrega.tipo).toBe('irresolvivel');
    if (bundle.entrega.tipo !== 'irresolvivel') return;
    expect(bundle.entrega.motivo).toMatch(motivo);
  });

  it('reads the RAW delivery ref: a frete block that fails its schema still decides the UF', async () => {
    // `parseFreteFromPedido` drops the WHOLE block on any parse failure; a
    // broken unrelated frete field must not turn an RJ delivery back into SP.
    const bundle = await loadPedidoBundle(
      fakeFs(
        seed(
          {
            freteInicial: {
              enderecoFreteOuterReference: 'clientes/C-1/enderecos/E-2',
              modalidade: 'bogus',
            },
          },
          { 'clientes/C-1/enderecos/E-2': ENDERECO_RJ },
        ),
        [],
      ),
      'PED-1',
    );
    expect(bundle.frete).toBeNull();
    expect(bundle.entrega.tipo).toBe('outroEndereco');
  });
});
