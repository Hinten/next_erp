import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
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
      <MantineTestProvider>{node}</MantineTestProvider>
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
  /**
   * A webchat thread. ⚠️ NOT an ML one: all three ML surfaces gained a sender
   * (#533, #768), and this fixture has to be an origem that genuinely has none
   * — the inert-fixture trap #813 named, hit three times in this stack.
   */
  const conversaMlClaims: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'site',
    nome: 'Visitante',
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
          origem: 'site',
          nome: 'Visitante',
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

/**
 * The confirm button's visible label, hardcoded rather than imported from
 * `confirmacaoEnvio.ts`.
 *
 * Importing it would make every test below pass through whatever the constant
 * happens to say, including "Enviar" — and a confirm button wearing the same
 * word as the affordance that opened it is dismissed by muscle memory, which is
 * the failure the dialog exists to prevent. Pinning the literal here means a
 * copy change has to be read by a human once.
 */
const CONFIRMAR_PERGUNTA = 'Responder e encerrar';

describe('ChatComposer — Mercado Livre replies leave through the route (#533)', () => {
  /** A pergunta thread the operator is already answering. */
  const conversaPergunta: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'mlperg',
    nome: 'Comprador',
    integracaoOuterRef: 'documents/integracao/conta1',
  });

  /**
   * Type and click Enviar — WITHOUT answering the pergunta confirmation.
   *
   * Kept separate from `typeAndSend` on purpose: the tests that assert the send
   * is refused before it ever reaches Mercado Livre must be able to observe that
   * no dialog appeared at all.
   */
  function typeAndClickSend(texto: string) {
    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: texto },
    });
    return act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });
  }

  async function typeAndSend(texto: string) {
    await typeAndClickSend(texto);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CONFIRMAR_PERGUNTA }));
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

    await typeAndClickSend('oi');

    expect(responderConversa).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/não resolvida para esta conversa/)).toBeTruthy());
    // ...and the operator was never asked to confirm a send that could not
    // happen. The confirmation gate sits AFTER this guard deliberately: a
    // dialog here would ask someone to authorise an irreversible act, then
    // refuse it anyway.
    expect(screen.queryByRole('button', { name: CONFIRMAR_PERGUNTA })).toBeNull();
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

describe('ChatComposer — claim replies leave through the route too (#768)', () => {
  /**
   * ⚠️ The regression this file exists to stop repeating. #768 gave mlclaims a
   * backend route and set ORIGEM_RULES.mlclaims.temEnvio = true, but the
   * composer kept a hand-written ORIGENS_ROTA set that listed only the two
   * #533 surfaces. So enviaPorRota was false, handleSend took the Firestore
   * branch, and every claim reply landed estadoEnvio: 'salva' — a state only
   * WhatsApp's sendOutbound trigger consumes. Nothing failed; the replies just
   * never left. The commit that introduced it is titled "reply and resolve ML
   * claims from the inbox".
   */
  const conversaClaim: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'mlclaims',
    nome: 'Comprador',
    integracaoOuterRef: 'documents/integracao/conta1',
  });

  it('calls the channel backend and writes NOTHING to Firestore', async () => {
    // ⚠️ BOTH halves are load-bearing. Asserting only the route call would pass
    // against a composer that ALSO wrote the mensagem — i.e. green while the
    // thread grows a phantom bubble ML never received.
    wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaClaim}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'Enviamos a etiqueta de devolução.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    expect(responderConversa).toHaveBeenCalledWith({
      integracaoId: 'conta1',
      conversaId: 'c1',
      texto: 'Enviamos a etiqueta de devolução.',
    });
    expect(setDocMock).not.toHaveBeenCalled();
    expect(batchCommit).not.toHaveBeenCalled();
    // ...and it went in ONE click. A claim thread stays open after a reply, so
    // it gets no confirmation — the negative control for the pergunta gate.
    expect(screen.queryByRole('button', { name: CONFIRMAR_PERGUNTA })).toBeNull();
  });

  it('hides the paperclip, because the responder route sends text only', async () => {
    // ORIGEM_RULES.mlclaims allows 3 attachments — that is what ML accepts on
    // the claim endpoint, not what this composer can deliver. While the origem
    // was mis-classified the paperclip was ENABLED here, so a staged file was
    // written as a mensagem and silently dropped. uploadClaimAttachment has no
    // caller anywhere, so there was never a path that sent it.
    const { container } = wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaClaim}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('ChatComposer — answering a pergunta is confirmed first', () => {
  /**
   * A Mercado Livre question takes exactly ONE answer. `POST /answers` publishes
   * it on the anúncio with no edit and no retract, and the server then merges
   * `respostaBloqueada` + `atendido: true`, which turns the composer read-only on
   * the next snapshot. One click used to end the atendimento with no warning.
   */
  const conversaPergunta: Conversa = conversaSchema.parse({
    usuarios: ['op1'],
    estadoConversa: 1,
    origem: 'mlperg',
    nome: 'Comprador',
    integracaoOuterRef: 'documents/integracao/conta1',
  });

  function mountPergunta() {
    return wrap(
      <ChatComposer
        conversaId="c1"
        conversa={conversaPergunta}
        addOptimistic={vi.fn()}
        markOptimisticError={vi.fn()}
      />,
    );
  }

  function typeReply(texto: string) {
    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: texto },
    });
  }

  it('opens the dialog and sends NOTHING until it is confirmed', async () => {
    // ⚠️ The second assertion is the one that matters. A dialog that renders
    // while the send already left would be decoration, not a gate.
    mountPergunta();
    typeReply('Temos sim, envio hoje!');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    expect(screen.getByRole('button', { name: CONFIRMAR_PERGUNTA })).toBeTruthy();
    expect(responderConversa).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CONFIRMAR_PERGUNTA }));
    });

    expect(responderConversa).toHaveBeenCalledWith({
      integracaoId: 'conta1',
      conversaId: 'c1',
      texto: 'Temos sim, envio hoje!',
    });
  });

  it('shows the reply back, and says what confirming costs', async () => {
    // The text is about to become public and permanent; this is the last moment
    // it is still private. Showing the warning without the body would ask the
    // operator to authorise something they can no longer see.
    mountPergunta();
    typeReply('Sim, temos em estoque.');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    // ⚠️ Scoped to the dialog, not the document. The textarea still holds the
    // same string, so an unscoped `getByText` matches twice and would keep
    // passing against a dialog that showed no preview at all.
    const dialogo = within(screen.getByRole('dialog'));
    expect(dialogo.getByText('Sim, temos em estoque.')).toBeTruthy();
    expect(dialogo.getByText(/UMA resposta/)).toBeTruthy();
    expect(dialogo.getByText(/não pode ser desfeita/)).toBeTruthy();
  });

  it('cancelling sends nothing and KEEPS the operator text', async () => {
    // Cancelling has to be free, or operators stop using it. Nothing left the
    // app, nothing was written, and the draft is exactly where they left it —
    // `setText('')` runs only after a successful send.
    mountPergunta();
    typeReply('quase pronto…');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });

    expect(responderConversa).not.toHaveBeenCalled();
    expect(setDocMock).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Digite uma mensagem/)).toHaveProperty(
      'value',
      'quase pronto…',
    );
    // ...and the composer is usable again, not stuck disabled by the `sending`
    // flag the aborted send set on its way in.
    expect(screen.getByLabelText('Enviar')).not.toHaveProperty('disabled', true);
  });

  it('gates the KEYBOARD send too, not just the button', async () => {
    // ⚠️ The path most likely to be missed, and the more dangerous of the two:
    // with the send-key preference on plain Enter, a question is answered by
    // reflex. The gate lives inside `handleSend`, which both paths call — a
    // guard hung on the button's onClick would have left this one open.
    mountPergunta();
    const textarea = screen.getByPlaceholderText(/Digite uma mensagem/);
    typeReply('respondendo pelo teclado');

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    expect(responderConversa).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: CONFIRMAR_PERGUNTA })).toBeTruthy();
  });

  it('does not gate a post-sale message, which leaves the thread open', async () => {
    // The scope is mlperg, and this is what proves it is a scope rather than an
    // accident of which origem the other tests happened to use. `mlped` takes
    // the same single-shot route but stays answerable, so confirming here would
    // be fatigue that teaches operators to click through the dialog above.
    wrap(
      <ChatComposer
        conversaId="c9"
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
    typeReply('Seu pedido saiu para entrega.');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    expect(screen.queryByRole('button', { name: CONFIRMAR_PERGUNTA })).toBeNull();
    expect(responderConversa).toHaveBeenCalledWith({
      integracaoId: 'conta1',
      conversaId: 'c9',
      texto: 'Seu pedido saiu para entrega.',
    });
  });
});
