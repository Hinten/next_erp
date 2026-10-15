/**
 * The deterministic incidente id of a Shopee return (#1525, step 17).
 *
 * One return is ONE incidente, at
 * `pedidos/{makePedidoIdShopee(conta, order_sn)}/incidentes/shopee-devolucao-<return_sn>`.
 * Both halves are DERIVED, never queried: the importer, the poller (`db.getAll`
 * over the derived refs) and the dry-run CLI all land on the same document from
 * the ids alone, so no index and no query ever stands between a return and its
 * row.
 *
 * ## Why `<return_sn>` verbatim and not a digest
 *
 * The pedido id is a digest because the LEGACY corpus already sits at that
 * digest (`orderIds.ts`). There is no such constraint here — the legacy app
 * wrote NO Shopee incidente — so the id stays readable: an operator looking at
 * the Firestore console sees which return a row is. Readable is only safe
 * because the input is guarded: {@link idIncidenteDevolucaoShopee} admits only
 * what `ehReturnSnShopee` (`@delfrance/schemas`, the ONE copy of the shape)
 * admits — `[A-Za-z0-9]{1,64}` — so no `/` can fork the path, no `.`/`..` can
 * name a reserved id, no `__x__` can form (no underscore) and the 81-byte
 * result is far under Firestore's 1500.
 *
 * ## Why the hyphenated prefix
 *
 * It cannot collide with the other ids under the same subcollection: the
 * 20-char auto ids the web editor mints (alphanumeric, no hyphen) and step 5's
 * `shopee-prod-<ensureUniqueId>` produto rows (`incidentesProduto.ts`) — a
 * different second segment. Per-conta uniqueness comes from the PARENT pedido:
 * two contas never share a pedido id.
 */
import { ehReturnSnShopee } from '@delfrance/schemas';

/** The id prefix of every Shopee-return incidente. A CONSTANT: the id is a key, never reformat it. */
export const PREFIXO_ID_INCIDENTE_DEVOLUCAO = 'shopee-devolucao-';

/**
 * `shopee-devolucao-<returnSn>` — the incidente id of ONE Shopee return.
 *
 * ⚠️ **Refuses, never repairs.** Anything `ehReturnSnShopee` refuses — blank,
 * padded, a `/`, an accented letter, a 65th character, a non-string — throws a
 * `RangeError` instead of being trimmed or escaped into SOME id: a repaired id
 * is a second document for one return, and the importer, the poller and the
 * CLI would then disagree about which one is real.
 *
 * ⚠️ The message names the FIELD and the length only, never the value — the
 * `logistica.ts` rule every guard on this channel follows.
 */
export function idIncidenteDevolucaoShopee(returnSn: string): string {
  // Widened on purpose: an untyped caller (a raw doc field, a parsed body) can
  // hand anything over, and the guard must describe it without echoing it.
  const bruto: unknown = returnSn;
  if (!ehReturnSnShopee(bruto)) {
    const comprimento = typeof bruto === 'string' ? String(bruto.length) : typeof bruto;
    throw new RangeError(
      `idIncidenteDevolucaoShopee: return_sn fora do formato [A-Za-z0-9]{1,64} (comprimento ${comprimento})`,
    );
  }
  return `${PREFIXO_ID_INCIDENTE_DEVOLUCAO}${returnSn}`;
}
