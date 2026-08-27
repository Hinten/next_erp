'use client';

import { useMemo } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { AiReviewAtual, AiReviewModal, type AiReviewFeedback } from '@delfrance/ui';

import type {
  MercadoLivreAtributoSugestao,
  MercadoLivreAtributosSugestao,
  MercadoLivreCategoriaAtributo,
} from '@/lib/mercado-livre/client';
import { isFilled, isNaRow, type AttrRow } from '@/lib/mercado-livre/attributeForm';
import { unitLabel } from '@/lib/mercado-livre/units';

export interface AtributosAiModalProps {
  opened: boolean;
  onClose: () => void;
  /** Null while the call is still out — the modal is its own spinner. */
  resultado: MercadoLivreAtributosSugestao | null;
  /** The category metadata, for names and units. */
  attrs: MercadoLivreCategoriaAtributo[];
  /** The grid as it stands, so "Atual" is honest. */
  rows: AttrRow[];
  onApply: (aceitas: MercadoLivreAtributoSugestao[]) => void;
  feedback?: AiReviewFeedback;
}

/**
 * Review the model's proposed attributes before any of them reach the listing.
 *
 * ⚠️ **Nothing is applied until Aplicar** — #799's stated criterion, and the
 * reason the route is named `sugerir-` rather than `preencher-`. The dialog
 * itself is the shared `AiReviewModal`; what lives here is attribute-shaped: the
 * pre-check rule, the value formatting, and the provenance banner.
 */
export function AtributosAiModal({
  opened,
  onClose,
  resultado,
  attrs,
  rows,
  onApply,
  feedback,
}: AtributosAiModalProps) {
  const nomePorId = useMemo(() => new Map(attrs.map((a) => [a.id, a.name ?? a.id])), [attrs]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  /** The value currently in the grid for this attribute, or null when empty. */
  function atualDe(id: string): string | null {
    const row = rowById.get(id);
    if (row == null || !isFilled(row)) return null;
    return row.value_name ?? row.value_id;
  }

  return (
    <AiReviewModal<MercadoLivreAtributoSugestao>
      opened={opened}
      onClose={onClose}
      title="Atributos sugeridos pela IA"
      data-testid="ml-atributos-ai-modal"
      items={resultado?.sugestoes ?? null}
      loadingLabel="Lendo o produto e a categoria…"
      emptyTitle="Nenhum atributo foi preenchido"
      emptyMessage="O modelo não conseguiu determinar nenhum atributo com segurança a partir do nome, da descrição e da foto. Preencha à mão, ou enriqueça a descrição do produto e peça de novo."
      keyOf={(s) => s.id}
      // ⚠️ TWO conditions, and the second is the one that matters. An attribute
      // the operator already filled starts unticked so a suggestion can never
      // overwrite typed work by default — and an N/A is NEVER pre-ticked even
      // though the field it lands on is empty by definition. ML's `-1` sentinel
      // SATISFIES the required check, so an auto-applied one would publish a
      // "does not apply" claim AND silence the validation that exists to catch
      // the missing value. Saying "this does not apply" stays a human decision.
      shouldPreCheck={(s) => atualDe(s.id) == null && !isNaRow(s)}
      labelOf={(s) => nomePorId.get(s.id) ?? s.id}
      selectionLabel={(n, total) => `${String(n)} de ${String(total)} atributos selecionados.`}
      banners={resultado != null ? <Fonte resultado={resultado} /> : null}
      columns={[
        { label: 'Atributo', render: (s) => nomePorId.get(s.id) ?? s.id },
        { label: 'Atual', render: (s) => <AiReviewAtual atual={atualDe(s.id)} /> },
        {
          label: 'Sugerido',
          render: (s) => (
            <Text size="sm" fw={500} c={isNaRow(s) ? 'dimmed' : undefined}>
              {isNaRow(s) ? 'Não se aplica' : s.value_name}
              {s.unit_id != null && !isNaRow(s) ? ` ${unitLabel(s.unit_id)}` : ''}
            </Text>
          ),
        },
      ]}
      onApply={onApply}
      feedback={feedback}
    />
  );
}

/**
 * What the model actually saw.
 *
 * ⚠️ `comFoto: false` is worth saying out loud. Several ML attributes are only
 * answerable from a photo (material, print, sleeve length), so a produto with no
 * usable image gets a thinner answer for a reason that is nothing to do with the
 * model — and the operator would otherwise blame it.
 */
function Fonte({ resultado }: { resultado: MercadoLivreAtributosSugestao }) {
  return (
    <Stack gap="xs">
      {!resultado.comFoto && (
        <Alert color="orange" variant="light" title="Sem foto do produto">
          Nenhuma foto legível foi encontrada neste produto, então o modelo usou apenas o nome, a
          marca e a descrição. Atributos que só se veem na imagem tendem a vir em branco.
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        {resultado.atributos} atributos oferecidos ao modelo · nada é gravado até você confirmar.
      </Text>
    </Stack>
  );
}
