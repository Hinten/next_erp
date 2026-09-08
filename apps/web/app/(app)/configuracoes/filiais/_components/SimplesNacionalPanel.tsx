'use client';

/**
 * "Simples Nacional" tab for one Filial — the config doc at
 * `filiais/{filialId}/simplesnacional/default` (#1491).
 *
 * Two halves, and the split is the point:
 *
 *   1. **What the operator sets** — anexo, the alíquota the accountant
 *      informed, and whether the monthly runner may PUBLISH what it computes.
 *   2. **What the runner computed** — RBT12, faixa, alíquota efetiva,
 *      competência and the two note counters. Read-only here: the runner is
 *      their single writer, which is what keeps sibling filiais of one CNPJ
 *      from disagreeing on a figure the Receita defines per company.
 *
 * ⚠️ The panel's real job is making `estadoApuracao` legible. `incompleta` is
 * not a neutral badge — it means the RBT12 could not be read in full, so the
 * previous rate still stands. Firestore's `sum()` skips a document missing the
 * summed field in SILENCE, so an unreadable note would otherwise shrink revenue,
 * lower the faixa and under-declare the tax with every job reporting success.
 * Saying so on screen is the human half of that guard.
 */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc } from 'firebase/firestore';
import { z } from 'zod';

import { PERM } from '@delfrance/auth';
import { formatReais } from '@delfrance/core/money';
import {
  ANEXO_SIMPLES_LABELS,
  APURACAO_ESTADO,
  type AnexoSimplesWire,
  type ApuracaoEstado,
  type SimplesNacionalConfig,
} from '@delfrance/schemas';

import { usePermission } from '@/lib/auth';
import {
  SIMPLES_CONFIG_DOC_ID,
  simplesNacionalConfigCollection,
} from '@/lib/data/simplesNacionalConfigCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { createSimplesConfigPort } from '@/lib/fiscal/simplesConfigPort';
import {
  SimplesConfigConflictError,
  SimplesConfigJaExisteError,
  saveSimplesConfig,
  type PainelSimplesKey,
} from '@/lib/fiscal/saveSimplesConfig';

/** A fraction (0.06728) as a pt-BR percentage with three decimals. */
export function formatAliquota(fracao: number | null): string {
  if (fracao === null) return '—';
  return `${(fracao * 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })}%`;
}

/**
 * How each apuração state reads on screen.
 *
 * ⚠️ `incompleta` is a WARNING, not information. It is the one state where the
 * number on screen is known to be untrustworthy, and the operator has to
 * understand that the previous rate is still the one being applied.
 */
export function descreverEstado(
  estado: ApuracaoEstado | null,
  notasIlegiveis: number | null,
): { cor: string; titulo: string; detalhe: string } | null {
  switch (estado) {
    case APURACAO_ESTADO.vigente:
      return {
        cor: 'green',
        titulo: 'Alíquota vigente',
        detalhe: 'A apuração do mês foi publicada e é a alíquota aplicada às emissões.',
      };
    case APURACAO_ESTADO.incompleta:
      return {
        cor: 'red',
        titulo: 'Apuração incompleta — a alíquota NÃO foi atualizada',
        detalhe:
          `${notasIlegiveis ?? 0} nota(s) da janela de 12 meses não puderam ser lidas, então a ` +
          'RBT12 está incompleta e uma receita menor daria uma faixa menor. A alíquota anterior ' +
          'continua valendo até que essas notas sejam recuperadas.',
      };
    case APURACAO_ESTADO.aguardandoAutorizacao:
      return {
        cor: 'yellow',
        titulo: 'Calculada, aguardando autorização',
        detalhe:
          'A apuração rodou e está registrada, mas o recálculo automático está desligado — ' +
          'ligue-o abaixo para que ela passe a ser a alíquota aplicada.',
      };
    case APURACAO_ESTADO.foraDoRegime:
      return {
        cor: 'orange',
        titulo: 'RBT12 fora do Simples Nacional',
        detalhe:
          'A receita dos 12 meses está zerada, negativa ou acima do teto de R$ 4.800.000 — ' +
          'a fórmula do Simples não se aplica. Fale com a contabilidade.',
      };
    case null:
      // Never apurada. An invented badge would imply a run that never happened.
      return null;
    default:
      return null;
  }
}

export function SimplesNacionalPanel({ filialId }: { filialId: string }) {
  const db = getFirebaseFirestore();
  const queryClient = useQueryClient();
  const { allowed: canWrite } = usePermission(PERM.fiscal.write);

  const cfgQuery = useQuery({
    queryKey: ['simplesnacional', filialId],
    queryFn: async () => {
      const snap = await getDoc(
        simplesNacionalConfigCollection.docRef(db, { filialId }, SIMPLES_CONFIG_DOC_ID),
      );
      return snap.exists() ? snap.data() : null;
    },
  });

  const [anexo, setAnexo] = useState<AnexoSimplesWire | null>(null);
  const [aliquota, setAliquota] = useState<number | null>(null);
  const [recalculo, setRecalculo] = useState<boolean | null>(null);
  const [conflict, setConflict] = useState<{
    current: SimplesNacionalConfig;
    fields: PainelSimplesKey[];
  } | null>(null);

  const cfg = cfgQuery.data ?? null;
  // Once a conflict is known the server's version is the truth the form mirrors
  // — showing the stale doc the operator already lost to would be worse than
  // useless.
  const base = conflict?.current ?? cfg;

  const anexoValue = anexo ?? base?.anexo ?? 'I';
  // Stored as a FRACTION, typed as a percentage — the input shows 6,728 while
  // the document holds 0.06728.
  const aliquotaValue =
    aliquota ?? (base?.aliquotaDeclarada != null ? base.aliquotaDeclarada * 100 : null);
  const recalculoValue = recalculo ?? base?.recalculoAutomatico ?? false;

  const dirty =
    base == null ||
    anexoValue !== base.anexo ||
    recalculoValue !== base.recalculoAutomatico ||
    (aliquotaValue ?? null) !==
      (base.aliquotaDeclarada != null ? base.aliquotaDeclarada * 100 : null);

  const save = useMutation({
    mutationFn: async () => {
      await saveSimplesConfig(createSimplesConfigPort(db, filialId), {
        // The RAW local edits, never the `*Value` bindings — those fold in the
        // render-time doc, and an untouched field must stay unwritten so it
        // cannot lose a race it never entered.
        anexo,
        aliquotaDeclarada: aliquota === null ? null : aliquota / 100,
        recalculoAutomatico: recalculo,
        baseline: base,
      });
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Configuração do Simples Nacional salva.' });
      setAnexo(null);
      setAliquota(null);
      setRecalculo(null);
      setConflict(null);
      void queryClient.invalidateQueries({ queryKey: ['simplesnacional', filialId] });
    },
    onError: (err) => {
      if (err instanceof SimplesConfigConflictError) {
        setConflict({ current: err.current, fields: err.fields });
        return;
      }
      if (err instanceof SimplesConfigJaExisteError) {
        notifications.show({ color: 'red', title: 'Falha ao salvar', message: err.message });
        void queryClient.invalidateQueries({ queryKey: ['simplesnacional', filialId] });
        return;
      }
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
      <Alert color="red" title="Falha ao carregar a configuração do Simples Nacional">
        {cfgQuery.error instanceof Error ? cfgQuery.error.message : 'Erro desconhecido'}
      </Alert>
    );
  }

  const estado = descreverEstado(base?.estadoApuracao ?? null, base?.notasIlegiveis ?? null);

  return (
    <Stack gap="lg" maw={720}>
      {cfg == null && (
        <Alert color="blue" title="Simples Nacional ainda não configurado">
          Esta filial não tem o documento <Code>simplesnacional/default</Code>. Preencha abaixo e
          salve para criá-lo — a apuração mensal só considera filiais configuradas.
        </Alert>
      )}

      {conflict != null && (
        <Alert color="orange" title="Alterada por outra pessoa">
          {conflict.fields.join(', ')} mudou desde que esta tela foi aberta. Os valores exibidos já
          são os do servidor; salvar de novo aplica sua edição sobre eles.
        </Alert>
      )}

      {estado != null && (
        <Alert color={estado.cor} title={estado.titulo}>
          {estado.detalhe}
        </Alert>
      )}

      <Stack gap="xs">
        <Title order={5}>Apuração</Title>
        <Group gap="lg">
          <Text size="sm" c="dimmed">
            RBT12:{' '}
            <Text span fw={500}>
              {base?.rbt12 != null ? formatReais(base.rbt12) : '—'}
            </Text>
          </Text>
          <Text size="sm" c="dimmed">
            Faixa:{' '}
            <Text span fw={500}>
              {base?.faixa ?? '—'}
            </Text>
          </Text>
          <Text size="sm" c="dimmed">
            Alíquota efetiva:{' '}
            <Text span fw={500}>
              {formatAliquota(base?.aliquotaEfetiva ?? null)}
            </Text>
          </Text>
          <Text size="sm" c="dimmed">
            Competência:{' '}
            <Text span fw={500}>
              {base?.competencia ?? '—'}
            </Text>
          </Text>
        </Group>

        {/* ⚠️ A faixa maior NÃO é necessariamente a mais cara: ao cruzar
            R$ 3.600.000 a alíquota efetiva CAI, e no Anexo I ela nunca volta ao
            pico da 5ª faixa. Dizer isso aqui evita que alguém "corrija" um
            número que está certo. */}
        <Text size="xs" c="dimmed">
          A faixa indica o intervalo de RBT12, não a carga: ao passar de R$ 3.600.000,00 a alíquota
          efetiva cai (Anexo I: 11,875% → 8,500%) por causa da parcela a deduzir da 6ª faixa.
        </Text>

        {(base?.notasNeutras ?? 0) > 0 && (
          <Text size="xs" c="dimmed">
            {base?.notasNeutras} nota(s) contadas como zero na janela (ajuste, ou devolução de
            compra) — não são receita, mas ficam registradas para conferência.
          </Text>
        )}
        {(base?.filiaisConsolidadas?.length ?? 0) > 1 && (
          <Text size="xs" c="dimmed">
            RBT12 consolidada com {base?.filiaisConsolidadas.length} filiais do mesmo CNPJ — a
            Receita apura o Simples pela empresa inteira, não por estabelecimento.
          </Text>
        )}
      </Stack>

      <Stack gap="sm">
        <Title order={5}>Configuração</Title>
        <Select
          label="Anexo"
          description="Anexo I para revenda, II para industrialização própria."
          data={Object.entries(ANEXO_SIMPLES_LABELS).map(([value, label]) => ({ value, label }))}
          value={anexoValue}
          onChange={(v) => setAnexo((v as AnexoSimplesWire | null) ?? null)}
          disabled={!canWrite}
          allowDeselect={false}
        />
        <NumberInput
          label="Alíquota informada pela contabilidade (%)"
          description="Usada quando ainda não há 12 meses de histórico apurável, e para conferir o valor calculado."
          value={aliquotaValue ?? ''}
          onChange={(v) => setAliquota(typeof v === 'number' ? v : null)}
          disabled={!canWrite}
          decimalScale={4}
          min={0}
          max={100}
          suffix="%"
        />
        <Switch
          label="Recalcular automaticamente"
          description="Autoriza a apuração mensal a publicar a alíquota que calcular. Desligado, ela apura e registra, mas não altera a alíquota aplicada."
          checked={recalculoValue}
          onChange={(e) => setRecalculo(e.currentTarget.checked)}
          disabled={!canWrite}
        />
        <Group>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!canWrite || !dirty}
          >
            {cfg == null ? 'Criar configuração' : 'Salvar'}
          </Button>
          {base?.calculadoEm != null && (
            <Badge variant="light" color="gray">
              apurado em {new Date(base.calculadoEm).toLocaleString('pt-BR')}
            </Badge>
          )}
        </Group>
      </Stack>
    </Stack>
  );
}
