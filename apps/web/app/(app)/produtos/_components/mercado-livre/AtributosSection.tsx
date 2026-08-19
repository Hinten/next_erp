'use client';

import type { ReactNode } from 'react';
import { Alert, Badge, Group, Loader, Paper, SimpleGrid, Text } from '@mantine/core';

import type { AttrRow } from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { AttributeField } from './AttributeField';

/**
 * Alternating cell background, by position in the grid.
 *
 * ⚠️ On a 2- or 3-column layout this reads as a **checkerboard**, not as rows —
 * a deliberate trade Lucas accepted, because striping true rows would need the
 * live column count and the grid is responsive. The point is the edge between
 * neighbouring fields, which a checkerboard still provides.
 */
function stripeBg(index: number): string | undefined {
  return index % 2 === 1 ? 'var(--mantine-color-default-hover)' : undefined;
}

export interface AtributosSectionProps {
  /** Null while no category is chosen — the cascade comes first. */
  categoryId: string | null;
  attrs: MercadoLivreCategoriaAtributo[];
  rows: AttrRow[];
  onRowsChange: (rows: AttrRow[]) => void;
  /** Per-attribute validation messages, keyed by attribute id. */
  errors: Record<string, string>;
  /** False ⇒ the stored category is mid-tree and has no attributes. */
  leaf: boolean;
  loading: boolean;
  failed: boolean;
  /**
   * Re-runs the attribute load. Omitted when the failure is one a retry cannot
   * fix — without it the whole grid stayed replaced by the alert until the
   * operator switched category away and back, or reloaded the page.
   */
  onRetry?: () => void;
  retrying?: boolean;
  disabled?: boolean;
  /**
   * The "Preencher com IA" trigger, rendered in this section's header.
   *
   * ⚠️ Passed IN rather than built here. The call needs `produtoId`,
   * `integracaoId` and the form's current category — all of which live in
   * `ListingForm` — and this component is otherwise a pure function of its
   * props. It sits in the header because that is the row above the grid the
   * suggestions actually fill.
   */
  acaoIa?: ReactNode;
}

/**
 * The per-category attribute grid — the last thing standing between a fresh
 * produto and an accepted publish.
 *
 * `link.attributes` was `null` on every produto this app created, because no
 * screen could author it, and most ML categories answer that with
 * `item.attributes.required`. This is that screen.
 *
 * Order and membership are the SERVER's decision (`projectCategoriaAtributos`):
 * ERP-owned ids (`SELLER_SKU`, `SELLER_PACKAGE_*`), hidden attributes and
 * size-chart attributes never arrive here, and what does arrive is already
 * sorted required-first. The legacy screen wanted that ordering and never
 * shipped it — there is a commented-out `getAtributosObrigatorio` in
 * `cadastroProdutoMLNew.dart` where it should have been.
 */
export function AtributosSection({
  categoryId,
  attrs,
  rows,
  onRowsChange,
  errors,
  leaf,
  loading,
  failed,
  onRetry,
  retrying,
  disabled,
  acaoIa,
}: AtributosSectionProps) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const pendingRequired = attrs.filter((a) => a.required && errors[a.id] != null).length;

  if (categoryId == null) {
    return (
      <Alert color="blue" variant="light">
        Escolha a categoria do Mercado Livre para ver os atributos que ela exige.
      </Alert>
    );
  }

  if (loading) {
    return (
      <Group justify="center" py="sm">
        <Loader size="sm" />
      </Group>
    );
  }

  if (failed) {
    return (
      <RetryAlert
        message="Não foi possível carregar os atributos desta categoria. Os atributos já salvos continuam intactos."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }

  if (!leaf) {
    // A Flutter-written or hand-edited `category_id` can point at a mid-tree
    // node, which has no attributes at all. Saying so beats an empty grid that
    // looks like "this category needs nothing".
    return (
      <Alert color="yellow" variant="light">
        Esta categoria não é uma categoria final do Mercado Livre e por isso não tem atributos.
        Escolha uma subcategoria.
      </Alert>
    );
  }

  if (attrs.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Esta categoria não exige atributos.
      </Text>
    );
  }

  return (
    <>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Text size="sm" fw={600}>
            Atributos
          </Text>
          <Badge size="sm" variant="light">
            {attrs.length}
          </Badge>
          {pendingRequired > 0 && (
            <Badge size="sm" color="red" variant="light">
              {pendingRequired} obrigatório(s) sem valor
            </Badge>
          )}
        </Group>
        {acaoIa}
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
        {attrs.map((attr, index) => (
          // A rich category runs to 30+ fields of near-identical shape, which is
          // exactly the layout the eye loses its place in. The alternating
          // background gives each field an edge to track along.
          //
          // ⚠️ `var(--mantine-color-default-hover)`, not a palette shade like
          // `gray.0`: this has to stay legible in dark mode, and a fixed light
          // grey does not. Same token `PhotoManager` uses for its own striping.
          <Paper key={attr.id} p="xs" radius="sm" bg={stripeBg(index)}>
            <AttributeField
              attr={attr}
              row={
                rowById.get(attr.id) ?? {
                  id: attr.id,
                  value_id: null,
                  value_name: null,
                  unit_id: null,
                }
              }
              onChange={(next) =>
                onRowsChange(
                  rows.some((r) => r.id === next.id)
                    ? rows.map((r) => (r.id === next.id ? next : r))
                    : [...rows, next],
                )
              }
              disabled={disabled}
              error={errors[attr.id]}
            />
          </Paper>
        ))}
      </SimpleGrid>
    </>
  );
}
