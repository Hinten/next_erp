/**
 * Inbound WhatsApp processing. Identity claims resolve the ERP cliente and a
 * transactional integration + cliente reservation selects its canonical chat.
 * Unknown contacts retain messages/media for explicit operator identification.
 * Message IDs remain deterministic on integration + wamid; no usuario is created.
 * The one-time migration imports claims for old chats before writers start.
 *
 * ── `ultima_modificacao` recency bump ──────────────────────────────────────────
 * A real inbound message stamps the conversa's `ultima_modificacao` so it
 * resurfaces in an `ultima_modificacao desc` list — the recency behavior legacy
 * Flutter got by stamping the field on every `.save()` (including from its webchat
 * widget, per visitor message — that widget was never ported, so WhatsApp is the only
 * live producer now). The create/reopen paths stamp it inside their txn; every
 * other real-inbound path (in-order-non-reopenable, out-of-order) uses a
 * separate MONOTONIC guarded merge (`bumpUltimaModificacao`) that never moves it
 * backwards on an out-of-order redelivery. The daily auto-reply bumps it with
 * its own timestamp. `ultimaModificacaoIntegracao` and `processStatus` are left
 * untouched — a status tick does not resurface a conversa (legacy parity).
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
import { isDeepStrictEqual } from 'node:util';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  conversaCollection,
  integracaoCollection,
  mensagemCollection,
  whatsappMensagemCollection,
  whatsappVinculoCollection,
  whatsappVinculoMensagemCollection,
  whatsappConversaCollection,
  clienteCollection,
} from '@delfrance/data/admin/collections';
import {
  TIPO_MENSAGEM,
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  INTEGRACAO_TIPO,
  ORIGEM_CONVERSA,
  decodeHorarioMs,
  podeReabrirConversa,
  toOuterRef,
  toOuterRefOrNull,
  type HorarioWhatsapp,
  type Integracao,
  type PeriodoWhatsapp,
  type TipoMensagem,
  type WhatsappDestino,
  mesmoDestinoWhatsapp,
  idFromRef,
} from '@delfrance/schemas';
import {
  valuePayloadSchema,
  type IncomingMessage,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { normalizeTelefoneInternacional } from '@delfrance/core/phone';
import { type ContaIdLookup, readContaIdByWaId, readWhatsappConta } from './contaCache';
import { mensagemDocId } from './ids';
import {
  identidadesDoContato,
  conversaWhatsappKey,
  resolverContatoWhatsapp,
  aplicarTransicaoWhatsapp,
  WhatsappVinculoConflitoError,
  type ContatoWhatsapp,
} from './contatos';
import { guardarContatoPendente } from './vinculos';
import { getAndUploadMedia, type MediaCacheContext } from './media';
import { processStatuses, type StatusesReport } from './processStatus';

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

/** Internal replay authority, supplied only by the retained-contact replay worker. */
export interface HistoricoManualRetido {
  vinculoId: string;
  revision: number;
}

/**
 * What ONE inbound message did. Every value is an existing branch of
 * `processInboundMessage` — nothing here is invented for the log.
 */
type InboundMessageOutcome =
  | 'mensagem' // the mensagem was written or updated
  | 'redelivery' // an existing mensagem at/after this timestamp — idempotent skip
  | 'echo' // outbound echo (the change also carries `statuses`) — conversa only
  | 'spam'
  | 'pending'
  | 'unidentified';

/**
 * What the whole `messages`-field change did.
 *
 * ⚠️ `processed` is a DISPOSITION, not an assertion that work happened: a change
 * carrying neither `messages` nor `statuses` resolves to it having written
 * nothing at all, and so does a redelivery of a message already stored. Without
 * this field they are indistinguishable in the logs — the blind spot that cost a
 * full day on Mercado Livre's first live run (#1087, fixed for ML in #1136).
 *
 * ⚠️ Typed as the narrow union, not `string`, ON PURPOSE — `TaskResult.detail`
 * widens it for the log, and that widening would otherwise let a renamed or
 * dropped member compile everywhere in silence.
 *
 * ⚠️ These name what happened to the MENSAGEM, not whether anything was written
 * at all: `upsertConversa` runs BEFORE the `echo` and `spam` returns, so every
 * value except `statuses` and `vazio` implies the conversa was created, reopened
 * or touched.
 *
 * The `statuses` half of that gap is CLOSED: `StatusesReport` rides out beside
 * `detail` whichever arm of the chain wins, so an `echo` no longer hides the
 * status work and a `statuses` that applied nothing no longer overstates.
 *
 * What REMAINS, deliberately: `redelivery` names the mensagem skip while the same
 * run may have reopened the conversa and bumped `ultima_modificacao`. It stays
 * unreported because of the rule the statuses report is an instance of —
 * **report in the log what leaves no other trace**. A soft-missed status writes
 * NOTHING but a `console.warn`, which is why it earned a field; the conversa
 * story writes its own documents (`evento_nova`, `evento_reaberto_<wamid>`, a
 * moved `estadoConversa`/`prazo_resposta`) and is derivable from `detail` besides
 * — `conversaTocada === (detail ∉ {statuses, vazio})`. A field that is a pure
 * function of another field on the same line makes the line longer, not the
 * operator wiser. This is a recorded decision, not an open TODO.
 */
export type MessagesFieldOutcome =
  // >= 1 inbound mensagem written or updated.
  | 'mensagens'
  // Messages present, every one an idempotent mensagem skip. The conversa may
  // still have been reopened + bumped on this same run.
  | 'redelivery'
  // Messages present, every one suppressed by the spam-conversa guard — but
  // `upsertConversa` already ran.
  | 'spam'
  // Outbound echo (the change also carries `statuses`): the conversa was
  // touched and the statuses WERE applied; no mensagem was written.
  | 'echo'
  // No `messages` key at all; a `statuses[]` batch ran. ⚠️ Says nothing about
  // whether any of them LANDED — that is what the `StatusesReport` beside it is
  // for, and it is the whole reason this member is no longer an overstatement.
  | 'statuses'
  // NEITHER present — nothing happened at all.
  | 'vazio';

/**
 * Why a change was acked without processing. Low-cardinality on purpose — a
 * `drop` persists NOTHING in either phase, so this log line is the only record
 * the delivery ever arrived, and the free-text `reason` beside it is not
 * filterable.
 */
export type DropOutcome =
  | 'campo-nao-suportado' // a field other than `messages`
  | 'value-malformado'; // the `messages` value failed `valuePayloadSchema`

/**
 * What a `messages[]` batch could not even look at.
 *
 * ⚠️ The counterpart to {@link StatusesReport}, and a COUNT for the same reason:
 * one batch can carry entries with different fates, which a single `detail`
 * enum value structurally cannot express.
 *
 * Only one field, and deliberately so — every OTHER fate a message can meet is
 * already named by `MessagesFieldOutcome` (`mensagens`, `redelivery`, `spam`,
 * `echo`). What had no name was the entry that never became an
 * `InboundMessageOutcome` at all because it failed `incomingMessageSchema` and
 * arrived as `null` (the `.nullable().catch(null)` on the array element).
 * Element tolerance without this counter would turn a loud whole-delivery drop
 * into a silent per-element one — visible data loss traded for invisible.
 */
export interface MensagensReport {
  /** Entries that failed `incomingMessageSchema`. Also `console.warn`ed. */
  malformados: number;
}

/** Deterministic result of processing a `messages`-field change. */
export type ProcessOutcome =
  | {
      kind: 'processed';
      contaId: string;
      detail: MessagesFieldOutcome;
      /**
       * What the `messages[]` batch could not read, or null when the change
       * carried no `messages` key at all. Required-and-nullable for the same
       * reason as `statuses` below.
       */
      mensagens: MensagensReport | null;
      /**
       * What the `statuses[]` batch did, or null when the change carried no
       * `statuses` key at all.
       *
       * ⚠️ Required-and-nullable rather than optional ON PURPOSE: it makes the
       * compiler force every `processed` return path to DECIDE the value, so
       * "absent means there were no statuses" is a fact rather than a convention
       * — and the projection's structural `in` check narrows it in one step.
       */
      statuses: StatusesReport | null;
    }
  | { kind: 'dropped'; reason: string; detail: DropOutcome } // ack, never persist
  // ⚠️ No `detail` here, and that asymmetry is the rule rather than an omission:
  // a `fail` WRITES a Firestore document carrying the whole `reason` as `erro`,
  // so the record already exists. `done` and `dropped` persist nothing, which is
  // why only those two need a filterable token in the log.
  | { kind: 'parked'; reason: string }
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
  if (message.type === 'system') return TIPO_MENSAGEM.evento;
  if (message.audio) return TIPO_MENSAGEM.audio;
  if (message.video) return TIPO_MENSAGEM.video;
  if (message.image || message.document || message.sticker) return TIPO_MENSAGEM.arquivo;
  return TIPO_MENSAGEM.comum;
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
  // `phoneNumberId` is the only variable predicate — `tipo == whatsapp` is
  // constant — so it alone keys the entry. The lookup caches the account ID and
  // the document comes from the shared reader, so one document is one entry with
  // one clock (and a self-write can actually reach it). A `none`/`many` outcome
  // is never cached; see `contaCache.ts`.
  const found = await readContaIdByWaId(phoneNumberId, () => queryContaId(db, phoneNumberId));
  if (found.kind === 'many') {
    return { kind: 'failed', reason: `múltiplas contas WhatsApp com wa_id ${phoneNumberId}` };
  }
  if (found.kind === 'none') {
    return { kind: 'failed', reason: `conta WhatsApp com wa_id ${phoneNumberId} não encontrada` };
  }

  // Splitting the query into id-then-document opens a window the single query did
  // not have: the account can be deleted, or have its tipo changed, between the
  // two. Guard it rather than hand a caller a half-resolved account.
  const conta = await readWhatsappConta(db, found.contaId);
  if (conta == null || conta.tipo !== INTEGRACAO_TIPO.whatsapp) {
    return { kind: 'failed', reason: `conta WhatsApp com wa_id ${phoneNumberId} não encontrada` };
  }
  return { kind: 'resolved', contaId: found.contaId, conta };
}

async function queryContaId(db: Firestore, phoneNumberId: string): Promise<ContaIdLookup> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.whatsapp)
    .where('wa_id', '==', phoneNumberId)
    .limit(2)
    .get();
  if (snap.docs.length === 1) return { kind: 'one', contaId: snap.docs[0]!.id };
  return snap.docs.length > 1 ? { kind: 'many' } : { kind: 'none' };
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
  sourceNotificationId: string | null = null,
  historicoManualRetido?: HistoricoManualRetido,
): Promise<ProcessOutcome> {
  const parsed = valuePayloadSchema.safeParse(rawValue);
  if (!parsed.success) {
    return {
      kind: 'dropped',
      reason: 'payload de mensagens malformado',
      detail: 'value-malformado',
    };
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

  // Fold the per-message outcomes most-work-first, so the reported value is the
  // strongest claim the change can actually support.
  const seen = new Set<InboundMessageOutcome>();
  // Null when the change carried no `messages` key at all — a different fact
  // from "it carried some and none of them was malformed", which is `{ 0 }`.
  let mensagens: MensagensReport | null = null;
  if (value.messages) {
    const report: MensagensReport = { malformados: 0 };
    for (let i = 0; i < value.messages.length; i++) {
      const message = value.messages[i];
      // The entry failed `incomingMessageSchema`. Scoped to itself by the
      // array's `.nullable().catch(null)`, so its good siblings — and the
      // `statuses[]` in the same change — still run. Counted, never silent.
      if (message == null) {
        console.warn('[whatsapp] mensagem ignorada — entrada malformada', { indice: i });
        report.malformados += 1;
        continue;
      }
      seen.add(
        await processInboundMessage(db, deps, {
          contaId,
          conta,
          value,
          message,
          incoming,
          sourceNotificationId,
          historicoManualRetido,
        }),
      );
    }
    if (seen.has('unidentified')) report.malformados += 1;
    mensagens = report;
  }
  const statuses = value.statuses ? await processStatuses(db, contaId, value) : null;

  // `echo` outranks `statuses` here: a change carrying BOTH keys sets
  // `incoming = false`, so every message folds to `echo`. That used to HIDE the
  // statuses work; it no longer does — the report above rides out beside `detail`
  // whichever arm wins, which is why this chain did not have to be reshuffled.
  const detail: MessagesFieldOutcome = seen.has('mensagem')
    ? 'mensagens'
    : seen.has('redelivery')
      ? 'redelivery'
      : seen.has('spam')
        ? 'spam'
        : seen.has('echo')
          ? 'echo'
          : // No messages in the change at all. `statuses` is the only other
            // thing this field can carry, so its absence means the change moved
            // nothing — an errors-only body, say. That is a real outcome and it
            // must not read as a processed message.
            value.statuses
            ? 'statuses'
            : 'vazio';

  // ⚠️ A change whose `messages[]` were ALL malformed folds to `statuses`/`vazio`
  // here, because no entry ever produced an `InboundMessageOutcome`. That is not
  // an overstatement and needs no seventh member: `mensagens.malformados` rides
  // out beside `detail` and says so — the same division of labour that lets
  // `statuses` mean "a batch ran" without claiming any of it landed.
  if (seen.has('pending'))
    return {
      kind: 'parked',
      reason: 'Contato aguardando vínculo com cliente; mensagens e anexos retidos.',
    };
  return { kind: 'processed', contaId, detail, mensagens, statuses };
}

/* ---------------------------- inbound one message ------------------------- */

interface InboundArgs {
  contaId: string;
  conta: Integracao;
  value: ReturnType<typeof valuePayloadSchema.parse>;
  message: IncomingMessage;
  incoming: boolean;
  sourceNotificationId: string | null;
  historicoManualRetido?: HistoricoManualRetido;
}

type ClienteConversaReplay = { clienteId: string; conversaId: string };
type ValidarReplay = (tx: Transaction, planned?: ClienteConversaReplay) => Promise<void>;

/** The same proof is checked before processing and inside EVERY replay write transaction. */
async function validarHistoricoManualRetido(
  db: Firestore,
  tx: Transaction,
  authority: HistoricoManualRetido,
  contaId: string,
  message: IncomingMessage,
  expected?: ClienteConversaReplay,
): Promise<ClienteConversaReplay> {
  const pending = await tx.get(whatsappVinculoCollection.docRef(db, {}, authority.vinculoId));
  const binding = pending.data();
  if (
    !pending.exists ||
    typeof binding?.decididoPor !== 'string' ||
    !binding.decididoPor ||
    binding.revision !== authority.revision ||
    !['recuperando', 'erro'].includes(String(binding.estado)) ||
    binding.integracaoId !== contaId ||
    typeof binding.clienteId !== 'string' ||
    !binding.clienteId ||
    typeof binding.conversaId !== 'string' ||
    !binding.conversaId ||
    (expected != null &&
      (binding.clienteId !== expected.clienteId || binding.conversaId !== expected.conversaId))
  )
    throw new WhatsappVinculoConflitoError(
      'A decisão de vínculo mudou. Recarregue o contato antes de recuperar o histórico.',
    );
  const { clienteId, conversaId } = binding;
  const [retained, chat, canonical, cliente, integration] = await Promise.all([
    tx.get(
      whatsappVinculoMensagemCollection.docRef(
        db,
        { vinculoId: authority.vinculoId },
        mensagemDocId(contaId, message.id),
      ),
    ),
    tx.get(conversaCollection.docRef(db, {}, conversaId)),
    tx.get(whatsappConversaCollection.docRef(db, {}, conversaWhatsappKey(contaId, clienteId))),
    tx.get(clienteCollection.docRef(db, {}, clienteId)),
    tx.get(integracaoCollection.docRef(db, {}, contaId)),
  ]);
  const stored = valuePayloadSchema.safeParse(retained.data()?.value);
  const retainedMessage = stored.success
    ? stored.data.messages?.find((item) => item?.id === message.id)
    : null;
  if (
    !retained.exists ||
    retained.data()?.processada !== false ||
    !isDeepStrictEqual(retainedMessage, message) ||
    !cliente.exists ||
    !integration.exists ||
    integration.data()?.tipo !== INTEGRACAO_TIPO.whatsapp ||
    !chat.exists ||
    chat.data()?.origem !== ORIGEM_CONVERSA.whatsapp ||
    toOuterRefOrNull(chat.data()?.clienteOuterRef) !==
      toOuterRefOrNull(clienteCollection.docPath({}, clienteId)) ||
    toOuterRefOrNull(chat.data()?.integracaoOuterRef) !==
      toOuterRefOrNull(integracaoCollection.docPath({}, contaId)) ||
    !canonical.exists ||
    canonical.data()?.integracaoId !== contaId ||
    canonical.data()?.clienteId !== clienteId ||
    canonical.data()?.conversaId !== conversaId
  )
    throw new WhatsappVinculoConflitoError(
      'A decisão de vínculo não autoriza recuperar esta mensagem. Recarregue o contato.',
    );
  return { clienteId, conversaId };
}

async function processInboundMessage(
  db: Firestore,
  deps: WhatsappProcessDeps,
  {
    contaId,
    conta,
    value,
    message,
    incoming,
    sourceNotificationId,
    historicoManualRetido,
  }: InboundArgs,
): Promise<InboundMessageOutcome> {
  if (!incoming) return 'echo';
  // Refuse stale tasks before identity resolution can alter a client/destination.
  // This early read is only a fast failure: each later write rechecks the proof.
  const replayBinding = historicoManualRetido
    ? await db.runTransaction((tx) =>
        validarHistoricoManualRetido(db, tx, historicoManualRetido, contaId, message),
      )
    : undefined;
  const validarReplay: ValidarReplay | undefined = historicoManualRetido
    ? async (tx, planned = replayBinding!) => {
        if (
          planned.clienteId !== replayBinding!.clienteId ||
          planned.conversaId !== replayBinding!.conversaId
        )
          throw new WhatsappVinculoConflitoError(
            'A identidade resolveu para outra conversa. Revise o vínculo antes de recuperar.',
          );
        await validarHistoricoManualRetido(
          db,
          tx,
          historicoManualRetido,
          contaId,
          message,
          replayBinding,
        );
      }
    : undefined;
  const prior = await whatsappMensagemCollection
    .docRef(db, {}, mensagemDocId(contaId, message.id))
    .get();
  if (prior.exists) {
    const mapped = whatsappMensagemCollection.parseRead(prior.data());
    if (replayBinding && mapped.conversaId !== replayBinding.conversaId)
      throw new WhatsappVinculoConflitoError('A mensagem já pertence a outra conversa vinculada.');
    const stored = await mensagemCollection
      .docRef(db, { conversaId: mapped.conversaId }, mapped.mensagemId)
      .get();
    if (mapped.integracaoId !== contaId || !stored.exists || stored.data()?.mid !== message.id) {
      throw new WhatsappVinculoConflitoError(
        'O registro da mensagem aponta para um histórico inconsistente.',
      );
    }
    const conversation = await conversaCollection.docRef(db, {}, mapped.conversaId).get();
    if (!conversation.exists)
      throw new WhatsappVinculoConflitoError('A conversa original da mensagem foi removida.');
    // A manual recovery accepted this retained content as history only. Original
    // notification redrives cannot later turn it into a fresh service-window event.
    if (mapped.historicoManual) {
      if (validarReplay) await db.runTransaction((tx) => validarReplay(tx));
      return 'redelivery';
    }
    const destination = conversaCollection.parseRead(conversation.data()).whatsappDestino;
    if (message.type !== 'system')
      await bumpUltimaModificacao(
        db,
        mapped.conversaId,
        waTimestampToMs(message.timestamp),
        validarReplay,
      );
    if (
      message.type !== 'system' &&
      destination?.identidadeId === stored.data()?.whatsappIdentidadeId &&
      destination?.ultimaMensagemEm === waTimestampToMs(message.timestamp)
    ) {
      await enviarMsgAutomatica(db, conta, mapped.conversaId, destination, validarReplay);
    }
    return 'redelivery';
  }
  const profile =
    value.contacts?.find(
      (contact) =>
        (message.from_user_id && contact.user_id === message.from_user_id) ||
        (message.from && contact.wa_id === message.from),
    ) ??
    (!message.from && !message.from_user_id && value.contacts?.length === 1
      ? value.contacts[0]
      : undefined);
  const contato: ContatoWhatsapp = {
    integracaoId: contaId,
    portfolioId: conta.portfolioId,
    bsuid: message.system?.previous_user_id ?? message.from_user_id ?? profile?.user_id ?? null,
    telefone: normalizeTelefoneInternacional(message.from ?? profile?.wa_id ?? ''),
    nome: profile?.profile?.name ?? null,
    timestamp: waTimestampToMs(message.timestamp),
  };
  if (!contato.bsuid && !contato.telefone) return 'unidentified';
  const mensagemDoCliente = message.type !== 'system';
  const transition =
    message.type === 'system' &&
    message.system &&
    ['user_changed_number', 'user_changed_user_id'].includes(message.system.type);
  const resolved = transition
    ? await aplicarTransicaoWhatsapp(db, contato, message.system!, validarReplay)
    : await resolverContatoWhatsapp(
        db,
        contato,
        validarReplay,
        // Provider events can identify a contact, but cannot open a service window.
        mensagemDoCliente ? {} : { ultimaMensagemEm: null },
      );
  if (resolved.kind === 'pending') {
    if (historicoManualRetido) {
      // A human may recover retained history without reactivating a retired
      // sender or approving an obsolete phone transition. The message transaction
      // revalidates that decision; no destination/window/identity mutation follows.
      const wrote = await createOrUpdateMensagem(db, deps, {
        contaId,
        conversaId: replayBinding!.conversaId,
        clienteId: replayBinding!.clienteId,
        identidadeId: identidadesDoContato(contato)[0]?.id ?? null,
        message,
        timestampMs: contato.timestamp,
        historicoManualRetido,
        somenteHistorico: true,
      });
      return wrote ? 'mensagem' : 'redelivery';
    }
    await guardarContatoPendente(
      db,
      contato,
      resolved.motivo,
      value,
      message,
      () => deps.mediaContext(db, contaId),
      sourceNotificationId,
    );
    return 'pending';
  }
  const { conversaId, clienteId, nome } = resolved;
  if (
    replayBinding &&
    (clienteId !== replayBinding.clienteId || conversaId !== replayBinding.conversaId)
  )
    throw new WhatsappVinculoConflitoError(
      'A identidade resolveu para outra conversa. Revise o vínculo antes de recuperar.',
    );
  const { skipMensagem, bumpedUltimaModificacao } = await upsertConversa(db, {
    conversaId,
    timestampMs: contato.timestamp,
    userName: nome,
    wamid: message.id,
    validarReplay,
    mensagemDoCliente,
  });
  if (skipMensagem) return 'spam';
  const wrote = await createOrUpdateMensagem(db, deps, {
    contaId,
    conversaId,
    clienteId,
    identidadeId: identidadesDoContato(contato)[0]!.id,
    message,
    timestampMs: contato.timestamp,
    historicoManualRetido,
  });
  if (mensagemDoCliente && !bumpedUltimaModificacao)
    await bumpUltimaModificacao(db, conversaId, contato.timestamp, validarReplay);
  // A replay for an old identity may enrich history; it must not send a reply to the new identity.
  if (mensagemDoCliente && resolved.destino.ultimaMensagemEm === contato.timestamp) {
    await enviarMsgAutomatica(db, conta, conversaId, resolved.destino, validarReplay);
  }
  return wrote ? 'mensagem' : 'redelivery';
}

/** The identity transaction already reserved and created this conversation. */
async function upsertConversa(
  db: Firestore,
  args: {
    conversaId: string;
    timestampMs: number;
    userName: string;
    wamid: string;
    validarReplay?: ValidarReplay;
    mensagemDoCliente: boolean;
  },
): Promise<{ skipMensagem: boolean; bumpedUltimaModificacao: boolean }> {
  const ref = conversaCollection.docRef(db, {}, args.conversaId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    await args.validarReplay?.(txn);
    if (!snap.exists)
      throw new WhatsappVinculoConflitoError(
        'A conversa vinculada foi removida durante o recebimento.',
      );
    const existing = conversaCollection.parseRead(snap.data());
    if (existing.estadoConversa === ESTADO_CONVERSA.spam)
      return { skipMensagem: true, bumpedUltimaModificacao: false };
    const last = toEpochMs(existing.ultimaModificacaoIntegracao);
    if (
      args.mensagemDoCliente &&
      (last == null || args.timestampMs > last) &&
      podeReabrirConversa(existing.estadoConversa)
    ) {
      txn.update(ref, {
        ultima_modificacao: Math.max(args.timestampMs, toEpochMs(existing.ultima_modificacao) ?? 0),
        ultimaModificacaoIntegracao: args.timestampMs,
        estadoConversa: ESTADO_CONVERSA.naoRespondido,
      });
      writeEvent(db, txn, args.conversaId, 'evento_reaberto_' + args.wamid, {
        conteudo:
          'Atendimento do ' +
          args.userName +
          ' reaberto automaticamente após nova mensagem do cliente.',
        timestampMs: args.timestampMs,
      });
      return { skipMensagem: false, bumpedUltimaModificacao: true };
    }
    return { skipMensagem: false, bumpedUltimaModificacao: false };
  });
}

/**
 * Bump the conversa's `ultima_modificacao` so a fresh inbound message
 * resurfaces it in an `ultima_modificacao desc` list (see the header note). The
 * create/reopen paths stamp it inline; this covers the in-order-non-reopenable
 * and out-of-order paths. Guarded to be MONOTONIC: a single-doc transaction
 * reads the current value and writes only when the message is newer, so an
 * out-of-order redelivery never moves it backwards. A transaction (not a bare
 * read-then-merge) is the cheapest shape that stays correct when the task queue
 * redelivers concurrently. `ultimaModificacaoIntegracao` is deliberately NOT
 * touched here — its freeze quirk is load-bearing (see `upsertConversa`).
 */
async function bumpUltimaModificacao(
  db: Firestore,
  conversaId: string,
  timestampMs: number,
  validarReplay?: ValidarReplay,
): Promise<void> {
  const convRef = conversaCollection.docRef(db, {}, conversaId);
  await db.runTransaction(async (txn: Transaction) => {
    const snap = await txn.get(convRef);
    await validarReplay?.(txn);
    if (!snap.exists) return;
    const existing = conversaCollection.parseRead(
      snap.data(),
      conversaCollection.docPath({}, conversaId),
    );
    const current = toEpochMs(existing.ultima_modificacao);
    if (current != null && current >= timestampMs) return; // never move backwards
    txn.set(convRef, conversaCollection.parseMerge({ ultima_modificacao: timestampMs }), {
      merge: true,
    });
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
  identidadeId: string | null;
  somenteHistorico?: boolean;
  historicoManualRetido?: HistoricoManualRetido;
  contaId: string;
  conversaId: string;
  clienteId: string;
  message: IncomingMessage;
  timestampMs: number;
}

/**
 * Create-or-update the inbound mensagem (messages.dart:204-327). Dedup by the
 * deterministic doc id + timestamp: an existing doc at/after this timestamp is a
 * redelivery → skip. Media is downloaded + cached into the typed schema
 * sub-objects; context/reaction/referral are mapped to the mensagem fields.
 * Returns `true` when a mensagem was written/updated, `false` on the idempotent
 * redelivery skip. ⚠️ The caller does NOT gate the `ultima_modificacao` bump on
 * it — see the comment at that bump for why gating there would be wrong. The
 * boolean is what the change's reported `MessagesFieldOutcome` is derived from,
 * which is the whole reason a redelivery is distinguishable from a real write.
 */
async function createOrUpdateMensagem(
  db: Firestore,
  deps: WhatsappProcessDeps,
  {
    contaId,
    conversaId,
    clienteId,
    identidadeId,
    message,
    timestampMs,
    historicoManualRetido,
    somenteHistorico,
  }: MensagemArgs,
): Promise<boolean> {
  const msgId = mensagemDocId(contaId, message.id);
  const msgRef = mensagemCollection.docRef(db, { conversaId }, msgId);

  // Media — resolve the account's Graph client + bucket only when needed.
  let ctx: MediaCacheContext | null = null;
  const mediaCtx = async (): Promise<MediaCacheContext> =>
    (ctx ??= await deps.mediaContext(db, contaId));

  const fields: Record<string, unknown> = {
    estadoEnvio: ESTADO_ENVIO.recebido,
    tipo: tipoForMessage(message),
    conteudo: message.text?.body ?? message.system?.body ?? null,
    whatsappIdentidadeId: identidadeId,
    user_id: null,
    usarioMensagemOuterRef: null,
    clienteMensagemOuterRef: 'documents/clientes/' + clienteId,
    mid: message.id,
    midGroup: msgId,
    data_cadastro: timestampMs,
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

  return db.runTransaction(async (tx) => {
    const current = await tx.get(msgRef);
    const mapRef = whatsappMensagemCollection.docRef(db, {}, msgId);
    const currentMap = await tx.get(mapRef);
    if (historicoManualRetido)
      await validarHistoricoManualRetido(db, tx, historicoManualRetido, contaId, message, {
        clienteId,
        conversaId,
      });
    if (currentMap.exists && currentMap.data()?.conversaId !== conversaId) {
      throw new WhatsappVinculoConflitoError('A mensagem já pertence a outra conversa canônica.');
    }
    const old = current.exists ? mensagemCollection.parseRead(current.data()) : null;
    tx.set(mapRef, {
      integracaoId: contaId,
      conversaId,
      mensagemId: msgRef.id,
      historicoManual: somenteHistorico === true || currentMap.data()?.historicoManual === true,
    });
    if (old && (toEpochMs(old.timestamp) ?? 0) >= timestampMs) return false;
    tx.set(
      msgRef,
      mensagemCollection.parse({
        ...fields,
        data_cadastro: toEpochMs(old?.data_cadastro) ?? timestampMs,
      }),
      { merge: true },
    );
    return true;
  });
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
  destino: WhatsappDestino,
  validarReplay?: ValidarReplay,
): Promise<void> {
  if (!conta.horario_funcionamento) return;
  const now = new Date();
  const aberto = estaAberto(conta, now);
  const texto = aberto ? conta.mensagem_automatica : conta.mensagem_inatividade;
  if (!texto) return;
  const kind = aberto ? 'dentro' : 'fora';
  const field = aberto ? 'recebido_durante_atendimento' : 'recebido_fora_atendimento';
  const id =
    'autoreply_' + kind + '_' + now.toISOString().slice(0, 10) + '_' + destino.identidadeId;
  const convRef = conversaCollection.docRef(db, {}, conversaId);
  const msgRef = mensagemCollection.docRef(db, { conversaId }, id);
  await db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);
    const message = await tx.get(msgRef);
    await validarReplay?.(tx);
    if (!conv.exists || message.exists) return;
    const current = conversaCollection.parseRead(conv.data());
    if (!mesmoDestinoWhatsapp(current.whatsappDestino, destino)) return;
    if ((current.whatsappDestino?.ultimaMensagemEm ?? 0) + DAY_MS <= now.getTime()) return;
    const last = toEpochMs(current[field]);
    if (last != null && now.getTime() - last < DAY_MS) return;
    tx.create(
      msgRef,
      mensagemCollection.parse({
        tipo: TIPO_MENSAGEM.comum,
        estadoEnvio: ESTADO_ENVIO.salva,
        conteudo: texto,
        timestamp: now.getTime(),
        data_cadastro: now.getTime(),
        whatsappDestino: current.whatsappDestino,
        whatsappIntegracaoId: idFromRef(current.integracaoOuterRef ?? ''),
      }),
    );
    tx.update(convRef, {
      [field]: now.getTime(),
      ultima_modificacao: Math.max(toEpochMs(current.ultima_modificacao) ?? 0, now.getTime()),
    });
  });
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
