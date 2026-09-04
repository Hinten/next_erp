'use client';

import type { FieldConfig } from '@delfrance/ui';
import {
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
} from '../../_components/integracaoFieldOverrides';

/**
 * Field config shared by the Mercado Livre create and edit screens.
 *
 * The outer-ref selectors the later ML milestones consume — filial + operações
 * (order import), tabelas de preço (price sync), depósito (stock push) — plus
 * `cor`/`nome`/`ativo`/`padrao` now come from
 * `integracaoFieldsCompartilhados`, the single definition every channel screen
 * shares; `canal` is what names them "do Mercado Livre". Only the ML-only field
 * below lives here.
 */
export const mercadoLivreFields: Record<string, FieldConfig> = {
  ...integracaoFieldsCompartilhados({ canal: 'Mercado Livre' }),
  modoEnvioMercadoLivre: {
    label: 'Modo de envio',
    hint: 'Enviado em toda publicação e republicação desta conta. Vazio: não enviar o modo — o Mercado Livre aplica o padrão da conta.',
  },
};

/**
 * Fields hidden from the Mercado Livre form:
 *  - `tipo` is pinned to 1 (mercadoLivre) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao` stay out of this
 *    first slice (surfaced later by the milestone that consumes them). `cor`
 *    was in that group and has now been surfaced — /produtos consumes it.
 *  - `dataCadastro` is stamped automatically on create.
 *  - every OTHER channel's flat account field (#289) is irrelevant here, and
 *    left visible each renders as a raw number/text input.
 *  - `user_id` IS this channel's own field, hidden anyway: it is stamped by the
 *    OAuth connect flow (`serverOwnedFields` on `integracaoMeta`), never
 *    hand-edited — hence the explicit `extra`, since the shared rule keeps the
 *    owner's own fields visible.
 */
export const mercadoLivreExcludedFields = integracaoExcludedFields('mercadoLivre', ['user_id']);
