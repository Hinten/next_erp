import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '../integracao';
import {
  MARKETPLACE_TIPO_CAPS,
  ehMarketplace,
  marketplaceCapsFor,
  marketplaceCapsOrNull,
  type MarketplaceCapabilities,
} from './marketplace';

/**
 * ⚠️ These assertions are written OUT, not derived by looping the table. A test
 * that iterates the constant it validates passes for any content — it only ever
 * proves the object is an object. The compile-time `Record<MarketplaceTipo, …>`
 * already guarantees completeness; what a runtime test can add is whether the
 * VALUES say what the running integration actually does.
 */

describe('MARKETPLACE_TIPO_CAPS — the Mercado Livre row', () => {
  const ml = marketplaceCapsFor(INTEGRACAO_TIPO.mercadoLivre);

  it('is the one implemented channel and names its backend segment', () => {
    expect(ml.implementado).toBe(true);
    expect(ml.channel).toBe('mercado-livre');
  });

  it('records that Mercado Livre does NOT sign its notifications', () => {
    // The receiver falls back to an `application_id` comparison that fails OPEN
    // precisely because there is no signature. Flipping this to 'sim' would make
    // a future channel author expect a header that never arrives.
    expect(ml.assinaWebhook).toBe('nao');
    expect(ml.notificacoes).toBe('push');
  });

  it('records that ML has NO usable virtual kit, while size charts are live', () => {
    // The pair that motivated the table: two capabilities of the same produto,
    // one supported and one not, neither derivable from "what ML did".
    expect(ml.kitVirtual).toBe('nao');
    expect(ml.tabelaDeMedidas).toBe('sim');
  });

  it('sends stock one listing at a time, with no batch size', () => {
    expect(ml.estoque.suporte).toBe('sim');
    expect(ml.estoque.protocolo).toBe('por-anuncio');
    expect(ml.estoque.loteMax).toBeNull();
    expect(ml.estoque.multiDeposito).toBe('sim');
  });

  it('fetches marketplace-minted labels rather than emitting its own', () => {
    expect(ml.etiqueta).toBe('fetch');
  });

  it('writes all three ML conversation origins into the unified inbox', () => {
    expect([...ml.origensConversa].sort()).toEqual(['mlclaims', 'mlped', 'mlperg']);
  });
});

describe('MARKETPLACE_TIPO_CAPS — unbuilt channels', () => {
  it('leaves an unresearched capability as "desconhecido", never as a false claim', () => {
    const amazon = marketplaceCapsFor(INTEGRACAO_TIPO.amazon);

    expect(amazon.implementado).toBe(false);
    expect(amazon.channel).toBeNull();
    // ⚠️ The near-miss. `'nao'` here would assert Amazon cannot do these things,
    // which nobody has checked. Only `'desconhecido'` is honest until Phase 0 runs.
    expect(amazon.tabelaDeMedidas).toBe('desconhecido');
    expect(amazon.kitVirtual).toBe('desconhecido');
    expect(amazon.estoque.protocolo).toBe('desconhecido');
    expect(amazon.assinaWebhook).toBe('desconhecido');
  });

  it('keeps the two Shopee facts that ARE evidenced, and nothing else', () => {
    const shopee = marketplaceCapsFor(INTEGRACAO_TIPO.shopee);

    expect(shopee.implementado).toBe(false);
    // Legacy carried an (disabled) HMAC verifier for Shopee pushes — #682.
    expect(shopee.assinaWebhook).toBe('sim');
    // `tabMedi.tabelasMedidasShopee` exists in the schema and holds migrated rows.
    expect(shopee.tabelaDeMedidas).toBe('sim');
    // Everything without a citation stays unanswered.
    expect(shopee.kitVirtual).toBe('desconhecido');
    expect(shopee.publicarAnuncio).toBe('desconhecido');
  });
});

/** The capability fields, spelled out so a new one must be added here too. */
const CAMPOS_SUPORTE = [
  'auth',
  'pkce',
  'notificacoes',
  'assinaWebhook',
  'publicarAnuncio',
  'importarAnuncio',
  'variacoes',
  'categoriasEAtributos',
  'tabelaDeMedidas',
  'kitVirtual',
  'enviarPreco',
  'importarPedido',
  'importarPagamento',
  'consolidaPacote',
  'dadosFiscaisSeparados',
  'etiqueta',
  'rastreio',
  'enviarNfe',
  'perguntas',
  'mensagensPosVenda',
  'reclamacoes',
] as const satisfies ReadonlyArray<keyof MarketplaceCapabilities>;

describe('MARKETPLACE_TIPO_CAPS — structural rules', () => {
  it('covers exactly the six marketplace tipos', () => {
    expect(
      Object.keys(MARKETPLACE_TIPO_CAPS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(
      [
        INTEGRACAO_TIPO.mercadoLivre,
        INTEGRACAO_TIPO.facebook,
        INTEGRACAO_TIPO.lojaIntegrada,
        INTEGRACAO_TIPO.magalu,
        INTEGRACAO_TIPO.shopee,
        INTEGRACAO_TIPO.amazon,
      ].sort((a, b) => a - b),
    );
  });

  it('an implemented channel has no unanswered capability', () => {
    // ⚠️ This is a RELATIONSHIP between two fields, not a restatement of either:
    // shipping a channel means every question about it was answered. A row that
    // flips `implementado` to true while leaving a 'desconhecido' behind is a
    // channel someone shipped without finishing the survey.
    for (const [tipo, caps] of Object.entries(MARKETPLACE_TIPO_CAPS)) {
      if (!caps.implementado) continue;

      const naoRespondidos = CAMPOS_SUPORTE.filter((c) => caps[c] === 'desconhecido');
      expect(naoRespondidos, `tipo ${tipo} is implemented but unanswered`).toEqual([]);
      expect(caps.estoque.suporte, `tipo ${tipo} estoque.suporte`).not.toBe('desconhecido');
      expect(caps.estoque.protocolo, `tipo ${tipo} estoque.protocolo`).not.toBe('desconhecido');
      expect(caps.channel, `tipo ${tipo} must name its backend segment`).not.toBeNull();
    }
  });

  it('is comparing against a table that really has an implemented row', () => {
    // Guards the assertion above from passing vacuously if every row were false.
    const implementados = Object.values(MARKETPLACE_TIPO_CAPS).filter((c) => c.implementado);
    expect(implementados.length).toBeGreaterThan(0);
  });

  it('a batch stock protocol must declare its batch size', () => {
    // 'lote' with a null loteMax is not a usable answer — the fan-out cannot be
    // sized from it. ML is 'por-anuncio', so today this holds trivially; it
    // exists for the first channel that is not.
    for (const [tipo, caps] of Object.entries(MARKETPLACE_TIPO_CAPS)) {
      if (caps.estoque.protocolo !== 'lote') continue;
      expect(caps.estoque.loteMax, `tipo ${tipo} declares 'lote' with no loteMax`).not.toBeNull();
    }
  });
});

describe('ehMarketplace / marketplaceCapsOrNull', () => {
  it('accepts the six marketplace tipos', () => {
    expect(ehMarketplace(INTEGRACAO_TIPO.mercadoLivre)).toBe(true);
    expect(ehMarketplace(INTEGRACAO_TIPO.shopee)).toBe(true);
    expect(ehMarketplace(INTEGRACAO_TIPO.amazon)).toBe(true);
    expect(ehMarketplace(INTEGRACAO_TIPO.magalu)).toBe(true);
    expect(ehMarketplace(INTEGRACAO_TIPO.lojaIntegrada)).toBe(true);
    expect(ehMarketplace(INTEGRACAO_TIPO.facebook)).toBe(true);
  });

  it('rejects the three tipos that are not marketplaces', () => {
    expect(ehMarketplace(INTEGRACAO_TIPO.whatsapp)).toBe(false);
    expect(ehMarketplace(INTEGRACAO_TIPO.balcao)).toBe(false);
    expect(ehMarketplace(INTEGRACAO_TIPO.nenhuma)).toBe(false);
  });

  it('marketplaceCapsOrNull answers null for a non-marketplace tipo', () => {
    expect(marketplaceCapsOrNull(INTEGRACAO_TIPO.whatsapp)).toBeNull();
    expect(marketplaceCapsOrNull(INTEGRACAO_TIPO.balcao)).toBeNull();
    expect(marketplaceCapsOrNull(INTEGRACAO_TIPO.mercadoLivre)?.channel).toBe('mercado-livre');
  });
});
