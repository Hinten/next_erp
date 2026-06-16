'use client';

import { useState } from 'react';
import { ActionIcon, TextInput, Tooltip } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useFormContext } from 'react-hook-form';
import type { FieldRenderProps } from '@delfrance/ui';
import { type EnderecoViaCep, buscarCep, cleanCep } from '@/lib/endereco/viaCep';

/** Display mask `#####-###` over the clean 8-digit value. */
function maskCep(clean: string): string {
  const d = cleanCep(clean);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export interface CepTextInputProps {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  /** Called with the resolved address when "Buscar CEP" succeeds. */
  onFound: (endereco: EnderecoViaCep) => void;
  label?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

/**
 * CEP input with a live `#####-###` mask (emits the clean 8 digits) and a
 * "Buscar CEP" button that resolves the address via ViaCEP. The caller fills
 * the sibling fields from `onFound` (the schema-driven `CepField` adapter does
 * it through the RHF form context; `EnderecoOrigemInput` patches its object).
 */
export function CepTextInput({
  value,
  onChange,
  onBlur,
  onFound,
  label = 'CEP',
  error,
  disabled,
  required,
}: CepTextInputProps) {
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const complete = cleanCep(value).length === 8;

  async function buscar() {
    if (!complete) return;
    setLoading(true);
    setLookupError(null);
    try {
      const found = await buscarCep(value);
      if (found) onFound(found);
      else setLookupError('CEP não encontrado.');
    } catch (err) {
      if (err instanceof TypeError) {
        setLookupError('Falha de rede ao buscar o CEP.');
        return;
      }
      if (err instanceof SyntaxError) {
        setLookupError('Resposta inválida do ViaCEP.');
        return;
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }

  return (
    <TextInput
      label={label}
      value={maskCep(value)}
      onChange={(e) => {
        setLookupError(null);
        onChange(cleanCep(e.currentTarget.value));
      }}
      onBlur={onBlur}
      error={lookupError ?? error}
      disabled={disabled}
      required={required}
      inputMode="numeric"
      maxLength={9}
      rightSection={
        <Tooltip label="Buscar endereço (ViaCEP)" withArrow>
          <ActionIcon
            variant="subtle"
            onClick={buscar}
            loading={loading}
            disabled={disabled || !complete}
            aria-label="Buscar CEP"
          >
            <IconSearch size={16} />
          </ActionIcon>
        </Tooltip>
      }
    />
  );
}

/**
 * ObjectView `renderInput` adapter. Autofills the sibling address fields via
 * the form context ObjectView exposes (`<FormProvider>`), so a successful CEP
 * lookup fills logradouro/bairro/cidade/estado/codigoMunicipio.
 */
export function CepField({ value, onChange, onBlur, error, label, disabled }: FieldRenderProps) {
  const { setValue } = useFormContext();
  return (
    <CepTextInput
      value={(value as string | null | undefined) ?? ''}
      onChange={onChange}
      onBlur={onBlur}
      label={label}
      error={error}
      disabled={disabled}
      onFound={(found) => {
        // Only overwrite a sibling when ViaCEP actually returned a value —
        // otherwise a city-wide CEP (empty logradouro/bairro) would clear what
        // the user already typed or set a required field to ''. Bairro keeps
        // its 'SEM BAIRRO' fallback (the schema default).
        const opts = { shouldDirty: true, shouldValidate: true } as const;
        if (found.logradouro) setValue('logradouro', found.logradouro, opts);
        setValue('bairro', found.bairro || 'SEM BAIRRO', opts);
        if (found.cidade) setValue('cidade', found.cidade, opts);
        if (found.estado) setValue('estado', found.estado, opts);
        if (found.codigoMunicipio) {
          setValue('codigoMunicipio', found.codigoMunicipio, { shouldDirty: true });
        }
      }}
    />
  );
}
