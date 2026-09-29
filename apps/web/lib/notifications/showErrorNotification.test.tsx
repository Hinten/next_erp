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

// Render next/link as a plain anchor (no App Router context in the test). Like
// the real Link it runs the caller's onClick and then suppresses the document
// navigation — which jsdom does not implement and would only log noise about.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: unknown;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={typeof href === 'string' ? href : '#'}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

import { notifications } from '@mantine/notifications';
import { showCopyableNotification, showErrorNotification } from './showErrorNotification';

const showSpy = vi.mocked(notifications.show);
const updateSpy = vi.mocked(notifications.update);
const hideSpy = vi.mocked(notifications.hide);

beforeEach(() => {
  showSpy.mockClear();
  updateSpy.mockClear();
  hideSpy.mockClear();
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

describe('showCopyableNotification — link (#852)', () => {
  const link = { href: '/clientes/cli-1', label: 'Abrir cadastro de ACME LTDA' };

  it('renders the link under the message as an anchor with that href and label', () => {
    showErrorNotification({ title: 'IE recusada', message: 'cStat=805: Rejeição', link });
    const arg = showSpy.mock.calls[0]![0]!;
    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);

    const anchor = screen.getByRole('link', { name: 'Abrir cadastro de ACME LTDA' });
    expect(anchor.getAttribute('href')).toBe('/clientes/cli-1');
    // The message and the copy button are still there alongside it.
    expect(screen.getByText('cStat=805: Rejeição')).toBeTruthy();
    expect(screen.getByLabelText('Copiar mensagem')).toBeTruthy();
  });

  it('clicking the link hides the toast by the SAME id notifications.show received', () => {
    showErrorNotification({ title: 'IE recusada', message: 'm', link });
    const arg = showSpy.mock.calls[0]![0]!;
    const id = arg.id!;
    expect(id).toBeTruthy();
    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);

    expect(hideSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: link.label }));
    expect(hideSpy).toHaveBeenCalledOnce();
    expect(hideSpy).toHaveBeenCalledWith(id);
  });

  it('without a link renders no anchor (every existing caller)', () => {
    showErrorNotification({ title: 'Erro', message: 'sem link' });
    showErrorNotification({ title: 'Erro', message: 'link nulo', link: null });
    for (const call of showSpy.mock.calls) {
      const { unmount } = render(
        <MantineTestProvider>{call[0]!.message as React.ReactNode}</MantineTestProvider>,
      );
      expect(screen.queryByRole('link')).toBeNull();
      unmount();
    }
  });

  it('the copied text is still `${title}: ${message}` — the link never enters it', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    showErrorNotification({ title: 'IE recusada', message: 'cStat=805: Rejeição', link });
    const arg = showSpy.mock.calls[0]![0]!;
    render(<MantineTestProvider>{arg.message as React.ReactNode}</MantineTestProvider>);
    fireEvent.click(screen.getByLabelText('Copiar mensagem'));
    expect(writeText).toHaveBeenCalledWith('IE recusada: cStat=805: Rejeição');
  });
});
