import { describe, expect, it, vi } from 'vitest';

import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreEtiquetaArtifact,
} from '@/lib/mercado-livre/client';

import { createMercadoLivreProvider } from './mercadoLivre';
import type { EtiquetaProviderInput } from '../types';

/* -------------------------------- fixtures -------------------------------- */

const LEGACY_NO_SHIPMENT_MSG =
  'Não foi possível encontrar o frete no Mercado Livre deste pedido. ' +
  'Entre em contato com o suporte para que o problema possa ser verificado.';

const LEGACY_NO_NFE_MSG =
  'Não foi possível obter a etiqueta do Mercado Livre, pois o pedido não possui ' +
  'nota fiscal eletrônica aprovada.';

const pendingError = () =>
  new MercadoLivreClientHttpError('etiqueta pendente de NF-e', 409, 'ML_INVOICE_PENDING');

function makeArtifact(
  over: Partial<MercadoLivreEtiquetaArtifact> = {},
): MercadoLivreEtiquetaArtifact {
  return {
    blob: new Blob(['label-bytes']),
    filename: 'etiqueta-1234.zip',
    contentType: 'application/zip',
    ...over,
  };
}

function makeUi(over: Partial<EtiquetaProviderInput['ui']> = {}): EtiquetaProviderInput['ui'] {
  return {
    confirmRisk: vi.fn(async () => true),
    notify: vi.fn(),
    openUrl: vi.fn(),
    comprarEtiqueta: vi.fn(),
    ...over,
  };
}

function makeInput(over: {
  externalId?: string | null;
  formato?: 'pdf' | 'zpl2';
  mercadoLivreClient?: unknown;
  printJob?: EtiquetaProviderInput['deps']['printJob'];
  sleep?: (ms: number) => Promise<void>;
  ui?: EtiquetaProviderInput['ui'];
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: { numero: '1234' } as never,
    pedidoId: 'p1',
    frete: { externalId: over.externalId === undefined ? 'SHIP-1' : over.externalId } as never,
    intFrete: { id: 'if1', tipo: INTEGRACAO_FRETE.mercadoLivre, data: {} as never },
    formato: over.formato ?? 'zpl2',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: (over.mercadoLivreClient ?? null) as never,
      printJob: over.printJob ?? (vi.fn(async () => 'printed' as const) as never),
      sleep: over.sleep,
    },
    ui: over.ui ?? makeUi(),
  };
}

/** Provider bound to a fake NF-e resolver (the Firestore seam stays untouched). */
function makeProvider(nfeId: string | null = 'nfe-7') {
  const resolveNfeId = vi.fn(async () => nfeId);
  return { provider: createMercadoLivreProvider(resolveNfeId), resolveNfeId };
}

/* --------------------------------- tests ---------------------------------- */

describe('mercadoLivreProvider', () => {
  it('fetches + prints a zpl2 label (printJob args pinned)', async () => {
    const art = makeArtifact();
    const etiqueta = vi.fn(async () => art);
    const printJob = vi.fn(async () => 'printed' as const);
    const { provider } = makeProvider();
    const input = makeInput({
      formato: 'zpl2',
      mercadoLivreClient: { etiqueta },
      printJob: printJob as never,
    });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledWith('p1', 'zpl2');
    expect(printJob).toHaveBeenCalledWith(art.blob, {
      fileName: 'etiqueta-1234.zip',
      contentType: 'application/zip',
      tamanho: 'etq',
    });
  });

  it('fetches + prints a pdf label', async () => {
    const art = makeArtifact({ filename: 'etiqueta-1234.pdf', contentType: 'application/pdf' });
    const etiqueta = vi.fn(async () => art);
    const printJob = vi.fn(async () => 'printed' as const);
    const { provider } = makeProvider();
    const input = makeInput({
      formato: 'pdf',
      mercadoLivreClient: { etiqueta },
      printJob: printJob as never,
    });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledWith('p1', 'pdf');
    expect(printJob).toHaveBeenCalledWith(art.blob, {
      fileName: 'etiqueta-1234.pdf',
      contentType: 'application/pdf',
      tamanho: 'etq',
    });
  });

  it("maps a print-agent 'downloaded' fallback to printed (both deliver the label)", async () => {
    const etiqueta = vi.fn(async () => makeArtifact());
    const printJob = vi.fn(async () => 'downloaded' as const);
    const { provider } = makeProvider();
    const input = makeInput({ mercadoLivreClient: { etiqueta }, printJob: printJob as never });

    expect(await provider.emitirOuImprimir(input)).toEqual({ status: 'printed' });
  });

  it('errors when the Mercado Livre client is null', async () => {
    const { provider } = makeProvider();
    const out = await provider.emitirOuImprimir(makeInput({ mercadoLivreClient: null }));
    expect(out).toEqual({
      status: 'error',
      message: 'Cliente do Mercado Livre indisponível. Faça login novamente e tente de novo.',
    });
  });

  it('errors with the legacy support message when the frete has no externalId', async () => {
    const etiqueta = vi.fn();
    const { provider } = makeProvider();
    for (const externalId of [null, '']) {
      const out = await provider.emitirOuImprimir(
        makeInput({ externalId, mercadoLivreClient: { etiqueta } }),
      );
      expect(out).toEqual({ status: 'error', message: LEGACY_NO_SHIPMENT_MSG });
    }
    expect(etiqueta).not.toHaveBeenCalled();
  });

  it('invoice_pending recovery: resends the resolved NF-e, waits, refetches once, prints', async () => {
    const art = makeArtifact();
    const etiqueta = vi.fn().mockRejectedValueOnce(pendingError()).mockResolvedValueOnce(art);
    const enviarNfe = vi.fn(async () => ({ enqueued: true }));
    const printJob = vi.fn(async () => 'printed' as const);
    const sleep = vi.fn(async () => {});
    const ui = makeUi();
    const { provider, resolveNfeId } = makeProvider('nfe-7');
    const input = makeInput({
      mercadoLivreClient: { etiqueta, enviarNfe },
      printJob: printJob as never,
      sleep,
      ui,
    });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(resolveNfeId).toHaveBeenCalledWith(input.db, 'p1');
    expect(enviarNfe).toHaveBeenCalledWith({ pedidoId: 'p1', nfeId: 'nfe-7' });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Enviando NF-e ao Mercado Livre — aguarde...' }),
    );
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(etiqueta).toHaveBeenCalledTimes(2);
    expect(printJob).toHaveBeenCalledTimes(1);
  });

  it('invoice_pending with no approved NF-e → legacy error, no resend, no retry', async () => {
    const etiqueta = vi.fn().mockRejectedValue(pendingError());
    const enviarNfe = vi.fn();
    const sleep = vi.fn(async () => {});
    const { provider } = makeProvider(null);
    const input = makeInput({ mercadoLivreClient: { etiqueta, enviarNfe }, sleep });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'error', message: LEGACY_NO_NFE_MSG });
    expect(enviarNfe).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('a second invoice_pending after the retry → error, exactly 2 fetches (never loops)', async () => {
    const etiqueta = vi.fn().mockRejectedValue(pendingError());
    const enviarNfe = vi.fn(async () => ({ enqueued: true }));
    const sleep = vi.fn(async () => {});
    const { provider } = makeProvider('nfe-7');
    const input = makeInput({ mercadoLivreClient: { etiqueta, enviarNfe }, sleep });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({
      status: 'error',
      message: 'A NF-e ainda não foi processada pelo Mercado Livre. Tente novamente em instantes.',
    });
    expect(etiqueta).toHaveBeenCalledTimes(2);
    expect(enviarNfe).toHaveBeenCalledTimes(1);
  });

  it('surfaces the enviar-nfe 409 message and does not retry the fetch', async () => {
    const etiqueta = vi.fn().mockRejectedValue(pendingError());
    const enviarNfe = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError(
          'A NF-e não está no estado aprovada.',
          409,
          'NFE_NAO_ELEGIVEL',
        ),
      );
    const sleep = vi.fn(async () => {});
    const { provider } = makeProvider('nfe-7');
    const input = makeInput({ mercadoLivreClient: { etiqueta, enviarNfe }, sleep });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'error', message: 'A NF-e não está no estado aprovada.' });
    expect(etiqueta).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps a non-pending http error to an error outcome carrying the route message', async () => {
    const etiqueta = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError(
          'Etiqueta indisponível no Mercado Livre.',
          409,
          'ML_ETIQUETA_INDISPONIVEL',
        ),
      );
    const enviarNfe = vi.fn();
    const { provider } = makeProvider();
    const input = makeInput({ mercadoLivreClient: { etiqueta, enviarNfe } });

    const out = await provider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'error', message: 'Etiqueta indisponível no Mercado Livre.' });
    expect(enviarNfe).not.toHaveBeenCalled();
  });

  it('maps a network error to an error outcome (not a rethrow)', async () => {
    const etiqueta = vi.fn().mockRejectedValue(new MercadoLivreClientNetworkError('down'));
    const { provider } = makeProvider();
    const out = await provider.emitirOuImprimir(makeInput({ mercadoLivreClient: { etiqueta } }));
    expect(out.status).toBe('error');
  });

  it('rethrows an unrecognized error', async () => {
    const boom = new RangeError('boom');
    const etiqueta = vi.fn().mockRejectedValue(boom);
    const { provider } = makeProvider();
    await expect(
      provider.emitirOuImprimir(makeInput({ mercadoLivreClient: { etiqueta } })),
    ).rejects.toBe(boom);
  });
});
