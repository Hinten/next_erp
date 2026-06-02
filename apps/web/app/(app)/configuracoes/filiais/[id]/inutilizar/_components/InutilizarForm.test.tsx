import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

const inutilizarMock = vi.fn();

vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: () => ({ inutilizar: inutilizarMock }),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
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
  return render(<MantineProvider env="test">{node}</MantineProvider>);
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

    expect(
      await screen.findByText(/justificativa deve ter ao menos 15 caracteres/i),
    ).toBeTruthy();
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

    expect(
      await screen.findByText(/número inicial deve ser .* ao número final/i),
    ).toBeTruthy();
    expect(inutilizarMock).not.toHaveBeenCalled();
  });
});
