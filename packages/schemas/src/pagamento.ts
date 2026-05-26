import { z } from 'zod';
import type { CollectionMetadata } from './types';
import type { EstadoPedido } from './pedido';

const PERM_PAGAMENTO_READ = 1n << 24n;
const PERM_PAGAMENTO_WRITE = 1n << 25n;
const PERM_PAGAMENTO_DELETE = 1n << 26n;

const PERM_METODO_PGTO_READ = 1n << 27n;
const PERM_METODO_PGTO_WRITE = 1n << 28n;
const PERM_METODO_PGTO_DELETE = 1n << 29n;

/**
 * FORMA_PAGAMENTO — wire format mirrors Flutter's int-coded enum
 * (`@JsonValue(N)`). Stored on disk as the integer value.
 */
export const formaPagamentoSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(10),
  z.literal(11),
  z.literal(12),
  z.literal(13),
  z.literal(15),
  z.literal(16),
  z.literal(17),
  z.literal(18),
  z.literal(19),
  z.literal(90),
  z.literal(99),
]);
export type FormaPagamento = z.infer<typeof formaPagamentoSchema>;

export const FORMA_PAGAMENTO = {
  dinheiro: 1,
  cheque: 2,
  cartao_credito: 3,
  cartao_debito: 4,
  credito_loja: 5,
  vale_alimentacao: 10,
  vale_refeicao: 11,
  vale_presente: 12,
  vale_combustivel: 13,
  boleto_bancario: 15,
  deposito_bancario: 16,
  pix: 17,
  carteira_digital_transferencia_bancaria: 18,
  fidelidade_cashback_credito_virtual: 19,
  sem_pagamento: 90,
  outros: 99,
} as const satisfies Record<string, FormaPagamento>;

export const FORMA_PAGAMENTO_LABELS: Record<FormaPagamento, string> = {
  1: 'Dinheiro',
  2: 'Cheque',
  3: 'Cartão de Crédito',
  4: 'Cartão de Débito',
  5: 'Crédito Loja',
  10: 'Vale alimentação',
  11: 'Vale refeição',
  12: 'Vale Presente',
  13: 'Vale Combustível',
  15: 'Boleto Bancário/Duplicata',
  16: 'Depósito Bancário',
  17: 'PIX',
  18: 'Carteira digital/Transferência bancária',
  19: 'Programa de Fidelidade/Cashback/Crédito Virtual',
  90: 'Sem pagamento',
  99: 'Outros',
};

/**
 * STATUS_PAGAMENTO — wire format mirrors Flutter's int-coded enum.
 */
export const statusPagamentoSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
  z.literal(11),
]);
export type StatusPagamento = z.infer<typeof statusPagamentoSchema>;

export const STATUS_PAGAMENTO = {
  pendente: 0,
  em_revisao: 1,
  pago_parcialmente: 2,
  em_processo_aprovacao: 3,
  aprovado: 4,
  em_disputa: 5,
  recusado: 6,
  cancelado: 7,
  estornado: 8,
  devolvido: 9,
  estornado_parcialmente: 10,
  estornado_totalmente: 11,
} as const satisfies Record<string, StatusPagamento>;

export const STATUS_PAGAMENTO_LABELS: Record<StatusPagamento, string> = {
  0: 'Pendente',
  1: 'Em revisão',
  2: 'Pago parcialmente',
  3: 'Em processo de aprovação',
  4: 'Aprovado',
  5: 'Em disputa',
  6: 'Recusado',
  7: 'Cancelado',
  8: 'Estornado',
  9: 'Devolvido',
  10: 'Estornado parcialmente',
  11: 'Estornado totalmente',
};

/**
 * Map a payment status to the corresponding pedido state. Mirrors
 * Flutter's `STATUS_PAGAMENTO.toEstadoPedido()`. Used by webhook
 * handlers in apps/integrations and by the manual status-change UI to
 * propose a pedido state transition alongside the payment status.
 */
export function statusToEstadoPedido(status: StatusPagamento): EstadoPedido {
  switch (status) {
    case STATUS_PAGAMENTO.pendente:
    case STATUS_PAGAMENTO.pago_parcialmente:
    case STATUS_PAGAMENTO.em_processo_aprovacao:
      return 'aguardandoConfirmacaoDePagamento';
    case STATUS_PAGAMENTO.em_revisao:
      return 'emAnalise';
    case STATUS_PAGAMENTO.aprovado:
    case STATUS_PAGAMENTO.em_disputa:
      return 'pago';
    case STATUS_PAGAMENTO.recusado:
      return 'pagamentoNaoRealizado';
    case STATUS_PAGAMENTO.cancelado:
      return 'cancelado';
    case STATUS_PAGAMENTO.estornado:
    case STATUS_PAGAMENTO.devolvido:
    case STATUS_PAGAMENTO.estornado_totalmente:
      return 'estornadoIntegralmente';
    case STATUS_PAGAMENTO.estornado_parcialmente:
      return 'estornadoParcialmente';
    default:
      return 'error';
  }
}

/**
 * Pagamento — subcoleção `pedidos/{pedidoId}/pagamento` (singular,
 * matching the Flutter ERP's wire format). Mirrors
 * `packages/pedido/lib/src/models.dart` Pagamento. Cartão / cheque
 * details remain pass-through; the typed surface is what this app reads
 * and writes today.
 */
export const pagamentoSchema = z.object({
  id: z.string().nullable().default(null),
  metodoPagamentoOuterRef: z.unknown().nullable().default(null),
  forma_de_pagamento: formaPagamentoSchema.default(FORMA_PAGAMENTO.dinheiro),
  status_pagamento: statusPagamentoSchema.nullable().default(null),
  cartao: z.unknown().nullable().default(null),
  cheque: z.unknown().nullable().default(null),
  descricaoPagamento: z.string().nullable().default(null),
  valor: z.number().min(0),
  parcelas: z.number().int().min(1).default(1),
  juros: z.number().min(0).nullable().default(null),
  tarifas: z.number().min(0).nullable().default(null),
  aVista: z.boolean().default(true),
  duplicata: z.boolean().default(false),
  nFat: z.string().max(60).nullable().default(null),
  vencimento: z.string().datetime().nullable().default(null),
  ultimaModificacao: z.string().datetime().nullable().default(null),
  dataCancelamento: z.string().datetime().nullable().default(null),
  dataAprovacao: z.string().datetime().nullable().default(null),
  dataCadastro: z.string().datetime().nullable().default(null),
}).passthrough();

export type Pagamento = z.infer<typeof pagamentoSchema>;

export const pagamentoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/pagamento',
  permissions: {
    read: PERM_PAGAMENTO_READ,
    write: PERM_PAGAMENTO_WRITE,
    delete: PERM_PAGAMENTO_DELETE,
  },
};

export const pagamento = { schema: pagamentoSchema, meta: pagamentoMeta };

/* -------------------------------------------------------------------------- */
/*                            MetodoPagamento                                 */
/* -------------------------------------------------------------------------- */

/**
 * TIPO_INTEGRACAO_PGTO — int-coded enum, today only `mercadoPago`.
 * New gateways register against this enum + a corresponding
 * PaymentGateway plugin in packages/integrations/<channel>/.
 */
export const tipoIntegracaoPgtoSchema = z.literal(1);
export type TipoIntegracaoPgto = z.infer<typeof tipoIntegracaoPgtoSchema>;

export const TIPO_INTEGRACAO_PGTO = { mercadoPago: 1 } as const satisfies Record<
  string,
  TipoIntegracaoPgto
>;
export const TIPO_INTEGRACAO_PGTO_LABELS: Record<TipoIntegracaoPgto, string> = {
  1: 'Mercado Pago',
};

export const metodoPagamentoSchema = z.object({
  tipo: tipoIntegracaoPgtoSchema,
  hasLinkPagamento: z.boolean().default(false),
  nome: z.string().min(1).max(255),
  dataCadastro: z.string().datetime().nullable().default(null),
});
export type MetodoPagamento = z.infer<typeof metodoPagamentoSchema>;

export const metodoPagamentoMeta: CollectionMetadata = {
  collectionPath: 'metodo_pgto',
  permissions: {
    read: PERM_METODO_PGTO_READ,
    write: PERM_METODO_PGTO_WRITE,
    delete: PERM_METODO_PGTO_DELETE,
  },
};

export const metodoPagamento = {
  schema: metodoPagamentoSchema,
  meta: metodoPagamentoMeta,
};
