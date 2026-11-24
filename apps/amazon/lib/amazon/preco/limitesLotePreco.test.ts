/**
 * The price batch's bounds, DERIVED: the message cap through the package's
 * own feed builder, on the worst price message the grammars allow, and the
 * most batches a run may name, from the worst greedy pack of a run's parts.
 */
import { describe, expect, it } from 'vitest';
import {
  AmazonConfigError,
  MAX_BYTES_FEED,
  MAX_MENSAGENS_FEED,
  type MensagemListingsFeed,
  TIPO_PRODUTO_LISTING_REGEX,
  montarDocumentoListingsFeed,
  patchDisponibilidadeAmazon,
  patchOfertaAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
  MAX_LOTES_EXECUCAO_PRECO_AMAZON,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
  lotesExecucaoPrecoAmazonSchema,
  sellingPartnerIdValido,
} from '@delfrance/schemas';

import { FLUXO_AMAZON, alvoValido } from '../core/valvulas';
import {
  MAX_MENSAGENS_LOTE_PRECO_AMAZON,
  MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON,
} from '../feeds/tarefaLote';
import { PAGINA_VARREDURA_VINCULOS_AMAZON } from '../listings/varreduraVinculos';
import { lotesDePartesPrecoAmazon } from './paginaPreco';

/** 64 visible-ASCII characters JSON escapes to two bytes each: the longest header. */
const SELLER_PIOR = '"'.repeat(64);
/** The longest `productType` the grammar lets a message carry: 64 characters. */
const TIPO_PIOR = `A${'Z'.repeat(63)}`;
/**
 * The longest JSON rendering of a positive number (23 characters). The
 * builder ACCEPTS it as a price (two decimals at most, by `roundReais`), so
 * the worst message below is a real one, not a stand-in.
 */
const PRECO_PIOR = Number.MAX_VALUE;

/** SKU `i` of the worst case: 40 code points, each a 4-byte UTF-8 character, `i` in the first. */
function skuPior(i: number): string {
  return String.fromCodePoint(0x10000 + i) + String.fromCodePoint(0x1f600).repeat(39);
}

/** The price message of `sku` at its worst: the longest type, three longest prices. */
function mensagemPior(sku: string): MensagemListingsFeed {
  return {
    sku,
    productType: TIPO_PIOR,
    patches: [patchOfertaAmazon({ base: PRECO_PIOR, minimo: PRECO_PIOR, maximo: PRECO_PIOR })],
  };
}

/** `n` worst messages in ONE price document, the report header included (a price feed asks for it). */
function documentoPior(n: number, sku: (i: number) => string = skuPior) {
  return () =>
    montarDocumentoListingsFeed({
      sellerId: SELLER_PIOR,
      mensagens: Array.from({ length: n }, (_v, i) => mensagemPior(sku(i))),
      relatorio: { incluir: ['issues'] },
    });
}

/** Whether `n` worst messages build. */
function constroi(n: number, sku?: (i: number) => string): boolean {
  try {
    documentoPior(n, sku)();
    return true;
  } catch (err) {
    if (err instanceof AmazonConfigError) return false;
    throw err;
  }
}

// Each case builds documents of up to 10 MB: headroom for a loaded CI runner.
describe(
  '★ the price message cap: the worst document a capped price batch builds, through the package’s OWN builder',
  { timeout: 60_000 },
  () => {
    it('the worst case is the worst the grammars allow, and a price message is LARGER than a stock one', () => {
      const sku = skuPior(MAX_MENSAGENS_FEED);
      expect([...sku]).toHaveLength(40);
      expect(new TextEncoder().encode(sku).byteLength).toBe(160);
      expect(alvoValido(FLUXO_AMAZON.preco, sku)).toBe(true);
      // NEAR-MISS: one code point more is no target the valve lets into a sent feed.
      expect(alvoValido(FLUXO_AMAZON.preco, `${sku}x`)).toBe(false);
      expect(TIPO_PRODUTO_LISTING_REGEX.test(TIPO_PIOR)).toBe(true);
      expect(TIPO_PRODUTO_LISTING_REGEX.test(`${TIPO_PIOR}Z`)).toBe(false);
      expect(JSON.stringify(PRECO_PIOR)).toHaveLength(23);
      expect(sellingPartnerIdValido(SELLER_PIOR)).toBe(true);
      // The stock cap was derived for a smaller message: it does not hold for price.
      const estoque = JSON.stringify({
        sku,
        patches: [patchDisponibilidadeAmazon(Number.MAX_SAFE_INTEGER)],
      });
      expect(JSON.stringify(mensagemPior(sku)).length).toBeGreaterThan(estoque.length + 200);
    });

    it('★ the worst-case price batch at the cap BUILDS, under the byte cap with headroom', () => {
      const doc = documentoPior(MAX_MENSAGENS_LOTE_PRECO_AMAZON)();
      expect(doc.mensagens).toBe(9_000);
      expect(doc.bytes.byteLength).toBeLessThanOrEqual(MAX_BYTES_FEED);
      // The documented worst case, byte for byte: 66% of the byte cap.
      expect(doc.bytes.byteLength).toBe(6_236_161);
      expect(doc.bytes.byteLength).toBeLessThan(0.66 * MAX_BYTES_FEED);
    });

    it('★ the TIGHTEST cap, found here: 13,704 worst messages build and 13,705 are refused (bytes bind first, under 25,000 messages); the cap keeps a third of it as headroom', () => {
      // From the cap's own document: every worst message has the same bytes but
      // its `messageId` digits, so the byte cap gives a first estimate, which
      // the builder then settles exactly.
      const umaMensagem = documentoPior(MAX_MENSAGENS_LOTE_PRECO_AMAZON)().bytes.byteLength / 9_000;
      let teto = Math.floor(MAX_BYTES_FEED / umaMensagem);
      while (constroi(teto + 1)) teto += 1;
      while (!constroi(teto)) teto -= 1;
      expect(teto).toBe(13_704);
      expect(teto).toBeLessThan(MAX_MENSAGENS_FEED);
      // NEAR-MISS: one message past the tightest cap is refused whole.
      expect(documentoPior(teto + 1)).toThrow(AmazonConfigError);
      expect(MAX_MENSAGENS_LOTE_PRECO_AMAZON).toBeLessThan(0.67 * teto);
    });

    it('★ NEAR-MISS against the stock cap alone: a price batch of 50 FULL parts (15,000 messages) is refused, so the price batch needs its own message cap', () => {
      const porPartes = MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON * MAX_ITENS_DIVERGENCIA_PRECO_AMAZON;
      expect(porPartes).toBe(15_000);
      expect(porPartes).toBeLessThanOrEqual(MAX_MENSAGENS_FEED);
      expect(documentoPior(porPartes)).toThrow(AmazonConfigError);
      expect(MAX_MENSAGENS_LOTE_PRECO_AMAZON).toBeLessThan(porPartes);
    });

    it('the headroom covers a dry-run document (every member, an invalid SKU included) of SKUs of 400 bytes once JSON-encoded; its own tightest SKU is 522 bytes (NEAR-MISS: 523 are refused)', () => {
      const comSkuDe = (bytes: number) => (i: number) => String(i).padStart(bytes, 'x');
      expect(alvoValido(FLUXO_AMAZON.preco, 'x'.repeat(400))).toBe(false);
      expect(constroi(MAX_MENSAGENS_LOTE_PRECO_AMAZON, comSkuDe(400))).toBe(true);
      expect(constroi(MAX_MENSAGENS_LOTE_PRECO_AMAZON, comSkuDe(522))).toBe(true);
      expect(constroi(MAX_MENSAGENS_LOTE_PRECO_AMAZON, comSkuDe(523))).toBe(false);
    });
  },
);

/** A deterministic stream of part sizes in `1…300` (a linear congruential generator). */
function partesAleatorias(semente: number, n: number): number[] {
  let x = semente;
  return Array.from({ length: n }, () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return 1 + (x % MAX_ITENS_DIVERGENCIA_PRECO_AMAZON);
  });
}

describe('★ MAX_LOTES_EXECUCAO_PRECO_AMAZON: the worst greedy pack of a run’s parts under both caps', () => {
  /**
   * A batch the message cap closes holds more than `cap − 300` items, so at
   * least this many parts; one the part cap closes holds exactly that cap.
   */
  const minimoDePartesPorLoteFechado = Math.min(
    Math.floor(
      (MAX_MENSAGENS_LOTE_PRECO_AMAZON - MAX_ITENS_DIVERGENCIA_PRECO_AMAZON) /
        MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
    ) + 1,
    MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON,
  );
  const pior = Math.ceil(MAX_PARTES_EXECUCAO_PRECO_AMAZON / minimoDePartesPorLoteFechado);

  it('★ derived from the two caps: every closed batch holds at least 30 parts, so 1,000 parts are at most 34 batches — the schema’s bound', () => {
    expect(minimoDePartesPorLoteFechado).toBe(30);
    expect(pior).toBe(34);
    expect(MAX_LOTES_EXECUCAO_PRECO_AMAZON).toBe(pior);
  });

  it('a part holds one walk page’s SKUs at most: the walk reads no more link docs per page than a part may store (the 300 both bounds rest on)', () => {
    expect(PAGINA_VARREDURA_VINCULOS_AMAZON).toBeLessThanOrEqual(
      MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
    );
  });

  it('★ NEAR-MISS at the message cap: 29 full parts + 299 (8,999 items) and a part of 2 ⇒ TWO batches, never one of 9,001', () => {
    const partes = [...Array.from({ length: 29 }, () => 300), 299, 2];
    expect(lotesDePartesPrecoAmazon(partes)).toEqual([
      { parteInicial: 0, partes: 30, itens: 8_999 },
      { parteInicial: 30, partes: 1, itens: 2 },
    ]);
    // …while a part of 1 still fits: exactly the cap.
    expect(lotesDePartesPrecoAmazon([...partes.slice(0, 30), 1])).toEqual([
      { parteInicial: 0, partes: 31, itens: 9_000 },
    ]);
  });

  it('★ the bound is reached: 1,000 FULL parts pack into exactly 34 batches (33 of 30, then 10)', () => {
    const lotes = lotesDePartesPrecoAmazon(
      Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 300),
    );
    expect(lotes).toHaveLength(pior);
    expect(lotes.slice(0, -1).every((l) => l.partes === 30 && l.itens === 9_000)).toBe(true);
    expect(lotes.at(-1)).toEqual({ parteInicial: 990, partes: 10, itens: 3_000 });
  });

  it('no other run of 1,000 parts packs into more (one-item parts, mixed sizes, 1,000 random runs)', () => {
    expect(
      lotesDePartesPrecoAmazon(Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 1)),
    ).toHaveLength(20);
    let maior = 0;
    let maisItens = 0;
    let maisPartes = 0;
    for (let semente = 1; semente <= 1_000; semente += 1) {
      const lotes = lotesDePartesPrecoAmazon(
        partesAleatorias(semente, MAX_PARTES_EXECUCAO_PRECO_AMAZON),
      );
      maior = Math.max(maior, lotes.length);
      for (const l of lotes) {
        maisItens = Math.max(maisItens, l.itens);
        maisPartes = Math.max(maisPartes, l.partes);
      }
    }
    expect(maior).toBeLessThanOrEqual(pior);
    // …and every batch of every run stays within BOTH caps.
    expect(maisItens).toBeLessThanOrEqual(MAX_MENSAGENS_LOTE_PRECO_AMAZON);
    expect(maisPartes).toBeLessThanOrEqual(MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON);
  });

  it('★ the run schema keeps the 34 batches of the worst pack; NEAR-MISS: a 35th is refused', () => {
    const lotes = lotesDePartesPrecoAmazon(
      Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 300),
    );
    const mapa = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_v, k) => {
          const l = lotes[Math.min(k, lotes.length - 1)] ?? {
            parteInicial: 0,
            partes: 1,
            itens: 1,
          };
          return [
            String(k),
            { execucaoIdLote: `lote-${String(k)}`, ...l, desfecho: null, motivoSemEnvio: null },
          ];
        }),
      );
    expect(lotesExecucaoPrecoAmazonSchema.safeParse(mapa(pior)).success).toBe(true);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse(mapa(pior + 1)).success).toBe(false);
  });
});
