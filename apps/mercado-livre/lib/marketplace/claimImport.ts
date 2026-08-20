/**
 * Mercado Livre CLAIMS webhook-topic handler (Step 14) — import one ML claim
 * as an Incidente (`pedidos/{pedidoId}/incidentes`) + Conversa (`chat`) +
 * Mensagens (`chat/{id}/mensagem`, attachments included), at the BYTE-EXACT
 * legacy doc ids (`claimIds.ts`), so re-processing a claim the Flutter app
 * already imported UPDATES the same docs instead of forking them. IMPORT
 * only — no respond side.
 *
 * Ports `getClaimMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1754-2005`)
 * with the Step 14 hardening policy:
 *
 *  - Legacy's unindexed first-lookups (pedidos `numero`+`integracao`,
 *    `freteInicial.externalId` — :1785-1791) are DELIBERATELY dropped: the
 *    `orderML` mirror is indexed and every ML pedido carries it, and the
 *    import fallback converges on the same deterministic pedido id anyway.
 *  - Legacy THREW `UnimplementedError` on an unresolvable pedido (:1852) and
 *    `assert`-crashed on a cliente-less pedido (:1855) — both are
 *    deterministic conditions a retry cannot fix, so this port returns a
 *    logged skip instead (`pedido-nao-encontrado` / `sem-cliente`).
 *  - A claim OPENED BY THE SELLER against a buyer that never produced a
 *    pedido is a silent ack (`reclamacao-do-vendedor`, legacy :1846-1851).
 *  - Deterministic ML-side dead ends degrade instead of poisoning the retry
 *    loop (legacy let them throw): the reason lookup falls back to the
 *    unknown-motivo text, a missing buyer profile (`getUser`) degrades to a
 *    null nickname, and a purged shipment (404) falls through to the
 *    pedido-not-found skip. Network errors still propagate (transient → retry).
 *
 * Upsert discipline (legacy-faithful):
 *  - INCIDENTE: create writes the full doc; an EXISTING doc gets ONLY
 *    `{ ultimaModificacao, resolucao }` merged (:1886-1891 — protects operator
 *    edits in the IncidentesTab; `resolucao` is re-derived each run with the
 *    FIXED tipo table, riding a field legacy already overwrote — #364), and
 *    each of the two only when NON-NULL: legacy's `copyWith` null-coalesced
 *    (`x ?? this.x`), so a still-open claim (null resolution on the wire)
 *    never wiped a stored resolução. `timestamp` is NEVER rewritten on update.
 *  - CONVERSA: create writes the full doc (estadoConversa fills from the
 *    schema default, naoRespondido); an EXISTING doc merges the mapped fields
 *    only when the stored `ultima_modificacao` is null or older than the
 *    incoming one, WITHOUT `estadoConversa` (operator triage state,
 *    :1908-1923) and WITHOUT `data_cadastro`, via `parseMerge` (a full parse
 *    would let schema defaults clobber stored fields).
 *  - MENSAGENS: the reason mensagem is written only when the conversa was
 *    created/updated (:1925-1937), at the RAW reason id; every claim message
 *    is a `set` (overwrite) at its deterministic id — legacy `forceAdd`
 *    parity, idempotent; attachment mensagens are written only when the
 *    Arquivo landed in Storage (`ensureClaimAttachmentArquivo`), and all
 *    attachments are skipped with ONE loud warn when no bucket is available.
 *
 * THROW-ON-TRANSIENT discipline: only `getClaim` 404 (`claim-404`) and the
 * deterministic skips above return; every other failure (ML API non-404,
 * network, Firestore, ZodError) PROPAGATES so the notification queue/sweep
 * retries. No generic `catch` anywhere in this module.
 *
 * ⚠️ UNITS: incidente datetimes are MICROSECONDS; conversa/mensagem datetimes
 * are MILLISECONDS (`claimMapping.ts` owns the conversions).
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlClaim,
  type MlClaimReason,
} from '@delfrance/integrations-mercado-livre';
import {
  conversaCollection,
  incidenteCollection,
  mensagemCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

import type { Bucket } from './arquivoUpload';
import { ensureClaimAttachmentArquivo } from './claimAttachments';
import {
  makeAttachmentMensagemId,
  makeClaimMessageId,
  makeConversaIdClaim,
  makeIncidenteIdClaim,
} from './claimIds';
import {
  buildAttachmentMensagem,
  buildClaimMessageMensagem,
  buildConversaFromClaim,
  buildIncidenteFromClaim,
  buildReasonMensagem,
} from './claimMapping';
import { claimActionability, type ClaimActionability } from './claimActionability';
import { vincularClienteMercadoLivre } from './claimCliente';
import { coerceToMillis } from '@delfrance/core/datetime';
import { limparMensagensProvisorias } from './mensagemProvisoria';
import { resolveShipmentOrderId } from './shipmentOrderId';
import { importPedidoMercadoLivre } from './orderImport';
import { resolvePedidoIdByOrderId } from './orderPedidoResolve';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

export interface ClaimImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** ML seller id + etiqueta color from the integração doc. */
  conta: { userId: number | null; cor: number | null };
  /** One timestamp for the whole run (µs since epoch) — incidente standard. */
  nowUs: number;
  /** Same instant, milliseconds — conversa/mensagem standard. */
  nowMs: number;
  /** Storage bucket for attachment Arquivos — null skips ALL attachments (one warn). */
  bucket: Bucket | null;
}

export interface ClaimImportResult {
  pedidoId: string | null;
  incidenteId: string | null;
  conversaId: string | null;
  skipped:
    | 'claim-404'
    | 'resource-nao-suportado'
    | 'pedido-nao-encontrado'
    | 'reclamacao-do-vendedor'
    | 'sem-cliente'
    /** No send action for the seller and no conversa existed — incidente only. */
    | 'sem-conversa-acionavel'
    | null;
  /** What the seller can still do, for the caller's log line. */
  acao?: ClaimActionability;
}

/* -------------------------------------------------------------------------- */
/*                             Small pure helpers                             */
/* -------------------------------------------------------------------------- */

// ML claim `resource` wire literals this handler routes (`_ResourceClaims` +
// `pack`, which legacy folded into the order path upstream).
const RESOURCE_ORDER = 'order';
const RESOURCE_PACK = 'pack';
const RESOURCE_SHIPMENT = 'shipment';

// `_RolePlayes.complainant` / the `_typePlayer.ehComprador` set
// (models.dart:3954, :3989 — buyer/payer/receiver are the buyer-side types).
const ROLE_COMPLAINANT = 'complainant';
const BUYER_PLAYER_TYPES: ReadonlySet<string> = new Set(['buyer', 'payer', 'receiver']);

function skipResult(skipped: NonNullable<ClaimImportResult['skipped']>): ClaimImportResult {
  return { pedidoId: null, incidenteId: null, conversaId: null, skipped };
}

/** `Claims.getClientId`'s player pick (models.dart:3887-3889) — first buyer-side player. */
function findBuyerPlayer(claim: MlClaim): { user_id: number | null } | undefined {
  return claim.players.find((p) => p.type != null && BUYER_PLAYER_TYPES.has(p.type));
}

/**
 * The seller-complainant check (tasks.dart:1846-1851). Both ids must be
 * present — `String(null) === String(null)` would otherwise classify a
 * null-user_id complainant as the seller whenever `conta.userId` is null,
 * silencing the pedido-not-found warn.
 */
function isSellerComplaint(claim: MlClaim, sellerUserId: number | null): boolean {
  if (sellerUserId == null) return false;
  return claim.players.some(
    (p) =>
      p.role === ROLE_COMPLAINANT &&
      p.user_id != null &&
      String(p.user_id) === String(sellerUserId),
  );
}

/* -------------------------------------------------------------------------- */
/*                                Orchestrator                                */
/* -------------------------------------------------------------------------- */

/**
 * Import (upsert) one Mercado Livre claim. See the module doc for the full
 * legacy mapping + every deviation.
 */
export async function importClaimMercadoLivre(
  deps: ClaimImportDeps,
  claimId: number,
): Promise<ClaimImportResult> {
  const { db, api, integracaoId, conta, nowUs, nowMs, bucket } = deps;

  /* ------------------------------ (a) the claim ----------------------------- */
  let claim: MlClaim;
  try {
    claim = await api.getClaim(claimId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      // tasks.dart:1766-1771 — permanently gone, never retry.
      console.warn('[mercado-livre] claim não encontrada (404)', { claimId });
      return skipResult('claim-404');
    }
    throw err;
  }

  /* ------------------- (b) resource routing → pedido resolve ---------------- */
  const isOrderLike = claim.resource === RESOURCE_ORDER || claim.resource === RESOURCE_PACK;
  const isShipment = claim.resource === RESOURCE_SHIPMENT;
  if (!isOrderLike && !isShipment) {
    // 'payment' (legacy :1793-1795) and any unknown resource — deterministic ack.
    console.warn('[mercado-livre] claim: resource não suportado', {
      claimId,
      resource: claim.resource,
    });
    return skipResult('resource-nao-suportado');
  }

  // The ML order/pack id the pedido resolves by: the claim's own resource_id
  // for order/pack, the shipment's order_id for shipment (tasks.dart:1816-1832).
  let orderKey: number | null = claim.resource_id;
  if (isShipment) {
    try {
      const shipment = await api.getShipment(claim.resource_id);
      // `shipment.order_id` was discontinued by ML (#957) — fall back to
      // `GET /shipments/{id}/orders`.
      orderKey = await resolveShipmentOrderId(api, shipment);
    } catch (err) {
      if (err instanceof MercadoLivreHttpError && err.status === 404) {
        // A purged shipment is permanent — fall through to the
        // pedido-not-found skip instead of poisoning the retry loop.
        console.warn('[mercado-livre] claim: shipment não encontrado (404)', {
          claimId,
          resourceId: claim.resource_id,
        });
        orderKey = null;
      } else {
        throw err;
      }
    }
  }

  let pedidoId: string | null = null;
  if (orderKey != null) {
    pedidoId = await resolvePedidoIdByOrderId(db, orderKey);
    if (pedidoId == null) {
      // No orderML mirror yet → full order import (tasks.dart:1812-1813/:1829).
      const imported = await importPedidoMercadoLivre(
        { db, api, integracaoId, nowUs, nowMs },
        orderKey,
      );
      pedidoId = imported.skipped == null ? imported.pedidoId : null;
    }
  }

  /* --------------- (d) pedido unresolved → seller-complaint / skip ---------- */
  if (pedidoId == null) {
    if (isSellerComplaint(claim, conta.userId)) {
      // The seller's own claim against a buyer that never produced a pedido —
      // silent ack (tasks.dart:1846-1851).
      return skipResult('reclamacao-do-vendedor');
    }
    // Legacy THREW here (:1852) — a retry cannot conjure the pedido, so skip.
    console.warn('[mercado-livre] claim: pedido não encontrado', {
      claimId,
      resource: claim.resource,
      resourceId: claim.resource_id,
    });
    return skipResult('pedido-nao-encontrado');
  }

  /* ------------------ (c) cliente check + one import retry ------------------ */
  const readPedido = async (id: string) => {
    const snap = await pedidoCollection.docRef(db, {}, id).get();
    return pedidoCollection.parseRead(snap.data() ?? {}, pedidoCollection.docPath({}, id));
  };
  let pedido = await readPedido(pedidoId);
  if (pedido.clientePedidoOuterRef == null && orderKey != null) {
    // Legacy re-imports ONCE when the pedido has no cliente yet (:1836-1844) —
    // the import fills cliente/endereço on an already-discovered pedido.
    const reimported = await importPedidoMercadoLivre(
      { db, api, integracaoId, nowUs, nowMs },
      orderKey,
    );
    if (reimported.skipped == null && reimported.pedidoId != null) {
      pedidoId = reimported.pedidoId;
    }
    pedido = await readPedido(pedidoId);
  }
  const clienteOuterRef = pedido.clientePedidoOuterRef ?? null;
  if (clienteOuterRef == null) {
    // Legacy `assert`-crashed (:1855) — hardening: logged deterministic skip.
    console.warn('[mercado-livre] claim: pedido sem cliente', { claimId, pedidoId });
    return skipResult('sem-cliente');
  }

  /* ------------------------ (e) buyer + (f) usuário ------------------------- */
  const buyer = findBuyerPlayer(claim);
  if (buyer == null || buyer.user_id == null) {
    // Legacy `getClientId` threw 'Não encontrou o cliente' (models.dart:3888) —
    // same hardening class as the pedido misses above; `sem-cliente` is the
    // one skip value for "the buyer/cliente side cannot be resolved".
    console.warn('[mercado-livre] claim: nenhum player comprador', { claimId });
    return skipResult('sem-cliente');
  }
  const buyerUserId = buyer.user_id;
  // ⚠️ The `GET /users/{id}` call that used to sit here is GONE (#768). Its
  // only product was the buyer nickname, whose only consumer was
  // `usuario.apelido` — and the module that wrote it is deleted. It was one
  // ML round-trip per claim notification for a value nothing reads.

  // #768 — the contact is a CLIENTE. The pedido already names it; all this does
  // is stamp the ML buyer id onto it when absent, so the cliente a pre-sale
  // question created and the cliente this order created converge instead of
  // forking. No usuario is created anywhere on this path any more.
  const { clienteOuterRef: clienteRef } = await vincularClienteMercadoLivre(db, {
    clienteOuterRef,
    buyerUserId,
  });

  // What the seller can still DO on this claim — the conversa gate below.
  const acao = claimActionability(claim);

  /* ------------------------ (g) best-effort reason -------------------------- */
  let reason: MlClaimReason | undefined;
  if (claim.reason_id != null) {
    try {
      reason = await api.getClaimReason(claim.reason_id);
    } catch (err) {
      if (err instanceof MercadoLivreHttpError) {
        // Deterministic ML-side answer — degrade to the unknown-motivo
        // fallback instead of blocking the claim; network errors propagate.
        console.warn('[mercado-livre] claim: motivo indisponível', {
          claimId,
          reasonId: claim.reason_id,
          status: err.status,
        });
      } else {
        throw err;
      }
    }
  }

  /* ------------------------- (h) incidente upsert (µs) ----------------------- */
  const incidenteId = makeIncidenteIdClaim(integracaoId, claim.resource_id, claim.id);
  const incidenteFields = buildIncidenteFromClaim(claim, reason, nowUs);
  const incidenteSnap = await incidenteCollection.docRef(db, { pedidoId }, incidenteId).get();
  if (incidenteSnap.exists) {
    // Legacy copyWith(ultimaModificacao, resolucao) on the EXISTING doc
    // (:1886-1891) — every other field (timestamp included) is operator turf.
    // Dart's generated copyWith NULL-COALESCES (`x ?? this.x`), so a null
    // incoming value KEPT the stored one: a still-open claim (resolution null
    // on the wire — every new-message webhook) must not wipe an
    // operator-entered resolução, and a null `last_updated` must not regress
    // `ultimaModificacao` to the date_created fallback.
    const patch = {
      ...(claim.last_updated != null
        ? { ultimaModificacao: incidenteFields.ultimaModificacao }
        : {}),
      ...(incidenteFields.resolucao != null ? { resolucao: incidenteFields.resolucao } : {}),
    };
    if (Object.keys(patch).length > 0) {
      await incidenteCollection.merge(db, { pedidoId }, incidenteId, patch);
    }
  } else {
    await incidenteCollection.set(db, { pedidoId }, incidenteId, incidenteFields);
  }

  /* -------------------------- (i) conversa upsert (ms) ----------------------- */
  // ⚠️ The incidente above is written for EVERY claim; the conversa is not.
  // A chat thread the seller cannot send on is #817 with extra steps — the
  // operator types, the reply goes nowhere. The incidente keeps the business
  // record either way, so nothing is lost by not opening the thread.
  const conversaId = makeConversaIdClaim(integracaoId, claim.resource_id, claim.id);
  const conversaSnap = await conversaCollection.docRef(db, {}, conversaId).get();

  if (!acao.podeResponder && !conversaSnap.exists) {
    // Nothing to answer and no history to preserve — the incidente is the
    // import. This is the owner's "import only what we can act on" directive.
    return {
      pedidoId,
      incidenteId,
      conversaId: null,
      skipped: 'sem-conversa-acionavel',
      acao,
    };
  }

  const conversaFields = buildConversaFromClaim(claim, {
    buyerUserId,
    clienteOuterRef: clienteRef,
    contaId: integracaoId,
    contaCor: conta.cor,
    pedidoId,
    incidenteId,
    respostaBloqueada: acao.motivo,
    podeResponder: acao.podeResponder,
  });

  // ⚠️ ONE transaction, gated on a PROVIDER watermark (root CLAUDE.md rule 7,
  // tier 2) — the same shape the post-sale message import and the WhatsApp
  // inbound guard use.
  //
  // This replaced a `ultima_modificacao` freshness check plus an out-of-band
  // close, and both halves of that were wrong. `ultima_modificacao` is a MIXED
  // clock — operators write it on every rename and etiqueta change — so an
  // edited conversa looked permanently "newer" than the wire. And the escape
  // hatch only ever CLOSED: a claim that regained a send action without moving
  // `last_updated` stayed blocked forever, while a worker holding an older
  // no-action response could close a thread another worker had just reopened.
  //
  // `ultimaModificacaoIntegracao` carries `claim.last_updated` and nothing else,
  // so the comparison is provider-vs-provider. The patch reconciles BOTH
  // directions because `respostaBloqueada` and `atendido` simply ride it, and
  // the gate is `>=`: when ML does not move `last_updated`, an equal snapshot
  // still applies, which is what the old escape hatch existed for.
  const atualizouConversa = await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversaCollection.docRef(db, {}, conversaId));
    if (!snap.exists) {
      // Full doc — estadoConversa fills from the schema default (naoRespondido).
      tx.set(
        conversaCollection.docRef(db, {}, conversaId),
        conversaCollection.parse(conversaFields) as DocumentData,
      );
      return true;
    }

    // Re-derived from the tx snapshot, never from the read above — that one is
    // stale by the time we get here, which is the whole point.
    const stored = snap.data() as Record<string, unknown> | undefined;
    const armazenado =
      typeof stored?.ultimaModificacaoIntegracao === 'number'
        ? stored.ultimaModificacaoIntegracao
        : null;
    const entrante = conversaFields.ultimaModificacaoIntegracao as number | null;

    if (armazenado != null && entrante != null && entrante < armazenado) {
      console.warn('[mercado-livre] claim: snapshot mais antigo ignorado', {
        conversaId,
        armazenado,
        entrante,
      });
      return false;
    }

    // parseMerge (never a full parse: defaults would clobber stored fields),
    // WITHOUT data_cadastro (set once on create) — estadoConversa is already
    // absent from the mapped fields (see buildConversaFromClaim).
    const { data_cadastro: _dataCadastro, ...patch } = conversaFields;
    tx.set(
      conversaCollection.docRef(db, {}, conversaId),
      conversaCollection.parseMerge(patch) as DocumentData,
      { merge: true },
    );
    return true;
  });

  /* --------------------------- (j) mensagens (ms) ---------------------------- */
  const messages = await api.getClaimMessages(claimId);

  if (atualizouConversa) {
    // The reason mensagem rides the conversa's create/update gate
    // (tasks.dart:1925-1937), at the RAW ML reason id — hashing would fork
    // years of history (legacy `motivo['id'].toString()`, so a numeric wire id
    // stringifies identically). No reason id at all → nothing to write.
    const reasonId = reason?.id != null ? String(reason.id) : (claim.reason_id ?? null);
    if (reasonId != null) {
      await mensagemCollection.set(
        db,
        { conversaId },
        reasonId,
        buildReasonMensagem({ reasonId, claim, reason, clienteOuterRef: clienteRef }),
      );
    }
  }

  let warnedNoBucket = false;
  for (const msg of messages) {
    const messageDocId = makeClaimMessageId(integracaoId, msg);

    // Attachments first (legacy order, :1941-1990), then the message itself.
    for (const attachment of msg.attachments) {
      if (bucket == null) {
        if (!warnedNoBucket) {
          console.warn(
            '[mercado-livre] claim: bucket de Storage indisponível — TODOS os anexos ignorados',
            { claimId },
          );
          warnedNoBucket = true;
        }
        continue;
      }
      const ensured = await ensureClaimAttachmentArquivo(
        { db, api, bucket },
        { contaId: integracaoId, claimId, filename: attachment.filename },
      );
      if (!ensured.ok) {
        // Legacy caught the download error and `continue`d (:1953-1959).
        console.warn('[mercado-livre] claim: anexo ignorado', {
          claimId,
          filename: attachment.filename,
          skipped: ensured.skipped,
        });
        continue;
      }
      await mensagemCollection.set(
        db,
        { conversaId },
        makeAttachmentMensagemId(integracaoId, attachment.filename),
        buildAttachmentMensagem({
          filename: attachment.filename,
          parentMessage: msg,
          parentMessageDocId: messageDocId,
          arquivoOuterRef: ensured.arquivoOuterRef,
          clienteOuterRef: clienteRef,
        }),
      );
    }

    // Overwrite-set at the deterministic id — legacy forceAdd parity (:1991-1995).
    await mensagemCollection.set(
      db,
      { conversaId },
      messageDocId,
      buildClaimMessageMensagem(msg, messageDocId, { clienteOuterRef: clienteRef }),
    );
  }

  // Same expiry as the post-sale path: the claim messages just written include
  // any reply the operator sent, so the provisional bubble covering the gap has
  // done its job. Bounded to the newest imported message time so a reply sent
  // after this snapshot keeps its placeholder.
  const carimbos = messages
    .map((m) => coerceToMillis(m.date_created))
    .filter((t): t is number => typeof t === 'number');
  await limparMensagensProvisorias(
    db,
    conversaId,
    carimbos.length > 0 ? Math.max(...carimbos) : null,
  );

  return { pedidoId, incidenteId, conversaId, skipped: null, acao };
}
