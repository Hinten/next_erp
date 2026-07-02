'use client';

import type { FieldConfig } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';

/**
 * Field config shared by the Mercado Livre create and edit screens — the
 * shared `integracao` outer-ref selectors the later ML milestones consume:
 * filial + operações (order import), tabelas de preço (price sync) and
 * depósito (stock push). Mirrors the Balcão overrides.
 */
export const mercadoLivreFields: Record<string, FieldConfig> = {
  filialIntegracaoPedidoOuterRef: {
    label: 'Filial',
    hint: 'Filial dos pedidos importados do Mercado Livre.',
    renderInput: filialRefRenderInput(true),
  },
  tabelaNormalOuterRef: {
    label: 'Tabela de preços',
    renderInput: refRenderInput(listaDePrecosCollection, true),
  },
  tabelaPromocionalOuterRef: {
    label: 'Tabela promocional',
    renderInput: refRenderInput(listaDePrecosCollection, false),
  },
  operacaoOuterRef: {
    label: 'Operação fiscal',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  operacaoDevolucaoOuterRef: {
    label: 'Operação de devolução',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  depositoOuterRef: {
    label: 'Depósito',
    hint: 'Depósito de onde o estoque é enviado ao Mercado Livre.',
    renderInput: refRenderInput(depositoCollection, true),
  },
  nome: { label: 'Nome' },
  ativo: { label: 'Ativo' },
  padrao: { label: 'Padrão' },
};

/**
 * Fields hidden from the Mercado Livre form:
 *  - `tipo` is pinned to 1 (mercadoLivre) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao`, `cor` stay out of
 *    this first slice (surfaced later by the milestone that consumes them).
 *  - `dataCadastro` is stamped automatically on create.
 */
export const mercadoLivreExcludedFields = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'cor',
  'dataCadastro',
];
