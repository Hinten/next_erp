import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_NFE, ESTADO_PEDIDO, INTEGRACAO_FRETE } from '@delfrance/schemas';

import { onNfeAprovada } from './onNfeAprovada';

const h = vi.hoisted(() => ({ get: vi.fn(), enqueue: vi.fn() }));

vi.mock('./options', () => ({ FUNCTIONS_REGION: 'us-central1' }));
vi.mock('./lib/admin', () => ({
  getDb: () => ({
    collection: (path: string) => ({
      doc: (id: string) => ({ get: () => h.get(`${path}/${id}`) }),
    }),
  }),
}));
vi.mock('../../lib/marketplace/nfe/mlNfeUploadTasks', () => ({
  createMlNfeUploadScheduler: () => ({ enqueue: h.enqueue }),
}));

const xmlVenda = '<nfeProc><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide></nfeProc>';
const venda = { estado: ESTADO_NFE.aprovada, xml_nfe_proc: xmlVenda };

function run(after: typeof venda, before?: typeof venda) {
  const event = {
    data: { before: { data: () => before }, after: { data: () => after } },
    params: { pedidoId: 'pedido-1', nfeId: 's1' },
  };
  return onNfeAprovada.run(event as unknown as Parameters<typeof onNfeAprovada.run>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue({
    exists: true,
    data: () => ({
      estado: ESTADO_PEDIDO.pago,
      freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre },
    }),
  });
});

describe('onNfeAprovada', () => {
  it('reads the pedido once and enqueues an approved production sale', async () => {
    await run(venda);

    expect(h.get).toHaveBeenCalledExactlyOnceWith('pedidos/pedido-1');
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith({ pedidoId: 'pedido-1', nfeId: 's1' });
  });

  it('still enqueues if the invoice was already ready before the write', async () => {
    await run(venda, venda);

    expect(h.get).toHaveBeenCalledExactlyOnceWith('pedidos/pedido-1');
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['return', xmlVenda.replace('finNFe>1', 'finNFe>4')],
    ['adjustment', xmlVenda.replace('finNFe>1', 'finNFe>3')],
    ['missing purpose', xmlVenda.replace('<finNFe>1</finNFe>', '')],
  ])('skips a %s without a Firestore read', async (_kind, xml) => {
    await run({ ...venda, xml_nfe_proc: xml });

    expect(h.get).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
