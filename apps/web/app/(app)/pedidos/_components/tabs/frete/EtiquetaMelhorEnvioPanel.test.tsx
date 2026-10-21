import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import type { Pedido, RespostaConferenciaPagamentoLi } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import type { PedidoFormState } from '../../types';

const { clientes } = vi.hoisted(() => ({
  clientes: { freight: null as unknown, li: null as unknown },
}));

vi.mock('@/lib/freight/client', () => ({ useFreightClient: () => clientes.freight }));
// Partial: the soft gate narrows on the client's REAL error classes.
vi.mock('@/lib/loja-integrada/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/loja-integrada/client')>()),
  useLojaIntegradaClient: () => clientes.li,
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
}));

import { EtiquetaMelhorEnvioPanel } from './EtiquetaMelhorEnvioPanel';

/**
 * The pedido form's Frete tab reprints a bought Melhor Envio label too — the
 * FOURTH reprint path besides the `/pedidos` row and the checkout's two, and
 * the one an imported Loja Integrada order reaches from `/pedidos/<id>` while
 * its estado locks every field. A2 checks EVERY Melhor Envio reprint, so this
 * one runs the same soft gate before it opens the label.
 */

const ID_LI = createHash('sha256').update('lojaIntegradaCONTA1-165').digest('hex');
const IDENTIDADE_LI = { numero: '165', integracaoPedidoOuterRef: 'documents/integracao/CONTA1' };

function respostaLi(veredito: 'pago' | 'nao-pago'): RespostaConferenciaPagamentoLi {
  return {
    aplicavel: true,
    fonte: 'loja',
    veredito,
    codigo: veredito === 'pago' ? 'pedido_pago' : 'pagamento_em_disputa',
    motivoContestacao: veredito === 'pago' ? null : 'disputa',
    conferidoEmMs: 0,
    correlationId: null,
  };
}

function Painel({
  pedidoId,
  identidade,
}: {
  pedidoId: string;
  identidade: { numero: string | null; integracaoPedidoOuterRef: unknown };
}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      ...identidade,
      ehSaida: true,
      freteInicial: { printLabelId: 'lbl-1' },
    } as unknown as PedidoFormState,
  });
  return <EtiquetaMelhorEnvioPanel form={form} intFreteId="if-me" pedidoId={pedidoId} />;
}

function montar(pedidoId = ID_LI, identidade = IDENTIDADE_LI) {
  return render(
    <MantineTestProvider>
      <Painel pedidoId={pedidoId} identidade={identidade} />
    </MantineTestProvider>,
  );
}

function cenario(veredito: 'pago' | 'nao-pago') {
  const conferirPagamento = vi.fn(async () => respostaLi(veredito));
  clientes.li = lojaIntegradaClientFalso({ conferirPagamento });
  const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
  const rastrear = vi.fn(async () => ({ tracking: {} }));
  clientes.freight = { imprimir, rastrear };
  const abrir = vi.spyOn(window, 'open').mockReturnValue(null);
  return { conferirPagamento, imprimir, rastrear, abrir };
}

const TITULO = 'Pedido 165 — Pagamento não confirmado na Loja Integrada';

beforeEach(() => {
  clientes.freight = null;
  clientes.li = null;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('EtiquetaMelhorEnvioPanel — the paid re-check before a reprint', () => {
  it('⭐ `nao-pago`: Continuar stays off until "Estou ciente do risco", then the label opens', async () => {
    const s = cenario('nao-pago');
    montar();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));
    expect(await screen.findByText(TITULO)).toBeTruthy();
    const continuar = screen.getByRole<HTMLButtonElement>('button', { name: 'Continuar' });
    expect(continuar.disabled).toBe(true);
    expect(s.imprimir).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Estou ciente do risco' }));
    expect(continuar.disabled).toBe(false);
    fireEvent.click(continuar);

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledWith('if-me', 'lbl-1'));
    expect(s.abrir).toHaveBeenCalledWith('https://me/label.pdf', '_blank', 'noopener,noreferrer');
    expect(s.conferirPagamento).toHaveBeenCalledWith(ID_LI, undefined);
  });

  it('⚠️ NEAR-MISS: Cancelar on the warning opens nothing and frees the buttons', async () => {
    const s = cenario('nao-pago');
    montar();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));

    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Imprimir' }).disabled).toBe(
        false,
      ),
    );
    expect(s.imprimir).not.toHaveBeenCalled();
    expect(s.abrir).not.toHaveBeenCalled();
  });

  it('`pago` opens the label with no dialog', async () => {
    const s = cenario('pago');
    montar();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledTimes(1));
    expect(s.conferirPagamento).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Pagamento não confirmado/)).toBeNull();
  });

  it('a pedido that is not an imported order never calls the backend', async () => {
    const s = cenario('nao-pago');
    montar('pedido-manual');

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledTimes(1));
    expect(s.conferirPagamento).not.toHaveBeenCalled();
  });

  it('Rastrear never runs the check', async () => {
    const s = cenario('nao-pago');
    montar();

    fireEvent.click(screen.getByRole('button', { name: 'Rastrear' }));

    await waitFor(() => expect(s.rastrear).toHaveBeenCalledTimes(1));
    expect(s.conferirPagamento).not.toHaveBeenCalled();
  });

  it('an unverifiable check asks the A1 confirm — never the checkbox — and Cancelar opens nothing', async () => {
    const s = cenario('nao-pago');
    clientes.li = null;
    montar();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));
    expect(await screen.findByText(/^Pedido 165: A conferência de pagamento/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Estou ciente do risco' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Imprimir' }).disabled).toBe(
        false,
      ),
    );
    expect(s.imprimir).not.toHaveBeenCalled();
  });
});
