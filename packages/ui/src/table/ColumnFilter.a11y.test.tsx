import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { ColumnFilter } from './ColumnFilter';
import type { FilterableField } from '../schema/types';

/**
 * Pins the accessibility contract that `apps/web/e2e/helpers/table-view.ts`
 * relies on to scope every filter interaction.
 *
 * The helpers locate a column's controls as
 * `page.getByRole('dialog', { name: `Filtrar ${label}` })`, which works only
 * because Mantine's `Popover.Dropdown` renders `role="dialog"` with
 * `aria-labelledby` pointing at the `Filtrar <label>` trigger. Both halves come
 * from defaults nothing in this repo sets: `Popover`'s `withRoles` (true) and
 * the trigger's `aria-label` in `FilterPopover`. Flipping either is invisible
 * here otherwise, and breaks every filter call site in the e2e suite at once.
 *
 * ⚠️ WHAT THIS FILE CANNOT PIN: the `withinPortal: false` opt-outs.
 * `MantineTestProvider` runs Mantine with `env="test"`, and `OptionalPortal`
 * short-circuits on the env BEFORE it reads `withinPortal`:
 *
 *     if (useMantineEnv() === 'test' || !withinPortal) return <>{children}</>;
 *
 * So under test NOTHING is ever portaled, and the containment assertions below
 * would still pass with every opt-out deleted. They pin the NAMES and the
 * structure, not the portal choice. That choice is guarded only by the note on
 * `FilterBody` and by the staging e2e lanes — and `MantineTestProvider` is
 * mandatory (#1150 forbids a bare `<MantineProvider>` in a component test), so
 * there is no portal-enabled env to test in.
 */
function open(descriptor: FilterableField) {
  render(
    <MantineTestProvider>
      <ColumnFilter descriptor={descriptor} value={undefined} onChange={() => {}} />
    </MantineTestProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: `Filtrar ${descriptor.label}` }));
  return screen.getByRole('dialog', { name: `Filtrar ${descriptor.label}` });
}

const stringField: FilterableField = { key: 'nome', kind: 'string', label: 'Nome' };
const enumField: FilterableField = {
  key: 'estado',
  kind: 'enum',
  label: 'Pagamento',
  enumValues: [
    { value: 'pago', label: 'Pago' },
    { value: 'cancelado', label: 'Cancelado' },
  ],
};

describe('ColumnFilter popover a11y contract', () => {
  it('exposes the trigger as `Filtrar <label>`', () => {
    render(
      <MantineTestProvider>
        <ColumnFilter descriptor={stringField} value={undefined} onChange={() => {}} />
      </MantineTestProvider>,
    );
    expect(screen.getByRole('button', { name: 'Filtrar Nome' })).toBeDefined();
  });

  it('opens a dialog whose accessible name is the trigger label', () => {
    // The e2e helpers' one and only scoping handle.
    expect(open(stringField)).toBeDefined();
  });

  it('keeps Aplicar, Limpar and the text input inside that dialog', () => {
    // Covers `applyTextFilter` and `clearColumnFilter`.
    const dialog = open(stringField);
    expect(dialog.contains(screen.getByRole('button', { name: 'Aplicar' }))).toBe(true);
    expect(dialog.contains(screen.getByRole('button', { name: 'Limpar' }))).toBe(true);
    expect(dialog.contains(screen.getByLabelText('Nome contém'))).toBe(true);
  });

  it('keeps an enum Select and its options inside that dialog', () => {
    // Covers `applySelectFilter`, which needs a strictly stronger property than
    // the text case: it locates BOTH the combobox and a `role="option"` node
    // through the dialog. The names it depends on are the column label and the
    // option label, so pin those.
    const dialog = open(enumField);
    const combobox = screen.getByRole('combobox', { name: 'Pagamento' });
    expect(dialog.contains(combobox)).toBe(true);
    fireEvent.click(combobox);
    expect(dialog.contains(screen.getByRole('option', { name: 'Pago' }))).toBe(true);
  });
});
