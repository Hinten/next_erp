import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { FirebaseError } from 'firebase/app';

import { PushProgressDialog } from './PushProgressDialog';
import type { PushRowBase } from './types';

/**
 * The dialog is shared by "Enviar estoque" and "Enviar preços", so its failure
 * behaviour is the one both operators see. What is pinned here is the run-level
 * break: a listing that fails is DATA and arrives as a row, but a run that
 * throws used to leave the dialog reporting "Enviados 0 · Pulados 0 · Falhas 0"
 * and no rows — telling the operator nothing happened when the truth is that
 * nobody knows what happened.
 */

const linha = (over: Partial<PushRowBase> = {}): PushRowBase => ({
  key: 'p1:c1:-',
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  integracaoId: 'c1',
  integracaoNome: 'Loja ML',
  anuncioId: null,
  linkDocId: null,
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Enviado.',
  ...over,
});

function renderDialog(
  executar: (
    opcao: boolean,
    signal: AbortSignal,
    onProgress: (rows: PushRowBase[]) => void,
  ) => Promise<{ rows: PushRowBase[]; cancelado: boolean }>,
) {
  render(
    <MantineProvider env="test">
      <PushProgressDialog<PushRowBase, boolean>
        opened
        onClose={vi.fn()}
        titulo="Enviando preços para os marketplaces"
        rotuloAcao="Enviar preços"
        testIdPrefix="envio-preco-row-"
        descricao="descrição"
        totalAlvos={1}
        opcaoInicial
        renderOpcao={() => null}
        executar={executar}
      />
    </MantineProvider>,
  );
}

describe('PushProgressDialog — a run that BREAKS', () => {
  it('reports a FirebaseError instead of an all-zeros summary', async () => {
    // The integração read is a live Firestore query and can reject before a
    // single row exists — offline, or a permission the claims have not resolved.
    renderDialog(() => Promise.reject(new FirebaseError('unavailable', 'client is offline')));

    fireEvent.click(screen.getByRole('button', { name: 'Enviar preços' }));

    expect(await screen.findByText('O envio foi interrompido')).toBeTruthy();
    expect(screen.getByText(/client is offline/)).toBeTruthy();
    // And the run is terminal, so the operator can read it and close.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy();
    });
  });

  it('still SURFACES a coding bug (repo rule 6) while telling the operator', async () => {
    // A provider rethrows anything that is not a known channel error, and this
    // dialog re-throws it in turn — same as `useActionRunner`, which shows the
    // FirebaseError and rethrows the rest. The rejection is therefore MEANT to
    // escape; the point of this spec is that the operator is no longer told
    // "Enviados 0 · Pulados 0 · Falhas 0" while it does.
    //
    // Acknowledged here so the intentional escape does not fail the run — the
    // listener is what asserts it actually happened.
    const escapou = vi.fn();
    process.on('unhandledRejection', escapou);
    try {
      renderDialog(() => Promise.reject(new TypeError('coding bug')));

      fireEvent.click(screen.getByRole('button', { name: 'Enviar preços' }));

      expect(await screen.findByText('O envio foi interrompido')).toBeTruthy();
      expect(screen.getByText(/coding bug/)).toBeTruthy();
      await waitFor(() => {
        expect(escapou).toHaveBeenCalledWith(expect.any(TypeError), expect.anything());
      });
    } finally {
      process.off('unhandledRejection', escapou);
    }
  });

  it('keeps the rows that DID land before the break', async () => {
    renderDialog((_opcao, _signal, onProgress) => {
      onProgress([linha()]);
      return Promise.reject(new FirebaseError('unavailable', 'caiu no meio'));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enviar preços' }));

    expect(await screen.findByText('O envio foi interrompido')).toBeTruthy();
    expect(screen.getByTestId('envio-preco-row-p1:c1:-')).toBeTruthy();
    expect(screen.getByText(/já haviam sido processados/)).toBeTruthy();
  });

  it('says nothing about a break on a clean run', async () => {
    renderDialog(() => Promise.resolve({ rows: [linha()], cancelado: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Enviar preços' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy();
    });
    expect(screen.queryByText('O envio foi interrompido')).toBeNull();
  });
});
