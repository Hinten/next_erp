'use client';

import { useMemo, useState } from 'react';
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
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  chaveAcessoValida,
  descreverViolacaoDocumento,
  FIN_NFE_OPERACAO,
  naOrdemDoPedido,
  nomeDoItem,
  REGRA_DOCUMENTO,
  violacoesDoDocumento,
  type DfeReferenciadoItem,
  type Pedido,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  lerNotasDeOrigem,
  preencherReferenciasPendentes,
  referenciaCompleta,
} from '@delfrance/data/pedido';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { linhaViraItem } from '../regroupItens';
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
 *
 * On a DEVOLUÇÃO every item must carry its reference (VC02-14, cStat 321,
 * #1683), with or without the Reforma Tributária. The devolução seeds fill
 * them from the origin's authorized XML; "Preencher a partir das NF-e de
 * origem" re-runs that same matching (`preencherReferenciasPendentes`) over the
 * origins in `saidasRelacionadas` for whatever is still incomplete — an edited
 * line, a legacy devolução not yet emitted, an origin whose XML arrived late.
 */
export function ReferenciaPorItemSection({
  form,
  db,
  destinatarioDocumento,
  disabled,
}: ReferenciaPorItemSectionProps) {
  const itensFlat = (form.watch('_itensFlat') ?? []) as FlatItem[];
  // The RAW watched value: the `?? []` fallback lives inside the useMemo below,
  // so the dependency is not a fresh array on every render.
  const chNFeReferenciadas = form.watch('chNFeReferenciadas');
  const operacaoOuterRef = form.watch('operacaoPedidoOuterRef');

  const operacaoRef = useMemo(() => {
    const r = dereferenceOuterRef(db, operacaoOuterRef);
    return r ? operacaoCollection.docRef(db, {}, r.id) : null;
  }, [db, operacaoOuterRef]);
  const { data: operacaoDoc } = useDocSnapshot(operacaoRef);

  // Numbered as the emission numbers `det/@nItem`: only the rows the save keeps
  // (`linhaViraItem` — a blank "Adicionar produto" row would shift every later
  // number), in the pedido's line order (`naOrdemDoPedido`, the order apps/nfe
  // emits in) rather than the row's position in the form array.
  const linhas = naOrdemDoPedido(
    itensFlat.map((item, index) => ({ item, index })).filter(({ item }) => linhaViraItem(item)),
    ({ item }) => item.ordem,
  );

  const violacoes = useMemo(
    () =>
      violacoesDoDocumento({
        emitRtc: true, // stated above the list instead — see the component doc
        finNFe: operacaoDoc?.data.finNFe ?? 1,
        tpNF: operacaoDoc?.data.tipo === 1 ? '1' : '0',
        tpNFDebito: operacaoDoc?.data.tpNFDebito ?? null,
        tpNFCredito: operacaoDoc?.data.tpNFCredito ?? null,
        // Unknown on this screen — the rules that need them stay silent here
        // and are judged at emission (1145, 269/678, and each item's cClassTrib).
        anoEmissao: null,
        mesEmissao: null,
        emitenteDocumento: null,
        emitenteCUF: null,
        // Judged by their own editor (and at emission), not by this panel.
        chNFePagamentoAntecipado: [],
        emitenteISUF: null,
        emitenteCMun: null,
        chNFeReferenciadas: (chNFeReferenciadas ?? []).filter((c): c is string => !!c),
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

  // The origins a devolução returns from — the troca and integral saves write
  // them; a devolução typed by hand has none, and fills its references by hand.
  const saidasRelacionadas = form.watch('saidasRelacionadas');
  const origens = useMemo(
    () =>
      (saidasRelacionadas ?? []).filter((id): id is string => typeof id === 'string' && id !== ''),
    [saidasRelacionadas],
  );
  const ehDevolucao = operacaoDoc?.data.finNFe === FIN_NFE_OPERACAO.devolucao;
  const pendentes = linhas.filter(({ item }) => !referenciaCompleta(item.dfeReferenciado)).length;
  const [preenchendo, setPreenchendo] = useState(false);

  const preencherDasOrigens = async () => {
    setPreenchendo(true);
    try {
      const notas = await lerNotasDeOrigem(createClientPedidoPort(db), origens);
      const novas = preencherReferenciasPendentes(
        linhas.map(({ item }) => item),
        notas,
      );
      let completas = 0;
      linhas.forEach(({ item, index }, i) => {
        const atual = item.dfeReferenciado ?? null;
        const nova = novas[i] ?? null;
        if (referenciaCompleta(atual) || nova === null) return;
        if (referenciaCompleta(nova)) completas += 1;
        if (nova.chaveAcesso !== atual?.chaveAcesso || nova.nItem !== atual?.nItem) {
          setRef(index, nova);
        }
      });
      const restantes = pendentes - completas;
      notifications.show({
        color: restantes === 0 ? 'green' : 'yellow',
        message:
          restantes === 0
            ? `${completas} ${completas === 1 ? 'referência preenchida' : 'referências preenchidas'} a partir das NF-e de origem.`
            : `${completas} preenchida(s); ${restantes} item(ns) não foram encontrados com segurança nas NF-e de origem — informe a chave e o item à mão.`,
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        showErrorNotification({
          title: 'Não foi possível ler as NF-e de origem',
          message: err.message,
        });
      } else {
        throw err;
      }
    } finally {
      setPreenchendo(false);
    }
  };

  const erroPageModel = (form.formState.errors as Record<string, { message?: string } | undefined>)
    .dfeReferenciado?.message;

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text fw={500}>Referência por item (DF-e referenciado)</Text>
        <Group gap="xs">
          {ehDevolucao && (
            <Button
              type="button"
              size="xs"
              variant="light"
              onClick={() => void preencherDasOrigens()}
              loading={preenchendo}
              disabled={disabled || origens.length === 0 || pendentes === 0}
              title={
                origens.length === 0
                  ? 'Esta devolução não está ligada a um pedido de origem — informe a chave e o item à mão.'
                  : undefined
              }
            >
              Preencher a partir das NF-e de origem
            </Button>
          )}
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
      </Group>
      <Text size="sm" c="dimmed">
        O item da nota original a que cada item se refere. Obrigatório em toda devolução, com ou sem
        a Reforma Tributária; nas notas de crédito/débito, só é emitido com a Reforma Tributária
        ativa na filial.
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
