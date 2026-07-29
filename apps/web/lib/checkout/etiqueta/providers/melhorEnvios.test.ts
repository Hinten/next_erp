import { describe, expect, it, vi } from 'vitest';
import {
  FreightNetworkError,
  FreightReauthRequiredError,
} from '@delfrance/integrations-freight-br/http-client';

import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import { melhorEnviosProvider } from './melhorEnvios';
import type { ComprarEtiquetaOutcome, EtiquetaProviderInput } from '../types';

/* -------------------------------- fixtures -------------------------------- */

function makeUi(over: Partial<EtiquetaProviderInput['ui']> = {}): EtiquetaProviderInput['ui'] {
  return {
    confirmRisk: vi.fn(async () => true),
    notify: vi.fn(),
    openUrl: vi.fn(),
    comprarEtiqueta: vi.fn(async (): Promise<ComprarEtiquetaOutcome> => ({ status: 'cancelled' })),
    ...over,
  };
}

function makeInput(over: {
  frete?: Partial<{ printLabelId: string | null; externalOptionId: string | null }>;
  formato?: 'pdf' | 'zpl2';
  freightClient?: unknown;
  ui?: EtiquetaProviderInput['ui'];
}): EtiquetaProviderInput {
  const frete = { printLabelId: null, externalOptionId: null, ...over.frete };
  return {
    db: {} as never,
    pedido: {} as never,
    pedidoId: 'p1',
    frete: frete as never,
    intFrete: { id: 'if1', tipo: INTEGRACAO_FRETE.melhorEnvios, data: {} as never },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: (over.freightClient ?? null) as never,
      nfeClient: null,
      printJob: vi.fn(),
    },
    ui: over.ui ?? makeUi(),
  };
}

/* --------------------------------- tests ---------------------------------- */

describe('melhorEnviosProvider', () => {
  it('prints an already-bought label: imprimir → openUrl → opened', async () => {
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const ui = makeUi();
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir }, ui });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(imprimir).toHaveBeenCalledWith('if1', 'lbl-1');
    expect(ui.openUrl).toHaveBeenCalledWith('https://me/label.pdf');
  });

  it('buys via the modal when a service is selected: bought+printUrl → opened', async () => {
    const comprarEtiqueta = vi.fn(
      async (): Promise<ComprarEtiquetaOutcome> => ({
        status: 'bought',
        printUrl: 'https://me/bought.pdf',
      }),
    );
    const ui = makeUi({ comprarEtiqueta });
    const input = makeInput({
      frete: { externalOptionId: 'opt-9' },
      freightClient: { imprimir: vi.fn() },
      ui,
    });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(comprarEtiqueta).toHaveBeenCalledWith(
      expect.objectContaining({ intFreteId: 'if1', pedidoId: 'p1' }),
    );
    expect(ui.openUrl).toHaveBeenCalledWith('https://me/bought.pdf');
  });

  it('returns skipped when the buy modal is cancelled', async () => {
    const ui = makeUi({ comprarEtiqueta: vi.fn(async () => ({ status: 'cancelled' as const })) });
    const input = makeInput({
      frete: { externalOptionId: 'opt-9' },
      freightClient: { imprimir: vi.fn() },
      ui,
    });

    expect(await melhorEnviosProvider.emitirOuImprimir(input)).toEqual({ status: 'skipped' });
    expect(ui.openUrl).not.toHaveBeenCalled();
  });

  it('needs a quote when there is no label and no selected option', async () => {
    const input = makeInput({ freightClient: { imprimir: vi.fn() } });
    expect(await melhorEnviosProvider.emitirOuImprimir(input)).toEqual({
      status: 'needs-quote',
      editorHref: '/pedidos/p1/editar',
    });
  });

  it('errors when the freight client is null', async () => {
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: null });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });

  it('warns (notify) but proceeds to PDF when zpl2 is requested', async () => {
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const ui = makeUi();
    const input = makeInput({
      frete: { printLabelId: 'lbl-1' },
      formato: 'zpl2',
      freightClient: { imprimir },
      ui,
    });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Melhor Envios' }));
  });

  it('maps a recognized freight error to an error outcome', async () => {
    const imprimir = vi.fn(async () => {
      throw new FreightReauthRequiredError('reauth', {});
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });

  it('rethrows an unrecognized error', async () => {
    const boom = new RangeError('boom');
    const imprimir = vi.fn(async () => {
      throw boom;
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    await expect(melhorEnviosProvider.emitirOuImprimir(input)).rejects.toBe(boom);
  });

  it('recognizes a network error as an error outcome (not a rethrow)', async () => {
    const imprimir = vi.fn(async () => {
      throw new FreightNetworkError('down');
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });
});
