import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CRT, CSOSN, ORIGEM } from '@delfrance/schemas';
import type { ValidationIssue } from '@delfrance/ui';
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
import { validarImpostoDaOperacao } from '../_components/operacaoFields';

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
  it('passes the module-level validarImpostoDaOperacao', () => {
    expect(typeof validarImpostoDaOperacao).toBe('function');
    expect(h.captured?.validate).toBe(validarImpostoDaOperacao);
  });

  it('a half-filled ICMS-ST retido group → an issue on the Impostos tab key', () => {
    expect(
      h.captured?.validate?.({ origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 }),
    ).toEqual([{ path: 'configuracaoICMS', message: expect.stringContaining('ICMS-ST retido') }]);
  });

  it('a CSOSN chosen with its sub-config never filled → blocked, pointing at the CSOSN', () => {
    expect(
      h.captured?.validate?.({
        origem: ORIGEM.nacional,
        configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.outros, csosn900: null },
      }),
    ).toEqual([
      {
        path: 'configuracaoICMS',
        message: 'CSOSN 900: os campos do CSOSN 900 não foram preenchidos.',
      },
    ]);
  });

  it('does not block a new operação with no Origem padrão (the e2e create flow)', () => {
    expect(h.captured?.validate?.({ nome: 'Nova', configuracaoICMS: PARCIAL_500 })).toEqual([]);
  });
});
