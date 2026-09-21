'use client';

import { useMemo } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Controller, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { CHAVE_NFE_REGEX, type Pedido } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { EnderecoPicker } from '@/components/pickers/EnderecoPicker';
import type { PedidoFormState } from '../types';

export interface FiscalTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
}

export function FiscalTab({ form, db, disabled }: FiscalTabProps) {
  const enderecoFiscalOuterRef = form.watch('enderecoFiscalOuterRef');
  const clientePedidoOuterRef = form.watch('clientePedidoOuterRef');

  const clienteRef = useMemo(() => {
    const r = dereferenceOuterRef(db, clientePedidoOuterRef);
    return r ? clienteCollection.docRef(db, {}, r.id) : null;
  }, [db, clientePedidoOuterRef]);
  const { data: clienteDoc } = useDocSnapshot(clienteRef);

  const enderecoFiscalRef = useMemo(
    () => dereferenceOuterRef(db, enderecoFiscalOuterRef),
    [db, enderecoFiscalOuterRef],
  );

  const chNFeList = form.watch('chNFeReferenciadas') ?? [];
  const updateChNFe = (next: string[]) => {
    form.setValue('chNFeReferenciadas', next.length === 0 ? null : next, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  return (
    <Stack>
      <Card withBorder>
        <Stack gap="xs">
          <EnderecoPicker
            db={db}
            clienteOuterRef={clientePedidoOuterRef}
            value={enderecoFiscalOuterRef}
            onChange={(docPath) =>
              form.setValue('enderecoFiscalOuterRef', docPath, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
            label="Endereço fiscal"
            disabled={disabled}
          />
          {!enderecoFiscalRef &&
            (clienteDoc ? (
              <Text size="sm" c="dimmed">
                Sem endereço fiscal definido. Será inferido a partir do cliente
                <Text component="span" inherit fw={500}>
                  {' '}
                  {clienteDoc.data.nome ?? '(sem nome)'}
                </Text>{' '}
                na emissão fiscal.
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                Selecione um cliente na aba Principal para herdar o endereço fiscal.
              </Text>
            ))}
        </Stack>
      </Card>

      <Controller
        control={form.control}
        name="infCpl"
        render={({ field, fieldState }) => (
          <Textarea
            label="Informações complementares (infCpl)"
            description="Texto adicional impresso no DANFE."
            value={field.value ?? ''}
            onChange={(e) => field.onChange(e.currentTarget.value || null)}
            onBlur={field.onBlur}
            rows={6}
            disabled={disabled}
            error={fieldState.error?.message}
          />
        )}
      />

      <Controller
        control={form.control}
        name="bloquearEmissaoNFe"
        render={({ field }) => (
          <Checkbox
            label="Bloquear emissão de NF-e"
            description="Quando marcado, o sistema recusa emitir NF-e para este pedido."
            checked={!!field.value}
            onChange={(e) => field.onChange(e.currentTarget.checked)}
            onBlur={field.onBlur}
            disabled={disabled}
          />
        )}
      />

      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Text fw={500}>NF-e referenciadas</Text>
          <Button
            type="button"
            size="xs"
            variant="light"
            onClick={() => updateChNFe([...chNFeList, ''])}
            disabled={disabled}
          >
            + Adicionar
          </Button>
        </Group>
        {chNFeList.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhuma chave de acesso referenciada.
          </Text>
        )}
        {chNFeList.map((value, index) => {
          const current = value ?? '';
          // ⚠️ The SHARED constant, so this agrees with the save-blocking
          // page-model check by construction. It stopped agreeing the moment
          // `pageModel.ts` moved to `CHAVE_NFE_REGEX` (positions 6–17 may be
          // letters, RFB IN 2.229/2024) while this copy still said `^\d{44}$`:
          // a valid alfa chave showed a red field error on a form that SAVED
          // successfully. A comment claiming two rules match is the smell —
          // there is one rule now.
          const invalid = current !== '' && !CHAVE_NFE_REGEX.test(current);
          return (
            <Group key={index} align="end">
              <TextInput
                style={{ flex: 1 }}
                label={index === 0 ? 'Chave de acesso (44 caracteres)' : undefined}
                value={current}
                onChange={(e) => {
                  const next = [...chNFeList];
                  next[index] = e.currentTarget.value;
                  updateChNFe(next);
                }}
                maxLength={44}
                error={invalid ? 'Deve ter 44 caracteres no formato da chave de acesso' : undefined}
                disabled={disabled}
              />
              <ActionIcon
                type="button"
                color="red"
                variant="subtle"
                onClick={() => updateChNFe(chNFeList.filter((_, i) => i !== index))}
                aria-label="Remover chave"
                disabled={disabled}
              >
                ✕
              </ActionIcon>
            </Group>
          );
        })}
      </Stack>

      <Alert color="gray" variant="light">
        <Text size="sm">
          A reatribuição de endereço a outro cliente (quando o endereço fiscal pertence a outro
          cliente) ainda usa o app antigo.
        </Text>
      </Alert>
    </Stack>
  );
}
