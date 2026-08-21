import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider builds the model then renders it through the generic-label
// module; mock the whole barrel so the test never touches Firestore or jsPDF.
const { buildModelMock, renderPdfMock, renderZplMock } = vi.hoisted(() => ({
  buildModelMock: vi.fn(),
  renderPdfMock: vi.fn(),
  renderZplMock: vi.fn(),
}));
vi.mock('@/lib/etiqueta-generica', () => ({
  buildEtiquetaGenericaModel: buildModelMock,
  renderEtiquetaGenericaPdf: renderPdfMock,
  renderEtiquetaGenericaZpl: renderZplMock,
}));

import { INTEGRACAO_FRETE } from '@delfrance/schemas';

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
    intFrete: { id: 'if1', tipo: INTEGRACAO_FRETE.motoboy, data: {} as never },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
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
    renderPdfMock.mockReset().mockResolvedValue(new Blob(['%PDF-1.3']));
    renderZplMock.mockReset().mockReturnValue('^XA^CI28^XZ');
  });

  it('builds the model, renders the PDF and prints it → printed', async () => {
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({ printJob });

    const out = await genericLabelProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(renderPdfMock).toHaveBeenCalledTimes(1);
    expect(renderZplMock).not.toHaveBeenCalled();
    expect(printJob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        tamanho: 'etq',
        contentType: 'application/pdf',
        fileName: 'etiqueta-1234.pdf',
      }),
    );
  });

  it('still reports printed when the agent is down, but SAYS the label was downloaded', async () => {
    // The row action is silent on a successful print, so without the toast an
    // agent that is down is indistinguishable from a print that worked — the
    // click appears to do nothing and the label is sitting in Downloads.
    const printJob = vi.fn(async () => 'downloaded' as const);
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ printJob, notify }));
    expect(out).toEqual({ status: 'printed' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringContaining('etiqueta-1234.pdf'),
      }),
    );
  });

  it('tells the operator a downloaded ZPL is not a file they can just open', async () => {
    // The two formats fail differently: a downloaded PDF is double-clickable, a
    // `.zpl2` is a text file Notepad will happily print as `^XA^CI28…` source.
    const notify = vi.fn();
    await genericLabelProvider.emitirOuImprimir(
      makeInput({
        formato: 'zpl2',
        printJob: vi.fn(async () => 'downloaded' as const),
        notify,
      }),
    );
    const message = String(notify.mock.calls[0]![0].message);
    expect(message).toContain('etiqueta-1234.zpl2');
    expect(message).toContain('Zebra');
    expect(message).toContain('Bloco de Notas');
  });

  it('stays silent when the agent actually printed it', async () => {
    const notify = vi.fn();
    await genericLabelProvider.emitirOuImprimir(
      makeInput({ printJob: vi.fn(async () => 'printed' as const), notify }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('renders real ZPL for zpl2 and sends it down the agent’s plain-text channel', async () => {
    // Legacy toasted "ainda não implementado" here and printed the PDF instead —
    // on the format that was the operator's default.
    const printJob = vi.fn(async () => 'printed' as const);
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(
      makeInput({ formato: 'zpl2', printJob, notify }),
    );

    expect(out).toEqual({ status: 'printed' });
    expect(renderZplMock).toHaveBeenCalledTimes(1);
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(printJob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        tamanho: 'etq',
        contentType: 'text/plain;charset=utf-8',
        fileName: 'etiqueta-1234.zpl2',
      }),
    );
  });

  it('carries the ZPL bytes themselves, not a rasterised label', async () => {
    renderZplMock.mockReturnValue('^XA^CI28^FDSão Paulo^FS^XZ');
    let sent: Blob | null = null;
    const printJob: EtiquetaProviderInput['deps']['printJob'] = async (blob) => {
      sent = blob;
      return 'printed';
    };
    await genericLabelProvider.emitirOuImprimir(makeInput({ formato: 'zpl2', printJob }));

    expect(sent).not.toBeNull();
    expect(await (sent as unknown as Blob).text()).toBe('^XA^CI28^FDSão Paulo^FS^XZ');
  });

  it('returns an error outcome + red toast when rendering fails (best-effort)', async () => {
    renderPdfMock.mockRejectedValue(new Error('canvas boom'));
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ notify }));
    expect(out).toEqual({ status: 'error', message: 'canvas boom' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
