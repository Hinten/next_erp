import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';
import { INTEGRACAO_FRETE, MODALIDADE_FRETE, seedFreteInicial } from '@delfrance/schemas';
import type { FreteInicialFormState } from './types';

const h = vi.hoisted(() => ({
  available: true,
  permission: { allowed: true, loading: false },
  rastrear: vi.fn(),
  show: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/mercado-livre/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/mercado-livre/client')>()),
  useMercadoLivreClient: () => (h.available ? { rastrear: h.rastrear } : null),
}));
vi.mock('@/lib/auth/usePermission', () => ({ usePermission: () => h.permission }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.show } }));
vi.mock('@/lib/notifications/showErrorNotification', () => ({ showErrorNotification: h.error }));

import { MercadoLivreRastrearAction } from './MercadoLivreRastrearAction';
import { EtiquetaAcaoHost, useEtiquetaAcao } from './EtiquetaAcaoHost';
import { MarketplaceReadOnly } from './tabs/frete/MarketplaceReadOnly';

const url = 'https://carrier.example/track?pedido=01';
const tab = () => ({
  opener: {} as unknown,
  closed: false,
  location: { replace: vi.fn() },
  close: vi.fn(),
});
const mount = (
  props: { pedidoId?: string; shipmentId?: string | null } = { pedidoId: 'p1', shipmentId: '555' },
) =>
  render(
    <MantineTestProvider>
      <MercadoLivreRastrearAction {...props} />
    </MantineTestProvider>,
  );
const button = () => screen.getByRole('button', { name: 'Rastrear' });

beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
  h.permission.allowed = true;
  h.permission.loading = false;
  h.rastrear.mockResolvedValue({ name: 'Carrier', url });
});
afterEach(() => vi.restoreAllMocks());

describe('Mercado Livre tracking action', () => {
  it('opens the detached tab synchronously and fetches only on click', async () => {
    const aba = tab();
    const open = vi.spyOn(window, 'open').mockReturnValue(aba as unknown as Window);
    h.rastrear.mockImplementation(async () => {
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(aba.opener).toBeNull();
      return { name: 'Carrier', url };
    });
    mount();
    expect(h.rastrear).not.toHaveBeenCalled();
    fireEvent.click(button());
    await waitFor(() => expect(aba.location.replace).toHaveBeenCalledWith(url));
    expect(h.rastrear).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it.each([
    { pedidoId: undefined, shipmentId: '555' },
    { pedidoId: 'p1', shipmentId: null },
    { pedidoId: 'p1', shipmentId: '' },
  ])('disables incomplete tracking inputs: %j', (props) => {
    mount(props);
    expect(button().hasAttribute('disabled')).toBe(true);
    fireEvent.click(button());
    expect(h.rastrear).not.toHaveBeenCalled();
  });

  it.each(['permission', 'loading', 'client'])('disables when %s is unavailable', (reason) => {
    if (reason === 'permission') h.permission.allowed = false;
    if (reason === 'loading') h.permission.loading = true;
    if (reason === 'client') h.available = false;
    mount();
    expect(button().hasAttribute('disabled')).toBe(true);
  });

  it('stays enabled in the read-only freight panel with no tracking code or label', async () => {
    vi.spyOn(window, 'open').mockReturnValue(tab() as unknown as Window);
    const frete = {
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
      externalId: '555',
      codRastreio: null,
      printLabelId: null,
    } as unknown as FreteInicialFormState;
    render(
      <MantineTestProvider>
        <MarketplaceReadOnly frete={frete} tipo={INTEGRACAO_FRETE.mercadoLivre} pedidoId="p1" />
      </MantineTestProvider>,
    );
    expect(screen.getByLabelText('Código de rastreio').hasAttribute('disabled')).toBe(true);
    expect(button().hasAttribute('disabled')).toBe(false);
    fireEvent.click(button());
    await waitFor(() => expect(h.rastrear).toHaveBeenCalledWith('p1'));
  });

  it('does not offer ML tracking on another marketplace', () => {
    const frete = {
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
    } as unknown as FreteInicialFormState;
    render(
      <MantineTestProvider>
        <MarketplaceReadOnly frete={frete} tipo={INTEGRACAO_FRETE.shopee} pedidoId="p1" />
      </MantineTestProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Rastrear' })).toBeNull();
  });

  it.each(['blocked', 'closed'])(
    'offers a persistent external link if the tab is %s',
    async (reason) => {
      const aba = tab();
      if (reason === 'closed') aba.closed = true;
      vi.spyOn(window, 'open').mockReturnValue(
        reason === 'blocked' ? null : (aba as unknown as Window),
      );
      mount();
      fireEvent.click(button());
      await waitFor(() => expect(h.show).toHaveBeenCalled());
      const notification = h.show.mock.calls[0]![0] as { autoClose: boolean; message: ReactNode };
      expect(notification.autoClose).toBe(false);
      render(<MantineTestProvider>{notification.message}</MantineTestProvider>);
      const link = screen.getByRole('link', { name: 'Rastrear com Carrier' });
      expect(link.getAttribute('href')).toBe(url);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(aba.location.replace).not.toHaveBeenCalled();
    },
  );

  it('closes the blank tab and displays unavailable tracking as information', async () => {
    const aba = tab();
    vi.spyOn(window, 'open').mockReturnValue(aba as unknown as Window);
    h.rastrear.mockRejectedValue(
      new MercadoLivreClientHttpError('unavailable', 409, 'ML_RASTREIO_INDISPONIVEL'),
    );
    mount();
    fireEvent.click(button());
    await waitFor(() =>
      expect(h.show).toHaveBeenCalledWith({
        color: 'blue',
        message: 'Rastreamento ainda indisponível.',
      }),
    );
    expect(aba.close).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    expect(button().hasAttribute('disabled')).toBe(false);
  });

  it.each([
    new MercadoLivreClientNetworkError('offline'),
    new MercadoLivreClientHttpError('reconnect', 409, 'ML_REAUTH_REQUIRED'),
    new MercadoLivreClientHttpError('forbidden', 403, null),
  ])('surfaces known errors and closes the blank tab: %s', async (error) => {
    const aba = tab();
    vi.spyOn(window, 'open').mockReturnValue(aba as unknown as Window);
    h.rastrear.mockRejectedValue(error);
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(aba.close).toHaveBeenCalledOnce();
  });

  it('prevents double clicks and completes after the freight popover unmounts', async () => {
    let resolve!: (result: { name: string; url: string }) => void;
    h.rastrear.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const aba = tab();
    vi.spyOn(window, 'open').mockReturnValue(aba as unknown as Window);
    function Action() {
      const host = useEtiquetaAcao();
      return (
        <MercadoLivreRastrearAction pedidoId="p1" shipmentId="555" acoes={host ?? undefined} />
      );
    }
    function Page() {
      const [show, setShow] = useState(true);
      return (
        <EtiquetaAcaoHost>
          <button onClick={() => setShow(!show)}>toggle popover</button>
          {show && <Action />}
        </EtiquetaAcaoHost>
      );
    }
    render(
      <MantineTestProvider>
        <Page />
      </MantineTestProvider>,
    );
    fireEvent.click(button());
    fireEvent.click(button());
    expect(h.rastrear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('toggle popover'));
    fireEvent.click(screen.getByText('toggle popover'));
    expect(button().hasAttribute('disabled')).toBe(true);
    fireEvent.click(button());
    expect(h.rastrear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('toggle popover'));
    await act(async () => resolve({ name: 'Carrier', url }));
    expect(aba.location.replace).toHaveBeenCalledWith(url);
    fireEvent.click(screen.getByText('toggle popover'));
    expect(button().hasAttribute('disabled')).toBe(false);
  });
});
