import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Arquivo } from '@delfrance/schemas';
import type { Mensagem } from '@delfrance/schemas';

// Swap the arquivo fetch for a controllable stub (mirrors the TanStack one-shot).
const { useArquivoMock } = vi.hoisted(() => ({
  useArquivoMock: vi.fn(),
}));
vi.mock('../../_hooks/useArquivo', () => ({ useArquivo: useArquivoMock }));

import { MensagemMedia, hasMedia } from './MensagemMedia';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

function arq(partial: Partial<Arquivo>): Arquivo {
  return {
    filetype: 'image',
    filepath: 'chat',
    filename: 'file.bin',
    originalFilename: null,
    contentType: 'image/png',
    url: 'https://example.com/file.png',
    externalIds: [],
    criadoEm: 1,
    resizeState: null,
    uploadState: 'finalized',
    markedForDeletionAt: null,
    ...partial,
  } as Arquivo;
}

const imageMsg = { image: { image: 'documents/arquivos/i1', caption: 'legenda' } } as Mensagem;

afterEach(() => {
  useArquivoMock.mockReset();
});

describe('MensagemMedia', () => {
  it('hasMedia detects sub-objects and legacy anexo_url', () => {
    expect(hasMedia(imageMsg)).toBe(true);
    expect(hasMedia({ anexo_url: 'https://x/y' } as Mensagem)).toBe(true);
    expect(hasMedia({ conteudo: 'só texto' } as Mensagem)).toBe(false);
    // A non-http(s) legacy anexo_url is not renderable media (XSS guard).
    expect(hasMedia({ anexo_url: 'javascript:alert(1)' } as Mensagem)).toBe(false);
  });

  it('shows a loading state while the arquivo resolves', () => {
    useArquivoMock.mockReturnValue({ arquivo: undefined, loading: true });
    wrap(<MensagemMedia mensagem={imageMsg} />);
    expect(screen.getByText('Carregando anexo…')).toBeTruthy();
  });

  it('renders a fallback when the arquivo is missing or has no url', () => {
    useArquivoMock.mockReturnValue({ arquivo: arq({ url: null }), loading: false });
    wrap(<MensagemMedia mensagem={imageMsg} />);
    expect(screen.getByText('Anexo indisponível')).toBeTruthy();
  });

  it('renders an image (with caption) once the arquivo has a url', () => {
    useArquivoMock.mockReturnValue({ arquivo: arq({ filetype: 'image' }), loading: false });
    wrap(<MensagemMedia mensagem={imageMsg} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('https://example.com/file.png');
    expect(screen.getByText('legenda')).toBeTruthy();
  });

  it('renders a document download link for a generic document', () => {
    useArquivoMock.mockReturnValue({
      arquivo: arq({
        filetype: 'document',
        url: 'https://x/doc.pdf',
        originalFilename: 'nota.pdf',
      }),
      loading: false,
    });
    const docMsg = {
      genericDocument: { genericDocument: 'documents/arquivos/d1', caption: null },
    } as Mensagem;
    wrap(<MensagemMedia mensagem={docMsg} />);
    const link = screen.getByText('nota.pdf').closest('a');
    expect(link?.getAttribute('href')).toBe('https://x/doc.pdf');
  });

  it('renders a plain link for a legacy anexo_url with no sub-object', () => {
    // No arquivo fetch is even attempted for a bare URL.
    useArquivoMock.mockReturnValue({ arquivo: undefined, loading: false });
    wrap(<MensagemMedia mensagem={{ anexo_url: 'https://x/legacy.bin' } as Mensagem} />);
    const link = screen.getByText('Anexo').closest('a');
    expect(link?.getAttribute('href')).toBe('https://x/legacy.bin');
  });

  it('drops a non-http(s) legacy anexo_url instead of rendering a link', () => {
    useArquivoMock.mockReturnValue({ arquivo: undefined, loading: false });
    const { container } = wrap(
      <MensagemMedia mensagem={{ anexo_url: 'javascript:alert(1)' } as Mensagem} />,
    );
    expect(screen.queryByText('Anexo')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('highlights matches inside a media caption while searching', () => {
    useArquivoMock.mockReturnValue({ arquivo: arq({ filetype: 'image' }), loading: false });
    wrap(<MensagemMedia mensagem={imageMsg} searchRegex={/legenda/giu} searchActive />);
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent).toBe('legenda');
  });
});
