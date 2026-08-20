import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
    update: vi.fn(),
    hide: vi.fn(),
  },
}));

import { notifications } from '@mantine/notifications';
import { showCopyableNotification, showErrorNotification } from './showErrorNotification';

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

  it('passes styles that let the title wrap instead of truncating', () => {
    showErrorNotification({ title: 'Erro', message: 'm' });
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.styles).toMatchObject({ title: { whiteSpace: 'normal' } });
  });

  it('renders a long cert-path message in full without dropping the copy button', () => {
    const longMessage =
      'Could not read the SEFAZ TLS chain at C:\\Users\\Lucas\\dev\\next_erp\\packages\\integrations\\nfe\\ca\\sefaz-sp-homologacao.pem: ENOENT: no such file or directory. ' +
      "Run 'pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca' to vendor it for this (UF, ambiente).";
    showErrorNotification({ title: 'Erro de certificado', message: longMessage });
    const arg = showSpy.mock.calls[0]![0]!;

    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    // The full string is present in the DOM (nothing clipped out), and the copy
    // button is still rendered alongside it.
    expect(screen.getByText(longMessage).textContent).toBe(longMessage);
    expect(screen.getByLabelText('Copiar mensagem')).toBeTruthy();
  });

  it('renders the message text and a copy button inside the JSX message', () => {
    showErrorNotification({ title: 'Erro', message: 'Cert file not found' });
    const arg = showSpy.mock.calls[0]![0]!;

    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    // getByText / getByLabelText throw if not found, so reaching here means
    // both nodes are in the rendered output.
    expect(screen.getByText('Cert file not found').textContent).toBe('Cert file not found');
    expect(screen.getByLabelText('Copiar mensagem')).toBeTruthy();
  });

  it('hover-pause: mouseenter calls update with autoClose=false, mouseleave restores autoClose', () => {
    showErrorNotification({ title: 'Erro', message: 'msg', autoClose: 8000 });
    const arg = showSpy.mock.calls[0]![0]!;
    const id = arg.id!;

    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    // The Group is the outermost element of the message JSX; trigger
    // hover via the Text inside it so the event bubbles.
    const text = screen.getByText('msg');
    fireEvent.mouseEnter(text);
    expect(updateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id,
        autoClose: false,
        styles: expect.objectContaining({
          title: expect.objectContaining({ whiteSpace: 'normal' }),
        }),
      }),
    );
    fireEvent.mouseLeave(text);
    expect(updateSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id, autoClose: 8000 }));
  });

  it('respects custom color and autoClose', () => {
    showErrorNotification({ title: 't', message: 'm', color: 'orange', autoClose: 3000 });
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('orange');
    expect(arg.autoClose).toBe(3000);
  });
});

describe('showCopyableNotification', () => {
  it('is the generic entry — honors the caller color (emit-result toasts)', () => {
    showCopyableNotification({ title: 'EPEC registrado', message: 'cStat=136 …', color: 'teal' });
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('teal');
    expect(arg.title).toBe('EPEC registrado');
    // Same copyable JSX message as the error variant.
    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    expect(screen.getByLabelText('Copiar mensagem')).toBeTruthy();
  });

  it('copies the TITLE + message (the title carries the outcome context)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    showCopyableNotification({ title: 'EPEC registrado', message: 'cStat=136: ok', color: 'teal' });
    const arg = showSpy.mock.calls[0]![0]!;
    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    fireEvent.click(screen.getByLabelText('Copiar mensagem'));
    expect(writeText).toHaveBeenCalledWith('EPEC registrado: cStat=136: ok');
  });
});
