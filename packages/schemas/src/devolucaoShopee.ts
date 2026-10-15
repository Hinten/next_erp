/**
 * Shopee returns — the shapes more than one surface must agree on (master-plan
 * step 17, #1525).
 *
 * NOT a collection: nothing here is a document, so there is no `registry.ts`
 * entry and nothing reaches a ruleset. It sits at the schemas root beside
 * `liquidacaoShopee.ts` / `importacaoShopee.ts` — and deliberately OUTSIDE
 * `pedido/`, whose every edit fires the NF-e live lane.
 *
 * ⚠️ This is the ONE copy of the `return_sn` shape. Three surfaces read it — the
 * code-29 push parser (`apps/shopee/lib/shopee/devolucoes/pushDevolucao.ts`),
 * the `reclamacao/{acao,estado}` routes, and the web panel's mount
 * (`incidenteCanal.ts`) — and `apps/web` has no dependency edge to `apps/shopee`,
 * so the only alternative to sharing it is writing it twice. The two designs
 * behind step 17 already disagreed on the bound (64 vs 40): #1369's drift,
 * caught before it shipped.
 */

/** The longest `return_sn` accepted. Shopee documents no bound; this one is ours. */
export const RETURN_SN_SHOPEE_MAX = 64;

const RETURN_SN_SHOPEE = new RegExp(`^[A-Za-z0-9]{1,${String(RETURN_SN_SHOPEE_MAX)}}$`);

/**
 * Is `v` a Shopee `return_sn`? ALPHANUMERIC, 1..{@link RETURN_SN_SHOPEE_MAX}.
 *
 * ⚠️ **Letters are legal, and a test that only feeds digits proves nothing.**
 * Every sample on Shopee's returns pages is alphanumeric (`2411280EDT4JRV5`), so
 * a digits-only guard — `Number.isSafeInteger`, `/^\d+$/` — would refuse every
 * real return while a digits-only fixture kept the suite green.
 *
 * ⚠️ **Nothing is trimmed or repaired.** A padded value is refused, never
 * quietly fixed: the id becomes a Firestore document id
 * (`shopee-devolucao-<return_sn>`), an aviso key segment and a URL query
 * parameter, and the allow-list is what makes all three safe by construction —
 * no `/` to fork a path, no `.`/`:` for `chaveDeAviso` to fold, no whitespace. A
 * caller whose OWN contract tolerates padding (the web mount reading a stored
 * `externalId`) trims before asking.
 */
export function ehReturnSnShopee(v: unknown): v is string {
  return typeof v === 'string' && RETURN_SN_SHOPEE.test(v);
}
