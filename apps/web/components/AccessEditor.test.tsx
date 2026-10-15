import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cargoSchema, SUPERUSER_MASK } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { AdminClientHttpError } from '@/lib/admin/users';
const m = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  token: vi.fn().mockResolvedValue('token'),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'actor', getIdToken: m.token } }),
  useTenant: () => ({ claims: { permissions: SUPERUSER_MASK.toString() } }),
  useIsSuperUser: () => true,
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/admin/access', () => ({
  readCargo: m.read,
  saveCargo: m.save,
  readUsuario: vi.fn(),
  saveUsuario: vi.fn(),
}));
vi.mock('@/app/(app)/configuracoes/_components/PermissionEditor', () => ({
  PermissionEditor: () => null,
}));
vi.mock('@/app/(app)/configuracoes/usuarios/_components/UsuarioForm', () => ({
  UsuarioForm: () => null,
}));
vi.mock('./AccessOperationPanel', () => ({
  useAccessOperationMemory: () => ({ operationId: 'op', remember: vi.fn() }),
  AccessOperationPanel: ({ onFinished }: { onFinished: (success: boolean) => void }) => (
    <button onClick={() => onFinished(false)}>Simular rejeição</button>
  ),
}));
import { AccessEditor } from './AccessEditor';
beforeEach(() => {
  vi.clearAllMocks();
  m.read.mockResolvedValue({
    value: cargoSchema.parse({ nome: 'Original', descricao: null, permissoes: '1' }),
    version: '1:0',
  });
});
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineTestProvider>
        <AccessEditor id="role" cargo />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}
it('preserves the entered form on an HTTP version conflict', async () => {
  m.save.mockRejectedValue(
    new AdminClientHttpError('Versão desatualizada', 409, 'VERSION_CONFLICT'),
  );
  mount();
  const input = await screen.findByRole('textbox', { name: 'Nome' });
  fireEvent.change(input, { target: { value: 'Meu rascunho' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
  expect(await screen.findByText('Versão desatualizada')).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe('Meu rascunho');
  expect(m.read).toHaveBeenCalledTimes(1);
});
it('retains form values after asynchronous rejection', async () => {
  m.save.mockResolvedValue({ operationId: 'op', targetId: 'role' });
  mount();
  const input = await screen.findByRole('textbox', { name: 'Nome' });
  fireEvent.change(input, { target: { value: 'Meu rascunho' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Simular rejeição' }));
  expect((input as HTMLInputElement).value).toBe('Meu rascunho');
  expect((input as HTMLInputElement).disabled).toBe(false);
  expect(m.read).toHaveBeenCalledTimes(1);
});
