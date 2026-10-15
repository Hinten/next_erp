import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { APURACAO_ESTADO } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';

// The panel reaches Firestore at module scope through the collection handle and
// the client singleton; this suite is about the three QUERY STATES it renders,
// so both are stubbed and `getDoc` is the only thing the tests steer.
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/simplesNacionalConfigCollection', () => ({
  SIMPLES_CONFIG_DOC_ID: 'default',
  simplesNacionalConfigCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/fiscal/simplesConfigPort', () => ({ createSimplesConfigPort: () => ({}) }));
const getDoc = vi.hoisted(() => vi.fn());
vi.mock('firebase/firestore', () => ({ getDoc }));

import {
  aliquotaParaCampo,
  campoParaAliquota,
  descreverEstado,
  formatAliquota,
  SimplesNacionalPanel,
} from './SimplesNacionalPanel';

describe('formatAliquota', () => {
  it('renders a fraction as a pt-BR percentage', () => {
    // Stored as 0.06728; the accountant says "6,728%".
    expect(formatAliquota(0.06728)).toBe('6,728%');
  });

  it('keeps three decimals — the rate is not money and 6,73% is a different tax', () => {
    expect(formatAliquota(0.04)).toBe('4,000%');
  });

  it('shows a dash for "not apurada yet" rather than 0%', () => {
    // 0% is a claim; "—" is the truth before the first apuração.
    expect(formatAliquota(null)).toBe('—');
    expect(formatAliquota(null)).not.toBe('0,000%');
  });
});

describe('descreverEstado', () => {
  it('vigente reads as published', () => {
    const d = descreverEstado(APURACAO_ESTADO.vigente, 0);
    expect(d?.cor).toBe('green');
  });

  // ⚠️ The load-bearing one. `incompleta` must not read as a neutral badge:
  // the number on screen is known to be untrustworthy and the OLD rate is
  // still the one being applied.
  describe('incompleta — a warning, not information', () => {
    it('is red, not a neutral colour', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 3)?.cor).toBe('red');
    });

    it('says plainly that the rate was NOT updated', () => {
      const d = descreverEstado(APURACAO_ESTADO.incompleta, 3);
      expect(d?.titulo).toMatch(/NÃO foi atualizada/);
    });

    it('names how many notes could not be read', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 3)?.detalhe).toContain('3 nota');
    });

    it('explains the DIRECTION of the error — a smaller revenue means a smaller faixa', () => {
      // Without this the operator cannot tell whether an incomplete window is
      // harmless. It is not: it under-declares.
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 1)?.detalhe).toMatch(
        /receita menor daria uma faixa menor/,
      );
    });

    it('says the previous rate still applies', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 1)?.detalhe).toMatch(
        /anterior continua valendo/,
      );
    });

    it('handles a null counter without printing "null notes"', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, null)?.detalhe).toContain('0 nota');
    });
  });

  it('aguardandoAutorizacao points at the switch that unblocks it', () => {
    const d = descreverEstado(APURACAO_ESTADO.aguardandoAutorizacao, 0);
    expect(d?.cor).toBe('yellow');
    expect(d?.detalhe).toMatch(/recálculo automático/);
  });

  it('foraDoRegime names the ceiling rather than showing a wrong rate', () => {
    expect(descreverEstado(APURACAO_ESTADO.foraDoRegime, 0)?.detalhe).toContain('4.800.000');
  });

  it('renders nothing before the first apuração', () => {
    // A filial just configured has no state; an invented badge would imply a
    // run that never happened.
    expect(descreverEstado(null, null)).toBeNull();
  });

  it('every state is distinguishable by colour AND wording', () => {
    const estados = [
      APURACAO_ESTADO.vigente,
      APURACAO_ESTADO.incompleta,
      APURACAO_ESTADO.aguardandoAutorizacao,
      APURACAO_ESTADO.foraDoRegime,
    ] as const;
    const cores = estados.map((e) => descreverEstado(e, 0)?.cor);
    const titulos = estados.map((e) => descreverEstado(e, 0)?.titulo);
    expect(new Set(cores).size).toBe(estados.length);
    expect(new Set(titulos).size).toBe(estados.length);
  });
});

describe('aliquotaParaCampo / campoParaAliquota', () => {
  it('shows a stored fraction as the percentage the accountant says', () => {
    expect(aliquotaParaCampo(0.06728)).toBe(6.728);
    expect(campoParaAliquota(6.728)).toBe(0.06728);
  });

  it('keeps null as "not informed" in both directions — never 0%', () => {
    expect(aliquotaParaCampo(null)).toBeNull();
    expect(campoParaAliquota(null)).toBeNull();
  });

  it('spans the whole schema range: 0 and the 100% ceiling `.max(1)` allows', () => {
    expect(aliquotaParaCampo(0)).toBe(0);
    expect(aliquotaParaCampo(1)).toBe(100);
    expect(campoParaAliquota(100)).toBe(1);
  });

  it('⚠️ round-trips EXACTLY, which a bare × 100 does not', () => {
    // The defect this pair exists to prevent, stated as the arithmetic itself:
    // both raw operations are off by an ulp, and neither is visible at any
    // scale the field renders — so an untouched form would look identical and
    // still re-save a different number every time it was opened.
    expect(0.06728 * 100).not.toBe(6.728);
    expect(6.728 / 100).not.toBe(0.06728);

    // Every value the input can express: `decimalScale={4}` on a percentage is
    // six decimals of a fraction. Sampled across the whole 0–1 domain.
    for (let i = 0; i <= 1_000_000; i += 7) {
      const fracao = i / 1e6;
      expect(campoParaAliquota(aliquotaParaCampo(fracao))).toBe(fracao);
    }
  });

  it('⚠️ NEAR-MISS: two rates one ten-thousandth of a percent apart stay distinct', () => {
    // The fold must not reach further than the input's own precision. 6,7280%
    // and 6,7281% are different rates, and the `dirty` check that enables the
    // Save button is an equality over exactly these values — a rounding one
    // digit coarser would report a real edit as "nothing changed".
    expect(campoParaAliquota(6.728)).not.toBe(campoParaAliquota(6.7281));
    expect(aliquotaParaCampo(0.06728)).not.toBe(aliquotaParaCampo(0.067281));
  });
});

/**
 * ⚠️ These three replace an e2e assertion that could not survive: the panel's
 * read needs Firestore rules that this change GENERATES and a human DEPLOYS, so
 * on staging it is denied and the panel renders its error alert. That made the
 * old assertion a claim about a deployment state (`apps/web/CLAUDE.md` rule 8) —
 * green the day the rules ship, red on every PR until then. Here the read is the
 * test's own to decide, so all three states are reachable deterministically.
 */
describe('SimplesNacionalPanel — the three query states stay distinct', () => {
  function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MantineTestProvider>
        <QueryClientProvider client={client}>
          <SimplesNacionalPanel filialId="f1" />
        </QueryClientProvider>
      </MantineTestProvider>,
    );
  }

  it('a MISSING document offers to create one, and shows no apuração badge', () => {
    // Never apurada ⇒ no state alert at all. An invented badge would imply a run
    // that never happened.
    getDoc.mockResolvedValueOnce({ exists: () => false });
    renderPanel();
    return waitFor(() => {
      expect(screen.getByText(/simples nacional ainda não configurado/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /criar configuração/i })).toBeTruthy();
      expect(screen.queryByText(/alíquota vigente/i)).toBeNull();
      expect(screen.queryByText(/apuração incompleta/i)).toBeNull();
    });
  });

  it('a DENIED read reads as a load failure, never as "not configured"', () => {
    // The distinction is the whole point: "no document" invites a create, while
    // "could not read" must not — creating over a document you were not allowed
    // to see is how one of two rate configs gets discarded silently.
    getDoc.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    renderPanel();
    return waitFor(() => {
      expect(
        screen.getByText(/falha ao carregar a configuração do simples nacional/i),
      ).toBeTruthy();
      expect(screen.queryByText(/ainda não configurado/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /criar configuração/i })).toBeNull();
    });
  });

  it('an EXISTING document shows the apuração and offers to save, not to create', async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        anexo: 'I',
        aliquotaDeclarada: 0.06728,
        recalculoAutomatico: true,
        rbt12: 1_000_000,
        faixa: 4,
        aliquotaEfetiva: 0.0891,
        competencia: '2026-08',
        estadoApuracao: APURACAO_ESTADO.vigente,
        notasIlegiveis: 0,
        calculadoEm: null,
        filiaisConsolidadas: [],
      }),
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^salvar$/i })).toBeTruthy();
    });
    expect(screen.queryByText(/ainda não configurado/i)).toBeNull();
    expect(screen.getByText(/alíquota vigente/i)).toBeTruthy();
    expect(screen.getByText('2026-08')).toBeTruthy();
  });
});
