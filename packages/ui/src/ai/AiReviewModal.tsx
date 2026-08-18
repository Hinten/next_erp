'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  Textarea,
} from '@mantine/core';

/**
 * The staging dialog every AI agent in this repo answers through.
 *
 * ⚠️ **A suggestion is OFFERED, never applied.** That is #799's own criterion and
 * the reason this component exists at all: the model's answer reaches a listing
 * only through a checkbox the operator ticked. Two agents now share it — the ML
 * attribute agent and the size-chart measurement agent — and they were one copy
 * away from being two, which is the point at which a UX rule stops being a rule
 * and becomes whatever each screen happened to implement.
 *
 * Generic over the suggestion type; everything agent-shaped is a callback.
 */
export interface AiReviewColumn<TItem> {
  label: string;
  width?: number;
  render: (item: TItem) => ReactNode;
}

/** The optional "ask the model to try again" turn. */
export interface AiReviewFeedback {
  value: string;
  onChange: (value: string) => void;
  onResubmit: () => void;
  /** True while the revised answer is in flight. */
  busy: boolean;
  placeholder?: string;
}

export interface AiReviewModalProps<TItem> {
  opened: boolean;
  onClose: () => void;
  title: string;
  /**
   * `null` while the request is in flight — the modal is its own spinner, so the
   * operator sees something the instant they click rather than a frozen button.
   */
  items: TItem[] | null;
  loadingLabel: string;
  emptyTitle: string;
  emptyMessage: string;
  keyOf: (item: TItem) => string;
  /**
   * Whether this suggestion starts ticked.
   *
   * ⚠️ Evaluated ONCE per result, not per render. Re-deriving it would undo the
   * operator's own unticking the moment anything else re-rendered. The caller
   * carries the whole rule: for attributes that means "only where the field is
   * empty, and never an N/A"; for measurements, "only where the cell is empty".
   */
  shouldPreCheck: (item: TItem) => boolean;
  /** Accessible name for the row's checkbox. */
  labelOf: (item: TItem) => string;
  columns: Array<AiReviewColumn<TItem>>;
  /** "3 de 8 medidas selecionadas." — wording (and gender) is the caller's. */
  selectionLabel: (accepted: number, total: number) => string;
  /** Provenance and warnings — what the model actually saw. */
  banners?: ReactNode;
  onApply: (accepted: TItem[]) => void;
  feedback?: AiReviewFeedback;
  'data-testid'?: string;
}

export function AiReviewModal<TItem>({
  opened,
  onClose,
  title,
  items,
  loadingLabel,
  emptyTitle,
  emptyMessage,
  keyOf,
  shouldPreCheck,
  labelOf,
  columns,
  selectionLabel,
  banners,
  onApply,
  feedback,
  'data-testid': testId,
}: AiReviewModalProps<TItem>) {
  const sugestoes = useMemo(() => items ?? [], [items]);

  // Seeded once per result. The parent is expected to remount per run (a `key`
  // that changes each time), so this never survives into a later suggestion.
  const [marcadas, setMarcadas] = useState<Set<string> | null>(null);
  const seeded = useMemo(
    () => new Set(sugestoes.filter(shouldPreCheck).map(keyOf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the RESULT, not the identity of the callbacks
    [sugestoes],
  );
  const checked = marcadas ?? seeded;

  function toggle(key: string) {
    setMarcadas((prev) => {
      const next = new Set(prev ?? seeded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const aceitas = sugestoes.filter((s) => checked.has(keyOf(s)));
  const carregando = items == null;

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="xl" centered data-testid={testId}>
      <Stack gap="md">
        {carregando && <Text size="sm">{loadingLabel}</Text>}

        {!carregando && (
          <>
            {banners}

            {sugestoes.length === 0 ? (
              <Alert color="yellow" variant="light" title={emptyTitle}>
                {emptyMessage}
              </Alert>
            ) : (
              <>
                <Group justify="space-between">
                  <Text size="sm">{selectionLabel(aceitas.length, sugestoes.length)}</Text>
                  <Group gap="xs">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setMarcadas(new Set(sugestoes.map(keyOf)))}
                    >
                      Marcar todas
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setMarcadas(new Set())}
                    >
                      Desmarcar todas
                    </Button>
                  </Group>
                </Group>

                <ScrollArea.Autosize mah={420}>
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={40} />
                        {columns.map((c) => (
                          <Table.Th key={c.label} w={c.width}>
                            {c.label}
                          </Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {sugestoes.map((item) => {
                        const key = keyOf(item);
                        return (
                          <Table.Tr key={key}>
                            <Table.Td>
                              <Checkbox
                                checked={checked.has(key)}
                                onChange={() => toggle(key)}
                                aria-label={`Aplicar ${labelOf(item)}`}
                              />
                            </Table.Td>
                            {columns.map((c) => (
                              <Table.Td key={c.label}>{c.render(item)}</Table.Td>
                            ))}
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              </>
            )}
          </>
        )}

        {/* The revise turn. Deliberately below the table: it is what the operator
            reaches for AFTER reading the answer and finding it wrong. */}
        {feedback != null && !carregando && (
          <Stack gap="xs">
            <Textarea
              label="O que ajustar?"
              description="Descreva o que está errado e peça de novo. A resposta anterior é enviada junto."
              placeholder={feedback.placeholder}
              value={feedback.value}
              onChange={(e) => feedback.onChange(e.currentTarget.value)}
              autosize
              minRows={2}
              maxRows={4}
              disabled={feedback.busy}
            />
            <Group justify="flex-end">
              <Button
                variant="light"
                size="compact-sm"
                onClick={feedback.onResubmit}
                loading={feedback.busy}
                disabled={feedback.value.trim() === ''}
              >
                Pedir novamente
              </Button>
            </Group>
          </Stack>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onApply(aceitas);
              onClose();
            }}
            disabled={carregando || aceitas.length === 0}
          >
            Aplicar {aceitas.length > 0 ? `(${aceitas.length})` : ''}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The "Atual" cell every agent renders the same way. */
export function AiReviewAtual({ atual }: { atual: string | null }) {
  if (atual == null) {
    return (
      <Text size="sm" c="dimmed">
        vazio
      </Text>
    );
  }
  return (
    <Group gap={6}>
      <Text size="sm">{atual}</Text>
      <Badge size="xs" color="yellow" variant="light">
        será substituída
      </Badge>
    </Group>
  );
}
