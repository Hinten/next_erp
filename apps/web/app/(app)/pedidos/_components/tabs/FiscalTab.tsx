'use client';

import { useMemo } from 'react';
import { Card, Checkbox, Stack, Text, Textarea } from '@mantine/core';
import { Controller, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { CHAVE_NFE_REGEX, decomporChaveAcesso, type Pedido } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { refDeClienteOuNull } from '@/lib/data/readClienteByRef';
import { EnderecoPicker } from '@/components/pickers/EnderecoPicker';
import type { PedidoFormState } from '../types';
import { AjusteRtcSection } from './AjusteRtcSection';
import { ChaveListEditor } from './ChaveListEditor';
import { ReferenciaPorItemSection } from './ReferenciaPorItemSection';

export interface FiscalTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
}

export function FiscalTab({ form, db, disabled }: FiscalTabProps) {
  const enderecoFiscalOuterRef = form.watch('enderecoFiscalOuterRef');
  const clientePedidoOuterRef = form.watch('clientePedidoOuterRef');

  const clienteRef = useMemo(() => {
    const r = refDeClienteOuNull(db, clientePedidoOuterRef);
    return r ? clienteCollection.docRef(db, {}, r.id) : null;
  }, [db, clientePedidoOuterRef]);
  const clienteSnapshot = useDocSnapshot(clienteRef);
  // useDocSnapshot can retain the previous customer's data while a new ref loads.
  const clienteDoc =
    clienteRef && clienteSnapshot.documentPath === clienteRef.path ? clienteSnapshot.data : null;

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
  const antecipadoList = form.watch('chNFePagamentoAntecipado') ?? [];
  const updateAntecipado = (next: string[]) => {
    form.setValue('chNFePagamentoAntecipado', next.length === 0 ? null : next, {
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
                Sem endereço fiscal definido. A emissão da NF-e exige um endereço fiscal. Selecione
                um endereço do cliente
                <Text component="span" inherit fw={500}>
                  {' '}
                  {clienteDoc.data.nome ?? '(sem nome)'}
                </Text>
                .
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                Selecione um cliente na aba Principal e depois um endereço fiscal dele, obrigatório
                para emitir a NF-e.
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

      <ChaveListEditor
        titulo="NF-e referenciadas"
        vazio="Nenhuma chave de acesso referenciada."
        value={chNFeList}
        onChange={updateChNFe}
        // ⚠️ The SHARED constant, so this agrees with the save-blocking
        // page-model check by construction. It stopped agreeing the moment
        // `pageModel.ts` moved to `CHAVE_NFE_REGEX` (positions 6–17 may be
        // letters, RFB IN 2.229/2024) while this copy still said `^\d{44}$`:
        // a valid alfa chave showed a red field error on a form that SAVED
        // successfully. A comment claiming two rules match is the smell —
        // there is one rule now.
        validar={(c) =>
          CHAVE_NFE_REGEX.test(c)
            ? undefined
            : 'Deve ter 44 caracteres no formato da chave de acesso'
        }
        labelPrimeiro="Chave de acesso (44 caracteres)"
        rotuloAdicionar="Adicionar chave referenciada"
        rotuloRemover="Remover chave"
        disabled={disabled}
      />

      <ChaveListEditor
        titulo="NF-e de pagamento antecipado"
        descricao="Notas de débito de pagamento antecipado cujas parcelas esta nota abate (Reforma Tributária, gPagAntecipado). Só são emitidas com a Reforma Tributária ativa na filial."
        vazio="Nenhuma NF-e de pagamento antecipado."
        value={antecipadoList}
        onChange={updateAntecipado}
        // The page model's own rule (BC02): an NF-e modelo 55 with a valid DV.
        validar={(c) =>
          decomporChaveAcesso(c)?.mod === '55'
            ? undefined
            : 'Chave inválida: NF-e modelo 55, com dígito verificador correto'
        }
        labelPrimeiro="Chave de acesso da NF-e de pagamento antecipado"
        rotuloAdicionar="Adicionar NF-e de pagamento antecipado"
        rotuloRemover="Remover NF-e de pagamento antecipado"
        erro={
          (form.formState.errors as Record<string, { message?: string } | undefined>)
            .chNFePagamentoAntecipado?.message
        }
        disabled={disabled}
      />

      <ReferenciaPorItemSection
        form={form}
        db={db}
        destinatarioDocumento={clienteDoc?.data.cpf_cnpj ?? null}
        disabled={disabled}
      />

      <AjusteRtcSection form={form} db={db} disabled={disabled} />
    </Stack>
  );
}
