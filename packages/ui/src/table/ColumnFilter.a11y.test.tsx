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
 * the trigger's `aria-label` in `FilterPopover`.
 *
 * ⚠️ Without this test, flipping either one is invisible here and breaks every
 * filter call site in the e2e suite at once — and only a full staging lane
 * would say so. The scoping exists so a screen can grow a second filter surface
 * (a panel listing the same column names) without the page-scoped
 * "Aplicar" / "Limpar" / `<label> contém` locators resolving to two nodes and
 * failing Playwright strict mode.
 *
 * Sibling rule, one layer down: `ActiveFilters.tsx` — "Nothing here may render
 * a bare column label."
 */
const descriptor: FilterableField = { key: 'nome', kind: 'string', label: 'Nome' };

function openPopover() {
  render(
    <MantineTestProvider>
      <ColumnFilter descriptor={descriptor} value={undefined} onChange={() => {}} />
    </MantineTestProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Filtrar Nome' }));
}

describe('ColumnFilter popover a11y contract', () => {
  it('exposes the trigger as `Filtrar <label>`', () => {
    render(
      <MantineTestProvider>
        <ColumnFilter descriptor={descriptor} value={undefined} onChange={() => {}} />
      </MantineTestProvider>,
    );
    expect(screen.getByRole('button', { name: 'Filtrar Nome' })).toBeDefined();
  });

  it('opens a dialog whose accessible name is the trigger label', () => {
    openPopover();
    // The e2e helpers' one and only scoping handle.
    expect(screen.getByRole('dialog', { name: 'Filtrar Nome' })).toBeDefined();
  });

  it('keeps Aplicar, Limpar and the input INSIDE that dialog', () => {
    openPopover();
    const dialog = screen.getByRole('dialog', { name: 'Filtrar Nome' });
    // `within`-free: assert containment directly, so a control rendered in a
    // portal outside the dialog fails here rather than in a staging lane.
    const aplicar = screen.getByRole('button', { name: 'Aplicar' });
    const limpar = screen.getByRole('button', { name: 'Limpar' });
    const input = screen.getByLabelText('Nome contém');
    expect(dialog.contains(aplicar)).toBe(true);
    expect(dialog.contains(limpar)).toBe(true);
    expect(dialog.contains(input)).toBe(true);
  });
});
