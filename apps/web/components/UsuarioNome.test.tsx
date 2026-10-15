import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineTestProvider } from '@/lib/testing/mantine';

// `useUsuarioNomes` pulls in the auth claims, the usuarios handle and the
// Firestore client at module scope; the render suite below is about the
// tri-state RENDER and the ref parser, both of which take their data as props.
//
// ⚠️ `usePermission` returns `{ allowed, loading }`. This mock used to answer a
// bare `true`, which typechecked nowhere and made the hook's `enabled` gate
// unfalsifiable — see the comment in `useUsuarioNomes`.
let permitido = true;
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: permitido, loading: false }) }));
vi.mock('@/lib/data/usuarioCollection', () => ({
  usuarioCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('firebase/firestore', () => ({ getDoc: vi.fn() }));

import { getDoc } from 'firebase/firestore';
import { UsuarioNome, uidFromUsuarioRef, useUsuarioNomes } from './UsuarioNome';

function renderNome(outerRef: string | null | undefined, nomes: Record<string, string> = {}) {
  return render(
    <MantineTestProvider>
      <UsuarioNome outerRef={outerRef} nomes={nomes} />
    </MantineTestProvider>,
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

describe('useUsuarioNomes — the permission gate has to actually reject', () => {
  function Host({ uids }: { uids: string[] }) {
    const nomes = useUsuarioNomes(uids);
    return <span data-testid="nomes">{JSON.stringify(nomes)}</span>;
  }

  function renderHook(uids: string[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MantineTestProvider>
          <Host uids={uids} />
        </MantineTestProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    vi.mocked(getDoc).mockReset();
    vi.mocked(getDoc).mockResolvedValue({ data: () => ({ nome: 'Lucas' }) } as never);
    permitido = true;
  });

  it('reads the names when the reader holds configuracoes.read', async () => {
    renderHook(['abc123']);
    await waitFor(() => expect(screen.getByTestId('nomes').textContent).toContain('Lucas'));
    expect(vi.mocked(getDoc)).toHaveBeenCalledTimes(1);
  });

  // The anchored negative: without the bit the hook must issue NO read at all.
  // A 50-row feed firing 50 permission-denied gets still LOOKS right on screen —
  // the errored query leaves `data` undefined and every row falls back to its
  // uid — so only the call count can tell the two apart.
  it('issues no read at all when the reader lacks it', async () => {
    permitido = false;
    renderHook(['abc123']);
    await waitFor(() => expect(screen.getByTestId('nomes').textContent).toBe('{}'));
    expect(vi.mocked(getDoc)).not.toHaveBeenCalled();
  });

  it('issues no read for an empty uid list', async () => {
    renderHook([]);
    await waitFor(() => expect(screen.getByTestId('nomes').textContent).toBe('{}'));
    expect(vi.mocked(getDoc)).not.toHaveBeenCalled();
  });
});
