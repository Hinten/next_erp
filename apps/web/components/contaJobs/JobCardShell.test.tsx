import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { JobCardShell, type ErrosDoCliente } from './JobCardShell';
import { PriceSyncEntryList, type AmostraDeJob } from './PriceSyncEntryList';

/** Two classes, so "is ONE of the client's" and "is EVERY one of them" disagree. */
class ErroHttpDoCanal extends Error {}
class ErroDeRedeDoCanal extends Error {}

const ERROS: ErrosDoCliente = {
  tagLog: '[canal-x]',
  classes: [ErroHttpDoCanal, ErroDeRedeDoCanal],
};

const CARD_X = 'Dispensar Envio de preços de Loja A';

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** Only the shell's own line — React may log on its own, and that is not under test. */
function linhasDoShell(): unknown[][] {
  return consoleError.mock.calls.filter(
    ([primeiro]) => typeof primeiro === 'string' && primeiro.startsWith(ERROS.tagLog),
  );
}

async function cancelarCom(erro: unknown) {
  render(
    <MantineTestProvider>
      <JobCardShell
        conta={{ id: 'conta-a', nome: 'Loja A' }}
        flowLabel="Envio de preços"
        running
        onDismiss={() => {}}
        cancelLabel="Cancelar envio"
        describeCancelError={() => 'Não foi possível cancelar o envio de preços.'}
        errosDoCliente={ERROS}
        onCancel={async () => {
          throw erro;
        }}
      >
        <span>contadores</span>
      </JobCardShell>
    </MantineTestProvider>,
  );

  fireEvent.click(screen.getByLabelText(CARD_X));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
  });
  // Whatever the class, the operator reads the flow's own copy in the confirm.
  expect(await screen.findByText('Não foi possível cancelar o envio de preços.')).toBeTruthy();
}

describe('JobCardShell — a failed cancel and the console', () => {
  it("logs nothing for a failure of the channel client's own classes", async () => {
    // Already described in the confirm; a console line would be noise. It is
    // the SECOND listed class on purpose: `.every` would treat it as foreign.
    await cancelarCom(new ErroDeRedeDoCanal('rede'));

    expect(linhasDoShell()).toEqual([]);
  });

  it('logs a foreign throwable once, under the channel tag', async () => {
    // Not a client failure at all (a null client, a bug): keep the original
    // where it can be read.
    const estranho = new TypeError('client is null');
    await cancelarCom(estranho);

    expect(linhasDoShell()).toEqual([
      ['[canal-x] cancelamento falhou (Envio de preços)', estranho],
    ]);
  });
});

function amostras(n: number, over: Partial<AmostraDeJob> = {}): AmostraDeJob[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `item-${String(i + 1)}`,
    produtoId: `prod-${String(i + 1)}`,
    code: 'PRECO_ANTIGO_IGUAL',
    ...over,
  }));
}

describe('PriceSyncEntryList', () => {
  it('counts "+N mais" against the exact total, not against the sample', () => {
    // 9 sampled of 12: the list shows 8, so 4 are unshown — not the 3 a
    // `total − entries.length` would claim.
    render(
      <MantineTestProvider>
        <PriceSyncEntryList label="Pulados" entries={amostras(9)} total={12} />
      </MantineTestProvider>,
    );

    expect(screen.getByText('+4 mais')).toBeTruthy();
    expect(screen.getByText(/^item-8 · /)).toBeTruthy();
    expect(screen.queryByText(/^item-9 · /)).toBeNull();
  });

  it("shows a backend's own sentence whole, on a line of its own", () => {
    render(
      <MantineTestProvider>
        <PriceSyncEntryList
          label="Falhas"
          entries={[
            {
              itemId: null,
              produtoId: 'prod-1',
              code: 'PRECO_RECUSADO',
              mensagem: 'A Shopee recusou o preço deste anúncio.',
            },
          ]}
          total={1}
        />
      </MantineTestProvider>,
    );

    // A plan-time entry (no listing) names the produto.
    expect(screen.getByText('prod-1 · PRECO_RECUSADO').textContent).toBe('prod-1 · PRECO_RECUSADO');
    expect(screen.getByText('A Shopee recusou o preço deste anúncio.').textContent).toBe(
      'A Shopee recusou o preço deste anúncio.',
    );
  });

  it('prints a dash for an entry that names neither a listing nor a produto', () => {
    render(
      <MantineTestProvider>
        <PriceSyncEntryList
          label="Pulados"
          entries={[{ itemId: null, code: 'SEM_VINCULO' }]}
          total={1}
        />
      </MantineTestProvider>,
    );

    expect(screen.getByText('— · SEM_VINCULO')).toBeTruthy();
  });
});
