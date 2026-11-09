/**
 * The Easy Ship scheduling's two entries (step 15, PR 15-c), offline: E1 (the
 * NF-e acceptance seam) and E2 (the order import), each through the REAL
 * producer over the recording queue of `testing/produtorAgendamento.ts` (a
 * Cloud Tasks stand-in that keeps every name it accepted, and refuses a held
 * one with the SDK's own 409). The failure policy is driven with the Admin
 * SDK's REAL error classes. No network, no Firestore: the enqueue is the whole
 * effect.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import type { DepsDestinoAceiteNfeAmazon } from '../nfe/destinoAceite';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import { loggerEspiao } from '../testing/fixtures';
import { filaAgendamentoDeTeste } from '../testing/produtorAgendamento';
import {
  AmazonAgendamentoRegiaoDaFilaInvalidaError,
  type AgendadorAgendamentoAmazon,
} from './agendadorAgendamento';
import {
  MOTIVO_ENTRADA_AGENDAMENTO_AMAZON,
  enfileirarAgendamentoDaImportacaoAmazon,
  enfileirarAgendamentoDoAceiteAmazon,
} from './entradasAgendamento';
import {
  ATRASO_AGENDAMENTO_DO_ACEITE_S,
  ORIGEM_AGENDAMENTO_AMAZON,
  idDaTarefaDeAgendamentoAmazon,
  tarefaAgendamentoAmazonSchema,
} from './tarefaAgendamento';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const ID_TAREFA_NFE = 'tarefa-nfe-sintetica-0001';
const WATERMARK_US = 1_790_000_000_000_000;

const ACEITE = { contaId: CONTA, pedidoId: PEDIDO_ID, nfeId: 's1', orderId: ORDER };
const IMPORTACAO = {
  contaId: CONTA,
  pedidoId: PEDIDO_ID,
  orderId: ORDER,
  watermarkUs: WATERMARK_US,
};

const sha = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');
const NOME_E1 = sha(`agendamento:aceite:${ID_TAREFA_NFE}`);
const NOME_E2 = sha(`agendamento:importacao:${PEDIDO_ID}:${String(WATERMARK_US)}`);

/** Every `fetch` is a failure: no entry reaches the network (D11). */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function montar(over: Partial<DepsDestinoAceiteNfeAmazon> = {}) {
  const fila = filaAgendamentoDeTeste();
  const log = loggerEspiao();
  const depsE1: DepsDestinoAceiteNfeAmazon = {
    agendamento: fila.produtor,
    logger: log.logger,
    idTarefa: ID_TAREFA_NFE,
    ultimaTentativa: false,
    ...over,
  };
  const depsE2 = {
    agendamento: fila.produtor,
    logger: log.logger,
    registro: { tentativa: 0, idTarefa: 'tarefa-leitura-1' },
  };
  return { fila, log, depsE1, depsE2 };
}

/** A producer whose named enqueue throws `err` (a bug or a refusal the real one never names). */
function produtorQueLanca(err: unknown): () => AgendadorAgendamentoAmazon {
  return () => ({
    enfileirarEntrada: () => Promise.reject(err),
    enfileirar: () => Promise.reject(new TypeError('teste: nunca chamado por uma entrada')),
  });
}

describe('E1 — the NF-e acceptance seam', () => {
  it('★ ONE enqueue: origem aceite-nfe, the 60-s delay, named sha256("agendamento:aceite:" + the NF-e task id); no line on success', async () => {
    const { fila, log, depsE1 } = montar();
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);

    expect(fila.enfileiradas).toEqual([
      {
        tarefa: {
          pedidoId: PEDIDO_ID,
          contaId: CONTA,
          orderId: ORDER,
          origem: 'aceite-nfe',
          espera: 0,
          pausas: 0,
        },
        id: NOME_E1,
        atrasoS: ATRASO_AGENDAMENTO_DO_ACEITE_S,
      },
    ]);
    expect(ATRASO_AGENDAMENTO_DO_ACEITE_S).toBe(60);
    expect(tarefaAgendamentoAmazonSchema.safeParse(fila.enfileiradas[0]?.tarefa).success).toBe(
      true,
    );
    expect(log.linhas).toEqual([]);
  });

  it('★ NEAR-MISS: a queue retry of the SAME NF-e task reuses the name (ja-enfileirada, ONE INFO line); a re-drive’s NEW NF-e task gets a new one', async () => {
    const { fila, log, depsE1 } = montar();
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);
    expect(fila.tentativas.map((t) => t.id)).toEqual([NOME_E1, NOME_E1]);
    expect(fila.enfileiradas).toHaveLength(1);
    expect(log.linhas).toEqual([
      {
        nivel: 'info',
        mensagem: expect.any(String) as string,
        meta: expect.objectContaining({
          evento: 'agendamento',
          motivo: MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.jaEnfileirada,
          origem: 'aceite-nfe',
          pedidoId: PEDIDO_ID,
          pedido: ORDER,
          conta: CONTA,
          fluxo: 'agendamento',
          idTarefa: ID_TAREFA_NFE,
          erro: null,
        }) as unknown,
      },
    ]);

    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, { ...depsE1, idTarefa: 'tarefa-nfe-2' });
    expect(fila.enfileiradas.map((t) => t.id)).toEqual([
      NOME_E1,
      sha('agendamento:aceite:tarefa-nfe-2'),
    ]);
  });

  it('★ (mutation 2) the tasks valve closed ⇒ ONE WARNING agendamento-nao-enfileirado naming the class, and NO throw on attempt 0', async () => {
    const { fila, log, depsE1 } = montar();
    fila.desligado = true;
    await expect(enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1)).resolves.toBeUndefined();
    expect(fila.tentativas).toEqual([]);
    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: {
        evento: 'agendamento',
        motivo: MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.naoEnfileirado,
        erro: 'AmazonAgendamentoTarefasDesligadasError',
        origem: 'aceite-nfe',
      },
    });
  });

  it.each<[string, () => unknown, string]>([
    [
      'a missing region',
      () => new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']),
      'MissingRegionError',
    ],
    [
      'a malformed region',
      () => new AmazonAgendamentoRegiaoDaFilaInvalidaError(),
      'AmazonAgendamentoRegiaoDaFilaInvalidaError',
    ],
    [
      'a raw SDK failure (403, a broken deploy)',
      () => falhaDoFunctions('permission-denied', 403),
      'FirebaseFunctionsError/functions/permission-denied',
    ],
  ])(
    '★ (mutation 17) %s is DETERMINISTIC ⇒ ONE WARNING, never a throw (a retry would only repeat it)',
    async (_c, falha, classe) => {
      const { fila, log, depsE1 } = montar();
      fila.falha = falha;
      await expect(enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1)).resolves.toBeUndefined();
      expect(log.linhas).toHaveLength(1);
      expect(log.linhas[0]).toMatchObject({
        nivel: 'warn',
        meta: { motivo: 'agendamento-nao-enfileirado', erro: classe },
      });
      // Never the SDK's message, which quotes the answered body.
      expect(JSON.stringify(log.linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    },
  );

  it.each<[string, () => unknown]>([
    ['a Cloud Tasks 503', () => falhaDoFunctions('unknown-error', 503)],
    ['a socket failure', () => falhaDoApp('network-error')],
  ])(
    '★ (mutation 17) a TRANSIENT (%s) RETHROWS on a non-last attempt — the NF-e dispatch owns the edge and retries',
    async (_c, falha) => {
      const { fila, log, depsE1 } = montar();
      fila.falha = falha;
      await expect(enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1)).rejects.toBeInstanceOf(
        AmazonTarefasTransitoriasError,
      );
      // The edge is NOT consumed by a log line.
      expect(log.linhas).toEqual([]);
    },
  );

  it('★ …and on the NF-e queue’s LAST attempt the same transient is the WARNING, no throw', async () => {
    const { fila, log, depsE1 } = montar({ ultimaTentativa: true });
    fila.falha = () => falhaDoFunctions('unknown-error', 503);
    await expect(enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1)).resolves.toBeUndefined();
    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: { motivo: 'agendamento-nao-enfileirado', erro: 'AmazonTarefasTransitoriasError' },
    });
    expect(JSON.stringify(log.linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('★ an unnamed failure from the producer PROPAGATES (rule 6) — a TypeError, a ZodError — even on the last attempt', async () => {
    for (const err of [new TypeError('bug'), new ZodError([])]) {
      const { log, depsE1 } = montar({ ultimaTentativa: true, agendamento: produtorQueLanca(err) });
      await expect(enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1)).rejects.toBe(err);
      expect(log.linhas).toEqual([]);
    }
  });

  it('an NF-e dispatch with no task id enqueues UNNAMED (never a name every such enqueue shares)', async () => {
    const { fila, depsE1 } = montar({ idTarefa: null });
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);
    expect(fila.enfileiradas.map((t) => [t.id, t.atrasoS])).toEqual([
      [null, 60],
      [null, 60],
    ]);
  });
});

describe('E2 — the order import', () => {
  it('★ ONE enqueue: origem importacao, NO delay, named sha256("agendamento:importacao:" + pedidoId + ":" + watermarkUs)', async () => {
    const { fila, log, depsE2 } = montar();
    expect(await enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, depsE2)).toBe('enfileirada');
    expect(fila.enfileiradas).toEqual([
      {
        tarefa: expect.objectContaining({ origem: 'importacao', espera: 0, pausas: 0 }) as unknown,
        id: NOME_E2,
        atrasoS: 0,
      },
    ]);
    expect(
      idDaTarefaDeAgendamentoAmazon({
        origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
        pedidoId: PEDIDO_ID,
        watermarkUs: WATERMARK_US,
      }),
    ).toBe(NOME_E2);
    expect(log.linhas).toEqual([]);
  });

  it('★ a redelivery of the SAME read dedupes (ja-enfileirada, ONE INFO line with the import’s attempt); a NEWER read lands', async () => {
    const { fila, log, depsE2 } = montar();
    await enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, depsE2);
    expect(
      await enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, {
        ...depsE2,
        registro: { tentativa: 1, idTarefa: 'tarefa-leitura-1' },
      }),
    ).toBe('ja-enfileirada');
    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toMatchObject({
      nivel: 'info',
      meta: { motivo: 'ja-enfileirada', origem: 'importacao', tentativa: 1 },
    });
    expect(
      await enfileirarAgendamentoDaImportacaoAmazon(
        { ...IMPORTACAO, watermarkUs: WATERMARK_US + 1 },
        depsE2,
      ),
    ).toBe('enfileirada');
    expect(fila.enfileiradas).toHaveLength(2);
  });

  it('★ (mutation 3) THE TOMBSTONE CASE: the E1 task of the same pedido RAN (its name still held) — the E2 lands under its OWN name', async () => {
    const { fila, depsE1, depsE2 } = montar();
    await enfileirarAgendamentoDoAceiteAmazon(ACEITE, depsE1);
    expect(fila.nomes.has(NOME_E1)).toBe(true);
    expect(await enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, depsE2)).toBe('enfileirada');
    expect(fila.enfileiradas.map((t) => t.id)).toEqual([NOME_E1, NOME_E2]);
    expect(NOME_E2).not.toBe(NOME_E1);
  });

  it('★ the tasks valve closed ⇒ ONE WARNING, nothing thrown', async () => {
    const { fila, log, depsE2 } = montar();
    fila.desligado = true;
    expect(await enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, depsE2)).toBe(
      'nao-enfileirada',
    );
    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: {
        motivo: 'agendamento-nao-enfileirado',
        erro: 'AmazonAgendamentoTarefasDesligadasError',
        origem: 'importacao',
      },
    });
  });

  it('★ a TRANSIENT ALWAYS rethrows (the import’s own retry owns the edge) — whatever the import’s attempt', async () => {
    for (const tentativa of [0, 3, null]) {
      const { fila, log, depsE2 } = montar();
      fila.falha = () => falhaDoFunctions('unknown-error', 503);
      await expect(
        enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, {
          ...depsE2,
          registro: { tentativa, idTarefa: null },
        }),
      ).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
      expect(log.linhas).toEqual([]);
    }
  });

  it('an unnamed failure propagates', async () => {
    const err = new TypeError('bug');
    const { log, depsE2 } = montar();
    await expect(
      enfileirarAgendamentoDaImportacaoAmazon(IMPORTACAO, {
        ...depsE2,
        agendamento: produtorQueLanca(err),
      }),
    ).rejects.toBe(err);
    expect(log.linhas).toEqual([]);
  });

  it('a pedido id outside its grammar is a bug: refused before the queue, as a rejection', async () => {
    const { fila, depsE2 } = montar();
    await expect(
      enfileirarAgendamentoDaImportacaoAmazon({ ...IMPORTACAO, pedidoId: 'x' }, depsE2),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fila.tentativas).toEqual([]);
  });
});
