'use client';

import type { FieldConfig } from '@delfrance/ui';
import {
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
  integracaoFieldsIntermediador,
} from '../../_components/integracaoFieldOverrides';

/**
 * Field config shared by the Amazon create and edit screens.
 *
 * - The outer-ref selectors the later Amazon steps consume (filial + operações
 *   for order import, tabelas de preço for price sync, depósito for stock push)
 *   plus `cor`/`nome`/`ativo`/`padrao` come from `integracaoFieldsCompartilhados`.
 *   `generoCanal: 'f'` makes the hints read "da Amazon" / "à Amazon".
 * - The NF-e intermediador pair (`cpf_cnpj`, `idCadIntTran`) comes from
 *   `integracaoFieldsIntermediador`: `buildInfIntermed` throws without both
 *   whenever the operação flags `indIntermed = '1'`, and the migrated conta
 *   carries them. This is the first channel form that shows them, so both
 *   screens also pass `validarIntermediador` as their `ObjectView` `validate`:
 *   the schema alone accepts a `cpf_cnpj` that is not a CNPJ.
 *
 * ## Why `selling_partner_id` is visible but not editable
 *
 * It is the seller the conta is bound to. Its writer is the Amazon OAuth
 * callback (`apps/amazon`, master plan step 2), through the Admin SDK, from the
 * seller that actually consented; a migrated conta arrives with the legacy
 * value. Surfacing it read-only lets an operator confirm WHICH seller a conta
 * is bound to, and `editable: false` keeps the form from fighting that writer:
 * `saveRecord` sends only the dirty patch on an update, so a field the form
 * never marks dirty is never written at all. Binding another seller is a new
 * conta by design (step 2's wrong-seller guard), which is what the hint says.
 */
export const amazonFields: Record<string, FieldConfig> = {
  ...integracaoFieldsCompartilhados({ canal: 'Amazon', generoCanal: 'f' }),
  ...integracaoFieldsIntermediador(),
  selling_partner_id: {
    label: 'Selling Partner ID',
    editable: false,
    hint: 'Preenchido pela conexão OAuth (o retorno da Amazon informa o vendedor). Para trocar de vendedor, crie outra conta.',
  },
};

/**
 * Fields hidden from the Amazon form: the system stamps and every OTHER
 * channel's flat account field (#289 — left visible each renders as a raw
 * number/text input on a form that has no business writing it). This channel's
 * own `selling_partner_id` stays (read-only, above), and `{ intermediador: true }`
 * keeps the intermediador pair; `modalidadeFreteImportacao` stays hidden until
 * the freight milestone surfaces it.
 */
export const amazonExcludedFields = integracaoExcludedFields('amazon', [], { intermediador: true });
