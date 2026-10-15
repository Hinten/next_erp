import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  FreightNotFoundError,
  FreightServerError,
} from '@delfrance/integrations-freight-br/http-client';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The "Serviço" select of a `mapa` row mapped to Melhor Envio (step 20, #1826):
 * the account's services through the apps/melhor-envio route, and the DEGRADED
 * state when that route cannot answer — a backend that predates it answers 404.
 */

const h = vi.hoisted(() => ({ servicos: vi.fn() }));

vi.mock('@/lib/freight/client', () => ({
  useFreightClient: () => ({ servicos: h.servicos }),
}));

const { ServicoMelhorEnvioSelect } = await import('./ServicoMelhorEnvioSelect');

const LISTA = {
  servicos: [
    { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
    { id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios' } },
  ],
};

function renderSelect(props: Partial<Parameters<typeof ServicoMelhorEnvioSelect>[0]> = {}) {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <ServicoMelhorEnvioSelect
          label="Serviço"
          intFreteId="me-conta"
          value={null}
          nomeArmazenado={null}
          onChange={onChange}
          habilitado
          {...props}
        />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
  return { onChange, view, qc };
}

const entrada = () => screen.getAllByLabelText('Serviço')[0] as HTMLInputElement;

beforeEach(() => {
  h.servicos.mockReset();
});

describe('ServicoMelhorEnvioSelect', () => {
  it('lists the account’s services as "empresa — serviço" and hands back the picked one', async () => {
    h.servicos.mockResolvedValue(LISTA);
    const { onChange } = renderSelect();
    fireEvent.click(entrada());
    fireEvent.click(await screen.findByRole('option', { name: 'Correios — SEDEX' }));
    expect(h.servicos).toHaveBeenCalledWith('me-conta');
    expect(onChange).toHaveBeenCalledWith({
      id: 2,
      name: 'SEDEX',
      company: { id: 1, name: 'Correios' },
    });
  });

  it('(f) a 404 DEGRADES: disabled, the stored service still shown, asked once, and no new pick', async () => {
    h.servicos.mockRejectedValue(new FreightNotFoundError('Not Found', null));
    renderSelect({ value: 7, nomeArmazenado: 'Transportadora — Expresso' });
    expect(
      await screen.findByText(/não é possível escolher outro agora/, { exact: false }),
    ).toBeTruthy();
    expect(entrada().disabled).toBe(true);
    expect(entrada().value).toBe('Transportadora — Expresso');
    // A 404 is not retried even when the query layer would retry.
    expect(h.servicos).toHaveBeenCalledTimes(1);
  });

  it('NEAR-MISS: any other freight failure is retried once, then degrades the same way', async () => {
    h.servicos.mockRejectedValue(new FreightServerError('Erro no Melhor Envio', 502, null));
    renderSelect();
    expect(
      await screen.findByText(/Erro no Melhor Envio/, undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(entrada().disabled).toBe(true);
    expect(h.servicos).toHaveBeenCalledTimes(2);
  });

  it('asks nothing until habilitado, showing the stored service meanwhile; then asks once', async () => {
    h.servicos.mockResolvedValue(LISTA);
    const { view, qc } = renderSelect({
      value: 7,
      nomeArmazenado: 'Transportadora — Expresso',
      habilitado: false,
    });
    expect(entrada().value).toBe('Transportadora — Expresso');
    expect(h.servicos).not.toHaveBeenCalled();
    view.rerender(
      <QueryClientProvider client={qc}>
        <MantineTestProvider>
          <ServicoMelhorEnvioSelect
            label="Serviço"
            intFreteId="me-conta"
            value={7}
            nomeArmazenado="Transportadora — Expresso"
            onChange={vi.fn()}
            habilitado
          />
        </MantineTestProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(h.servicos).toHaveBeenCalledTimes(1));
    expect(h.servicos).toHaveBeenCalledWith('me-conta');
  });

  it('keeps a stored service missing from the list visible under its stored label', async () => {
    h.servicos.mockResolvedValue(LISTA);
    renderSelect({ value: 7, nomeArmazenado: 'Transportadora — Expresso' });
    expect(entrada().value).toBe('Transportadora — Expresso');
    fireEvent.click(entrada());
    expect(await screen.findByRole('option', { name: 'Correios — PAC' })).toBeTruthy();
  });
});
