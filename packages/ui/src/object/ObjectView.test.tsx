import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  return (
    <MantineProvider>
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
});
