import { z } from 'zod';
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
 * shape so Flutter and Next coexist on the same docs. Outer references
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

  usuarios: z.array(z.string()).nullable().default(null),

  data_cadastro: z.string().datetime().nullable().default(null),
  ultima_modificacao: z.string().datetime().nullable().default(null),
  ultimaModificacaoIntegracao: z.string().datetime().nullable().default(null),
  prazo_resposta: z.string().datetime().nullable().default(null),
  recebido_fora_atendimento: z.string().datetime().nullable().default(null),
  recebido_durante_atendimento: z.string().datetime().nullable().default(null),

  nome: z.string().default('Conversa sem título'),
  urlAvatar: z.string().default(''),
  cor_etiqueta: z.number().int().nullable().default(null),
  atendido: z.boolean().default(false),

  externalLink: z.string().nullable().default(null),
  internalLink: z.string().nullable().default(null),

  versao: z.number().int().nullable().default(null),
  mensagensIdMap: z.record(z.string(), z.unknown()).nullable().default(null),
  mensagensId: z.array(z.string()).nullable().default(null),
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
  urlAvatar: z.string().nullable().default(null),
  mid: z.string().nullable().default(null),
  midGroup: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  visualizado: z.string().datetime().nullable().default(null),
  transcription: z.string().nullable().default(null),
  anexo: z.string().nullable().default(null),
  // Real Firestore/Flutter key is snake_case `anexo_url` (`models.g.dart`),
  // not the camelCase `anexoUrl` this schema used before #464 — that silent
  // mismatch meant the field was read/written under the wrong key.
  anexo_url: z.string().nullable().default(null),
  // Mensagem timestamp ordering field. Flutter writes either createTime
  // (Firestore metadata) or an explicit `timestamp` — we expect the
  // latter when authoring from this app.
  timestamp: z.string().datetime().nullable().default(null),

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
  data_cadastro: z.string().datetime().nullish(),
  lastExternalUpdateDateTime: z.string().datetime().nullish(),
});
// No `.passthrough()` (see the `conversaSchema` note): unknown top-level keys
// are stripped, and rejected on writes through `defineCollection`. `createdAt`
// (a raw Firestore `Timestamp` written by `apps/webchat` alongside the ISO
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
