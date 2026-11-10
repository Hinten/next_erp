import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  STATUS_IMPORTACAO_LI,
} from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { respostaImportacaoLiFalsa as job } from '@/lib/testing/importacaoLiFalsa';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * One conta's product-import card (master plan step 9): what it reads, what it
 * shows from the job answer, Cancelar, "sem progresso" and the way into an
 * ended job's result.
 *
 * Only the backend hook is replaced: the error classes, the hooks and the copy
 * are the REAL ones. The ids are obviously fake.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as LojaIntegradaClient | null },
}));

vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({ client: h.clientRef.current, indisponivel: null }),
  };
});

const { CartaoImportacaoLi, linhasDosContadoresLi, resumoDasOpcoesLi, textoListagemDivergenteLi } =
  await import('./CartaoImportacaoLi');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');
const { MENSAGEM_BACKEND_SEM_IMPORTACAO_LI } = await import('@/lib/loja-integrada/importacao');
const { MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI } =
  await import('@/lib/loja-integrada/importacaoRotulos');
const { SEM_PROGRESSO_MS } = await import('@/lib/marketplace/contaJobs/cadencia');

const CONTA: ContaRef = { id: 'conta-falsa-1', nome: 'Conta A' };

function renderCartao(cartao: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{cartao}</QueryClientProvider>
    </MantineTestProvider>,
  );
}

interface Props {
  jobId?: string;
  jobDaLista?: RespostaImportacaoLi | null;
  reatado?: boolean;
  podeCancelar?: boolean;
  onDismiss?: () => void;
  onAbrirResultado?: (alvo: { conta: ContaRef; job: RespostaImportacaoLi }) => void;
}

function cartao(p: Props = {}) {
  return (
    <CartaoImportacaoLi
      conta={CONTA}
      jobId={p.jobId ?? 'job-falso-1'}
      jobDaLista={p.jobDaLista ?? null}
      reatado={p.reatado ?? false}
      podeCancelar={p.podeCancelar ?? true}
      onDismiss={p.onDismiss ?? vi.fn()}
      {...(p.onAbrirResultado ? { onAbrirResultado: p.onAbrirResultado } : {})}
    />
  );
}

const CONTADORES = {
  familias: 40,
  vinculados: 30,
  criados: 5,
  completados: 4,
  semMudanca: 1,
  pendenciasAcionaveis: 3,
  pendenciasInformativas: 1,
  fotos: 0,
  falhas: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pure lines', () => {
  it('the options: the Completar-only two appear only under Completar', () => {
    const completar = {
      alvo: ALVO_IMPORTACAO_LI.naoNoErp,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: 0,
    };
    expect(resumoDasOpcoesLi(completar)).toBe(
      'Só os que ainda não estão no ERP · Completar · Categorias: Criar e vincular as que faltam · Fotos: Só em produtos sem foto',
    );
    // NEAR MISS — the same stored values under "Só vincular" say nothing about them.
    expect(resumoDasOpcoesLi({ ...completar, acao: ACAO_IMPORTACAO_LI.soVincular })).toBe(
      'Só os que ainda não estão no ERP · Só vincular',
    );
    expect(
      resumoDasOpcoesLi({
        ...completar,
        alvo: ALVO_IMPORTACAO_LI.selecionados,
        acao: ACAO_IMPORTACAO_LI.soVincular,
        selecionados: 12,
      }),
    ).toBe('Selecionados (12) · Só vincular');
  });

  it('the counters: done under Importar, proposed under Simular; photos and failures only when non-zero', () => {
    const aplicar = job({ contadores: CONTADORES });
    expect(linhasDosContadoresLi(aplicar)).toEqual([
      '40 produtos lidos da loja',
      '30 vinculados · 5 criados · 4 completados · 1 sem mudança',
      '3 pendências a resolver · 1 informativa',
    ]);
    expect(
      linhasDosContadoresLi({ ...aplicar, modo: MODO_IMPORTACAO_LI.simular }).slice(1, 2),
    ).toEqual(['30 a vincular · 5 a criar · 4 a completar · 1 sem mudança']);
    expect(
      linhasDosContadoresLi({ ...aplicar, contadores: { ...CONTADORES, fotos: 1, falhas: 2 } }).at(
        -1,
      ),
    ).toBe('1 foto copiada · 2 falhas');
    // One of each reads in the singular, done or proposed.
    const um = { ...CONTADORES, vinculados: 1, criados: 1, completados: 1, fotos: 1 };
    expect(linhasDosContadoresLi({ ...aplicar, contadores: um })[1]).toBe(
      '1 vinculado · 1 criado · 1 completado · 1 sem mudança',
    );
    expect(
      linhasDosContadoresLi({ ...aplicar, modo: MODO_IMPORTACAO_LI.simular, contadores: um }).at(
        -1,
      ),
    ).toBe('1 foto a copiar');
  });

  it('⭐ the store’s count shows ONLY when the backend flagged the listing divergent', () => {
    expect(textoListagemDivergenteLi({ linhas: 118, totalLi: 120, divergente: true })).toMatch(
      /^A loja informou 120 produtos e a leitura achou 118 produtos:/,
    );
    // NEAR MISS — different numbers, but the backend did not flag them: nothing.
    expect(textoListagemDivergenteLi({ linhas: 118, totalLi: 120, divergente: false })).toBeNull();
    expect(textoListagemDivergenteLi({ linhas: 1, totalLi: null, divergente: true })).toMatch(
      /^A leitura achou 1 produto, um número diferente do que a loja informou:/,
    );
  });
});

describe('CartaoImportacaoLi', () => {
  it('polls ITS job and shows status, mode, options, phase and counters', async () => {
    const importacao = vi.fn(async () =>
      job({
        acao: ACAO_IMPORTACAO_LI.completar,
        categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
        contadores: CONTADORES,
      }),
    );
    h.clientRef.current = lojaIntegradaClientFalso({ importacao });
    renderCartao(cartao());

    expect(await screen.findByText('Em andamento')).not.toBeNull();
    expect(screen.getByText('Importar')).not.toBeNull();
    expect(screen.getByText(/Completar · Categorias: Criar e vincular/)).not.toBeNull();
    expect(screen.getByText('Processando os produtos')).not.toBeNull();
    expect(
      screen.getByText('30 vinculados · 5 criados · 4 completados · 1 sem mudança'),
    ).not.toBeNull();
    expect(importacao).toHaveBeenCalledWith('conta-falsa-1', 'job-falso-1', expect.anything());
  });

  it('⭐ an ENDED job the list holds is shown as is — no read at all', async () => {
    const importacao = vi.fn(async () => job());
    h.clientRef.current = lojaIntegradaClientFalso({ importacao });
    renderCartao(
      cartao({
        jobDaLista: job({ status: STATUS_IMPORTACAO_LI.concluido, concluidoEmMs: Date.now() }),
      }),
    );

    expect(screen.getByText('Concluída')).not.toBeNull();
    expect(screen.getByText('Importação concluída.')).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(importacao).not.toHaveBeenCalled();
  });

  it('NEAR MISS — a RUNNING job the list holds is still polled', async () => {
    const importacao = vi.fn(async () => job({ fase: FASE_IMPORTACAO_LI.revisao }));
    h.clientRef.current = lojaIntegradaClientFalso({ importacao });
    renderCartao(cartao({ jobDaLista: job({ fase: FASE_IMPORTACAO_LI.listagem }) }));

    // The list's copy first, the poll's answer next.
    expect(screen.getByText('Lendo a lista de produtos da loja')).not.toBeNull();
    expect(await screen.findByText('Conferindo a lista de revisão fiscal')).not.toBeNull();
    expect(importacao).toHaveBeenCalledTimes(1);
  });

  it('a Simular says nothing is written, and its end says so too', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    renderCartao(
      cartao({
        jobDaLista: job({
          modo: MODO_IMPORTACAO_LI.simular,
          status: STATUS_IMPORTACAO_LI.concluido,
        }),
      }),
    );
    expect(
      screen.getByText(
        'Simulação: os números dizem o que uma importação faria; nada é gravado no ERP.',
      ),
    ).not.toBeNull();
    expect(screen.getByText('Simulação concluída: nada foi gravado no ERP.')).not.toBeNull();
  });

  it('shows the divergent count, the 429 pauses and the skipped photos when the job says so', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    renderCartao(
      cartao({
        jobDaLista: job({
          status: STATUS_IMPORTACAO_LI.concluido,
          listagem: { paginas: 2, linhas: 118, totalLi: 120, divergente: true },
          pausas429: 2,
          fotosIndisponiveis: true,
        }),
      }),
    );
    expect(screen.getByText(/A loja informou 120 produtos e a leitura achou 118/)).not.toBeNull();
    expect(screen.getByText(/limitou as chamadas 2 vezes/)).not.toBeNull();
    expect(screen.getByText(/Fotos indisponíveis:/)).not.toBeNull();
  });

  it('NEAR MISS — none of those three lines on a job that does not stamp them', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    renderCartao(cartao({ jobDaLista: job({ status: STATUS_IMPORTACAO_LI.concluido }) }));
    expect(screen.queryByText(/A loja informou/)).toBeNull();
    expect(screen.queryByText(/limitou as chamadas/)).toBeNull();
    expect(screen.queryByText(/Fotos indisponíveis/)).toBeNull();
  });

  it('a failed job shows its motivo’s copy; an unknown motivo is quoted, never hidden', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    const { unmount } = renderCartao(
      cartao({
        jobDaLista: job({
          status: STATUS_IMPORTACAO_LI.falhou,
          motivo: MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas,
        }),
      }),
    );
    expect(
      screen.getByText(
        MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI[MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas],
      ),
    ).not.toBeNull();
    unmount();

    renderCartao(
      cartao({ jobDaLista: job({ status: STATUS_IMPORTACAO_LI.falhou, motivo: 'motivo-novo' }) }),
    );
    expect(screen.getByText(/motivo "motivo-novo"/)).not.toBeNull();
  });

  it('a busy start’s job says the options picked now were not applied', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    renderCartao(
      cartao({ reatado: true, jobDaLista: job({ status: STATUS_IMPORTACAO_LI.concluido }) }),
    );
    expect(screen.getByText(/As opções escolhidas agora não foram aplicadas\./)).not.toBeNull();
  });

  it('⭐ Cancelar goes through the backend and the card shows the cancelled job', async () => {
    const cancelarImportacao = vi.fn(async () => job({ status: STATUS_IMPORTACAO_LI.cancelado }));
    h.clientRef.current = lojaIntegradaClientFalso({
      importacao: vi.fn(async () => job()),
      cancelarImportacao,
    });
    renderCartao(cartao());
    await screen.findByText('Em andamento');

    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar importação' }));

    expect(
      await screen.findByText('Importação cancelada. O que ela já gravou no ERP permanece.'),
    ).not.toBeNull();
    expect(cancelarImportacao).toHaveBeenCalledWith('conta-falsa-1', 'job-falso-1');
  });

  it('NEAR MISS — without the write permission the X only hides the card: no confirm, no cancel', async () => {
    const onDismiss = vi.fn();
    h.clientRef.current = lojaIntegradaClientFalso({ importacao: vi.fn(async () => job()) });
    renderCartao(cartao({ podeCancelar: false, onDismiss }));
    await screen.findByText('Em andamento');

    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancelar importação' })).toBeNull();
  });

  it('⭐ "Ver resultado" only for an ENDED job, handing over the conta and the job', async () => {
    const onAbrirResultado = vi.fn();
    const encerrado = job({ status: STATUS_IMPORTACAO_LI.concluido });
    h.clientRef.current = lojaIntegradaClientFalso({ importacao: vi.fn(async () => job()) });
    const { unmount } = renderCartao(cartao({ jobDaLista: encerrado, onAbrirResultado }));

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(onAbrirResultado).toHaveBeenCalledWith({ conta: CONTA, job: encerrado });
    unmount();

    // NEAR MISS — the same card on a running job offers no way in.
    renderCartao(cartao({ onAbrirResultado }));
    await screen.findByText('Em andamento');
    expect(screen.queryByRole('button', { name: 'Ver resultado' })).toBeNull();
  });

  it('a backend without the import routes says so', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacao: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError('Não encontrado.', 404, null);
      }),
    });
    renderCartao(cartao());
    expect(await screen.findByText(MENSAGEM_BACKEND_SEM_IMPORTACAO_LI)).not.toBeNull();
  });

  it('⭐ flags a running job only once it has been silent for MORE than 45 minutes', async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 9, 14, 15, 0, 0);
    vi.setSystemTime(t0);
    const parado = job({
      iniciadoEmMs: t0 - 3_600_000,
      atualizadoEmMs: t0 - SEM_PROGRESSO_MS + 60_000,
    });
    h.clientRef.current = lojaIntegradaClientFalso({
      importacao: vi.fn(async () => ({ ...parado })),
    });
    renderCartao(cartao());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Em andamento')).not.toBeNull();
    // 44 min of silence: still quiet.
    expect(screen.queryByText(/Sem progresso desde/)).toBeNull();

    // Two more minutes of identical polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(
      screen.getByText(
        'Sem progresso desde 14/10 11:16 — se continuar assim, cancele e inicie de novo.',
      ),
    ).not.toBeNull();
  });
});
