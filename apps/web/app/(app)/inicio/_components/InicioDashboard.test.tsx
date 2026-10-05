import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineTestProvider } from '@/lib/testing/mantine';
const mocks = vi.hoisted(() => ({ checkout: vi.fn() }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/inicio/queries', async (original) => ({
  ...(await original<typeof import('@/lib/inicio/queries')>()),
  loadCheckoutInicio: mocks.checkout,
}));
vi.mock('@mantine/charts', () => ({
  PieChart: ({ data }: { data: unknown }) => <div data-testid="pie">{JSON.stringify(data)}</div>,
}));
import { CheckoutCard } from './InicioDashboard';

describe('checkout card', () => {
  it('switches chart periods using loaded counts and keeps unknown users', async () => {
    mocks.checkout.mockResolvedValue({
      total: { dia: 1, semana: 3, mes: 2 },
      rows: [{ userId: null, label: 'Outros usuários', dia: 1, semana: 3, mes: 2 }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineTestProvider>
        <QueryClientProvider client={client}>
          <CheckoutCard uid="u" day={1} />
        </QueryClientProvider>
      </MantineTestProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('pie').textContent).toContain('"value":1'));
    fireEvent.click(screen.getByText('Semana', { selector: 'span' }));
    expect(screen.getByTestId('pie').textContent).toContain('"value":3');
    fireEvent.click(screen.getByText('Mês', { selector: 'span' }));
    expect(screen.getByTestId('pie').textContent).toContain('"value":2');
    expect(screen.getByText('Outros usuários')).toBeTruthy();
    expect(mocks.checkout).toHaveBeenCalledOnce();
    client.clear();
  });
});
