'use client';

import { createContext, useContext, useRef, useState } from 'react';
import { ActionIcon, Button, Group, Modal, Stack, Text, Tooltip } from '@mantine/core';
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

/** A single field the lookup would overwrite, shown in the confirmation diff. */
interface UpdateDiff {
  label: string;
  from: string;
  to: string;
}

/** A resolved lookup pending the operator's "update the cadastro?" confirmation. */
interface PendingUpdate {
  diffs: UpdateDiff[];
  /** Applies the resolved nome/IE + fires the success notification. */
  apply: () => void;
}

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
  const { setValue, watch, getValues } = useFormContext();
  const nfe = useNFeClient();
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  // A resolved lookup that would OVERWRITE existing non-empty nome/IE waits for
  // explicit confirmation (a focused diff) instead of clobbering the cadastro
  // silently — #341. A blank field (the create page) applies straight away.
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
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
      // valid (the schema rejects PF + CNPJ) and the IE applies. The tipo switch
      // and the address offer are non-destructive, so they apply immediately;
      // only the nome/IE overwrite waits for confirmation below.
      const switchedToPJ = watch('tipo') !== '1';
      if (switchedToPJ) setValue('tipo', '1', SET_OPTS);

      // Hand the result up — null too, so a no-address lookup retracts any
      // address a previous lookup offered for this same field. The page's own
      // dedup decides register-new vs open-existing (#341).
      onAddressResolved?.(endereco);
      offeredRef.current = endereco !== null;

      // Writes nome/IE + announces it — applied straight away, or behind the
      // diff modal when it would overwrite existing values.
      const apply = () => {
        setValue('nome', nome, SET_OPTS);
        if (ie) setValue('ie', ie, SET_OPTS);
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
      };

      // Only an overwrite of EXISTING non-empty data needs confirmation; a blank
      // field (the create page) just fills. Never a silent overwrite (#341).
      const curNome = ((getValues('nome') as string | null | undefined) ?? '').trim();
      const curIe = ((getValues('ie') as string | null | undefined) ?? '').trim();
      const diffs: UpdateDiff[] = [];
      if (curNome && curNome !== nome) diffs.push({ label: 'Nome', from: curNome, to: nome });
      if (ie && curIe && curIe !== ie) {
        diffs.push({ label: 'Inscrição estadual', from: curIe, to: ie });
      }

      if (diffs.length > 0) {
        setPendingUpdate({ diffs, apply });
      } else {
        apply();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
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

      {/* #341: a lookup against an existing cadastro confirms before overwriting
          nome/IE — never a silent overwrite. */}
      <Modal
        opened={pendingUpdate !== null}
        onClose={() => setPendingUpdate(null)}
        title="Atualizar dados do cadastro?"
        centered
      >
        <Stack>
          <Text size="sm">
            A consulta retornou dados diferentes dos cadastrados. Deseja atualizá-los?
          </Text>
          {pendingUpdate?.diffs.map((d) => (
            <Text key={d.label} size="sm">
              <b>{d.label}:</b> {d.from} → {d.to}
            </Text>
          ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPendingUpdate(null)}>
              Manter atual
            </Button>
            <Button
              onClick={() => {
                pendingUpdate?.apply();
                setPendingUpdate(null);
              }}
            >
              Atualizar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
