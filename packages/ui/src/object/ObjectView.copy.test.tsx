import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';
import { MantineTestProvider } from '../testing/mantine';
import { ObjectView } from './ObjectView';

const { source, save } = vi.hoisted(() => ({
  source: {
    nome: 'Cliente',
    telefone: '14155552671',
    identity: 'original',
    history: ['5511999998888'],
  },
  save: vi.fn(async (input: { values: unknown }) => ({ id: 'new', patch: input.values })),
}));
vi.mock('@delfrance/data/hooks', async (load) => ({
  ...(await load<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: unknown) => ({
    data: ref ? { id: 'source', data: source } : null,
    loading: false,
    error: undefined,
    fromCache: false,
  }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('copyFrom=source'),
}));
vi.mock('./saveRecord', async (load) => ({
  ...(await load<typeof import('./saveRecord')>()),
  saveRecord: save,
}));
afterEach(cleanup);

it('prepares a copied form seed before field validation and persistence without mutating the source', async () => {
  const schema = z.object({
    nome: z.string().default('').describe('Nome'),
    telefone: z.string().default('').describe('Telefone'),
    identity: z.string().nullable().default(null),
    history: z.array(z.string()).default([]),
  });
  const collection: CollectionHandle<typeof schema> = {
    resolvePath: () => 'clientes',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
    merge: async () => undefined,
  };
  const prepare = vi.fn((value: unknown) =>
    typeof value === 'string' ? value.replace('+', '') : value,
  );
  const transform = vi.fn((copy: Readonly<Record<string, unknown>>) => ({
    ...copy,
    telefone: `+${String(copy.telefone)}`,
    identity: null,
    history: [],
  }));
  render(
    <MantineTestProvider>
      <ObjectView
        schema={schema}
        collection={collection}
        db={{} as never}
        currentUserUid="operator"
        transformCopiedValues={transform}
        fields={{ telefone: { prepareForSave: prepare } }}
        excludedFields={['identity', 'history']}
        showSaveAndContinue={false}
      />
    </MantineTestProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Telefone')).toHaveProperty('value', '+14155552671'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(prepare).toHaveBeenCalledWith('+14155552671');
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      values: expect.objectContaining({ telefone: '14155552671', identity: null, history: [] }),
    }),
  );
  expect(source).toEqual({
    nome: 'Cliente',
    telefone: '14155552671',
    identity: 'original',
    history: ['5511999998888'],
  });
});
