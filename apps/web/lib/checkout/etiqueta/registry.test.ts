import { describe, expect, it, vi } from 'vitest';
import {
  INTEGRACAO_FRETE,
  freightCapsFor,
  type FreightTipoCapabilities,
  type IntegracaoFrete,
} from '@delfrance/schemas';

// The generic-label provider pulls in the DOM/Firestore-backed generic-label
// module; mock the barrel so importing the registry stays offline.
vi.mock('@/lib/etiqueta-generica', () => ({
  buildEtiquetaGenericaModel: vi.fn(async () => ({ title: 'Pedido 1' })),
  renderAndExportEtiquetaGenericaPdf: vi.fn(async () => new Blob(['pdf'])),
}));

import { emitirOuImprimirEtiqueta, resolveEtiquetaProvider } from './registry';
import { genericLabelProvider } from './providers/genericLabel';
import { melhorEnviosProvider } from './providers/melhorEnvios';
import { unsupportedMarketplaceProvider } from './providers/unsupportedMarketplace';
import type { EtiquetaProviderInput } from './types';

const caps = (over: Partial<FreightTipoCapabilities> = {}): FreightTipoCapabilities => ({
  marketplaceOwned: false,
  canQuote: false,
  canBuy: false,
  canPrint: false,
  canTrack: false,
  labelMode: 'none',
  channel: null,
  ...over,
});

/* ---------------------------- resolve dispatch ---------------------------- */

describe('resolveEtiquetaProvider', () => {
  it('picks the exact provider for a registered tipo', () => {
    expect(
      resolveEtiquetaProvider(
        INTEGRACAO_FRETE.melhorEnvios,
        freightCapsFor(INTEGRACAO_FRETE.melhorEnvios),
      ),
    ).toBe(melhorEnviosProvider);
    expect(
      resolveEtiquetaProvider(
        INTEGRACAO_FRETE.mercadoLivre,
        freightCapsFor(INTEGRACAO_FRETE.mercadoLivre),
      ),
    ).toBe(unsupportedMarketplaceProvider);
    const genericos: IntegracaoFrete[] = [
      INTEGRACAO_FRETE.motoboy,
      INTEGRACAO_FRETE.fob,
      INTEGRACAO_FRETE.outros,
      INTEGRACAO_FRETE.retiradaNaLoja,
    ];
    for (const tipo of genericos) {
      expect(resolveEtiquetaProvider(tipo, freightCapsFor(tipo))).toBe(genericLabelProvider);
    }
  });

  it('falls back to unsupportedMarketplace for a marketplaceOwned tipo with no exact provider', () => {
    // A synthetic/legacy tipo not in PROVIDERS exercises the caps fallback.
    const tipo = 'futureMarketplace' as IntegracaoFrete;
    expect(resolveEtiquetaProvider(tipo, caps({ marketplaceOwned: true }))).toBe(
      unsupportedMarketplaceProvider,
    );
  });

  it('falls back to the generic label for a non-marketplace tipo with no exact provider', () => {
    const tipo = 'somethingElse' as IntegracaoFrete;
    expect(resolveEtiquetaProvider(tipo, caps({ marketplaceOwned: false }))).toBe(
      genericLabelProvider,
    );
  });
});

/* ------------------------------ shared entry ------------------------------ */

function makeInput(over: {
  modalidade?: string;
  estado?: string;
  printLabelId?: string | null;
  externalOptionId?: string | null;
  tipo?: IntegracaoFrete;
  confirmRisk?: EtiquetaProviderInput['ui']['confirmRisk'];
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: {} as never,
    pedidoId: 'p1',
    frete: {
      modalidade: over.modalidade ?? '0',
      estado: over.estado ?? 'iniciado',
      printLabelId: over.printLabelId ?? null,
      externalOptionId: over.externalOptionId ?? null,
    } as never,
    intFrete: { id: 'if1', tipo: over.tipo ?? INTEGRACAO_FRETE.melhorEnvios, data: {} as never },
    formato: 'pdf',
    deps: { freightClient: { imprimir: vi.fn() } as never, nfeClient: null, printJob: vi.fn() },
    ui: {
      confirmRisk: over.confirmRisk ?? vi.fn(async () => true),
      notify: vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
    },
  };
}

describe('emitirOuImprimirEtiqueta', () => {
  it('skips silently on semFrete (modalidade 9), never touching a provider', async () => {
    const input = makeInput({ modalidade: '9' });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({ status: 'skipped' });
  });

  it('skips when the operator declines an already-posted reprint', async () => {
    const confirmRisk = vi.fn(async () => false);
    const input = makeInput({ estado: 'postado', confirmRisk });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({ status: 'skipped' });
    expect(confirmRisk).toHaveBeenCalledTimes(1);
  });

  it('dispatches to the resolved provider once the gates pass', async () => {
    // melhorEnvios with neither label nor selected option → needs-quote.
    const input = makeInput({ tipo: INTEGRACAO_FRETE.melhorEnvios });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({
      status: 'needs-quote',
      editorHref: '/pedidos/p1/editar',
    });
  });

  it('confirmed already-posted reprint proceeds to dispatch', async () => {
    const confirmRisk = vi.fn(async () => true);
    const input = makeInput({
      estado: 'postado',
      confirmRisk,
      tipo: INTEGRACAO_FRETE.melhorEnvios,
    });
    const out = await emitirOuImprimirEtiqueta(input);
    expect(out.status).toBe('needs-quote');
    expect(confirmRisk).toHaveBeenCalledTimes(1);
  });
});
