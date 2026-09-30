import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

const { permissionState, notificationShow } = vi.hoisted(() => ({
  permissionState: { allowed: true, loading: false },
  notificationShow: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ usePermission: () => permissionState }));
vi.mock('@/lib/data/newDocId', () => ({ newDocId: () => 'copy' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notificationShow } }));

import { usePedidoEnderecoCopyPreparation } from './usePedidoEnderecoCopyPreparation';

const origem = 'documents/clientes/antigo/enderecos/e1';
const values = {
  clientePedidoOuterRef: 'documents/clientes/novo',
  enderecoFiscalOuterRef: origem,
  freteInicial: { enderecoFreteOuterReference: origem },
} as unknown as Pedido;

function Harness() {
  const { prepareSubmit, element } = usePedidoEnderecoCopyPreparation();
  const [result, setResult] = useState('pending');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void prepareSubmit(values).then((prepared) => {
            setResult(prepared === false ? 'cancelled' : JSON.stringify(prepared));
          });
        }}
      >
        Preparar
      </button>
      <output>{result}</output>
      {element}
    </>
  );
}

beforeEach(() => {
  permissionState.allowed = true;
  permissionState.loading = false;
  notificationShow.mockReset();
});

describe('usePedidoEnderecoCopyPreparation', () => {
  it('shows one explanatory dialog with the requested actions and cancels without a plan', async () => {
    render(
      <MantineTestProvider>
        <Harness />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preparar' }));

    expect(await screen.findByText('Copiar endereço para o cliente selecionado?')).toBeTruthy();
    expect(screen.getByText(/endereços fiscal e de entrega/i)).toBeTruthy();
    expect(screen.getByText(/endereço original será mantido/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar e salvar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));
    await waitFor(() => expect(screen.getByText('cancelled')).toBeTruthy());
  });

  it('confirms one deduplicated stable copy plan', async () => {
    render(
      <MantineTestProvider>
        <Harness />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preparar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar e salvar' }));

    await waitFor(() => expect(screen.getByText(/clientes\/novo\/enderecos\/copy/)).toBeTruthy());
    expect(screen.getByText(/"usos":\["fiscal","entrega"\]/)).toBeTruthy();
  });

  it('blocks before opening the dialog without address read/write permission', async () => {
    permissionState.allowed = false;
    render(
      <MantineTestProvider>
        <Harness />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preparar' }));

    await waitFor(() => expect(screen.getByText('cancelled')).toBeTruthy());
    expect(screen.queryByText('Copiar endereço para o cliente selecionado?')).toBeNull();
    expect(notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sem permissão para copiar endereço', color: 'red' }),
    );
  });
});
