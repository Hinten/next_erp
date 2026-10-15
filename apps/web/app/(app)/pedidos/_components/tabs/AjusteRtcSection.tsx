'use client';

import { useMemo } from 'react';
import { ActionIcon, Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import type { UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  descreverViolacaoDocumento,
  GRUPO_AJUSTE_RTC,
  grupoDeAjusteDoTipo,
  nomeDoItem,
  REGRA_DOCUMENTO,
  tipoAindaNaoEmitido,
  violacoesDoDocumento,
  type AjusteRtcItem,
  type GrupoAjusteRtc,
  type Pedido,
  type RegraDocumento,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { DecimalInput } from '@delfrance/ui';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import type { FlatItem, PedidoFormState } from '../types';

export interface AjusteRtcSectionProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
}

/** What each group means, in the operator's words. */
const TITULO_DO_GRUPO: Record<GrupoAjusteRtc, string> = {
  [GRUPO_AJUSTE_RTC.transfCred]: 'Transferência de crédito (gTransfCred)',
  [GRUPO_AJUSTE_RTC.ajusteCompet]: 'Ajuste de competência (gAjusteCompet)',
  [GRUPO_AJUSTE_RTC.estornoCred]: 'Estorno de crédito (gEstornoCred)',
  [GRUPO_AJUSTE_RTC.credPresIBSZFM]: 'Crédito presumido de IBS na ZFM (gCredPresIBSZFM)',
};

/** The document rules this section owns — the rest belong to other panels. */
const REGRAS_DO_AJUSTE: ReadonlySet<RegraDocumento> = new Set([
  REGRA_DOCUMENTO.ajusteAusente,
  REGRA_DOCUMENTO.ajusteValorInvalido,
  REGRA_DOCUMENTO.ajusteTransfCredZerado,
  REGRA_DOCUMENTO.ajusteCompetZerado,
  REGRA_DOCUMENTO.ajusteCompetenciaInvalida,
  REGRA_DOCUMENTO.ajusteIndevido,
]);

/**
 * Per-item IBS/CBS amounts of a nota de débito whose tipo binds a fixed
 * cClassTrib (NT 2025.002, #330) — `itens[*].ajusteRtc`. The operação's tipo
 * decides the classification and the group; the operator states the amounts.
 *
 * Shown only for such a tipo, or while an item still holds amounts the current
 * tipo would ignore (so they stay visible and clearable). The panel runs the
 * SAME rules the emission pre-flight refuses with, as warnings: the emission
 * date is unknown here, so a future competência is judged at emission only.
 */
export function AjusteRtcSection({ form, db, disabled }: AjusteRtcSectionProps) {
  const itensFlat = (form.watch('_itensFlat') ?? []) as FlatItem[];
  const operacaoOuterRef = form.watch('operacaoPedidoOuterRef');

  const operacaoRef = useMemo(() => {
    const r = dereferenceOuterRef(db, operacaoOuterRef);
    return r ? operacaoCollection.docRef(db, {}, r.id) : null;
  }, [db, operacaoOuterRef]);
  const { data: operacaoDoc } = useDocSnapshot(operacaoRef);

  const tipo = {
    finNFe: operacaoDoc?.data.finNFe ?? 1,
    tpNFDebito: operacaoDoc?.data.tpNFDebito ?? null,
    tpNFCredito: operacaoDoc?.data.tpNFCredito ?? null,
  };
  const grupo = tipoAindaNaoEmitido(tipo) ? null : grupoDeAjusteDoTipo(tipo);

  const linhas = itensFlat
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item._delete);

  const violacoes = violacoesDoDocumento({
    emitRtc: true, // the filial switch is not on this screen — the emission judges it
    ...tipo,
    tpNF: operacaoDoc?.data.tipo === 1 ? '1' : '0',
    anoEmissao: null,
    mesEmissao: null,
    chNFeReferenciadas: [],
    destinatarioDocumento: null,
    emitenteDocumento: null,
    emitenteCUF: null,
    // Judged by their own editor (and at emission), not by this panel.
    chNFePagamentoAntecipado: [],
    emitenteISUF: null,
    emitenteCMun: null,
    itens: linhas.map(({ item }, i) => ({
      nItem: i + 1,
      dfeReferenciado: null,
      ajusteRtc: item.ajusteRtc ?? null,
    })),
  }).filter((v) => REGRAS_DO_AJUSTE.has(v.regra));

  if (grupo == null && !linhas.some(({ item }) => item.ajusteRtc != null)) return null;

  const setAjuste = (index: number, next: AjusteRtcItem | null) => {
    form.setValue(`_itensFlat.${index}.ajusteRtc`, next, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };
  const limparTodos = () => {
    for (const { item, index } of linhas) if (item.ajusteRtc != null) setAjuste(index, null);
  };
  const comCompetencia = grupo === GRUPO_AJUSTE_RTC.ajusteCompet;

  const erroPageModel = (form.formState.errors as Record<string, { message?: string } | undefined>)
    .ajusteRtc?.message;

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text fw={500}>
          {grupo != null ? TITULO_DO_GRUPO[grupo] : 'Ajuste de IBS/CBS por item'}
        </Text>
        {grupo == null && (
          <Button type="button" size="xs" variant="light" onClick={limparTodos} disabled={disabled}>
            Limpar valores
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed">
        Os valores de IBS e CBS que cada item transfere, ajusta ou estorna. A classificação
        tributária vem do tipo da nota de débito, não do cadastro do produto.
      </Text>
      {linhas.map(({ item, index }, i) => {
        const a = item.ajusteRtc ?? null;
        const atual = (patch: Partial<AjusteRtcItem>): AjusteRtcItem => ({
          vIBS: a?.vIBS ?? 0,
          vCBS: a?.vCBS ?? 0,
          competApur: a?.competApur ?? null,
          ...patch,
        });
        return (
          <Group key={item._rowId} align="end" wrap="nowrap">
            <Text size="sm" w={220} truncate="end" title={nomeDoItem(item, null)}>
              {i + 1}. {nomeDoItem(item, null)}
            </Text>
            <DecimalInput
              w={140}
              label={i === 0 ? 'IBS (R$)' : undefined}
              ariaLabel={`IBS do ajuste do item ${i + 1}`}
              value={a?.vIBS ?? null}
              decimalScale={2}
              allowNegative={false}
              onChange={(v) => setAjuste(index, atual({ vIBS: v ?? 0 }))}
              disabled={disabled}
            />
            <DecimalInput
              w={140}
              label={i === 0 ? 'CBS (R$)' : undefined}
              ariaLabel={`CBS do ajuste do item ${i + 1}`}
              value={a?.vCBS ?? null}
              decimalScale={2}
              allowNegative={false}
              onChange={(v) => setAjuste(index, atual({ vCBS: v ?? 0 }))}
              disabled={disabled}
            />
            {comCompetencia && (
              <TextInput
                w={130}
                label={i === 0 ? 'Competência (AAAA-MM)' : undefined}
                aria-label={`Competência do ajuste do item ${i + 1}`}
                placeholder="2026-09"
                maxLength={7}
                value={a?.competApur ?? ''}
                onChange={(e) =>
                  setAjuste(index, atual({ competApur: e.currentTarget.value || null }))
                }
                disabled={disabled}
              />
            )}
            <ActionIcon
              type="button"
              color="red"
              variant="subtle"
              onClick={() => setAjuste(index, null)}
              aria-label={`Remover ajuste do item ${i + 1}`}
              disabled={disabled || a == null}
            >
              ✕
            </ActionIcon>
          </Group>
        );
      })}
      {erroPageModel && (
        <Text size="sm" c="red">
          {erroPageModel}
        </Text>
      )}
      {violacoes.length > 0 && (
        <Alert color="yellow" variant="light" title="Pendências para a emissão">
          <Stack gap={2}>
            {violacoes.map((v, k) => (
              <Text key={k} size="sm">
                {descreverViolacaoDocumento(v)}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
