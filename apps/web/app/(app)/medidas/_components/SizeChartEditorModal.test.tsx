import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { SizeChartEditorModal } from './SizeChartEditorModal';

/**
 * The incident this file exists for: a network blip while the editor loaded the
 * Mercado Livre domain list left a red alert and no way forward. The domain
 * Select had no options, so `domainId` stayed null, so both downstream spec
 * queries stayed disabled — closing and re-opening the modal was the only
 * recovery, and it only worked because the parent remounts on a fresh `key`.
 */

const DOMAINS = { domains: [{ domain_id: 'MLB-T_SHIRTS', name: 'Camisetas' }] };

const networkError = () =>
  new MercadoLivreClientNetworkError('failed to fetch', new TypeError('fetch failed'));

function show(client: Partial<MercadoLivreClient>) {
  const qc = new QueryClient({
    // ⚠️ NOT `retry: false` — the queries set their own `retry` predicate, which
    // a client default cannot override. `retryDelay: 0` is the knob that IS
    // still ours, and it collapses the automatic backoff so the error path is
    // reached in one tick instead of three real seconds.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  render(
    // ⚠️ `env="test"` disables Mantine's transitions. Without it this fullScreen
    // `Modal` leaves a `Transition` timer running past the test and the callback
    // fires after jsdom has torn `window` down — an "every test passed, one
    // error" failure that names an innocent bystander file.
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>
        <SizeChartEditorModal
          opened
          onClose={vi.fn()}
          client={client as MercadoLivreClient}
          integracaoId="conta-1"
          tabMediId="tab-1"
          getFatos={() => ({}) as never}
          chart={null}
          chartIndex={null}
          grupos={[]}
          canWrite
          onSaveDraft={vi.fn()}
          onSend={vi.fn()}
          onDuplicate={vi.fn()}
        />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('SizeChartEditorModal — failed domain load', () => {
  it('heals a one-off blip without ever showing the operator an error', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(DOMAINS);
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(sizeChartDomains).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/Não foi possível contatar o Mercado Livre/)).toBeNull();
  });

  it('recovers in place when the operator retries a persistent failure', async () => {
    const sizeChartDomains = vi
      .fn()
      // The reported failure, verbatim — and it has to outlast the automatic
      // retries (1 initial attempt + ML_QUERY_MAX_RETRIES) to reach the alert.
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(DOMAINS);
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText(/Não foi possível contatar o Mercado Livre/)).toBeTruthy();
    });
    expect(sizeChartDomains).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));

    // The dead end is gone: the load recovers without the modal being closed.
    await waitFor(() => {
      expect(screen.queryByText(/Não foi possível contatar o Mercado Livre/)).toBeNull();
    });
    expect(sizeChartDomains).toHaveBeenCalledTimes(4);
    expect(screen.getByPlaceholderText('Selecione o domínio')).toBeTruthy();
  });

  // The old mapper keyed the "reconnect your account" copy on `status === 409`,
  // which is not one meaning: this route family answers 409 for AI states too.
  it('keeps a non-reauth 409 message instead of blaming the connection', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError(
          'Já existe uma sugestão em andamento.',
          409,
          'AI_JA_EM_ANDAMENTO',
        ),
      );
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText('Já existe uma sugestão em andamento.')).toBeTruthy();
    });
    expect(screen.queryByText(/reconecte em Canais de venda/)).toBeNull();
    // A 4xx is not worth re-attempting, so it was never retried either.
    expect(sizeChartDomains).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for a disconnected account, which retrying cannot fix', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError('unauthorized', 409, 'ML_REAUTH_REQUIRED'),
      );
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText(/reconecte em Canais de venda/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /Tentar novamente/ })).toBeNull();
  });
});
