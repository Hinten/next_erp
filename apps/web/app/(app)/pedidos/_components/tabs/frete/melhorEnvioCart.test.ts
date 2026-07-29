import { describe, expect, it } from 'vitest';
import { MODALIDADE_FRETE, ESTADO_FRETE } from '@delfrance/schemas';
import type { Endereco, Filial, ItemDoPedido } from '@delfrance/schemas';

import { buildPedidoCartPayload } from './melhorEnvioCart';
import type { FreteInicialFormState } from '../../types';

/** A minimal frete form-state with the cart-relevant fields set. */
function makeFrete(overrides: Partial<FreteInicialFormState> = {}): FreteInicialFormState {
  return {
    externalId: null,
    printLabelId: null,
    externalOptionId: '2',
    externalOptionIntegracao: 'int-1',
    externalOptionData: null,
    externalOptionSelectionDate: null,
    estado: ESTADO_FRETE.iniciado,
    integracaoFreteOuterRef: null,
    integracaoTargetOuterRef: null,
    integracao_path: null,
    clienteRecebedorOuterReference: null,
    enderecoFreteOuterReference: null,
    modalidade: MODALIDADE_FRETE.cif,
    transportadora: null,
    veiculo: null,
    reboques: null,
    vagao: null,
    balsa: null,
    volumes: [
      {
        quantidade: 1,
        especie: null,
        marca: null,
        numero: null,
        pesoBruto: 2,
        pesoLiquido: null,
        dimensoes: { altura: 10, largura: 20, comprimento: 30 },
        lacres: null,
      },
    ],
    codRastreio: null,
    valorCobrado: null,
    custoCalculado: null,
    custoFinal: null,
    ehReverso: false,
    prazoExtra: 0,
    prazoDespacho: null,
    dataEntrega: null,
    dataPrevisaoEntrega: null,
    valor_assegurado: 150,
    maoPropria: false,
    avisoRecebimento: false,
    ultimaModificacao: null,
    timestamp: null,
    ...overrides,
  };
}

const ORIGIN: Endereco = {
  idExterno: null,
  cep: '01310100',
  logradouro: 'Av Paulista',
  numero: '1000',
  bairro: 'Bela Vista',
  complemento: 'Conj 1',
  codigoMunicipio: null,
  cidade: 'São Paulo',
  estado: 'SP',
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: 'loja@example.com',
  telefone: '1133334444',
  timestamp: null,
};

const FILIAL: Filial = {
  razaoSocial: 'Delfrance LTDA',
  fantasia: 'Delfrance',
  cnae: '4781400',
  cnpj: '12345678000199',
  ie: '111222333',
  iest: null,
  imun: null,
  sede: ORIGIN,
};

/** A long destination street to exercise the 39-char address cap. */
const DEST_PF: Endereco = {
  idExterno: null,
  cep: '20040002',
  logradouro: 'Rua da Assembleia com um nome bem longo que estoura o limite',
  numero: '50',
  bairro: 'Centro',
  complemento: null,
  codigoMunicipio: null,
  cidade: 'Rio de Janeiro',
  estado: 'RJ',
  cPais: null,
  pais: null,
  nome: 'Maria Recebedora',
  cpf_cnpj: '11122233344', // 11 digits → PF
  rg: null,
  ie: null,
  imun: null,
  email: 'maria@example.com',
  telefone: '21999998888',
  timestamp: null,
};

const ITENS: ItemDoPedido[] = [
  {
    produtoUid: 'p1',
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: 'SKU-1',
    gtin: null,
    nomeDeVenda: 'Camiseta',
    precoDeVenda: 50,
    descontoUnitario: 5,
    quantidade: 2,
    custo: null,
    timestamp: null,
    imposto: null,
  },
];

describe('buildPedidoCartPayload', () => {
  it('maps a PF destination to the full ME cart payload', () => {
    const payload = buildPedidoCartPayload({
      frete: makeFrete(),
      enderecoOrigem: ORIGIN,
      filial: FILIAL,
      enderecoDestino: DEST_PF,
      clienteDestino: { nome: 'Cliente Pedido', cpf_cnpj: '11122233344' },
      itens: ITENS,
      pedidoNumero: 'PED-7',
    }) as Record<string, unknown>;

    expect(payload.service).toBe(2);
    expect('agency' in payload).toBe(false);

    expect(payload.from).toMatchObject({
      name: 'Delfrance LTDA',
      company_document: '12345678000199',
      state_register: '111222333',
      economic_activity_code: '4781400',
      address: 'Av Paulista',
      number: '1000',
      district: 'Bela Vista',
      city: 'São Paulo',
      state_abbr: 'SP',
      postal_code: '01310100',
      complement: 'Conj 1',
      phone: '1133334444',
      email: 'loja@example.com',
    });

    expect(payload.to).toMatchObject({
      name: 'Maria Recebedora',
      phone: '21999998888',
      email: 'maria@example.com',
      document: '11122233344',
      number: '50',
      district: 'Centro',
      city: 'Rio de Janeiro',
      state_abbr: 'RJ',
      postal_code: '20040002',
    });
    // PF → no company_document / state_register.
    expect((payload.to as Record<string, unknown>).company_document).toBeUndefined();
    expect((payload.to as Record<string, unknown>).state_register).toBeUndefined();
    // 39-char address cap (ME rejects 40) applied by buildCartItem.
    expect((payload.to as { address: string }).address.length).toBeLessThanOrEqual(39);

    expect(payload.products).toEqual([{ name: 'Camiseta', quantity: '2', unitary_value: '45.00' }]);
    expect(payload.volumes).toEqual([{ width: 20, height: 10, length: 30, weight: 2 }]);

    expect(payload.options).toMatchObject({
      insurance_value: 150,
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: true, // v1: no NF-e key
      tags: [{ tag: 'Pedido PED-7' }],
    });
    // Deferred — no invoice block in v1.
    expect((payload.options as Record<string, unknown>).invoice).toBeUndefined();
  });

  it('maps a PJ destination to company_document + state_register', () => {
    const destPJ: Endereco = {
      ...DEST_PF,
      nome: 'Empresa Recebedora',
      cpf_cnpj: '99888777000166', // 14 digits → PJ
      ie: '555666777',
    };
    const payload = buildPedidoCartPayload({
      frete: makeFrete(),
      enderecoOrigem: ORIGIN,
      filial: FILIAL,
      enderecoDestino: destPJ,
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: 1,
    }) as Record<string, unknown>;

    const to = payload.to as Record<string, unknown>;
    expect(to.company_document).toBe('99888777000166');
    expect(to.state_register).toBe('555666777');
    expect(to.document).toBeUndefined();
  });

  it('swaps from/to on a reverse shipment', () => {
    const payload = buildPedidoCartPayload({
      frete: makeFrete({ ehReverso: true }),
      enderecoOrigem: ORIGIN,
      filial: FILIAL,
      enderecoDestino: DEST_PF,
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: 'PED-7',
    }) as Record<string, unknown>;

    expect(payload.options).toMatchObject({ reverse: true });
    // Reverse ships FROM the recipient TO the store.
    expect((payload.from as { name: string }).name).toBe('Maria Recebedora');
    expect((payload.to as { name: string }).name).toBe('Delfrance LTDA');
  });

  it('throws when no freight option is selected', () => {
    expect(() =>
      buildPedidoCartPayload({
        frete: makeFrete({ externalOptionId: null }),
        enderecoOrigem: ORIGIN,
        filial: FILIAL,
        enderecoDestino: DEST_PF,
        clienteDestino: null,
        itens: ITENS,
        pedidoNumero: null,
      }),
    ).toThrow(/opção de frete/i);
  });

  it('reads agency from externalOptionData when present', () => {
    const payload = buildPedidoCartPayload({
      frete: makeFrete({ externalOptionData: { agency: 42 } }),
      enderecoOrigem: ORIGIN,
      filial: FILIAL,
      enderecoDestino: DEST_PF,
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: null,
    }) as Record<string, unknown>;

    expect(payload.agency).toBe(42);
  });

  it('maps the NF-e numeric cPais (1058) to the ISO country_id BR', () => {
    const payload = buildPedidoCartPayload({
      frete: makeFrete(),
      enderecoOrigem: { ...ORIGIN, cPais: '1058' },
      filial: FILIAL,
      enderecoDestino: { ...DEST_PF, cPais: '1058' },
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: null,
    }) as Record<string, unknown>;

    expect((payload.from as { country_id: string }).country_id).toBe('BR');
    expect((payload.to as { country_id: string }).country_id).toBe('BR');
  });

  it('falls back the sender phone to the filial sede when the origin has none', () => {
    const payload = buildPedidoCartPayload({
      frete: makeFrete(),
      enderecoOrigem: { ...ORIGIN, telefone: null },
      filial: { ...FILIAL, sede: { ...ORIGIN, telefone: '1144445555' } },
      enderecoDestino: DEST_PF,
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: null,
    }) as Record<string, unknown>;

    expect((payload.from as { phone: string }).phone).toBe('1144445555');
  });

  it('attaches the NF-e key as invoice and flips non_commercial off', () => {
    const chave = '35200114200166000187550010000000015000000016';
    const payload = buildPedidoCartPayload({
      frete: makeFrete(),
      enderecoOrigem: ORIGIN,
      filial: FILIAL,
      enderecoDestino: DEST_PF,
      clienteDestino: null,
      itens: ITENS,
      pedidoNumero: null,
      invoiceKey: chave,
    }) as Record<string, unknown>;

    const options = payload.options as Record<string, unknown>;
    expect(options.non_commercial).toBe(false);
    expect(options.invoice).toEqual({ key: chave });
  });
});
