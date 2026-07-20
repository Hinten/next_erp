import { beforeEach, describe, expect, it, vi } from 'vitest';

const { newDocIdMock } = vi.hoisted(() => ({ newDocIdMock: vi.fn(() => 'evt-id') }));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/newDocId', () => ({ newDocId: newDocIdMock }));
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
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    arrayRemove: (v: unknown) => ({ __arrayRemove: v }),
  };
});

import {
  enterConversa,
  finishConversa,
  includeAtendente,
  leaveConversa,
  renameConversa,
  resolveActor,
  setEtiqueta,
  transferConversa,
} from './conversaActions';

const NOW = 1_720_000_000_000;
const ME = { uid: 'op1', displayName: 'Operador X' };
// The db is only forwarded to the mocked collection handle, so a stub suffices.
const DB = {} as unknown as import('firebase/firestore').Firestore;

/** A fake WriteBatch whose `set` records (ref, payload). */
function fakeBatch() {
  const set = vi.fn();
  return { batch: { set } as unknown as import('firebase/firestore').WriteBatch, set };
}

/** The conversa patch call = the one whose payload has no `tipo` key. */
function patchOf(set: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = set.mock.calls.find((c) => !('tipo' in (c[1] as Record<string, unknown>)));
  return call![1] as Record<string, unknown>;
}

/** Every event mensagem payload (those carrying `tipo`) in call order. */
function eventsOf(set: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return set.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((p) => 'tipo' in p);
}

beforeEach(() => vi.clearAllMocks());

describe('resolveActor', () => {
  it('prefers displayName, then email, then "Operador"', () => {
    expect(resolveActor({ uid: 'u', displayName: 'Ana' })).toEqual({
      uid: 'u',
      displayName: 'Ana',
    });
    expect(resolveActor({ uid: 'u', email: 'a@x.com' })).toEqual({
      uid: 'u',
      displayName: 'a@x.com',
    });
    expect(resolveActor({ uid: 'u' })).toEqual({ uid: 'u', displayName: 'Operador' });
    expect(resolveActor(null)).toBeNull();
    expect(resolveActor({ uid: '' })).toBeNull();
  });
});

describe('enterConversa', () => {
  it('adds the operator (arrayUnion), moves to emResposta, writes the entry event', () => {
    const { batch, set } = fakeBatch();
    enterConversa({ batch, db: DB, conversaId: 'c1', actor: ME, now: NOW });

    const patch = patchOf(set);
    expect(Object.keys(patch).sort()).toEqual(['estadoConversa', 'ultima_modificacao', 'usuarios']);
    expect(patch.usuarios).toEqual({ __arrayUnion: 'op1' });
    expect(patch.estadoConversa).toBe(1);
    expect(patch.ultima_modificacao).toBe(NOW);

    const [evt] = eventsOf(set);
    expect(evt!.tipo).toBe('e');
    expect(evt!.estadoEnvio).toBe(1);
    expect(evt!.mid).toBeNull();
    expect(evt!.conteudo).toBe('Operador X entrou na conversa.');
    // `entrar` is anonymous in legacy (`Mensagem.evento` with no user).
    expect(evt!.user_id).toBeNull();
    expect(evt!.usarioMensagemOuterRef).toBeNull();
  });
});

describe('leaveConversa', () => {
  it('removes the operator (arrayRemove) and keeps estado when others remain', () => {
    const { batch, set } = fakeBatch();
    leaveConversa({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: ['op1', 'op2'],
    });

    const patch = patchOf(set);
    expect(patch.usuarios).toEqual({ __arrayRemove: 'op1' });
    expect('estadoConversa' in patch).toBe(false);
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Operador X saiu da conversa');
    // Always participant-authored → carries the actor's ref (legacy `sairDaConversa`).
    expect(evt.user_id).toBe('op1');
    expect(evt.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
  });

  it('falls back to naoRespondido (0) when no participant remains', () => {
    const { batch, set } = fakeBatch();
    leaveConversa({ batch, db: DB, conversaId: 'c1', actor: ME, now: NOW, usuarios: ['op1'] });
    expect(patchOf(set).estadoConversa).toBe(0);
  });
});

describe('finishConversa', () => {
  it('a participant: removes them, closes, writes the named event', () => {
    const { batch, set } = fakeBatch();
    finishConversa({ batch, db: DB, conversaId: 'c1', actor: ME, now: NOW, usuarios: ['op1'] });

    const patch = patchOf(set);
    expect(patch.estadoConversa).toBe(2);
    expect(patch.usuarios).toEqual({ __arrayRemove: 'op1' });
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Operador X encerrou a conversa');
    expect(evt.user_id).toBe('op1');
    expect(evt.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
  });

  it('a non-participant: closes without touching usuarios, writes the system event', () => {
    const { batch, set } = fakeBatch();
    finishConversa({ batch, db: DB, conversaId: 'c1', actor: ME, now: NOW, usuarios: ['other'] });

    const patch = patchOf(set);
    expect(patch.estadoConversa).toBe(2);
    expect('usuarios' in patch).toBe(false);
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Conversa encerrada');
    // System close → anonymous.
    expect(evt.user_id).toBeNull();
    expect(evt.usarioMensagemOuterRef).toBeNull();
  });
});

describe('transferConversa', () => {
  const TARGET = { uid: 'op2', displayName: 'Bruno' };

  it('computes usuarios (remove me, add target), emResposta, saiu + entrou events', () => {
    const { batch, set } = fakeBatch();
    transferConversa({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: ['op1', 'op3'],
      target: TARGET,
    });

    const patch = patchOf(set);
    expect(patch.usuarios).toEqual(['op3', 'op2']);
    expect(patch.estadoConversa).toBe(1);
    const events = eventsOf(set);
    expect(events.map((e) => e.conteudo)).toEqual([
      'Operador X saiu da conversa',
      'Bruno entrou na conversa.',
    ]);
    // The "saiu" leg is participant-authored (carries the actor); the target
    // "entrou" leg (the `incluir` leg) is anonymous, matching legacy.
    expect(events[0]!.user_id).toBe('op1');
    expect(events[0]!.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
    expect(events[1]!.user_id).toBeNull();
    expect(events[1]!.usarioMensagemOuterRef).toBeNull();
  });

  it('omits the "saiu" event when the operator was not a participant', () => {
    const { batch, set } = fakeBatch();
    transferConversa({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: ['op3'],
      target: TARGET,
    });
    expect(patchOf(set).usuarios).toEqual(['op3', 'op2']);
    const events = eventsOf(set);
    expect(events.map((e) => e.conteudo)).toEqual(['Bruno entrou na conversa.']);
    expect(events[0]!.user_id).toBeNull();
    expect(events[0]!.usarioMensagemOuterRef).toBeNull();
  });
});

describe('includeAtendente', () => {
  it('adds the target (arrayUnion), emResposta, target-authored entry event', () => {
    const { batch, set } = fakeBatch();
    includeAtendente({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      target: { uid: 'op2', displayName: 'Bruno' },
    });

    const patch = patchOf(set);
    expect(patch.usuarios).toEqual({ __arrayUnion: 'op2' });
    expect(patch.estadoConversa).toBe(1);
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Bruno entrou na conversa.');
    // `incluir` is anonymous in legacy (no user passed to `Mensagem.evento`).
    expect(evt.user_id).toBeNull();
    expect(evt.usarioMensagemOuterRef).toBeNull();
  });
});

describe('renameConversa', () => {
  it('a participant: sets nome, writes the user-authored rename event', () => {
    const { batch, set } = fakeBatch();
    renameConversa({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: ['op1'],
      oldNome: 'Antigo',
      newNome: 'Novo',
    });
    expect(patchOf(set).nome).toBe('Novo');
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Operador X renomeou a conversa de Antigo para Novo');
    expect(evt.user_id).toBe('op1');
    expect(evt.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
  });

  it('a non-participant: writes the system rename event', () => {
    const { batch, set } = fakeBatch();
    renameConversa({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: [],
      oldNome: 'Antigo',
      newNome: 'Novo',
    });
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Conversa renomeada de Antigo para Novo');
    expect(evt.user_id).toBeNull();
    expect(evt.usarioMensagemOuterRef).toBeNull();
  });
});

describe('setEtiqueta', () => {
  it('a participant: sets cor_etiqueta, writes the user-authored colour event', () => {
    const { batch, set } = fakeBatch();
    setEtiqueta({
      batch,
      db: DB,
      conversaId: 'c1',
      actor: ME,
      now: NOW,
      usuarios: ['op1'],
      cor: 4294198070,
    });
    expect(patchOf(set).cor_etiqueta).toBe(4294198070);
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Operador X alterou a cor da conversa');
    expect(evt.user_id).toBe('op1');
    expect(evt.usarioMensagemOuterRef).toBe('documents/usuarios/op1');
  });

  it('clears the etiqueta with null and writes the system colour event for a non-participant', () => {
    const { batch, set } = fakeBatch();
    setEtiqueta({ batch, db: DB, conversaId: 'c1', actor: ME, now: NOW, usuarios: [], cor: null });
    expect(patchOf(set).cor_etiqueta).toBeNull();
    const evt = eventsOf(set)[0]!;
    expect(evt.conteudo).toBe('Cor da conversa alterada');
    expect(evt.user_id).toBeNull();
    expect(evt.usarioMensagemOuterRef).toBeNull();
  });
});
