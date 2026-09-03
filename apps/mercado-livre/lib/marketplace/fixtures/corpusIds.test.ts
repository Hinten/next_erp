import { describe, expect, it } from 'vitest';

import { countIds, idsFromCorpus } from './corpusIds';
import { findFixtureForSlug, listWireFixtures } from './wireCorpus';

describe('idsFromCorpus', () => {
  it('recovers every id family from the REAL committed corpus', () => {
    // ⚠️ Run against the real filenames, not a hand-written list. A parser tested
    // only against invented names is a parser tested against my assumptions about
    // the convention rather than against the convention.
    const ids = idsFromCorpus();

    // ⚠️ FOUR, not three. `2000014733850447` 404'd on `/orders/{id}` because it
    // is a PACK id, and a pack id and an order id are indistinguishable from
    // outside — which is exactly why the capture plan fans every id out to both
    // and records the 404 as data. Re-fetching it will 404 again, correctly.
    expect(ids.orderIds).toEqual([
      '2000014733850447',
      '2000018143664980',
      '2000018144679512',
      '2000018144681452',
    ]);
    expect(ids.itemIds).toContain('MLB5095421681');
    expect(ids.itemIds).toContain('MLB7542354578');
    // ⚠️ The corpus is now uniformly `items-` — the four legacy `item-` files
    // were renamed to the slug `fixtureFileName` actually produces, so the
    // matcher needs no special case and none of them goes unverified.
    expect(listWireFixtures().filter((f) => /^item-/.test(f))).toEqual([]);
    expect(ids.shipmentIds).toEqual(['47868202073', '47868991350']);
    expect(ids.paymentIds).toEqual(['174911485053', '174920100019', '175866174436']);
    expect(ids.claimIds).toEqual(['5567065796']);
  });

  it('finds ids in every family, so no family is silently unverifiable', () => {
    const ids = idsFromCorpus();
    expect(ids.orderIds.length).toBeGreaterThan(0);
    expect(ids.itemIds.length).toBeGreaterThan(0);
    expect(ids.shipmentIds.length).toBeGreaterThan(0);
    expect(ids.paymentIds.length).toBeGreaterThan(0);
    expect(ids.claimIds.length).toBeGreaterThan(0);
    expect(countIds(ids)).toBeGreaterThanOrEqual(10);
  });

  it('⚠️ does NOT re-derive an id from a SUB-RESOURCE slug', () => {
    // `shipments-47868202073-costs` names the same shipment as
    // `shipments-47868202073`. The plan already fans one id out to every
    // endpoint, so counting the sub-resource would fetch each of them twice.
    const ids = idsFromCorpus([
      'shipments-47868202073.json',
      'shipments-47868202073-costs.json',
      'shipments-47868202073-sla.json',
      'orders-1.json',
      'orders-1-billing_info.json',
    ]);
    expect(ids.shipmentIds).toEqual(['47868202073']);
    expect(ids.orderIds).toEqual(['1']);
  });

  it('strips a status suffix, so a 404 capture still yields its id', () => {
    // A 404 is data — the id was real, ML just had nothing for it.
    expect(idsFromCorpus(['orders-2000014733850447.404.json']).orderIds).toEqual([
      '2000014733850447',
    ]);
  });

  it('reads both the singular and plural item slugs', () => {
    const ids = idsFromCorpus(['item-MLB1.json', 'items-MLB2.json']);
    expect(ids.itemIds).toEqual(['MLB1', 'MLB2']);
  });

  it('CONTROL — an empty corpus yields no ids rather than inventing any', () => {
    expect(countIds(idsFromCorpus([]))).toBe(0);
  });

  it('ignores files it does not recognise instead of guessing', () => {
    expect(countIds(idsFromCorpus(['SHAPES.txt', 'README.md', 'order-single.json']))).toBe(0);
  });

  it('every derived id round-trips to a file that exists in the corpus', () => {
    // The property that keeps the live verify apples-to-apples: nothing is
    // fetched that the corpus cannot be compared against.
    //
    // ⚠️ Uses the PRODUCTION matcher, `findFixtureForSlug`. This test used to
    // hand-copy its predicate — including the anchoring bug — so it was green
    // while `baselineFor` resolved 15 of 33 plan slugs to a different resource.
    // Two copies of a matcher drift toward plausible (root `CLAUDE.md`); sharing
    // one makes this a real backstop for the script instead of a parallel
    // implementation of the same mistake.
    const ids = idsFromCorpus();
    for (const id of ids.orderIds) {
      expect(findFixtureForSlug(`orders-${id}`), `orders-${id}`).not.toBeNull();
    }
    for (const id of ids.shipmentIds) {
      expect(findFixtureForSlug(`shipments-${id}`), `shipments-${id}`).not.toBeNull();
    }
    for (const id of ids.paymentIds) {
      expect(findFixtureForSlug(`collections-${id}`), `collections-${id}`).not.toBeNull();
    }
    // ⚠️ The family that genuinely did NOT round-trip, and was simply not
    // asserted here before: the corpus held `item-MLB…` while the capture plan
    // emits `items-MLB…`, so 4 of the 5 item ids were fetched and never compared.
    for (const id of ids.itemIds) {
      expect(findFixtureForSlug(`items-${id}`), `items-${id}`).not.toBeNull();
    }
  });

  it('CONTROL — the matcher does not resolve a slug to a DIFFERENT resource', () => {
    // The exact failure the old predicate had: an unanchored tail comparison
    // matched any name of the same length ending in `.NNN.json`, and any 200
    // file whose stem ended in three digits.
    expect(findFixtureForSlug('orders-2000018143664980')).toBe('orders-2000018143664980.json');
    expect(findFixtureForSlug('items-MLB5095421681')).toBe('items-MLB5095421681.json');
    expect(findFixtureForSlug('orders-9999999999999999')).toBeNull();
  });
});
