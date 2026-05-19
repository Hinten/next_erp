import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

// Default to "no existing doc" — individual tests can override.
const docState: { current: { data: undefined | null | { id: string; data: unknown }; loading: boolean; error: undefined } } = {
  current: { data: null, loading: false, error: undefined },
};
vi.mock('@delfrance/data/hooks', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: () => docState.current,
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { ObjectView } from './ObjectView';

const schema = z.object({
  nome: z.string().nullable().optional().describe('Nome'),
  tipo: z.enum(['0', '1']).nullable().optional().describe('Tipo'),
  obs: z.string().nullable().optional().describe('{"label":"Observações","kind":"longText","section":"Notas"}'),
});

function fakeCollection(): CollectionHandle<typeof schema> {
  return {
    resolvePath: () => 'clientes',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
  };
}

function Wrap({ children }: { children: React.ReactNode }) {
  // `env="test"` disables Mantine transitions/portals so overlays (Modal)
  // render synchronously and are queryable.
  return (
    <MantineProvider env="test">
      <Notifications />
      {children}
    </MantineProvider>
  );
}

describe('ObjectView', () => {
  it('renders one input per non-excluded field', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
        />
      </Wrap>,
    );
    expect(screen.getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Observações' })).toBeTruthy();
  });

  it('hides excluded fields', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          excludedFields={['obs']}
        />
      </Wrap>,
    );
    expect(screen.queryByRole('textbox', { name: 'Observações' })).toBeNull();
  });

  it('renders nested object fields inside a fieldset', () => {
    const nestedSchema = z.object({
      nome: z.string().describe('Nome'),
      endereco: z
        .object({
          rua: z.string().describe('Rua'),
          cidade: z.string().describe('Cidade'),
        })
        .describe('Endereço'),
    });
    render(
      <Wrap>
        <ObjectView
          schema={nestedSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
        />
      </Wrap>,
    );
    // Leaf inputs of the nested object are bound and labelled.
    expect(screen.getByRole('textbox', { name: 'Rua' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Cidade' })).toBeTruthy();
    // The fieldset legend carries the object field's label.
    expect(screen.getByText('Endereço')).toBeTruthy();
  });

  it('renders Mantine tabs when `sections` is set', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          sections={['Geral', 'Notas']}
        />
      </Wrap>,
    );
    expect(screen.getByRole('tab', { name: 'Geral' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Notas' })).toBeTruthy();
  });

  it('renders the pager when `pager` is provided', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          pager={{ ids: ['a', 'b', 'c'], current: 'b', onChange: () => {} }}
        />
      </Wrap>,
    );
    expect(screen.getByText('2 / 3')).toBeTruthy();
  });

  it('delete modal requires typing "excluir" before it calls onDelete', () => {
    docState.current = { data: { id: 'rec-1', data: {} }, loading: false, error: undefined };
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="rec-1"
          onDelete={onDelete}
        />
      </Wrap>,
    );

    // Open the modal via the row-action delete button.
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    // Scope queries to the modal dialog so the row's own "Excluir" button
    // doesn't get matched.
    const dialog = screen.getByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: 'Excluir',
    }) as HTMLButtonElement;
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Digite "excluir"/), {
      target: { value: 'excluir' },
    });
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(confirmBtn);
    expect(onDelete).toHaveBeenCalledWith('rec-1');

    docState.current = { data: null, loading: false, error: undefined };
  });
});
