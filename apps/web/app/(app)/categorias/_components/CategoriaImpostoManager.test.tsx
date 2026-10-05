import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import {
  CRT,
  CSOSN,
  ORIGEM,
  impostoCategoriaSchema,
  type ImpostoCategoria,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The categoria Impostos tab shows ONE operação at a time, but the save
 * refuses every reachable row the NF-e engine would refuse (#1655) — so a
 * stored bad row on another operação must be named, with a way to jump to it.
 */
const h = vi.hoisted(() => ({
  operacoes: [] as { id: string; data: { nome: string; ativo: boolean; padrao: boolean } }[],
  impostos: [] as { id: string; data: unknown }[],
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => ({ base }),
  orderByField: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
  useSnapshot: (q: { base: { kind: string } } | null) => {
    if (!q) return { data: undefined, loading: false, error: undefined };
    return {
      data: q.base.kind === 'operacoes' ? h.operacoes : h.impostos,
      loading: false,
      error: undefined,
    };
  },
}));
vi.mock('@/lib/data/operacaoCollection', () => ({
  operacaoCollection: { ref: () => ({ kind: 'operacoes' }) },
}));
vi.mock('@/lib/data/impostoCategoriaCollection', () => ({
  impostoCategoriaCollection: {
    ref: () => ({ kind: 'impostos' }),
    docRef: (_db: unknown, context: { categoriaId: string }, id: string) => ({
      path: 'categorias/' + context.categoriaId + '/imposto/' + id,
    }),
  },
}));

import { CategoriaImpostoManager } from './CategoriaImpostoManager';

const OUTRAS = 'Outras operações que a NF-e recusaria';
const TITULO_EDITOR = 'A NF-e recusaria esta configuração';

const PARCIAL_900 = { crt: CRT.simplesNacional, csosn: CSOSN.outros, csosn900: { vBC: 1500 } };

function stored(operacaoId: string, over: Record<string, unknown>) {
  return {
    id: operacaoId,
    data: impostoCategoriaSchema.parse({
      impostoCategoriaOperacaoOuterRef: `operacao/${operacaoId}`,
      ...over,
    }),
  };
}

/** Holds the transient `impostos` value like the page does: null until seeded. */
function Harness() {
  const [value, setValue] = useState<ImpostoCategoria[] | null>(null);
  return (
    <MantineTestProvider>
      <CategoriaImpostoManager
        categoriaId="cat1"
        db={{} as Firestore}
        value={value}
        onChange={setValue}
      />
    </MantineTestProvider>
  );
}

beforeEach(() => {
  h.operacoes = [
    { id: 'op1', data: { nome: 'Venda', ativo: true, padrao: true } },
    { id: 'op2', data: { nome: 'Devolução', ativo: true, padrao: false } },
  ];
  h.impostos = [];
});

describe('CategoriaImpostoManager — the rows the NF-e engine would refuse (#1655)', () => {
  it('names a stored bad row on another operação, and jumps to it', async () => {
    h.impostos = [stored('op2', { origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_900 })];
    render(<Harness />);

    const alerta = (await screen.findByText(OUTRAS)).closest('[role="alert"]') as HTMLElement;
    expect(screen.queryByText(TITULO_EDITOR)).toBeNull();

    fireEvent.click(within(alerta).getByRole('button', { name: 'Devolução' }));

    expect((screen.getByRole('combobox', { name: 'Operação' }) as HTMLInputElement).value).toBe(
      'Devolução',
    );
    expect(screen.getByText(TITULO_EDITOR)).toBeTruthy();
    // The combobox role, not getByLabelText: a Mantine Select's listbox carries
    // the same label, so the label alone matches two elements.
    expect(screen.getByRole('combobox', { name: 'modBC' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(screen.getByLabelText('pICMS (%)').getAttribute('aria-invalid')).toBe('true');
    // Near-miss: the member that IS filled is not the problem.
    expect(screen.getByLabelText('vBC (R$)').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByText(OUTRAS)).toBeNull();
  });

  it('names nothing when the stored row has no origem (the engine never reads it)', async () => {
    h.impostos = [stored('op2', { configuracaoICMS: PARCIAL_900 })];
    render(<Harness />);
    await screen.findByRole('combobox', { name: 'Operação' });
    expect(screen.queryByText(OUTRAS)).toBeNull();
    expect(screen.queryByText(TITULO_EDITOR)).toBeNull();
  });

  it('only the active row bad → the editor Alert, and no "other operações" Alert', async () => {
    h.impostos = [stored('op1', { origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_900 })];
    render(<Harness />);
    expect(await screen.findByText(TITULO_EDITOR)).toBeTruthy();
    expect(screen.queryByText(OUTRAS)).toBeNull();
  });
});
