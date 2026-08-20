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
 * ⚠️ The transition that makes this load-bearing is `closed`. The parent's
 * `estado` feeds `linkHasLiveListing`, which drives `produtos.integracoesComProduto`
 * — the anchor pre-filter BOTH ML sweeps open with. So one member closing while
 * its siblings are still selling would drop the whole produto out of the stock and
 * price sweeps, silently: nothing errors, the produto simply stops being selected.
 * Hence the ladder below, where `closed` ranks LAST and can only win when it is
 * the only thing left.
 *
 * ⚠️ There is NO FLOOR under "cannot conclude", and that is a deliberate bias with
 * a consequence worth naming. A family whose members were all closed BEFORE this
 * shipped stays un-concluded until every member fires another `items`
 * notification — and a closed listing that never changes again never fires one. So
 * such a family keeps its old `estado` and stays selected by the sweeps. That is
 * over-inclusion (a few wasted sends that ML rejects), never a silent drop, which
 * is the direction this whole module is biased toward. Clearing that backlog needs
 * a reconciliation pass, not a rule change here.
 *
 * Pure and total: no Firestore, no ML, no clock. `podeEnviarEstoque` is itself a
 * pure predicate — the fold borrows the SAME definition of "sendable" the stock
 * planner gates on rather than restating it and letting the two drift. The caller
 * supplies every member it knows about (with the notified one's freshly-fetched
 * status substituted in) and gets back the raw values to write, or null meaning
 * "cannot conclude — write nothing", which is always safe because the previous
 * value stays.
 */

import { podeEnviarEstoque } from './bulkEstoquePlan';

/** The member facts the fold reads. `status` null = never observed. */
export interface FoldableMember {
  status: string | null;
  subStatus: string[] | null;
}

/** The raw ML values the family's parent link should carry. */
export interface FoldedFamilyStatus {
  status: string;
  subStatus: string[] | null;
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
 */
function rank(status: string): number {
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
 *  - every OBSERVED member is closed but at least one member was never observed.
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
    const r = rank(m.status);
    if (r > winnerRank) {
      winnerRank = r;
      winner = m;
    } else if (r === winnerRank && winner != null && !sendable(winner) && sendable(m)) {
      // ⚠️ TIE-BREAK, and it is not cosmetic. `rank` reads `status` alone, so two
      // `paused` members tie — but the stock gate reads the PAIR: `paused` sends
      // only WITH `out_of_stock`. Left to arrive-order the winner would be
      // whichever child produto sorts first by `__name__`, so the same family
      // with the same member statuses would either keep receiving stock or stop,
      // decided by document ordering. Stopping is the harmful direction: the
      // out-of-stock member then never gets the `qty > 0` push ML reactivates on,
      // and the listing stays down. Same shape as the `closed` rung above — one
      // member's bad news speaking for the family — so it gets the same answer.
      winner = m;
    }
  }

  if (winner == null) return null; // nothing observed
  if (winnerRank === 0 && unobserved > 0) return null; // all-closed is not yet provable

  return { status: winner.status!, subStatus: winner.subStatus };
}

/** Whether ML would accept a stock update for this reading — the tie-break key. */
function sendable(m: FoldableMember): boolean {
  return podeEnviarEstoque(m.status, m.subStatus).enviar;
}
