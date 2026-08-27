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
 * here: the cell key, the size label, and the provenance banners. The checkbox
 * set, the seed-once rule, Marcar/Desmarcar todas and the Aplicar gate are the
 * generic half, and having them in one place is what stops "a suggestion is
 * offered, never applied" from meaning something slightly different on each
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

  // ⚠️ `aiCellKey` and `preCheckedCells` are IMPORTED, not reimplemented. Both
  // ship from `@delfrance/ai` with their own unit tests and this modal is their
  // only production consumer — a local copy of the key or of the pre-check rule
  // would leave the tested ones with no caller at all.
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
      loadingLabel="Lendo a tabela de medidas…"
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
              {/*
                A size-equivalence cell maps one row onto SEVERAL standard sizes,
                so the list is what the operator has to judge. `value_name`
                already carries the members joined, but reading them off the list
                keeps this row honest if that ever stops being true.
              */}
              {s.valueList != null && s.valueList.length > 0
                ? s.valueList.map((v) => v.name).join(', ')
                : s.value_name}
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
 * ⚠️ This exists because a text-only answer to a transcription task is close to
 * worthless, and without saying so the operator blames the model. The two
 * photo-less cases carry OPPOSITE instructions, which is why `contexto` reports
 * `fotos` and `anexadas` separately rather than one flag: a tabela with no photo
 * needs one uploaded, while a tabela whose photo has no readable copy yet needs
 * only time — telling that operator to "envie a foto" sends them to redo the
 * thing they just did.
 */
function Fonte({ resultado }: { resultado: MercadoLivreMedidasSugestao }) {
  const { fotos, anexadas, descricao, codigo, referencia } = resultado.contexto;

  // Everything that reached the model, in the order it matters. Listing the
  // sources is what lets the operator judge the ANSWER instead of guessing
  // whether the model was given anything to work with.
  const usados: string[] = [];
  if (fotos > 0) usados.push(fotos === 1 ? '1 foto' : `${String(fotos)} fotos`);
  if (descricao) usados.push('descrição');
  if (codigo) usados.push('código');
  if (referencia) usados.push('1 guia de referência');

  return (
    <Stack gap="xs">
      {fotos === 0 && anexadas === 0 && (
        <Alert color="orange" variant="light" title="Sem foto da tabela">
          Esta tabela de medidas não tem nenhuma foto, então o modelo usou apenas o texto. Envie a
          foto da tabela do fornecedor na aba Fotos para um resultado melhor.
        </Alert>
      )}
      {fotos === 0 && anexadas > 0 && (
        <Alert color="orange" variant="light" title="Não foi possível ler a foto">
          {/*
            ⚠️ Both halves matter. "Not processed yet" is only ONE of the reasons
            a photo that exists cannot be read — a format outside the allowlist,
            a file over the size ceiling, or a batch over the request budget are
            all PERMANENT, and an alert that says only "aguarde" leaves that
            operator retrying forever while forbidding the one action that would
            actually fix it.
          */}
          {anexadas === 1 ? 'A foto desta tabela' : 'As fotos desta tabela'} não
          {anexadas === 1 ? ' pôde' : ' puderam'} ser {anexadas === 1 ? 'lida' : 'lidas'}, então o
          modelo usou apenas o texto. Se a foto acabou de ser enviada, aguarde alguns instantes e
          tente de novo; se continuar, envie uma versão menor ou em JPEG.
        </Alert>
      )}
      {resultado.truncado && (
        <Alert color="yellow" variant="light" title="A grade foi reduzida">
          Parte da grade ficou de fora do pedido (limite de linhas/colunas, ou dois tamanhos com o
          mesmo nome). As medidas que faltarem precisam ser preenchidas à mão.
        </Alert>
      )}
      <Text size="xs" c="dimmed" data-testid="ml-size-chart-ai-fonte">
        {usados.length > 0 ? usados.join(' · ') : 'nenhum contexto disponível'} ·{' '}
        {resultado.celulas} células oferecidas ao modelo · nada é gravado até você confirmar.
      </Text>
    </Stack>
  );
}
