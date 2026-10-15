import {
  ORIGEM_INCIDENTE,
  ORIGEM_INCIDENTE_LABELS,
  ORIGENS_INCIDENTE_MARKETPLACE,
  ehReturnSnShopee,
} from '@delfrance/schemas';

/**
 * Which CHANNEL an incidente belongs to, and what that allows the editor to do
 * (#1525, step 17). Pure, so the mount, the lock and the origem options are
 * tested without React.
 *
 * ⚠️ The marketplace origens are read from `ORIGENS_INCIDENTE_MARKETPLACE` — the
 * same set the pedido overlay blocks on — never re-listed here. A second list is
 * how a channel ends up blocking `finalizar` while the editor still lets an
 * operator retype it away.
 */

/** The fields these helpers read — a stored incidente or a form-shaped one. */
export interface IncidenteDoCanal {
  origem?: number | null;
  externalId?: string | null;
}

/** Widened once: the set is typed by the origem union, the doc field by `number`. */
const ORIGENS_MARKETPLACE: ReadonlySet<number> = ORIGENS_INCIDENTE_MARKETPLACE;

/** Whether `origem` is a marketplace's — the importer's to write, never a person's. */
export function ehOrigemDeMarketplace(origem: number | null | undefined): boolean {
  return origem != null && ORIGENS_MARKETPLACE.has(origem);
}

/**
 * The Shopee `return_sn` of an incidente the returns importer wrote, or `null`.
 *
 * ⚠️ BOTH halves matter, as in `claimIdDoIncidente`. `origem` alone would match
 * a row a human tagged Shopee; `externalId` alone would match any origem that
 * stores an id — an ML claim id is a valid return_sn shape too.
 *
 * ⚠️ ALPHANUMERIC, through the one shared predicate (`ehReturnSnShopee`): every
 * Shopee sample is alphanumeric (`2411280EDT4JRV5`), so ML's digits-only test
 * would never mount the panel on a real return. The stored id is trimmed first —
 * the predicate itself refuses padding, and a legacy value may carry some.
 */
export function returnSnDoIncidente(inc: IncidenteDoCanal): string | null {
  if (inc.origem !== ORIGEM_INCIDENTE.pedidoShopee) return null;
  const raw = (inc.externalId ?? '').trim();
  return ehReturnSnShopee(raw) ? raw : null;
}

/**
 * Whether a CHANNEL importer owns this incidente's `origem` and `tipo`: a
 * marketplace origem AND a non-blank `externalId`.
 *
 * The editor locks both fields on such a row — the Selects are disabled, and
 * `buildIncidentePatch` drops them structurally — because retyping either one
 * lifts or forges the pedido overlay: the overlay keys on exactly these two.
 *
 * ⚠️ `externalId` is the second half on purpose. A legacy row tagged with a
 * marketplace origem but no id was typed by a person and stays editable;
 * step 5's `outros` (99) product rows carry an id but are not a marketplace's.
 */
export function ehIncidenteImportado(inc: IncidenteDoCanal): boolean {
  if (!ehOrigemDeMarketplace(inc.origem)) return false;
  return (inc.externalId ?? '').trim() !== '';
}

/** One option of the editor's Origem `Select`. */
export interface OpcaoDeOrigem {
  value: string;
  label: string;
}

/**
 * The editor's Origem options: `(nenhuma)` first, then every origem EXCEPT the
 * marketplace ones — unless `atual` (the STORED origem of the row being edited)
 * is one, so a legacy row keeps a displayable value.
 *
 * A marketplace origem is the importer's to write. Offering it on a manual row
 * would let an operator hand-tag one, and a hand-tagged row reads as an OPEN
 * claim (no `claimStatus`) that blocks the pedido until someone records a
 * resolução. `validateIncidenteForm` refuses the same thing at save time.
 */
export function opcoesDeOrigem(atual: number | null | undefined): OpcaoDeOrigem[] {
  const opcoes: OpcaoDeOrigem[] = [{ value: '', label: '(nenhuma)' }];
  for (const [value, label] of Object.entries(ORIGEM_INCIDENTE_LABELS)) {
    const origem = Number(value);
    if (ehOrigemDeMarketplace(origem) && origem !== atual) continue;
    opcoes.push({ value, label });
  }
  return opcoes;
}
