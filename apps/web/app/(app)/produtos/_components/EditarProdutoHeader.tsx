'use client';

import Link from 'next/link';
import { Anchor } from '@mantine/core';
import { useWatch } from 'react-hook-form';
import { PageHeader } from '@delfrance/ui';

/** Stands in for a `nome` that is null, absent, empty or whitespace-only. */
const SEM_NOME = 'produto sem nome';
/** Stands in for a `sku` that is null, absent, empty or whitespace-only. */
const SEM_SKU = 'sem sku';

/** The form value as something displayable, or null when there is nothing to show. */
function displayable(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The produto editor heading: `Editar <nome> - <sku>`.
 *
 * Each half falls back on its own, so the half that IS filled in still names the
 * record — a produto carrying a sku but no name reads
 * `Editar produto sem nome - CAM-001`, not a generic "sem nome ou sem sku".
 *
 * Pure, and exported for the branch table in the tests.
 */
export function buildEditarProdutoTitle(nome: unknown, sku: unknown): string {
  return `Editar ${displayable(nome) ?? SEM_NOME} - ${displayable(sku) ?? SEM_SKU}`;
}

export interface EditarProdutoHeaderProps {
  /**
   * True while the produto document has not emitted yet. The form still holds
   * `buildEmptyDefaults`' `nome: ''` / `sku: null` at that point, so without this
   * the heading would flash "Editar produto sem nome - sem sku" over the loading
   * skeletons — show the neutral title until there is something real to name.
   */
  loading: boolean;
}

/**
 * Header for `/produtos/<id>/editar`, tracking the FORM's `nome`/`sku` live so a
 * rename shows up while it is still being typed (the saved document would only
 * catch up at save time).
 *
 * ⚠️ Must be handed to `ObjectView`'s `title` prop, NOT rendered as a sibling of
 * `<ObjectView>` where the page's `<PageHeader>` used to sit. That placement is
 * load-bearing twice and the type signature says neither: it is what puts this
 * inside the form's `FormProvider`, which is the only reason `useWatch` resolves
 * a control at all — and it is what keeps a keystroke from re-rendering the page
 * and, with it, every field in all fifteen tabs.
 */
export function EditarProdutoHeader({ loading }: EditarProdutoHeaderProps) {
  // No `control`: RHF takes it from the surrounding FormProvider.
  const [nome, sku] = useWatch({ name: ['nome', 'sku'] }) as [unknown, unknown];
  return (
    <PageHeader
      // A plain STRING on purpose — that is what gets PageHeader's
      // `<Title order={2}>` wrapper, and with it the `heading` role the e2e
      // specs query. A node would render bare.
      title={loading ? 'Editar produto' : buildEditarProdutoTitle(nome, sku)}
      actions={
        <Anchor component={Link} href="/produtos" size="sm">
          Cancelar
        </Anchor>
      }
    />
  );
}
