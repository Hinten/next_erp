'use client';

/**
 * "Nova Carta de Correção" form for a SINGLE NF-e (fixed by the route).
 * Registers a CC-e (RecepcaoEvento, tpEvento=110110) — corrects an authorized
 * NF-e without cancelling it. An NF-e can have many CC-e (each a new
 * `nSeqEvento`), so this form sits above the history list of all corrections.
 * react-hook-form + Zod resolver (apps/web rule #4).
 *
 * Mirrors the old Flutter `CartaCorrecaoCadastroView` → "Nova Carta de Correção".
 */
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { IconCircleCheck, IconClockHour4 } from '@tabler/icons-react';
import { z } from 'zod';
import {
  NFeHttpError,
  NFeNetworkError,
  NFeRejectedError,
  type NFeCartaCorrecaoResult,
} from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

const XCORRECAO_MIN = 15;
const XCORRECAO_MAX = 1000;

const cceFormSchema = z.object({
  xCorrecao: z
    .string()
    .trim()
    .min(XCORRECAO_MIN, `A correção deve ter ao menos ${XCORRECAO_MIN} caracteres`)
    .max(XCORRECAO_MAX),
});

type CCeFormValues = z.output<typeof cceFormSchema>;

const DEFAULTS: CCeFormValues = { xCorrecao: '' };

export function CartaCorrecaoForm({ pedidoId, nfeId }: { pedidoId: string; nfeId: string }) {
  const client = useNFeClient();
  const [result, setResult] = useState<NFeCartaCorrecaoResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CCeFormValues>({
    resolver: zodResolver(cceFormSchema),
    defaultValues: DEFAULTS,
    mode: 'onBlur',
  });

  async function handleSubmit(values: CCeFormValues) {
    if (!client) {
      showErrorNotification({ title: 'Não autenticado', message: 'Você não está logado.' });
      return;
    }
    setResult(null);
    setSubmitting(true);
    try {
      const res = await client.cartaCorrecao(pedidoId, nfeId, values.xCorrecao.trim());
      setResult(res);
      form.reset(DEFAULTS);
    } catch (err) {
      // The client throws NFeHttpError subclasses (incl. NFeRejectedError) or
      // NFeNetworkError; anything else is an unexpected bug — let it surface.
      if (!(err instanceof NFeHttpError) && !(err instanceof NFeNetworkError)) throw err;
      const message =
        err instanceof NFeRejectedError ? `${err.cStat} — ${err.xMotivo}` : err.message;
      showErrorNotification({ title: 'Falha na carta de correção', message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(handleSubmit)}>
      <Stack maw={720}>
        <Controller
          control={form.control}
          name="xCorrecao"
          render={({ field, fieldState }) => (
            <Textarea
              {...field}
              value={field.value ?? ''}
              label="Correção"
              description={`${(field.value ?? '').trim().length}/${XCORRECAO_MAX} caracteres (mínimo ${XCORRECAO_MIN})`}
              placeholder="Descreva a correção a ser considerada"
              autosize
              minRows={4}
              maxRows={12}
              maxLength={XCORRECAO_MAX}
              error={fieldState.error?.message}
              required
            />
          )}
        />

        <Alert color="yellow" variant="light">
          A carta de correção não pode alterar valores/impostos (base de cálculo, alíquota,
          quantidade, valor), dados que mudem remetente/destinatário, nem a data de emissão ou de
          saída. Para esses casos, cancele e reemita a NF-e.
        </Alert>

        <Group justify="flex-end">
          <Button type="submit" loading={submitting} disabled={!client}>
            Registrar carta de correção
          </Button>
        </Group>

        {result &&
          (result.pending ? (
            // cStat 136: registered but not yet linked. The re-check resolves it
            // asynchronously — surface "em processamento", NOT success/error (#81).
            <Paper withBorder p="md" radius="md" bg="var(--mantine-color-yellow-light)">
              <Group gap="xs" mb="xs">
                <IconClockHour4 size={20} color="var(--mantine-color-yellow-8)" />
                <Text fw={600} c="yellow.8">
                  Carta de correção em processamento (cStat {result.cStat})
                </Text>
              </Group>
              <Stack gap={2}>
                <Text size="sm">Sequência do evento: nº {result.nSeqEvento}</Text>
                <Text size="sm" c="dimmed">
                  Registrada na SEFAZ, aguardando vínculo à NF-e. A confirmação é verificada
                  automaticamente — acompanhe o estado na lista abaixo.
                </Text>
                <Text size="sm" c="dimmed">
                  {result.xMotivo}
                </Text>
              </Stack>
            </Paper>
          ) : (
            <Paper withBorder p="md" radius="md" bg="var(--mantine-color-teal-light)">
              <Group gap="xs" mb="xs">
                <IconCircleCheck size={20} color="var(--mantine-color-teal-7)" />
                <Text fw={600} c="teal.8">
                  Carta de correção registrada (cStat {result.cStat})
                </Text>
              </Group>
              <Stack gap={2}>
                <Text size="sm">Sequência do evento: nº {result.nSeqEvento}</Text>
                {result.nProt && (
                  <Text size="sm">
                    Protocolo:{' '}
                    <Text span ff="monospace">
                      {result.nProt}
                    </Text>
                  </Text>
                )}
                <Text size="sm" c="dimmed">
                  {result.xMotivo}
                </Text>
              </Stack>
            </Paper>
          ))}
      </Stack>
    </form>
  );
}
