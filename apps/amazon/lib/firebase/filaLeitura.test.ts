/**
 * The App Hosting composition root of the reads queue. The Admin SDK's
 * `getFunctions` is mocked (a recording queue): nothing reaches Cloud Tasks.
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import { TASKS_REGION_ENV } from '../amazon/env';
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

const { agendadorDaFilaLeituraAmazon, filaLeituraDesligadaAmazon, regiaoDaFilaLeituraAmazon } =
  await import('./filaLeitura');

const PAYLOAD: PayloadNotificacaoAmazon = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.push,
  sellerId: 'AXXXXXXXXXXXXX',
  amazonOrderId: '000-0000000-0000001',
  notificationId: '00000000-0000-0000-0000-000000000001',
  publishTimeMs: 1,
};

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
