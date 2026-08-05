import type { FieldConfig } from '@delfrance/ui';
import { CepField } from './CepInput';

/**
 * Recebedor (NFe destinatário) + system/derived keys hidden on every embedded
 * `enderecoSchema` address form. The recebedor fields belong to a separate
 * editor; `idExterno` is a system id; `cPais`/`pais` default to Brazil; and
 * `codigoMunicipio` (IBGE) is filled by the CEP lookup, never typed.
 *
 * Single source of truth shared by the cliente address modal
 * (`EnderecoFormModal`, top-level render → `excludedFields`) and the embedded
 * forms (filial `sede`, freight `enderecoDeOrigem`, via `enderecoNestedFields`).
 */
export const ENDERECO_HIDDEN_KEYS = [
  'nome',
  'cpf_cnpj',
  'rg',
  'ie',
  'imun',
  'email',
  'telefone',
  'idExterno',
  'cPais',
  'pais',
  'codigoMunicipio',
  // System stamps — written by `saveRecord` / ObjectView, never form inputs.
  'timestamp',
  'ultimaModificacao',
] as const;

/**
 * Per-sub-field `fields` overrides for an embedded endereço: hide the keys in
 * `ENDERECO_HIDDEN_KEYS` and wire the CEP field's "Buscar CEP" (ViaCEP) lookup,
 * which autofills logradouro/bairro/cidade/estado/IBGE. `CepField` resolves the
 * sibling paths relative to its own field name, so it works nested.
 */
export const enderecoNestedFields: Record<string, FieldConfig> = {
  ...Object.fromEntries(ENDERECO_HIDDEN_KEYS.map((k) => [k, { hidden: true }])),
  cep: { renderInput: CepField },
};
