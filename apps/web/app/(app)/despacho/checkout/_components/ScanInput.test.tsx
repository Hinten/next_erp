import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ScanInput } from './ScanInput';

function renderInput(onScan: (code: string) => void) {
  return render(
    <MantineTestProvider>
      <ScanInput onScan={onScan} />
    </MantineTestProvider>,
  );
}

describe('ScanInput', () => {
  it('submits the code and clears the field on Enter', () => {
    const onScan = vi.fn();
    renderInput(onScan);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ABC123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('ABC123');
    expect(input.value).toBe('');
  });

  it('trims the code before submitting', () => {
    const onScan = vi.fn();
    renderInput(onScan);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  P1  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('P1');
  });

  it('does not submit while the operator is just typing', () => {
    const onScan = vi.fn();
    renderInput(onScan);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'partial' } });
    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores the Enter that commits an IME composition (keyCode 229)', () => {
    const onScan = vi.fn();
    renderInput(onScan);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'nome' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onScan).not.toHaveBeenCalled();
  });

  it('does not submit an empty code', () => {
    const onScan = vi.fn();
    renderInput(onScan);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScan).not.toHaveBeenCalled();
  });
});
