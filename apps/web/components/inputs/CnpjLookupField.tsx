'use client';

import { createContext, useContext, useRef, useState } from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useFormContext } from 'react-hook-form';
import type { FieldRenderProps } from '@delfrance/ui';
import { CpfCnpjTextInput } from './CpfCnpjInput';
import { type ClienteCnpjEndereco, cleanCnpj } from '@/lib/clientes/consultaCnpj';
import { resolveCnpj } from '@/lib/clientes/resolveCnpj';
import { useNFeClient } from '@/lib/nfe/client';

/**
 * Page-level wiring for {@link CnpjLookupField}, passed via context so the
 * shared `CLIENTE_FORM_FIELDS` (which ObjectView identity-tracks) stays a stable
 * module constant instead of a per-render closure.
 */
export interface CnpjLookupConfig {
  /** Filial whose A1 certificate signs the SEFAZ Consulta Cadastro call. */
  filialId?: string;
  /**
   * Called with the resolved address so the page can offer to register it, or
   * with `null` to retract a previously offered one (a no-address lookup, or an
   * edit to the CNPJ after a successful lookup).
   */
  onAddressResolved?: (endereco: ClienteCnpjEndereco | null) => void;
}

const CnpjLookupContext = createContext<CnpjLookupConfig>({});

/** Provide the filial + address-offer wiring to a `CnpjLookupField` subtree. */
export const CnpjLookupConfigProvider = CnpjLookupContext.Provider;

const SET_OPTS = { shouldDirty: true, shouldValidate: true } as const;

/**
 * CPF/CNPJ input that adds a "buscar dados" action — **regardless of the
 * selected tipo** (#293). Hybrid lookup: a public CNPJ API fills razão social
 * (`nome`) + endereço, and SEFAZ Consulta Cadastro confirms the authoritative
 * inscrição estadual (`ie`). Mirrors the ViaCEP "Buscar CEP" affordance on
 * `CepField` — the button is a `rightSection` icon, **always shown and
 * clickable**; it validates on click (an invalid/empty CNPJ shows the error
 * message instead of calling the API). A successful lookup switches `tipo` to
 * Pessoa Jurídica (a CNPJ ⇒ PJ; PF + CNPJ is rejected by the schema).
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
  // True once a lookup has offered an address upward — lets us retract it on the
  // next CNPJ edit so a stale address is never relayed for the wrong cliente.
  const offeredRef = useRef(false);

  const doc = (value as string | null | undefined) ?? '';
  // BrasilAPI keys off the 14-digit numeric CNPJ; gate the button on that —
  // regardless of the selected tipo (a valid CNPJ is lookable from any tipo).
  const isCnpj = /^\d{14}$/.test(cleanCnpj(doc));

  async function buscarDados() {
    // Validate on click (the button is always enabled): an invalid/empty CNPJ
    // surfaces the message and never hits the API.
    if (!isCnpj) {
      setLookupError('Informe um CNPJ válido (14 dígitos) para buscar os dados.');
      return;
    }
    setLoading(true);
    setLookupError(null);
    try {
      const outcome = await resolveCnpj(doc, nfe, filialId);
      if (!outcome.ok) {
        setLookupError(
          outcome.reason === 'network'
            ? 'Falha de rede ao consultar o CNPJ.'
            : outcome.reason === 'invalid-response'
              ? 'Resposta inválida da API de CNPJ.'
              : 'CNPJ não encontrado na base pública.',
        );
        return;
      }
      const { nome, ie, endereco, sefazNote } = outcome.data;
      // A CNPJ belongs to a Pessoa Jurídica — switch the tipo so the form stays
      // valid (the schema rejects PF + CNPJ) and the IE applies.
      const switchedToPJ = watch('tipo') !== '1';
      if (switchedToPJ) setValue('tipo', '1', SET_OPTS);
      setValue('nome', nome, SET_OPTS);
      if (ie) setValue('ie', ie, SET_OPTS);

      // Hand the result up — null too, so a no-address lookup retracts any
      // address a previous lookup offered for this same field.
      onAddressResolved?.(endereco);
      offeredRef.current = endereco !== null;

      // Announce the silent tipo change so the operator notices it.
      const tipoNote = switchedToPJ ? 'Tipo alterado para Pessoa Jurídica. ' : '';
      if (ie) {
        notifications.show({
          color: 'green',
          message: `${tipoNote}Dados de ${nome} preenchidos (IE ${ie})`,
        });
      } else {
        // No IE — surface the reason so the operator can distinguish a genuine
        // "no registration" from a coverage gap, and knows to type the IE.
        const why = sefazNote ?? 'IE não disponível';
        notifications.show({
          color: 'yellow',
          message: `${tipoNote}Dados de ${nome} preenchidos. ${why} — preencha a IE manualmente.`,
        });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <CpfCnpjTextInput
      value={doc}
      onChange={(next) => {
        setLookupError(null);
        // Editing the CNPJ invalidates any address a prior lookup offered.
        if (offeredRef.current) {
          offeredRef.current = false;
          onAddressResolved?.(null);
        }
        onChange(next);
      }}
      onBlur={onBlur}
      label={label}
      description={hint}
      error={lookupError ?? error}
      disabled={disabled}
      rightSection={
        <Tooltip label="Buscar dados do CNPJ (razão social, IE, endereço)" withArrow>
          <ActionIcon
            type="button"
            variant="subtle"
            onClick={buscarDados}
            loading={loading}
            disabled={disabled}
            aria-label="Buscar dados do CNPJ"
          >
            <IconSearch size={16} />
          </ActionIcon>
        </Tooltip>
      }
    />
  );
}
