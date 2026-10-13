'use client';

import type { FieldConfig } from '@delfrance/ui';
import {
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
} from '../../_components/integracaoFieldOverrides';

/**
 * Field config shared by the Loja Integrada create and edit screens: the six
 * outer-ref selectors the later steps consume (filial + operações for order
 * import, tabelas de preço for price sync, depósito for stock push), plus
 * `cor`/`nome`/`ativo`/`padrao`, straight from `integracaoFieldsCompartilhados`.
 * `canal` names the channel and `generoCanal: 'f'` makes the hints read "da Loja
 * Integrada" / "à Loja Integrada" instead of the masculine contraction.
 *
 * Unlike Shopee and WhatsApp this channel keeps NO flat account field on the
 * `integracao` document. The store's credential lives in an admin-only
 * subcollection written by `apps/loja-integrada`, never in a field this form
 * could show or overwrite, so there is nothing to surface read-only and no
 * `CAMPOS_POR_CANAL` entry to add.
 */
export const lojaIntegradaFields: Record<string, FieldConfig> = integracaoFieldsCompartilhados({
  canal: 'Loja Integrada',
  generoCanal: 'f',
});

/**
 * Fields hidden from the Loja Integrada form: the system stamps and EVERY
 * channel's flat account field (#289). This channel owns none of them, so
 * `dono` is `null` (the Balcão precedent) and the shared rule excludes them all;
 * left visible they would render as raw number/text inputs on a form that has no
 * business writing them.
 */
export const lojaIntegradaExcludedFields = integracaoExcludedFields(null);
