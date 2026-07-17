import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import { ESTADO_ENVIO, type Mensagem } from '@delfrance/schemas';

// Hoisted, mutable state + spies so each test can swap what the mocked hooks
// return / assert on calls before rendering. Mirrors
// apps/web/app/(app)/pedidos/_components/PedidoCells.test.tsx.
const { snapState, setDocMock, docRefMock } = vi.hoisted(() => ({
  snapState: {
    current: { data: undefined, loading: true, error: undefined } as SnapshotState<
      SnapshotRow<Mensagem>[]
    >,
  },
  setDocMock: vi.fn(async (_ref: unknown, _data: unknown) => undefined),
  docRefMock: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ __docRef: id })),
}));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'operator-1' } }),
}));

// Doc id is minted client-side (#529 contract: the write must land under this
// exact id so the optimistic entry + server snapshot reconcile by doc id).
vi.mock('@/lib/data/newDocId', () => ({
  newDocId: () => 'minted-doc-id',
}));

vi.mock('@/lib/data/conversaCollection', () => ({
  mensagemCollection: {
    ref: () => ({ __colRef: true }),
    docRef: docRefMock,
  },
}));

vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshot: () => snapState.current };
});

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, setDoc: setDocMock };
});

import { MensagemThread } from './MensagemThread';

function row(id: string, data: Mensagem): SnapshotRow<Mensagem> {
  return { id, path: `chat/c1/mensagem/${id}`, data };
}

function setSnap(state: Partial<SnapshotState<SnapshotRow<Mensagem>[]>>) {
  snapState.current = { data: undefined, loading: false, error: undefined, ...state };
}

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

const baseMensagem: Mensagem = {
  estadoEnvio: ESTADO_ENVIO.salva,
  tipo: 'c',
  conteudo: 'oi',
  resposta: null,
  canal: 0,
  usarioMensagemOuterRef: null,
  user_id: 'operator-1',
  urlAvatar: null,
  mid: null,
  midGroup: null,
  error: null,
  visualizado: null,
  transcription: null,
  anexo: null,
  anexo_url: null,
  timestamp: Date.parse('2026-07-15T12:00:00.000Z'),
};

afterEach(() => {
  snapState.current = { data: undefined, loading: true, error: undefined };
  setDocMock.mockClear();
  setDocMock.mockImplementation(async () => undefined);
  docRefMock.mockClear();
});

describe('MensagemThread', () => {
  it('shows the empty state when there are no messages', () => {
    setSnap({ data: [] });
    wrap(<MensagemThread conversaId="c1" />);
    expect(screen.getByText('Sem mensagens nesta conversa.')).toBeTruthy();
  });

  it('sends a reply with a pre-minted doc id and mid: null (#529 outbound contract)', async () => {
    setSnap({ data: [] });
    wrap(<MensagemThread conversaId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'Olá cliente' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    // The write must go through `setDoc` against the pre-minted doc id
    // (docRef), not `addDoc` — and must carry `mid: null` so the whatsapp
    // app's `sendOutbound` trigger (apps/whatsapp/lib/whatsapp/outbound.ts)
    // picks the message up instead of skipping it.
    expect(docRefMock).toHaveBeenCalledWith(
      expect.anything(),
      { conversaId: 'c1' },
      'minted-doc-id',
    );
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [, payload] = setDocMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      mid: null,
      conteudo: 'Olá cliente',
      estadoEnvio: ESTADO_ENVIO.salva,
    });
  });

  it('renders the optimistic reply immediately, keyed by the pre-minted doc id', () => {
    setSnap({ data: [] });
    wrap(<MensagemThread conversaId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'Enviando agora' },
    });
    // Don't await the click — inspect the optimistic render before the
    // (mocked) setDoc promise resolves.
    fireEvent.click(screen.getByLabelText('Enviar'));

    expect(screen.getByText('Enviando agora')).toBeTruthy();
  });

  it('reconciles the optimistic entry by doc id once the server snapshot includes it', () => {
    setSnap({ data: [row('minted-doc-id', baseMensagem)] });
    wrap(<MensagemThread conversaId="c1" />);

    // The server row for the pre-minted id renders exactly once — no
    // duplicate optimistic bubble left over from a stale `mid` comparison.
    expect(screen.getAllByText('oi')).toHaveLength(1);
  });

  it('prunes a reconciled optimistic entry so it never resurrects when its server row ages out', async () => {
    setSnap({ data: [] });
    const { rerender } = wrap(<MensagemThread conversaId="c1" />);
    const remount = () =>
      rerender(
        <MantineProvider env="test">
          <MensagemThread conversaId="c1" />
        </MantineProvider>,
      );

    // 1. Send → the optimistic bubble shows immediately.
    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'Olá cliente' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });
    expect(screen.getByText('Olá cliente')).toBeTruthy();

    // 2. Server snapshot now includes the pre-minted id → reconciled AND pruned.
    setSnap({ data: [row('minted-doc-id', { ...baseMensagem, conteudo: 'Olá cliente' })] });
    await act(async () => {
      remount();
    });
    expect(screen.getAllByText('Olá cliente')).toHaveLength(1);

    // 3. That row ages out of the 200-doc window (server data no longer has it).
    //    Pre-fix the optimistic ghost resurrected here; now it stays pruned.
    setSnap({ data: [] });
    await act(async () => {
      remount();
    });
    expect(screen.queryByText('Olá cliente')).toBeNull();
  });

  it('flips the optimistic entry to erro and surfaces the FirebaseError message', async () => {
    setDocMock.mockImplementation(async () => {
      throw new FirebaseError('permission-denied', 'Permissão negada');
    });
    setSnap({ data: [] });
    wrap(<MensagemThread conversaId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(/Digite uma mensagem/), {
      target: { value: 'Vai falhar' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enviar'));
    });

    expect(screen.getByText('Permissão negada')).toBeTruthy();
    expect(screen.getByText('Erro')).toBeTruthy(); // ESTADO_ENVIO_LABELS[erro] badge
  });
});
