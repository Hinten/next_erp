import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../shared/datetime';
import { freteDoPedidoSchema } from '../../shared/frete';

// Incidente belongs to the PEDIDO permission domain (`permCode: 'p4'` in the
// legacy ODM); it shares the pedido bits, like `motivoIncidente`.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * `tipoDeIncidente` — STRING-coded enum, wire values mirror the legacy Flutter
 * enum (`.old/packages/pedido/lib/src/models.dart:1153`). Stored on disk as the
 * raw value (`'returns'`, `'t'`, …).
 */
export const TIPO_INCIDENTE = {
  mediacaoDoMarketplace: 'mediations',
  cancelamentoPeloComprador: 'cancel_purchase',
  devolucao: 'returns',
  cancelamentoPeloVendedor: 'cancel_sale',
  troca: 't',
  atendimento: 'a',
  entregaAtrasada: 'e',
  outros: 'o',
} as const satisfies Record<string, TipoIncidente>;

export const tipoIncidenteSchema = z.enum([
  'mediations',
  'cancel_purchase',
  'returns',
  'cancel_sale',
  't',
  'a',
  'e',
  'o',
]);
export type TipoIncidente = z.infer<typeof tipoIncidenteSchema>;

export const TIPO_INCIDENTE_LABELS: Record<TipoIncidente, string> = {
  mediations: 'Mediação do Marketplace',
  cancel_purchase: 'Cancelamento pelo Comprador',
  returns: 'Devolução',
  cancel_sale: 'Cancelamento pelo Vendedor',
  t: 'Troca',
  a: 'Atendimento ruim',
  e: 'Entrega Atrasada',
  o: 'Outros',
};

/**
 * `OrigemIncidente` — INT-coded enum
 * (`.old/packages/pedido/lib/src/models.dart:1205`).
 */
export const ORIGEM_INCIDENTE = {
  site: 0,
  facebook: 1,
  pedidoMercadoLivre: 2,
  troca: 3,
  devolucao: 4,
  outros: 99,
} as const;

export const origemIncidenteSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(99),
]);
export type OrigemIncidente = z.infer<typeof origemIncidenteSchema>;

export const ORIGEM_INCIDENTE_LABELS: Record<OrigemIncidente, string> = {
  0: 'Site',
  1: 'Facebook',
  2: 'Pedido Mercado Livre',
  3: 'Troca',
  4: 'Devolução',
  99: 'Outros',
};

/**
 * `TipoResolucao` — INT-coded enum
 * (`.old/packages/pedido/lib/src/models.dart:1365`).
 */
export const TIPO_RESOLUCAO = {
  itemDevolvido: 0,
  enviadoOutroItem: 1,
  etiquetaDeDevolucao: 2,
  pagamentoDevolvidoIntegralmente: 3,
  pagamentoDevolvidoParcialmente: 4,
  inatividadeDoCliente: 5,
  encerradoSemNenhumaAcao: 6,
  outro: 7,
} as const;

export const tipoResolucaoSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export type TipoResolucao = z.infer<typeof tipoResolucaoSchema>;

export const TIPO_RESOLUCAO_LABELS: Record<TipoResolucao, string> = {
  0: 'Item devolvido',
  1: 'Enviado outro item',
  2: 'Etiqueta de devolução',
  3: 'Pagamento devolvido integralmente',
  4: 'Pagamento devolvido parcialmente',
  5: 'Inatividade do cliente',
  6: 'Encerrado sem nenhuma ação',
  7: 'Outro',
};

/**
 * `Resolucao` — embedded object inside an `Incidente` (the legacy model has
 * `hasCollection: false`; it is never its own collection). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:1413`.
 */
export const resolucaoSchema = z
  .object({
    data: microsSinceEpoch('Data da resolução').nullable().default(null),
    valor: z.number().min(0).default(0).describe('Despesa da resolução'),
    tipo: tipoResolucaoSchema.describe('Tipo de resolução'),
    comentarios: z.string().nullable().default(null).describe('Comentários sobre a resolução'),
    frete: freteDoPedidoSchema.nullable().default(null).describe('Frete da resolução'),
  })
  .passthrough();
export type Resolucao = z.infer<typeof resolucaoSchema>;

/**
 * Incidente — subcoleção `pedidos/{pedidoId}/incidentes` (plural, matching the
 * legacy `INCIDENTE_PEDIDO_COLLECTION` constant). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:1256`. An order issue/incident:
 * mediation, return, exchange, late delivery, etc., optionally with a recorded
 * resolution.
 */
export const incidenteSchema = z
  .object({
    origem: origemIncidenteSchema.nullable().default(null).describe('Origem'),
    tipo: tipoIncidenteSchema.default(TIPO_INCIDENTE.devolucao).describe('Tipo de incidente'),
    motivoDoIncidente: z.string().max(2000).nullable().default(null).describe('Motivo'),
    comentarios: z.string().max(2000).nullable().default(null).describe('Comentários'),
    timestamp: microsSinceEpoch('Data do incidente').nullable().default(null),
    ultimaModificacao: microsSinceEpoch('Última modificação').nullable().default(null),
    externalId: z.string().nullable().default(null).describe('ID externo'),
    resolucao: resolucaoSchema.nullable().default(null).describe('Resolução'),
  })
  .passthrough();

export type Incidente = z.infer<typeof incidenteSchema>;

export const incidenteMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/incidentes',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
};

export const incidente = { schema: incidenteSchema, meta: incidenteMeta };
