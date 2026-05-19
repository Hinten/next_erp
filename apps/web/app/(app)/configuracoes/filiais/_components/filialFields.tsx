import type { FieldConfig } from '@delfrance/ui';
import { CnpjInput } from './CnpjInput';

/**
 * `fields` overrides shared by the Filial create and edit `ObjectView`s.
 *
 * - `cnpj` → masked CNPJ-only input.
 * - `sede` → the embedded `enderecoSchema` carries NFe-recebedor fields
 *   (`nome`, `cpf_cnpj`, `rg`, …) that don't belong to a branch's physical
 *   address; hide them so the fieldset only shows location fields.
 */
export const filialObjectFields: Record<string, FieldConfig> = {
  cnpj: { renderInput: CnpjInput },
  sede: {
    fields: {
      idExterno: { hidden: true },
      nome: { hidden: true },
      cpf_cnpj: { hidden: true },
      rg: { hidden: true },
      ie: { hidden: true },
      imun: { hidden: true },
      email: { hidden: true },
      telefone: { hidden: true },
    },
  },
};
