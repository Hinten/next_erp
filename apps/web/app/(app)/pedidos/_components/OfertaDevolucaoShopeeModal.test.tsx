import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ShopeeSolucaoOfertavel } from '@/lib/shopee/wire';
import { OfertaDevolucaoShopeeModal } from './OfertaDevolucaoShopeeModal';

type Props = React.ComponentProps<typeof OfertaDevolucaoShopeeModal>;

/** Adjustable return-and-refund within R$ 10,00 … R$ 89,90; a fixed refund-only. */
const SOLUCOES: ShopeeSolucaoOfertavel[] = [
  { solucao: 'RETURN_REFUND', ajustavel: true, minimo: 10, maximo: 89.9 },
  { solucao: 'REFUND', ajustavel: false, minimo: null, maximo: null },
];

const base = (over: Partial<Props> = {}): Props => ({
  solucoes: SOLUCOES,
  carregando: false,
  enviando: false,
  erro: null,
  onConfirm: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

// A FRESH element per call: React bails out of a re-render handed the
// referentially identical element, which would make every `rerender` vacuous.
const modal = (props: Props) => (
  <MantineTestProvider>
    <OfertaDevolucaoShopeeModal {...props} />
  </MantineTestProvider>
);

function montar(over: Partial<Props> = {}) {
  const props = base(over);
  const utils = render(modal(props));
  return { ...utils, props, onConfirm: vi.mocked(props.onConfirm) };
}

// ⚠️ This suite loads no jest-dom, so disabled/checked state is asserted
// through the DOM property rather than `toBeDisabled`.
const enviar = () => screen.getByRole('button', { name: 'Enviar proposta' }) as HTMLButtonElement;
const radio = (nome: string) => screen.getByRole('radio', { name: nome }) as HTMLInputElement;
const devolucaoEReembolso = () => radio('Devolução e reembolso');
const apenasReembolso = () => radio('Apenas reembolso');
const valorInput = () => screen.getByLabelText('Valor do reembolso proposto') as HTMLInputElement;
const ciente = () => screen.getByRole('checkbox') as HTMLInputElement;

/** `fireEvent.change` replaces the WHOLE text, so each call carries the full value. */
function digitar(texto: string) {
  fireEvent.change(valorInput(), { target: { value: texto } });
}

describe('OfertaDevolucaoShopeeModal — nothing the operator did not choose is sent', () => {
  it('preselects NOTHING — not even when Shopee offers a single solução', () => {
    // ⚠️ A default selection is a proposal the operator never clicked but did
    // confirm. One eligible row is exactly when a "helpful" preselect tempts.
    montar({ solucoes: [SOLUCOES[1]!] });
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(enviar().disabled).toBe(true);
  });

  it('shows the amount input only for an ADJUSTABLE solução, and empty', () => {
    montar();
    expect(screen.queryByLabelText('Valor do reembolso proposto')).toBeNull();

    fireEvent.click(apenasReembolso());
    expect(screen.queryByLabelText('Valor do reembolso proposto')).toBeNull();
    // A fixed solução needs no amount: the acknowledgement is the last step.
    expect(ciente().checked).toBe(false);

    fireEvent.click(devolucaoEReembolso());
    // Never prefilled — not with a bound, not with anything typed before.
    expect(valorInput().value).toBe('');
    expect(screen.getByText('Informe um valor entre R$ 10,00 e R$ 89,90.')).toBeTruthy();
    // An adjustable solução with no amount is not a complete proposal yet.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(enviar().disabled).toBe(true);
  });

  it('sends the amount as INTEGER centavos, and no third decimal can reach it', () => {
    const { onConfirm } = montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('12,3');
    digitar('12,34');
    // The field takes two decimals and no more: the third keystroke is dropped
    // at the input, so nothing downstream ever has to round it.
    digitar('12,345');
    expect(valorInput().value).toContain('12,34');
    expect(valorInput().value).not.toContain('12,345');

    fireEvent.click(ciente());
    fireEvent.click(enviar());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // ⚠️ 1234, never 12.34: reais floats do not leave the browser (R-14).
    expect(onConfirm).toHaveBeenCalledWith({ solucao: 'RETURN_REFUND', valorReembolsoMinor: 1234 });
  });

  it('sends NO amount key for a non-adjustable solução — even after one was typed', () => {
    // ⚠️ Shopee refuses an amount on a fixed solução, and `0` IS an amount.
    // The stale case is the one that matters: typed under the adjustable row,
    // then switched.
    const { onConfirm } = montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('20');
    fireEvent.click(apenasReembolso());
    expect(screen.queryByLabelText('Valor do reembolso proposto')).toBeNull();

    fireEvent.click(ciente());
    fireEvent.click(enviar());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const enviado = onConfirm.mock.calls[0]![0];
    expect(enviado).toEqual({ solucao: 'REFUND' });
    expect(Object.keys(enviado)).toEqual(['solucao']);
  });

  it('does not carry an amount typed under one solução back into it', () => {
    montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('20');
    fireEvent.click(apenasReembolso());
    fireEvent.click(devolucaoEReembolso());
    expect(valorInput().value).toBe('');
    expect(enviar().disabled).toBe(true);
  });
});

describe('OfertaDevolucaoShopeeModal — out of range is REFUSED, never clamped', () => {
  it('refuses an amount above the maximum, states the range, and keeps what was typed', () => {
    const { onConfirm } = montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('95');

    expect(
      screen.getByText('Fora da faixa que a Shopee permite: entre R$ 10,00 e R$ 89,90.'),
    ).toBeTruthy();
    // ⚠️ A clamp would rewrite 95 to 89,90 and arm confirm on a sum nobody typed.
    expect(valorInput().value).toContain('95');
    expect(valorInput().value).not.toContain('89');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(enviar().disabled).toBe(true);
    fireEvent.click(enviar());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['9,99', false],
    ['10', true],
    ['89,9', true],
    ['89,91', false],
  ])('the bounds are inclusive and compared to the centavo: %s ⇒ accepted %s', (texto, aceito) => {
    // A pair that must pass (each bound itself) and a near-miss one centavo
    // outside each — R-14's `min ≤ v ≤ max`, in centavos.
    montar();
    fireEvent.click(devolucaoEReembolso());
    digitar(texto);
    expect(screen.queryByRole('checkbox') !== null).toBe(aceito);
    expect(screen.queryByText(/Fora da faixa/) === null).toBe(aceito);
  });

  it('refuses zero — an amount the route would reject', () => {
    montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('0');
    expect(screen.getByText('Informe um valor maior que zero.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(enviar().disabled).toBe(true);
  });

  it('checks only the bound Shopee sent — an open side is Shopee’s to refuse', () => {
    const { onConfirm } = montar({
      solucoes: [{ solucao: 'RETURN_REFUND', ajustavel: true, minimo: null, maximo: 50 }],
    });
    fireEvent.click(devolucaoEReembolso());
    expect(screen.getByText('Informe um valor até R$ 50,00.')).toBeTruthy();
    digitar('0,01');
    fireEvent.click(ciente());
    fireEvent.click(enviar());
    expect(onConfirm).toHaveBeenCalledWith({ solucao: 'RETURN_REFUND', valorReembolsoMinor: 1 });
  });
});

describe('OfertaDevolucaoShopeeModal — the acknowledgement is for ONE (solução, amount)', () => {
  it('echoes the solução and the amount it acknowledges', () => {
    montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('25,5');
    expect(
      screen.getByText(
        /Entendo que a proposta \(Devolução e reembolso com reembolso de R\$\s?25,50\) vai ao comprador e não pode ser retirada pelo ERP\./,
      ),
    ).toBeTruthy();
  });

  it('clears when the AMOUNT changes', () => {
    montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('20');
    fireEvent.click(ciente());
    expect(enviar().disabled).toBe(false);

    digitar('30');
    // ⚠️ Ticked for R$ 20,00; R$ 30,00 needs its own consent.
    expect(ciente().checked).toBe(false);
    expect(enviar().disabled).toBe(true);
  });

  it('clears when the SOLUÇÃO changes, even with no amount on either side', () => {
    montar({
      solucoes: [
        { solucao: 'RETURN_REFUND', ajustavel: false, minimo: null, maximo: null },
        { solucao: 'REFUND', ajustavel: false, minimo: null, maximo: null },
      ],
    });
    fireEvent.click(devolucaoEReembolso());
    fireEvent.click(ciente());
    expect(enviar().disabled).toBe(false);

    fireEvent.click(apenasReembolso());
    expect(ciente().checked).toBe(false);
    expect(enviar().disabled).toBe(true);
  });

  it('clears when a refetch makes the chosen solução fixed — and the typed amount stays home', () => {
    const { rerender, props, onConfirm } = montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('20');
    fireEvent.click(ciente());
    expect(enviar().disabled).toBe(false);

    rerender(
      modal({
        ...props,
        solucoes: [{ solucao: 'RETURN_REFUND', ajustavel: false, minimo: null, maximo: null }],
      }),
    );
    expect(ciente().checked).toBe(false);
    expect(enviar().disabled).toBe(true);

    // ⚠️ No radio click resets the amount here — the solução did not change,
    // only whether it takes one. The R$ 20,00 still in state must not ride along.
    fireEvent.click(ciente());
    fireEvent.click(enviar());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(Object.keys(onConfirm.mock.calls[0]![0])).toEqual(['solucao']);
  });
});

describe('OfertaDevolucaoShopeeModal — the payload cannot be stale at commit', () => {
  it('blocks confirm while the estado is refetching', () => {
    const { rerender, props, onConfirm } = montar();
    fireEvent.click(apenasReembolso());
    fireEvent.click(ciente());
    expect(enviar().disabled).toBe(false);

    rerender(modal({ ...props, carregando: true }));
    expect(enviar().disabled).toBe(true);
    expect(screen.getByText('Atualizando as soluções da Shopee…')).toBeTruthy();
    fireEvent.click(enviar());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('blocks confirm, Cancelar and the choices while the proposal is being sent', () => {
    const { rerender, props } = montar();
    fireEvent.click(apenasReembolso());
    fireEvent.click(ciente());

    rerender(modal({ ...props, enviando: true }));
    expect(enviar().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(devolucaoEReembolso().disabled).toBe(true);
  });

  it('drops the selection when a refetch removes the chosen solução', () => {
    const { rerender, props } = montar();
    fireEvent.click(apenasReembolso());
    fireEvent.click(ciente());
    expect(enviar().disabled).toBe(false);

    rerender(modal({ ...props, solucoes: [SOLUCOES[0]!] }));
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(enviar().disabled).toBe(true);
  });

  it('shows a refusal verbatim and keeps the operator’s choice in place', () => {
    // The 409 names what to do next; closing would throw that away along with
    // the operator's place.
    const { rerender, props } = montar();
    fireEvent.click(devolucaoEReembolso());
    digitar('20');
    fireEvent.click(ciente());

    const frase =
      'Informe um valor dentro da faixa que a Shopee permite para esta devolução — o valor proposto ficou fora dela.';
    rerender(modal({ ...props, erro: frase }));
    expect(screen.getByText(frase)).toBeTruthy();
    expect(devolucaoEReembolso().checked).toBe(true);
    expect(valorInput().value).toContain('20');
    expect(ciente().checked).toBe(true);
  });

  it('starts from nothing when mounted again — the panel unmounts it on close', () => {
    const { unmount } = montar();
    fireEvent.click(apenasReembolso());
    fireEvent.click(ciente());
    unmount();

    montar();
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(enviar().disabled).toBe(true);
  });
});

describe('OfertaDevolucaoShopeeModal — what cannot be proposed', () => {
  it('renders no confirm path at all when Shopee offers nothing', () => {
    // ⚠️ Not a disabled button over an empty list — that reads as a UI fault.
    montar({ solucoes: [] });
    expect(screen.queryByRole('button', { name: 'Enviar proposta' })).toBeNull();
    expect(screen.getByText(/não oferece nenhuma solução para propor/)).toBeTruthy();
  });

  it('closes through Cancelar without proposing anything', () => {
    const { props, onConfirm } = montar();
    fireEvent.click(apenasReembolso());
    fireEvent.click(ciente());
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
