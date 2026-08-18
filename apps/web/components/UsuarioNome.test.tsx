import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

// `useUsuarioNomes` pulls in the auth claims, the usuarios handle and the
// Firestore client at module scope; this suite is about the tri-state RENDER
// and the ref parser, both of which take their data as props.
vi.mock('@/lib/auth', () => ({ usePermission: () => true }));
vi.mock('@/lib/data/usuarioCollection', () => ({
  usuarioCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('firebase/firestore', () => ({ getDoc: vi.fn() }));

import { UsuarioNome, uidFromUsuarioRef } from './UsuarioNome';

function renderNome(outerRef: string | null | undefined, nomes: Record<string, string> = {}) {
  return render(
    <MantineProvider env="test">
      <UsuarioNome outerRef={outerRef} nomes={nomes} />
    </MantineProvider>,
  );
}

describe('uidFromUsuarioRef', () => {
  it('extracts the uid from the canonical outer-ref', () => {
    expect(uidFromUsuarioRef('documents/usuarios/abc123')).toBe('abc123');
  });

  it('returns null for null, undefined and a non-usuarios ref', () => {
    expect(uidFromUsuarioRef(null)).toBeNull();
    expect(uidFromUsuarioRef(undefined)).toBeNull();
    expect(uidFromUsuarioRef('documents/produtos/p1')).toBeNull();
    expect(uidFromUsuarioRef('abc123')).toBeNull();
  });
});

describe('UsuarioNome — the three states stay distinct', () => {
  it('renders an em-dash when the field is ABSENT (row predates attribution)', () => {
    renderNome(undefined);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Sistema')).toBeNull();
  });

  it('renders "Sistema" for an explicit null (an Admin-SDK write)', () => {
    // The distinction matters: a legacy row must NOT claim to be a system write.
    renderNome(null);
    expect(screen.getByText('Sistema')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('renders the resolved name when the uid is known', () => {
    renderNome('documents/usuarios/abc123', { abc123: 'Lucas' });
    expect(screen.getByText('Lucas')).toBeTruthy();
  });

  it('falls back to a short uid when the name is unresolved (in flight, or no permission)', () => {
    // Must NOT be blank and must NOT read "Sistema" — the actor IS known, only
    // the name lookup is unavailable.
    renderNome('documents/usuarios/abcdefghijklmnop');
    expect(screen.getByText('Usuário abcdefgh')).toBeTruthy();
  });
});
