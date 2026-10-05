import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { PropagatePriceToChildrenField } from './PropagatePriceToChildrenField';

const LABEL = 'Propagar preço para as variações';

function propagationSwitch() {
  return screen.getByRole('switch', { name: new RegExp(LABEL) });
}

function renderField(value: boolean, divergentChildren = 0) {
  const onChange = vi.fn();
  render(
    <MantineTestProvider>
      <PropagatePriceToChildrenField
        value={value}
        onChange={onChange}
        divergentChildren={divergentChildren}
      />
    </MantineTestProvider>,
  );
  return onChange;
}

afterEach(cleanup);

describe('PropagatePriceToChildrenField', () => {
  it('turns propagation off immediately', () => {
    const onChange = renderField(true);

    fireEvent.click(propagationSwitch());

    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('turns propagation on immediately when every child already matches', () => {
    const onChange = renderField(false);

    fireEvent.click(propagationSwitch());

    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before replacing divergent child prices, and cancel preserves the current value', () => {
    const onChange = renderField(false, 2);

    fireEvent.click(propagationSwitch());
    expect(screen.getByRole('dialog').textContent).toContain(
      '2 variações têm preços diferentes do produto pai.',
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('confirms propagation and the server-side synchronization on the next save', () => {
    const onChange = renderField(false, 1);

    fireEvent.click(propagationSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Propagar e sincronizar' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });
});
