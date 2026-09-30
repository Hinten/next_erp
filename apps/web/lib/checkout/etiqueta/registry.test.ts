import { describe, expect, it, vi } from 'vitest';
import {
  ESTADO_FRETE,
  FREIGHT_TIPO_CAPS,
  INTEGRACAO_FRETE,
  freightCapsFor,
  integracoesFreteSchema,
  isFreteMarketplaceOwned,
  type FreightTipoCapabilities,
  type IntegracaoFrete,
} from '@delfrance/schemas';

// The generic-label provider pulls in the Firestore-backed generic-label
// module; mock the barrel so importing the registry stays offline.
vi.mock('@/lib/etiqueta-generica', () => ({
  buildEtiquetaGenericaModel: vi.fn(async () => ({ title: 'Pedido 1' })),
  renderEtiquetaGenericaPdf: vi.fn(async () => new Blob(['pdf'])),
  renderEtiquetaGenericaZpl: vi.fn(() => '^XA^XZ'),
}));

import { PROVIDERS, emitirOuImprimirEtiqueta, resolveEtiquetaProvider } from './registry';
import { genericLabelProvider } from './providers/genericLabel';
import { melhorEnviosProvider } from './providers/melhorEnvios';
import { mercadoLivreProvider } from './providers/mercadoLivre';
import { shopeeProvider } from './providers/shopee';
import { unsupportedMarketplaceProvider } from './providers/unsupportedMarketplace';
import type { CheckoutEtiquetaProvider, EtiquetaProviderInput } from './types';

const caps = (over: Partial<FreightTipoCapabilities> = {}): FreightTipoCapabilities => ({
  marketplaceOwned: false,
  canQuote: false,
  canBuy: false,
  canPrint: false,
  canFetchLabel: false,
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
    ).toBe(mercadoLivreProvider);
    // W2: Shopee graduated — its own provider, never the placeholder (#1523).
    expect(
      resolveEtiquetaProvider(INTEGRACAO_FRETE.shopee, freightCapsFor(INTEGRACAO_FRETE.shopee)),
    ).toBe(shopeeProvider);
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

  it('never sends a marketplace-owned tipo to Melhor Envio or the generic label (the `bloco` safety)', () => {
    // `resolverIntFrete` produces `fonte: 'bloco'` ONLY for a marketplace-owned
    // tipo, and the two providers that need the `int_frete` DOCUMENT are
    // exactly these two — so this is the run-time half of their W6 refusal.
    const marketplace = integracoesFreteSchema.options.filter(isFreteMarketplaceOwned);
    expect(marketplace.length).toBeGreaterThan(0);
    for (const tipo of marketplace) {
      const p = resolveEtiquetaProvider(tipo, freightCapsFor(tipo));
      expect(p).not.toBe(melhorEnviosProvider);
      expect(p).not.toBe(genericLabelProvider);
    }
  });
});

/* -------------------------- the caps drift guard -------------------------- */

/**
 * Every tipo on which the registry and `FREIGHT_TIPO_CAPS` disagree, as
 * readable lines (empty = aligned). A pure function of the two tables, so the
 * guard's OWN power can be shown against a table mutated in the test — the
 * step-15 mistake in both directions — without touching either module.
 *
 *   1. `canFetchLabel` ⇔ a REAL marketplace provider is registered (defined,
 *      not the placeholder, and the tipo marketplace-owned). The cap alone
 *      makes the `/pedidos` row show two fetch buttons that end in "ainda não
 *      suportada"; the provider alone never renders its buttons at all
 *      (`etiquetaRowState` answers `'unsupported'`).
 *   2. A marketplace tipo that cannot fetch resolves to the placeholder.
 *   3. `labelMode 'emit'` resolves to Melhor Envio; a non-marketplace
 *      `generic`/`none` tipo resolves to the generic label.
 */
function divergencias(
  tabela: Readonly<Record<IntegracaoFrete, FreightTipoCapabilities>>,
  providers: Readonly<Partial<Record<IntegracaoFrete, CheckoutEtiquetaProvider>>>,
): string[] {
  const achados: string[] = [];
  for (const tipo of integracoesFreteSchema.options) {
    const c = tabela[tipo];
    const p = providers[tipo];
    const provedorReal =
      p !== undefined && p !== unsupportedMarketplaceProvider && c.marketplaceOwned;
    if (c.canFetchLabel !== provedorReal) {
      achados.push(
        `${tipo}: canFetchLabel=${String(c.canFetchLabel)}, provedor real=${String(provedorReal)}`,
      );
    }
    // Rules 2–3 read the resolution the REGISTRY makes, over the table given.
    const resolvido =
      p ?? (c.marketplaceOwned ? unsupportedMarketplaceProvider : genericLabelProvider);
    if (c.marketplaceOwned && !c.canFetchLabel && resolvido !== unsupportedMarketplaceProvider) {
      achados.push(`${tipo}: marketplace sem busca de etiqueta fora do placeholder`);
    }
    if (c.labelMode === 'emit' && resolvido !== melhorEnviosProvider) {
      achados.push(`${tipo}: labelMode emit fora do Melhor Envio`);
    }
    if (
      !c.marketplaceOwned &&
      (c.labelMode === 'generic' || c.labelMode === 'none') &&
      resolvido !== genericLabelProvider
    ) {
      achados.push(`${tipo}: tipo próprio sem a etiqueta genérica`);
    }
  }
  return achados;
}

describe('the registry agrees with FREIGHT_TIPO_CAPS (drift guard, W3)', () => {
  it('finds no divergence between the real registry and the real caps table', () => {
    expect(divergencias(FREIGHT_TIPO_CAPS, PROVIDERS)).toEqual([]);
  });

  it('the real resolution agrees with the model the guard reasons over', () => {
    // `divergencias` re-states `resolveEtiquetaProvider`'s fallback; this pins
    // the two together on every real tipo, so the guard cannot drift from the
    // registry it guards.
    for (const tipo of integracoesFreteSchema.options) {
      const c = FREIGHT_TIPO_CAPS[tipo];
      const esperado =
        PROVIDERS[tipo] ??
        (c.marketplaceOwned ? unsupportedMarketplaceProvider : genericLabelProvider);
      expect(resolveEtiquetaProvider(tipo, c)).toBe(esperado);
    }
  });

  it('reds the caps flip WITHOUT a provider (half 1): magalu fetches, nothing registered', () => {
    const tabela = {
      ...FREIGHT_TIPO_CAPS,
      magalu: { ...FREIGHT_TIPO_CAPS.magalu, canFetchLabel: true },
    };
    expect(divergencias(tabela, PROVIDERS)).toEqual([
      'magalu: canFetchLabel=true, provedor real=false',
    ]);
  });

  it('reds the provider WITHOUT the caps flip (half 2): shopee registered, cap off', () => {
    const tabela = {
      ...FREIGHT_TIPO_CAPS,
      shopee: { ...FREIGHT_TIPO_CAPS.shopee, canFetchLabel: false },
    };
    expect(divergencias(tabela, PROVIDERS)).toEqual([
      'shopee: canFetchLabel=false, provedor real=true',
      'shopee: marketplace sem busca de etiqueta fora do placeholder',
    ]);
  });

  it('reds a caps flip whose tipo is still claimed by the placeholder (the W2 twin)', () => {
    const providers = { ...PROVIDERS, shopee: unsupportedMarketplaceProvider };
    expect(divergencias(FREIGHT_TIPO_CAPS, providers)).toEqual([
      'shopee: canFetchLabel=true, provedor real=false',
    ]);
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
    intFrete: {
      fonte: 'doc',
      id: 'if1',
      tipo: over.tipo ?? INTEGRACAO_FRETE.melhorEnvios,
      data: {} as never,
    },
    formato: 'pdf',
    deps: {
      freightClient: { imprimir: vi.fn() } as never,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      printJob: vi.fn(),
    },
    ui: {
      confirmRisk: over.confirmRisk ?? vi.fn(async () => true),
      notify: vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(),
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

/* -------------------- the posted-risk confirm per provider -------------------- */

describe('the posted-risk confirm follows the provider’s `reimpressao` (#1523 R-f)', () => {
  // The Shopee provider with no client answers its own error — proof it was
  // DISPATCHED, without a network fake.
  const SEM_CLIENTE_SHOPEE = {
    status: 'error',
    message: 'Cliente da Shopee indisponível. Faça login novamente e tente de novo.',
  };

  it('declares Shopee `mesmo-documento` and leaves every other provider on the default', () => {
    expect(shopeeProvider.reimpressao).toBe('mesmo-documento');
    for (const p of [mercadoLivreProvider, melhorEnviosProvider, genericLabelProvider]) {
      expect(p.reimpressao ?? 'pode-duplicar').toBe('pode-duplicar');
    }
  });

  for (const estado of [
    ESTADO_FRETE.aguardandoPostagem,
    ESTADO_FRETE.error,
    ESTADO_FRETE.postado,
  ]) {
    it(`W8 — Shopee on \`${estado}\` dispatches with ZERO confirms`, async () => {
      const confirmRisk = vi.fn(async () => false);
      const input = makeInput({ estado, confirmRisk, tipo: INTEGRACAO_FRETE.shopee });
      expect(await emitirOuImprimirEtiqueta(input)).toEqual(SEM_CLIENTE_SHOPEE);
      expect(confirmRisk).not.toHaveBeenCalled();
    });
  }

  it('W7 — Mercado Livre still asks on `postado`, and a "no" skips before the provider', async () => {
    const confirmRisk = vi.fn(async () => false);
    const input = makeInput({
      estado: 'postado',
      confirmRisk,
      tipo: INTEGRACAO_FRETE.mercadoLivre,
    });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({ status: 'skipped' });
    expect(confirmRisk).toHaveBeenCalledTimes(1);
  });

  it('near-miss — Melhor Envio still asks on `aguardandoPostagem` (its reprint CAN duplicate)', async () => {
    const confirmRisk = vi.fn(async () => false);
    const input = makeInput({
      estado: ESTADO_FRETE.aguardandoPostagem,
      confirmRisk,
      tipo: INTEGRACAO_FRETE.melhorEnvios,
    });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({ status: 'skipped' });
    expect(confirmRisk).toHaveBeenCalledTimes(1);
  });

  it('semFrete still skips for Shopee — the skip turns off gate 2 only', async () => {
    const confirmRisk = vi.fn(async () => true);
    const input = makeInput({ modalidade: '9', confirmRisk, tipo: INTEGRACAO_FRETE.shopee });
    expect(await emitirOuImprimirEtiqueta(input)).toEqual({ status: 'skipped' });
    expect(confirmRisk).not.toHaveBeenCalled();
  });
});
