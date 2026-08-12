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
