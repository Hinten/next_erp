'use client';

import type { FieldConfig } from '@delfrance/ui';
import {
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
} from '../../_components/integracaoFieldOverrides';

/**
 * Field config shared by the Shopee create and edit screens.
 *
 * The outer-ref selectors the later Shopee steps consume — filial + operações
 * (order import), tabelas de preço (price sync), depósito (stock push) — plus
 * `cor`/`nome`/`ativo`/`padrao` come from `integracaoFieldsCompartilhados`, the
 * single definition every channel screen shares. `canal` names them, and
 * `generoCanal: 'f'` is what makes the hints read "da Shopee" / "à Shopee"
 * instead of the masculine contraction every other channel uses today.
 *
 * ## Why `shop_id` and `main_account_id` are visible but not editable
 *
 * Both are written by the OAuth callback through the Admin SDK, from the id
 * class the seller actually consented to. Surfacing them read-only is what lets
 * an operator confirm WHICH Shopee shop a conta is bound to without opening a
 * console — and `editable: false` is enough to keep the form from fighting that
 * writer: `saveRecord` sends only the dirty patch on an update, so a field the
 * form never marks dirty is never written at all.
 *
 * They are deliberately NOT promoted to `integracaoMeta.serverOwnedFields`.
 * That list is a Firestore-rules concern — changing it means regenerating both
 * rulesets, refreshing two snapshots and coordinating a rules deploy — and
 * neither field is a routing key the rules have to defend.
 *
 * ## Why `tabelasAtacado` is hidden
 *
 * It is an array of objects, and `ObjectView` renders that through
 * `FieldRenderer`'s `'array'` branch as a plain text input holding raw JSON — an
 * editor that can only corrupt the value. Step 13 (price sync) owns the real
 * editor, with the staged-deletion affordance the repo requires for destructive
 * edits inside a form.
 */
export const shopeeFields: Record<string, FieldConfig> = {
  ...integracaoFieldsCompartilhados({ canal: 'Shopee', generoCanal: 'f' }),
  shop_id: {
    label: 'Shop ID',
    editable: false,
    hint: 'Preenchido pela conexão OAuth — a Shopee informa a loja no retorno do consentimento. Para trocar de loja, reconecte a conta.',
  },
  main_account_id: {
    label: 'Main Account ID',
    editable: false,
    hint: 'Preenchido pela conexão OAuth quando o consentimento é da conta principal (multi-loja), no lugar do Shop ID.',
  },
};

/**
 * Fields hidden from the Shopee form: the system stamps, every OTHER channel's
 * flat account field (#289 — left visible each renders as a raw number/text
 * input on a form that has no business writing it), and this channel's own
 * `tabelasAtacado` for the reason above.
 */
export const shopeeExcludedFields = integracaoExcludedFields('shopee', ['tabelasAtacado']);
