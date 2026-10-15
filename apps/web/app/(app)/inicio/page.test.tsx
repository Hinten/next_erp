import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
const mocks = vi.hoisted(() => ({
  auth: { user: { uid: 'u' } as { uid: string } | null, loading: false },
  permission: { allowed: true, loading: false },
}));
vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/auth/usePermission', () => ({ usePermission: () => mocks.permission }));
vi.mock('@/lib/avisos/useAvisos', () => ({
  useAvisos: () => ({
    rows: [],
    naoLidos: 0,
    loading: false,
    marcarComoLido: vi.fn(),
    marcarTodosLidos: vi.fn(),
  }),
}));
vi.mock('../_components/AvisosPanel', () => ({ AvisosPanel: () => <div>Avisos preservados</div> }));
vi.mock('./_components/InicioDashboard', () => ({
  InicioDashboard: ({ uid }: { uid: string }) => <div data-testid="dashboard">{uid}</div>,
}));
import InicioPage from './page';
beforeEach(() => {
  mocks.auth = { user: { uid: 'u' }, loading: false };
  mocks.permission = { allowed: true, loading: false };
});
describe('home permission gating', () => {
  it.each(['auth', 'permission', 'denied', 'signed-out'])(
    'preserves Avisos and avoids mounting dashboard reads while %s',
    (state) => {
      if (state === 'auth') mocks.auth.loading = true;
      if (state === 'permission') mocks.permission.loading = true;
      if (state === 'denied') mocks.permission.allowed = false;
      if (state === 'signed-out') mocks.auth.user = null;
      render(
        <MantineTestProvider>
          <InicioPage />
        </MantineTestProvider>,
      );
      expect(screen.queryByTestId('dashboard')).toBeNull();
      expect(screen.getByText('Avisos preservados')).toBeTruthy();
    },
  );
  it('mounts the dashboard with the authenticated UID once both gates resolve', () => {
    render(
      <MantineTestProvider>
        <InicioPage />
      </MantineTestProvider>,
    );
    expect(screen.getByTestId('dashboard').textContent).toBe('u');
  });
});
