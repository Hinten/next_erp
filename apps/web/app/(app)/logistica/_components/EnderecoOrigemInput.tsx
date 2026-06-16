'use client';

import { Fieldset, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { ufSchema } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';
import { CepTextInput } from '@/components/inputs/CepInput';
import { childFieldError, rootError } from './editorErrors';

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
  // Brazil by default (NFe country code 1058) — endereços de origem are domestic.
  cPais: '1058',
  pais: 'Brasil',
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
  errorTree,
}: FieldRenderProps) {
  const endereco = (value ?? null) as EnderecoValue | null;
  const enabled = endereco !== null;

  const patch = (p: Partial<EnderecoValue>) => {
    onChange({ ...(endereco ?? EMPTY_ENDERECO), ...p });
  };

  const err = (key: string) => childFieldError(errorTree, key);

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
                error={err('logradouro')}
                required
              />
              <TextInput
                label="Número"
                value={endereco?.numero ?? ''}
                onChange={(e) => patch({ numero: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                error={err('numero')}
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
                error={err('bairro')}
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
              <CepTextInput
                value={endereco?.cep ?? ''}
                onChange={(cep) => patch({ cep })}
                onBlur={onBlur}
                onFound={(f) =>
                  patch({
                    logradouro: f.logradouro,
                    bairro: f.bairro || 'SEM BAIRRO',
                    cidade: f.cidade,
                    estado: f.estado,
                    codigoMunicipio: f.codigoMunicipio,
                  })
                }
                disabled={disabled}
                error={err('cep')}
                required
              />
              <TextInput
                label="Cidade"
                value={endereco?.cidade ?? ''}
                onChange={(e) => patch({ cidade: e.currentTarget.value })}
                onBlur={onBlur}
                disabled={disabled}
                error={err('cidade')}
                required
              />
              <Select
                label="Estado (UF)"
                data={UF_OPTIONS}
                // No 'SP' fallback: a missing estado must render unselected
                // (and fail validation) instead of silently looking set.
                value={endereco?.estado ?? null}
                onChange={(v) => {
                  if (v) patch({ estado: v });
                }}
                onBlur={onBlur}
                disabled={disabled}
                error={err('estado')}
                allowDeselect={false}
                searchable
                maw={120}
              />
            </Group>
          </>
        )}
        {rootError(errorTree, error) && (
          <Text size="xs" c="red">
            {rootError(errorTree, error)}
          </Text>
        )}
      </Stack>
    </Fieldset>
  );
}
