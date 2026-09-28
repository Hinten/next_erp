'use client';

import { useMemo } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  chaveAcessoValida,
  descreverViolacaoDocumento,
  nomeDoItem,
  REGRA_DOCUMENTO,
  violacoesDoDocumento,
  type DfeReferenciadoItem,
  type Pedido,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import type { FlatItem, PedidoFormState } from '../types';

export interface ReferenciaPorItemSectionProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  /** The cliente's CPF/CNPJ — the devolução rule 1194 compares it to the referenced emitente. */
  destinatarioDocumento: string | null;
  disabled?: boolean;
}

/**
 * Per-item NF-e references — `itens[*].dfeReferenciado`, emitted as
 * `det/DFeReferenciado` (NT 2025.002 Grupo VC, #330).
 *
 * The panel below runs the SAME document rules the emission pre-flight refuses
 * with (`violacoesDoDocumento`, `@delfrance/schemas`), as warnings: whether a
 * reference is required, and how references combine, depends on the operação,
 * which the operator may still be changing. Only a malformed chave or `nItem`
 * blocks the save (the page model). The filial's Reforma Tributária switch is
 * not on this screen, so that one policy is stated, not evaluated, here — the
 * emission refuses it with its own message.
 */
export function ReferenciaPorItemSection({
  form,
  db,
  destinatarioDocumento,
  disabled,
}: ReferenciaPorItemSectionProps) {
  const itensFlat = (form.watch('_itensFlat') ?? []) as FlatItem[];
  const chNFeReferenciadas = form.watch('chNFeReferenciadas') ?? [];
  const operacaoOuterRef = form.watch('operacaoPedidoOuterRef');

  const operacaoRef = useMemo(() => {
    const r = dereferenceOuterRef(db, operacaoOuterRef);
    return r ? operacaoCollection.docRef(db, {}, r.id) : null;
  }, [db, operacaoOuterRef]);
  const { data: operacaoDoc } = useDocSnapshot(operacaoRef);

  const linhas = itensFlat
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item._delete);

  const violacoes = useMemo(
    () =>
      violacoesDoDocumento({
        emitRtc: true, // stated above the list instead — see the component doc
        finNFe: operacaoDoc?.data.finNFe ?? 1,
        tpNF: operacaoDoc?.data.tipo === 1 ? '1' : '0',
        chNFeReferenciadas: chNFeReferenciadas.filter((c): c is string => !!c),
        destinatarioDocumento,
        itens: linhas.map(({ item }, i) => ({
          nItem: i + 1,
          dfeReferenciado: item.dfeReferenciado ?? null,
        })),
      }).filter((v) => v.regra !== REGRA_DOCUMENTO.refItemSemReformaTributaria),
    [operacaoDoc, chNFeReferenciadas, destinatarioDocumento, linhas],
  );

  const setRef = (index: number, next: DfeReferenciadoItem | null) => {
    form.setValue(`_itensFlat.${index}.dfeReferenciado`, next, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const primeiraChave = linhas.find(({ item }) => item.dfeReferenciado?.chaveAcesso)?.item
    .dfeReferenciado?.chaveAcesso;
  const aplicarATodos = () => {
    if (!primeiraChave) return;
    for (const { item, index } of linhas) {
      if (!item.dfeReferenciado?.chaveAcesso) {
        setRef(index, { chaveAcesso: primeiraChave, nItem: item.dfeReferenciado?.nItem ?? null });
      }
    }
  };

  const erroPageModel = (form.formState.errors as Record<string, { message?: string } | undefined>)
    .dfeReferenciado?.message;

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text fw={500}>Referência por item (DF-e referenciado)</Text>
        <Button
          type="button"
          size="xs"
          variant="light"
          onClick={aplicarATodos}
          disabled={disabled || !primeiraChave}
        >
          Aplicar a mesma chave a todos
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Para notas de crédito/débito e devoluções da Reforma Tributária: o item da nota original a
        que cada item se refere. Só é emitida com a Reforma Tributária ativa na filial.
      </Text>
      {linhas.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhum item no pedido.
        </Text>
      )}
      {linhas.map(({ item, index }, i) => {
        const ref = item.dfeReferenciado ?? null;
        const chave = ref?.chaveAcesso ?? '';
        const chaveInvalida = chave !== '' && !chaveAcessoValida(chave);
        return (
          <Group key={item._rowId} align="end" wrap="nowrap">
            <Text size="sm" w={220} truncate="end" title={nomeDoItem(item, null)}>
              {i + 1}. {nomeDoItem(item, null)}
            </Text>
            <TextInput
              style={{ flex: 1 }}
              label={i === 0 ? 'Chave de acesso da nota original' : undefined}
              aria-label={`Chave referenciada do item ${i + 1}`}
              value={chave}
              maxLength={44}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setRef(
                  index,
                  next === '' && ref?.nItem == null
                    ? null
                    : { chaveAcesso: next, nItem: ref?.nItem ?? null },
                );
              }}
              error={chaveInvalida ? 'Chave inválida (formato ou dígito verificador)' : undefined}
              disabled={disabled}
            />
            <NumberInput
              w={110}
              label={i === 0 ? 'Item (nItem)' : undefined}
              aria-label={`Item da nota original para o item ${i + 1}`}
              value={ref?.nItem ?? ''}
              min={1}
              max={990}
              allowDecimal={false}
              allowNegative={false}
              onChange={(v) => {
                const nItem = v === '' ? null : Number(v);
                setRef(index, chave === '' && nItem == null ? null : { chaveAcesso: chave, nItem });
              }}
              disabled={disabled}
            />
            <ActionIcon
              type="button"
              color="red"
              variant="subtle"
              onClick={() => setRef(index, null)}
              aria-label={`Remover referência do item ${i + 1}`}
              disabled={disabled || ref == null}
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
        <Alert color="yellow" variant="light" title="A SEFAZ recusaria esta nota assim">
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
