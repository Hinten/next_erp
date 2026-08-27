import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { SearchBar } from './SearchBar';

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

/** The input's current text. `@testing-library/jest-dom` is not set up here. */
function searchValue(): string {
  return (screen.getByRole('textbox') as HTMLInputElement).value;
}

describe('SearchBar', () => {
  it('debounces multiple keystrokes into a single onChange', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchBar value="" onChange={onChange} debounceMs={300} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(310);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('abc');
    vi.useRealTimers();
  });

  it('does not fire onChange on mount', async () => {
    // The regression that eats a restored term: this component used to emit
    // `onChange(initialValue)` one debounce after EVERY mount, which lands
    // ~300ms in — right on top of the sticky restore, silently clearing it.
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchBar value="camiseta" onChange={onChange} debounceMs={300} />);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('shows a value that arrives after mount, without echoing it back', async () => {
    // The sticky restore: `useTableUrlState` applies the remembered term in an
    // effect, so it reaches this component on a later render than the mount.
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = wrap(<SearchBar value="" onChange={onChange} debounceMs={300} />);
    expect(searchValue()).toBe('');

    rerender(
      <MantineTestProvider>
        <SearchBar value="camiseta" onChange={onChange} debounceMs={300} />
      </MantineTestProvider>,
    );
    expect(searchValue()).toBe('camiseta');

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('adopts an externally cleared term ("Limpar filtros") without re-emitting', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = wrap(<SearchBar value="camiseta" onChange={onChange} debounceMs={300} />);
    rerender(
      <MantineTestProvider>
        <SearchBar value="" onChange={onChange} debounceMs={300} />
      </MantineTestProvider>,
    );
    expect(searchValue()).toBe('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('stays silent when typing returns to the committed term before the debounce lands', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchBar value="ab" onChange={onChange} debounceMs={300} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(input, { target: { value: 'ab' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('emits again after a term was committed', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchBar value="" onChange={onChange} debounceMs={300} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'ab' } });
    await vi.advanceTimersByTimeAsync(310);
    fireEvent.change(input, { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(310);
    expect(onChange.mock.calls).toEqual([['ab'], ['abc']]);
    vi.useRealTimers();
  });
});
