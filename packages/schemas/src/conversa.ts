import { z } from 'zod';
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
export const origemConversaSchema = z.enum([
  'site',
  'facebook',
  'comentario',
  'whatsapp',
  'mlperg',
  'mlped',
  'mlclaims',
]);
export type OrigemConversa = z.infer<typeof origemConversaSchema>;

export const ORIGEM_LABELS: Record<OrigemConversa, string> = {
  site: 'Site',
  facebook: 'Facebook',
  comentario: 'Comentário Facebook',
  whatsapp: 'WhatsApp',
  mlperg: 'Mercado Livre Perguntas',
  mlped: 'Mercado Livre Pedido',
  mlclaims: 'Mercado Livre Reclamações',
};

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
  return ([
    ESTADO_CONVERSA.atendimentoFinalizado,
    ESTADO_CONVERSA.atendimentoCancelado,
    ESTADO_CONVERSA.atendimentoCanceladoPeloCliente,
    ESTADO_CONVERSA.atendimentoCanceladoPeloAtendente,
    ESTADO_CONVERSA.finalizadoSemAtendimento,
  ] as EstadoConversa[]).includes(estado);
}

/**
 * Conversa — collection `chat`. Mirrors `packages/atendimento/lib/src/models.dart`
 * shape so Flutter and Next coexist on the same docs. Outer references
 * stay opaque pass-through; UI surfaces the IDs and resolves names lazily.
 */
export const conversaSchema = z.object({
  id: z.string().nullable().optional(),
  sender_id: z.string().nullable().optional(),
  estadoConversa: estadoConversaSchema.default(ESTADO_CONVERSA.naoRespondido),
  origem: origemConversaSchema.default('site'),

  // Outer refs (pass-through; the Flutter app authors them with full paths).
  usarioOuterRef: z.unknown().nullable().optional(),
  integracaoOuterRef: z.unknown().nullable().optional(),
  pedidoOuterRef: z.unknown().nullable().optional(),
  incidenteOuterRef: z.unknown().nullable().optional(),
  produtoOuterRef: z.unknown().nullable().optional(),

  usuarios: z.array(z.string()).nullable().optional(),

  data_cadastro: z.string().datetime().nullable().optional(),
  ultima_modificacao: z.string().datetime().nullable().optional(),
  ultimaModificacaoIntegracao: z.string().datetime().nullable().optional(),
  prazo_resposta: z.string().datetime().nullable().optional(),
  recebido_fora_atendimento: z.string().datetime().nullable().optional(),
  recebido_durante_atendimento: z.string().datetime().nullable().optional(),

  nome: z.string().default('Conversa sem título'),
  urlAvatar: z.string().default(''),
  cor_etiqueta: z.number().int().nullable().optional(),
  atendido: z.boolean().default(false),

  externalLink: z.string().nullable().optional(),
  internalLink: z.string().nullable().optional(),

  versao: z.number().int().nullable().optional(),
  mensagensIdMap: z.record(z.string(), z.unknown()).nullable().optional(),
  mensagensId: z.array(z.string()).nullable().optional(),
}).passthrough();

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
export const tipoMensagemSchema = z.enum(['c', 'e', 'v', 'a', 'f', '!']);
export type TipoMensagem = z.infer<typeof tipoMensagemSchema>;

export const TIPO_MENSAGEM_LABELS: Record<TipoMensagem, string> = {
  c: 'Comum',
  e: 'Evento',
  v: 'Vídeo',
  a: 'Áudio',
  f: 'Arquivo',
  '!': 'Erro',
};

/**
 * Mensagem — subcollection `chat/{conversaId}/mensagem`. Mirrors
 * `Mensagem extends _MensagemModel` from the Flutter atendimento package.
 */
export const mensagemSchema = z.object({
  estadoEnvio: estadoEnvioMensagemSchema.default(ESTADO_ENVIO.salva),
  tipo: tipoMensagemSchema.default('c'),
  conteudo: z.string().nullable().optional(),
  resposta: z.string().nullable().optional(),
  canal: z.number().int().default(0),
  usarioMensagemOuterRef: z.unknown().nullable().optional(),
  user_id: z.string().nullable().optional(),
  urlAvatar: z.string().nullable().optional(),
  mid: z.string().nullable().optional(),
  midGroup: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  visualizado: z.string().datetime().nullable().optional(),
  transcription: z.string().nullable().optional(),
  anexo: z.string().nullable().optional(),
  anexoUrl: z.string().nullable().optional(),
  // Mensagem timestamp ordering field. Flutter writes either createTime
  // (Firestore metadata) or an explicit `timestamp` — we expect the
  // latter when authoring from this app.
  timestamp: z.string().datetime().nullable().optional(),
}).passthrough();

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
