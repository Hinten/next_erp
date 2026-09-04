/**
 * Fold a User-Products family's member listings into the ONE status its parent
 * link can carry.
 *
 * ML has no family-level status — `publish.ts` says so outright where it takes
 * the parent's `estado` from `family.items[0]`, and the importer does the same
 * with whichever member it happened to import. That convention is fine at write
 * time (one member, just observed) but wrong as a general rule: an `items`
 * notification arrives for ONE member, and applying it straight to the parent
 * would let any single member speak for the whole family.
 *
 * ⚠️ The transition that makes this load-bearing is a member ENDING — `closed`,
 * or removed by ML moderation (#1226). The parent's `estado` feeds
 * `linkHasLiveListing`, which drives `produtos.integracoesComProduto` — the
 * anchor pre-filter BOTH ML sweeps open with. So one member ending while its
 * siblings are still selling would drop the whole produto out of the stock and
 * price sweeps, silently: nothing errors, the produto simply stops being selected.
 * Hence the ladder below, where both terminal readings rank LAST and can only
 * win when nothing else is left.
 *
 * ⚠️ There is NO FLOOR under "cannot conclude", and that is a deliberate bias with
 * a consequence worth naming. A family whose members were all ended BEFORE this
 * shipped stays un-concluded until every member fires another `items`
 * notification — and a closed listing that never changes again never fires one. So
 * such a family keeps its old `estado` and stays selected by the sweeps. That is
 * over-inclusion (a few wasted sends that ML rejects), never a silent drop, which
 * is the direction this whole module is biased toward. Clearing that backlog needs
 * a reconciliation pass, not a rule change here.
 *
 * ⚠️ The fold also carries ML's MODERATIONS (#1087), and it carries the WINNER's
 * rather than a union: `status` and the text explaining it have to describe the
 * same listing. Because every member's moderations are stored on its own link
 * beside its raw status, this costs no extra ML call — the caller substitutes the
 * notified member's freshly-fetched value exactly as it already does for `status`.
 *
 * Pure and total: no Firestore, no ML, no clock. `podeEnviarEstoque` is itself a
 * pure predicate — the fold borrows the SAME definition of "sendable" the stock
 * planner gates on rather than restating it and letting the two drift. The caller
 * supplies every member it knows about (with the notified one's freshly-fetched
 * status substituted in) and gets back the raw values to write, or null meaning
 * "cannot conclude — write nothing", which is always safe because the previous
 * value stays.
 */

import { type MlModeracao, moderacaoRemoveuAnuncio } from '@delfrance/schemas';

import { podeEnviarEstoque } from '../estoque/bulkEstoquePlan';

/** The member facts the fold reads. `status` null = never observed. */
export interface FoldableMember {
  status: string | null;
  subStatus: string[] | null;
  /**
   * ML's active moderations on THIS member (#1087) — as stored on its own link,
   * with the notified member's freshly-fetched value substituted in by the
   * caller, exactly like `status`.
   *
   * ⚠️ Optional so the fold's existing callers and tests need no change: a member
   * observed before this field existed simply has no moderation, which is the
   * correct reading of an absent value and not a guess.
   */
  moderacoes?: MlModeracao[] | null;
}

/** The raw ML values the family's parent link should carry. */
export interface FoldedFamilyStatus {
  status: string;
  subStatus: string[] | null;
  /**
   * The WINNER's moderations — the same member whose status the family took.
   *
   * ⚠️ Not a union across members, and that is the whole point. `status` and the
   * text explaining it must describe ONE listing: pooling every member's
   * moderation onto the parent would show a reason for a sibling that is not the
   * one the family's `estado` is reporting, which is the "one member speaks for
   * the family" mistake this module exists to prevent (#1142) wearing a different
   * hat. Never null: a winner with no moderation folds to `[]`, which is what
   * CLEARS a lifted moderation off the parent.
   */
  moderacoes: MlModeracao[];
}

/**
 * Liveness rank — higher wins. `closed` is deliberately the floor so it only
 * decides the family when every observed member is closed.
 *
 * An unrecognised-but-present status ranks above `closed` and below the known
 * live ones: it is evidence the listing still exists, which is the opposite of
 * evidence it is gone. `estadoFromMlStatus` maps it to `'E'`, and letting a
 * status ML has not documented yet mark a whole family cancelled would be the
 * same silent-outage shape this ladder exists to prevent.
 *
 * ⚠️ It reads the STATUS/SUB_STATUS PAIR, not the status alone, and that is
 * load-bearing for exactly one combination (#1226). A listing Mercado Livre has REMOVED reads
 * `under_review` + `forbidden` — the status alone puts it at rank 2, above the
 * `closed` floor and, through `prefere`'s moderation rung, actively PREFERRED
 * over an equally-ranked sibling. So a family with one removed member and one
 * still under ordinary review would elect the removed one, stamp the terminal
 * `estado 'rm'` on the parent and drop the produto out of both sweeps while a
 * savable sibling remained: the identical failure the `closed` floor exists to
 * prevent, arriving through a different door. A removed member therefore ranks
 * at the floor too, and inherits the "all-terminal is not yet provable when a
 * member was never observed" guard in {@link foldFamilyStatus} with it.
 */
function rank(status: string, subStatus: string[] | null): number {
  if (moderacaoRemoveuAnuncio(status, subStatus)) return 0;
  switch (status) {
    case 'active':
      return 4;
    case 'paused':
      return 3;
    case 'under_review':
      return 2;
    case 'closed':
      return 0;
    default:
      return 1;
  }
}

/**
 * The family's status, or null when the members do not support a conclusion.
 *
 * Two distinct null cases, both meaning "leave the parent link alone":
 *  - nothing observed at all (a family whose members predate the status fields);
 *  - every OBSERVED member is terminal (closed, or removed by moderation) but at
 *    least one member was never observed.
 *    Writing `cancelado` there would be a guess about the unobserved one, and the
 *    cost of guessing wrong is the sweep outage described above. An unobserved
 *    member is unknown, never dead.
 */
export function foldFamilyStatus(members: readonly FoldableMember[]): FoldedFamilyStatus | null {
  let winner: FoldableMember | null = null;
  let winnerRank = -1;
  let unobserved = 0;

  for (const m of members) {
    if (m.status == null) {
      unobserved += 1;
      continue;
    }
    const r = rank(m.status, m.subStatus);
    if (r > winnerRank) {
      winnerRank = r;
      winner = m;
    } else if (r === winnerRank && winner != null && prefere(winner, m)) {
      winner = m;
    }
  }

  if (winner == null) return null; // nothing observed
  if (winnerRank === 0 && unobserved > 0) return null; // all-terminal is not yet provable

  return {
    status: winner.status!,
    subStatus: winner.subStatus,
    moderacoes: winner.moderacoes ?? [],
  };
}

/**
 * Whether `desafiante` should displace `atual` among members of the SAME rank.
 * Two rungs, tried in order; the first is the one that can cost money.
 *
 * ⚠️ RUNG 1 — sendability. Not cosmetic. `rank` reads the pair only to spot a
 * moderation REMOVAL, so two `paused` members still tie — but the stock gate
 * reads the whole pair: `paused` sends only
 * WITH `out_of_stock`. Left to arrive-order the winner would be whichever child
 * produto sorts first by `__name__`, so the same family with the same member
 * statuses would either keep receiving stock or stop, decided by document
 * ordering. Stopping is the harmful direction: the out-of-stock member then never
 * gets the `qty > 0` push ML reactivates on, and the listing stays down. Same
 * shape as the `closed` rung above — one member's bad news speaking for the
 * family — so it gets the same answer.
 *
 * ⚠️ RUNG 2 — explainability (#1087). Reached only when rank AND sendability are
 * equal, i.e. exactly where the rules above are indifferent and DOCUMENT ORDER
 * was silently deciding. Two `active` members, one carrying a
 * `poor_quality_thumbnail` moderation and one clean, tie on both: whichever won
 * would set the family's `sub_status` and, now, its `moderacoes`. Preferring the
 * member that can say WHY turns an arbitrary choice into an informative one, and
 * it cannot change stock behaviour because both readings are equally sendable.
 * Deliberately last: it must never outrank a decision the stock gate depends on.
 */
function prefere(atual: FoldableMember, desafiante: FoldableMember): boolean {
  const atualEnvia = sendable(atual);
  const desafianteEnvia = sendable(desafiante);
  if (atualEnvia !== desafianteEnvia) return desafianteEnvia;
  return (atual.moderacoes ?? []).length === 0 && (desafiante.moderacoes ?? []).length > 0;
}

/** Whether ML would accept a stock update for this reading — the tie-break key. */
function sendable(m: FoldableMember): boolean {
  return podeEnviarEstoque(m.status, m.subStatus).enviar;
}
