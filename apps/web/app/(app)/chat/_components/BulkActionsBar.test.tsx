import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

const { batchSet, batchCommit, notifShow, newDocIdMock } = vi.hoisted(() => ({
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => undefined),
  notifShow: vi.fn(),
  newDocIdMock: vi.fn(() => 'evt-id'),
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'op1', displayName: 'Operador X' } }),
}));
vi.mock('@/lib/data/newDocId', () => ({ newDocId: newDocIdMock }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notifShow } }));

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
  return { ...actual, writeBatch: () => ({ set: batchSet, commit: batchCommit }) };
});

import { BulkActionsBar } from './BulkActionsBar';

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

afterEach(() => {
  vi.clearAllMocks();
  batchCommit.mockImplementation(async () => undefined);
});

describe('BulkActionsBar', () => {
  it('disables Aplicar until an action is chosen', () => {
    wrap(<BulkActionsBar selectedIds={['c1', 'c2']} onApplied={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Aplicar' })).toHaveProperty('disabled', true);
  });

  it('confirms then commits a batch (patch + event per conversa) and notifies success', async () => {
    const onApplied = vi.fn();
    wrap(<BulkActionsBar selectedIds={['c1', 'c2']} onApplied={onApplied} />);

    // Enable an action (set an etiqueta) → Aplicar becomes clickable.
    fireEvent.click(screen.getByLabelText('Alterar etiqueta'));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));

    // The confirm dialog appears; nothing has committed yet.
    expect(screen.getByText('2 conversas foram selecionadas, deseja continuar?')).toBeTruthy();
    expect(batchCommit).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    });

    await waitFor(() => expect(batchCommit).toHaveBeenCalledTimes(1));
    // Per conversa: 1 conversa merge patch + 1 event mensagem = 4 writes total.
    expect(batchSet).toHaveBeenCalledTimes(4);

    // Exact write shapes: the conversa patch carries ONLY the intended keys
    // (converter stripped — no schema-default clobber) and the event mensagem
    // is pipeline-shaped (tipo 'e', estadoEnvio salva, mid null → excluded
    // from the #529 outbound trigger by the tipo clause).
    const payloads = batchSet.mock.calls.map((c) => c[1] as Record<string, unknown>);
    const patches = payloads.filter((p) => !('tipo' in p));
    const events = payloads.filter((p) => 'tipo' in p);
    expect(patches).toHaveLength(2);
    for (const p of patches) {
      expect(Object.keys(p).sort()).toEqual(['cor_etiqueta', 'ultima_modificacao']);
      expect(typeof p.ultima_modificacao).toBe('number');
    }
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.tipo).toBe('e');
      expect(e.estadoEnvio).toBe(1);
      expect(e.mid).toBeNull();
      expect(String(e.conteudo)).toContain('definiu a etiqueta');
      // Legacy `alterarEstadoEmMassa` attached the operator to the bulk events.
      expect(e.user_id).toBe('op1');
      expect(e.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
    }

    expect(notifShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'Alterações aplicadas' }),
    );
    expect(onApplied).toHaveBeenCalled();
  });

  it('chunks selections so no batch exceeds the 500-op ceiling', async () => {
    // 200 conversas × up to 3 ops each = 600 ops → must split across batches.
    const many = Array.from({ length: 200 }, (_, i) => `c${i}`);
    wrap(<BulkActionsBar selectedIds={many} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Alterar etiqueta'));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    });
    await waitFor(() => expect(batchCommit).toHaveBeenCalledTimes(2));
    // 200 patches + 200 events split as 150+150 / 50+50.
    expect(batchSet).toHaveBeenCalledTimes(400);
  });

  it('cancelling the confirm dialog commits nothing', () => {
    wrap(<BulkActionsBar selectedIds={['c1']} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Alterar etiqueta'));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(batchCommit).not.toHaveBeenCalled();
  });
});
