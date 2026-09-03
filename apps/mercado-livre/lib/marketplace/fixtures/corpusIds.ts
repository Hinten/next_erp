/**
 * Recover the Mercado Livre ids the committed corpus was captured from, by
 * reading its filenames.
 *
 * ⭐ This is what lets `verify:wire --live` take **no id flags**. It re-fetches
 * exactly what `__wire__/` holds, so the comparison is apples-to-apples by
 * construction — a hand-typed id list would drift from the corpus and produce
 * "differences" that are really just a different order.
 *
 * The filename convention is `slugForPath` + `fixtureFileName`
 * (`fixtureCapture.ts`): the request path with `/` → `-`, plus a status suffix
 * for anything that is not a 200.
 */
import { listWireFixtures } from './wireCorpus';

export interface CorpusIds {
  readonly orderIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly shipmentIds: readonly string[];
  readonly paymentIds: readonly string[];
  readonly claimIds: readonly string[];
}

/** Strip the `.json` and any `.<status>` suffix: `orders-1.404.json` → `orders-1`. */
function stem(file: string): string {
  return file.replace(/\.json$/, '').replace(/\.\d{3}$/, '');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * ⚠️ Sub-resource slugs are excluded, never mapped to their parent id. A
 * `shipments-47868202073-costs` names the SAME shipment as
 * `shipments-47868202073`, and feeding the id twice would re-fetch every one of
 * its endpoints twice — the plan already fans one id out to all of them.
 */
export function idsFromCorpus(files: readonly string[] = listWireFixtures()): CorpusIds {
  const stems = files.map(stem);

  const match = (re: RegExp): string[] =>
    unique(stems.map((s) => re.exec(s)?.[1]).filter((v): v is string => v !== undefined));

  return {
    // `orders-<digits>` only — `orders-<digits>-billing_info` is a sub-resource.
    orderIds: match(/^orders-(\d+)$/),
    // Both `item-MLB…` (singular, older capture) and `items-MLB…`.
    itemIds: match(/^items?-(MLB\d+)$/),
    shipmentIds: match(/^shipments-(\d+)$/),
    paymentIds: match(/^collections-(\d+)$/),
    claimIds: match(/^post-purchase-v1-claims-(\d+)$/),
  };
}

/** Total ids across every family — zero means the corpus told us nothing. */
export function countIds(ids: CorpusIds): number {
  return (
    ids.orderIds.length +
    ids.itemIds.length +
    ids.shipmentIds.length +
    ids.paymentIds.length +
    ids.claimIds.length
  );
}
