import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
    update: vi.fn(),
    hide: vi.fn(),
  },
}));

import { notifications } from '@mantine/notifications';
import { showErrorNotification } from './showErrorNotification';

const showSpy = vi.mocked(notifications.show);
const updateSpy = vi.mocked(notifications.update);

beforeEach(() => {
  showSpy.mockClear();
  updateSpy.mockClear();
});

describe('showErrorNotification', () => {
  it('calls notifications.show with the title, red color, and a JSX message containing the text', () => {
    showErrorNotification({ title: 'Erro', message: 'Cert file not found at /x/y/z' });

    expect(showSpy).toHaveBeenCalledOnce();
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.title).toBe('Erro');
    expect(arg.color).toBe('red');
    expect(arg.autoClose).toBe(8000);
    expect(arg.withCloseButton).toBe(true);
    expect(arg.id).toBeTruthy();
    expect(arg.message).toBeTruthy(); // JSX node, not a string
  });

  it('renders the message text and a copy button inside the JSX message', () => {
    showErrorNotification({ title: 'Erro', message: 'Cert file not found' });
    const arg = showSpy.mock.calls[0]![0]!;

    render(<MantineProvider>{arg.message as React.ReactNode}</MantineProvider>);
    // getByText / getByLabelText throw if not found, so reaching here means
    // both nodes are in the rendered output.
    expect(screen.getByText('Cert file not found').textContent).toBe('Cert file not found');
    expect(screen.getByLabelText('Copiar mensagem de erro')).toBeTruthy();
  });

  it('hover-pause: mouseenter calls update with autoClose=false, mouseleave restores autoClose', () => {
    showErrorNotification({ title: 'Erro', message: 'msg', autoClose: 8000 });
    const arg = showSpy.mock.calls[0]![0]!;
    const id = arg.id!;

    render(<MantineProvider>{arg.message as React.ReactNode}</MantineProvider>);
    // The Group is the outermost element of the message JSX; trigger
    // hover via the Text inside it so the event bubbles.
    const text = screen.getByText('msg');
    fireEvent.mouseEnter(text);
    expect(updateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id, autoClose: false }),
    );
    fireEvent.mouseLeave(text);
    expect(updateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id, autoClose: 8000 }),
    );
  });

  it('respects custom color and autoClose', () => {
    showErrorNotification({ title: 't', message: 'm', color: 'orange', autoClose: 3000 });
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('orange');
    expect(arg.autoClose).toBe(3000);
  });
});
