import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { NFeCertificateError } from '@delfrance/integrations-nfe/http-provider';

import { MantineTestProvider } from '@/lib/testing/mantine';

// The panel reaches Firestore through the collection handle and the client
// singleton; this suite is about the REMOVAL flow (#1680), so both are stubbed
// and `getDoc` only has to hand back a filial that has a certificate.
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/filialCollection', () => ({ filialCollection: { docRef: () => ({}) } }));
const { getDoc, deleteCertificado, showErrorNotification, notificationsShow } = vi.hoisted(() => ({
  getDoc: vi.fn(),
  deleteCertificado: vi.fn(),
  showErrorNotification: vi.fn(),
  notificationsShow: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ getDoc }));
vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: () => ({ deleteCertificado, uploadCertificado: vi.fn() }),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification,
  showCopyableNotification: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notificationsShow } }));

import { CertificadoPanel } from './CertificadoPanel';

const CERTIFICADO = {
  subjectCommonName: 'ACME LTDA:99999999000191',
  cnpj: '99999999000191',
  notAfter: Date.now() + 200 * 86_400_000,
  filename: 'acme.pfx',
  uploadedAt: Date.now(),
};

function renderPanel() {
  getDoc.mockResolvedValue({ exists: () => true, data: () => ({ certificado: CERTIFICADO }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineTestProvider>
        <CertificadoPanel filialId="F-1" />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CertificadoPanel — removal asks first (#1680)', () => {
  it('"Cancelar" removes nothing', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remover' }));

    // The confirmation says what removal costs before anything happens —
    // including that running instances keep the cert until they restart.
    const aviso = await screen.findByText(/bloqueadas até um novo envio/);
    expect(aviso.textContent).toMatch(/até reiniciarem/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByText(/bloqueadas até um novo envio/)).toBeNull());
    expect(deleteCertificado).not.toHaveBeenCalled();
  });

  it('confirming removes the certificate of THIS filial, once', async () => {
    deleteCertificado.mockResolvedValue(undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remover' }));
    await screen.findByText(/bloqueadas até um novo envio/);

    // Two "Remover" buttons exist now (the card's and the dialog's): click the
    // dialog's.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(deleteCertificado).toHaveBeenCalledTimes(1));
    expect(deleteCertificado).toHaveBeenCalledWith('F-1');
    await waitFor(() =>
      expect(notificationsShow).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green', message: 'Certificado removido.' }),
      ),
    );
  });

  it('a refused removal shows the error with the server message', async () => {
    deleteCertificado.mockRejectedValue(
      new NFeCertificateError("Filial 'F-1' não encontrada.", 404, null, undefined),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remover' }));
    await screen.findByText(/bloqueadas até um novo envio/);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remover' }));

    await waitFor(() =>
      expect(showErrorNotification).toHaveBeenCalledWith({
        title: 'Falha ao remover o certificado',
        message: "Filial 'F-1' não encontrada.",
      }),
    );
  });
});
