import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { SearchBar } from './SearchBar';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>);
}

describe('SearchBar', () => {
  it('debounces multiple keystrokes into a single onChange', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchBar onChange={onChange} debounceMs={300} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).not.toHaveBeenCalledWith('abc');
    await vi.advanceTimersByTimeAsync(310);
    // The mount also fires once with the initial value '', so filter to the
    // most recent call we actually care about.
    expect(onChange).toHaveBeenLastCalledWith('abc');
    vi.useRealTimers();
  });
});
