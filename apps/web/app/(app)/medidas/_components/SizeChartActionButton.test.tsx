import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { SizeChartActionButton } from './SizeChartActionButton';

/**
 * The failure mode this file exists for: a tooltip that renders but cannot be
 * triggered. Mantine turns pointer events OFF on a disabled `Button`, so a
 * `Tooltip` wrapping one directly never fires — and a message nobody can reach
 * is worse than none, because it looks solved. Every assertion below therefore
 * checks the label is REACHABLE, never merely present in the DOM.
 */

const MOTIVO = 'Requer permissão de escrita em integrações para enviar ao Mercado Livre.';

/**
 * Opens a Mantine `Tooltip`.
 *
 * ⚠️ Fired on the WRAPPER, not the button. Mantine v9 → floating-ui `useHover`
 * registers `mouseenter` natively on the reference element (deliberately
 * bypassing React's delegation), and `mouseenter` does not bubble — so a hover
 * aimed at the `<button>` reaches no listener at all. The reference is the
 * `<span>` the component wraps the button in, i.e. `button.parentElement`.
 *
 * `fireEvent.mouseEnter` is enough: RTL dispatches the bubbling `mouseover`
 * alongside the native `mouseenter`, and Mantine's default `openDelay` is 0, so
 * the label mounts synchronously. No pointer priming is needed — `useHover`'s
 * `mouseOnly` guard treats an unset `pointerType` as mouse-like.
 */
function hoverWrapper(button: HTMLElement): void {
  const wrapper = button.parentElement;
  expect(wrapper).not.toBeNull();
  fireEvent.mouseEnter(wrapper!);
}

function show(motivo: string | null, onClick = vi.fn()) {
  render(
    <MantineTestProvider>
      <SizeChartActionButton gate={{ disabled: motivo !== null, motivo }} onClick={onClick}>
        Excluir
      </SizeChartActionButton>
    </MantineTestProvider>,
  );
  return { button: screen.getByRole('button', { name: 'Excluir' }), onClick };
}

describe('SizeChartActionButton', () => {
  it('disables the button and makes the motivo reachable on hover', async () => {
    const { button } = show(MOTIVO);

    expect(button.hasAttribute('disabled')).toBe(true);
    // ⚠️ The half that matters: present-in-the-DOM would pass even for a
    // tooltip that can never open.
    expect(screen.queryByText(MOTIVO)).toBeNull();

    hoverWrapper(button);
    expect(await screen.findByText(MOTIVO)).not.toBeNull();
  });

  it('leaves an open gate clickable and silent', async () => {
    const { button, onClick } = show(null);

    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    hoverWrapper(button);
    // A `motivo` on an enabled control is the mirror-image bug: it would explain
    // a state the button is not in.
    await Promise.resolve();
    expect(screen.queryByText(MOTIVO)).toBeNull();
  });

  /**
   * ⚠️ The wrapper must not change the accessible name — `medidas-mercado-livre.
   * cadastros.e2e.spec.ts` locates every one of these buttons by role+name, and
   * an `aria-label` here would break all of them silently.
   */
  it('keeps the button locatable by role and name', () => {
    const { button } = show(MOTIVO);
    expect(button.textContent).toBe('Excluir');
    expect(button.getAttribute('aria-label')).toBeNull();
  });
});
