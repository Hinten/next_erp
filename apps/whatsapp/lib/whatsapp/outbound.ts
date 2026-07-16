/**
 * Outbound send disposition for the WhatsApp Cloud API (#529) — the PURE,
 * trigger-agnostic core that transmits an operator's (or the daily auto-reply's)
 * outbound `mensagem` to Meta and re-anchors it so the #527 status pipeline can
 * track delivery. Port of `_enviarMensagensWhatsapp` + `markAnyMessageAsRead`
 * (`.old/lib/chat/providers/conversaProvider.dart:~880-951` + `~1400-1460`).
 *
 * `sendOutbound` (`functions/src/sendOutbound.ts`, an `onDocumentCreated` on
 * `chat/{conversaId}/mensagem/{mensagemId}`) and `reprocessStaleOutbound` (the
 * `onSchedule` sweep) both call {@link dispatchOutbound}; keeping the disposition
 * here (not in the trigger) keeps it unit-testable with fakes.
 *
 * ── Send discriminator (PR-3 contract) ────────────────────────────────────────
 * A mensagem is a pending outbound send iff
 *
 *     estadoEnvio === ESTADO_ENVIO.salva (1)  AND  tipo !== 'e' && tipo !== '!'
 *       AND  mid == null  AND  parent conversa origem === 'whatsapp'
 *
 * Operator replies (apps/web) and the daily auto-reply (#527) both write
 * `{ estadoEnvio: salva, tipo: 'c', mid: null }`; lifecycle events are `tipo 'e'`
 * and inbound customer messages are `estadoEnvio: recebido (7)` — neither matches.
 * The `origem === 'whatsapp'` clause is the AUTHORITATIVE channel gate: apps/webchat
 * ('site' conversas) writes its own NON-null local `mid`, but a 'site' conversa is
 * excluded here by the origem gate regardless of its `mid` convention.
 *
 * ── RE-ANCHOR contract (#527 status pipeline depends on it) ────────────────────
 * `processStatus` locates an outbound mensagem by the DETERMINISTIC id
 * `mensagemDocId(contaId, status.id)` — NOT a `mid` collection-group query. So on
 * a successful send this disposition MUST move the doc to
 * `chat/{conversaId}/mensagem/{mensagemDocId(contaId, sendWamid)}` carrying the
 * full original content, `mid = sendWamid`, `estadoEnvio = enviando`, and
 * `lastExternalUpdateDateTime = null` — a TRANSACTIONAL create-new + delete-old.
 * The re-anchored doc re-fires this trigger, but it now carries `mid != null` so
 * the fast-path skips it (no loop, no re-send).
 *
 * ── Idempotency + at-least-once ────────────────────────────────────────────────
 * The trigger runs with `retry: true` (Eventarc at-least-once) and the 15-min
 * `reprocessStaleOutbound` sweep is a second backstop, so a send can be RE-DRIVEN
 * — a still-retrying trigger and the sweep can even overlap on the SAME doc. Three
 * guards make redelivery safe:
 *   (1) the fast-path `mid != null` skip on the re-anchored doc;
 *   (2) a TRANSACTIONAL CLAIM right before sending — {@link claimOutbound} re-reads
 *       the ORIGINAL and flips `estadoEnvio` salva→enviando ONLY if it is still
 *       (`salva` && `mid == null`). Concurrent dispatchers serialize on that
 *       transaction: exactly ONE wins and sends; every loser sees a non-`salva`
 *       doc (or a deleted one, after a prior success) and exits ('claimed'). This
 *       closes the concurrent double-send the fresh re-read alone could not;
 *   (3) the re-anchor create-new + delete-old transaction (below).
 * The ONLY remaining double-SEND window is a CRASH between the claim and the
 * re-anchor: the original is left `enviando` with `mid == null`, so the sweep
 * re-drives it — it queries BOTH `salva` and `enviando` (each with `mid == null`)
 * past the stale window. That re-driven send can RARELY duplicate (only if the
 * pre-crash send actually reached Meta) — the same at-least-once tail the legacy
 * pipeline carried. Stamping `mid` pre-anchor would instead strand status
 * callbacks (they can't locate the message until re-anchor completes), so we
 * accept this narrow tail.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  arquivoCollection,
  conversaCollection,
  mensagemCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_ENVIO, idFromRef, type Filetype } from '@delfrance/schemas';
import {
  WhatsAppHttpError,
  WhatsAppNetworkError,
  type SendMediaInput,
  type WhatsAppClient,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { fromNumberFromSenderId, mensagemDocId } from './ids';
import {
  WhatsappContaNotConfiguredError,
  WhatsappTokenMissingError,
  loadWhatsappContext,
  type WhatsappContext,
} from './whatsapp';

/** gRPC `ALREADY_EXISTS` — a create that lost the race (redelivery). */
const GRPC_ALREADY_EXISTS = 6;

/**
 * A deterministic "can't build the outbound message" failure (no content,
 * missing/urlless `Arquivo`, no recipient). Distinct from a transient Firestore
 * error so the disposition patches `erro` (no retry) instead of throwing.
 */
export class OutboundSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundSendError';
  }
}

/**
 * A TRANSIENT "not ready to build the outbound message yet" condition — distinct
 * from the terminal {@link OutboundSendError}. The create-first arquivo contract
 * makes an `Arquivo` doc visible before its bytes finish uploading, so a media
 * `mensagem` can briefly reference an arquivo whose `url` is still `null`. That is
 * NOT a permanent failure: the disposition RETHROWS it so Eventarc retries and the
 * sweep re-drives, giving the upload time to land. A permanently-`null` `url`
 * simply keeps the doc visible as unsent (never patched to `erro`).
 */
export class OutboundTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundTransientError';
  }
}

/** The disposition seam — injectable so unit tests skip real Firestore/Graph. */
export interface OutboundDeps {
  /** Resolve the WhatsApp account context (client + token). */
  loadContext(db: Firestore, integracaoId: string): Promise<WhatsappContext>;
}

export const defaultOutboundDeps: OutboundDeps = {
  loadContext: loadWhatsappContext,
};

export type OutboundResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'sent'; wamid: string; mensagemId: string }
  | { kind: 'error'; reason: string };

type MediaType = SendMediaInput['type'];

type SendSpec =
  | { kind: 'text'; text: string }
  | { kind: 'media'; type: MediaType; link: string; caption: string | null };

/* --------------------------------- helpers -------------------------------- */

function skip(reason: string): OutboundResult {
  return { kind: 'skipped', reason };
}

/**
 * Patch the ORIGINAL doc to `estadoEnvio = erro` + the error text (the `error`
 * field) and return an `error` result. Deterministic — the sweep only re-drives
 * `salva`, so `erro` is terminal (an operator resends). A transient failure of
 * the merge itself propagates so the trigger retries.
 */
async function failMensagem(
  db: Firestore,
  conversaId: string,
  mensagemId: string,
  message: string,
): Promise<OutboundResult> {
  await mensagemCollection.merge(db, { conversaId }, mensagemId, {
    estadoEnvio: ESTADO_ENVIO.erro,
    error: message,
  });
  console.error('[whatsapp] envio outbound falhou', { conversaId, mensagemId, message });
  return { kind: 'error', reason: message };
}

/** Map an `Arquivo` filetype to the WhatsApp media kind (legacy parity). */
function mediaTypeForFiletype(filetype: Filetype): MediaType {
  if (filetype === 'image') return 'image';
  if (filetype === 'video') return 'video';
  if (filetype === 'audio') return 'audio';
  return 'document';
}

/**
 * Decide what to transmit: a media send when the doc carries an `anexoStorage`
 * ref (legacy `mensagemUpload.anexoStorage`), else the text `conteudo`. The
 * `Arquivo`'s public download `url` is the media LINK Meta fetches server-side.
 * Deterministic problems throw {@link OutboundSendError} (terminal → `erro`); a
 * still-uploading arquivo (`url == null`) throws {@link OutboundTransientError}
 * (retry); a transient Firestore read propagates (so the trigger retries).
 */
async function resolveSendSpec(
  db: Firestore,
  doc: { conteudo: string | null; anexoStorage?: string | null; anexoDescription?: string | null },
): Promise<SendSpec> {
  const anexoRef = typeof doc.anexoStorage === 'string' ? doc.anexoStorage : null;
  if (anexoRef) {
    const arquivoId = idFromRef(anexoRef);
    if (!arquivoId) throw new OutboundSendError(`anexoStorage inválido: ${anexoRef}`);
    const snap = await arquivoCollection.docRef(db, {}, arquivoId).get();
    if (!snap.exists) throw new OutboundSendError(`Arquivo ${arquivoId} do anexo não encontrado.`);
    const arquivo = arquivoCollection.parseRead(
      snap.data(),
      arquivoCollection.docPath({}, arquivoId),
    );
    // A create-first arquivo may still be uploading — a `null` url is a PENDING
    // window, not a terminal error: throw TRANSIENT so the trigger/sweep re-drive.
    if (!arquivo.url) {
      throw new OutboundTransientError(
        `Arquivo ${arquivoId} sem URL de download (upload pendente?).`,
      );
    }
    const caption =
      (typeof doc.conteudo === 'string' && doc.conteudo.trim() !== '' ? doc.conteudo : null) ??
      (typeof doc.anexoDescription === 'string' ? doc.anexoDescription : null);
    return {
      kind: 'media',
      type: mediaTypeForFiletype(arquivo.filetype),
      link: arquivo.url,
      caption,
    };
  }

  const text = doc.conteudo;
  if (!text || text.trim() === '') {
    throw new OutboundSendError('Mensagem sem conteúdo para envio.');
  }
  return { kind: 'text', text };
}

/** Transmit the spec, returning the wamid Meta assigns. */
async function performSend(client: WhatsAppClient, to: string, spec: SendSpec): Promise<string> {
  if (spec.kind === 'text') {
    const res = await client.sendText({ to, text: spec.text });
    return res.messageId;
  }
  // Audio has no caption on the Graph API — omit it there.
  const res = await client.sendMedia({
    to,
    type: spec.type,
    link: spec.link,
    caption: spec.type === 'audio' ? undefined : (spec.caption ?? undefined),
  });
  return res.messageId;
}

/** Drop `undefined`-valued keys (Firestore rejects them) from a write payload. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Transactionally re-anchor a sent message to `mensagemDocId(contaId, wamid)`
 * (see the RE-ANCHOR contract): create the new doc carrying the full original
 * content + `mid = wamid` + `estadoEnvio = enviando` + `lastExternalUpdateDateTime
 * = null`, and delete the original in the SAME transaction. `ALREADY_EXISTS` on
 * the create means a redelivery already re-anchored — just delete the original.
 */
async function reanchor(
  db: Firestore,
  conversaId: string,
  originalId: string,
  contaId: string,
  wamid: string,
  originalRaw: unknown,
): Promise<void> {
  const newId = mensagemDocId(contaId, wamid);
  const original = mensagemCollection.parseRead(
    originalRaw,
    mensagemCollection.docPath({ conversaId }, originalId),
  );
  const data = mensagemCollection.parse(
    stripUndefined({
      ...(original as Record<string, unknown>),
      mid: wamid,
      estadoEnvio: ESTADO_ENVIO.enviando,
      lastExternalUpdateDateTime: null,
    }),
  );

  const newRef = mensagemCollection.docRef(db, { conversaId }, newId);
  const oldRef = mensagemCollection.docRef(db, { conversaId }, originalId);
  try {
    await db.runTransaction(async (txn: Transaction) => {
      txn.create(newRef, data);
      txn.delete(oldRef);
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === GRPC_ALREADY_EXISTS) {
      // A redelivery already re-anchored this send → just drop the original.
      await oldRef.delete();
      return;
    }
    throw err;
  }
}

/**
 * Best-effort mark-as-read: acknowledge the newest inbound (`recebido`) message
 * so WhatsApp shows the blue ticks. Marking the latest inbound also marks every
 * earlier one read (Cloud API semantics), so one call covers the conversa — the
 * cheap equivalent of legacy `markAllMessagesAsRead`.
 *
 * Only the GRAPH CALL is best-effort: a `WhatsAppHttpError`/`WhatsAppNetworkError`
 * from `markRead` is warn+continue (the reply already went out). Firestore reads,
 * Zod parses, and the `visualizado` merge below are NOT swallowed — they rethrow so
 * a genuine backend failure surfaces (and the trigger safely retries the no-op).
 * Legacy parity (conversaProvider.dart:1401-1417): on a successful mark-read the
 * inbound doc gets `visualizado` stamped (ISO, like the status pipeline's other
 * datetimes) so the operator UI reflects the read receipt.
 */
async function markReadNewestInbound(
  db: Firestore,
  conversaId: string,
  client: WhatsAppClient,
): Promise<void> {
  const snap = await mensagemCollection
    .ref(db, { conversaId })
    .where('estadoEnvio', '==', ESTADO_ENVIO.recebido)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();
  const first = snap.docs[0];
  if (!first) return;
  const mensagem = mensagemCollection.parseRead(
    first.data(),
    mensagemCollection.docPath({ conversaId }, first.id),
  );
  if (!mensagem.mid) return;

  try {
    await client.markRead(mensagem.mid);
  } catch (err) {
    if (err instanceof WhatsAppHttpError || err instanceof WhatsAppNetworkError) {
      console.warn('[whatsapp] markRead best-effort falhou', { conversaId, message: err.message });
      return;
    }
    throw err;
  }

  await mensagemCollection.merge(db, { conversaId }, first.id, {
    visualizado: new Date().toISOString(),
  });
}

/* ---------------------------------- claim --------------------------------- */

/** Tuning for {@link dispatchOutbound}. */
export interface DispatchOptions {
  /**
   * Also claim a doc already in `enviando` (with `mid == null`). Default `false`:
   * the trigger path treats an `enviando` doc as already-claimed by a concurrent
   * winner and exits ('claimed'). The sweep sets this ONLY for its crashed-claim
   * re-drive pass (an `enviando`/`mid == null` doc left by a crash between claim
   * and re-anchor), accepting the rare duplicate a re-driven send can carry.
   */
  claimEnviando?: boolean;
}

type ClaimResult = { kind: 'claimed' } | { kind: 'skip'; reason: string };

/** Whether a doc in this state (with `mid == null`) may be claimed for sending. */
function isClaimable(estadoEnvio: number, claimEnviando: boolean): boolean {
  return (
    estadoEnvio === ESTADO_ENVIO.salva || (claimEnviando && estadoEnvio === ESTADO_ENVIO.enviando)
  );
}

/**
 * Transactionally CLAIM the outbound send — the atomic guard against a concurrent
 * double-send. Re-reads the ORIGINAL under a transaction and flips `estadoEnvio`
 * salva→enviando ONLY while it is still (`salva` && `mid == null`) — or, when
 * `claimEnviando`, (`enviando` && `mid == null`) for the sweep's crashed-claim
 * re-drive. Concurrent dispatchers serialize on this transaction, so exactly one
 * claims and every loser exits ('claimed' / gone). Runs LAST, right before
 * `performSend`, so the read-only setup (client + spec) can fail transiently
 * WITHOUT mutating the doc (it stays `salva` for a fast trigger-retry).
 */
async function claimOutbound(
  db: Firestore,
  conversaId: string,
  mensagemId: string,
  claimEnviando: boolean,
): Promise<ClaimResult> {
  const ref = mensagemCollection.docRef(db, { conversaId }, mensagemId);
  return db.runTransaction(async (txn: Transaction) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { kind: 'skip', reason: 'mensagem já processada (removida)' };
    const fresh = mensagemCollection.parseRead(
      snap.data(),
      mensagemCollection.docPath({ conversaId }, mensagemId),
    );
    if (fresh.mid != null) return { kind: 'skip', reason: 'mensagem já processada' };
    if (!isClaimable(fresh.estadoEnvio, claimEnviando)) return { kind: 'skip', reason: 'claimed' };
    // Flip to `enviando` (a no-op for an already-`enviando` sweep re-drive).
    txn.set(ref, mensagemCollection.parseMerge({ estadoEnvio: ESTADO_ENVIO.enviando }), {
      merge: true,
    });
    return { kind: 'claimed' };
  });
}

/* ------------------------------- disposition ------------------------------ */

/**
 * Send one outbound `mensagem` to WhatsApp and re-anchor it. Pure + injectable.
 *
 * @param doc the mensagem doc data as delivered by the trigger (the cheap
 *   fast-path seed); the authoritative content is RE-READ + CLAIMED inside a
 *   transaction for idempotency (see {@link claimOutbound}).
 * @param opts `claimEnviando` lets the sweep re-drive a crashed claim.
 */
export async function dispatchOutbound(
  db: Firestore,
  conversaId: string,
  mensagemId: string,
  doc: unknown,
  deps: OutboundDeps = defaultOutboundDeps,
  opts: DispatchOptions = {},
): Promise<OutboundResult> {
  const claimEnviando = opts.claimEnviando ?? false;

  // 1. Cheap fast-path on the delivered snapshot — skip events, errors, inbound
  //    messages and the already-anchored doc WITHOUT touching the conversa. A
  //    doc already in `enviando` is skipped UNLESS the sweep opts into re-driving
  //    a crashed claim (`claimEnviando`).
  const seed = mensagemCollection.parseRead(
    doc,
    mensagemCollection.docPath({ conversaId }, mensagemId),
  );
  if (!isClaimable(seed.estadoEnvio, claimEnviando)) return skip(`estadoEnvio ${seed.estadoEnvio}`);
  if (seed.tipo === 'e' || seed.tipo === '!') return skip(`tipo ${seed.tipo}`);
  if (seed.mid != null) return skip('mid já definido');

  // 2. Parent conversa — only WhatsApp-origem conversas send through here.
  const convSnap = await conversaCollection.docRef(db, {}, conversaId).get();
  if (!convSnap.exists) return skip('conversa inexistente');
  const conversa = conversaCollection.parseRead(
    convSnap.data(),
    conversaCollection.docPath({}, conversaId),
  );
  if (conversa.origem !== 'whatsapp') return skip(`origem ${conversa.origem}`);

  // 3. Recipient + owning account (deterministic gaps → erro, no retry).
  if (!conversa.sender_id) {
    return failMensagem(db, conversaId, mensagemId, 'Conversa sem sender_id — envio impossível.');
  }
  const to = fromNumberFromSenderId(conversa.sender_id);
  if (!to) {
    return failMensagem(db, conversaId, mensagemId, 'sender_id sem número de destino.');
  }
  if (!conversa.integracaoOuterRef) {
    return failMensagem(db, conversaId, mensagemId, 'Conversa sem integracaoOuterRef.');
  }
  const contaId = idFromRef(conversa.integracaoOuterRef);
  if (!contaId) {
    return failMensagem(
      db,
      conversaId,
      mensagemId,
      `integracaoOuterRef inválido: ${conversa.integracaoOuterRef}`,
    );
  }

  // 4. Fresh re-read: the authoritative content + an early skip. This does NOT
  //    mutate — the CLAIM (step 7) is the concurrency guard. Reading before the
  //    read-only setup lets build-client / resolveSendSpec fail transiently while
  //    the doc stays `salva` (a fast trigger-retry, not a 15-min sweep wait).
  const freshSnap = await mensagemCollection.docRef(db, { conversaId }, mensagemId).get();
  if (!freshSnap.exists) return skip('mensagem já processada (removida)');
  const fresh = mensagemCollection.parseRead(
    freshSnap.data(),
    mensagemCollection.docPath({ conversaId }, mensagemId),
  );
  if (fresh.mid != null || !isClaimable(fresh.estadoEnvio, claimEnviando)) {
    return skip('mensagem já processada');
  }
  const freshRaw = freshSnap.data();

  // 5. Build the client (missing token / misconfigured conta → erro, no retry;
  //    a transient Firestore read propagates so the trigger retries).
  let client: WhatsAppClient;
  try {
    const ctx = await deps.loadContext(db, contaId);
    client = await ctx.buildClient();
  } catch (err) {
    if (
      err instanceof WhatsappTokenMissingError ||
      err instanceof WhatsappContaNotConfiguredError
    ) {
      return failMensagem(db, conversaId, mensagemId, err.message);
    }
    throw err;
  }

  // 6. Resolve what to send. Deterministic gaps → erro (terminal); a still-uploading
  //    arquivo (OutboundTransientError) or a transient Firestore read → throw → retry
  //    (the doc is still `salva` here, so the trigger-retry re-drives cleanly).
  let spec: SendSpec;
  try {
    spec = await resolveSendSpec(db, fresh);
  } catch (err) {
    if (err instanceof OutboundSendError) {
      return failMensagem(db, conversaId, mensagemId, err.message);
    }
    throw err; // OutboundTransientError + transient Firestore → Eventarc retries.
  }

  // 7. Transactional CLAIM immediately before sending: atomically flip salva→enviando
  //    (see claimOutbound). A prior success DELETED the original, or a concurrent
  //    dispatcher already claimed it — either way the loser exits here without
  //    sending. This closes the concurrent double-send.
  const claim = await claimOutbound(db, conversaId, mensagemId, claimEnviando);
  if (claim.kind === 'skip') return skip(claim.reason);

  // 8. Transmit. A Graph HTTP failure (WhatsAppHttpError) is terminal → erro (bad
  //    request / auth / permanent); a transport failure (WhatsAppNetworkError) is
  //    transient → RETHROW so the trigger retries; anything else rethrows too. On a
  //    terminal/transient failure the doc is now `enviando`/`mid == null` — the sweep
  //    re-drives the transient case; `failMensagem` moves the terminal case to `erro`.
  let wamid: string;
  try {
    wamid = await performSend(client, to, spec);
  } catch (err) {
    if (err instanceof WhatsAppNetworkError) throw err;
    if (err instanceof WhatsAppHttpError) {
      return failMensagem(db, conversaId, mensagemId, err.message);
    }
    throw err;
  }

  // 9. Re-anchor (transient Firestore → throw → retry) + best-effort mark-read.
  await reanchor(db, conversaId, mensagemId, contaId, wamid, freshRaw);
  await markReadNewestInbound(db, conversaId, client);

  return { kind: 'sent', wamid, mensagemId: mensagemDocId(contaId, wamid) };
}

/* ---------------------------------- sweep --------------------------------- */

/** 10 minutes — a `salva`/`enviando` outbound older than this is considered stuck. */
const STALE_OUTBOUND_MS = 10 * 60 * 1000;

export interface SweepOptions {
  olderThanMs?: number;
  limit?: number;
  now?: number;
}

export interface SweepResult {
  processed: number;
  outcomes: Record<string, number>;
  errors: Array<{ docId: string; message: string }>;
}

/**
 * The `reprocessStaleOutbound` backstop core (the `onSchedule` sweep): re-drive
 * outbound mensagens stuck past the window — a trigger that never fired, threw
 * before patching, or lost its ack. TWO collection-group passes, both older than
 * the cutoff:
 *   - `estadoEnvio == salva`  — a send that never got claimed;
 *   - `estadoEnvio == enviando` — a claim that CRASHED before re-anchoring (left
 *     `enviando`/`mid == null`); re-driven with `claimEnviando` so the claim
 *     re-acquires it. (The `mid == null` part is enforced by the dispatch
 *     fast-path, not the query — an `enviando` doc WITH a `mid` is a normal
 *     re-anchored send awaiting a status callback and is skipped.)
 * Two queries (not an `IN`) so both reuse the composite collection-group index
 * `mensagem(estadoEnvio, timestamp)`. Each candidate re-runs through
 * {@link dispatchOutbound}, whose fast-path drops non-WhatsApp conversas. Bounded +
 * per-doc isolated so one failure never aborts the batch.
 *
 * Enterprise runs the queries unindexed (full scan) without the index; it keeps
 * them cost/latency-bounded on the hot path.
 */
export async function sweepStaleOutbound(
  db: Firestore,
  opts: SweepOptions = {},
  deps: OutboundDeps = defaultOutboundDeps,
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const cutoffIso = new Date(now - (opts.olderThanMs ?? STALE_OUTBOUND_MS)).toISOString();
  const max = opts.limit ?? 50;

  const outcomes: Record<string, number> = {};
  const errors: Array<{ docId: string; message: string }> = [];
  let processed = 0;

  // `salva` = never claimed; `enviando` = claim crashed pre-re-anchor (re-drive it).
  const passes: Array<{ estado: number; claimEnviando: boolean }> = [
    { estado: ESTADO_ENVIO.salva, claimEnviando: false },
    { estado: ESTADO_ENVIO.enviando, claimEnviando: true },
  ];

  // Snapshot BOTH candidate sets up front, BEFORE any dispatch re-anchors a doc —
  // otherwise the `enviando` pass would immediately re-scan the (mid-carrying) doc
  // the `salva` pass just re-anchored.
  const candidates: Array<{
    conversaId: string;
    docId: string;
    data: unknown;
    claimEnviando: boolean;
  }> = [];
  for (const pass of passes) {
    const snap = await mensagemCollection
      .groupQuery(db)
      .where('estadoEnvio', '==', pass.estado)
      .where('timestamp', '<', cutoffIso)
      .orderBy('timestamp')
      .limit(max)
      .get();
    for (const d of snap.docs) {
      const conversaId = d.ref.parent.parent?.id;
      if (!conversaId) continue;
      candidates.push({
        conversaId,
        docId: d.id,
        data: d.data(),
        claimEnviando: pass.claimEnviando,
      });
    }
  }

  for (const c of candidates) {
    try {
      const result = await dispatchOutbound(db, c.conversaId, c.docId, c.data, deps, {
        claimEnviando: c.claimEnviando,
      });
      outcomes[result.kind] = (outcomes[result.kind] ?? 0) + 1;
      processed += 1;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      errors.push({ docId: `${c.conversaId}/${c.docId}`, message: err.message });
    }
  }

  return { processed, outcomes, errors };
}
