import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { RetryAlert, type RetryAlertProps } from './RetryAlert';

function show(props: Partial<RetryAlertProps> = {}) {
  render(
    <MantineProvider env="test">
      <RetryAlert message="Não foi possível carregar." {...props} />
    </MantineProvider>,
  );
}

describe('RetryAlert', () => {
  it('shows the message and a retry button', () => {
    show({ onRetry: vi.fn() });
    expect(screen.getByText('Não foi possível carregar.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tentar novamente/ })).toBeTruthy();
  });

  it('calls onRetry once per click', () => {
    const onRetry = vi.fn();
    show({ onRetry });
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // A failure the operator must fix elsewhere (a disconnected account, a blocked
  // publish) gets no button: one that cannot help is worse than none.
  it('renders no button when there is nothing a retry could fix', () => {
    show();
    expect(screen.queryByRole('button', { name: /Tentar novamente/ })).toBeNull();
  });

  it('marks the button as loading while a retry is in flight', () => {
    show({ onRetry: vi.fn(), retrying: true });
    expect(
      screen.getByRole('button', { name: /Tentar novamente/ }).getAttribute('data-loading'),
    ).toBe('true');
  });

  it('renders the title in the default variant', () => {
    show({ title: 'Falha ao carregar', onRetry: vi.fn() });
    expect(screen.getByText('Falha ao carregar')).toBeTruthy();
  });

  it('drops the title in the compact variant', () => {
    show({ title: 'Falha ao carregar', variant: 'compact', onRetry: vi.fn() });
    expect(screen.queryByText('Falha ao carregar')).toBeNull();
  });
});
