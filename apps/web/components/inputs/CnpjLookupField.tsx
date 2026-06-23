'use client';

import { createContext, useContext, useState } from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useFormContext } from 'react-hook-form';
import type { FieldRenderProps } from '@delfrance/ui';
import { NFeHttpError, NFeNetworkError } from '@delfrance/integrations-nfe/http-provider';
import { CpfCnpjTextInput } from './CpfCnpjInput';
import {
  type ClienteCnpjData,
  type ClienteCnpjEndereco,
  buscarCnpj,
  cleanCnpj,
} from '@/lib/clientes/consultaCnpj';
import { useNFeClient } from '@/lib/nfe/client';

/**
 * Page-level wiring for {@link CnpjLookupField}, passed via context so the
 * shared `CLIENTE_FORM_FIELDS` (which ObjectView identity-tracks) stays a stable
 * module constant instead of a per-render closure.
 */
export interface CnpjLookupConfig {
  /** Filial whose A1 certificate signs the SEFAZ Consulta Cadastro call. */
  filialId?: string;
  /** Called with the resolved address so the page can offer to register it. */
  onAddressResolved?: (endereco: ClienteCnpjEndereco) => void;
}

const CnpjLookupContext = createContext<CnpjLookupConfig>({});

/** Provide the filial + address-offer wiring to a `CnpjLookupField` subtree. */
export const CnpjLookupConfigProvider = CnpjLookupContext.Provider;

const SET_OPTS = { shouldDirty: true, shouldValidate: true } as const;

/**
 * CPF/CNPJ input that adds a "buscar dados" action for **Pessoa Jurídica only**.
 * Hybrid lookup: a public CNPJ API fills razão social (`nome`) + endereço, and
 * SEFAZ Consulta Cadastro confirms the authoritative inscrição estadual (`ie`).
 * Mirrors the ViaCEP "Buscar CEP" affordance on `CepField` — the button is a
 * `rightSection` icon, hidden entirely for PF (`tipo !== '1'`).
 *
 * The SEFAZ leg is best-effort: a missing filial, an unsupported UF or a SEFAZ
 * outage just falls back to the public IE (or leaves `ie` untouched) — it never
 * blocks the cadastro. The returned address (if any) is handed to the page via
 * the context's `onAddressResolved` so it can offer to register it in the
 * enderecos subcollection (which needs the cliente id, not known to this field).
 */
export function CnpjLookupField({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
  disabled,
}: FieldRenderProps) {
  const { filialId, onAddressResolved } = useContext(CnpjLookupContext);
  const { setValue, watch } = useFormContext();
  const nfe = useNFeClient();
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const doc = (value as string | null | undefined) ?? '';
  const isPJ = watch('tipo') === '1';
  // BrasilAPI keys off the 14-digit numeric CNPJ; gate the button on that.
  const isCnpj = /^\d{14}$/.test(cleanCnpj(doc));

  async function buscarDados() {
    setLoading(true);
    setLookupError(null);
    try {
      let pub: ClienteCnpjData | null;
      try {
        pub = await buscarCnpj(doc);
      } catch (err) {
        if (err instanceof TypeError) {
          setLookupError('Falha de rede ao consultar o CNPJ.');
          return;
        }
        if (err instanceof SyntaxError) {
          setLookupError('Resposta inválida da API de CNPJ.');
          return;
        }
        throw err;
      }
      if (!pub) {
        setLookupError('CNPJ não encontrado na base pública.');
        return;
      }

      if (pub.nome) setValue('nome', pub.nome, SET_OPTS);

      // Authoritative IE from SEFAZ Consulta Cadastro (best-effort).
      let sefazIe: string | null = null;
      let sefazTried = false;
      if (nfe && filialId && pub.uf) {
        sefazTried = true;
        try {
          const cad = await nfe.consultaCadastro(cleanCnpj(doc), pub.uf, filialId);
          const habilitada = cad.infCad.find((c) => c.situacao === '1') ?? cad.infCad[0];
          sefazIe = habilitada?.ie ?? null;
        } catch (err) {
          // Consulta Cadastro is advisory — a typed NFe failure just falls back
          // to the public IE. Anything else is a real bug, so rethrow.
          if (!(err instanceof NFeHttpError) && !(err instanceof NFeNetworkError)) throw err;
        }
      }

      const ie = sefazIe ?? pub.ie;
      if (ie) setValue('ie', ie, SET_OPTS);

      if (pub.endereco && onAddressResolved) onAddressResolved(pub.endereco);

      const ieNote = ie ? ` (IE ${ie})` : sefazTried ? ' — IE não retornada pela SEFAZ' : '';
      notifications.show({ color: 'green', message: `Dados de ${pub.nome} preenchidos${ieNote}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <CpfCnpjTextInput
      value={doc}
      onChange={(next) => {
        setLookupError(null);
        onChange(next);
      }}
      onBlur={onBlur}
      label={label}
      description={hint}
      error={lookupError ?? error}
      disabled={disabled}
      rightSection={
        isPJ ? (
          <Tooltip label="Buscar dados do CNPJ (razão social, IE, endereço)" withArrow>
            <ActionIcon
              variant="subtle"
              onClick={buscarDados}
              loading={loading}
              disabled={disabled || !isCnpj}
              aria-label="Buscar dados do CNPJ"
            >
              <IconSearch size={16} />
            </ActionIcon>
          </Tooltip>
        ) : undefined
      }
    />
  );
}
