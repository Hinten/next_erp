import type {
  ImportedIncident,
  ImportedIncidentMessage,
  IncidentKind,
  IncidentParty,
  SyncCursor,
  SyncPage,
} from '@delfrance/core/plugins';
import type { MercadoLivreApi } from './api';
import { MercadoLivreHttpError } from './errors';
import type { MlClaim, MlClaimMessage, MlClaimReason } from './types';

/**
 * Pure wire → `ImportedIncident` mapping + the two MarketplaceChannel incident
 * adapters (claims import, Step 14). Platform-neutral on purpose: no Firebase,
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
      return 'other';
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
      return 'marketplace';
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
 * `MarketplaceChannel.importIncidents` body — one `searchClaims` page per call.
 *
 * Honest limitations (the webhook handler in `apps/mercado-livre` is the
 * authoritative ingest; this adapter is a convenience read):
 * - `status: 'opened'` only — closed claims never show up here.
 * - `cursor.sinceMs` is filtered CLIENT-SIDE against `lastUpdatedMs` (the
 *   search endpoint has no since param), so a filtered page can come back
 *   empty while `nextCursor` still advances.
 * - Items carry NO messages/reason (no N+1) — hydrate via `getIncidentMl`.
 */
export async function importIncidentsMl(
  api: MercadoLivreApi,
  cursor?: SyncCursor,
): Promise<SyncPage<ImportedIncident>> {
  const offset = Number(cursor?.token ?? 0);
  const page = await api.searchClaims({ status: 'opened', limit: SEARCH_PAGE_LIMIT, offset });
  const pageItems = page.data;
  const consumed = offset + pageItems.length;
  const total = page.paging.total ?? null;

  const sinceMs = cursor?.sinceMs;
  const mapped = pageItems.map((claim) => mapClaimToImportedIncident(claim));
  const items = sinceMs != null ? mapped.filter((i) => i.lastUpdatedMs > sinceMs) : mapped;

  return {
    items,
    ...(total != null && consumed < total ? { nextCursor: { token: String(consumed) } } : {}),
  };
}

/**
 * `MarketplaceChannel.getIncident` body — targeted hydrate: full claim +
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
