import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CRT, CSOSN, ORIGEM } from '@delfrance/schemas';
import type { ValidationIssue } from '@delfrance/ui';
import { ImpostoConfigEditor } from '@/components/imposto/ImpostoConfigEditor';
import type { ImpostoConfigValue } from '@/components/imposto/types';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The operação create page wires the same refusal as the edit page (#1655):
 * a copy (`?copyFrom=`) or a fresh operação with a default tax config the NF-e
 * engine would refuse must not be created.
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
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('../_components/MacrosTab', () => ({ MacrosTab: () => null }));

import NovaOperacaoPage from './page';
import { validarFormularioDaOperacao } from '../_components/operacaoFields';

const PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};

beforeEach(() => {
  h.captured = null;
  render(
    <MantineTestProvider>
      <NovaOperacaoPage />
    </MantineTestProvider>,
  );
});

describe('operacoes/novo — refuses a default tax config the NF-e engine would refuse (#1655)', () => {
  it('passes the module-level validarFormularioDaOperacao', () => {
    expect(typeof validarFormularioDaOperacao).toBe('function');
    expect(h.captured?.validate).toBe(validarFormularioDaOperacao);
  });

  it('a half-filled ICMS-ST retido group → an issue on the Impostos tab key', () => {
    expect(
      h.captured?.validate?.({ origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 }),
    ).toEqual([{ path: 'configuracaoICMS', message: expect.stringContaining('ICMS-ST retido') }]);
  });

  it.each([
    ['no field was filled', false],
    ['a field was filled and cleared', true],
  ])('allows saving CSOSN 900 when %s', (_label, fillAndClear) => {
    const onChange = vi.fn<(next: ImpostoConfigValue) => void>();
    function Editor() {
      const [value, setValue] = useState<ImpostoConfigValue>({
        origem: ORIGEM.nacional,
        configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito },
      });
      return (
        <ImpostoConfigEditor
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(
      <MantineTestProvider>
        <Editor />
      </MantineTestProvider>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'CSOSN' }));
    fireEvent.click(screen.getByRole('option', { name: /^900 - Outros/ }));
    if (fillAndClear) {
      const base = screen.getByLabelText('vBC (R$)');
      fireEvent.change(base, { target: { value: '100' } });
      expect(onChange.mock.lastCall?.[0].configuracaoICMS?.csosn900).toEqual({ vBC: 100 });
      fireEvent.change(base, { target: { value: '' } });
    }
    const edited = onChange.mock.lastCall?.[0];
    expect(edited?.configuracaoICMS?.csosn900).toEqual(fillAndClear ? { vBC: null } : null);
    expect(h.captured?.validate?.({ ...edited })).toEqual([]);
  });

  it('does not block a new operação with no Origem padrão (the e2e create flow)', () => {
    expect(h.captured?.validate?.({ nome: 'Nova', configuracaoICMS: PARCIAL_500 })).toEqual([]);
  });
});
