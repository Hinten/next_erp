import { buildClienteTelefonePatch } from '@delfrance/schemas';
import { CnpjLookupField } from '@/components/inputs/CnpjLookupField';
import { ClienteTelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import {
  TelefonesAdicionaisField,
  prepareForSaveTelefonesAdicionais,
} from '@/components/inputs/TelefonesAdicionaisInput';

export const CLIENTE_FORM_FIELDS = {
  cpf_cnpj: { renderInput: CnpjLookupField },
  telefone: {
    label: 'Telefone principal',
    renderInput: ClienteTelefoneField,
    prepareForSave: prepareForSaveTelefone,
  },
  telefonesAdicionais: {
    renderInput: TelefonesAdicionaisField,
    prepareForSave: prepareForSaveTelefonesAdicionais,
  },
};

export function deriveClienteTelefonePatch(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
) {
  return buildClienteTelefonePatch(current, { tipo: 'manual', patch });
}

/** The cutover phone migration normalizes ALL stored clientes before runtime, including unmanaged ones. Copy contact details as editable input, excluding the source history and identity. */
export function prepareClienteCopy(source: Readonly<Record<string, unknown>>) {
  const phone = source.telefone;
  return {
    ...source,
    telefone:
      typeof phone === 'string' && phone !== '' && !phone.startsWith('+') ? `+${phone}` : phone,
    telefonesAdicionais: [],
    telefoneGerenciado: false,
    userCliente: null,
  };
}
