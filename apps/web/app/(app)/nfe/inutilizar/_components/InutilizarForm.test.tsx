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
vi.mock('@/lib/data/filialCollection', () => ({
  filialCollection: { ref: () => ({ __filiaisRef: true }) },
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: [], loading: false, error: undefined }),
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

describe('InutilizarForm — validation', () => {
  it('blocks an empty submit and shows the required-field errors (no SEFAZ call)', async () => {
    const { container } = wrap(<InutilizarForm />);
    submitForm(container);

    expect(await screen.findByText('Selecione uma filial')).toBeTruthy();
    expect(
      screen.getByText(/justificativa deve ter ao menos 15 caracteres/i),
    ).toBeTruthy();
    expect(screen.getByText('Informe a série')).toBeTruthy();
    expect(inutilizarMock).not.toHaveBeenCalled();
  });

  it('rejects an inverted range (nNFIni > nNFFin)', async () => {
    const { container } = wrap(<InutilizarForm />);
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
