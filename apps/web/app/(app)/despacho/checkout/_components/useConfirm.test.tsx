import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { useConfirm, type ConfirmHandle } from './useConfirm';

/**
 * The checkout's awaitable confirm, and its `ciencia` option (master plan
 * step 15, A2): the provider's `confirmarCiente` lands here at checkout and in
 * the checkout reprint, so it must behave exactly like the `/pedidos` one.
 */

function montar() {
  let api: ConfirmHandle | null = null;
  function Host() {
    const r = useConfirm();
    api = r;
    return <>{r.element}</>;
  }
  render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  return () => api!;
}

function abrir(api: () => ConfirmHandle, ciencia: boolean) {
  let resposta: boolean | undefined;
  act(() => {
    void api()
      .confirm({
        title: 'Pagamento não confirmado na Loja Integrada',
        message: 'Aviso.',
        danger: true,
        ...(ciencia ? { ciencia: true as const } : {}),
      })
      .then((r) => {
        resposta = r;
      });
  });
  return () => resposta;
}

const continuar = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Continuar' });
const checkbox = () =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: 'Estou ciente do risco' });

describe('useConfirm — the `ciencia` option', () => {
  it('Continuar is DISABLED until the box is ticked, then confirms', async () => {
    const api = montar();
    const resposta = abrir(api, true);

    expect(continuar().disabled).toBe(true);
    fireEvent.click(checkbox());
    expect(continuar().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(continuar());
    });

    expect(resposta()).toBe(true);
  });

  it('Cancelar answers false', async () => {
    const api = montar();
    const resposta = abrir(api, true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });

    expect(resposta()).toBe(false);
  });

  it('⚠️ NEAR-MISS: a second question opens UNTICKED', async () => {
    const api = montar();
    abrir(api, true);
    fireEvent.click(checkbox());
    await act(async () => {
      fireEvent.click(continuar());
    });

    abrir(api, true);

    expect(checkbox().checked).toBe(false);
    expect(continuar().disabled).toBe(true);
  });

  it('the near miss: without `ciencia` there is no checkbox and Continuar is live', () => {
    const api = montar();
    abrir(api, false);

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(continuar().disabled).toBe(false);
  });
});
