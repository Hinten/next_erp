import type {
  ImportedIncident,
  ImportedIncidentMessage,
  IncidentKind,
  IncidentParty,
  SyncCursor,
  SyncPage,
} from '@delfrance/core/marketplace';
import type { MercadoLivreApi } from './api';
import { CLAIM_SEARCH_WINDOW_MAX } from './claimSearch';
import { MercadoLivreHttpError } from './errors';
import type { MlClaim, MlClaimMessage, MlClaimReason } from './types';

/**
 * Pure wire → `ImportedIncident` mapping + the two incident READ adapters
 * (claims import, Step 14). Platform-neutral on purpose: no Firebase,
 * no `@delfrance/schemas` — the Firestore upsert (Incidente/Conversa/Mensagem
 * at the byte-exact legacy doc ids) lives in `apps/mercado-livre`, driven by
 * the webhook pipeline; these adapters are the provider-agnostic read surface.
 */

/** `claims` search page size — matches the ML documented default. */
const SEARCH_PAGE_LIMIT = 30;

/**
 * `claim.type` → `IncidentKind`. The legacy Dart enum (`_typeClaims`,
 * models.dart:3636-3655) THREW on unknown values; here anything unmapped
 * (including null) degrades to `'other'` — the raw type still rides the
 * passthrough claim in `channelSpecific` consumers.
 */
function kindFromClaimType(type: string | null): IncidentKind {
  switch (type) {
    case 'mediations':
      return 'mediation';
    case 'returns':
      return 'return';
    case 'cancel_purchase':
    case 'cancel_sale':
      return 'cancellation';
    case 'change':
      return 'exchange';
    case null:
    default:
      return 'other';
  }
}

/**
 * `sender_role` → `IncidentParty`. CAVEAT: the mapping is positional, not
 * literal — on a `cancel_sale` claim the complainant may be the SELLER (the
 * legacy `_typePlayer.ehComprador`, models.dart:3975-4002, resolved the buyer
 * by player TYPE, not role). The raw roles ride the incident's
 * `channelSpecific.players`, so a consumer that needs the true party can
 * re-derive it from the claim's player list.
 */
function authorFromSenderRole(senderRole: string | null): IncidentParty {
  switch (senderRole) {
    case 'complainant':
      return 'buyer';
    case 'respondent':
      return 'seller';
    case null:
    default:
      return 'marketplace';
  }
}

function mapClaimMessage(msg: MlClaimMessage): ImportedIncidentMessage {
  const attachments = msg.attachments.map((a) => a.filename);
  return {
    author: authorFromSenderRole(msg.sender_role),
    text: msg.message,
    ...(attachments.length > 0 ? { attachments } : {}),
    timestampMs: Date.parse(msg.date_created),
  };
}

/**
 * A parsed claim → the provider-agnostic `ImportedIncident`.
 *
 * CAVEAT on `orderExternalId`: it is `String(resource_id)` VERBATIM — for a
 * `shipment`/`payment` resource that is NOT an order id (the legacy handler
 * resolved those to a pedido via extra lookups, tasks.dart:1783-1844);
 * `channelSpecific.resource` carries the discriminator so the caller knows
 * which lookup applies.
 *
 * `messages`/`reason` are optional enrichments: the search adapter maps bare
 * claims (no N+1), `getIncidentMl` passes the full set.
 */
export function mapClaimToImportedIncident(
  claim: MlClaim,
  opts?: { messages?: ReadonlyArray<MlClaimMessage>; reason?: MlClaimReason },
): ImportedIncident {
  // Legacy motivo precedence: `detail ?? name` (tasks.dart:1778).
  const reasonText = opts?.reason ? (opts.reason.detail ?? opts.reason.name) : null;
  return {
    externalId: String(claim.id),
    kind: kindFromClaimType(claim.type),
    orderExternalId: String(claim.resource_id),
    status: claim.status ?? '',
    ...(reasonText != null ? { reason: reasonText } : {}),
    openedMs: Date.parse(claim.date_created),
    lastUpdatedMs: Date.parse(claim.last_updated ?? claim.date_created),
    ...(opts?.messages !== undefined ? { messages: opts.messages.map(mapClaimMessage) } : {}),
    channelSpecific: {
      stage: claim.stage,
      resource: claim.resource,
      resource_id: claim.resource_id,
      reason_id: claim.reason_id,
      players: claim.players,
      resolution: claim.resolution,
    },
  };
}

/**
 * The incident LIST adapter — one `searchClaims` page per call.
 *
 * ⚠️ **`sellerId` is REQUIRED, and that is the point of the parameter.** This
 * used to send `status: 'opened'` with paging and nothing else — a shape ML's own
 * docs now single out: *"Consultas com somente `status=opened` são tecnicamente
 * válidas, porém altamente ineficientes"*, an unbounded scan carrying *"risco de
 * rate limiting ou bloqueio da aplicação se o padrão persistir"*. Its stated
 * remedy is exactly this pair, `players.user_id` + `players.role=respondent`.
 *
 * ⚠️ It is **not optional with a fallback**. An optional `sellerId` degrading to
 * the old query would leave the bad-practice path alive as the silent default,
 * reachable by every caller who simply did not pass it — the fallback-that-is-
 * really-a-deny-list shape that has escaped review in this channel twice. A
 * caller without a seller id has no correct query to send, so the type says so.
 * `api.getMe().id` is the answer for one that does not already hold it, and
 * deliberately not called here: this is a per-page read and that would be one
 * extra round trip on every page.
 *
 * Honest limitations (the webhook handler in `apps/mercado-livre` is the
 * authoritative ingest; this adapter is a convenience read):
 * - `status: 'opened'` only — closed claims never show up here.
 * - `cursor.sinceMs` is filtered CLIENT-SIDE against `lastUpdatedMs` (the
 *   search endpoint has no since param), so a filtered page can come back
 *   empty while `nextCursor` still advances.
 * - Items carry NO messages/reason (no N+1) — hydrate via `getIncidentMl`.
 * - Paging stops at ML's 10000-row window (see `nextCursor` below).
 * - Paging also stops on an EMPTY page, even when `paging.total` still claims
 *   more rows — `total` is an estimate over an eventually-consistent engine.
 *   Continuing is impossible anyway: the offset cannot advance past a page that
 *   returned nothing.
 */
export async function importIncidentsMl(
  api: MercadoLivreApi,
  sellerId: number,
  cursor?: SyncCursor,
): Promise<SyncPage<ImportedIncident>> {
  const offset = Number(cursor?.token ?? 0);
  const page = await api.searchClaims({
    'players.user_id': sellerId,
    'players.role': 'respondent',
    status: 'opened',
    limit: SEARCH_PAGE_LIMIT,
    offset,
  });
  const pageItems = page.data;
  const consumed = offset + pageItems.length;
  const total = page.paging.total ?? null;

  const sinceMs = cursor?.sinceMs;
  const mapped = pageItems.map((claim) => mapClaimToImportedIncident(claim));
  const items = sinceMs != null ? mapped.filter((i) => i.lastUpdatedMs > sinceMs) : mapped;

  // ⚠️ ML refuses `offset + limit >= 10000`, so a cursor that would take the NEXT
  // page past that window is not emitted at all. Without this the walk ends on a
  // 400 — or now, since the query is checked locally, on a thrown
  // `MercadoLivreClaimSearchParamsError` from a call the caller did nothing wrong
  // to make. A seller with >10000 open claims is not a realistic shape; ending
  // the walk deliberately is still better than ending it by exception.
  const podePaginar = consumed + SEARCH_PAGE_LIMIT < CLAIM_SEARCH_WINDOW_MAX;

  // ⚠️ **An EMPTY page must end the walk, whatever `total` still claims.**
  // `consumed` is `offset + pageItems.length`, so an empty page leaves it equal
  // to the offset just passed in — and `consumed < total` is then still true
  // against a stale or estimated `total`, so the cursor emitted is the SAME one
  // the caller arrived with. A driver looping `while (page.nextCursor)` re-issues
  // an identical request for ever, and the 10000-row guard cannot break it
  // because the offset never advances. ML's search is an estimate over an
  // eventually-consistent engine and `status: 'opened'` narrows under our feet,
  // so "total says more, this page has none" is an ordinary answer, not a bug.
  //
  // ⚠️ It must test `pageItems`, NOT `items`: `items` is the `sinceMs`-filtered
  // view, and a page legitimately filters down to nothing while the offset DID
  // advance — the limitation documented above. Testing `items` would truncate
  // those walks at the first fully-filtered page.
  const houveProgresso = pageItems.length > 0;

  return {
    items,
    ...(total != null && consumed < total && podePaginar && houveProgresso
      ? { nextCursor: { token: String(consumed) } }
      : {}),
  };
}

/**
 * The incident HYDRATE adapter — targeted: full claim +
 * message thread + BEST-EFFORT reason (an HTTP failure on the reason endpoint
 * degrades to no reason — legacy parity, the motivo falls back to a default
 * text downstream — while a network error still aborts the whole hydrate).
 */
export async function getIncidentMl(
  api: MercadoLivreApi,
  externalIncidentId: string,
): Promise<ImportedIncident> {
  const claimId = Number(externalIncidentId);
  const claim = await api.getClaim(claimId);
  const messages = await api.getClaimMessages(claimId);

  let reason: MlClaimReason | undefined;
  if (claim.reason_id !== null) {
    try {
      reason = await api.getClaimReason(claim.reason_id);
    } catch (err) {
      if (err instanceof MercadoLivreHttpError) {
        console.warn(
          `Motivo da reclamação ${claim.reason_id} indisponível (ML ${err.status}) — importando sem motivo.`,
        );
      } else {
        throw err;
      }
    }
  }

  return mapClaimToImportedIncident(claim, { messages, reason });
}
