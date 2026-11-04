import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { useConfirmDialog, type UseConfirmDialogResult } from './ConfirmDialog';

/**
 * The `/pedidos` awaitable confirm, and its `ciencia` option (master plan
 * step 15, A2): an acknowledged-risk question whose confirm stays disabled
 * until "Estou ciente do risco" is ticked — and a tick that never carries over
 * to the next question.
 */

function montar() {
  let api: UseConfirmDialogResult | null = null;
  function Host() {
    const r = useConfirmDialog();
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

function abrir(api: () => UseConfirmDialogResult, ciencia: boolean) {
  let resposta: boolean | undefined;
  act(() => {
    void api()
      .confirm({
        title: 'Pagamento não confirmado na Loja Integrada',
        message: 'Aviso.',
        confirmLabel: 'Continuar',
        cancelLabel: 'Cancelar',
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

describe('useConfirmDialog — the `ciencia` option', () => {
  it('Continuar is DISABLED until the box is ticked, then confirms', async () => {
    const api = montar();
    const resposta = abrir(api, true);

    expect(continuar().disabled).toBe(true);
    fireEvent.click(continuar());
    expect(resposta()).toBeUndefined();

    fireEvent.click(checkbox());
    expect(continuar().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(continuar());
    });

    expect(resposta()).toBe(true);
  });

  it('Cancelar answers false, ticked or not', async () => {
    const api = montar();
    const resposta = abrir(api, true);

    fireEvent.click(checkbox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });

    expect(resposta()).toBe(false);
  });

  it('⚠️ NEAR-MISS: a second question opens UNTICKED — the first answer never carries over', async () => {
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
