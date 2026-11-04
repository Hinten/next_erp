/**
 * The product import's job lifecycle on a real Firestore — the emulator of `ci-loja-integrada.yml`,
 * not the in-memory fake.
 *
 * `job.test.ts` and `despacho.test.ts` prove the decisions against `testing/fakeDb.ts`, which MODELS
 * how the server applies the one primitive the job rests on (`update(patch, { lastUpdateTime })`,
 * chained from each write's `writeTime`). This file proves what the fake cannot:
 *
 *  - the guard's query (`integracaoId == <conta> orderBy iniciadoEmMs desc limit 10`) runs on the
 *    server in exactly the shape of the ONE composite `firestore.indexes.json` declares for it, and
 *    answers newest first, this conta only;
 *  - a write's `writeTime` IS accepted as the next write's precondition (the chain every dispatch
 *    rides), and the end-of-dispatch checkpoint alone moves `seq`;
 *  - a unit checkpoint LOSES to a cancel landed between it and its read: the server refuses it with
 *    9, the re-read sees `cancelado`, and the checkpoint is never re-applied;
 *  - a dispatch of a stale `seq` reads the job and writes NOTHING (its update time unchanged).
 *
 * ⚠️ Every job here is seeded `executando` or `concluido`, never `pendente`: the job-creation
 * trigger the functions emulator loads enqueues only a job created `pendente`, so no dispatch races
 * these assertions. It writes no `integracao` and no `produtolojaintegrada` doc (the conta and link
 * triggers never fire for it), uses ids no other suite seeds, and deletes exactly what it reads in
 * `beforeEach`. `fetch` is never reached: nothing here calls Loja Integrada.
 */
import { readFileSync } from 'node:fs';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FASE_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_TAREFA_IMPORTACAO_LI,
  importacaoLojaIntegradaSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { despacharImportacaoLi } from './despacho';
import {
  cancelarImportacaoLi,
  gravarCheckpointDaUnidadeLi,
  gravarCheckpointDoFimDoDespachoLi,
  jobEmCursoDaContaLi,
  lerJobLi,
  listarImportacoesDaContaLi,
} from './job';

const EMULATED = Boolean(env.FIRESTORE_EMULATOR_HOST);

const JOBS = 'importacoesLojaIntegrada';
/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-importacao-fs';
const OUTRA_CONTA = 'conta-li-importacao-fs-2';
const IDS = {
  antigo: 'jobImportacaoFsAntigo01',
  emCurso: 'jobImportacaoFsEmCurso01',
  daOutra: 'jobImportacaoFsDaOutra01',
  cadeia: 'jobImportacaoFsCadeia001',
  cancelado: 'jobImportacaoFsCancel001',
  velho: 'jobImportacaoFsVelho0001',
} as const;
const AGORA_MS = Date.UTC(2026, 10, 4, 12, 0, 0);

function db(): Firestore {
  return getAdminFirestore();
}

/** Seed a job through the job schema (every default a created one has), NEVER `pendente`. */
async function seedJob(
  id: string,
  over: Partial<Record<'integracaoId' | 'status' | 'seq' | 'iniciadoEmMs', unknown>> = {},
): Promise<void> {
  const job = importacaoLojaIntegradaSchema.parse({
    integracaoId: CONTA,
    iniciadoPor: 'u-fs',
    iniciadoEmMs: AGORA_MS,
    status: STATUS_IMPORTACAO_LI.executando,
    ...over,
  });
  expect(job.status).not.toBe(STATUS_IMPORTACAO_LI.pendente);
  await db().collection(JOBS).doc(id).set(job);
}

describe.skipIf(!EMULATED)('the product import’s job on a real Firestore', () => {
  beforeEach(async () => {
    for (const id of Object.values(IDS)) {
      await db().recursiveDelete(db().collection(JOBS).doc(id));
    }
  });

  afterAll(async () => {
    for (const id of Object.values(IDS)) {
      await db().recursiveDelete(db().collection(JOBS).doc(id));
    }
  });

  it('the guard’s query runs in the declared composite’s shape: newest first, this conta only', async () => {
    await seedJob(IDS.antigo, {
      status: STATUS_IMPORTACAO_LI.concluido,
      iniciadoEmMs: AGORA_MS - 60_000,
    });
    await seedJob(IDS.emCurso, { iniciadoEmMs: AGORA_MS });
    await seedJob(IDS.daOutra, { integracaoId: OUTRA_CONTA, iniciadoEmMs: AGORA_MS + 60_000 });

    expect(await jobEmCursoDaContaLi(db(), CONTA)).toBe(IDS.emCurso);
    expect((await listarImportacoesDaContaLi(db(), CONTA)).map((j) => j.jobId)).toEqual([
      IDS.emCurso,
      IDS.antigo,
    ]);

    // The composite the query rides, as declared (Enterprise full-scans without it, and the
    // emulator would not say so): exactly these two fields, in this order and direction.
    const indices = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../../firestore.indexes.json', import.meta.url)),
        'utf8',
      ),
    ) as { indexes: { collectionGroup: string; queryScope: string; fields: unknown[] }[] };
    expect(indices.indexes.filter((i) => i.collectionGroup === JOBS)).toEqual([
      {
        collectionGroup: JOBS,
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'integracaoId', order: 'ASCENDING' },
          { fieldPath: 'iniciadoEmMs', order: 'DESCENDING' },
        ],
      },
    ]);
  });

  it('a write’s writeTime is the next write’s precondition, and only the end-of-dispatch checkpoint moves seq', async () => {
    await seedJob(IDS.cadeia);
    const lido = await lerJobLi(db(), IDS.cadeia);
    if (lido === null) throw new Error('o job semeado não foi lido');

    const um = await gravarCheckpointDaUnidadeLi(
      db(),
      { jobId: IDS.cadeia, seq: 0, versao: lido.versao },
      { fase: FASE_IMPORTACAO_LI.listagem },
      AGORA_MS,
    );
    if (um.tipo !== 'gravado') throw new Error('o checkpoint da unidade não gravou');
    expect((await lerJobLi(db(), IDS.cadeia))?.job).toMatchObject({ fase: 'listagem', seq: 0 });

    const fim = await gravarCheckpointDoFimDoDespachoLi(
      db(),
      { jobId: IDS.cadeia, seq: 0, versao: um.versao },
      {},
      AGORA_MS,
    );
    expect(fim.tipo).toBe('gravado');
    expect((await lerJobLi(db(), IDS.cadeia))?.job).toMatchObject({
      status: 'executando',
      fase: 'listagem',
      seq: 1,
    });

    // NEAR-MISS: the stale first stamp loses now — the server refuses it, the job runs at seq 1,
    // so the dispatch of seq 0 stops and writes nothing.
    const velho = await gravarCheckpointDaUnidadeLi(
      db(),
      { jobId: IDS.cadeia, seq: 0, versao: lido.versao },
      { fase: FASE_IMPORTACAO_LI.lixeira },
      AGORA_MS,
    );
    expect(velho).toMatchObject({ tipo: 'parar', job: { seq: 1, fase: 'listagem' } });
  });

  it('a unit checkpoint LOSES to a cancel landed after its read, and is never re-applied', async () => {
    await seedJob(IDS.cancelado);
    const lido = await lerJobLi(db(), IDS.cancelado);
    if (lido === null) throw new Error('o job semeado não foi lido');

    const cancelamento = await cancelarImportacaoLi(db(), CONTA, IDS.cancelado, AGORA_MS);
    expect(cancelamento.tipo).toBe('cancelado');

    const r = await gravarCheckpointDaUnidadeLi(
      db(),
      { jobId: IDS.cancelado, seq: 0, versao: lido.versao },
      { fase: FASE_IMPORTACAO_LI.listagem },
      AGORA_MS + 1,
    );
    expect(r).toMatchObject({ tipo: 'parar', job: { status: 'cancelado' } });
    expect((await lerJobLi(db(), IDS.cancelado))?.job).toMatchObject({
      status: 'cancelado',
      fase: 'catalogo',
      seq: 0,
    });
  });

  it('a dispatch of a STALE seq reads the job and writes nothing', async () => {
    await seedJob(IDS.velho, { seq: 3 });
    const antes = await db().collection(JOBS).doc(IDS.velho).get();
    const agendador = vi.fn(() => {
      throw new Error('importacao.firestore.test: nenhuma tarefa é enfileirada aqui');
    });

    const r = await despacharImportacaoLi(
      db(),
      { tipo: TIPO_TAREFA_IMPORTACAO_LI, contaId: CONTA, jobId: IDS.velho, seq: 1 },
      {
        // The switch OFF, as the lane runs: a stale seq never even reaches the context.
        ambiente: { LOJA_INTEGRADA_CHAMADAS: 'off' },
        agoraMs: () => AGORA_MS,
        inicioMs: AGORA_MS,
        esperar: () => Promise.reject(new Error('nenhuma espera')),
        increment: () => {
          throw new Error('nenhum contador');
        },
        agendador,
        logger: { warn: vi.fn() },
        tentativa: 0,
        idTarefa: null,
      },
    );

    expect(r.desfecho).toBe('nada');
    expect(agendador).not.toHaveBeenCalled();
    const depois = await db().collection(JOBS).doc(IDS.velho).get();
    expect(depois.updateTime?.isEqual(antes.updateTime ?? depois.updateTime)).toBe(true);
    expect(depois.data()).toEqual(antes.data());
  });
});
