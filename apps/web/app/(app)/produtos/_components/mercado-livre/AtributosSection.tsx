'use client';

import { Alert, Badge, Group, Loader, SimpleGrid, Text } from '@mantine/core';

import type { AttrRow } from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';
import { AttributeField } from './AttributeField';

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
  disabled?: boolean;
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
  disabled,
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
      <Alert color="red" variant="light">
        Não foi possível carregar os atributos desta categoria. Os atributos já salvos continuam
        intactos.
      </Alert>
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
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
        {attrs.map((attr) => (
          <AttributeField
            key={attr.id}
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
        ))}
      </SimpleGrid>
    </>
  );
}
