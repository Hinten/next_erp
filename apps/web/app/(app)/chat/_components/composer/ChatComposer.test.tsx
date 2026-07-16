import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { conversaSchema, type Conversa } from '@delfrance/schemas';

const { batchSet, batchCommit, newDocIdMock, uploadFileMock } = vi.hoisted(() => ({
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => undefined),
  newDocIdMock: vi.fn(() => 'evt-id'),
  uploadFileMock: vi.fn(),
}));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
  getFirebaseStorage: () => ({}),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'op1', displayName: 'Operador X' } }),
}));
vi.mock('@/lib/data/newDocId', () => ({ newDocId: newDocIdMock }));

// Keep the real StorageUploadError class (the composer narrows on it) but stub
// the upload itself so the tests drive success / failure deterministically.
vi.mock('@delfrance/storage', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/storage')>();
  return { ...actual, uploadFile: uploadFileMock };
});

vi.mock('@/lib/data/conversaCollection', () => ({
  conversaCollection: {
    docRef: () => ({ withConverter: () => ({ __convRefNoConverter: true }) }),
  },
  mensagemCollection: {
    docRef: (_db: unknown, ctx: { conversaId: string }, id: string) => ({
      __msgRef: `${ctx.conversaId}/${id}`,
    }),
  },
}));

vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return {
    ...actual,
    writeBatch: () => ({ set: batchSet, commit: batchCommit }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  };
});

import { StorageUploadError } from '@delfrance/storage';
import { ChatComposer } from './ChatComposer';

// gate === 'enter': the operator is not yet a participant (usuarios empty).
const conversaEnter: Conversa = conversaSchema.parse({
  usuarios: [],
  estadoConversa: 1,
  origem: 'whatsapp',
  nome: 'Cliente',
});

// gate === 'compose': op1 is a participant of an emResposta conversa → full input.
const conversaFull: Conversa = conversaSchema.parse({
  usuarios: ['op1'],
  estadoConversa: 1,
  origem: 'whatsapp',
  nome: 'Cliente',
});

/** Drive a file through the hidden FileButton input (Mantine reads `files`). */
function selectFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">{node}</MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  batchCommit.mockImplementation(async () => undefined);
});

describe('ChatComposer — attachment upload + audio caption hint', () => {
  it('flags an attachment as errored when the upload rejects (StorageUploadError)', async () => {
    uploadFileMock.mockRejectedValueOnce(new StorageUploadError('Falha no upload do arquivo'));
    const { container } = wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaFull}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    selectFile(container, new File(['x'], 'foto.jpg', { type: 'image/jpeg' }));

    // The narrowed catch (StorageUploadError | FirebaseError) surfaces the error
    // on the chip instead of throwing.
    await waitFor(() => expect(screen.getByText('Falha no upload do arquivo')).toBeTruthy());
  });

  it('hints that an audio caption is dropped once audio + text coexist', async () => {
    uploadFileMock.mockResolvedValueOnce({ id: 'a1', arquivo: { filetype: 'audio' } });
    const { container } = wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaFull}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    // Type a caption, then attach an audio file.
    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'legenda de teste' },
    });
    selectFile(container, new File(['x'], 'audio.ogg', { type: 'audio/ogg' }));

    await waitFor(() =>
      expect(screen.getByText(/Áudio não leva legenda no WhatsApp/)).toBeTruthy(),
    );
  });
});

describe('ChatComposer — "Entrar na conversa" gate', () => {
  it('shows the join button when the operator is not a participant', () => {
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaEnter}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Entrar na conversa/ })).toBeTruthy();
    // The full composer input is not rendered in this state.
    expect(screen.queryByPlaceholderText(/Digite uma mensagem/)).toBeNull();
  });

  it('joins with a raw conversa patch + an entry event mensagem', async () => {
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaEnter}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Entrar na conversa/ }));
    });

    await waitFor(() => expect(batchCommit).toHaveBeenCalledTimes(1));
    // Two writes: the conversa patch + the entry event mensagem.
    expect(batchSet).toHaveBeenCalledTimes(2);

    const payloads = batchSet.mock.calls.map((c) => c[1] as Record<string, unknown>);
    const patch = payloads.find((p) => !('tipo' in p))!;
    const event = payloads.find((p) => 'tipo' in p)!;

    // Raw patch: only the intended keys (converter stripped — no default clobber),
    // usuarios via arrayUnion, estado → emResposta (1), a bumped ultima_modificacao.
    expect(Object.keys(patch).sort()).toEqual(['estadoConversa', 'ultima_modificacao', 'usuarios']);
    expect(patch.estadoConversa).toBe(1);
    expect(patch.usuarios).toEqual({ __arrayUnion: 'op1' });
    expect(typeof patch.ultima_modificacao).toBe('number');

    // Entry event — writeEvent shape (excluded from the #529 sender by tipo 'e').
    expect(event.tipo).toBe('e');
    expect(event.estadoEnvio).toBe(1);
    expect(event.mid).toBeNull();
    expect(event.conteudo).toBe('Operador X entrou na conversa.');
  });
});
