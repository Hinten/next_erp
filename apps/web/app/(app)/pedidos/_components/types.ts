import type { ItemDoPedido } from '@delfrance/schemas';

/**
 * A flat item row used by the form's `useFieldArray`. Carries a
 * synthetic `_rowId` so RHF can key stable rows even when the user
 * reorders or removes them. Stripped on submit.
 */
export type FlatItem = ItemDoPedido & { _rowId: string };

/**
 * The shape RHF holds for the pedido form. Mirrors `pedidoSchema`'s
 * input plus the synthetic `_itensFlat` field. We avoid `z.input` here
 * because `.passthrough()` adds an `[x: string]: unknown` index
 * signature that defeats RHF's path inference for `_itensFlat`.
 */
export interface PedidoFormState {
  ehSaida: boolean;
  hasUserInteraction: boolean | null;
  estado:
    | 'iniciado'
    | 'carrinho'
    | 'carrinhoAbandonado'
    | 'escolhendoFormaDePagamento'
    | 'aguardandoConfirmacaoDePagamento'
    | 'pagamentoNaoRealizado'
    | 'emAnalise'
    | 'emProcessamento'
    | 'pago'
    | 'estornadoParcialmente'
    | 'estornadoIntegralmente'
    | 'processandoCancelamento'
    | 'cancelado'
    | 'fraude'
    | 'finalizado'
    | 'error';
  numero: string | null;
  vendedorPedidoOuterRef: unknown;
  integracaoPedidoOuterRef: unknown;
  operacaoPedidoOuterRef: unknown;
  clientePedidoOuterRef: unknown;
  enderecoFiscalOuterRef: unknown;
  listaDePrecosOuterRef: unknown;
  entradasRelacionadas: string[] | null;
  saidasRelacionadas: string[] | null;
  chNFeReferenciadas: string[] | null;
  itens: Record<string, ItemDoPedido[]>;
  itensIds: string[];
  itensDevolvidos: Record<string, Record<string, ItemDoPedido[]>> | null;
  freteInicial: unknown;
  valorCobrado: number | null;
  descontoTotal: number;
  valorCusto: number | null;
  valorFreteInicial: number | null;
  custoFreteInicial: number | null;
  valorDevolucao: number | null;
  valorCustoDevolvidos: number | null;
  valorDespesasIncidentes: number | null;
  valorFretesIncidentes: number | null;
  valorComissoes: number | null;
  impostos: number | null;
  timestamp: number | null;
  ultimaModificacao: number | null;
  dataFinalExpedicao: number | null;
  dataIndisponivelEstoque: number | null;
  dataRemocaoEstoque: number | null;
  lastMarketplaceUpdate: number | null;
  foiImpresso: boolean;
  dtImpressao: number | null;
  bloquearEmissaoNFe: boolean | null;
  observacoesInternas: string | null;
  infCpl: string | null;
  error: string | null;
  _itensFlat: FlatItem[];
}
