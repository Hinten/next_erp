'use client';

import type { FieldConfig } from '@delfrance/ui';

/**
 * Field config shared by the Mercado Pago create and edit screens. Only
 * `nome` and `hasLinkPagamento` are user-editable — the schema doesn't
 * `.describe()` either field (no other `metodo_pgto` consumer needed a UI
 * label yet), so labels are set explicitly here. Mirrors the Mercado Livre
 * overrides.
 */
export const metodoPagamentoFields: Record<string, FieldConfig> = {
  nome: { label: 'Nome' },
  hasLinkPagamento: {
    label: 'Aceita link de pagamento',
    hint: 'Habilita a geração de links de cobrança Mercado Pago para esta conta.',
  },
};

/**
 * Fields hidden from the Mercado Pago form:
 *  - `tipo` is pinned to `TIPO_INTEGRACAO_PGTO.mercadoPago` in defaultValues
 *    — never user-pickable (today the only gateway).
 *  - `user_id` is server-denormalized at OAuth exchange (the connected MP
 *    collector id) — display-only, surfaced in `ContaMercadoPagoPanel`
 *    instead of as a form field.
 *  - `dataCadastro` / `ultimaModificacao` are stamped by `saveRecord`.
 */
export const metodoPagamentoExcludedFields = [
  'tipo',
  'user_id',
  'dataCadastro',
  'ultimaModificacao',
];
