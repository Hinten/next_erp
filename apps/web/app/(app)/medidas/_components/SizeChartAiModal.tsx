'use client';

import { useMemo } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { AiReviewAtual, AiReviewModal } from '@delfrance/ui';
import { aiCellKey, preCheckedCells } from '@delfrance/ai';
import type { MercadoLivreMedidasSugestao } from '@/lib/mercado-livre/client';
import type { ChartColumn } from '@/lib/mercado-livre/chartSpec';
import { type ChartRowDraft, isFilled } from '@/lib/mercado-livre/chartRows';

type MedidaSugestao = MercadoLivreMedidasSugestao['sugestoes'][number];

/**
 * Review the model's proposed measurements before any of them reach the grid.
 *
 * ⚠️ **Nothing is applied until Aplicar.** That is the whole point of the screen,
 * and it is not caution for its own sake: a measurement that is wrong is
 * indistinguishable from one that is right once it is in the grid, and it ships
 * to buyers. The operator has to see `atual → sugerido` for every cell before
 * agreeing.
 *
 * ⚠️ The dialog itself is `AiReviewModal` from `@delfrance/ui` — the shared
 * staging surface every agent answers through. What is measurement-shaped stays
 * here: the cell key, the size label, and the two provenance banners. The
 * checkbox set, the seed-once rule, Marcar/Desmarcar todas and the Aplicar gate
 * are the generic half, and having them in one place is what stops "a suggestion
 * is offered, never applied" from meaning something slightly different on each
 * screen.
 */
export interface SizeChartAiModalProps {
  opened: boolean;
  onClose: () => void;
  /** Null while the call is still out. */
  resultado: MercadoLivreMedidasSugestao | null;
  rows: ChartRowDraft[];
  columns: ChartColumn[];
  /**
   * The chart's main attribute — where each row's size label lives.
   *
   * ⚠️ Not always `SIZE`: a footwear chart's main attribute is `EU_SIZE` or
   * `M_US_SIZE`, and hardcoding `SIZE` would leave every row of this table
   * labelled blank on exactly the domains that motivated the picker.
   */
  mainAttributeId: string;
  /** Applies the accepted cells. Only ever called with a non-empty list. */
  onApply: (aceitas: MercadoLivreMedidasSugestao['sugestoes']) => void;
}

export function SizeChartAiModal({
  opened,
  onClose,
  resultado,
  rows,
  columns,
  mainAttributeId,
  onApply,
}: SizeChartAiModalProps) {
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const labelByAttr = useMemo(() => {
    const out = new Map<string, string>();
    for (const column of columns) {
      for (const part of column.parts) out.set(part.attributeId, part.label);
    }
    return out;
  }, [columns]);

  /** The current value of the cell a suggestion lands on, or null when empty. */
  function atualDe(rowKey: string, attributeId: string): string | null {
    const cell = rowByKey.get(rowKey)?.cells[attributeId];
    if (!isFilled(cell)) return null;
    return cell?.value_name ?? cell?.valueList?.map((v) => v.name).join(', ') ?? null;
  }

  // ⚠️ `preCheckedCells` is IMPORTED, not reimplemented. It ships from
  // `@delfrance/ai` with its own unit tests and this modal is its only
  // production consumer — a local copy of the rule would leave the tested one
  // with no caller at all.
  const preChecked = useMemo(
    () =>
      new Set(
        preCheckedCells(resultado?.sugestoes ?? [], (rowKey, attributeId) =>
          isFilled(rowByKey.get(rowKey)?.cells[attributeId]),
        ),
      ),
    [resultado, rowByKey],
  );

  return (
    <AiReviewModal<MedidaSugestao>
      opened={opened}
      onClose={onClose}
      title="Medidas sugeridas pela IA"
      data-testid="ml-size-chart-ai-modal"
      items={resultado?.sugestoes ?? null}
      loadingLabel="Lendo a foto da tabela…"
      emptyTitle="Nenhuma medida foi lida"
      emptyMessage="O modelo não conseguiu ler nenhuma medida com segurança. Confira se a foto da tabela está legível e se os tamanhos da guia batem com os da tabela."
      keyOf={(s) => aiCellKey(s.rowKey, s.attributeId)}
      shouldPreCheck={(s) => preChecked.has(aiCellKey(s.rowKey, s.attributeId))}
      labelOf={(s) => labelByAttr.get(s.attributeId) ?? s.attributeId}
      selectionLabel={(n, total) => `${String(n)} de ${String(total)} medidas selecionadas.`}
      banners={resultado != null ? <Fonte resultado={resultado} /> : null}
      columns={[
        {
          label: 'Tamanho',
          render: (s) =>
            rowByKey.get(s.rowKey)?.cells[mainAttributeId]?.value_name ?? s.rowKey.split('/').pop(),
        },
        { label: 'Medida', render: (s) => labelByAttr.get(s.attributeId) ?? s.attributeId },
        {
          label: 'Atual',
          render: (s) => <AiReviewAtual atual={atualDe(s.rowKey, s.attributeId)} />,
        },
        {
          label: 'Sugerido',
          render: (s) => (
            <Text size="sm" fw={500}>
              {s.value_name}
            </Text>
          ),
        },
      ]}
      onApply={onApply}
    />
  );
}

/**
 * What the model actually saw.
 *
 * ⚠️ `comFoto: false` is the case this exists for. A tabela whose photo predates
 * the resize rollout has no derivative to read, so the agent falls back to the
 * description alone — and a text-only answer to a transcription task is close to
 * worthless. Without this line the operator would blame the model.
 */
function Fonte({ resultado }: { resultado: MercadoLivreMedidasSugestao }) {
  return (
    <Stack gap="xs">
      {!resultado.comFoto && (
        <Alert color="orange" variant="light" title="Sem foto da tabela">
          Nenhuma foto legível foi encontrada nesta tabela de medidas, então o modelo usou apenas a
          descrição. Envie a foto da tabela do fornecedor na aba Fotos para um resultado melhor.
        </Alert>
      )}
      {resultado.truncado && (
        <Alert color="yellow" variant="light" title="A grade foi reduzida">
          Parte da grade ficou de fora do pedido (limite de linhas/colunas, ou dois tamanhos com o
          mesmo nome). As medidas que faltarem precisam ser preenchidas à mão.
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        {resultado.celulas} células oferecidas ao modelo · nada é gravado até você confirmar.
      </Text>
    </Stack>
  );
}
