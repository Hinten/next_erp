/**
 * **Round-trip contract, User Products** — the half `roundTrip.test.ts` cannot cover.
 *
 * That file's `mlEcho` is deliberately OPTIMISTIC: "Mercado Livre stores exactly
 * what it was sent and adds only the ids it mints". Its docblock says so, and says
 * that what ML *actually* does — "fills `value_id`, rewrites `unit_id`, returns a
 * `value_struct`" — is empirical and belongs to the live run. That is a stated
 * scope boundary, not an oversight, so this file does NOT relax it. It adds the
 * second control beside it: a PESSIMISTIC echo doing what the live run (#1087)
 * observed ML actually doing to a User-Products item.
 *
 * The two together are the pair the repo insists on everywhere else — a known-good
 * that must pass and a known-bad that must fail — because an optimistic echo can
 * only ever catch OUR mapping losing something. Every finding in #1087 was the
 * other kind: ML returning something different from what we sent.
 */
import { describe, expect, it } from 'vitest';

import { itemSchema, type MlItem } from '../src/types';
import { buildItemPayload } from '../src/mapping/itemPayload';
import { attrSku, attributeToMercadoLivre, type MlAttribute } from '../src/mapping/attributes';
import { attributesFromItem, mapMlItemToImport } from '../src/mapping/importItem';
import { mapUpMemberToImport } from '../src/mapping/importUserProduct';

/** The seller SKU an operator typed. It must survive the whole trip. */
const SKU = 'band123';
/** ML's own numeric family key, deliberately NOT equal to any item id. */
const FAMILY_ID = 3921756196207441;
const ITEM_ID = 'MLB5125183715';

function upPublishInput() {
  return {
    isUpdate: false,
    // The account carries `user_product_seller`, so publish sends `family_name`
    // and no `title` — the shape #1087 reproduced against.
    isUserProductSeller: true,
    title: 'Porta-lapis de madeira',
    condition: 'new' as const,
    sellerCustomField: 'link-doc-1',
    categoryId: 'MLB1430',
    listingTypeId: 'gold_special',
    price: 79.9,
    availableQuantity: 12,
    pictures: [{ id: 'PIC1' }],
    videoId: null,
    attributes: [
      { id: 'BRAND', name: 'Marca', value_name: 'Acme' },
      attrSku(SKU),
      // The dimension case. We send the bare number and the unit APART.
      { id: 'HEIGHT', value_name: '12', unit_id: 'cm' },
    ] satisfies MlAttribute[],
  };
}

/**
 * What ML really answered in the live run — every divergence observed in #1087,
 * and nothing invented:
 *
 *  - it mints `user_product_id` AND `family_id`, though we created no family;
 *  - it adds `ITEM_CONDITION`, a PARENT_PK it derives from `condition` and that we
 *    never sent;
 *  - it bakes the unit INTO `value_name` (`12` becomes `12 cm`) while still
 *    reporting `unit_id` beside it;
 *  - `attribute_combinations` is absent: a family of one has nothing to vary.
 */
function mlEchoRealista(payload: Record<string, unknown>): MlItem {
  const sent = (payload.attributes as Record<string, unknown>[] | undefined) ?? [];
  const attributes = sent.map((a) =>
    a.id === 'HEIGHT'
      ? { ...a, value_name: '12 cm', unit_id: 'cm', value_id: '2230284' }
      : { ...a, value_id: a.value_id ?? '111' },
  );
  return itemSchema.parse({
    ...payload,
    id: ITEM_ID,
    status: 'active',
    user_product_id: 'MLBU4903167333',
    family_id: FAMILY_ID,
    base_price: payload.price,
    attributes: [
      ...attributes,
      { id: 'ITEM_CONDITION', name: 'Condicao do item', value_id: '2230284', value_name: 'Novo' },
    ],
  });
}

const echo = mlEchoRealista(buildItemPayload(upPublishInput()));

describe('round-trip: a User-Products SINGLE survives publish → import', () => {
  it('ML mints a family for an item we published as a single — the import is right to see one', () => {
    // The fact the whole #1087 shape change rests on. ML's docs say the family is
    // auto-generated for every user product; here one comes back on an item whose
    // payload created no family at all.
    expect(echo.family_id).toBe(FAMILY_ID);
    expect(echo.family_name).toBe('Porta-lapis de madeira');
  });

  it('the FAMILY id and the ITEM id are different values — the fixture cannot hide a mix-up', () => {
    // ⚠️ #1142 was missed twice because the fixtures made the two behaviours
    // numerically equal. Pinning them apart is what lets every assertion below
    // actually fail.
    expect(String(FAMILY_ID)).not.toBe(ITEM_ID);
  });

  it('⛔ the member keeps the operator SKU — never the family id', () => {
    // A SKU is a dedup key: `resolveExistingProduto` and `orderProdutoResolve` both
    // match on it, so a numeric family id sitting where a human SKU belongs
    // silently mis-resolves — and the ORDER path falls through to those rungs
    // precisely when the link lookup misses.
    expect(mapUpMemberToImport(echo).member.sku).toBe(SKU);
  });

  it('the member is addressed by its own MLB item id, and the family by the family id', () => {
    const up = mapUpMemberToImport(echo);
    expect(up.member.variationId).toBe(ITEM_ID);
    expect(up.familyId).toBe(String(FAMILY_ID));
    expect(up.canonicalId).toBe(String(FAMILY_ID));
  });

  it('a family of one has no combination — that is what makes it a SOLE member', () => {
    expect(mapUpMemberToImport(echo).member.combos).toEqual([]);
  });

  it('carries the user_product_id: the stock identity on a multiorigem conta (#706)', () => {
    expect(mapMlItemToImport(echo).userProductId).toBe('MLBU4903167333');
  });

  it('records the User-Products model, which is what routes every later publish', () => {
    expect(mapMlItemToImport(echo).isUserProductModel).toBe(true);
  });
});

describe('round-trip: what ML changed on the way back', () => {
  const stored = attributesFromItem(echo.attributes);
  const height = stored.find((a) => a.id === 'HEIGHT')!;

  it('keeps the attribute ML ADDED — ITEM_CONDITION is a family PARENT_PK we never sent', () => {
    // Neither a loss nor a bug: it explains why the stored attribute id SET is a
    // superset of what publish recorded, which is finding #8 of the live run.
    expect(stored.map((a) => a.id)).toContain('ITEM_CONDITION');
  });

  it('⛔ a measurement is not stored with its unit BOTH baked in and beside it', () => {
    // ML baked the unit into `value_name` (12 → 12 cm) and still reported
    // `unit_id: cm`. `attributeToMercadoLivre` re-joins the two on the next
    // publish, so storing both makes the NEXT payload say "12 cm cm".
    expect(attributeToMercadoLivre(height).value_name).toBe('12 cm');
  });

  // ⚠️ One row per shape ML is known to return. The first two passed before #1087's
  // second pass; the last two are the ones that still compounded, one shape over —
  // a comma decimal (`Number('1,5')` is NaN) and a unit whose DISPLAY case differs
  // from its id (`'mL'` vs `unit_id: 'ml'`).
  it.each([
    ['12 cm', 'cm', '12 cm'],
    ['1.5 cm', 'cm', '1.5 cm'],
    ['1,5 cm', 'cm', '1,5 cm'],
    ['355 mL', 'ml', '355 ml'],
    ['1,5 mL', 'ml', '1,5 ml'],
  ])(
    'does not accumulate the unit: %s + unit_id=%s republishes as %s',
    (nome, unitId, esperado) => {
      const [attr] = attributesFromItem([
        { id: 'HEIGHT', value_name: nome, unit_id: unitId, value_id: '1' },
      ]);
      expect(attributeToMercadoLivre(attr!).value_name).toBe(esperado);
    },
  );

  it('⚠️ never splits a value ML did NOT name a unit for — a BRAND stays whole', () => {
    // The reason the fallback is narrow: this layer has no category metadata, so a
    // blind split would turn `Nike Air` into `Nike`. It splits only a trailing token
    // ML itself reported in `unit_id`, and only over a number.
    const [semUnidade] = attributesFromItem([
      { id: 'BRAND', value_name: 'Nike Air', value_id: '1' },
    ]);
    expect(attributeToMercadoLivre(semUnidade!).value_name).toBe('Nike Air');
    // ...and not even then, when the head is not a number.
    const [naoNumero] = attributesFromItem([
      { id: 'BRAND', value_name: 'Nike cm', unit_id: 'cm', value_id: '1' },
    ]);
    expect(attributeToMercadoLivre(naoNumero!).value_name).toBe('Nike cm');
  });

  it('⛔ a SECOND round trip is idempotent — the unit does not accumulate', () => {
    // The property that actually matters. One extra " cm" per republish is
    // invisible until ML rejects the value, and by then every listing carries it.
    const republished = buildItemPayload({
      ...upPublishInput(),
      isUpdate: true,
      attributes: stored,
    });
    const second = attributesFromItem(mlEchoRealista(republished).attributes);
    const h2 = second.find((a) => a.id === 'HEIGHT')!;
    expect(attributeToMercadoLivre(h2).value_name).toBe('12 cm');
  });
});
