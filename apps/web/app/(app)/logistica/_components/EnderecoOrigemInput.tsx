'use client';

import { Fieldset, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { ufSchema } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';

/**
 * Optional origin-address override (`intFrete.enderecoDeOrigem`). The whole
 * object is nullable — a Switch toggles between `null` (use the filial's
 * sede as origin) and a minimal location sub-form. The full Flutter
 * `Endereco` wire shape is written (unshown recipient/NFe keys stay null).
 */

interface EnderecoValue {
  [key: string]: unknown;
  logradouro?: string;
  numero?: string;
  bairro?: string;
  complemento?: string | null;
  cep?: string;
  cidade?: string;
  estado?: string;
}

const EMPTY_ENDERECO: EnderecoValue = {
  idExterno: null,
  logradouro: '',
  numero: '',
  bairro: '',
  complemento: null,
  cep: '',
  codigoMunicipio: null,
  cidade: '',
  estado: 'SP',
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
};

const UF_OPTIONS = ufSchema.options.map((uf) => ({ value: uf, label: uf }));

export function EnderecoOrigemInput({
  label,
  hint,
  value,
  onChange,
  onBlur,
  disabled,
  error,
}: FieldRenderProps) {
  const endereco = (value ?? null) as EnderecoValue | null;
  const enabled = endereco !== null;

  const patch = (p: Partial<EnderecoValue>) => {
    onChange({ ...(endereco ?? EMPTY_ENDERECO), ...p });
  };

  return (
    <Fieldset legend={label}>
      <Stack gap="sm">
        <Switch
          label="Informar endereço de origem"
          description={hint ?? 'Desligado: a origem dos envios é a sede da filial.'}
          checked={enabled}
          onChange={(e) => onChange(e.currentTarget.checked ? { ...EMPTY_ENDERECO } : null)}
          disabled={disabled}
        />
        {enabled && (
          <>
            <Group grow align="flex-start">
              <TextInput
                label="Logradouro"
                value={endereco?.logradouro ?? ''}
                onChange={(e) => patch({ logradouro: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                required
              />
              <TextInput
                label="Número"
                value={endereco?.numero ?? ''}
                onChange={(e) => patch({ numero: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                required
                maw={120}
              />
            </Group>
            <Group grow align="flex-start">
              <TextInput
                label="Bairro"
                value={endereco?.bairro ?? ''}
                onChange={(e) => patch({ bairro: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                required
              />
              <TextInput
                label="Complemento"
                value={endereco?.complemento ?? ''}
                onChange={(e) =>
                  patch({
                    complemento: e.currentTarget.value === '' ? null : e.currentTarget.value,
                  })
                }
                onBlur={onBlur}
                disabled={disabled}
              />
            </Group>
            <Group grow align="flex-start">
              <TextInput
                label="CEP"
                value={endereco?.cep ?? ''}
                onChange={(e) =>
                  patch({ cep: e.currentTarget.value.replace(/\D/g, '').slice(0, 8) })
                }
                onBlur={onBlur}
                disabled={disabled}
                required
                maw={140}
              />
              <TextInput
                label="Cidade"
                value={endereco?.cidade ?? ''}
                onChange={(e) => patch({ cidade: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                required
              />
              <Select
                label="Estado (UF)"
                data={UF_OPTIONS}
                value={endereco?.estado ?? 'SP'}
                onChange={(v) => {
                  if (v) patch({ estado: v });
                }}
                onBlur={onBlur}
                disabled={disabled}
                allowDeselect={false}
                searchable
                maw={120}
              />
            </Group>
          </>
        )}
        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}
      </Stack>
    </Fieldset>
  );
}
