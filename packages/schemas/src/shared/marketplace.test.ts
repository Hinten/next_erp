import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '../integracao';
import { VINCULO_INT_FRETE_CONTA } from '../intFrete';
import { FREIGHT_TIPO_CAPS, type FreightLabelMode } from './frete';
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

  it('is implemented and names its backend segment', () => {
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

  it('can pause and reactivate a listing', () => {
    // #1412. A distinct capability from publishing: inferring it from
    // `publicarAnuncio` is what the tri-state exists to stop.
    expect(ml.pausarAnuncio).toBe('sim');
    expect(ml.publicarAnuncio).toBe('sim');
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

describe('MARKETPLACE_TIPO_CAPS — the Shopee row', () => {
  it('records the full Shopee survey, implemented at step 22 (#1530)', () => {
    // The master plan's Phase 0 caps row
    // (`.master_plans/shopee/shopee-marketplace-integration.md` §1), written out
    // WHOLE like Loja Integrada's and Amazon's. Since the flip every 'sim' here is
    // a live dispatch — `estoque.suporte`, `enviarPreco` and `pausarAnuncio` are
    // what turn the three /produtos bulk actions on — so a silent edit to any of
    // them changes what an operator's click sends. The zero-'desconhecido' pin is
    // now the structural rule's ("an implemented channel has no unanswered
    // capability", below).
    expect(marketplaceCapsFor(INTEGRACAO_TIPO.shopee)).toEqual({
      channel: 'shopee',
      implementado: true,
      auth: 'oauth2',
      pkce: 'nao',
      notificacoes: 'push',
      assinaWebhook: 'sim',
      publicarAnuncio: 'sim',
      importarAnuncio: 'sim',
      variacoes: 'sim',
      categoriasEAtributos: 'sim',
      tabelaDeMedidas: 'sim',
      kitVirtual: 'sim',
      pausarAnuncio: 'sim',
      estoque: { suporte: 'sim', protocolo: 'por-anuncio', loteMax: 50, multiDeposito: 'sim' },
      enviarPreco: 'sim',
      importarPedido: 'sim',
      importarPagamento: 'sim',
      consolidaPacote: 'nao',
      dadosFiscaisSeparados: 'sim',
      etiqueta: 'fetch',
      rastreio: 'push',
      enviarNfe: 'sim',
      perguntas: 'nao',
      mensagensPosVenda: 'nao',
      reclamacoes: 'sim',
      origensConversa: [],
    });
  });
});

describe('MARKETPLACE_TIPO_CAPS — unbuilt channels', () => {
  it('leaves an unresearched capability as "desconhecido", never as a false claim', () => {
    const magalu = marketplaceCapsFor(INTEGRACAO_TIPO.magalu);

    expect(magalu.implementado).toBe(false);
    expect(magalu.channel).toBeNull();
    // ⚠️ The near-miss. `'nao'` here would assert Magalu cannot do these things,
    // which nobody has checked. Only `'desconhecido'` is honest until Phase 0 runs.
    expect(magalu.tabelaDeMedidas).toBe('desconhecido');
    expect(magalu.kitVirtual).toBe('desconhecido');
    expect(magalu.pausarAnuncio).toBe('desconhecido');
    expect(magalu.estoque.protocolo).toBe('desconhecido');
    expect(magalu.assinaWebhook).toBe('desconhecido');
  });

  it('records the full Loja Integrada survey with implementado still false', () => {
    // The master plan's Phase 0 caps row
    // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md`
    // §1), written out WHOLE: every later step derives its gate from one of
    // these values, so a silent edit to any of them re-plans a step.
    expect(marketplaceCapsFor(INTEGRACAO_TIPO.lojaIntegrada)).toEqual({
      channel: 'loja-integrada',
      implementado: false,
      auth: 'api-key',
      pkce: 'nao',
      notificacoes: 'push',
      assinaWebhook: 'sim',
      publicarAnuncio: 'sim',
      importarAnuncio: 'sim',
      variacoes: 'sim',
      categoriasEAtributos: 'sim',
      tabelaDeMedidas: 'nao',
      kitVirtual: 'nao',
      pausarAnuncio: 'sim',
      // One PUT per CHILD produto, no batch — so no batch size either.
      estoque: { suporte: 'sim', protocolo: 'por-anuncio', loteMax: null, multiDeposito: 'nao' },
      enviarPreco: 'sim',
      importarPedido: 'sim',
      importarPagamento: 'sim',
      consolidaPacote: 'nao',
      // The buyer's fiscal identity is inline on the order — ML and Shopee are
      // both 'sim' here, which is exactly why this is not "what the others did".
      dadosFiscaisSeparados: 'nao',
      // LI mints no label; we emit through the carrier the int_frete mapa picks.
      etiqueta: 'emit',
      rastreio: 'pull',
      enviarNfe: 'sim',
      perguntas: 'nao',
      mensagensPosVenda: 'nao',
      reclamacoes: 'nao',
      origensConversa: [],
    });

    // The structural rule's completeness pin, applied before the flip and
    // worded so it does NOT claim the channel is implemented: the survey is
    // done, the backend is not.
    const li = marketplaceCapsFor(INTEGRACAO_TIPO.lojaIntegrada);
    expect(CAMPOS_SUPORTE.filter((c) => li[c] === 'desconhecido')).toEqual([]);
    expect(li.estoque.suporte).not.toBe('desconhecido');
    expect(li.estoque.protocolo).not.toBe('desconhecido');
  });

  /**
   * ⚠️ `assinaWebhook: 'sim'` is the same VALUE for Shopee and Loja Integrada
   * and a different MECHANISM: Shopee signs the body with an HMAC, LI only
   * echoes back a static secret we chose. A value cannot carry that difference,
   * so the row's comment does — and this pins the comment, because the step-4
   * receiver is written from it. Losing it invites an HMAC verifier for a header
   * that is a plain Bearer token, which rejects every genuine delivery.
   */
  it('pins what assinaWebhook "sim" MEANS for Loja Integrada: authenticated, not signed', () => {
    const fonte = readFileSync(join(import.meta.dirname, 'marketplace.ts'), 'utf8');
    const inicio = fonte.indexOf('[INTEGRACAO_TIPO.lojaIntegrada]: {');
    const fim = fonte.indexOf('[INTEGRACAO_TIPO.', inicio + 1);
    expect(inicio, 'the Loja Integrada row is missing from marketplace.ts').toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);

    const linha = fonte.slice(inicio, fim);
    // The comment block between the previous field and `assinaWebhook`.
    const comentario = linha.slice(
      linha.indexOf("notificacoes: 'push',"),
      linha.indexOf("assinaWebhook: 'sim',"),
    );
    expect(comentario).toContain('AUTHENTICATED, NOT SIGNED');
    expect(comentario).toContain('Authorization: Bearer <token>');
    expect(comentario).toContain('Fail CLOSED');
    expect(comentario).toContain('Never write an HMAC verifier');
  });

  it('records the Amazon survey with implementado still false', () => {
    // The master plan's Phase 0 caps row
    // (`.master_plans/amazon/amazon-marketplace-integration.md` §1), written out
    // WHOLE like Loja Integrada's: every later step derives its gate from one of
    // these values, so a silent edit to any of them re-plans a step.
    expect(marketplaceCapsFor(INTEGRACAO_TIPO.amazon)).toEqual({
      channel: 'amazon',
      implementado: false,
      auth: 'oauth2',
      pkce: 'nao',
      // ORDER_CHANGE reaches us through SQS → EventBridge Pipe → API destination.
      notificacoes: 'push',
      assinaWebhook: 'sim',
      publicarAnuncio: 'sim',
      importarAnuncio: 'sim',
      variacoes: 'sim',
      categoriasEAtributos: 'sim',
      tabelaDeMedidas: 'nao',
      kitVirtual: 'nao',
      pausarAnuncio: 'sim',
      // The first feed channel: per-SKU patches for deltas, JSON_LISTINGS_FEED
      // (≤ 25,000 messages per document) for bulk.
      estoque: {
        suporte: 'sim',
        protocolo: 'feed-assincrono',
        loteMax: 25000,
        multiDeposito: 'nao',
      },
      enviarPreco: 'sim',
      importarPedido: 'sim',
      importarPagamento: 'sim',
      consolidaPacote: 'nao',
      // Inline in getOrder, but gated by app role and order status — 'sim' in
      // the sense Shopee's is, not a second call like ML's.
      dadosFiscaisSeparados: 'sim',
      etiqueta: 'fetch',
      rastreio: 'pull',
      enviarNfe: 'sim',
      perguntas: 'nao',
      mensagensPosVenda: 'nao',
      reclamacoes: 'desconhecido',
      origensConversa: [],
    });
  });

  it('leaves exactly ONE Amazon question open: reclamacoes, settled before step 22', () => {
    // ⚠️ Not the zero-'desconhecido' pin Loja Integrada carries (and every
    // implemented row gets from the structural rule): the Amazon survey left
    // `reclamacoes` honestly open (owner capture C6), and the structural rule
    // below forbids flipping `implementado` while it stays so.
    // Pinning the exact list fails BOTH ways — a new unknown sneaking in, and
    // C6 settling the question without this test and the plan saying so.
    const amazon = marketplaceCapsFor(INTEGRACAO_TIPO.amazon);
    expect(CAMPOS_SUPORTE.filter((c) => amazon[c] === 'desconhecido')).toEqual(['reclamacoes']);
    expect(amazon.estoque.suporte).not.toBe('desconhecido');
    expect(amazon.estoque.protocolo).not.toBe('desconhecido');
  });

  /**
   * ⚠️ The third `assinaWebhook: 'sim'` mechanism, and the easiest to get
   * wrong: Amazon puts NOTHING verifiable in a notification. What the receiver
   * checks is a key OUR EventBridge Connection adds, plus the payload's
   * `ApplicationId`. The step-3 receiver is written from this comment — losing
   * it invites either an HMAC verifier (rejects every genuine delivery) or a
   * receiver that trusts the body because "Amazon signs it" (accepts forgeries).
   */
  it('pins what assinaWebhook "sim" MEANS for Amazon: our relay key, not a signature', () => {
    const fonte = readFileSync(join(import.meta.dirname, 'marketplace.ts'), 'utf8');
    const inicio = fonte.indexOf('[INTEGRACAO_TIPO.amazon]: {');
    const fim = fonte.indexOf('[INTEGRACAO_TIPO.', inicio + 1);
    expect(inicio, 'the Amazon row is missing from marketplace.ts').toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);

    const linha = fonte.slice(inicio, fim);
    // The comment block between the previous field and `assinaWebhook`.
    const comentario = linha.slice(
      linha.indexOf("notificacoes: 'push',"),
      linha.indexOf("assinaWebhook: 'sim',"),
    );
    expect(comentario).toContain('NOT SIGNED');
    expect(comentario).toContain('API-key header OUR EventBridge');
    expect(comentario).toContain('ApplicationId === ours');
    expect(comentario).toContain('fail CLOSED');
    expect(comentario).toContain('Never write an HMAC verifier');
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
  'pausarAnuncio',
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

  it('a batch or feed stock protocol must declare its batch size', () => {
    // 'lote' with a null loteMax is not a usable answer — the fan-out cannot be
    // sized from it. 'feed-assincrono' is the same question one level up: a
    // feed document has a per-document message cap (Amazon: 25,000), and a
    // bulk push that does not know it cannot split itself into documents.
    for (const [tipo, caps] of Object.entries(MARKETPLACE_TIPO_CAPS)) {
      if (caps.estoque.protocolo !== 'lote' && caps.estoque.protocolo !== 'feed-assincrono') {
        continue;
      }
      expect(
        caps.estoque.loteMax,
        `tipo ${tipo} declares '${caps.estoque.protocolo}' with no loteMax`,
      ).not.toBeNull();
    }
  });

  it('is checking the batch rule against a row that really has a feed', () => {
    // Guards the rule above from passing vacuously: until Amazon, no row used
    // either protocol, so the loop body never ran.
    expect(
      Object.values(MARKETPLACE_TIPO_CAPS).some((c) => c.estoque.protocolo === 'feed-assincrono'),
    ).toBe(true);
  });
});

/**
 * The SAME channel is described by two tables: `MARKETPLACE_TIPO_CAPS` (keyed by
 * the conta's `integracao.tipo`, the INT enum) says who mints its label, and
 * `FREIGHT_TIPO_CAPS` (keyed by its `int_frete.tipo`, the STRING enum) says how
 * the label flow dispatches. `VINCULO_INT_FRETE_CONTA` is the bridge between the
 * two enums — so this is where a contradiction between them can be seen.
 */
describe('MARKETPLACE_TIPO_CAPS.etiqueta agrees with FREIGHT_TIPO_CAPS.labelMode (step 15)', () => {
  /** What each `etiqueta` answer demands of the freight row. */
  const LABEL_MODE_DA_ETIQUETA: Partial<
    Record<MarketplaceCapabilities['etiqueta'], FreightLabelMode>
  > = {
    // The marketplace mints the label: the freight row fetches it.
    fetch: 'fetch',
    // We mint it — through the carrier the conta's `mapa` routes the pedido
    // to, so the freight row is a ROUTER.
    emit: 'roteado',
  };

  function divergencias(tabelaFrete: typeof FREIGHT_TIPO_CAPS): string[] {
    const achados: string[] = [];
    for (const [canal, vinculo] of Object.entries(VINCULO_INT_FRETE_CONTA)) {
      const etiqueta = MARKETPLACE_TIPO_CAPS[vinculo.tipoConta].etiqueta;
      const labelMode = tabelaFrete[vinculo.tipoFrete].labelMode;
      const esperado = LABEL_MODE_DA_ETIQUETA[etiqueta];
      if (esperado === undefined) {
        achados.push(`${canal}: etiqueta '${etiqueta}' sem labelMode correspondente`);
      } else if (labelMode !== esperado) {
        achados.push(
          `${canal}: etiqueta '${etiqueta}' exige labelMode '${esperado}', não '${labelMode}'`,
        );
      }
    }
    return achados;
  }

  it('every channel with a freight doc is consistent across the two tables', () => {
    expect(divergencias(FREIGHT_TIPO_CAPS)).toEqual([]);
  });

  it('reads real rows, written out — fetch for Mercado Livre and Shopee, emit for Loja Integrada', () => {
    // Guards the loop above from passing over an empty bridge — without
    // freezing its membership: a channel joining the bridge is checked by the
    // loop, not refused here.
    expect(Object.keys(VINCULO_INT_FRETE_CONTA)).toEqual(
      expect.arrayContaining(['lojaIntegrada', 'mercadoLivre', 'shopee']),
    );
    expect(MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.mercadoLivre].etiqueta).toBe('fetch');
    expect(FREIGHT_TIPO_CAPS.mercadoLivre.labelMode).toBe('fetch');
    expect(MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.shopee].etiqueta).toBe('fetch');
    expect(FREIGHT_TIPO_CAPS.shopee.labelMode).toBe('fetch');
    expect(MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.lojaIntegrada].etiqueta).toBe('emit');
    expect(FREIGHT_TIPO_CAPS.lojaIntegrada.labelMode).toBe('roteado');
  });

  it('NEAR-MISS: an emit channel left on fetch — the contradiction this pins — is reported', () => {
    const tabela = {
      ...FREIGHT_TIPO_CAPS,
      lojaIntegrada: { ...FREIGHT_TIPO_CAPS.lojaIntegrada, labelMode: 'fetch' as const },
    };
    expect(divergencias(tabela)).toEqual([
      "lojaIntegrada: etiqueta 'emit' exige labelMode 'roteado', não 'fetch'",
    ]);
  });

  it('NEAR-MISS: a fetch channel made a router is reported too (the other direction)', () => {
    const tabela = {
      ...FREIGHT_TIPO_CAPS,
      shopee: { ...FREIGHT_TIPO_CAPS.shopee, labelMode: 'roteado' as const },
    };
    expect(divergencias(tabela)).toEqual([
      "shopee: etiqueta 'fetch' exige labelMode 'fetch', não 'roteado'",
    ]);
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

  it('marketplaceCapsOrNull answers null for a tipo OUTSIDE the enum', () => {
    // ⚠️ The near-miss for `ehMarketplace`, which only excludes the three known
    // non-marketplace tipos — anything else passes it. Firestore documents reach
    // the UI unparsed and the migrated corpus carries wire-format enums this
    // union does not model, so a stray value used to index the Record to
    // `undefined` while the signature promised a `MarketplaceCapabilities`.
    // Every caller dereferences the result; `/canais` crashed on `.implementado`.
    const fora = 9999 as IntegracaoTipo;
    expect(ehMarketplace(fora)).toBe(true);
    expect(marketplaceCapsOrNull(fora)).toBeNull();
  });
});
