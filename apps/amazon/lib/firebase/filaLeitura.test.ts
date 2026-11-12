/**
 * The App Hosting composition root of its three producers — the reads queue's
 * (the receiver), since step 14 (PR 14-d) the NF-e queue's (the re-drive
 * route), and since step 12a (PR 12-c) the jobs queue's (the receiver's feed
 * wake-up). The Admin SDK's `getFunctions` is mocked (a recording queue):
 * nothing reaches Cloud Tasks.
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import { TASKS_REGION_ENV } from '../amazon/env';
import { AmazonLotesTarefasDesligadasError } from '../amazon/feeds/agendadorLotes';
import {
  type TarefaLoteAmazon,
  nomeNotificacaoFeed,
  tarefaLoteAmazonSchema,
} from '../amazon/feeds/tarefaLote';
import { AmazonNfeTarefasDesligadasError } from '../amazon/nfe/agendadorNfe';
import { tarefaInicialNfeAmazon } from '../amazon/nfe/tarefaNfe';
import { AmazonTarefasDesligadasError } from '../amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '../amazon/notificacoes/notificacao';

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
  agendadorDaFilaLeituraAmazon,
  agendadorDaFilaLotesAmazon,
  agendadorDaFilaNfeAmazon,
  filaLeituraDesligadaAmazon,
  filaLotesDesligadaAmazon,
  filaNfeDesligadaAmazon,
  regiaoDaFilaLeituraAmazon,
} = await import('./filaLeitura');

const PAYLOAD: PayloadNotificacaoAmazon = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.push,
  sellerId: 'AXXXXXXXXXXXXX',
  amazonOrderId: '000-0000000-0000001',
  notificationId: '00000000-0000-0000-0000-000000000001',
  publishTimeMs: 1,
};

/** The re-drive route's payload: the builder's, for a synthetic pedido digest. */
const TAREFA_NFE = tarefaInicialNfeAmazon('a'.repeat(64), 's1');

/** The receiver's feed wake-up: no conta (the notification names a seller), rung 0. */
const FEED = '50001234567';
const DESPERTAR: TarefaLoteAmazon = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-resultado',
  contaId: null,
  feedId: FEED,
  rodada: 0,
  origem: 'notificacao',
});
const NOME_DESPERTAR = nomeNotificacaoFeed(null, FEED);

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
  vi.stubEnv('AMAZON_TASKS_REGION', '');
  vi.stubEnv('FUNCTIONS_REGION', '');
  vi.stubEnv('AMAZON_TASKS_DISABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('regiaoDaFilaLeituraAmazon', () => {
  it('AMAZON_TASKS_REGION first, then FUNCTIONS_REGION', () => {
    vi.stubEnv('FUNCTIONS_REGION', 'xx-funcoes-1');
    expect(regiaoDaFilaLeituraAmazon()).toBe('xx-funcoes-1');
    vi.stubEnv('AMAZON_TASKS_REGION', 'xx-tarefas-1');
    expect(regiaoDaFilaLeituraAmazon()).toBe('xx-tarefas-1');
  });

  it('NO default: both unset or blank ⇒ MissingRegionError naming both', () => {
    for (const valor of ['', '   ']) {
      vi.stubEnv('AMAZON_TASKS_REGION', valor);
      vi.stubEnv('FUNCTIONS_REGION', valor);
      const err = ((): MissingRegionError | null => {
        try {
          regiaoDaFilaLeituraAmazon();
          return null;
        } catch (e) {
          if (e instanceof MissingRegionError) return e;
          throw e;
        }
      })();
      expect(err).toBeInstanceOf(MissingRegionError);
      expect(err?.candidates).toEqual(['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
    }
  });

  it('reads both as STATIC process.env members, the first named as env.ts names it', () => {
    const fonte = readFileSync(new URL('./filaLeitura.ts', import.meta.url), 'utf8');
    expect(fonte).toContain('AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,');
    expect(fonte).toContain('FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,');
    expect(fonte).not.toMatch(/process\.env\[/);
    expect(TASKS_REGION_ENV).toBe('AMAZON_TASKS_REGION');
  });
});

describe('the sweep-only valve', () => {
  it.each([
    ['1', true],
    ['', false],
    ['0', false],
    ['true', false],
    [' 1', false],
    ['1 ', false],
  ])('AMAZON_TASKS_DISABLED=%j ⇒ closed: %s', (valor, fechada) => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', valor);
    expect(filaLeituraDesligadaAmazon()).toBe(fechada);
  });

  it('closed ⇒ every enqueue rejects AmazonTarefasDesligadasError and the SDK is never touched', async () => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    await expect(agendadorDaFilaLeituraAmazon().enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      AmazonTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
  });
});

describe('agendadorDaFilaLeituraAmazon', () => {
  it('enqueues on the region-qualified queue, the payload ALONE', async () => {
    vi.stubEnv('AMAZON_TASKS_REGION', 'xx-tarefas-1');
    await agendadorDaFilaLeituraAmazon().enfileirar(PAYLOAD);
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/filaLeituraAmazon']);
    expect(h.chamadas).toEqual([[PAYLOAD]]);
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it('an unset region rejects THAT enqueue (resolved per enqueue, never at module load)', async () => {
    const agendador = agendadorDaFilaLeituraAmazon();
    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.chamadas).toEqual([]);
  });
});

describe('agendadorDaFilaNfeAmazon (step 14, PR 14-d: the re-drive route’s producer)', () => {
  it('★ enqueues UNNAMED on the region-qualified NF-e queue, the payload ALONE (no id, no delay)', async () => {
    vi.stubEnv('AMAZON_TASKS_REGION', 'xx-tarefas-1');
    await agendadorDaFilaNfeAmazon().enfileirar(TAREFA_NFE);
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonNfeUpload']);
    expect(h.chamadas).toEqual([[TAREFA_NFE]]);
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it('the SAME region as the reads queue: FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset', async () => {
    vi.stubEnv('FUNCTIONS_REGION', 'xx-funcoes-1');
    await agendadorDaFilaNfeAmazon().enfileirar(TAREFA_NFE);
    await agendadorDaFilaLeituraAmazon().enfileirar(PAYLOAD);
    expect(h.caminhos).toEqual([
      'locations/xx-funcoes-1/functions/processAmazonNfeUpload',
      'locations/xx-funcoes-1/functions/filaLeituraAmazon',
    ]);
  });

  it.each([
    ['1', true],
    ['', false],
    ['true', false],
    [' 1', false],
  ])('the SAME valve: AMAZON_TASKS_DISABLED=%j ⇒ closed: %s, for both queues', (valor, fechada) => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', valor);
    expect(filaNfeDesligadaAmazon()).toBe(fechada);
    expect(filaLeituraDesligadaAmazon()).toBe(fechada);
  });

  it('closed ⇒ the enqueue rejects the NF-e queue’s OWN class and the SDK is never touched', async () => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    await expect(agendadorDaFilaNfeAmazon().enfileirar(TAREFA_NFE)).rejects.toBeInstanceOf(
      AmazonNfeTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('an unset region rejects THAT enqueue (resolved per enqueue, never at module load)', async () => {
    const agendador = agendadorDaFilaNfeAmazon();
    await expect(agendador.enfileirar(TAREFA_NFE)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.chamadas).toEqual([]);
  });

  it('★ the file has ONE `getFunctions(` call, shared by every producer, and reads the valve as a STATIC member once', () => {
    const fonte = readFileSync(new URL('./filaLeitura.ts', import.meta.url), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codigo.match(/\bgetFunctions\s*\(/g)).toHaveLength(1);
    expect(codigo.match(/process\.env\.AMAZON_TASKS_DISABLED/g)).toHaveLength(1);
    expect(codigo.match(/process\.env\.AMAZON_TASKS_REGION/g)).toHaveLength(1);
  });
});

describe('agendadorDaFilaLotesAmazon (step 12a, PR 12-c: the receiver’s SECOND producer)', () => {
  it('★ enqueues the wake-up NAMED on the region-qualified jobs queue, the payload and its name ALONE', async () => {
    vi.stubEnv('AMAZON_TASKS_REGION', 'xx-tarefas-1');
    await expect(
      agendadorDaFilaLotesAmazon().enfileirarLote(DESPERTAR, { nome: NOME_DESPERTAR }),
    ).resolves.toBe('enfileirada');
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonListingsJob']);
    expect(h.chamadas).toEqual([[DESPERTAR, { id: NOME_DESPERTAR }]]);
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it('the SAME region as the other two queues: FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset', async () => {
    vi.stubEnv('FUNCTIONS_REGION', 'xx-funcoes-1');
    await agendadorDaFilaLotesAmazon().enfileirarLote(DESPERTAR, { nome: NOME_DESPERTAR });
    await agendadorDaFilaLeituraAmazon().enfileirar(PAYLOAD);
    expect(h.caminhos).toEqual([
      'locations/xx-funcoes-1/functions/processAmazonListingsJob',
      'locations/xx-funcoes-1/functions/filaLeituraAmazon',
    ]);
  });

  it.each([
    ['1', true],
    ['', false],
    ['true', false],
    [' 1', false],
  ])(
    'the SAME valve: AMAZON_TASKS_DISABLED=%j ⇒ closed: %s, for all three queues',
    (valor, fechada) => {
      vi.stubEnv('AMAZON_TASKS_DISABLED', valor);
      expect(filaLotesDesligadaAmazon()).toBe(fechada);
      expect(filaNfeDesligadaAmazon()).toBe(fechada);
      expect(filaLeituraDesligadaAmazon()).toBe(fechada);
    },
  );

  it('closed ⇒ the enqueue rejects the jobs queue’s OWN class and the SDK is never touched', async () => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    const erro = await agendadorDaFilaLotesAmazon()
      .enfileirarLote(DESPERTAR, { nome: NOME_DESPERTAR })
      .then(
        () => expect.unreachable('o enqueue deveria ter rejeitado'),
        (e: unknown) => e,
      );
    expect(erro).toBeInstanceOf(AmazonLotesTarefasDesligadasError);
    expect(erro).not.toBeInstanceOf(AmazonTarefasDesligadasError);
    expect(erro).not.toBeInstanceOf(AmazonNfeTarefasDesligadasError);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('an unset region rejects THAT enqueue (resolved per enqueue, never at module load)', async () => {
    const agendador = agendadorDaFilaLotesAmazon();
    await expect(
      agendador.enfileirarLote(DESPERTAR, { nome: NOME_DESPERTAR }),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.chamadas).toEqual([]);
  });
});
