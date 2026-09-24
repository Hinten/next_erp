import { z } from 'zod';
import { ttlExpiry } from './shared/ttl';

/** Destination accepted by the operator/identity resolver, never inferred by the sender. */
export const whatsappDestinoSchema = z.object({
  tipo: z.enum(['telefone', 'bsuid']),
  valor: z.string().min(1),
  identidadeId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  ultimaMensagemEm: z.number().nullable().default(null),
  ultimaIdentificacaoEm: z.number().nullable().optional(),
});
export type WhatsappDestino = z.infer<typeof whatsappDestinoSchema>;

// These records are Admin-only. The HTTP API enforces chat + cliente permissions
// and returns projections, never the retained provider payload.
export const whatsappIdentidadeSchema = z.object({
  escopo: z.string().min(1),
  tipo: z.enum(['telefone', 'bsuid']),
  valor: z.string().min(1),
  clienteId: z.string().min(1),
  ativa: z.boolean(),
  confirmadaManualmente: z.boolean().default(false),
  /** Phone alias IDs reviewed as contradictory to this BSUID; never transferred. */
  aliasesTelefoneIgnorados: z.array(z.string()).default([]),
  telefoneClienteNoVinculo: z.string().nullable().default(null),
  sucessoraId: z.string().nullable().default(null),
  ultimaTransicaoEm: z.number().nullable().default(null),
});
export const whatsappConversaSchema = z.object({
  integracaoId: z.string(),
  clienteId: z.string(),
  conversaId: z.string(),
});
export const whatsappMensagemSchema = z.object({
  integracaoId: z.string(),
  conversaId: z.string(),
  mensagemId: z.string(),
  // A human recovered retained history; redelivery must not reopen a service window.
  historicoManual: z.boolean().default(false),
});
export const whatsappConversaAliasSchema = whatsappConversaSchema;
export const whatsappMensagemAliasSchema = z.object({
  conversaId: z.string(),
  mensagemId: z.string(),
});

export const whatsappVinculoResumoSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  integracaoId: z.string(),
  integracaoNome: z.string(),
  nome: z.string().nullable().default(null),
  telefone: z.string().nullable().default(null),
  bsuid: z.string().nullable().default(null),
  motivo: z.string(),
  ultimaMensagemEm: z.number(),
  quantidadeMensagens: z.number().int().nonnegative(),
  estado: z.enum(['aguardando', 'recuperando', 'resolvido', 'erro']),
  clienteId: z.string().nullable().default(null),
  conversaId: z.string().nullable().default(null),
});
export type WhatsappVinculoResumo = z.infer<typeof whatsappVinculoResumoSchema>;
export const whatsappVinculoSchema = whatsappVinculoResumoSchema.extend({
  portfolioId: z.string().nullable().default(null),
  ultimaMensagemClienteEm: z.number().nullable().default(null),
  requestId: z.string().nullable().default(null),
  requestFingerprint: z.string().nullable().default(null),
  decididoPor: z.string().nullable().default(null),
});
export const whatsappVinculoMensagemSchema = z.object({
  sourceNotificationId: z.string().nullable().default(null),
  value: z.unknown(),
  timestamp: z.number(),
  conteudo: z.string().nullable().default(null),
  arquivoId: z.string().nullable().default(null),
  anexoTipo: z.string().nullable().default(null),
  processada: z.boolean().default(false),
  /**
   * TTL expiry (`./shared/ttl`), stamped in the SAME write that sets
   * `processada: true` (`vinculoReplay.ts`): by then the message lives in the
   * chat, and this copy only holds the raw provider payload — personal data kept
   * for nothing. An unprocessed message is never stamped: it is the only copy.
   * ⚠️ The `mensagens` group is shared with `whatsappConversaAliases/{id}/mensagens`,
   * which must never be stamped.
   */
  expiraEm: ttlExpiry().nullable().optional(),
});
export const whatsappVinculoListaSchema = z.object({
  items: z.array(whatsappVinculoResumoSchema),
  nextCursor: z.string().nullable(),
});
export const whatsappVinculoDetalheSchema = z.object({
  pendencia: whatsappVinculoResumoSchema,
  candidates: z.array(
    z.object({
      id: z.string(),
      nome: z.string().nullable(),
      cpf_cnpj: z.string().nullable(),
      telefone: z.string().nullable(),
      email: z.string().nullable(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      timestamp: z.number().nullable(),
      conteudo: z.string().nullable(),
      anexoUrl: z.string().nullable(),
      anexoTipo: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
/** Review projection for the selected customer before confirming a manual link. */
export const whatsappVinculoPrevisaoSchema = z.object({
  cliente: z.object({
    id: z.string().min(1),
    nome: z.string().nullable(),
    cpf_cnpj: z.string().nullable(),
    telefone: z.string().nullable(),
  }),
  conversaId: z.string().min(1).nullable(),
  avisoIdentidade: z.string().nullable().default(null),
});
export type WhatsappVinculoPrevisao = z.infer<typeof whatsappVinculoPrevisaoSchema>;

export const whatsappVinculoResultadoSchema = z.object({
  clienteId: z.string(),
  conversaId: z.string(),
  replayPending: z.boolean(),
});

/** Equality used both before browser writes and inside the outbound claim. */
export function mesmoDestinoWhatsapp(
  a: WhatsappDestino | null | undefined,
  b: WhatsappDestino | null | undefined,
): boolean {
  return (
    a != null &&
    b != null &&
    a.tipo === b.tipo &&
    a.valor === b.valor &&
    a.identidadeId === b.identidadeId &&
    a.revision === b.revision
  );
}
