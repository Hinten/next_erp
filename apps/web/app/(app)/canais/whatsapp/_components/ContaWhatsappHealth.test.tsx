import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WhatsappHealth } from '@/lib/whatsapp/client';

// Mock only `useWhatsappClient`; keep the real error classes so the degraded
// branch narrows correctly. Mirrors the hoisted-mock pattern of
// apps/web/app/(app)/chat/_components/MensagemThread.test.tsx.
const h = vi.hoisted(() => ({
  clientRef: { current: null as null | { health: (id: string) => Promise<WhatsappHealth> } },
}));

vi.mock('@/lib/whatsapp/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/client')>();
  return { ...actual, useWhatsappClient: () => h.clientRef.current };
});

const { ContaWhatsappHealth } = await import('./ContaWhatsappHealth');
const { WhatsappClientNetworkError } = await import('@/lib/whatsapp/client');

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(<ContaWhatsappHealth integracaoId="i1" />, { wrapper });
}

function setHealth(health: WhatsappHealth): void {
  h.clientRef.current = { health: vi.fn(async () => health) };
}

describe('ContaWhatsappHealth', () => {
  it('renders the ok verdicts and check rows', async () => {
    setHealth({
      generatedAt: 1,
      canSend: true,
      canReceive: true,
      checks: [
        { id: 'token', status: 'ok', label: 'Token', detail: 'Token cadastrado', hint: null },
        { id: 'quality', status: 'ok', label: 'Qualidade', detail: 'GREEN', hint: null },
      ],
    });
    renderCard();
    expect(await screen.findByText('Pode enviar')).toBeTruthy();
    expect(await screen.findByText('Pode receber')).toBeTruthy();
    expect(await screen.findByText('Token')).toBeTruthy();
    expect(await screen.findByText('Token cadastrado')).toBeTruthy();
  });

  it('renders a fail check with its detail + hint and the "não pode enviar" verdict', async () => {
    setHealth({
      generatedAt: 1,
      canSend: false,
      canReceive: false,
      checks: [
        {
          id: 'phone_status',
          status: 'fail',
          label: 'Status do número',
          detail: 'PENDING',
          hint: 'Verifique o número no painel do Meta.',
        },
      ],
    });
    renderCard();
    expect(await screen.findByText('Não pode enviar')).toBeTruthy();
    expect(await screen.findByText('Status do número')).toBeTruthy();
    expect(await screen.findByText('PENDING')).toBeTruthy();
    expect(await screen.findByText('Verifique o número no painel do Meta.')).toBeTruthy();
  });

  it('renders a skip check and the indeterminate-receive verdict', async () => {
    setHealth({
      generatedAt: 1,
      canSend: true,
      canReceive: null,
      checks: [
        {
          id: 'webhook_subscription',
          status: 'skip',
          label: 'Inscrição do webhook',
          detail: 'Preencha o WABA ID',
          hint: null,
        },
      ],
    });
    renderCard();
    expect(await screen.findByText('Recebimento indeterminado')).toBeTruthy();
    expect(await screen.findByText('Inscrição do webhook')).toBeTruthy();
    expect(await screen.findByText('Preencha o WABA ID')).toBeTruthy();
  });

  it('degrades to a yellow alert when the query fails (backend offline)', async () => {
    h.clientRef.current = {
      health: vi.fn(async () => {
        throw new WhatsappClientNetworkError('offline');
      }),
    };
    renderCard();
    expect(await screen.findByText('Falha de rede ao consultar a saúde da conta.')).toBeTruthy();
  });
});
