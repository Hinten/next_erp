import type { FieldConfig } from '@delfrance/ui';
import { enderecoNestedFields } from '@/components/inputs/enderecoFields';
import { CnpjInput } from './CnpjInput';

/**
 * `fields` overrides shared by the Filial create and edit `ObjectView`s.
 *
 * - `cnpj` → masked CNPJ-only input.
 * - `sede` → the embedded `enderecoSchema`. Reuses the shared
 *   `enderecoNestedFields`: hides the recebedor/system fields that don't belong
 *   to a branch's physical address and wires the CEP "Buscar CEP" (ViaCEP)
 *   lookup — the same address config the cliente modal and freight origin use.
 */
export const filialObjectFields: Record<string, FieldConfig> = {
  cnpj: { renderInput: CnpjInput },
  sede: { fields: enderecoNestedFields },
};
