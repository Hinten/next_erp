import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Cliente } from '@delfrance/schemas';
import { WhatsappClientHttpError } from '@/lib/whatsapp/client';
import { ClienteQuickCreateForm } from './ClienteQuickCreateModal';

const { save, duplicates } = vi.hoisted(() => ({ save: vi.fn(), duplicates: vi.fn() }));
vi.mock('@delfrance/ui', async (load) => ({
  ...(await load<typeof import('@delfrance/ui')>()),
  saveRecord: (...args: unknown[]) => save(...args),
}));
vi.mock('@/lib/clientes/dedup', () => ({
  checkClienteDuplicates: (...args: unknown[]) => duplicates(...args),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'operator' } }),
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('@/lib/nfe/client', () => ({ useNFeClient: () => null }));
vi.mock('@/lib/clientes/useDefaultFilialId', () => ({ useDefaultFilialId: () => undefined }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(onCreate: (cliente: Cliente) => Promise<{ id: string }>) {
  duplicates.mockResolvedValue({
    blocking: [],
    similarNome: [],
    telefoneMatches: [],
    emailMatches: [],
  });
  const resolved = vi.fn();
  render(
    <MantineTestProvider>
      <ClienteQuickCreateForm
        initialValues={{ nome: 'Maria', telefone: '14155552671' }}
        onCreate={onCreate}
        onResolved={resolved}
        onCancel={() => undefined}
      />
    </MantineTestProvider>,
  );
  return resolved;
}

describe('atomic cliente quick create', () => {
  it('submits one normalized cliente to the backend seam without a local pre-create', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'canonical-cliente' });
    const resolved = show(create);
    expect(screen.getByLabelText('Telefone principal')).toHaveProperty('value', '+14155552671');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar telefone' }));
    fireEvent.change(screen.getByLabelText('Telefone adicional 1'), {
      target: { value: '11999998888' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        nome: 'Maria',
        telefone: '14155552671',
        telefonesAdicionais: ['5511999998888'],
      }),
    );
    expect(save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(resolved).toHaveBeenCalledWith({
        id: 'canonical-cliente',
        nome: 'Maria',
        endereco: null,
      }),
    );
  });
  it('retains the typed principal and extra when the atomic backend rejects a competing decision', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new WhatsappClientHttpError('Outro operador vinculou este contato.', 409, 'WA_CONFLICT'),
      );
    const resolved = show(create);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar telefone' }));
    fireEvent.change(screen.getByLabelText('Telefone adicional 1'), {
      target: { value: '21999998888' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await screen.findByText('Outro operador vinculou este contato.');
    expect(screen.getByLabelText('Telefone adicional 1')).toHaveProperty('value', '21999998888');
    expect(screen.getByLabelText('Telefone principal')).toHaveProperty('value', '+14155552671');
    expect(save).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
  });
});
