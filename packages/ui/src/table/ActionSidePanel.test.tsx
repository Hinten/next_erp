import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import type { SnapshotRow } from '@delfrance/data/hooks';

import { ActionSidePanel } from './ActionSidePanel';
import type { ActionConfig } from '../schema/types';

function wrap(node: React.ReactNode) {
  // `env="test"` disables Mantine transitions / portals so the confirm Modal
  // renders synchronously and is queryable.
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

type Row = { name: string };
const ROW: SnapshotRow<Row> = { id: '1', path: 'x/1', data: { name: 'a' } };

function makeAction(id: string, run = vi.fn()): ActionConfig<Row> {
  return { id, label: `Ação ${id}`, run };
}

describe('ActionSidePanel', () => {
  it('renders Novo, Copiar and one button per action', () => {
    wrap(
      <ActionSidePanel
        actions={[makeAction('1'), makeAction('2')]}
        selectedRows={[ROW]}
        newHref="/x/novo"
        copyHref={'/x/novo' as never}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    );
    expect(screen.getByRole('complementary', { name: 'Ações' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Novo' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Copiar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ação 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ação 2' })).toBeTruthy();
    expect(screen.getByText('1 selecionado(s)')).toBeTruthy();
  });

  it('disables actions that require selection when nothing is selected', () => {
    wrap(
      <ActionSidePanel
        actions={[{ ...makeAction('1'), requiresSelection: true }]}
        selectedRows={[]}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Ação 1' }) as HTMLButtonElement;
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('disables a maxSelection action past its cap and says why on hover', () => {
    const second: SnapshotRow<Row> = { id: '2', path: 'x/2', data: { name: 'b' } };
    const { rerender } = wrap(
      <ActionSidePanel
        actions={[{ ...makeAction('1'), requiresSelection: true, maxSelection: 1 }]}
        selectedRows={[ROW]}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    );
    const enabled = screen.getByRole('button', { name: 'Ação 1' }) as HTMLButtonElement;
    expect(enabled.hasAttribute('disabled')).toBe(false);

    rerender(
      <MantineTestProvider>
        <ActionSidePanel
          actions={[{ ...makeAction('1'), requiresSelection: true, maxSelection: 1 }]}
          selectedRows={[ROW, second]}
          collapsed={false}
          onToggleCollapsed={() => {}}
        />
      </MantineTestProvider>,
    );
    const capped = screen.getByRole('button', { name: 'Ação 1' }) as HTMLButtonElement;
    expect(capped.hasAttribute('disabled')).toBe(true);
    expect(capped.getAttribute('title')).toBe('Selecione apenas 1 registro');
  });

  it('routes a confirm action through the modal: Confirmar runs, Cancelar does not', () => {
    const run = vi.fn();
    wrap(
      <ActionSidePanel
        actions={[
          { ...makeAction('1', run), confirm: { title: 'Excluir?', message: 'Tem certeza?' } },
        ]}
        selectedRows={[ROW]}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ação 1' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText('Tem certeza?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ação 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([ROW]);
  });

  it('collapses to a slim rail with only the expand control', () => {
    const onToggle = vi.fn();
    wrap(
      <ActionSidePanel
        actions={[makeAction('1')]}
        selectedRows={[ROW]}
        collapsed
        onToggleCollapsed={onToggle}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Ação 1' })).toBeNull();
    const expand = screen.getByRole('button', { name: 'Expandir ações' });
    fireEvent.click(expand);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders `extra` below the buttons when expanded and on the collapsed rail', () => {
    const { rerender } = wrap(
      <ActionSidePanel
        actions={[makeAction('1')]}
        selectedRows={[ROW]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        extra={<span>progresso</span>}
      />,
    );
    expect(screen.getByText('progresso')).toBeTruthy();

    // Collapsing must not hide caller content — the caller decides what
    // survives (a badge, typically), so `extra` renders on the rail too.
    rerender(
      <MantineTestProvider>
        <ActionSidePanel
          actions={[makeAction('1')]}
          selectedRows={[ROW]}
          collapsed
          onToggleCollapsed={() => {}}
          extra={<span>progresso</span>}
        />
      </MantineTestProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Ação 1' })).toBeNull();
    expect(screen.getByText('progresso')).toBeTruthy();
  });

  it('widens the expanded rail to `width`', () => {
    wrap(
      <ActionSidePanel
        actions={[]}
        selectedRows={[]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        width={300}
      />,
    );
    const aside = screen.getByRole('complementary', { name: 'Ações' });
    // Mantine rewrites a numeric `w` to rem and scales it: 300 / 16 = 18.75rem.
    expect(getComputedStyle(aside).width).toContain('18.75rem');
  });

  it('the collapse chevron reports back via onToggleCollapsed', () => {
    const onToggle = vi.fn();
    wrap(
      <ActionSidePanel
        actions={[]}
        selectedRows={[]}
        collapsed={false}
        onToggleCollapsed={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recolher ações' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
