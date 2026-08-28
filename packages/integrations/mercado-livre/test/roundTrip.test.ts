/**
 * **Round-trip contract** — the offline half of the #1087 live run.
 *
 * The question the live run exists to answer is "if we publish a produto to
 * Mercado Livre and import it back, do we get the same values?". Most of that
 * question does not need Mercado Livre at all: the export mapper
 * (`buildItemPayload`) and the import mappers (`mapMlItemToImport`,
 * `mapMlVariationsToImport`) are pure, so the composition can be exercised here
 * — for free, on every PR, before a single test-user slot is spent.
 *
 *     produto → buildItemPayload() → [ML echo] → mapMlItemToImport() → produto?
 *
 * `mlEcho` models the **optimistic** provider: Mercado Livre stores exactly what
 * it was sent and adds only the ids it mints. That is deliberately the friendly
 * case. Anything lost against an echo that changes nothing is lost by OUR
 * mapping, not by ML — which is precisely the class of defect this file is for.
 * What ML actually does to a value (fills `value_id`, rewrites `unit_id`,
 * returns a `value_struct`, rehosts a picture) is empirical and belongs to the
 * live run; see `apps/mercado-livre/LIVE-TEST.md` §5.
 *
 * ⚠️ **The `describe('documented divergences')` block asserts that certain
 * fields do NOT survive.** Those tests fail if someone *fixes* one of them, and
 * that is the point: each is a deliberate design decision with a reason written
 * next to it, so changing one must be a conscious edit here and in LIVE-TEST.md,
 * never a silent drift.
 *
 * ⚠️ Mutation check — this file is only worth its runtime if it goes red on a
 * real regression. Swap `SELLER_PACKAGE_LENGTH`/`SELLER_PACKAGE_WIDTH` in
 * `attrPackageDimensions`, or drop the unit from `attrWeightKg`, and the simple
 * round-trip below must fail.
 */
import { describe, expect, it } from 'vitest';

import { itemSchema, type MlItem, type MlItemAttribute } from '../src/types';
import { buildItemPayload, type BuildItemPayloadInput } from '../src/mapping/itemPayload';
import { mapMlItemToImport } from '../src/mapping/importItem';
import { mapMlVariationsToImport } from '../src/mapping/importVariations';
import {
  attrPackageDimensions,
  attrSize,
  attrSku,
  attrWeightKg,
  type MlAttribute,
} from '../src/mapping/attributes';

/* --------------------------- the ERP side, as data -------------------------- */

/** The produto fields a publish reads and an import is expected to give back. */
interface SourceProduto {
  nome: string;
  sku: string;
  pesoLiquidoKg: number;
  pesoBrutoKg: number;
  alturaCm: number;
  larguraCm: number;
  profundidadeCm: number;
  ehUsado: boolean;
  preco: number;
  quantidade: number;
  categoryId: string;
  listingTypeId: string;
  videoId: string;
  /** Category attributes the operator filled in on the ML tab. */
  atributos: MlAttribute[];
}

const PRODUTO: SourceProduto = {
  nome: 'Camiseta Preta Lisa',
  sku: 'CAM-PRETA-001',
  pesoLiquidoKg: 0.5,
  pesoBrutoKg: 0.6,
  alturaCm: 5,
  larguraCm: 30,
  profundidadeCm: 20,
  ehUsado: false,
  preco: 79.9,
  quantidade: 12,
  categoryId: 'MLB1430',
  listingTypeId: 'gold_special',
  videoId: 'YT123',
  atributos: [
    { id: 'BRAND', name: 'Marca', value_name: 'Acme' },
    { id: 'MODEL', value_name: 'Basic' },
  ],
};

/**
 * Mirror of `buildParentAttributes` in
 * `apps/mercado-livre/lib/marketplace/anuncios/publishCore.ts` — the app assembles the
 * parent attribute list there, and this package cannot import from an app. Kept
 * deliberately literal so a divergence between the two is visible on sight.
 */
function parentAttributes(p: SourceProduto): MlAttribute[] {
  return [
    ...p.atributos,
    attrSku(p.sku),
    attrWeightKg(p.pesoLiquidoKg),
    // The app calls `dimensoesDoPacote` here; this package cannot import
    // `@delfrance/schemas`, and the fixture's values are whole numbers, so the
    // literal equivalent is the same four fields with kg → g.
    ...attrPackageDimensions({
      alturaCm: p.alturaCm,
      larguraCm: p.larguraCm,
      profundidadeCm: p.profundidadeCm,
      pesoG: Math.round(p.pesoBrutoKg * 1000),
    }),
  ];
}

function publishInput(p: SourceProduto, over: Partial<BuildItemPayloadInput> = {}) {
  return {
    isUpdate: false,
    isUserProductSeller: false,
    title: p.nome,
    condition: p.ehUsado ? ('used' as const) : ('new' as const),
    sellerCustomField: 'link-doc-1',
    categoryId: p.categoryId,
    listingTypeId: p.listingTypeId,
    price: p.preco,
    availableQuantity: p.quantidade,
    pictures: [{ id: 'PIC1' }, { id: 'PIC2' }],
    videoId: p.videoId,
    attributes: parentAttributes(p),
    ...over,
  } satisfies BuildItemPayloadInput;
}

/* ------------------------------- the ML echo -------------------------------- */

/**
 * What `POST /items` returns, on the assumption that ML stores the payload
 * verbatim and only adds what it alone can mint: the item id, one id per
 * variation, `status`, and `base_price` (which mirrors `price` when there is no
 * promotional price).
 */
function mlEcho(payload: Record<string, unknown>, variationIds: number[] = []): MlItem {
  const variations = (payload.variations as Record<string, unknown>[] | undefined) ?? [];
  return itemSchema.parse({
    ...payload,
    id: 'MLB111222333',
    status: 'active',
    ...(payload.price != null ? { base_price: payload.price } : {}),
    ...(variations.length > 0
      ? {
          variations: variations.map((v, i) => ({ ...v, id: variationIds[i] ?? 9000 + i })),
        }
      : {}),
  });
}

/* ------------------------------ simple produto ------------------------------ */

describe('round-trip: a simple produto survives publish → import', () => {
  const imported = mapMlItemToImport(mlEcho(buildItemPayload(publishInput(PRODUTO))));

  it('recovers the core produto fields', () => {
    expect(imported.nome).toBe(PRODUTO.nome);
    expect(imported.sku).toBe(PRODUTO.sku);
    expect(imported.ehUsado).toBe(PRODUTO.ehUsado);
    expect(imported.condicao).toBe(1);
  });

  it('recovers weights and dimensions through the unit round-trip', () => {
    // Publish writes "0.5 kg" and, for the package, GRAMS ("600 g"); import has
    // to parse the unit back out. A legacy g→0.01 bug lived here.
    expect(imported.pesoLiquidoKg).toBeCloseTo(PRODUTO.pesoLiquidoKg, 6);
    expect(imported.pesoBrutoKg).toBeCloseTo(PRODUTO.pesoBrutoKg, 6);
    expect(imported.alturaCm).toBe(PRODUTO.alturaCm);
    expect(imported.larguraCm).toBe(PRODUTO.larguraCm);
    expect(imported.profundidadeCm).toBe(PRODUTO.profundidadeCm);
  });

  it('recovers price, stock and the listing identity', () => {
    expect(imported.precoNormal).toBe(PRODUTO.preco);
    // No promotional price was sent, so there must not be one on the way back.
    expect(imported.precoPromocional).toBeNull();
    expect(imported.availableQuantity).toBe(PRODUTO.quantidade);
    expect(imported.categoryId).toBe(PRODUTO.categoryId);
    expect(imported.listingTypeId).toBe(PRODUTO.listingTypeId);
    expect(imported.videoId).toBe(PRODUTO.videoId);
    expect(imported.sellerCustomField).toBe('link-doc-1');
  });

  it('recovers the operator-filled category attributes', () => {
    expect(imported.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'BRAND', value_name: 'Acme' }),
        expect.objectContaining({ id: 'MODEL', value_name: 'Basic' }),
      ]),
    );
  });
});

/* ------------------ the ML echo that is NOT optimistic (#1346) -------------- */

/** A measurement as the operator's editor stores it: number and unit APART. */
const MEDIDA: MlAttribute = {
  id: 'UNIT_VOLUME',
  name: 'Volume da unidade',
  value_name: '355',
  unit_id: 'mL',
};

/**
 * Rewrite one attribute the way a live `GET /items` actually answers it.
 *
 * Publish sends `value_name: '355'` + `unit_id: 'mL'`; `attributeToMercadoLivre`
 * joins them to `'355 mL'` on the wire. ML then answers with that joined text,
 * **drops `unit_id`**, sends **no root `value_struct`**, and states the split
 * only under `values[0].struct`. Measured on MLB5146021467, 27/08/2026.
 */
function comoOMercadoLivreResponde(attr: MlItemAttribute): Record<string, unknown> {
  const nome = attr.value_name;
  const m = typeof nome === 'string' ? /^(-?\d+(?:\.\d+)?)\s+(\S+)$/.exec(nome) : null;
  if (m == null) return { ...attr };
  return {
    ...attr,
    value_name: nome,
    unit_id: null,
    value_struct: undefined,
    values: [{ id: null, name: nome, struct: { number: Number(m[1]), unit: m[2] } }],
  };
}

/**
 * `mlEcho` above models the OPTIMISTIC provider — ML stores the payload verbatim
 * — and that is deliberately the friendly case.
 *
 * ⚠️ It is also the reason #1346 hid here for so long: an echo that changes
 * nothing can never produce the shape that breaks the reader. This one applies
 * the ONE transform ML really does, so the composition below is publish → *the
 * real response* → import.
 */
function mlEchoRealista(payload: Record<string, unknown>): MlItem {
  const item = mlEcho(payload);
  return itemSchema.parse({
    ...item,
    attributes: (item.attributes ?? []).map(comoOMercadoLivreResponde),
  });
}

function publicarCom(attributes: MlAttribute[]): Record<string, unknown> {
  return buildItemPayload(publishInput(PRODUTO, { attributes }));
}

function valorEnviado(payload: Record<string, unknown>, id: string): unknown {
  const attrs = payload.attributes as Array<Record<string, unknown>>;
  return attrs.find((a) => a.id === id)?.value_name;
}

describe('round-trip through the REAL ML response, not the optimistic echo (#1346)', () => {
  const ATRIBUTOS = [...parentAttributes(PRODUTO), MEDIDA];
  const publicado = publicarCom(ATRIBUTOS);
  const importado = mapMlItemToImport(mlEchoRealista(publicado));

  it('sends the pair joined, as it always has', () => {
    expect(valorEnviado(publicado, 'UNIT_VOLUME')).toBe('355 mL');
  });

  it('recovers a number_unit attribute exactly as the operator entered it', () => {
    expect(importado.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'UNIT_VOLUME', value_name: '355', unit_id: 'mL' }),
      ]),
    );
  });

  it('⚠️ CONTROL — the produto dimensions still survive this echo', () => {
    // The package attributes are rewritten by the same transform, so this proves
    // the realistic echo did not simply break everything into passing.
    expect(importado.alturaCm).toBe(PRODUTO.alturaCm);
    expect(importado.larguraCm).toBe(PRODUTO.larguraCm);
    expect(importado.profundidadeCm).toBe(PRODUTO.profundidadeCm);
    expect(importado.pesoLiquidoKg).toBeCloseTo(PRODUTO.pesoLiquidoKg, 6);
    expect(importado.pesoBrutoKg).toBeCloseTo(PRODUTO.pesoBrutoKg, 6);
  });

  /**
   * ⛔ The regression this whole block exists for.
   *
   * `attributeToMercadoLivre` re-joins `value_name` + `unit_id`, so storing BOTH
   * halves means the next publish sends `'355 mL mL'`, the one after
   * `'355 mL mL mL'` — silently, on every republish, until ML rejects the value,
   * by which time every republished listing carries it (#1087).
   */
  it('⛔ is a FIXED POINT: publish → import → publish → import never grows the unit', () => {
    const medidaImportada = importado.attributes.filter((a) => a.id === 'UNIT_VOLUME');
    const republicado = publicarCom([...parentAttributes(PRODUTO), ...medidaImportada]);

    // The wire is where the growth would show, so assert it there FIRST.
    expect(valorEnviado(republicado, 'UNIT_VOLUME')).toBe('355 mL');

    const reimportado = mapMlItemToImport(mlEchoRealista(republicado));
    expect(reimportado.attributes.filter((a) => a.id === 'UNIT_VOLUME')).toEqual(medidaImportada);
  });
});

/* --------------------------- produto with variations ------------------------ */

describe('round-trip: variations survive publish → import', () => {
  const CHILDREN = [
    { produtoId: 'child-P', sku: 'CAM-PRETA-001-P', tamanho: 'P', quantidade: 3, ordem: 0 },
    { produtoId: 'child-M', sku: 'CAM-PRETA-001-M', tamanho: 'M', quantidade: 7, ordem: 1 },
  ];

  const payload = buildItemPayload(
    publishInput(PRODUTO, {
      variations: CHILDREN.map((c) => ({
        produtoId: c.produtoId,
        order: c.ordem,
        availableQuantity: c.quantidade,
        attributeCombinations: [attrSize(c.tamanho)],
        attributes: [attrSku(c.sku)],
      })),
    }),
  );
  const variations = mapMlVariationsToImport(mlEcho(payload, [501, 502]));

  it('maps one entry per variation, keyed by the id ML minted', () => {
    expect(variations.map((v) => v.variationId)).toEqual(['501', '502']);
  });

  it('recovers each variation SKU, quantity and back-reference', () => {
    expect(variations.map((v) => v.sku)).toEqual(CHILDREN.map((c) => c.sku));
    expect(variations.map((v) => v.availableQuantity)).toEqual(CHILDREN.map((c) => c.quantidade));
    // `seller_custom_field` is the child produto doc id — the link back to the ERP.
    expect(variations.map((v) => v.sellerCustomField)).toEqual(CHILDREN.map((c) => c.produtoId));
  });

  it('recovers the combination that defines each variation', () => {
    expect(variations.map((v) => v.combos[0]?.value_name)).toEqual(['P', 'M']);
  });

  it('names each variation from the title plus its combination values', () => {
    expect(variations.map((v) => v.nome)).toEqual([`${PRODUTO.nome} P`, `${PRODUTO.nome} M`]);
  });
});

/* --------------------------- documented divergences ------------------------- */

describe('documented divergences — deliberate, and NOT bugs', () => {
  it('drops the variation display order: ML has no field for it', () => {
    // `ordem` sorts the emitted array and is then discarded. Under User
    // Products the concept does not exist at all, so there is nowhere to put it.
    const payload = buildItemPayload(
      publishInput(PRODUTO, {
        variations: [
          {
            produtoId: 'child-M',
            order: 1,
            availableQuantity: 7,
            attributeCombinations: [attrSize('M')],
          },
          {
            produtoId: 'child-P',
            order: 0,
            availableQuantity: 3,
            attributeCombinations: [attrSize('P')],
          },
        ],
      }),
    );
    const emitted = payload.variations as Record<string, unknown>[];
    // Sorted by `order`…
    expect(emitted.map((v) => v.seller_custom_field)).toEqual(['child-P', 'child-M']);
    // …and `order` itself is not on the wire, so nothing can bring it back.
    expect(emitted.every((v) => !('order' in v))).toBe(true);
  });

  it('never sends a price on an update: republishing cannot change the ML price', () => {
    // Price is owned by the dedicated push path (`/enviar-precos`,
    // `/atualizar-precos`). A republish that silently repriced a live listing
    // would be worse than one that does not.
    const payload = buildItemPayload(publishInput(PRODUTO, { isUpdate: true }));
    expect(payload.price).toBeUndefined();
  });

  it('moves price and quantity to the variation level once variations exist', () => {
    const payload = buildItemPayload(
      publishInput(PRODUTO, {
        variations: [
          {
            produtoId: 'child-P',
            availableQuantity: 3,
            attributeCombinations: [attrSize('P')],
          },
        ],
      }),
    );
    expect(payload.price).toBeUndefined();
    expect(payload.available_quantity).toBeUndefined();
    expect((payload.variations as Record<string, unknown>[])[0]?.available_quantity).toBe(3);
  });

  it('strips the parent SELLER_SKU when there are variations, so the parent sku is only guessable', () => {
    // ML rejects an attribute that also appears as a combination, and each
    // variation carries its own SELLER_SKU. `skuGuessFromVariations` is the
    // heuristic that recovers a parent sku — and only when every variation
    // shares one prefix.
    const payload = buildItemPayload(
      publishInput(PRODUTO, {
        variations: [
          {
            produtoId: 'child-P',
            availableQuantity: 3,
            attributeCombinations: [attrSize('P')],
            attributes: [attrSku('CAM-PRETA-001-P')],
          },
        ],
      }),
    );
    const parentIds = (payload.attributes as Record<string, unknown>[]).map((a) => a.id);
    expect(parentIds).not.toContain('SELLER_SKU');
    expect(mapMlItemToImport(mlEcho(payload, [501])).sku).toBeNull();
  });

  it('carries no description: that is a separate ML call', () => {
    // `POST/PUT /items/{id}/description` on the way out, `getItemDescription`
    // on the way back — neither is part of the item payload.
    const payload = buildItemPayload(publishInput(PRODUTO));
    expect(payload.description).toBeUndefined();
    expect('descricao' in mapMlItemToImport(mlEcho(payload))).toBe(false);
  });

  it('keeps the derived attribute ids off the stored link attributes', () => {
    // The link doc stores only what the operator chose. SELLER_SKU, WEIGHT and
    // SELLER_PACKAGE_* are re-derived from produto fields on every publish, so
    // storing them too would send each id twice.
    const imported = mapMlItemToImport(mlEcho(buildItemPayload(publishInput(PRODUTO))));
    const ids = imported.attributes.map((a) => a.id);
    expect(ids).not.toContain('SELLER_SKU');
    expect(ids).not.toContain('WEIGHT');
    expect(ids).not.toContain('SELLER_PACKAGE_HEIGHT');
  });

  it('loses an id-bearing attribute label, because ML identifies it by id', () => {
    // `attributeToMercadoLivre` emits `name` ONLY for a custom characteristic
    // (an attribute with no id). For an id-bearing attribute the name is a
    // local label ML never asked for, so it does not survive.
    const imported = mapMlItemToImport(mlEcho(buildItemPayload(publishInput(PRODUTO))));
    const brand = imported.attributes.find((a) => a.id === 'BRAND');
    expect(brand?.value_name).toBe('Acme');
    expect(brand?.name).toBeNull();
  });

  it('does not round-trip ehKit: publish never sends IS_KIT', () => {
    // ⚠️ ASYMMETRY, inherited from the legacy Flutter app (which also only ever
    // READ `IS_KIT`, models.dart:1227). `importItem.ts` lists IS_KIT among the
    // ids "the publish path re-derives from produto fields" — but no publish
    // path derives it, so a kit produto imports back as `ehKit: false`, and a
    // listing that does carry IS_KIT has it stripped from the link and never
    // re-sent. Harmless while `ehKit` is ERP-owned; a finding if it ever is not.
    const payload = buildItemPayload(publishInput(PRODUTO));
    const ids = (payload.attributes as Record<string, unknown>[]).map((a) => a.id);
    expect(ids).not.toContain('IS_KIT');
    expect(mapMlItemToImport(mlEcho(payload)).ehKit).toBe(false);
  });
});
