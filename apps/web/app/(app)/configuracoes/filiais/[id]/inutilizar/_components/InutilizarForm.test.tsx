import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NFeInutilizacaoNaoSeAplicaError } from '@delfrance/integrations-nfe/http-provider';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

const inutilizarMock = vi.fn();

vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: () => ({ inutilizar: inutilizarMock }),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
  showCopyableNotification: vi.fn(),
}));
// The history list (always rendered for the fixed filial) reads these.
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: [], loading: false, error: undefined }),
}));
vi.mock('@/lib/data/inutilizacaoCollection', () => ({
  inutilizacaoCollection: { ref: () => ({ __inutRef: true }) },
}));

import { InutilizarForm } from './InutilizarForm';

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

/**
 * Submit via the form element, not a submit-button click — jsdom does not
 * trigger implicit form submission on `fireEvent.click` of a submit button.
 */
function submitForm(container: HTMLElement) {
  fireEvent.submit(container.querySelector('form')!);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('InutilizarForm — validation (fixed filial)', () => {
  it('blocks an empty submit and shows the required-field errors (no SEFAZ call)', async () => {
    const { container } = wrap(<InutilizarForm filialId="F-1" />);
    submitForm(container);

    expect(await screen.findByText(/justificativa deve ter ao menos 15 caracteres/i)).toBeTruthy();
    expect(screen.getByText('Informe a série')).toBeTruthy();
    expect(screen.getByText('Informe o número inicial')).toBeTruthy();
    expect(inutilizarMock).not.toHaveBeenCalled();
  });

  it('rejects an inverted range (nNFIni > nNFFin)', async () => {
    const { container } = wrap(<InutilizarForm filialId="F-1" />);
    fireEvent.change(screen.getByPlaceholderText('nNFIni'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByPlaceholderText('nNFFin'), {
      target: { value: '10' },
    });
    submitForm(container);

    expect(await screen.findByText(/número inicial deve ser .* ao número final/i)).toBeTruthy();
    expect(inutilizarMock).not.toHaveBeenCalled();
  });
});

describe('InutilizarForm — Ajuste SINIEF nº 40/2026 (AC/BA/SP from 01/11/2026)', () => {
  // 01/11/2026 00:00 in SP/BA (−03:00).
  const VIGENCIA = new Date('2026-11-01T03:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  function botao() {
    return screen.getByRole('button', { name: 'Inutilizar numeração' }) as HTMLButtonElement;
  }

  it('an SP filial from 01/11/2026 → explains the Ajuste, disables the form and never calls apps/nfe', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(VIGENCIA);
    const { container } = wrap(<InutilizarForm filialId="F-1" uf="SP" />);

    expect(screen.getByText('Inutilização não se aplica a esta filial')).toBeTruthy();
    expect(screen.getByText(/Ajuste SINIEF nº 40\/2026/)).toBeTruthy();
    expect(botao().disabled).toBe(true);
    expect((screen.getByPlaceholderText('nNFIni') as HTMLInputElement).disabled).toBe(true);

    submitForm(container);
    expect(inutilizarMock).not.toHaveBeenCalled();
  });

  it('the same SP filial one millisecond earlier → enabled, no explanation', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(VIGENCIA.getTime() - 1);
    wrap(<InutilizarForm filialId="F-1" uf="SP" />);

    expect(screen.queryByText('Inutilização não se aplica a esta filial')).toBeNull();
    expect(botao().disabled).toBe(false);
  });

  it('a filial outside the Ajuste (MG) after the date → enabled', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-01T12:00:00.000Z'));
    wrap(<InutilizarForm filialId="F-1" uf="MG" />);

    expect(screen.queryByText('Inutilização não se aplica a esta filial')).toBeNull();
    expect(botao().disabled).toBe(false);
  });

  it('apps/nfe refusing the UF (page opened before midnight) → its own notification, not "Falha"', async () => {
    const motivo =
      'A inutilização de numeração não se aplica às filiais de São Paulo desde 01/11/2026.';
    inutilizarMock.mockRejectedValueOnce(
      new NFeInutilizacaoNaoSeAplicaError(motivo, 422, {
        error: motivo,
        code: 'INUTILIZACAO_NAO_SE_APLICA',
      }),
    );
    const { container } = wrap(<InutilizarForm filialId="F-1" uf="MG" />);
    fireEvent.change(screen.getByPlaceholderText('Ex.: 1'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('nNFIni'), { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('nNFFin'), { target: { value: '6' } });
    fireEvent.change(screen.getByPlaceholderText('Descreva o motivo da inutilização'), {
      target: { value: 'Numeracao pulada por falha no sistema' },
    });
    submitForm(container);

    await waitFor(() =>
      expect(showErrorNotification).toHaveBeenCalledWith({
        title: 'Inutilização não se aplica',
        message: motivo,
      }),
    );
  });
});
