import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefLooseSchema, outerRefSchema } from './shared/outerRef';
import type { CollectionMetadata } from './types';

const PERM_CONVERSA_READ = 1n << 48n;
const PERM_CONVERSA_WRITE = 1n << 49n;
const PERM_CONVERSA_DELETE = 1n << 50n;

const PERM_MENSAGEM_READ = 1n << 51n;
const PERM_MENSAGEM_WRITE = 1n << 52n;
const PERM_MENSAGEM_DELETE = 1n << 53n;

/**
 * Origem da conversa — string-coded enum mirroring
 * `packages/atendimento/lib/src/models.dart`. The wire values stay
 * compatible with the Flutter app, which is the source of webhook
 * events for non-`site` channels.
 */
export const ORIGEM_LABELS = {
  site: 'Site',
  facebook: 'Facebook',
  comentario: 'Comentário Facebook',
  whatsapp: 'WhatsApp',
  mlperg: 'Mercado Livre Perguntas',
  mlped: 'Mercado Livre Pedido',
  mlclaims: 'Mercado Livre Reclamações',
} as const;

export const origemConversaSchema = z
  .enum(['site', 'facebook', 'comentario', 'whatsapp', 'mlperg', 'mlped', 'mlclaims'])
  .meta({ labels: ORIGEM_LABELS });
export type OrigemConversa = z.infer<typeof origemConversaSchema>;

/**
 * Named members of {@link origemConversaSchema} — a readable name for each wire
 * slug, taken from what {@link ORIGEM_LABELS} calls it. (That map is keyed by the
 * slug, so its keys are the values here, not the names.)
 *
 * The three `ml*` slugs are the reason this exists — `'mlperg'`, `'mlped'` and
 * `'mlclaims'` are three different Mercado Livre surfaces that read alike.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const ORIGEM_CONVERSA = {
  site: 'site',
  facebook: 'facebook',
  comentarioFacebook: 'comentario',
  whatsapp: 'whatsapp',
  mercadoLivrePerguntas: 'mlperg',
  mercadoLivrePedido: 'mlped',
  mercadoLivreReclamacoes: 'mlclaims',
} as const satisfies Record<string, OrigemConversa>;

/**
 * EstadoConversa — int-coded enum (0/1/2/3/4/5/6/7/8/99). Flutter
 * stores the raw int; we keep the same wire format.
 */
export const estadoConversaSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(99),
]);
export type EstadoConversa = z.infer<typeof estadoConversaSchema>;

export const ESTADO_CONVERSA = {
  naoRespondido: 0,
  emResposta: 1,
  atendimentoFinalizado: 2,
  atendimentoCancelado: 3,
  atendimentoCanceladoPeloCliente: 4,
  atendimentoCanceladoPeloAtendente: 5,
  finalizadoSemAtendimento: 6,
  emEspera: 7,
  emTransferencia: 8,
  spam: 99,
} as const satisfies Record<string, EstadoConversa>;

export const ESTADO_CONVERSA_LABELS: Record<EstadoConversa, string> = {
  0: 'Não Respondido',
  1: 'Em Resposta',
  2: 'Atendimento Finalizado',
  3: 'Atendimento Cancelado',
  4: 'Cancelado pelo Cliente',
  5: 'Cancelado pelo Atendente',
  6: 'Finalizado sem Atendimento',
  7: 'Em Espera',
  8: 'Em Transferência',
  99: 'Spam',
};

export function podeReabrirConversa(estado: EstadoConversa): boolean {
  return (
    [
      ESTADO_CONVERSA.atendimentoFinalizado,
      ESTADO_CONVERSA.atendimentoCancelado,
      ESTADO_CONVERSA.atendimentoCanceladoPeloCliente,
      ESTADO_CONVERSA.atendimentoCanceladoPeloAtendente,
      ESTADO_CONVERSA.finalizadoSemAtendimento,
    ] as EstadoConversa[]
  ).includes(estado);
}

/**
 * Conversa — collection `chat`. Mirrors `packages/atendimento/lib/src/models.dart`
 * shape, which is how the migrated corpus is stored. Outer references
 * stay opaque pass-through; UI surfaces the IDs and resolves names lazily.
 */
export const conversaSchema = z.object({
  id: z.string().nullable().default(null),
  sender_id: z.string().nullable().default(null),
  estadoConversa: estadoConversaSchema.default(ESTADO_CONVERSA.naoRespondido),
  origem: origemConversaSchema.default('site'),

  // Outer refs — `documents/<col>/<id>` doc-path strings (Flutter ODM format).
  usarioOuterRef: outerRefSchema.nullable().default(null),
  integracaoOuterRef: outerRefSchema.nullable().default(null),
  pedidoOuterRef: outerRefSchema.nullable().default(null),
  incidenteOuterRef: outerRefSchema.nullable().default(null),
  produtoOuterRef: outerRefSchema.nullable().default(null),
  /**
   * The contact behind this conversa, as a `clientes` ref.
   *
   * `usuarios` is for people who can log into the system; an inbound contact is
   * a `cliente`. The legacy app minted a synthetic sem-auth `usuarios` doc per
   * contact purely so `usarioOuterRef` had something to point at, and the chat
   * UI then reached the customer through a second hop
   * (`clientes.userCliente == documents/usuarios/<uid>`). This field removes both
   * the doc and the hop.
   *
   * `usarioOuterRef` above STAYS: the WhatsApp pipeline writes it, and the
   * migration import brings in years of conversas carrying it. Readers prefer
   * `clienteOuterRef` and fall back to the usuario hop — never the other way
   * round, because a redelivery `merge()` onto a legacy doc leaves BOTH fields
   * populated.
   */
  clienteOuterRef: outerRefSchema.nullable().default(null),

  usuarios: z.array(z.string()).nullable().default(null),

  // Datetime fields — millisecondsSinceEpoch INT wire format (#484/#486), the
  // legacy Flutter `maybeDateTimeToJson` shape (`DateTime.millisecondsSinceEpoch`).
  // Written as a plain ms int; reads stay tolerant of a stray ISO string / µs int
  // via the `millisSinceEpoch()` codec (the migration shim), so pre-backfill docs
  // still render correctly instead of as 1970.
  data_cadastro: millisSinceEpoch().nullable().default(null),
  ultima_modificacao: millisSinceEpoch().nullable().default(null),
  ultimaModificacaoIntegracao: millisSinceEpoch().nullable().default(null),
  prazo_resposta: millisSinceEpoch().nullable().default(null),
  recebido_fora_atendimento: millisSinceEpoch().nullable().default(null),
  recebido_durante_atendimento: millisSinceEpoch().nullable().default(null),

  nome: z.string().default('Conversa sem título'),
  urlAvatar: z.string().default(''),
  cor_etiqueta: z.number().int().nullable().default(null),
  atendido: z.boolean().default(false),

  externalLink: z.string().nullable().default(null),
  internalLink: z.string().nullable().default(null),

  versao: z.number().int().nullable().default(null),
  mensagensIdMap: z.record(z.string(), z.unknown()).nullable().default(null),
  mensagensId: z.array(z.string()).nullable().default(null),

  /**
   * Why this thread can no longer be answered — `null` means it can.
   *
   * Written by the channel importers, read by the composer. The string is the
   * operator-facing reason, shown in place of the input ("Pergunta já respondida
   * no Mercado Livre", "Prazo de resposta encerrado", "Reclamação sem ações
   * disponíveis"), which is what #817 asks for: a composer that explains itself
   * rather than one that silently vanishes.
   *
   * ⚠️ Deliberately NOT `estadoConversa`. That field is operator triage state —
   * `claimImport.ts` restores it after every merge precisely so a webhook cannot
   * clobber someone mid-triage — and a webhook writing it would also ping-pong
   * against `podeReabrirConversa`. This field is channel-owned, that one is
   * operator-owned, and keeping them apart is what lets both be written safely.
   *
   * ⚠️ A UI HINT, never enforcement. It records what the channel last observed,
   * so it is stale by construction: a claim's available actions can empty out and
   * a post-sale window can close between the last import and the operator
   * pressing send. The send route re-derives the capability from the live
   * provider and is the only authority.
   */
  respostaBloqueada: z.string().nullable().default(null),
});
// No `.passthrough()`: every field the legacy Flutter app and the webchat
// widget write to `chat/*` is modeled above, so unknown top-level keys are
// stripped and — on a write through `defineCollection` — rejected (#464).
// Reads stay tolerant regardless (`parseSoftRead` logs, never throws).

export type Conversa = z.infer<typeof conversaSchema>;

export const conversaMeta: CollectionMetadata = {
  collectionPath: 'chat',
  permissions: {
    read: PERM_CONVERSA_READ,
    write: PERM_CONVERSA_WRITE,
    delete: PERM_CONVERSA_DELETE,
  },
  /**
   * ENFORCED, by `onConversaDeleted` — the CARO GENÉRICO factory in
   * `apps/functions/src/cascades/caroGenericoTriggers.ts` (#980). Firestore
   * cascades nothing on its own, so before that trigger a deleted conversa left
   * its entire `mensagem` history orphaned, permanently and invisibly.
   *
   * ⚠️ The trigger does not read this array. It walks whatever
   * `listCollections()` reports, so it also reclaims subcollections the legacy
   * corpus put under a conversa that this repo never modeled. This declaration
   * records intent; it is not the sweep's input.
   *
   * ⚠️ FIRESTORE ONLY. The `mensagem` documents carry six outer refs into the
   * top-level `arquivos` collection (`anexoStorage`, `audio.audio`,
   * `image.image`, `video.video`, `sticker.sticker`,
   * `genericDocument.genericDocument`). Those live outside the conversa, so the
   * cascade does not touch them, and no sweep reclaims them either — WhatsApp
   * media sits under `whatsapp/<contaId>/<mediaId>`, which `parseOwnedMediaDir`
   * does not recognise. A deliberate, recorded remainder (the `arquivos` skill's
   * §9 step-4 trap, pre-dating this cascade), NOT something to fix by deleting
   * the arquivos here: one arquivo doc is shared across messages and conversas
   * by deterministic media id, so a per-message delete would break a live
   * attachment elsewhere. Reclaiming them needs refcounting in the sweep — #1207.
   *
   * ⚠️ Like every trigger in that codebase, it does nothing until
   * `functions:storage` is deployed — a manual step.
   */
  cascade: [{ path: 'chat/{conversaId}/mensagem', onDelete: 'cascade' }],
};

export const conversa = { schema: conversaSchema, meta: conversaMeta };

/* -------------------------------------------------------------------------- */
/*                                  Mensagem                                  */
/* -------------------------------------------------------------------------- */

/**
 * EstadoEnvioMensagem — int-coded delivery state.
 */
export const estadoEnvioMensagemSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
]);
export type EstadoEnvioMensagem = z.infer<typeof estadoEnvioMensagemSchema>;

export const ESTADO_ENVIO = {
  salva: 1,
  enviando: 2,
  enviado: 3, // delivered
  recebido: 7,
  erro: 4,
  excluido: 5,
  banida: 6,
  desconhecido: 8,
} as const satisfies Record<string, EstadoEnvioMensagem>;

/**
 * The states a message WE sent can be in — `recebido` is the only inbound one.
 *
 * ⚠️ This is what decides which side of the thread a bubble renders on **for a
 * message with no author**, which is every message the marketplace importers
 * write: identity is a `cliente` now, so nothing stamps `user_id` (#768). When a
 * `user_id` IS present it wins, because it says *which operator* — something a
 * state can never answer.
 *
 * ⚠️ `excluido`, `banida` and `desconhecido` are deliberately OUT. They are
 * ambiguous — a moderated message may be the contact's — and the safe direction
 * is inbound: showing someone else's message as ours is a misattribution an
 * operator cannot detect, while the reverse is obvious.
 */
export const ESTADO_ENVIO_SAIDA = [
  ESTADO_ENVIO.salva,
  ESTADO_ENVIO.enviando,
  ESTADO_ENVIO.enviado,
  ESTADO_ENVIO.erro,
] as const satisfies readonly EstadoEnvioMensagem[];

const ESTADOS_DE_SAIDA: ReadonlySet<number> = new Set(ESTADO_ENVIO_SAIDA);

/** Whether this state means "we sent it" rather than "the contact sent it". */
export function ehEstadoDeSaida(estado: EstadoEnvioMensagem | null | undefined): boolean {
  return estado != null && ESTADOS_DE_SAIDA.has(estado);
}

export const ESTADO_ENVIO_LABELS: Record<EstadoEnvioMensagem, string> = {
  1: 'Salva',
  2: 'Enviando',
  3: 'Enviado',
  4: 'Erro',
  5: 'Excluído',
  6: 'Banido',
  7: 'Recebido',
  8: 'Desconhecido',
};

/**
 * TipoMensagem — single-char string-coded enum.
 */
export const TIPO_MENSAGEM_LABELS = {
  c: 'Comum',
  e: 'Evento',
  v: 'Vídeo',
  a: 'Áudio',
  f: 'Arquivo',
  '!': 'Erro',
} as const;

export const tipoMensagemSchema = z
  .enum(['c', 'e', 'v', 'a', 'f', '!'])
  .meta({ labels: TIPO_MENSAGEM_LABELS });
export type TipoMensagem = z.infer<typeof tipoMensagemSchema>;

/**
 * Named members of {@link tipoMensagemSchema} — a readable name for each wire
 * code, taken from what {@link TIPO_MENSAGEM_LABELS} calls it. (That map is keyed
 * by the code, so its keys are the values here, not the names.)
 *
 * Single-char codes, plus `'!'` for erro — which is not something anyone should
 * be typing by hand.
 */
export const TIPO_MENSAGEM = {
  comum: 'c',
  evento: 'e',
  video: 'v',
  audio: 'a',
  arquivo: 'f',
  erro: '!',
} as const satisfies Record<string, TipoMensagem>;

/**
 * Mensagem — subcollection `chat/{conversaId}/mensagem`. Mirrors
 * `Mensagem extends _MensagemModel` from the Flutter atendimento package.
 */
export const mensagemSchema = z.object({
  estadoEnvio: estadoEnvioMensagemSchema.default(ESTADO_ENVIO.salva),
  tipo: tipoMensagemSchema.default('c'),
  conteudo: z.string().nullable().default(null),
  resposta: z.string().nullable().default(null),
  canal: z.number().int().default(0),
  usarioMensagemOuterRef: outerRefSchema.nullable().default(null),
  user_id: z.string().nullable().default(null),
  /**
   * The message author when the author is the CONTACT — the `clientes` twin of
   * `usarioMensagemOuterRef`/`user_id` above, which stay for legacy + WhatsApp
   * writers. See `clienteOuterRef` on the conversa.
   *
   * ⚠️ This is NOT what decides which side of the thread a bubble renders on.
   * For a message with NO `user_id` — which is every message the marketplace
   * importers write — that is {@link ehEstadoDeSaida}: an inbound message must
   * be stamped `recebido` and an outbound one a saída state, whichever author
   * field it carries. When a `user_id` IS present it wins, because it names the
   * operator.
   *
   * ⚠️ This comment used to say `MensagemBubble` "reads `estadoEnvio === recebido`
   * for that", full stop. Only the INBOUND half was ever true: the side came off
   * `user_id === myUid` alone, so an authorless message could never render as
   * ours and every ML reply we sent landed on the customer's side, grey and with
   * no delivery tick. Three files repeated the claim and the importers were
   * written against it. Do not restate it without checking the renderer.
   */
  clienteMensagemOuterRef: outerRefSchema.nullable().default(null),
  urlAvatar: z.string().nullable().default(null),
  mid: z.string().nullable().default(null),
  midGroup: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  // Read-receipt timestamp — millisecondsSinceEpoch INT (#484/#486); tolerant
  // read of a stray ISO/µs value via the codec.
  visualizado: millisSinceEpoch().nullable().default(null),
  transcription: z.string().nullable().default(null),
  anexo: z.string().nullable().default(null),
  // Real Firestore/Flutter key is snake_case `anexo_url` (`models.g.dart`),
  // not the camelCase `anexoUrl` this schema used before #464 — that silent
  // mismatch meant the field was read/written under the wrong key.
  anexo_url: z.string().nullable().default(null),
  // Mensagem timestamp ordering field. Flutter writes either createTime
  // (Firestore metadata) or an explicit `timestamp` — we expect the
  // latter when authoring from this app. millisecondsSinceEpoch INT wire
  // format (#484/#486, legacy `maybeDateTimeToJson` parity); the codec
  // tolerates a stray ISO/µs value on read.
  timestamp: millisSinceEpoch().nullable().default(null),

  /*
   * Legacy WhatsApp/webchat-pipeline fields (`.old` atendimento models,
   * populated by the WhatsApp Cloud API webhook pipeline). The new UI only
   * *reads* these, never authors them, so they are modeled as `.nullish()`
   * (wire-optional; the Flutter `toJson` omits null values) rather than the
   * `.nullable().default(null)` convention used by the app-authored fields
   * above. That keeps soft-reads tolerant across the WhatsApp/ML/Facebook
   * channels and never leaks `undefined` into the app's own writes (which
   * omit these keys entirely). Media/`Arquivo` refs use `outerRefLooseSchema`
   * because their exact wire form (`documents/<col>/<id>` vs bare `<col>/<id>`)
   * is not verifiable off-staging; reads stay soft regardless.
   */

  // Storage attachment (single `Arquivo` outer ref) + its caption.
  anexoStorage: outerRefLooseSchema.nullish(),
  anexoDescription: z.string().nullish(),

  // Media sub-objects — each wraps a downloaded WhatsApp media `Arquivo`.
  audio: z.object({ audio: outerRefLooseSchema, transcription: z.string().nullish() }).nullish(),
  image: z
    .object({
      image: outerRefLooseSchema,
      caption: z.string().nullish(),
      ai_description: z.string().nullish(),
    })
    .nullish(),
  video: z
    .object({
      video: outerRefLooseSchema,
      caption: z.string().nullish(),
      ai_description: z.string().nullish(),
    })
    .nullish(),
  sticker: z
    .object({
      sticker: outerRefLooseSchema,
      caption: z.string().nullish(),
      ai_description: z.string().nullish(),
      animated: z.boolean().nullish(),
    })
    .nullish(),
  genericDocument: z
    .object({
      genericDocument: outerRefLooseSchema,
      caption: z.string().nullish(),
      ai_description: z.string().nullish(),
    })
    .nullish(),

  // Interactive / contextual sub-objects.
  button: z.object({ text: z.string(), payload: z.string() }).nullish(),
  context: z
    .object({
      mensagemOuterRef: outerRefSchema.nullish(),
      produto_uid: z.string().nullish(),
      observacao: z.string().nullish(),
      forwarded: z.boolean().nullish(),
      frequently_forwarded: z.boolean().nullish(),
    })
    .nullish(),
  reaction: z
    .object({
      mensagemOuterRef: outerRefSchema.nullish(),
      emoji: z.string(),
      observacao: z.string().nullish(),
    })
    .nullish(),
  referral: z
    .object({
      source_url: z.string().nullish(),
      source_type: z.string().nullish(),
      source_id: z.string().nullish(),
      headline: z.string().nullish(),
      body: z.string().nullish(),
      media_type: z.string().nullish(),
      image_url: z.string().nullish(),
      video_url: z.string().nullish(),
      thumbnail_url: z.string().nullish(),
      ctwa_clid: z.string().nullish(),
    })
    .nullish(),

  // WhatsApp delivery errors (`errors[]`, distinct from the legacy single
  // `error` string above).
  errors: z
    .array(
      z.object({
        code: z.number().int(),
        title: z.string(),
        details: z.string().nullish(),
        error_data: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .nullish(),

  // Lifecycle timestamps: `data_cadastro` set once on create;
  // `lastExternalUpdateDateTime` tracks the last WhatsApp status webhook and
  // guards against stale/out-of-order `estadoEnvio` transitions.
  // millisecondsSinceEpoch INT wire format (#484/#486); kept `.nullish()`
  // (wire-optional — pre-existing docs from other writers may omit the keys
  // entirely; legacy Flutter writes them present-with-null) rather than the
  // `.nullable().default(null)` convention above. Reads tolerate a stray
  // ISO/µs value via the codec.
  data_cadastro: millisSinceEpoch().nullish(),
  lastExternalUpdateDateTime: millisSinceEpoch().nullish(),
});
// No `.passthrough()` (see the `conversaSchema` note): unknown top-level keys
// are stripped, and rejected on writes through `defineCollection`. `createdAt`
// (a raw Firestore `Timestamp` written by `apps/webchat` alongside the ms-int
// `timestamp`) is intentionally NOT modeled — it is a redundant server-write
// companion the new UI never reads; it is soft-stripped on read and is never
// sent through the converter, so it never trips the strict-write check.

export type Mensagem = z.infer<typeof mensagemSchema>;

export const mensagemMeta: CollectionMetadata = {
  collectionPath: 'chat/{conversaId}/mensagem',
  permissions: {
    read: PERM_MENSAGEM_READ,
    write: PERM_MENSAGEM_WRITE,
    delete: PERM_MENSAGEM_DELETE,
  },
};

export const mensagem = { schema: mensagemSchema, meta: mensagemMeta };
