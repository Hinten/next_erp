import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import type { AttrRow } from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';
import { AtributosSection } from './AtributosSection';

function attr(over: Partial<MercadoLivreCategoriaAtributo> = {}): MercadoLivreCategoriaAtributo {
  return {
    id: 'BRAND',
    name: 'Marca',
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    allowedUnits: [],
    groupId: null,
    groupName: null,
    required: false,
    multivalued: false,
    readOnly: false,
    relevance: 1,
    ...over,
  };
}

/** By role — a Mantine Combobox's label names both its input and its listbox. */
const combo = (name: string) => screen.getByRole('combobox', { name });

function renderSection(props: Partial<Parameters<typeof AtributosSection>[0]> = {}) {
  const onRowsChange = vi.fn();
  render(
    <MantineProvider env="test">
      <AtributosSection
        categoryId="MLB31447"
        attrs={[attr()]}
        rows={[]}
        onRowsChange={onRowsChange}
        errors={{}}
        leaf
        loading={false}
        failed={false}
        {...props}
      />
    </MantineProvider>,
  );
  return onRowsChange;
}

describe('AtributosSection', () => {
  it('sends the operator to the cascade before showing an empty grid', () => {
    renderSection({ categoryId: null });
    expect(screen.getByText(/Escolha a categoria do Mercado Livre/)).toBeDefined();
  });

  it('explains a mid-tree category instead of rendering nothing', () => {
    // A Flutter-written `category_id` can point at a non-leaf, which has no
    // attributes at all — an empty grid there reads as "needs nothing".
    renderSection({ leaf: false });
    expect(screen.getByText(/não é uma categoria final/)).toBeDefined();
  });

  it('says the stored attributes are safe when the metadata call fails', () => {
    // The purge rule runs off this metadata; with none loaded nothing is
    // written, and the operator should know that rather than assume loss.
    renderSection({ failed: true });
    expect(screen.getByText(/Os atributos já salvos continuam intactos/)).toBeDefined();
  });

  it('counts the required attributes still missing a value', () => {
    renderSection({
      attrs: [attr({ id: 'BRAND', required: true }), attr({ id: 'MODEL', required: true })],
      errors: { BRAND: 'Este campo é obrigatório', MODEL: 'Este campo é obrigatório' },
    });
    expect(screen.getByText('2 obrigatório(s) sem valor')).toBeDefined();
  });

  it('reports an edit without mutating the row it was given', () => {
    const onRowsChange = renderSection({
      attrs: [attr({ id: 'BRAND', name: 'Marca' })],
      rows: [{ id: 'BRAND', value_id: null, value_name: null, unit_id: null }],
    });
    fireEvent.change(combo('Marca'), { target: { value: 'Hering' } });
    expect(onRowsChange).toHaveBeenCalledOnce();
    const next = onRowsChange.mock.calls[0]![0] as AttrRow[];
    expect(next).toEqual([{ id: 'BRAND', value_id: null, value_name: 'Hering', unit_id: null }]);
  });

  it('adds a row for an attribute that had none stored', () => {
    const onRowsChange = renderSection({
      attrs: [attr({ id: 'BRAND', name: 'Marca' })],
      rows: [],
    });
    fireEvent.change(combo('Marca'), { target: { value: 'Hering' } });
    expect((onRowsChange.mock.calls[0]![0] as AttrRow[])[0]!.value_name).toBe('Hering');
  });

  it('states plainly that a category needs no attributes', () => {
    renderSection({ attrs: [] });
    expect(screen.getByText('Esta categoria não exige atributos.')).toBeDefined();
  });
});

describe('the attribute cells alternate background', () => {
  it('stripes every other cell', () => {
    // A rich category runs to 30+ fields of near-identical shape; the stripe is
    // the only edge the eye can track along.
    renderSection({
      attrs: [
        attr({ id: 'A', name: 'Um' }),
        attr({ id: 'B', name: 'Dois' }),
        attr({ id: 'C', name: 'Três' }),
      ],
      rows: [],
    });
    const cells = [...document.querySelectorAll('.mantine-Paper-root')];
    expect(cells).toHaveLength(3);
    // Mantine renders `bg` as a `background:` declaration on the style
    // attribute; the undefined case emits nothing, which is what tells them
    // apart.
    const painted = cells.map((c) => c.getAttribute('style')?.includes('background:') ?? false);
    expect(painted).toEqual([false, true, false]);
  });

  it('uses a theme token, not a fixed grey, so dark mode survives', () => {
    // `gray.0` would be invisible-to-wrong on a dark background.
    renderSection({
      attrs: [attr({ id: 'A', name: 'Um' }), attr({ id: 'B', name: 'Dois' })],
      rows: [],
    });
    const striped = [...document.querySelectorAll('.mantine-Paper-root')][1]!;
    expect(striped.getAttribute('style')).toContain('var(--mantine-color-default-hover)');
  });
});
