'use client';

/**
 * "Configurações NFe" tab content for one Filial — the NF-e config doc at
 * `filiais/{filialId}/nfeconfig/default`.
 *
 * Two blocks:
 *   1. **Status dos serviços** — on-demand NfeStatusServico4 checks against
 *      the home SEFAZ and the UF's SVC (decision support for the toggle).
 *   2. **Contingência** — the manual switch (`contingencia_modo`) + the
 *      mandatory justification (15–255 chars, becomes the NF-e's `xJust`).
 *      `contingencia_dataInicio` (`dhCont`) is stamped automatically when the
 *      mode turns on and cleared when it turns back to normal.
 *
 * Counters (numeração / série / lote / ambiente) are shown read-only — they
 * advance server-side in apps/nfe transactions.
 */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc, setDoc } from 'firebase/firestore';
import { z } from 'zod';

import { PERM } from '@delfrance/auth';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeStatusServicoResult,
} from '@delfrance/integrations-nfe/http-provider';
import { type ContingenciaModo, type NFeConfig } from '@delfrance/schemas';

import { usePermission } from '@/lib/auth';
import { NFE_CONFIG_DOC_ID, nfeConfigCollection } from '@/lib/data/nfeConfigCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';

const MODO_LABELS: Record<ContingenciaModo, string> = {
  none: 'Normal (sem contingência)',
  svc: 'SVC — SEFAZ Virtual de Contingência',
  epec: 'EPEC — Evento Prévio de Emissão em Contingência',
};

/** One status-servico row: target label + check button + result badge. */
function StatusRow({ target, label }: { target: 'normal' | 'svc'; label: string }) {
  const client = useNFeClient();
  const [result, setResult] = useState<NFeStatusServicoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client.statusServico(target));
    } catch (err) {
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        // Unreachable / 5xx IS the answer the operator is looking for here.
        setResult(null);
        setError(err.message);
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  }

  const up = result?.category === 'servico-em-operacao';
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="sm" w={140}>
        {label}
      </Text>
      <Button size="compact-sm" variant="light" onClick={check} loading={busy} disabled={!client}>
        Verificar
      </Button>
      {result && (
        <Badge color={up ? 'green' : 'red'} variant="light">
          cStat {result.cStat}
        </Badge>
      )}
      {result && (
        <Text size="xs" c="dimmed" style={{ flex: 1 }} truncate>
          {result.xMotivo}
        </Text>
      )}
      {error && (
        <Text size="xs" c="red" style={{ flex: 1 }} truncate>
          {error}
        </Text>
      )}
    </Group>
  );
}

export function NfeConfigPanel({ filialId }: { filialId: string }) {
  const db = getFirebaseFirestore();
  const queryClient = useQueryClient();
  const { allowed: canWrite } = usePermission(PERM.fiscal.write);

  const cfgQuery = useQuery({
    queryKey: ['nfeconfig', filialId],
    queryFn: async () => {
      const snap = await getDoc(nfeConfigCollection.docRef(db, { filialId }, NFE_CONFIG_DOC_ID));
      return snap.exists() ? snap.data() : null;
    },
  });

  const [modo, setModo] = useState<ContingenciaModo | null>(null);
  const [justificativa, setJustificativa] = useState<string | null>(null);

  const cfg = cfgQuery.data ?? null;
  // Local edits win; otherwise mirror the persisted doc.
  const modoValue = modo ?? cfg?.contingencia_modo ?? 'none';
  const justValue = justificativa ?? cfg?.contingencia_justificativa ?? '';
  const dirty =
    cfg != null &&
    (modoValue !== cfg.contingencia_modo ||
      (modoValue !== 'none' && justValue !== (cfg.contingencia_justificativa ?? '')));
  const justInvalid = modoValue !== 'none' && (justValue.length < 15 || justValue.length > 255);

  const save = useMutation({
    mutationFn: async () => {
      if (!cfg) return;
      const now = new Date().toISOString();
      const next: NFeConfig = {
        ...cfg,
        contingencia_modo: modoValue,
        contingencia_justificativa: modoValue === 'none' ? null : justValue,
        // Stamp dhCont when the mode turns ON; keep it while it stays on;
        // clear it on the way back to normal.
        contingencia_dataInicio: modoValue === 'none' ? null : (cfg.contingencia_dataInicio ?? now),
        timestamp: now,
      };
      await setDoc(nfeConfigCollection.docRef(db, { filialId }, NFE_CONFIG_DOC_ID), next);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Configuração de contingência salva.' });
      setModo(null);
      setJustificativa(null);
      void queryClient.invalidateQueries({ queryKey: ['nfeconfig', filialId] });
    },
    onError: (err) => {
      if (err instanceof FirebaseError || err instanceof z.ZodError) {
        notifications.show({ color: 'red', title: 'Falha ao salvar', message: err.message });
        return;
      }
      throw err;
    },
  });

  if (cfgQuery.isLoading) return <Loader size="sm" />;
  if (cfgQuery.isError) {
    return (
      <Alert color="red" title="Falha ao carregar a configuração NF-e">
        {cfgQuery.error instanceof Error ? cfgQuery.error.message : 'Erro desconhecido'}
      </Alert>
    );
  }

  return (
    <Stack gap="lg" maw={720}>
      <Stack gap="xs">
        <Title order={5}>Status dos serviços SEFAZ</Title>
        <StatusRow target="normal" label="SEFAZ (normal)" />
        <StatusRow target="svc" label="SVC (contingência)" />
      </Stack>

      {!cfg ? (
        <Alert color="yellow" title="Configuração NF-e não encontrada">
          Esta filial ainda não tem o documento <Code>nfeconfig/default</Code> (numeração / série /
          ambiente). Ele é criado no setup fiscal da filial — sem ele não há emissão nem
          contingência.
        </Alert>
      ) : (
        <Stack gap="xs">
          <Title order={5}>Contingência</Title>
          <Group gap="lg">
            <Text size="sm" c="dimmed">
              Série:{' '}
              <Text span fw={500}>
                {cfg.serie}
              </Text>
            </Text>
            <Text size="sm" c="dimmed">
              Numeração atual:{' '}
              <Text span fw={500}>
                {cfg.numeracao_atual}
              </Text>
            </Text>
            <Text size="sm" c="dimmed">
              Ambiente:{' '}
              <Text span fw={500}>
                {cfg.ambiente === '1' ? 'Produção' : 'Homologação'}
              </Text>
            </Text>
          </Group>

          <Select
            label="Modo de emissão"
            description="A ativação é uma decisão manual — confirme acima que a SEFAZ está fora do ar antes de ligar."
            value={modoValue}
            onChange={(v) => setModo((v ?? 'none') as ContingenciaModo)}
            data={[
              { value: 'none', label: MODO_LABELS.none },
              { value: 'svc', label: MODO_LABELS.svc },
              // EPEC lands in the nfe-contingencia-epec PR.
              { value: 'epec', label: `${MODO_LABELS.epec} (em breve)`, disabled: true },
            ]}
            allowDeselect={false}
            disabled={!canWrite}
          />

          {modoValue !== 'none' && (
            <Textarea
              label="Justificativa da contingência"
              description="Obrigatória (15–255 caracteres) — impressa na DANFE como xJust."
              value={justValue}
              onChange={(e) => setJustificativa(e.currentTarget.value)}
              error={
                justInvalid && justValue.length > 0
                  ? 'A justificativa precisa ter entre 15 e 255 caracteres.'
                  : undefined
              }
              minRows={2}
              autosize
              disabled={!canWrite}
            />
          )}

          {cfg.contingencia_modo !== 'none' && cfg.contingencia_dataInicio && (
            <Text size="xs" c="dimmed">
              Contingência ativa desde{' '}
              {new Date(cfg.contingencia_dataInicio).toLocaleString('pt-BR')}.
            </Text>
          )}

          <Group>
            <Button
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!canWrite || !dirty || justInvalid}
            >
              Salvar contingência
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
