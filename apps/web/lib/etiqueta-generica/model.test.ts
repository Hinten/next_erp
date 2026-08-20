import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model resolves five independent Firestore reads (plus two sequential ones
 * for a reverse label), so the tests drive a tiny in-memory doc store keyed by
 * path. Nothing here touches a real Firestore.
 */
const { docs, getDocMock, getDocsMock, derefMock, nfeRefMock } = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    getDocMock: vi.fn(async (ref: { path: string }) => ({
      exists: () => docs.has(ref.path),
      data: () => docs.get(ref.path),
    })),
    getDocsMock: vi.fn(async () => ({ docs: [] as { data: () => unknown }[] })),
    derefMock: vi.fn((_db: unknown, outerRef: unknown) =>
      typeof outerRef === 'string' ? { path: outerRef } : null,
    ),
    nfeRefMock: vi.fn(() => ({ path: 'nfe-query' })),
  };
});

vi.mock('firebase/firestore', () => ({ getDoc: getDocMock, getDocs: getDocsMock }));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: derefMock }));
vi.mock('@/lib/data/nfeCollection', () => ({ nfeCollection: { ref: nfeRefMock } }));

import { ESTADO_NFE, INTEGRACAO_FRETE, type IntegracaoFrete } from '@delfrance/schemas';

import { buildEtiquetaGenericaModel } from './model';

const DB = {} as never;

const CLIENTE_PATH = 'clientes/c1';
const ENDERECO_PATH = 'clientes/c1/enderecos/e1';
const RECEBEDOR_PATH = 'clientes/c2';
const INTEGRACAO_PATH = 'integracoes/i1';
const FILIAL_PATH = 'filiais/f1';

function pedido(over: Record<string, unknown> = {}): never {
  return {
    numero: '12345',
    clientePedidoOuterRef: CLIENTE_PATH,
    integracaoPedidoOuterRef: INTEGRACAO_PATH,
    ...over,
  } as never;
}

function frete(over: Record<string, unknown> = {}): never {
  return {
    ehReverso: false,
    enderecoFreteOuterReference: ENDERECO_PATH,
    clienteRecebedorOuterReference: null,
    volumes: null,
    ...over,
  } as never;
}

function intFrete(tipo: IntegracaoFrete, nome: string | null = 'Motoboy Centro') {
  return { id: 'if1', tipo, data: { nome } as never };
}

/** Seed the NF-e subcollection the model queries. */
function seedNfes(...rows: Record<string, unknown>[]): void {
  getDocsMock.mockResolvedValue({ docs: rows.map((r) => ({ data: () => r })) });
}

beforeEach(() => {
  docs.clear();
  getDocsMock.mockResolvedValue({ docs: [] });
  docs.set(CLIENTE_PATH, {
    nome: 'Maria Souza',
    telefone: '5511987654321',
    cpf_cnpj: '12345678909',
  });
  docs.set(ENDERECO_PATH, {
    logradouro: 'Rua das Palmeiras',
    numero: '1250',
    complemento: null,
    bairro: 'Jardim Paulista',
    cidade: 'São Paulo',
    estado: 'SP',
    cep: '01415002',
  });
});

describe('buildEtiquetaGenericaModel', () => {
  it('resolves the cliente, the delivery address and the legacy composite subtitle', async () => {
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );

    expect(model.title).toBe('Pedido 12345');
    // Legacy `IntegracaoFrete.toString()` — `'$nome (${tipo.displayName})'`.
    expect(model.subTitle).toBe('Motoboy Centro (Motoboy)');
    expect(model.cliente).toEqual({
      nome: 'Maria Souza',
      telefone: '5511987654321',
      cpfCnpj: '12345678909',
    });
    // `Endereco.estado` is the UF sigla; the label's `uf` is that field renamed.
    expect(model.endereco).toMatchObject({ cidade: 'São Paulo', uf: 'SP', cep: '01415002' });
    expect(model.ocultarEndereco).toBe(false);
    expect(model.enderecoReverso).toBeNull();
  });

  it('falls back to the tipo label alone when the integração has no nome', async () => {
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.outros, '   '),
    );
    expect(model.subTitle).toBe('Outros');
  });

  it('flags retiradaNaLoja for suppression but still RESOLVES the address', async () => {
    // The distinction matters: legacy prints "Endereço não informado" when the
    // address is missing even on a pickup, and nothing at all when it exists.
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.retiradaNaLoja, 'Loja Matriz'),
    );
    expect(model.ocultarEndereco).toBe(true);
    expect(model.endereco).not.toBeNull();
  });

  it('walks pedido → integração → filial → sede for a reverse shipment', async () => {
    docs.set(INTEGRACAO_PATH, { filialIntegracaoPedidoOuterRef: FILIAL_PATH });
    docs.set(FILIAL_PATH, {
      sede: {
        logradouro: 'Avenida Industrial',
        numero: '900',
        complemento: null,
        bairro: 'Distrito Industrial',
        cidade: 'Campinas',
        estado: 'SP',
        cep: '13052000',
      },
    });

    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete({ ehReverso: true }),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );

    expect(model.ehReverso).toBe(true);
    expect(model.enderecoReverso).toMatchObject({ cidade: 'Campinas', uf: 'SP' });
  });

  it('picks the most recently modified authorized NF-e and ignores the rest', async () => {
    seedNfes(
      { estado: ESTADO_NFE.aprovada, numeracao: 100, chave: 'A'.repeat(44), ultima_modificacao: 1 },
      { estado: ESTADO_NFE.aprovada, numeracao: 300, chave: 'C'.repeat(44), ultima_modificacao: 9 },
      { estado: 'r', numeracao: 999, chave: 'R'.repeat(44), ultima_modificacao: 99 },
    );

    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );

    expect(model.nfeNumero).toBe(300);
    expect(model.nfeChave).toBe('C'.repeat(44));
  });

  it('accepts an EPEC-authorized NF-e too, and reports none when there is none', async () => {
    seedNfes({
      estado: ESTADO_NFE.epecAprovado,
      numeracao: 55,
      chave: 'E'.repeat(44),
      ultima_modificacao: 1,
    });
    const epec = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(epec.nfeNumero).toBe(55);

    seedNfes({ estado: 'r', numeracao: 1, chave: null, ultima_modificacao: 1 });
    const none = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(none.nfeNumero).toBeNull();
    expect(none.nfeChave).toBeNull();
  });

  it('resolves the recebedor from the frete, not from the pedido cliente', async () => {
    docs.set(RECEBEDOR_PATH, {
      nome: 'João Ferreira',
      telefone: '5511912345678',
      cpf_cnpj: '12345678000195',
    });
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete({ clienteRecebedorOuterReference: RECEBEDOR_PATH }),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(model.recebedor).toEqual({
      nome: 'João Ferreira',
      telefone: '5511912345678',
      cpfCnpj: '12345678000195',
    });
    // The cliente block is unaffected — they are two different people.
    expect(model.cliente?.nome).toBe('Maria Souza');
  });

  it('summarises the volumes, counting an absent quantidade as one', async () => {
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete({
        volumes: [
          { quantidade: 2, pesoBruto: 10 },
          { quantidade: null, pesoBruto: 2.45 },
        ],
      }),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(model.volumesResumo).toBe('3 volume(s) · 12,45 kg');
  });

  it('omits the volumes line when there are none', async () => {
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido(),
      'p1',
      frete({ volumes: [] }),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(model.volumesResumo).toBeNull();
  });

  it('reports missing cliente / endereço / recebedor as null rather than throwing', async () => {
    docs.clear();
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido({ clientePedidoOuterRef: null }),
      'p1',
      frete({ enderecoFreteOuterReference: null }),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(model.cliente).toBeNull();
    expect(model.endereco).toBeNull();
    expect(model.recebedor).toBeNull();
  });

  it('falls back to the pedido id when the pedido has no numero', async () => {
    const model = await buildEtiquetaGenericaModel(
      DB,
      pedido({ numero: null }),
      'p1',
      frete(),
      intFrete(INTEGRACAO_FRETE.motoboy),
    );
    expect(model.title).toBe('Pedido p1');
  });
});
