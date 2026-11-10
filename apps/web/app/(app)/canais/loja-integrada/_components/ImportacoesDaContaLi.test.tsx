import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { MODO_IMPORTACAO_LI, STATUS_IMPORTACAO_LI } from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import { respostaImportacaoLiFalsa as job } from '@/lib/testing/importacaoLiFalsa';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The conta page's product imports (master plan step 9) — where the import's
 * avisos link: the conta's newest job as a card, and its result one click away,
 * gated like the list page's rail.
 *
 * Only the backend hook and the permission bits are replaced; the panel, the
 * card, the result view and the copy are the REAL ones. The ids are obviously
 * fake.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as LojaIntegradaClient | null },
  bits: new Set<bigint>(),
}));

vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({ client: h.clientRef.current, indisponivel: null }),
  };
});
vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: h.bits.has(bit), loading: false }),
}));

const { ImportacoesDaContaLi } = await import('./ImportacoesDaContaLi');

const IMPORTACAO = job({
  jobId: 'job-importacao-1',
  integracaoId: 'conta-falsa-1',
  status: STATUS_IMPORTACAO_LI.concluido,
  modo: MODO_IMPORTACAO_LI.aplicar,
});

function renderSecao() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <ImportacoesDaContaLi integracaoId="conta-falsa-1" />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.bits = new Set([PERM.integracao.read]);
});

describe('ImportacoesDaContaLi', () => {
  it('⭐ shows the conta’s newest import, and opens its result — the report the avisos name', async () => {
    const importacoes = vi.fn(async () => ({ importacoes: [IMPORTACAO] }));
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes,
      itensImportacao: vi.fn(async () => ({ itens: [], proximo: null })),
    });
    renderSecao();

    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
    expect(importacoes).toHaveBeenCalledWith('conta-falsa-1', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByText('Resultado da importação — Esta conta')).not.toBeNull();
    expect(await screen.findByRole('radio', { name: /^Revisão fiscal$/ })).not.toBeNull();
  });

  it('NEAR MISS — a viewer with neither integration bit gets nothing, and reads nothing', () => {
    h.bits = new Set();
    const importacoes = vi.fn(async () => ({ importacoes: [IMPORTACAO] }));
    h.clientRef.current = lojaIntegradaClientFalso({ importacoes });
    const { container } = renderSecao();

    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(importacoes).not.toHaveBeenCalled();
  });

  it('a reader cannot cancel: the X only hides the card', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({
        importacoes: [{ ...IMPORTACAO, status: STATUS_IMPORTACAO_LI.executando }],
      })),
      importacao: vi.fn(async () => ({ ...IMPORTACAO, status: STATUS_IMPORTACAO_LI.executando })),
    });
    renderSecao();
    await screen.findByText('Em andamento');

    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));

    expect(screen.queryByRole('button', { name: 'Cancelar importação' })).toBeNull();
    expect(screen.queryByText('Em andamento')).toBeNull();
  });
});
