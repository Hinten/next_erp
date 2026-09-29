import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CRT, CSOSN, ORIGEM, impostoCategoriaSchema } from '@delfrance/schemas';
import type { ValidationIssue } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The categoria edit page saves its per-operação imposto rows atomically with
 * the categoria doc; it must refuse a row the NF-e engine would refuse (#1655).
 * ObjectView is replaced by a stub that captures its props.
 */

/** The one ObjectView prop these tests read. */
interface Capturado {
  validate?: (values: Record<string, unknown>) => readonly ValidationIssue[];
}

const h = vi.hoisted(() => ({ captured: null as Capturado | null }));

vi.mock('@delfrance/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/ui')>()),
  ObjectView: (props: Capturado) => {
    h.captured = props;
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'cat1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/categorias/cascadeNomeCompleto', () => ({
  cascadeCategoriaNomeCompleto: vi.fn(),
  listDescendantIdsForPicker: () => Promise.resolve([]),
}));
vi.mock('../_components/CategoriaImpostoManager', () => ({ CategoriaImpostoManager: () => null }));
vi.mock('../_components/CategoriaParentField', () => ({ CategoriaParentField: () => null }));

import CategoriaPage from './page';
import { validarImpostosDaCategoria } from '@/lib/categorias/clientPort';

const linha = (operacaoId: string, over: Record<string, unknown> = {}) =>
  impostoCategoriaSchema.parse({
    impostoCategoriaOperacaoOuterRef: `operacao/${operacaoId}`,
    ...over,
  });

beforeEach(() => {
  h.captured = null;
  render(
    <MantineTestProvider>
      <CategoriaPage />
    </MantineTestProvider>,
  );
});

describe('categorias/[id] — refuses an imposto row the NF-e engine would refuse (#1655)', () => {
  it('passes the module-level validarImpostosDaCategoria (stable identity)', () => {
    expect(typeof validarImpostosDaCategoria).toBe('function');
    expect(h.captured?.validate).toBe(validarImpostosDaCategoria);
  });

  it('a half-filled CSOSN 900 ICMS próprio group on row 1 → an issue on that row', () => {
    const impostos = [
      linha('op1'),
      linha('op2', {
        origem: ORIGEM.nacional,
        configuracaoICMS: {
          crt: CRT.simplesNacional,
          csosn: CSOSN.outros,
          csosn900: { vBC: 1500 },
        },
      }),
    ];
    expect(h.captured?.validate?.({ nome: 'Camisetas', impostos })).toContainEqual({
      path: expect.stringMatching(/^impostos\.1\.configuracaoICMS\.csosn900\./),
      message: expect.stringContaining('ICMS próprio'),
    });
  });

  it('does not block a save that never opened the Impostos tab (impostos null)', () => {
    expect(h.captured?.validate?.({ nome: 'Camisetas', impostos: null })).toEqual([]);
  });
});
