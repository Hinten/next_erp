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
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc } from 'firebase/firestore';
import { z } from 'zod';

import { PERM } from '@delfrance/auth';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeStatusServicoResult,
} from '@delfrance/integrations-nfe/http-provider';
import {
  CONTINGENCIA_MODO,
  AMBIENTE_NFE,
  nfeConfigSchema,
  type ContingenciaModo,
  type NFeConfig,
} from '@delfrance/schemas';
import { buildConflictFields, ConflictModal, labelFromShape } from '@delfrance/ui';

import { usePermission } from '@/lib/auth';
import { NFE_CONFIG_DOC_ID, nfeConfigCollection } from '@/lib/data/nfeConfigCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import { createNfeConfigPort } from '@/lib/nfe/nfeConfigPort';
import {
  NfeConfigConflictError,
  NfeConfigMissingError,
  saveNfeConfig,
  type PanelOwnedKey,
} from '@/lib/nfe/saveNfeConfig';

const MODO_LABELS: Record<ContingenciaModo, string> = {
  none: 'Normal (sem contingência)',
  svc: 'SVC — SEFAZ Virtual de Contingência',
  epec: 'EPEC — Evento Prévio de Emissão em Contingência',
};

/** One status-servico row: target label + check button + result badge. */
function StatusRow({
  target,
  label,
  filialId,
}: {
  target: 'normal' | 'svc';
  label: string;
  filialId: string;
}) {
  const client = useNFeClient();
  const [result, setResult] = useState<NFeStatusServicoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      // The status check signs with this filial's own cert (the server signs
      // per-filial — it doesn't require a shared env cert).
      setResult(await client.statusServico(target, filialId));
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
  const [rtc, setRtc] = useState<boolean | null>(null);

  // The remote doc a conflict was raised against, plus which panel fields
  // collided. It becomes the baseline a "Salvar mesmo assim" re-applies over —
  // so a THIRD change landing meanwhile raises the modal again instead of being
  // swallowed by a blind force-write.
  const [conflict, setConflict] = useState<{
    current: NFeConfig;
    fields: PanelOwnedKey[];
  } | null>(null);

  const cfg = cfgQuery.data ?? null;
  // Once a conflict is known, the server's version is the truth the form
  // mirrors — showing the operator the stale doc they already lost to would be
  // worse than useless.
  const base = conflict?.current ?? cfg;
  // Local edits win; otherwise mirror the persisted doc.
  const modoValue = modo ?? base?.contingencia_modo ?? 'none';
  const justValue = justificativa ?? base?.contingencia_justificativa ?? '';
  const rtcValue = rtc ?? base?.emitirReformaTributaria ?? false;
  const dirty =
    base != null &&
    (modoValue !== base.contingencia_modo ||
      (modoValue !== 'none' && justValue !== (base.contingencia_justificativa ?? '')) ||
      rtcValue !== (base.emitirReformaTributaria ?? false));
  const justInvalid = modoValue !== 'none' && (justValue.length < 15 || justValue.length > 255);

  const save = useMutation({
    mutationFn: async () => {
      if (!base) return;
      // ⚠️ `modo` / `justificativa` / `rtc` — the raw local edits, NOT the
      // `*Value` bindings. Those fold in the render-time doc, and the whole
      // point is that the write must not carry it: an untouched field is passed
      // as `null` so `saveNfeConfig` re-derives it from the tx-fresh doc.
      //
      // "Salvar mesmo assim" takes this SAME path — there is no force flag. It
      // differs only in `base`, which by then is the version the modal showed
      // (`conflict.current`), so the guard still runs and a third write landing
      // meanwhile raises the modal again instead of being overwritten.
      await saveNfeConfig(createNfeConfigPort(db, filialId), {
        modo,
        justificativa,
        rtc,
        baseline: base,
      });
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Configuração de NF-e salva.' });
      setModo(null);
      setJustificativa(null);
      setRtc(null);
      setConflict(null);
      void queryClient.invalidateQueries({ queryKey: ['nfeconfig', filialId] });
    },
    onError: (err) => {
      // Tier 3 — someone else changed a field this save writes. Show them what,
      // and let them decide; never discard what the operator typed.
      if (err instanceof NfeConfigConflictError) {
        setConflict({ current: err.current, fields: err.fields });
        return;
      }
      if (err instanceof NfeConfigMissingError) {
        notifications.show({ color: 'red', title: 'Falha ao salvar', message: err.message });
        return;
      }
      if (err instanceof FirebaseError || err instanceof z.ZodError) {
        notifications.show({ color: 'red', title: 'Falha ao salvar', message: err.message });
        return;
      }
      throw err;
    },
  });

  /**
   * "Recarregar do servidor" — take the server's version for the fields that
   * actually collided, and KEEP every edit that did not. Only what genuinely
   * conflicted is dropped; the operator does not lose unrelated typing.
   */
  function reloadFromServer(): void {
    for (const key of conflict?.fields ?? []) {
      if (key === 'contingencia_modo') setModo(null);
      if (key === 'contingencia_justificativa') setJustificativa(null);
      if (key === 'emitirReformaTributaria') setRtc(null);
    }
    setConflict(null);
    void queryClient.invalidateQueries({ queryKey: ['nfeconfig', filialId] });
  }

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
        <StatusRow target="normal" label="SEFAZ (normal)" filialId={filialId} />
        <StatusRow target="svc" label="SVC (contingência)" filialId={filialId} />
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
                {cfg.ambiente === AMBIENTE_NFE.producao ? 'Produção' : 'Homologação'}
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
              { value: 'epec', label: MODO_LABELS.epec },
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

          {cfg.contingencia_modo !== CONTINGENCIA_MODO.none && cfg.contingencia_dataInicio && (
            <Text size="xs" c="dimmed">
              Contingência ativa desde{' '}
              {new Date(cfg.contingencia_dataInicio).toLocaleString('pt-BR')}.
            </Text>
          )}

          <Switch
            mt="sm"
            label="Emitir Reforma Tributária (IBS/CBS/IS)"
            description="Inclui os grupos IBS/CBS/IS (NT 2025.002) na NF-e. Mantenha DESLIGADO em produção até a SEFAZ publicar as regras do Simples Nacional (obrigatório só em 04/01/2027). Teste primeiro em homologação."
            checked={rtcValue}
            onChange={(e) => setRtc(e.currentTarget.checked)}
            disabled={!canWrite}
          />

          <Group>
            <Button
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!canWrite || !dirty || justInvalid}
            >
              Salvar configuração
            </Button>
          </Group>
        </Stack>
      )}

      <ConflictModal
        opened={conflict !== null}
        title="Configuração de NF-e alterada"
        description="A configuração desta filial foi alterada desde que você abriu esta aba."
        fields={
          conflict
            ? buildConflictFields(
                cfg ?? {},
                conflict.current,
                conflict.fields,
                new Set<string>(conflict.fields),
                { labelFor: (f) => labelFromShape(nfeConfigSchema.shape, f) },
              )
            : []
        }
        saving={save.isPending}
        onForceSave={() => save.mutate()}
        onReloadFromServer={reloadFromServer}
        onCancel={() => setConflict(null)}
      />
    </Stack>
  );
}
