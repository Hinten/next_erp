import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { ReembolsoParcialModal } from './ReembolsoParcialModal';

const OFERTAS = [
  { amount: 268.2, percentage: 90 },
  { amount: 149, percentage: 50 },
  { amount: 89.4, percentage: 30 },
];

function montar(over: Partial<React.ComponentProps<typeof ReembolsoParcialModal>> = {}) {
  const onConfirm = vi.fn();
  const utils = render(
    <MantineTestProvider>
      <ReembolsoParcialModal
        opened
        onClose={vi.fn()}
        ofertas={OFERTAS}
        recomendacoes={[]}
        restricoes={[]}
        carregando={false}
        enviando={false}
        erro={null}
        onConfirm={onConfirm}
        {...over}
      />
    </MantineTestProvider>,
  );
  return { ...utils, onConfirm };
}

// ⚠️ This suite loads no jest-dom, so disabled state is asserted through the
// DOM property rather than `toBeDisabled` (which silently reads as an invalid
// Chai property).
function confirmar(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: 'Confirmar reembolso parcial',
  }) as HTMLButtonElement;
}

describe('ReembolsoParcialModal — ML reads a MISSING percentage as 50%', () => {
  /**
   * ⚠️⚠️ Every assertion in this block exists because Mercado Livre does not
   * REJECT a partial refund with no percentage — it refunds **half the order**.
   * So the property under test is not "invalid input is rejected" but "the
   * operator not having chosen is unrepresentable".
   */
  it('offers NO free numeric input — only ML’s own values are expressible', () => {
    const { container } = montar();
    // A percentage ML did not offer cannot be typed, dragged or spun into being.
    expect(container.querySelector('input[type="number"]')).toBeNull();
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it('preselects NOTHING, so confirm cannot send an unchosen value', () => {
    // ⚠️ The layer that literally prevents "left blank". A default selection
    // would be a value the operator never clicked but did confirm.
    montar();
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(confirmar().disabled).toBe(true);
  });

  it('still blocks confirm after a choice, until the acknowledgement is ticked', () => {
    montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?149,00/ }));
    expect(confirmar().disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirmar().disabled).toBe(false);
  });

  it('sends the AMOUNT in minor units plus the percentage actually shown', () => {
    // ⚠️ The amount is the authority — `percentualParaValor` matches on it and
    // re-derives the percentage from ML's own list. Sending only the percentage
    // would commit the same LABEL against a possibly different sum.
    const { onConfirm } = montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?149,00/ }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmar());

    expect(onConfirm).toHaveBeenCalledWith({
      valorReembolsoMinor: 14900,
      percentualExibido: 50,
    });
  });

  it('echoes the exact amount in the acknowledgement', () => {
    // The operator ticks a box that repeats the money back at them, not a
    // generic "I understand".
    montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?268,20/ }));
    expect(screen.getByText(/Estou ciente.*268,20.*90%.*não é possível desfazer/s)).toBeTruthy();
  });
});

describe('ReembolsoParcialModal — what cannot be offered', () => {
  it('filters 100% out — that is the full-refund action, which ML rejects here', () => {
    montar({ ofertas: [...OFERTAS, { amount: 298, percentage: 100 }] });
    expect(screen.queryByRole('radio', { name: /100%/ })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('renders no confirm path at all when ML offers nothing', () => {
    // ⚠️ Not a disabled button over an empty list — that looks like a UI fault
    // and invites a support ticket.
    montar({ ofertas: [] });
    expect(screen.queryByRole('button', { name: 'Confirmar reembolso parcial' })).toBeNull();
    expect(screen.getByText(/não oferece reembolso parcial nesta reclamação/)).toBeTruthy();
  });

  it('disables rows below a minimum restriction, and says why', () => {
    // The difference between ML answering `400 below minimum` AFTER the commit
    // and the row simply not being clickable.
    montar({ restricoes: [{ percentage: 50, reason: 'PAREX_REJECTED', type: 'minimum' }] });
    expect((screen.getByRole('radio', { name: /R\$\s?89,40/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('radio', { name: /R\$\s?149,00/ }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(screen.getByText(/exige no mínimo 50%/)).toBeTruthy();
  });

  it('badges a recommended offer without preselecting it', () => {
    // Advice, not a decision — ML recommending 90% must not tick 90% for them.
    montar({
      recomendacoes: [
        { percentage: 90, reason: 'PARTIAL_REFUND_BETTER_THAN_RETURN', type: 'maximum' },
      ],
    });
    expect(screen.getByText('Recomendado pelo ML')).toBeTruthy();
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });
});

describe('ReembolsoParcialModal — the payload cannot be stale at commit', () => {
  it('blocks confirm while the offers are being refetched', () => {
    // ⚠️ `isFetching`, not `isLoading`: a cached reopen still refetches, and the
    // list under the operator's chosen row may be about to change.
    const { rerender, onConfirm } = montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?149,00/ }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirmar().disabled).toBe(false);

    rerender(
      <MantineTestProvider>
        <ReembolsoParcialModal
          opened
          onClose={vi.fn()}
          ofertas={OFERTAS}
          recomendacoes={[]}
          restricoes={[]}
          carregando
          enviando={false}
          erro={null}
          onConfirm={onConfirm}
        />
      </MantineTestProvider>,
    );
    expect(confirmar().disabled).toBe(true);
  });

  it('CLEARS the acknowledgement when a refetch removes the chosen offer', () => {
    // ⚠️ The assertion that makes the reset effect load-bearing, and the one my
    // first attempt missed. Dropping the SELECTION happens for free —
    // `selecionada` is derived by looking the value up in the current list, so a
    // vanished offer already resolves to null. What does NOT happen for free is
    // clearing `ciente`: without it the operator picks a new amount and finds the
    // acknowledgement still ticked from the old one, and confirms a DIFFERENT sum
    // under a consent they gave for something else.
    const { rerender, onConfirm } = montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?149,00/ }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirmar().disabled).toBe(false);

    // ML re-prices: 149,00 is gone, 268,20 remains.
    rerender(
      <MantineTestProvider>
        <ReembolsoParcialModal
          opened
          onClose={vi.fn()}
          ofertas={[{ amount: 268.2, percentage: 90 }]}
          recomendacoes={[]}
          restricoes={[]}
          carregando={false}
          enviando={false}
          erro={null}
          onConfirm={onConfirm}
        />
      </MantineTestProvider>,
    );

    // Picking the surviving offer must require a FRESH acknowledgement.
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?268,20/ }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(confirmar().disabled).toBe(true);
  });

  it('drops the selection when a refetch removes the chosen offer', () => {
    // Otherwise the operator confirms an amount ML no longer lists — and the
    // acknowledgement they ticked was about a sum that is gone.
    const { rerender, onConfirm } = montar();
    fireEvent.click(screen.getByRole('radio', { name: /R\$\s?149,00/ }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirmar().disabled).toBe(false);

    rerender(
      <MantineTestProvider>
        <ReembolsoParcialModal
          opened
          onClose={vi.fn()}
          ofertas={[{ amount: 268.2, percentage: 90 }]}
          recomendacoes={[]}
          restricoes={[]}
          carregando={false}
          enviando={false}
          erro={null}
          onConfirm={onConfirm}
        />
      </MantineTestProvider>,
    );
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(confirmar().disabled).toBe(true);
  });

  it('shows a refusal verbatim and keeps the modal usable', () => {
    // A 409 here NAMES the percentages ML does offer; closing would throw that
    // away along with the operator's place in the list.
    montar({
      erro: 'O Mercado Livre não oferece um reembolso parcial de 200. Disponíveis: 90% = 268.2',
    });
    expect(screen.getByText(/Disponíveis: 90% = 268\.2/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });
});
