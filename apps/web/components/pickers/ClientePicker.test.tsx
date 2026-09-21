import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clienteSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ClientePicker } from './ClientePicker';
import { clientePhoneSearchShapes, describeClienteOption } from './clientePhoneSearch';

const mocks = vi.hoisted(() => ({
  pipelineSupported: true,
  primaryRows: [] as Array<{ id: string; data: unknown }>,
  phoneRows: [] as Array<{ id: string; data: unknown }>,
  query: vi.fn(),
  pipeline: vi.fn(),
  db: {},
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => mocks.db }));
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: false }) }));
vi.mock('./ClienteQuickCreateModal', () => ({ ClienteQuickCreateModal: () => null }));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));
vi.mock('@/lib/data/clienteCollection', () => ({
  clienteCollection: { ref: () => ({ collection: 'clientes' }), resolvePath: () => 'clientes' },
}));
vi.mock('firebase/firestore', async (load) => ({
  ...(await load<typeof import('firebase/firestore')>()),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  or: (...filters: unknown[]) => ({ or: filters }),
  limit: (value: number) => ({ limit: value }),
  query: (...args: unknown[]) => {
    mocks.query(...args);
    return { kind: 'phones' };
  },
}));
vi.mock('@delfrance/data', async (load) => ({
  ...(await load<typeof import('@delfrance/data')>()),
  isPipelineSupported: () => mocks.pipelineSupported,
  buildPipeline: (_db: unknown, spec: unknown) => {
    mocks.pipeline(spec);
    return spec;
  },
  buildQuery: () => ({ kind: 'fallback' }),
  orderByField: () => ({}),
  whereOp: () => ({}),
  limit: () => ({}),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined }),
  usePipelineSnapshot: () => ({ data: mocks.primaryRows }),
  useSnapshot: (query: { kind?: string } | null) => ({
    data: query?.kind === 'phones' ? mocks.phoneRows : mocks.primaryRows,
    loading: false,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pipelineSupported = true;
  mocks.primaryRows = [];
  mocks.phoneRows = [];
  localStorage.clear();
});
afterEach(cleanup);

describe('manual cliente phone search', () => {
  it('matches full national/formatted numbers while keeping ninth-digit and international identities distinct', () => {
    expect(clientePhoneSearchShapes('(11) 99999-8888')).toContain('5511999998888');
    expect(clientePhoneSearchShapes('+55 11 99999-8888')).toContain('5511999998888');
    expect(clientePhoneSearchShapes('(11) 9999-8888')).not.toContain('5511999998888');
    expect(clientePhoneSearchShapes('+1 415 555 2671')).toEqual(['14155552671']);
    expect(clientePhoneSearchShapes('14155552671')).toContain('5514155552671');
    expect(clientePhoneSearchShapes('99999')).toEqual([]);
    expect(clientePhoneSearchShapes('Maria 11999998888')).toEqual([]);
  });

  it('labels matching history without presenting it as the principal', () => {
    const data = clienteSchema.parse({
      nome: 'Maria',
      cpf_cnpj: '52998224725',
      telefone: '5511888887777',
      telefonesAdicionais: ['5511999998888'],
    });
    expect(describeClienteOption(data, '(11) 99999-8888')).toContain('Histórico inativo');
    expect(describeClienteOption(data, '(11) 99999-8888')).toContain(
      'Principal: +55 (11) 88888-7777',
    );
    expect(describeClienteOption(data, '(11) 9999-8888')).not.toContain('Histórico inativo');
    expect(describeClienteOption(data, 'Maria')).not.toContain('Histórico inativo');
  });

  it.each([true, false])(
    'finds an inactive phone beyond the initial list, deduplicates and requires selection (pipelines=%s)',
    async (pipelines) => {
      mocks.pipelineSupported = pipelines;
      const row = {
        id: 'old-contact',
        data: clienteSchema.parse({
          nome: 'Maria da Silva',
          cpf_cnpj: '52998224725',
          telefone: '5511888887777',
          telefonesAdicionais: ['5511999998888'],
        }),
      };
      const change = vi.fn();
      const view = render(
        <MantineTestProvider>
          <ClientePicker
            fieldName="phone-search-test"
            value={null}
            onChange={change}
            allowCreate={false}
          />
        </MantineTestProvider>,
      );
      const input = screen.getByRole('combobox', { name: 'Cliente' });
      fireEvent.click(input);
      expect(screen.queryByRole('option', { name: /Maria da Silva/ })).toBeNull();
      mocks.phoneRows = [row];
      fireEvent.change(input, { target: { value: '(11) 99999-8888' } });
      await waitFor(() =>
        expect(mocks.query).toHaveBeenCalledWith(
          { collection: 'clientes' },
          {
            or: [
              { field: 'telefone', op: 'in', value: ['11999998888', '5511999998888'] },
              {
                field: 'telefonesAdicionais',
                op: 'array-contains-any',
                value: ['11999998888', '5511999998888'],
              },
            ],
          },
          { limit: 15 },
        ),
      );
      expect(screen.getAllByRole('option', { name: /Maria da Silva/ })).toHaveLength(1);
      mocks.primaryRows = [row];
      view.rerender(
        <MantineTestProvider>
          <ClientePicker
            fieldName="phone-search-test"
            value={null}
            onChange={change}
            allowCreate={false}
          />
        </MantineTestProvider>,
      );
      expect(screen.getAllByRole('option', { name: /Maria da Silva/ })).toHaveLength(1);
      expect(screen.getByText(/Histórico inativo/)).toBeTruthy();
      expect(screen.getByText(/52998224725/)).toBeTruthy();
      expect(change).not.toHaveBeenCalled();
      if (pipelines) {
        expect(mocks.pipeline).toHaveBeenLastCalledWith(
          expect.objectContaining({
            search: {
              fields: ['nome', 'cpf_cnpj', 'idEstrangeiro', 'email', 'telefone'],
              term: '(11) 99999-8888',
            },
          }),
        );
      }
      fireEvent.click(screen.getByRole('option', { name: /Maria da Silva/ }));
      expect(change).toHaveBeenCalledWith(
        'documents/clientes/old-contact',
        expect.objectContaining({ label: 'Maria da Silva' }),
      );
      view.unmount();
    },
  );

  it('does not query historical numbers for a name or partial phone', async () => {
    render(
      <MantineTestProvider>
        <ClientePicker
          fieldName="name-search-test"
          value={null}
          onChange={() => {}}
          allowCreate={false}
        />
      </MantineTestProvider>,
    );
    const input = screen.getByRole('combobox', { name: 'Cliente' });
    fireEvent.change(input, { target: { value: 'Maria' } });
    await waitFor(() =>
      expect(mocks.pipeline).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ term: 'Maria' }),
        }),
      ),
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
