import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider builds the model + renders the PDF through the generic-label
// module; mock the whole barrel so the test never touches Firestore or the DOM.
const { buildModelMock, renderMock } = vi.hoisted(() => ({
  buildModelMock: vi.fn(),
  renderMock: vi.fn(),
}));
vi.mock('@/lib/etiqueta-generica', () => ({
  buildEtiquetaGenericaModel: buildModelMock,
  renderAndExportEtiquetaGenericaPdf: renderMock,
}));

import { genericLabelProvider } from './genericLabel';
import type { EtiquetaProviderInput } from '../types';

function makeInput(over: {
  formato?: 'pdf' | 'zpl2';
  printJob?: EtiquetaProviderInput['deps']['printJob'];
  notify?: EtiquetaProviderInput['ui']['notify'];
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: { numero: '1234' } as never,
    pedidoId: 'p1',
    frete: {} as never,
    intFrete: { id: 'if1', tipo: 'motoboy', data: {} as never },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      printJob: over.printJob ?? (vi.fn(async () => 'printed') as never),
    },
    ui: {
      confirmRisk: vi.fn(async () => true),
      notify: over.notify ?? vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
    },
  };
}

describe('genericLabelProvider', () => {
  beforeEach(() => {
    buildModelMock.mockReset().mockResolvedValue({ title: 'Pedido 1234' });
    renderMock.mockReset().mockResolvedValue(new Blob(['pdf']));
  });

  it('builds the model, exports the PDF and prints it → printed', async () => {
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({ printJob });

    const out = await genericLabelProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(printJob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ tamanho: 'etq', contentType: 'application/pdf' }),
    );
  });

  it('still reports printed when the agent is down (printJob downloads)', async () => {
    const printJob = vi.fn(async () => 'downloaded' as const);
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ printJob }));
    expect(out).toEqual({ status: 'printed' });
  });

  it('warns on zpl2 but still builds the PDF', async () => {
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ formato: 'zpl2', notify }));
    expect(out).toEqual({ status: 'printed' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Etiqueta genérica' }));
    expect(renderMock).toHaveBeenCalledTimes(1);
  });
});
