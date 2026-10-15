import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import { MantineTestProvider } from '@/lib/testing/mantine';

// The deref is exercised by its own suite; here it only has to turn the
// canonical outer-ref into an id without touching a real Firestore.
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) => {
    if (typeof ref !== 'string') return null;
    const segs = ref.split('/').filter(Boolean);
    return segs.length >= 2 ? { id: segs[segs.length - 1] } : null;
  },
}));

// Seam: what the component ASKS to resolve is the observable that says whether
// it fired a `usuarios` read at all.
const useUsuarioNomes = vi.fn<(uids: ReadonlyArray<string>) => Record<string, string>>(() => ({}));
vi.mock('@/components/UsuarioNome', () => ({
  useUsuarioNomes: (uids: ReadonlyArray<string>) => useUsuarioNomes(uids),
}));

let usuarioAtual: { uid: string; email: string | null } | null = null;
vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: usuarioAtual, loading: false }) }));

// Import AFTER the mocks are registered.
import { VendedorField } from './VendedorField';

function renderCampo(outerRef: unknown) {
  render(
    <MantineTestProvider>
      <VendedorField db={{} as Firestore} outerRef={outerRef} />
    </MantineTestProvider>,
  );
  return screen.getByLabelText('Vendedor') as HTMLInputElement;
}

beforeEach(() => {
  useUsuarioNomes.mockReset();
  useUsuarioNomes.mockReturnValue({});
  usuarioAtual = { uid: 'meu-uid', email: 'eu@delfrance.com' };
});

describe('VendedorField', () => {
  it('renders an em-dash when the pedido has no vendedor', () => {
    expect(renderCampo(null).value).toBe('—');
    expect(useUsuarioNomes).toHaveBeenCalledWith([]);
  });

  it('renders the logged-in email for your OWN pedido, with no usuarios read', () => {
    expect(renderCampo('documents/usuarios/meu-uid').value).toBe('eu@delfrance.com');
    // Reading `usuarios` needs PERM.configuracoes.read, which a plain operator
    // does not hold — the common case must not depend on it.
    expect(useUsuarioNomes).toHaveBeenCalledWith([]);
  });

  it('falls back to the uid when the session carries no email', () => {
    usuarioAtual = { uid: 'meu-uid', email: null };
    expect(renderCampo('documents/usuarios/meu-uid').value).toBe('meu-uid');
  });

  it("renders the OTHER person's name, never the logged-in user", () => {
    useUsuarioNomes.mockReturnValue({ 'uid-da-maria': 'Maria Silva' });
    const input = renderCampo('documents/usuarios/uid-da-maria');

    expect(input.value).toBe('Maria Silva');
    // The regression this field exists to fix: it used to render the CURRENT
    // user unconditionally, so every pedido looked like yours.
    expect(input.value).not.toBe('eu@delfrance.com');
    expect(useUsuarioNomes).toHaveBeenCalledWith(['uid-da-maria']);
  });

  it('shows a short uid — not your email — when the name cannot be resolved', () => {
    // In flight, or the reader lacks configuracoes.read. The actor IS known;
    // only the lookup is unavailable.
    const input = renderCampo('documents/usuarios/abcdefghijklmnop');
    expect(input.value).toBe('Usuário abcdefgh');
    expect(input.value).not.toBe('eu@delfrance.com');
  });

  it('stays read-only', () => {
    const input = renderCampo('documents/usuarios/meu-uid');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
  });
});
