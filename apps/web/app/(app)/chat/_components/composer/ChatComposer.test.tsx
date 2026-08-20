import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { conversaSchema, type Conversa } from '@delfrance/schemas';

const { batchSet, batchCommit, newDocIdMock, uploadFileMock, setDocMock, responderConversa } =
  vi.hoisted(() => ({
    batchSet: vi.fn(),
    batchCommit: vi.fn(async () => undefined),
    newDocIdMock: vi.fn(() => 'evt-id'),
    uploadFileMock: vi.fn(),
    setDocMock: vi.fn(async () => undefined),
    responderConversa: vi.fn(),
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
    setDoc: setDocMock,
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  };
});

// Keep the real error CLASSES (the composer narrows on them) and stub only the
// hook, so a route refusal can be driven with a genuine instance.
vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => ({ responderConversa }) };
});

import { StorageUploadError } from '@delfrance/storage';
import { MercadoLivreClientHttpError } from '@/lib/mercado-livre/client';
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
  setDocMock.mockImplementation(async () => undefined);
  responderConversa.mockResolvedValue({
    conversaId: 'c1',
    mensagemId: 'm1',
    respostaBloqueada: null,
  });
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

  it('disables sending when a restored draft exceeds the origem character limit', () => {
    // The Textarea's maxLength blocks typing past the limit, but a restored
    // draft can exceed it — canSend must gate on overLimit too (Copilot #584).
    window.localStorage.setItem('chat:draft:c-over', 'x'.repeat(2001)); // whatsapp cap: 2000
    try {
      wrap(
        <ChatComposer
          conversaId="c-over"
          conversa={conversaFull}
          addOptimistic={vi.fn()}
          markOptimisticError={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Enviar')).toHaveProperty('disabled', true);
    } finally {
      window.localStorage.removeItem('chat:draft:c-over');
    }
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

describe('ChatComposer — send capability (#817)', () => {
  /** An ML claim thread: the inbox surface a buyer expects an answer on. */
  const conversaMlClaims: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'mlclaims',
    nome: 'Reclamação',
  });

  it('renders a read-only notice instead of the input on a channel with no sender', () => {
    // The reported bug: this rendered a fully enabled composer, the operator
    // typed a reply, it appeared in the thread, and Mercado Livre never received
    // it — no error, no hint, while ML's SLA clock ran.
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaMlClaims}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(screen.getByTestId('composer-somente-leitura')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/mensagem/i)).toBeNull();
  });

  it('offers no "Entrar na conversa" escape hatch either', () => {
    // That button flips estadoConversa to emResposta, which would land the
    // operator on a full composer — the same bug behind one extra click.
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaSchema.parse({
          usuarios: [],
          estadoConversa: 2,
          origem: 'mlclaims',
          nome: 'Reclamação',
        })}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(screen.getByTestId('composer-somente-leitura')).toBeTruthy();
    expect(screen.queryByText('Entrar na conversa')).toBeNull();
  });

  it('shows the channel-supplied reason verbatim for a blocked thread', () => {
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaSchema.parse({
          usuarios: ['op1'],
          estadoConversa: 1,
          origem: 'whatsapp',
          nome: 'Cliente',
          respostaBloqueada: 'Prazo de resposta encerrado',
        })}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(screen.getByText('Prazo de resposta encerrado')).toBeTruthy();
  });

  it('leaves WhatsApp untouched — the composer still renders', () => {
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaFull}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('composer-somente-leitura')).toBeNull();
  });
});

describe('ChatComposer — Mercado Livre replies leave through the route (#533)', () => {
  /** A pergunta thread the operator is already answering. */
  const conversaPergunta: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'mlperg',
    nome: 'Comprador',
    integracaoOuterRef: 'documents/integracao/conta1',
  });

  function typeAndSend(texto: string) {
    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: texto },
    });
    return act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });
  }

  it('calls the channel backend and writes NOTHING to Firestore', async () => {
    // ⚠️ The whole point of the route. A local mensagem written first would sit
    // in the thread claiming a send ML may still refuse — #817 inverted. The
    // server writes the bubble only after ML accepts.
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaPergunta}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    await typeAndSend('Temos sim, envio hoje!');

    expect(responderConversa).toHaveBeenCalledWith({
      integracaoId: 'conta1',
      conversaId: 'c1',
      texto: 'Temos sim, envio hoje!',
    });
    expect(setDocMock).not.toHaveBeenCalled();
    expect(batchCommit).not.toHaveBeenCalled();
  });

  it('shows the route refusal verbatim and KEEPS the operator text', async () => {
    // A 409 is recoverable information, not a dead end: the reason is the only
    // thing telling the operator what to do next, and losing their draft on top
    // of it would make the failure twice as expensive.
    responderConversa.mockRejectedValue(
      new MercadoLivreClientHttpError('Pergunta já respondida no Mercado Livre', 409, null),
    );
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaPergunta}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    await typeAndSend('oi');

    await waitFor(() =>
      expect(screen.getByText('Pergunta já respondida no Mercado Livre')).toBeTruthy(),
    );
    expect(screen.getByPlaceholderText(/Digite uma mensagem/)).toHaveProperty('value', 'oi');
  });

  it('refuses to send when the conversa names no integração', async () => {
    // Without it there is no account to transmit through, and silently doing
    // nothing here would reproduce #817 exactly.
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaSchema.parse({
          usuarios: ['op1'],
          estadoConversa: 1,
          origem: 'mlperg',
          nome: 'Comprador',
        })}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    await typeAndSend('oi');

    expect(responderConversa).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/não resolvida para esta conversa/)).toBeTruthy());
  });

  it('hides the paperclip on mlped, whose CHANNEL does accept a file', async () => {
    // ORIGEM_RULES.mlped.permiteAnexo is true — that states what Mercado Livre
    // takes, not what this composer can deliver. The route sends text only, so
    // an enabled paperclip would let an operator stage a file that handleSend
    // then drops without a word.
    const { container } = wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaSchema.parse({
          usuarios: ['op1'],
          estadoConversa: 1,
          origem: 'mlped',
          nome: 'Comprador',
          integracaoOuterRef: 'documents/integracao/conta1',
        })}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    expect(container.querySelector('input[type="file"]')).toBeNull();
    // ...while WhatsApp, which shares permiteAnexo: true, still has one.
    const wa = wrap(
      <ChatComposer
        conversaId="c2"
        conversa={conversaFull}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(wa.container.querySelector('input[type="file"]')).not.toBeNull();
  });
});
