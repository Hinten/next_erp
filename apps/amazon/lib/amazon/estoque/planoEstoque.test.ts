/**
 * The stock plan and the batch form: the equality shortcut and the three rules
 * that override it (forcing, the recent-send rule, the feed-recent rule), each
 * with its near-miss; and the 30/31 switch with the 3,000-SKU delta bound.
 */
import { describe, expect, it } from 'vitest';
import {
  CANAL_MFN,
  type ListingAmazon,
  MARKETPLACE_ID_BR,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioEstoqueAmazon,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  type ResultadoEnvioEstoqueAmazon,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioEstoqueAmazonSchema,
} from '@delfrance/schemas';

import { type VeredictoListingEstoqueAmazon, avaliarListingEstoqueAmazon } from './gateListing';
import { MOTIVO_ESTOQUE_AMAZON } from './motivosEstoque';
import {
  CAMINHO_LOTE_ESTOQUE_AMAZON,
  DESTINO_LOTE_DELTA_ESTOQUE_AMAZON,
  DIRECAO_ESTOQUE_AMAZON,
  JANELA_VISIBILIDADE_MS,
  type OpcoesPlanoEstoqueAmazon,
  type PlanoEstoqueAmazon,
  REGRA_ESCRITA_ESTOQUE_AMAZON,
  caminhoDoLote,
  destinoDoLoteDelta,
  planejarEstoqueAmazon,
} from './planoEstoque';

const MIN = 60_000;
/** ms — the live read's instant (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;
const SEM_OPCOES: OpcoesPlanoEstoqueAmazon = { forcar: false, feedRecenteEmMs: null };

/** An enviável gate showing `quantidade` (null = Amazon shows none). */
function mostra(quantidade: number | null): VeredictoListingEstoqueAmazon {
  return { enviavel: true, quantidadeAmazon: quantidade, contagens: [] };
}

/** A stored patch outcome of `quantidade`, sent `haMs` before the read. */
function patch(
  quantidade: number,
  haMs: number,
  resultado: ResultadoEnvioEstoqueAmazon = RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
): EnvioEstoqueAmazon {
  return envioEstoqueAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs: AGORA - haMs,
    quantidade,
    resultado,
    submissionId: resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto ? null : 'sub-1',
  });
}

/** A stored feed outcome (no quantity), sent `haMs` before the read. */
function feed(haMs: number): EnvioEstoqueAmazon {
  return envioEstoqueAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
    emMs: AGORA - haMs,
    quantidade: null,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
    feedId: '50001',
    problemas: [{ code: 'W1', severity: 'WARNING' }],
  });
}

function plano(
  erp: number,
  gate: VeredictoListingEstoqueAmazon,
  envio: EnvioEstoqueAmazon | null = null,
  opcoes: OpcoesPlanoEstoqueAmazon = SEM_OPCOES,
): PlanoEstoqueAmazon {
  return planejarEstoqueAmazon(erp, gate, envio, AGORA, opcoes);
}

/** A BR listing the real gate reads, overridable. */
function listing(over: Partial<ListingAmazon> = {}): ListingAmazon {
  return {
    sku: 'SKU-1',
    summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: 'ASIN-UM' }],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: CANAL_MFN, quantity: 3 }],
    ...over,
  };
}

describe('★ the plan: the equality shortcut', () => {
  it('ERP 5 vs Amazon 5 ⇒ no write (igual)', () => {
    const p = plano(5, mostra(5));
    expect(p.escrever).toBe(false);
    expect(p.diff).toEqual({
      quantidadeErp: 5,
      quantidadeAmazon: 5,
      direcao: DIRECAO_ESTOQUE_AMAZON.igual,
      motivo: MOTIVO_ESTOQUE_AMAZON.igual,
      regra: null,
    });
  });

  it('ERP 5 vs Amazon 4 ⇒ write, sobe, and the quantity is the ERP’s', () => {
    const p = plano(5, mostra(4));
    expect(p.escrever).toBe(true);
    expect(p.quantidade).toBe(5);
    expect(p.diff).toEqual({
      quantidadeErp: 5,
      quantidadeAmazon: 4,
      direcao: DIRECAO_ESTOQUE_AMAZON.sobe,
      motivo: MOTIVO_ESTOQUE_AMAZON.enviado,
      regra: REGRA_ESCRITA_ESTOQUE_AMAZON.diferente,
    });
  });

  it('ERP 5 vs no Amazon quantity (null) ⇒ write: an absent quantity counts as different', () => {
    const p = plano(5, mostra(null));
    expect(p.escrever).toBe(true);
    expect(p.diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.sobe);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.diferente);
  });

  it('ERP 0 vs Amazon 3 ⇒ write, zera; ERP 2 vs Amazon 3 ⇒ desce', () => {
    expect(plano(0, mostra(3)).diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.zera);
    expect(plano(0, mostra(3)).escrever).toBe(true);
    expect(plano(0, mostra(null)).diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.zera);
    expect(plano(2, mostra(3)).diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.desce);
    expect(plano(0, mostra(0)).diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.igual);
    expect(plano(0, mostra(0)).escrever).toBe(false);
  });

  it('a refused listing never writes, and its diff names the gate’s refusal', () => {
    const p = plano(5, { enviavel: false, motivo: MOTIVO_ESTOQUE_AMAZON.afn });
    expect(p.escrever).toBe(false);
    // The quantity a plan carries is always the ERP's, even one that writes nothing.
    expect(p.quantidade).toBe(5);
    expect(p.diff).toEqual({
      quantidadeErp: 5,
      quantidadeAmazon: null,
      direcao: null,
      motivo: MOTIVO_ESTOQUE_AMAZON.afn,
      regra: null,
    });
  });

  it('the diff is primitives only (the engine’s dry-run line campos)', () => {
    for (const valor of Object.values(plano(5, mostra(4), patch(3, MIN)).diff)) {
      expect(valor === null || ['string', 'number', 'boolean'].includes(typeof valor)).toBe(true);
    }
  });
});

describe('★ the recent-send rule (a live read inside the visibility lag of our own PATCH)', () => {
  it('the window is the DOCUMENTED 15 minutes, not the typical 1–5', () => {
    expect(JANELA_VISIBILIDADE_MS).toBe(900_000);
  });

  it('the link sent 3 two minutes ago, ERP 5, Amazon reads 5 ⇒ write (envio-recente)', () => {
    const p = plano(5, mostra(5), patch(3, 2 * MIN));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.envioRecente);
    expect(p.diff.direcao).toBe(DIRECAO_ESTOQUE_AMAZON.igual);
  });

  it('sent 3 ten minutes ago ⇒ still write (inside the 15-min lag)', () => {
    expect(plano(5, mostra(5), patch(3, 10 * MIN)).escrever).toBe(true);
  });

  it('NEAR-MISS: sent 3 sixteen minutes ago ⇒ no write (past the lag, the read is trusted)', () => {
    expect(plano(5, mostra(5), patch(3, 16 * MIN)).escrever).toBe(false);
  });

  it('the boundary: one ms inside the window writes, exactly 15 minutes does not', () => {
    expect(plano(5, mostra(5), patch(3, JANELA_VISIBILIDADE_MS - 1)).escrever).toBe(true);
    expect(plano(5, mostra(5), patch(3, JANELA_VISIBILIDADE_MS)).escrever).toBe(false);
  });

  it('NEAR-MISS: sent 5 two minutes ago (the ERP’s own value) ⇒ no write', () => {
    expect(plano(5, mostra(5), patch(5, 2 * MIN)).escrever).toBe(false);
  });

  it('★ NEAR-MISS: a via feed outcome (quantidade null) two minutes ago is IGNORED ⇒ no write', () => {
    const p = plano(5, mostra(5), feed(2 * MIN));
    expect(p.escrever).toBe(false);
    expect(p.diff.motivo).toBe(MOTIVO_ESTOQUE_AMAZON.igual);
  });

  it('an incerto send of 4 (its answer lost), ERP 3, Amazon reads 3 ⇒ write', () => {
    const p = plano(3, mostra(3), patch(4, 2 * MIN, RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.envioRecente);
  });

  it('a recusado send of 4 inside the lag counts too (the rule reads the quantity sent, not its result)', () => {
    expect(
      plano(3, mostra(3), patch(4, 2 * MIN, RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado)).escrever,
    ).toBe(true);
  });
});

describe('★ forcing (the catch-up): drops ONLY the equality shortcut', () => {
  const forcado: OpcoesPlanoEstoqueAmazon = { forcar: true, feedRecenteEmMs: null };

  it('ERP 3 and Amazon 3, forced ⇒ write (forcado)', () => {
    const p = plano(3, mostra(3), null, forcado);
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.forcado);
    expect(p.quantidade).toBe(3);
  });

  it('NEAR-MISS: the same state unforced (a delta task) ⇒ no write', () => {
    expect(plano(3, mostra(3)).escrever).toBe(false);
  });

  it('forcing is rule 1: a forced send whose read also differs is still named forcado', () => {
    for (const amazon of [4, null]) {
      const p = plano(3, mostra(amazon), null, forcado);
      expect(p.escrever, String(amazon)).toBe(true);
      expect(p.diff.regra, String(amazon)).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.forcado);
    }
  });

  it('NEAR-MISS: forced on a BR variation parent or an AFN listing ⇒ still no write (every gate kept)', () => {
    const pai = avaliarListingEstoqueAmazon(
      listing({
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: 'VARIATION', childSkus: ['F1'] }],
          },
        ],
      }),
      { asinsDoVinculo: [] },
    );
    const afn = avaliarListingEstoqueAmazon(
      listing({ fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 3 }] }),
      { asinsDoVinculo: [] },
    );
    for (const gate of [pai, afn]) {
      expect(gate.enviavel).toBe(false);
      expect(plano(3, gate, null, forcado).escrever).toBe(false);
    }
    expect(
      plano(
        3,
        avaliarListingEstoqueAmazon(MOTIVO_ESTOQUE_AMAZON.naoListado, { asinsDoVinculo: [] }),
        null,
        forcado,
      ),
    ).toMatchObject({ escrever: false, diff: { motivo: MOTIVO_ESTOQUE_AMAZON.naoListado } });
  });
});

describe('★ the feed-recent rule (an equal read right after the conta’s last stock feed ended)', () => {
  // A delta feed set X to 5 while Amazon showed 3; the feed ended 4 minutes ago
  // and its recovery ran; the ERP moved back to 3; Amazon still reads 3.
  const terminou = (haMs: number): OpcoesPlanoEstoqueAmazon => ({
    forcar: false,
    feedRecenteEmMs: AGORA - haMs,
  });

  it('the feed ended 4 minutes ago, ERP 3, Amazon reads 3 ⇒ a write (feed-recente)', () => {
    const p = plano(3, mostra(3), null, terminou(4 * MIN));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.feedRecente);
  });

  it('★ the SKU’s own OLD patch outcome does not switch the rule off: a patch of 5 an hour ago, the feed ended 4 minutes ago, ERP 3, Amazon 3 ⇒ a write', () => {
    // A feed member accepted by the feed gets no new link outcome, so its stored one is old.
    const p = plano(3, mostra(3), patch(5, 60 * MIN), terminou(4 * MIN));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.feedRecente);
    // NEAR-MISS: the same old patch, the feed ended 16 minutes ago ⇒ no write.
    expect(plano(3, mostra(3), patch(5, 60 * MIN), terminou(16 * MIN)).escrever).toBe(false);
  });

  it('inside the lag the rule keeps writing (redundant absolute sends, even after the SKU’s own fresh patch of the ERP value); past it, none', () => {
    // A read-back of our own patch of 3, one minute old, still inside the feed's lag: written again.
    expect(plano(3, mostra(3), patch(3, MIN), terminou(5 * MIN))).toMatchObject({
      escrever: true,
      diff: { regra: REGRA_ESCRITA_ESTOQUE_AMAZON.feedRecente },
    });
    expect(plano(3, mostra(3), patch(3, MIN), terminou(16 * MIN)).escrever).toBe(false);
  });

  it('★ rule 3 is named before rule 4 when both fire: our patch of 3 two minutes ago and a feed that ended 4 minutes ago, ERP 5, Amazon 5 ⇒ envio-recente', () => {
    const p = plano(5, mostra(5), patch(3, 2 * MIN), terminou(4 * MIN));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.envioRecente);
  });

  it('NEAR-MISS: the feed ended 16 minutes ago ⇒ no write', () => {
    expect(plano(3, mostra(3), null, terminou(16 * MIN)).escrever).toBe(false);
  });

  it('the boundary: one ms inside the window writes, exactly 15 minutes does not', () => {
    expect(plano(3, mostra(3), null, terminou(JANELA_VISIBILIDADE_MS - 1)).escrever).toBe(true);
    expect(plano(3, mostra(3), null, terminou(JANELA_VISIBILIDADE_MS)).escrever).toBe(false);
  });

  it('NEAR-MISS: no feed on record ⇒ no write', () => {
    expect(plano(3, mostra(3), null, { forcar: false, feedRecenteEmMs: null }).escrever).toBe(
      false,
    );
  });

  it('NEAR-MISS: Amazon reads 4 ⇒ a write anyway, by the ordinary rule', () => {
    const p = plano(3, mostra(4), null, terminou(16 * MIN));
    expect(p.escrever).toBe(true);
    expect(p.diff.regra).toBe(REGRA_ESCRITA_ESTOQUE_AMAZON.diferente);
  });
});

describe('the plan’s inputs are ms and quantities, checked', () => {
  it('a quantity or an instant outside a non-negative safe integer is a RangeError naming the field', () => {
    expect(() => planejarEstoqueAmazon(-1, mostra(1), null, AGORA, SEM_OPCOES)).toThrow(
      /quantidadeErp/,
    );
    expect(() => planejarEstoqueAmazon(1.5, mostra(1), null, AGORA, SEM_OPCOES)).toThrow(
      RangeError,
    );
    expect(() => planejarEstoqueAmazon(1, mostra(1), null, Number.NaN, SEM_OPCOES)).toThrow(
      /agoraMs/,
    );
    expect(() =>
      planejarEstoqueAmazon(1, mostra(1), null, AGORA, { forcar: false, feedRecenteEmMs: -5 }),
    ).toThrow(/feedRecenteEmMs/);
  });
});

describe('★ the 30/31 switch and the 3,000-SKU delta bound', () => {
  it('the switch is 30, pinned by value; the catalogue-zero floor stays 1,500, a separate constant', () => {
    expect(LIMIAR_FEED_ESTOQUE_AMAZON).toBe(30);
    expect(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON).toBe(3_000);
    expect(LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON).toBe(1_500);
  });

  it('caminhoDoLote: 1 and 30 ⇒ patches; 31 ⇒ feed (NEAR-MISS pair)', () => {
    expect(caminhoDoLote(1)).toBe(CAMINHO_LOTE_ESTOQUE_AMAZON.patches);
    expect(caminhoDoLote(30)).toBe(CAMINHO_LOTE_ESTOQUE_AMAZON.patches);
    expect(caminhoDoLote(31)).toBe(CAMINHO_LOTE_ESTOQUE_AMAZON.feed);
  });

  it('NEAR-MISS: the old 1,500 switch would send 1,499 as patches; here it is a feed', () => {
    expect(caminhoDoLote(1_499)).toBe(CAMINHO_LOTE_ESTOQUE_AMAZON.feed);
    expect(caminhoDoLote(1_500)).toBe(CAMINHO_LOTE_ESTOQUE_AMAZON.feed);
  });

  it('caminhoDoLote refuses an empty or a fractional batch', () => {
    expect(() => caminhoDoLote(0)).toThrow(RangeError);
    expect(() => caminhoDoLote(2.5)).toThrow(RangeError);
  });

  it('destinoDoLoteDelta: 0 nada, 1 and 30 patches, 31 and 3,000 feed, 3,001 reconciliacao', () => {
    expect(destinoDoLoteDelta(0)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.nada);
    expect(destinoDoLoteDelta(1)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches);
    expect(destinoDoLoteDelta(30)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches);
    expect(destinoDoLoteDelta(31)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed);
    expect(destinoDoLoteDelta(1_500)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed);
    expect(destinoDoLoteDelta(3_000)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed);
    expect(destinoDoLoteDelta(3_001)).toBe(DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.reconciliacao);
  });

  it('destinoDoLoteDelta refuses a negative or a fractional count', () => {
    expect(() => destinoDoLoteDelta(-1)).toThrow(RangeError);
    expect(() => destinoDoLoteDelta(0.5)).toThrow(RangeError);
  });
});
