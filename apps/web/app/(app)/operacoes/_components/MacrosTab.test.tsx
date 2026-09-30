import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CRT, CSOSN, ORIGEM, regraImpostoSchema, type RegraImposto } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * A regra de imposto (macro) is written by `MacrosTab.handleSave` directly —
 * no ObjectView, no resolver. It must refuse, BEFORE any write, a tax config
 * the NF-e engine would refuse (#1655), and still write one it would emit.
 */
const h = vi.hoisted(() => ({
  regras: [] as { id: string; data: unknown }[],
  setDoc: vi.fn(),
  addDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => ({ base }),
  orderByField: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: { base: { kind: string } } | null) => ({
    data: q?.base.kind === 'regras' ? h.regras : [],
    loading: false,
    error: undefined,
  }),
}));
vi.mock('@/lib/data/regraImpostoCollection', () => ({
  regraImpostoCollection: {
    ref: () => ({ kind: 'regras' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ kind: 'regraDoc', id }),
  },
}));
vi.mock('@/lib/data/categoriaCollection', () => ({
  categoriaCollection: { ref: () => ({ kind: 'categorias' }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { ref: () => ({ kind: 'produtos' }) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/components/collection-select/CollectionSelect', () => ({
  CollectionSelect: () => null,
}));
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  setDoc: (...args: unknown[]) => h.setDoc(...args),
  addDoc: (...args: unknown[]) => h.addDoc(...args),
  deleteDoc: (...args: unknown[]) => h.deleteDoc(...args),
}));

import { MacrosTab } from './MacrosTab';

function regra(over: Record<string, unknown>): RegraImposto {
  return regraImpostoSchema.parse({ nome: 'Regra ST', ncms: ['61091000'], ...over });
}

const ICMS_PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};

function renderEditing(r: RegraImposto) {
  h.regras = [{ id: 'r1', data: r }];
  render(
    <MantineTestProvider>
      <MacrosTab operacaoId="op1" />
    </MantineTestProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
}

beforeEach(() => {
  h.setDoc.mockReset().mockResolvedValue(undefined);
  h.addDoc.mockReset().mockResolvedValue(undefined);
  h.deleteDoc.mockReset().mockResolvedValue(undefined);
});

describe('MacrosTab — refuses to save a regra the NF-e engine would refuse (#1655)', () => {
  it('shows the problem while editing', () => {
    renderEditing(regra({ origem: ORIGEM.nacional, configuracaoICMS: ICMS_PARCIAL_500 }));
    expect(screen.getByText('A NF-e recusaria esta configuração')).toBeTruthy();
  });

  it('writes nothing on save, and says why', async () => {
    renderEditing(regra({ origem: ORIGEM.nacional, configuracaoICMS: ICMS_PARCIAL_500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' }));

    // Settle the async save either way before asserting on the write.
    await waitFor(() =>
      expect(
        h.setDoc.mock.calls.length > 0 || screen.queryByText(/A NF-e recusaria esta regra/) != null,
      ).toBe(true),
    );
    expect(h.setDoc).not.toHaveBeenCalled();
    expect(h.addDoc).not.toHaveBeenCalled();
    expect(screen.getByText(/A NF-e recusaria esta regra/).textContent).toContain('ICMS-ST retido');
  });

  it('writes a regra whose group is complete (equal pair)', async () => {
    renderEditing(
      regra({
        origem: ORIGEM.nacional,
        configuracaoICMS: {
          ...ICMS_PARCIAL_500,
          csosn500: { vBCSTRet: 100, pST: 20, vICMSSTRet: 20 },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' }));
    await waitFor(() => expect(h.setDoc).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/A NF-e recusaria esta regra/)).toBeNull();
  });

  it('writes the same partial regra when it has no origem (the engine never reads it)', async () => {
    renderEditing(regra({ origem: null, configuracaoICMS: ICMS_PARCIAL_500 }));
    expect(screen.queryByText('A NF-e recusaria esta configuração')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' }));
    await waitFor(() => expect(h.setDoc).toHaveBeenCalledTimes(1));
  });
});
