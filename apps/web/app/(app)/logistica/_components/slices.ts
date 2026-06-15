import type { IntegracaoFrete } from '@delfrance/schemas';

/**
 * The four `/logistica/*` screens are slices of the single `int_frete`
 * collection, discriminated by `tipo` (same pattern as `/canais/balcao` over
 * `integracao`). Each slice pins its `tipo` on create and scopes the list
 * query; the form differences are just which schema fields are shown.
 *
 * `mapa` (marketplace → internal routing) is excluded everywhere — it has no
 * UI yet (marketplace freight is read-only for now); existing values survive
 * untouched because ObjectView only writes dirty fields.
 */
export interface LogisticaSlice {
  /** Route segment under /logistica. */
  slug: 'retirada' | 'motoboy' | 'fob' | 'melhor-envios';
  /** `INTEGRACOES_FRETE` wire slug pinned on this screen. */
  tipo: IntegracaoFrete;
  titulo: string;
  tituloNovo: string;
  descricao: string;
  novoLabel: string;
  /** Slice-specific exclusions on top of the shared ones. */
  extraExcluded: readonly string[];
  /** ObjectView tabs — only tabs whose fields aren't excluded on the slice. */
  sections: readonly string[];
}

/** Hidden on every slice: pinned/stamped/no-UI-yet fields. */
export const SHARED_EXCLUDED = ['tipo', 'dataCadastro', 'mapa'] as const;

/** Tab names — `intFreteFields` assigns the special editors to them; every
 * unsectioned field lands on the first tab. */
export const SECTION = {
  geral: 'Dados gerais',
  enderecoOrigem: 'Endereço de origem',
  faixasCep: 'Faixas de CEP',
  horarios: 'Horários de corte',
} as const;

export const LOGISTICA_SLICES: Record<LogisticaSlice['slug'], LogisticaSlice> = {
  retirada: {
    slug: 'retirada',
    tipo: 'retiradaNaLoja',
    titulo: 'Retirada na loja',
    tituloNovo: 'Nova retirada na loja',
    descricao: 'Pontos de retirada (balcão) com horários de corte para disponibilidade.',
    novoLabel: 'Nova retirada',
    extraExcluded: ['faixaCep', 'client_id', 'client_secret'],
    sections: [SECTION.geral, SECTION.enderecoOrigem, SECTION.horarios],
  },
  motoboy: {
    slug: 'motoboy',
    tipo: 'motoboy',
    titulo: 'Motoboy',
    tituloNovo: 'Novo motoboy',
    descricao: 'Entrega local por motoboy — tarifas por faixa de CEP e horários de corte.',
    novoLabel: 'Novo motoboy',
    extraExcluded: ['client_id', 'client_secret'],
    sections: [SECTION.geral, SECTION.faixasCep, SECTION.horarios, SECTION.enderecoOrigem],
  },
  fob: {
    slug: 'fob',
    tipo: 'fob',
    titulo: 'Por conta do destinatário (FOB)',
    tituloNovo: 'Novo frete FOB',
    descricao: 'Entrega organizada e paga pelo destinatário.',
    novoLabel: 'Novo FOB',
    extraExcluded: ['faixaCep', 'client_id', 'client_secret'],
    sections: [SECTION.geral, SECTION.enderecoOrigem, SECTION.horarios],
  },
  'melhor-envios': {
    slug: 'melhor-envios',
    tipo: 'melhorEnvios',
    titulo: 'Melhor Envios',
    tituloNovo: 'Nova conta Melhor Envios',
    descricao:
      'Contas Melhor Envios — endereço de origem das cotações. As credenciais do app (Client ID/Secret) ficam no ambiente, não por conta.',
    novoLabel: 'Nova conta',
    // client_id/client_secret are app-wide ME credentials (one registered ME
    // application), read from env on the server — not collected per-integration.
    extraExcluded: ['faixaCep', 'client_id', 'client_secret'],
    sections: [SECTION.geral, SECTION.enderecoOrigem, SECTION.horarios],
  },
};
