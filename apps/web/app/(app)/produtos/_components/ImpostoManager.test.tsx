import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import { CRT, CSOSN, ORIGEM, impostoProdutoSchema, type ImpostoProduto } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The produto Impostos tab shows ONE operação at a time, but the save refuses
 * every reachable row the NF-e engine would refuse (#1655) — so a stored bad
 * row on another operação must be named, with a way to jump to it.
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
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: { ref: () => ({ kind: 'impostos' }) },
}));

import { ImpostoManager } from './ImpostoManager';

const OUTRAS = 'Outras operações que a NF-e recusaria';
const TITULO_EDITOR = 'A NF-e recusaria esta configuração';

const PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};

function stored(operacaoId: string, over: Record<string, unknown>) {
  return {
    id: operacaoId,
    data: impostoProdutoSchema.parse({ impostoOpercaoOuterRef: `operacao/${operacaoId}`, ...over }),
  };
}

/** Holds the transient `impostos` value like the page does: null until seeded. */
function Harness() {
  const [value, setValue] = useState<ImpostoProduto[] | null>(null);
  return (
    <MantineTestProvider>
      <ImpostoManager produtoId="p1" db={{} as Firestore} value={value} onChange={setValue} />
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

describe('ImpostoManager — the rows the NF-e engine would refuse (#1655)', () => {
  it('names a stored bad row on another operação, and jumps to it', async () => {
    h.impostos = [stored('op2', { origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 })];
    render(<Harness />);

    const alerta = (await screen.findByText(OUTRAS)).closest('[role="alert"]') as HTMLElement;
    expect(screen.queryByText(TITULO_EDITOR)).toBeNull(); // the active row (Venda) is fine

    fireEvent.click(within(alerta).getByRole('button', { name: 'Devolução' }));

    expect((screen.getByRole('combobox', { name: 'Operação' }) as HTMLInputElement).value).toBe(
      'Devolução',
    );
    expect(screen.getByText(TITULO_EDITOR)).toBeTruthy();
    expect(screen.getByLabelText('vBCSTRet (R$)').getAttribute('aria-invalid')).toBe('true');
    // The jumped-to row is now the active one: nothing ELSE is refused.
    expect(screen.queryByText(OUTRAS)).toBeNull();
  });

  it('names nothing when the stored row has no origem (the engine never reads it)', async () => {
    h.impostos = [stored('op2', { configuracaoICMS: PARCIAL_500 })];
    render(<Harness />);
    await screen.findByRole('combobox', { name: 'Operação' });
    expect(screen.queryByText(OUTRAS)).toBeNull();
    expect(screen.queryByText(TITULO_EDITOR)).toBeNull();
  });

  it('only the active row bad → the editor Alert, and no "other operações" Alert', async () => {
    h.impostos = [stored('op1', { origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 })];
    render(<Harness />);
    expect(await screen.findByText(TITULO_EDITOR)).toBeTruthy();
    expect(screen.queryByText(OUTRAS)).toBeNull();
  });
});
