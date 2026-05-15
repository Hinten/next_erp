import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Pagination } from './Pagination';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>);
}

describe('Pagination', () => {
  it('fires onPrev / onNext when buttons clicked', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    wrap(<Pagination canGoPrev canGoNext onPrev={onPrev} onNext={onNext} />);
    fireEvent.click(screen.getByRole('button', { name: /Anterior/ }));
    fireEvent.click(screen.getByRole('button', { name: /Próximo/ }));
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('disables buttons when can flags are false', () => {
    wrap(<Pagination canGoPrev={false} canGoNext={false} onPrev={() => {}} onNext={() => {}} />);
    // Mantine sets the disabled state via the DOM attribute, but the JS
    // `.disabled` property is true only when the underlying element is a
    // <button>. Use hasAttribute for robustness against either rendering.
    expect(screen.getByRole('button', { name: /Anterior/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Próximo/ }).hasAttribute('disabled')).toBe(true);
  });
});
