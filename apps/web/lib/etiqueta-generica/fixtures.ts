/**
 * Hand-built {@link EtiquetaGenericaModel} fixtures — decoupled from Firestore —
 * for the layout/render tests and the `render-etiqueta-samples` script. They
 * cover the shapes the label actually has to survive: the minimum a motoboy
 * pedido carries, a full label with an NF-e barcode, a reverse (return) label
 * whose foot is a second address block, a pickup whose address must NOT print,
 * and the maximal one used to prove the content still fits 150mm.
 */
import type { EtiquetaGenericaAddress, EtiquetaGenericaModel } from './model';

/** A real-shaped 44-digit chave (SP, CNPJ, modelo 55). */
export const CHAVE = '35260114200166000187550010000000123456789012';

const ENDERECO_CLIENTE: EtiquetaGenericaAddress = {
  logradouro: 'Rua das Palmeiras',
  numero: '1250',
  complemento: 'Apto 74B',
  bairro: 'Jardim Paulista',
  cidade: 'São Paulo',
  uf: 'SP',
  cep: '01415002',
};

const ENDERECO_SEDE: EtiquetaGenericaAddress = {
  logradouro: 'Avenida Industrial',
  numero: '900',
  complemento: null,
  bairro: 'Distrito Industrial',
  cidade: 'Campinas',
  uf: 'SP',
  cep: '13052000',
};

const BASE: EtiquetaGenericaModel = {
  title: 'Pedido 12345',
  subTitle: 'Motoboy Centro (Motoboy)',
  pedidoNumero: '12345',
  nfeNumero: null,
  nfeChave: null,
  ehReverso: false,
  cliente: { nome: 'Maria Aparecida de Souza', telefone: '5511987654321', cpfCnpj: '12345678909' },
  endereco: ENDERECO_CLIENTE,
  ocultarEndereco: false,
  recebedor: null,
  enderecoReverso: null,
  volumesResumo: null,
};

/** The minimum a seeded motoboy pedido carries: no NF-e, no recebedor, no volumes. */
export const MINIMAL_MODEL: EtiquetaGenericaModel = BASE;

/** An authorized NF-e, so the header carries the number, the Code 128 and the chave. */
export const COM_NFE_MODEL: EtiquetaGenericaModel = {
  ...BASE,
  nfeNumero: 4821,
  nfeChave: CHAVE,
};

/** Reverse shipment: "Retirada" at the customer, "Entrega" at the filial sede. */
export const REVERSO_MODEL: EtiquetaGenericaModel = {
  ...COM_NFE_MODEL,
  ehReverso: true,
  enderecoReverso: ENDERECO_SEDE,
};

/** Pickup: the address resolves but must not be printed. */
export const RETIRADA_MODEL: EtiquetaGenericaModel = {
  ...BASE,
  subTitle: 'Loja Matriz (Retirar na Loja)',
  ocultarEndereco: true,
};

/** Pickup with no address at all — legacy still says so. */
export const RETIRADA_SEM_ENDERECO_MODEL: EtiquetaGenericaModel = {
  ...RETIRADA_MODEL,
  endereco: null,
};

/** Every optional block present at once — the worst case for the page height. */
export const MAXIMAL_MODEL: EtiquetaGenericaModel = {
  ...REVERSO_MODEL,
  recebedor: {
    nome: 'João Carlos Ferreira da Silva',
    telefone: '5511912345678',
    cpfCnpj: '12345678000195',
  },
  volumesResumo: '3 volume(s) · 12,45 kg',
};
