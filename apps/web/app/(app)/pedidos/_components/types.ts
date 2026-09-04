import type { EstadoFrete, ItemDoPedido, ModalidadeFrete } from '@delfrance/schemas';

/**
 * A flat item row used by the form's `useFieldArray`. Carries a
 * synthetic `_rowId` so RHF can key stable rows even when the user
 * reorders or removes them, plus a transient `_delete` flag for staged
 * deletion (the row stays visible+dimmed until the pedido is saved). Both
 * synthetic fields are stripped on submit by `pedidoResolver`.
 */
export type FlatItem = ItemDoPedido & { _rowId: string; _delete?: boolean };

/**
 * RHF-friendly mirrors of the `freteDoPedidoSchema` nested shapes. Like
 * `PedidoFormState` itself, these are hand-written instead of `z.infer`
 * because `.passthrough()` adds an `[x: string]: unknown` index signature
 * that defeats RHF's path inference (e.g. `freteInicial.valorCobrado`).
 * All field names are the Flutter wire names.
 */
export interface TransportadoraFormState {
  cnpj: string | null;
  ie: string | null;
  nome: string | null;
  endereco: string | null;
  municipio: string | null;
  uf: string | null;
}

export interface DimensoesFormState {
  altura: number;
  largura: number;
  comprimento: number;
}

export interface VolumeFormState {
  quantidade: number | null;
  especie: string | null;
  marca: string | null;
  numero: string | null;
  pesoBruto: number | null;
  pesoLiquido: number | null;
  dimensoes: DimensoesFormState | null;
  lacres: string[] | null;
}

/**
 * `pedido.freteInicial` as held by the form. Mirrors `freteDoPedidoSchema`
 * — every key Flutter writes, ms-epoch ints for dates, `documents/...`
 * path strings for the outer refs. `veiculo`/`reboques` have no editor in
 * the Frete tab (the legacy tab had none either) and pass through opaque.
 */
export interface FreteInicialFormState {
  externalId: string | null;
  printLabelId: string | null;
  externalOptionId: string | null;
  externalOptionIntegracao: string | null;
  externalOptionData: Record<string, unknown> | null;
  externalOptionSelectionDate: number | null;
  estado: EstadoFrete;
  integracaoFreteOuterRef: unknown;
  integracaoTargetOuterRef: unknown;
  integracao_path: string | null;
  clienteRecebedorOuterReference: unknown;
  enderecoFreteOuterReference: unknown;
  modalidade: ModalidadeFrete;
  transportadora: TransportadoraFormState | null;
  veiculo: unknown;
  reboques: unknown;
  vagao: string | null;
  balsa: string | null;
  volumes: VolumeFormState[] | null;
  codRastreio: string | null;
  valorCobrado: number | null;
  custoCalculado: number | null;
  custoFinal: number | null;
  ehReverso: boolean;
  prazoExtra: number;
  prazoDespacho: number | null;
  dataEntrega: number | null;
  dataPrevisaoEntrega: number | null;
  valor_assegurado: number | null;
  maoPropria: boolean | null;
  avisoRecebimento: boolean | null;
  ultimaModificacao: number | null;
  timestamp: number | null;
}

/**
 * The shape RHF holds for the pedido form. Mirrors `pedidoSchema`'s
 * input plus the synthetic `_itensFlat` field. We avoid `z.input` here
 * because `.passthrough()` adds an `[x: string]: unknown` index
 * signature that defeats RHF's path inference for `_itensFlat`.
 */
export interface PedidoFormState {
  /**
   * Transient page-model context (NOT written to the doc — both are in the data
   * layer's `NON_DOC_KEYS`). `id` is the pedido doc id (null on create);
   * `ehSaidaOriginal` is `ehSaida` as loaded, so the resolver can enforce that
   * the direction flag can't flip on an existing order.
   */
  id: string | null;
  ehSaidaOriginal: boolean | null;
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
  freteInicial: FreteInicialFormState | null;
  valorCobrado: number | null;
  descontoTotal: number;
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
