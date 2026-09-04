'use client';

import type { FieldConfig } from '@delfrance/ui';
import {
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
} from '../../_components/integracaoFieldOverrides';

/**
 * Field config for the Balcão create and edit screens: the six outer-ref
 * selectors + the `cor` colour picker + `nome`/`ativo`/`padrao`, straight from
 * the shared `integracaoFieldsCompartilhados`. A counter register belongs to no
 * marketplace, so it names no `canal` — which is also why its Filial and
 * Depósito fields carry no hint, exactly as they ship today.
 */
export const balcaoFields: Record<string, FieldConfig> = integracaoFieldsCompartilhados();

/**
 * Fields hidden from the Balcão form:
 *  - `tipo` is pinned to 7 (balcao) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao` are marketplace-
 *    oriented and irrelevant for a counter register.
 *  - `dataCadastro` is stamped automatically on create.
 *  - EVERY channel's flat account field (#289) — Balcão owns none of them, so
 *    `dono` is `null` and the shared rule excludes them all; left visible they
 *    would render as raw number/text inputs on a counter register's form.
 */
export const balcaoExcludedFields = integracaoExcludedFields(null);
