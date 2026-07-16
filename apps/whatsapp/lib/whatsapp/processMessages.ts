/**
 * Inbound `messages`-field processor for the WhatsApp Cloud API webhook (#527).
 * Port of `.old/packages/canais_de_venda/whatsapp_cloud_api/lib/src/notificacoes/
 * messages.dart` (lines 15–327 + 474–535): resolve the owning account, find/create
 * the contact, create-or-reopen the `chat` conversa in a transaction, attach the
 * `mensagem` (downloading + caching media), then run the daily auto-reply and the
 * anonymous-name fixup.
 *
 * ── Idempotency (the #527 goal) ────────────────────────────────────────────────
 * Everything is keyed on DETERMINISTIC ids so a redelivered webhook — or a task
 * retry — converges on the same documents instead of forking:
 *  - conversa doc id  = `conversaDocId(contaId, senderId(displayPhone, from))`;
 *  - mensagem doc id  = `mensagemDocId(contaId, message.id)` (the Meta wamid);
 *  - the "nova conversa" event id is fixed (`evento_nova`); a reopen event is
 *    keyed to the triggering wamid (`evento_reaberto_<wamid>`);
 *  - the daily auto-reply is keyed to the UTC day (`autoreply_<kind>_<yyyy-mm-dd>`).
 * A create that loses a race hits ALREADY_EXISTS (gRPC 6) and is ignored.
 *
 * ── Auto-reply outbound contract for PR-3 (#529 sender trigger) ────────────────
 * Legacy SENT the daily auto-reply inline via the Graph API and recorded an
 * event. This pipeline does NOT call the API; instead it WRITES the auto-reply as
 * an OUTBOUND `mensagem` doc and lets PR-3's `onCreate` trigger send it. The
 * marker PR-3 keys on is:
 *
 *     estadoEnvio === ESTADO_ENVIO.salva (1)  AND  tipo !== 'e' (evento)  AND  mid == null
 *
 * i.e. PR-3 sends any freshly-created message in the `salva` state that is not an
 * event and has no wamid yet (an operator's manual reply qualifies identically).
 * Auto-replies are therefore written as `{ estadoEnvio: salva, tipo: 'c', mid: null }`.
 * The lifecycle EVENTS written here (`nova conversa`, `reaberto`) are also `salva`
 * but carry `tipo: 'e'`, so the `tipo !== 'e'` clause keeps PR-3 from sending them.
 * Inbound customer messages are `estadoEnvio: recebido (7)` and never match.
 * After PR-3 sends an outbound doc it MUST stamp `mid = <sendWamid>` and re-anchor
 * the doc id to `mensagemDocId(contaId, sendWamid)` so status callbacks locate it
 * (see processStatus.ts).
 *
 * ── `estaAberto` UTC-hour quirk (models.dart:288-308) ──────────────────────────
 * `Horario_Whatsapp.abertura`/`.fechamento` encode a year-0-anchored LOCAL
 * wall-clock via the schema codec; the legacy `Periodo_Whatsapp.compareHoje`
 * reader converts each to UTC (`.toUtc().hour/.minute`) before building today's
 * open/close instants and comparing to `DateTime.now()`. On the UTC deploy clock
 * (App Hosting / Cloud Run) `decodeHorarioMs` (which reads server-local) yields
 * exactly those `.toUtc()` values, so decoding via the codec + building the
 * comparison with `Date.UTC(...)` reproduces the legacy decision — including the
 * operator-timezone skew (an 08:00 typed by a UTC-3 operator compares as ~11:06).
 * We decode ONLY via `decodeHorarioMs` and never re-derive the ms by hand.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  conversaCollection,
  integracaoCollection,
  mensagemCollection,
} from '@delfrance/data/admin/collections';
import {
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  INTEGRACAO_TIPO,
  decodeHorarioMs,
  podeReabrirConversa,
  toOuterRef,
  type HorarioWhatsapp,
  type Integracao,
  type PeriodoWhatsapp,
  type TipoMensagem,
} from '@delfrance/schemas';
import {
  valuePayloadSchema,
  type IncomingMessage,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { conversaDocId, mensagemDocId, senderId } from './ids';
import { discoverUserByPhoneNumber, fixConversaAnonima, usuarioOuterRef } from './discoverUser';
import { getAndUploadMedia, type MediaCacheContext } from './media';
import { processStatuses } from './processStatus';

/** 24 hours in ms — the conversa prazo window and the auto-reply dedupe threshold. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The media seam. `getAndUploadMedia` needs a Graph client + a Storage bucket
 * bound to the owning account; `mediaContext` resolves that lazily (only when a
 * message actually carries media). Injectable so the unit tests pass a fake.
 */
export interface WhatsappProcessDeps {
  mediaContext(db: Firestore, contaId: string): Promise<MediaCacheContext>;
}

/** Deterministic result of processing a `messages`-field change. */
export type ProcessOutcome =
  | { kind: 'processed'; contaId: string }
  | { kind: 'dropped'; reason: string } // ack, never persist (malformed value)
  | { kind: 'failed'; reason: string }; // persist as `failed`, sweep re-drives

/** Owning-account resolution for an inbound change. */
type ContaResolution =
  | { kind: 'resolved'; contaId: string; conta: Integracao }
  | { kind: 'failed'; reason: string };

/* --------------------------------- helpers -------------------------------- */

/** WhatsApp timestamps are unix SECONDS (webhook.dart:256 `* 1000`). */
function waTimestampToMs(ts: string): number {
  const secs = Number.parseInt(ts, 10);
  return Number.isFinite(secs) ? secs * 1000 : Date.now();
}

/** Coerce a conversa date field (epoch ms int, or a stray legacy ISO string) to epoch ms. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Single-char `tipo` per the inbound media kind. Legacy `createOrUpdateMensagem`
 * hard-coded `comum`; the task derives it: audio→`a`, video→`v`,
 * image/document/sticker→`f` (arquivo), everything else (text/reaction/…)→`c`.
 */
function tipoForMessage(message: IncomingMessage): TipoMensagem {
  if (message.audio) return 'a';
  if (message.video) return 'v';
  if (message.image || message.document || message.sticker) return 'f';
  return 'c';
}

/* ------------------------------ conta lookup ------------------------------ */

/**
 * Resolve the owning `integracao` (WhatsApp) account by
 * `wa_id == metadata.phone_number_id` — the legacy quirk (`wa_id` actually holds
 * the phone-number id; see the integracao schema). `limit(2)`: exactly one →
 * resolved; zero (account not linked yet — sweep re-drives when it connects) or
 * more than one (ambiguous) → `failed` PARK.
 */
export async function resolveConta(db: Firestore, phoneNumberId: string): Promise<ContaResolution> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.whatsapp)
    .where('wa_id', '==', phoneNumberId)
    .limit(2)
    .get();
  if (snap.docs.length === 1) {
    const doc = snap.docs[0]!;
    return {
      kind: 'resolved',
      contaId: doc.id,
      conta: integracaoCollection.parseRead(doc.data(), integracaoCollection.docPath({}, doc.id)),
    };
  }
  if (snap.docs.length > 1) {
    return {
      kind: 'failed',
      reason: `múltiplas contas WhatsApp com wa_id ${phoneNumberId}`,
    };
  }
  return {
    kind: 'failed',
    reason: `conta WhatsApp com wa_id ${phoneNumberId} não encontrada`,
  };
}

/* --------------------------- messages dispatcher -------------------------- */

/**
 * Process one `messages`-field change end-to-end (the `WEBHOOK_FIELD_MESSAGES`
 * case). Malformed value → `dropped`; unlinked/ambiguous account → `failed` PARK;
 * a transient Firestore / Graph failure PROPAGATES (throws) so the queue retries.
 */
export async function processMessagesField(
  db: Firestore,
  rawValue: unknown,
  deps: WhatsappProcessDeps,
): Promise<ProcessOutcome> {
  const parsed = valuePayloadSchema.safeParse(rawValue);
  if (!parsed.success) {
    return { kind: 'dropped', reason: 'payload de mensagens malformado' };
  }
  const value = parsed.data;
  const phoneNumberId = value.metadata.phone_number_id;

  const resolution = await resolveConta(db, phoneNumberId);
  if (resolution.kind === 'failed') {
    console.error('[whatsapp] conta não resolvida — parking', {
      phoneNumberId,
      reason: resolution.reason,
    });
    return { kind: 'failed', reason: resolution.reason };
  }
  const { contaId, conta } = resolution;

  // Legacy `_processarMensagens`: when a change ALSO carries `statuses`, the
  // `messages` are treated as an outbound echo — the conversa is still touched,
  // but no mensagem/auto-reply/fixup runs.
  const incoming = value.statuses == null;

  if (value.messages) {
    for (const message of value.messages) {
      await processInboundMessage(db, deps, { contaId, conta, value, message, incoming });
    }
  }
  if (value.statuses) {
    await processStatuses(db, contaId, value);
  }

  return { kind: 'processed', contaId };
}

/* ---------------------------- inbound one message ------------------------- */

interface InboundArgs {
  contaId: string;
  conta: Integracao;
  value: ReturnType<typeof valuePayloadSchema.parse>;
  message: IncomingMessage;
  incoming: boolean;
}

async function processInboundMessage(
  db: Firestore,
  deps: WhatsappProcessDeps,
  { contaId, conta, value, message, incoming }: InboundArgs,
): Promise<void> {
  const displayPhone = value.metadata.display_phone_number;
  const from = message.from;
  const timestampMs = waTimestampToMs(message.timestamp);
  const prazoMs = timestampMs + DAY_MS;

  const fromName = value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? null;
  const user = await discoverUserByPhoneNumber(db, from, fromName);

  const sender = senderId(displayPhone, from);
  const conversaId = conversaDocId(contaId, sender);

  const { skipMensagem, conversaNome } = await upsertConversa(db, {
    contaId,
    conta,
    conversaId,
    sender,
    from,
    phoneNumberId: value.metadata.phone_number_id,
    userName: user.usuario.nome,
    userId: user.id,
    timestampMs,
    prazoMs,
    wamid: message.id,
  });

  // Outbound echo (statuses present) or a spam conversa → no mensagem, no reply.
  if (!incoming || skipMensagem) return;

  await createOrUpdateMensagem(db, deps, {
    contaId,
    conversaId,
    userId: user.id,
    message,
    timestampMs,
  });

  await enviarMsgAutomatica(db, conta, conversaId, from);

  // Best-effort (legacy caught + logged the same way): a failure here never
  // blocks message ingestion.
  try {
    await fixConversaAnonima(db, conversaId, { nome: conversaNome }, user);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error('[whatsapp] fixConversaAnonima falhou', { message: err.message });
  }
}

/* --------------------------- conversa create/reopen ----------------------- */

interface UpsertArgs {
  contaId: string;
  conta: Integracao;
  conversaId: string;
  sender: string;
  from: string;
  phoneNumberId: string;
  userName: string;
  userId: string;
  timestampMs: number;
  prazoMs: number;
  wamid: string;
}

/**
 * Transactionally create-or-reopen the conversa (messages.dart:63-141).
 *  - absent  → create per the legacy field list + a `Nova conversa` event;
 *  - spam    → skip the whole message (return `skipMensagem: true`);
 *  - out-of-order (timestamp ≤ ultimaModificacaoIntegracao) → no conversa update,
 *    but the mensagem is still written (return `skipMensagem: false`);
 *  - reopenable state → naoRespondido + fresh 24h prazo + a `reaberto` event.
 */
async function upsertConversa(
  db: Firestore,
  args: UpsertArgs,
): Promise<{ skipMensagem: boolean; conversaNome: string }> {
  const convRef = conversaCollection.docRef(db, {}, args.conversaId);

  return db.runTransaction(async (txn: Transaction) => {
    const snap = await txn.get(convRef);

    if (!snap.exists) {
      const data = conversaCollection.parse({
        atendido: false,
        data_cadastro: args.timestampMs,
        ultimaModificacaoIntegracao: args.timestampMs,
        origem: 'whatsapp',
        sender_id: args.sender,
        nome: args.userName,
        usarioOuterRef: usuarioOuterRef(args.userId),
        integracaoOuterRef: `documents/integracao/${args.contaId}`,
        id: args.phoneNumberId,
        prazo_resposta: args.prazoMs,
        cor_etiqueta: args.conta.cor ?? 0,
        externalLink: `https://api.whatsapp.com/send?phone=${args.from}`,
        estadoConversa: ESTADO_CONVERSA.naoRespondido,
      });
      txn.set(convRef, data);
      writeEvent(db, txn, args.conversaId, 'evento_nova', {
        conteudo: `Nova conversa iniciada por ${args.userName}.`,
        timestampMs: args.timestampMs,
      });
      return { skipMensagem: false, conversaNome: args.userName };
    }

    const existing = conversaCollection.parseRead(
      snap.data(),
      conversaCollection.docPath({}, args.conversaId),
    );

    if (existing.estadoConversa === ESTADO_CONVERSA.spam) {
      return { skipMensagem: true, conversaNome: existing.nome };
    }

    const lastMod = toEpochMs(existing.ultimaModificacaoIntegracao);
    const shouldUpdate = lastMod == null || args.timestampMs > lastMod;
    if (!shouldUpdate) {
      // Stale/out-of-order: leave the conversa untouched, still write the mensagem.
      return { skipMensagem: false, conversaNome: existing.nome };
    }

    if (podeReabrirConversa(existing.estadoConversa)) {
      const patch = conversaCollection.parseMerge({
        ultimaModificacaoIntegracao: args.timestampMs,
        estadoConversa: ESTADO_CONVERSA.naoRespondido,
        prazo_resposta: args.prazoMs,
      });
      txn.set(convRef, patch, { merge: true });
      writeEvent(db, txn, args.conversaId, `evento_reaberto_${args.wamid}`, {
        conteudo: `Atendimento do ${args.userName} reaberto automaticamente após nova mensagem do cliente.`,
        timestampMs: args.timestampMs,
      });
    }
    // In-order + NOT reopenable (e.g. emResposta): legacy assigns
    // ultimaModificacaoIntegracao in memory but never `.save()`s on this branch
    // (messages.dart:133-135) — the stored guard FREEZES until the next
    // create/reopen write. That no-save quirk is load-bearing: it is what lets
    // a late out-of-order customer message still reopen a since-finalized
    // ticket. Persisting the guard here would silently change the reopen
    // semantics, so we deliberately write NOTHING (parity over tidiness).

    return { skipMensagem: false, conversaNome: existing.nome };
  });
}

/** Write a lifecycle event mensagem (tipo `e`) inside the conversa transaction. */
function writeEvent(
  db: Firestore,
  txn: Transaction,
  conversaId: string,
  eventoId: string,
  { conteudo, timestampMs }: { conteudo: string; timestampMs: number },
): void {
  const data = mensagemCollection.parse({
    estadoEnvio: ESTADO_ENVIO.salva, // salva, but tipo 'e' keeps PR-3 from sending it
    tipo: 'e',
    conteudo,
    data_cadastro: timestampMs,
    timestamp: timestampMs,
  });
  txn.set(mensagemCollection.docRef(db, { conversaId }, eventoId), data);
}

/* ----------------------------- mensagem upsert ---------------------------- */

interface MensagemArgs {
  contaId: string;
  conversaId: string;
  userId: string;
  message: IncomingMessage;
  timestampMs: number;
}

/**
 * Create-or-update the inbound mensagem (messages.dart:204-327). Dedup by the
 * deterministic doc id + timestamp: an existing doc at/after this timestamp is a
 * redelivery → skip. Media is downloaded + cached into the typed schema
 * sub-objects; context/reaction/referral are mapped to the mensagem fields.
 */
async function createOrUpdateMensagem(
  db: Firestore,
  deps: WhatsappProcessDeps,
  { contaId, conversaId, userId, message, timestampMs }: MensagemArgs,
): Promise<void> {
  const msgId = mensagemDocId(contaId, message.id);
  const msgRef = mensagemCollection.docRef(db, { conversaId }, msgId);

  const oldSnap = await msgRef.get();
  let dataCadastroMs = timestampMs;
  if (oldSnap.exists) {
    const old = mensagemCollection.parseRead(
      oldSnap.data(),
      mensagemCollection.docPath({ conversaId }, msgId),
    );
    const oldTs = toEpochMs(old.timestamp);
    if (oldTs != null && oldTs >= timestampMs) return; // same or newer → idempotent skip
    // Preserve the original create time across an update (keep-old-value); the
    // codec tolerates a stray ISO value on the stored field via `toEpochMs`.
    const oldCadastro = toEpochMs(old.data_cadastro);
    if (oldCadastro != null) dataCadastroMs = oldCadastro;
  }

  // Media — resolve the account's Graph client + bucket only when needed.
  let ctx: MediaCacheContext | null = null;
  const mediaCtx = async (): Promise<MediaCacheContext> =>
    (ctx ??= await deps.mediaContext(db, contaId));

  const fields: Record<string, unknown> = {
    estadoEnvio: ESTADO_ENVIO.recebido,
    tipo: tipoForMessage(message),
    conteudo: message.text?.body ?? null,
    user_id: userId,
    usarioMensagemOuterRef: usuarioOuterRef(userId),
    mid: message.id,
    midGroup: msgId,
    data_cadastro: dataCadastroMs,
    timestamp: timestampMs,
  };

  if (message.image) {
    fields.image = {
      image: await getAndUploadMedia(await mediaCtx(), message.image.id),
      caption: message.image.caption ?? null,
    };
  }
  if (message.video) {
    fields.video = {
      video: await getAndUploadMedia(await mediaCtx(), message.video.id),
      caption: message.video.caption ?? null,
    };
  }
  if (message.audio) {
    fields.audio = { audio: await getAndUploadMedia(await mediaCtx(), message.audio.id) };
  }
  if (message.sticker) {
    const raw = message.sticker as Record<string, unknown>;
    fields.sticker = {
      sticker: await getAndUploadMedia(await mediaCtx(), message.sticker.id),
      animated: typeof raw.animated === 'boolean' ? raw.animated : false,
      caption: message.sticker.caption ?? null,
    };
  }
  if (message.document) {
    fields.genericDocument = {
      genericDocument: await getAndUploadMedia(await mediaCtx(), message.document.id),
      caption: message.document.caption ?? null,
    };
  }

  const context = await mapContext(db, conversaId, contaId, message);
  if (context) fields.context = context;
  const reaction = await mapReaction(db, conversaId, contaId, message);
  if (reaction) fields.reaction = reaction;
  const referral = mapReferral(message);
  if (referral) fields.referral = referral;

  await msgRef.set(mensagemCollection.parse(fields));
}

/** The `documents/chat/<c>/mensagem/<m>` outer ref of a prior message doc. */
function mensagemOuterRef(conversaId: string, msgId: string): string {
  return toOuterRef(`chat/${conversaId}/mensagem/${msgId}`);
}

/** Whether a prior mensagem exists at the deterministic id for `wamid`. */
async function priorMensagemRef(
  db: Firestore,
  conversaId: string,
  contaId: string,
  wamid: string,
): Promise<string | null> {
  const priorId = mensagemDocId(contaId, wamid);
  const snap = await mensagemCollection.docRef(db, { conversaId }, priorId).get();
  return snap.exists ? mensagemOuterRef(conversaId, priorId) : null;
}

async function mapContext(
  db: Firestore,
  conversaId: string,
  contaId: string,
  message: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  if (!message.context) return null;
  const raw = message.context as Record<string, unknown>;
  const contextId = typeof raw.id === 'string' ? raw.id : null;
  const forwarded = typeof raw.forwarded === 'boolean' ? raw.forwarded : null;
  const frequentlyForwarded =
    typeof raw.frequently_forwarded === 'boolean' ? raw.frequently_forwarded : null;

  const out: Record<string, unknown> = {};
  let observacao: string | null = null;
  if (contextId) {
    const ref = await priorMensagemRef(db, conversaId, contaId, contextId);
    if (ref) out.mensagemOuterRef = ref;
    else {
      const fromPart = typeof raw.from === 'string' ? ` de ${raw.from}` : '';
      observacao = `Mensagem de contexto com id ${contextId}${fromPart} não encontrada na database.`;
    }
  }
  if (observacao) out.observacao = observacao;
  if (forwarded != null) out.forwarded = forwarded;
  if (frequentlyForwarded != null) out.frequently_forwarded = frequentlyForwarded;
  return out;
}

async function mapReaction(
  db: Firestore,
  conversaId: string,
  contaId: string,
  message: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  if (!message.reaction) return null;
  const contextId = message.reaction.message_id ?? null;
  const out: Record<string, unknown> = { emoji: message.reaction.emoji ?? '' };
  if (contextId) {
    const ref = await priorMensagemRef(db, conversaId, contaId, contextId);
    if (ref) out.mensagemOuterRef = ref;
    else out.observacao = `Mensagem de reação com id ${contextId} não encontrada na database.`;
  } else {
    out.observacao = 'Mensagem de reação sem message_id.';
  }
  return out;
}

function mapReferral(message: IncomingMessage): Record<string, unknown> | null {
  const r = message.referral;
  if (!r) return null;
  return {
    source_url: r.source_url ?? null,
    source_type: r.source_type ?? null,
    source_id: r.source_id ?? null,
    headline: r.headline ?? null,
    body: r.body ?? null,
    media_type: r.media_type ?? null,
    image_url: r.image_url ?? null,
    video_url: r.video_url ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    ctwa_clid: r.ctwa_clid ?? null,
  };
}

/* ------------------------------- auto-reply ------------------------------- */

/**
 * Daily auto-reply (messages.dart:474-535). Sends `mensagem_automatica` in
 * business hours, else `mensagem_inatividade`, at most once per UTC day per
 * conversa — deduped via the conversa's `recebido_durante_atendimento` /
 * `recebido_fora_atendimento` date fields (a full 24h since the last, legacy
 * `.inDays >= 1`). Writes the reply as an OUTBOUND doc for PR-3 (see the file
 * header's contract), not an inline Graph send.
 */
async function enviarMsgAutomatica(
  db: Firestore,
  conta: Integracao,
  conversaId: string,
  to: string,
): Promise<void> {
  void to; // recipient is derived by PR-3 from the conversa; kept for signature parity
  if (!conta.horario_funcionamento) return;

  const now = new Date();
  const aberto = estaAberto(conta, now);

  const convSnap = await conversaCollection.docRef(db, {}, conversaId).get();
  if (!convSnap.exists) return;
  const conversa = conversaCollection.parseRead(
    convSnap.data(),
    conversaCollection.docPath({}, conversaId),
  );

  if (conta.mensagem_inatividade && !aberto) {
    const last = toEpochMs(conversa.recebido_fora_atendimento);
    if (last == null || now.getTime() - last >= DAY_MS) {
      await writeAutoReply(db, conversaId, conta.mensagem_inatividade, now, 'fora');
      await conversaCollection.merge(db, {}, conversaId, {
        recebido_fora_atendimento: now.getTime(),
      });
    }
  } else if (conta.mensagem_automatica && aberto) {
    const last = toEpochMs(conversa.recebido_durante_atendimento);
    if (last == null || now.getTime() - last >= DAY_MS) {
      await writeAutoReply(db, conversaId, conta.mensagem_automatica, now, 'dentro');
      await conversaCollection.merge(db, {}, conversaId, {
        recebido_durante_atendimento: now.getTime(),
      });
    }
  }
}

/** Write the outbound auto-reply doc (idempotent per UTC day). */
async function writeAutoReply(
  db: Firestore,
  conversaId: string,
  texto: string,
  now: Date,
  kind: 'dentro' | 'fora',
): Promise<void> {
  const dayKey = now.toISOString().slice(0, 10); // yyyy-mm-dd (UTC) — a doc-id key, not a datetime field
  const id = `autoreply_${kind}_${dayKey}`;
  const data = mensagemCollection.parse({
    estadoEnvio: ESTADO_ENVIO.salva, // salva + tipo 'c' → PR-3 sends it
    tipo: 'c',
    conteudo: texto,
    data_cadastro: now.getTime(),
    timestamp: now.getTime(),
  });
  try {
    await mensagemCollection.docRef(db, { conversaId }, id).create(data);
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === 6) return; // already sent today
    throw err;
  }
}

/* ------------------------------- estaAberto ------------------------------- */

/**
 * Whether the account is within business hours right now — port of
 * `Conta_Whatsapp.estaAberto` (any open `Periodo_Whatsapp` for today ⇒ open).
 * Reproduces the `compareHoje` UTC quirk (see the file header).
 */
export function estaAberto(conta: Integracao, now: Date = new Date()): boolean {
  const periodos = conta.horario_funcionamento;
  if (!periodos) return false;
  for (const periodo of periodos) {
    const horario = horarioForWeekday(periodo, now.getUTCDay());
    if (horario && compareHoje(horario, now)) return true;
  }
  return false;
}

const WEEKDAY_KEYS: readonly (keyof PeriodoWhatsapp)[] = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
];

function horarioForWeekday(periodo: PeriodoWhatsapp, utcDay: number): HorarioWhatsapp | null {
  const key = WEEKDAY_KEYS[utcDay];
  if (!key) return null;
  return periodo[key] ?? null;
}

/**
 * `Periodo_Whatsapp.compareHoje` (models.dart:288-308): decode the stored
 * abertura/fechamento to a wall clock via the codec, build today's open/close
 * instants in UTC, and test that now is strictly between them. Decoding on the
 * UTC deploy clock matches the legacy `.toUtc().hour/.minute` read exactly.
 */
function compareHoje(horario: HorarioWhatsapp, now: Date): boolean {
  const open = decodeHorarioMs(horario.abertura);
  const close = decodeHorarioMs(horario.fechamento);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const openMs = Date.UTC(y, m, d, open.hour, open.minute);
  const closeMs = Date.UTC(y, m, d, close.hour, close.minute);
  const nowMs = now.getTime();
  return openMs < nowMs && closeMs > nowMs;
}
