import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp } from 'firebase/app';
import { getFirestore, type DocumentReference } from 'firebase/firestore';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  pedidoSchema,
  type IntegracaoFrete,
} from '@delfrance/schemas';

const { getDoc } = vi.hoisted(() => ({
  getDoc:
    vi.fn<(ref: DocumentReference) => Promise<{ exists: () => boolean; data: () => unknown }>>(),
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc };
});

import { buildPrintModel } from './assemble';

const app = initializeApp({ projectId: 'demo-pedido-print' }, 'pedido-print-frete');
const db = getFirestore(app, 'default');
const PEDIDO_ID = 'pedido-exemplo';
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const FREIGHT_PATH = 'int_frete/configurada';
const FREIGHT_REF = `documents/${FREIGHT_PATH}`;

function mockPedido(tipo: IntegracaoFrete, ref: string | null, integracaoFrete?: { nome: string }) {
  const pedido = pedidoSchema.parse({
    estado: ESTADO_PEDIDO.pago,
    freteInicial: {
      estado: ESTADO_FRETE.iniciado,
      externalOptionIntegracao: tipo,
      integracaoFreteOuterRef: ref,
    },
  });
  const docs: Record<string, unknown> = { [PEDIDO_PATH]: pedido, [FREIGHT_PATH]: integracaoFrete };
  getDoc.mockImplementation(async ({ path }: DocumentReference) => {
    const data = docs[path];
    return { exists: () => data !== undefined, data: () => data };
  });
}

beforeEach(() => {
  getDoc.mockReset();
});
afterAll(() => deleteApp(app));

describe('buildPrintModel — freight name', () => {
  it('uses Shopee for marketplace freight with a null ref without reading a freight document', async () => {
    mockPedido(INTEGRACAO_FRETE.shopee, null);

    const model = await buildPrintModel(db, PEDIDO_ID);

    expect(model.frete?.tipoNome).toBe('Shopee');
    expect(getDoc.mock.calls.map(([ref]) => ref.path)).toEqual([PEDIDO_PATH]);
  });

  it('uses Mercado Livre when the referenced freight document is missing', async () => {
    mockPedido(INTEGRACAO_FRETE.mercadoLivre, FREIGHT_REF);

    const model = await buildPrintModel(db, PEDIDO_ID);

    expect(model.frete?.tipoNome).toBe('Mercado Livre');
    expect(getDoc).toHaveBeenCalledWith(expect.objectContaining({ path: FREIGHT_PATH }));
  });

  it('uses Genérico for non-marketplace freight with a null ref', async () => {
    mockPedido(INTEGRACAO_FRETE.outros, null);

    const model = await buildPrintModel(db, PEDIDO_ID);

    expect(model.frete?.tipoNome).toBe('Genérico');
  });

  it('prefers the resolved freight name over the marketplace label', async () => {
    mockPedido(INTEGRACAO_FRETE.shopee, FREIGHT_REF, { nome: 'Shopee Expedição Sul' });

    const model = await buildPrintModel(db, PEDIDO_ID);

    expect(model.frete?.tipoNome).toBe('Shopee Expedição Sul');
  });
});
