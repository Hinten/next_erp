/**
 * The App Hosting composition root of the stock routes' producers (master plan step 12, PR 12-h):
 * the stock queue and the reads queue, the region and the sweep-only valve read on THIS surface.
 * The Admin SDK's `getFunctions` is mocked (a recording queue): nothing reaches Cloud Tasks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
} from '@delfrance/schemas';

import {
  LiTarefasDesligadasError,
  enfileirarTarefaEstoqueLi,
} from '../lojaIntegrada/estoque/agendadorEstoque';

const h = vi.hoisted(() => ({
  caminhos: [] as string[],
  chamadas: [] as unknown[][],
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', async (importOriginal) => {
  const original = await importOriginal<typeof import('firebase-admin/functions')>();
  return { ...original, getFunctions: h.getFunctions };
});

vi.mock('./admin', () => ({ getAdminApp: () => ({ name: 'app-de-teste' }) }));

const {
  agendadorEstoqueLiDoAppHosting,
  agendadorReconcileLiDoAppHosting,
  regiaoDasFilasLiAppHosting,
  tarefasLiDesligadasNoAppHosting,
} = await import('./filasLi');

const REGIAO = 'southamerica-east1';
const AGORA = Date.UTC(2027, 0, 15, 15, 0, 10);
const RECONCILE = {
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: 'estoque-reconcile-manual-1800000000000',
  seq: 0,
} as const;

function ambiente(o: { regiao?: string; functions?: string; desligado?: string }): void {
  vi.stubEnv('LOJA_INTEGRADA_TASKS_REGION', o.regiao ?? '');
  vi.stubEnv('FUNCTIONS_REGION', o.functions ?? '');
  vi.stubEnv('LOJA_INTEGRADA_TASKS_DISABLED', o.desligado ?? '');
}

const enviarEstoque = () =>
  enfileirarTarefaEstoqueLi(agendadorEstoqueLiDoAppHosting(), () => AGORA, {
    contaId: 'C1',
    produtoId: 'f1',
    origem: ORIGEM_TAREFA_ESTOQUE_LI.manual,
    estoqueId: null,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
  });

beforeEach(() => {
  h.caminhos.length = 0;
  h.chamadas.length = 0;
  h.getFunctions.mockReset();
  h.getFunctions.mockImplementation(() => ({
    taskQueue: (caminho: string) => {
      h.caminhos.push(caminho);
      return {
        enqueue: (...args: unknown[]) => {
          h.chamadas.push(args);
          return Promise.resolve();
        },
      };
    },
  }));
  vi.stubGlobal('fetch', () => {
    throw new Error('filasLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the two queues', () => {
  it('the manual push enqueues onto filaEstoqueLojaIntegrada in the region, with its id and schedule', async () => {
    ambiente({ regiao: REGIAO });
    await enviarEstoque();
    expect(h.caminhos).toEqual([`locations/${REGIAO}/functions/filaEstoqueLojaIntegrada`]);
    const [tarefa, opcoes] = h.chamadas[0] ?? [];
    expect(tarefa).toMatchObject({ tipo: TIPO_TAREFA_ESTOQUE_LI.estoque, produtoId: 'f1' });
    expect(Object.keys(opcoes as object).sort()).toEqual(['id', 'scheduleTime']);
  });

  it('the reconcile enqueues its first slice onto filaLeituraLojaIntegrada, the id alone (delay 0) — never the writes queue', async () => {
    ambiente({ regiao: REGIAO });
    await agendadorReconcileLiDoAppHosting().enfileirar(RECONCILE, { atrasoS: 0 });
    expect(h.caminhos).toEqual([`locations/${REGIAO}/functions/filaLeituraLojaIntegrada`]);
    expect(h.chamadas[0]?.[1]).toEqual({ id: `li-${RECONCILE.execucaoId}-0` });
    expect(h.caminhos.some((c) => c.includes('filaEscrita'))).toBe(false);
  });

  it('FUNCTIONS_REGION is the fallback, LOJA_INTEGRADA_TASKS_REGION wins over it', async () => {
    ambiente({ functions: 'us-x1' });
    expect(regiaoDasFilasLiAppHosting()).toBe('us-x1');
    ambiente({ regiao: REGIAO, functions: 'us-x1' });
    expect(regiaoDasFilasLiAppHosting()).toBe(REGIAO);
  });
});

describe('the region guard: no default, ever (#1108)', () => {
  it.each([
    ['unset', undefined],
    ['blank', ''],
  ])(
    'a region %s rejects the ENQUEUE with MissingRegionError — never the producer build, never a guessed queue',
    async (_caso, valor) => {
      vi.stubEnv('LOJA_INTEGRADA_TASKS_REGION', valor ?? '');
      vi.stubEnv('FUNCTIONS_REGION', '');
      vi.stubEnv('LOJA_INTEGRADA_TASKS_DISABLED', '');
      // Building the producers reads no region.
      const estoque = agendadorEstoqueLiDoAppHosting();
      const reconcile = agendadorReconcileLiDoAppHosting();
      expect(estoque).toBeDefined();
      await expect(enviarEstoque()).rejects.toBeInstanceOf(MissingRegionError);
      await expect(reconcile.enfileirar(RECONCILE, { atrasoS: 0 })).rejects.toBeInstanceOf(
        MissingRegionError,
      );
      expect(h.caminhos).toEqual([]);
      expect(() => regiaoDasFilasLiAppHosting()).toThrow(MissingRegionError);
    },
  );
});

describe('the sweep-only valve', () => {
  it("exactly '1' closes both producers: LiTarefasDesligadasError, the SDK never touched, no region needed", async () => {
    ambiente({ desligado: '1' });
    expect(tarefasLiDesligadasNoAppHosting()).toBe(true);
    await expect(enviarEstoque()).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    await expect(
      agendadorReconcileLiDoAppHosting().enfileirar(RECONCILE, { atrasoS: 0 }),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it.each([['1 '], [' 1'], ['true'], ['0'], ['']])(
    '⚠️ NEAR-MISS: LOJA_INTEGRADA_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ regiao: REGIAO, desligado: valor });
      expect(tarefasLiDesligadasNoAppHosting()).toBe(false);
      await enviarEstoque();
      expect(h.chamadas).toHaveLength(1);
    },
  );
});

describe('the source', () => {
  const fonte = readFileSync(fileURLToPath(new URL('./filasLi.ts', import.meta.url)), 'utf8');

  it('ONE getFunctions( call, requireRegion as STATIC env members, no region literal', () => {
    // Code only: the header names the call too.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(codigo.match(/\bgetFunctions\s*\(/g) ?? []).toHaveLength(1);
    expect(fonte.replace(/\r\n/g, '\n')).toContain(
      [
        'requireRegion({',
        '    LOJA_INTEGRADA_TASKS_REGION: process.env.LOJA_INTEGRADA_TASKS_REGION,',
        '    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,',
        '  })',
      ].join('\n'),
    );
    expect(fonte).not.toMatch(/\b(?:us|southamerica|europe|asia)-[a-z]+\d\b/);
    expect(codigo).not.toContain('oidcToken');
  });
});
