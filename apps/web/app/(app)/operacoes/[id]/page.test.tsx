import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  IND_INCENTIVO,
  IND_ISS,
  MOD_BC,
  ORIGEM,
} from '@delfrance/schemas';
import type { ValidationIssue } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The operação edit page must refuse to save a default tax config the NF-e
 * engine would refuse (#1655). ObjectView is replaced by a stub that captures
 * its props, so the test reads the page's own `validate` wiring rather than
 * re-testing ObjectView's resolver.
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
  useParams: () => ({ id: 'op1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('../_components/MacrosTab', () => ({ MacrosTab: () => null }));

import OperacaoPage from './page';
import { validarImpostoDaOperacao } from '../_components/operacaoFields';

const PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};
const PARCIAL_900 = { crt: CRT.simplesNacional, csosn: CSOSN.outros, csosn900: { vBC: 1500 } };

beforeEach(() => {
  h.captured = null;
  render(
    <MantineTestProvider>
      <OperacaoPage />
    </MantineTestProvider>,
  );
});

describe('operacoes/[id] — refuses a default tax config the NF-e engine would refuse (#1655)', () => {
  it('passes the module-level validarImpostoDaOperacao (stable identity for the resolver memo)', () => {
    expect(typeof validarImpostoDaOperacao).toBe('function');
    expect(h.captured?.validate).toBe(validarImpostoDaOperacao);
  });

  it('a half-filled ICMS-ST retido group → an issue on the Impostos tab key', () => {
    expect(
      h.captured?.validate?.({
        nome: 'Venda',
        origem: ORIGEM.nacional,
        configuracaoICMS: PARCIAL_500,
      }),
    ).toEqual([{ path: 'configuracaoICMS', message: expect.stringContaining('ICMS-ST retido') }]);
  });

  it('a PIS problem is routed to configuracaoICMS too (the PIS keys are hidden fields)', () => {
    expect(
      h.captured?.validate?.({
        origem: ORIGEM.nacional,
        configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
      }),
    ).toEqual([{ path: 'configuracaoICMS', message: expect.stringContaining('não as duas') }]);
  });

  it.each([
    // An operação with no Origem padrão is never read as a tier by the engine.
    ['origem null', { origem: null, configuracaoICMS: PARCIAL_500 }],
    [
      'an ISSQN config with a leftover partial CSOSN 900',
      {
        origem: ORIGEM.nacional,
        configuracaoICMS: PARCIAL_900,
        configuracaoISSQN: {
          vBC: 500,
          vAliq: 5,
          vISSQN: 25,
          cMunFG: '3550308',
          cListServ: '01.05',
          indISS: IND_ISS.exigivel,
          indIncentivo: IND_INCENTIVO.nao,
        },
      },
    ],
    [
      'a complete CSOSN 900 ICMS próprio group',
      {
        origem: ORIGEM.nacional,
        configuracaoICMS: {
          ...PARCIAL_900,
          csosn900: { modBC: MOD_BC.valorOperacao, vBC: 1500, pICMS: 18, vICMS: 270 },
        },
      },
    ],
    [
      'no tax config at all (the e2e seed shape)',
      { origem: ORIGEM.nacional, configuracaoICMS: null },
    ],
  ])('does not block %s', (_label, values) => {
    expect(h.captured?.validate?.(values)).toEqual([]);
  });
});
