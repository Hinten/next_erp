import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

// Stub the snapshot hooks + the query helpers so the table renders a static
// dataset without hitting Firestore's internals. We control the response on a
// per-test basis via the hoisted `snapState`.
const { snapState } = vi.hoisted(() => ({
  snapState: {
    current: {
      data: [
        { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    } as SnapshotState<SnapshotRow<{ nome?: string; tipo?: string }>[]>,
  },
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshot: () => snapState.current };
});
vi.mock('@delfrance/data/hooks/usePipelineSnapshot', () => ({
  usePipelineSnapshot: () => snapState.current,
}));
vi.mock('@delfrance/data/pipeline-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/data/pipeline-queries')>();
  return {
    ...actual,
    isPipelineSupported: (_db: unknown) => false,
    buildPipeline: () => null,
  };
});
vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    // Bypass real query construction — the TableView calls these but the
    // returned object only matters as a stable identity for useSnapshot deps.
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
    whereOp: () => ({ __c: 'where' }),
  };
});

import { TableView } from './TableView';

const testSchema = z.object({
  nome: z.string(),
  tipo: z.enum(['0', '1']).describe('Tipo'),
  observacoes: z.string().nullable().optional(),
});

function fakeCollection(): CollectionHandle<typeof testSchema> {
  return {
    resolvePath: () => 'tests',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
  };
}

function wrap(node: React.ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>);
}

describe('TableView', () => {
  it('renders one header per non-unknown field by default', () => {
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Nome', 'Tipo', 'Observacoes']));
  });

  it('limits columns to defaultColumns when provided', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        defaultColumns={['nome']}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toContain('Nome');
    expect(headers).not.toContain('Tipo');
  });

  it('renders one row per snapshot entry, plus a click-link on the first cell', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
      />,
    );
    const aliceLink = screen.getByRole('link', { name: 'Alice' });
    expect(aliceLink.getAttribute('href')).toBe('/tests/1');
  });

  it('shows an empty state when no rows', () => {
    snapState.current = { data: [], loading: false, error: undefined };
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    expect(screen.getByText(/Nenhum resultado/)).toBeTruthy();
    // Reset for sibling tests.
    snapState.current = {
      data: [
        { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    };
  });

  it('selectable adds a checkbox column and enables bulk actions on selection', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { container } = wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        selectable
        actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run }]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    expect(button.hasAttribute('disabled')).toBe(true);
    const rowCheckbox = within(container).getByRole('checkbox', { name: 'Selecionar 1' });
    fireEvent.click(rowCheckbox);
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(run).toHaveBeenCalled();
  });
});
