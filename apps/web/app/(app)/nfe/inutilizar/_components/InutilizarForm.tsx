'use client';

/**
 * Inutilização de numeração form. Burns a contiguous range of NF-e números
 * on a filial's série (NfeInutilizacao4) — for números that will never be
 * authorized (gaps). react-hook-form + Zod resolver (apps/web rule #4).
 *
 * Improves on the old Flutter dedicated page (`.old/lib/nfe/pages/inutNFe.dart`)
 * with schema-driven validation (range + xJust) and a clear result card
 * echoing the burned range + protocolo.
 */
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { z } from 'zod';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  NFeInutilizacaoAbortedError,
  NFeRejectedError,
  type NFeInutilizarResult,
} from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { InutilizacaoHistory } from './InutilizacaoHistory';

const XJUST_MIN = 15;
const XJUST_MAX = 255;

const inutFormSchema = z
  .object({
    filialId: z.string().min(1, 'Selecione uma filial'),
    serie: z.number().int().min(0).max(999).nullable(),
    nNFIni: z.number().int().min(1).max(999_999_999).nullable(),
    nNFFin: z.number().int().min(1).max(999_999_999).nullable(),
    xJust: z
      .string()
      .trim()
      .min(XJUST_MIN, `A justificativa deve ter ao menos ${XJUST_MIN} caracteres`)
      .max(XJUST_MAX),
  })
  .superRefine((b, ctx) => {
    if (b.serie === null)
      ctx.addIssue({ code: 'custom', path: ['serie'], message: 'Informe a série' });
    if (b.nNFIni === null)
      ctx.addIssue({ code: 'custom', path: ['nNFIni'], message: 'Informe o número inicial' });
    if (b.nNFFin === null)
      ctx.addIssue({ code: 'custom', path: ['nNFFin'], message: 'Informe o número final' });
    if (b.nNFIni !== null && b.nNFFin !== null && b.nNFIni > b.nNFFin)
      ctx.addIssue({
        code: 'custom',
        path: ['nNFIni'],
        message: 'O número inicial deve ser ≤ ao número final',
      });
  });

type InutFormValues = z.output<typeof inutFormSchema>;

const DEFAULTS: InutFormValues = {
  filialId: '',
  serie: null,
  nNFIni: null,
  nNFFin: null,
  xJust: '',
};

export function InutilizarForm() {
  const client = useNFeClient();
  const db = getFirebaseFirestore();
  const filiaisQuery = useMemo(() => filialCollection.ref(db, {}), [db]);
  const { data: filiais, loading: filiaisLoading } = useSnapshot(filiaisQuery);
  const [result, setResult] = useState<NFeInutilizarResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const filialOptions = useMemo(
    () =>
      (filiais ?? []).map((f) => ({
        value: f.id,
        label: f.data.fantasia ?? f.data.razaoSocial ?? f.id,
      })),
    [filiais],
  );

  const form = useForm<InutFormValues>({
    resolver: zodResolver(inutFormSchema),
    defaultValues: DEFAULTS,
    mode: 'onBlur',
  });

  // The history list mirrors whichever filial is currently selected.
  const selectedFilialId = form.watch('filialId');

  async function handleSubmit(values: InutFormValues) {
    // superRefine guarantees these are non-null here.
    if (values.serie === null || values.nNFIni === null || values.nNFFin === null) return;
    if (!client) {
      showErrorNotification({ title: 'Não autenticado', message: 'Você não está logado.' });
      return;
    }
    setResult(null);
    setSubmitting(true);
    try {
      const res = await client.inutilizar({
        filialId: values.filialId,
        serie: values.serie,
        nNFIni: values.nNFIni,
        nNFFin: values.nNFFin,
        xJust: values.xJust.trim(),
      });
      setResult(res);
    } catch (err) {
      if (err instanceof NFeInutilizacaoAbortedError) {
        // Pre-check abort: a número in the range belongs to an authorized NF-e.
        showErrorNotification({ title: 'Inutilização não permitida', message: err.message });
        return;
      }
      const message =
        err instanceof NFeRejectedError
          ? `${err.cStat} — ${err.xMotivo}`
          : err instanceof Error
            ? err.message
            : 'Erro desconhecido ao inutilizar a numeração.';
      showErrorNotification({ title: 'Falha na inutilização', message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack gap="xl">
    <form onSubmit={form.handleSubmit(handleSubmit)}>
      <Stack maw={560}>
        <Controller
          control={form.control}
          name="filialId"
          render={({ field, fieldState }) => (
            <Select
              label="Filial"
              placeholder={filiaisLoading ? 'Carregando filiais…' : 'Selecione a filial'}
              data={filialOptions}
              value={field.value || null}
              onChange={(v) => field.onChange(v ?? '')}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
              disabled={filiaisLoading}
              searchable
              required
            />
          )}
        />

        <Controller
          control={form.control}
          name="serie"
          render={({ field, fieldState }) => (
            <NumberInput
              label="Série"
              placeholder="Ex.: 1"
              value={field.value ?? ''}
              onChange={(v) => field.onChange(typeof v === 'number' ? v : null)}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
              min={0}
              max={999}
              allowDecimal={false}
              required
            />
          )}
        />

        <Group grow align="flex-start">
          <Controller
            control={form.control}
            name="nNFIni"
            render={({ field, fieldState }) => (
              <NumberInput
                label="Número inicial"
                placeholder="nNFIni"
                value={field.value ?? ''}
                onChange={(v) => field.onChange(typeof v === 'number' ? v : null)}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                min={1}
                max={999_999_999}
                allowDecimal={false}
                required
              />
            )}
          />
          <Controller
            control={form.control}
            name="nNFFin"
            render={({ field, fieldState }) => (
              <NumberInput
                label="Número final"
                placeholder="nNFFin"
                value={field.value ?? ''}
                onChange={(v) => field.onChange(typeof v === 'number' ? v : null)}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                min={1}
                max={999_999_999}
                allowDecimal={false}
                required
              />
            )}
          />
        </Group>

        <Controller
          control={form.control}
          name="xJust"
          render={({ field, fieldState }) => (
            <Textarea
              {...field}
              value={field.value ?? ''}
              label="Justificativa"
              description={`${field.value.trim().length}/${XJUST_MAX} caracteres (mínimo ${XJUST_MIN})`}
              placeholder="Descreva o motivo da inutilização"
              autosize
              minRows={3}
              maxRows={6}
              maxLength={XJUST_MAX}
              error={fieldState.error?.message}
              required
            />
          )}
        />

        <Alert color="yellow" variant="light">
          A inutilização é definitiva e registrada na SEFAZ — os números da
          faixa não poderão mais ser usados. Não toca o contador de numeração.
        </Alert>

        <Group justify="flex-end">
          <Button type="submit" loading={submitting} disabled={!client}>
            Inutilizar numeração
          </Button>
        </Group>

        {result && (
          <Paper withBorder p="md" radius="md" bg="var(--mantine-color-teal-light)">
            <Group gap="xs" mb="xs">
              <IconCircleCheck size={20} color="var(--mantine-color-teal-7)" />
              <Text fw={600} c="teal.8">
                Inutilização homologada (cStat {result.cStat})
              </Text>
            </Group>
            <Stack gap={2}>
              <Text size="sm">
                Série {result.serie} · números {result.nNFIni}–{result.nNFFin}
              </Text>
              {result.nProt && (
                <Text size="sm">
                  Protocolo: <Text span ff="monospace">{result.nProt}</Text>
                </Text>
              )}
              <Text size="sm">
                {result.reconciled > 0
                  ? `${result.reconciled} NF-e marcada(s) como numeração inutilizada.`
                  : 'Nenhuma NF-e na faixa precisou ser reconciliada.'}
              </Text>
              <Text size="sm" c="dimmed">
                {result.xMotivo}
              </Text>
            </Stack>
          </Paper>
        )}
      </Stack>
    </form>

      {selectedFilialId && <InutilizacaoHistory filialId={selectedFilialId} />}
    </Stack>
  );
}
