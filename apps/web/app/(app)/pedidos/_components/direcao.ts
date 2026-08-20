/**
 * Direction parametrization for the pedidos surface. The list / novo / editar
 * pages are shared between the two directions of the single `pedidos`
 * collection — `ehSaida: true` (saída / sale, `/pedidos`) and `ehSaida: false`
 * (entrada / inbound, `/pedidos/entradas`). Every route, label and toast that
 * differs by direction lives here so the views stay direction-agnostic.
 */

export type Direcao = 'saida' | 'entrada';

export interface DirecaoConfig {
  ehSaida: boolean;
  listPath: string;
  novoPath: string;
  editarPath: (id: string) => string;
  listTitle: string;
  listDescription: string;
  novoTitle: string;
  newButtonLabel: string;
  docLabel: string;
  savedToast: string;
}

export const DIRECAO: Record<Direcao, DirecaoConfig> = {
  saida: {
    ehSaida: true,
    listPath: '/pedidos',
    novoPath: '/pedidos/novo',
    editarPath: (id) => `/pedidos/${id}/editar`,
    listTitle: 'Pedidos',
    listDescription: 'Selecione pedidos e use o botão acima da tabela para emitir NF-e.',
    novoTitle: 'Novo pedido',
    newButtonLabel: 'Novo pedido',
    docLabel: 'Pedido',
    savedToast: 'Pedido salvo.',
  },
  entrada: {
    ehSaida: false,
    listPath: '/pedidos/entradas',
    novoPath: '/pedidos/entradas/novo',
    editarPath: (id) => `/pedidos/entradas/${id}/editar`,
    listTitle: 'Entradas',
    listDescription: 'Entradas de mercadoria — compras e devoluções.',
    novoTitle: 'Nova entrada',
    newButtonLabel: 'Nova entrada',
    docLabel: 'Entrada',
    savedToast: 'Entrada salva.',
  },
};

/**
 * Direction of a loaded doc. Only an explicit `false` means entrada — `true`,
 * `null` and `undefined` all resolve to saída, matching the schema default
 * (`ehSaida: z.boolean().default(true)`).
 */
export function direcaoOf(ehSaida: boolean | null | undefined): Direcao {
  return ehSaida === false ? 'entrada' : 'saida';
}

/**
 * Guard for `?copiarDe=<id>` (#370): the direction the duplicate ACTUALLY
 * belongs to when it disagrees with the create route it was opened on, or
 * `null` when they agree.
 *
 * A duplicate keeps the origin's `ehSaida` — the seed does not force one, and
 * a pedido's direction is immutable — so the two can only disagree on a
 * hand-edited URL (the `Duplicar` row action always targets the list's own
 * direction). That case has to be blocked rather than rendered, because the
 * two halves of the page would then disagree: `PedidoForm` takes `ehSaida`
 * from `defaultValues` (`buildDefaults` spreads `...existing` over the prop),
 * while `useCreatePedidoSubmit` follows the ROUTE — so an entrada opened at
 * `/pedidos/novo?copiarDe=…` would save as an entrada, then prompt for a saída
 * NF-e and navigate to the saída edit route.
 */
export function direcaoIncompativelDaCopia(
  ehSaidaOrigem: boolean | null | undefined,
  direcaoDaPagina: Direcao,
): Direcao | null {
  const origem = direcaoOf(ehSaidaOrigem);
  return origem === direcaoDaPagina ? null : origem;
}
