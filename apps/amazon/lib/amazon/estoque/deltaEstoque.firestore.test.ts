/**
 * The recovery delta on a REAL Firestore — the emulator of `ci-amazon.yml`, not
 * the in-memory fake (step 12, PR 12-e2). The offline suite drives every rule
 * against `testing/fakeDb.ts`; this file runs the recovery IN-PROCESS on the
 * real server and proves what only holds if the server behaves as the fake
 * says:
 *
 *  - ★ the catch-up on REAL commit times: a feed's members committed before
 *    `S − 20 s` are not re-sent, a row stamped before the snapshot but
 *    committed after the margin is, FORCED and named by the feed; a second
 *    recovery over the same rows answers "already enqueued";
 *  - ★ with a pending start and no snapshot, a row is sent UNFORCED, named by
 *    its REAL commit time (the document's own `updateTime`).
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the queries'
 * SHAPE and results, never their cost — the index pin is the cost guard
 * (`packages/schemas/src/estoqueAmazon.indexes.test.ts`).
 *
 * D11: the recovery makes no Amazon call and binds no client. The producer is
 * the REAL one over a RECORDING queue: nothing is enqueued onto a queue the
 * lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id and the depósito here start with `e2e-estoque-delta-`, which no other
 * suite seeds (the window query is filtered on that depósito); the conta id is
 * no other suite's, and no `integracao` document is written, so the conta
 * trigger never fires; `produtos`, their `estoques` and their `prodAmazon` are
 * no trigger path. Every case wipes what it seeds first, and the file leaves
 * nothing behind.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { loggerEspiao } from '../testing/fixtures';
import { DESFECHO_DELTA_ESTOQUE_AMAZON, enviarDeltaEstoqueAmazon } from './deltaEstoque';
import { MARGEM_COMMIT_MS } from './descobertaEstoque';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  referenciaDaObservacao,
} from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-delta-';
/** The conta of this file — an id no other suite seeds; no conta document is written. */
const CONTA = `${P}conta`;
const DEP = `${P}dep`;
const CANONICA = `documents/depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
/** The recovered feed's reference. */
const REF_FEED = `${P}feed-1`;

function db(): Firestore {
  return getAdminFirestore();
}

/** Every path this file may seed, so each case starts clean and the file ends clean. */
const CAMINHOS = new Set<string>();

async function semear(caminho: string, dados: Record<string, unknown>): Promise<Timestamp> {
  CAMINHOS.add(caminho);
  return (await db().doc(caminho).set(dados)).writeTime;
}

async function limpar(): Promise<void> {
  const caminhos = [...CAMINHOS];
  for (let i = 0; i < caminhos.length; i += 400) {
    const lote = db().batch();
    for (const c of caminhos.slice(i, i + 400)) lote.delete(db().doc(c));
    await lote.commit();
  }
}

/** A produto with its one link (SKU `<P>SKU-<id>`); its row stamped `carimbo`, seeded LAST. Returns the row's path. */
async function moveu(id: string, carimbo: number): Promise<string> {
  await semear(`produtos/${P}${id}`, { nome: `Produto ${id}` });
  await semear(`produtos/${P}${id}/prodAmazon/${P}l-${id}`, {
    contaAmazonOuterRef: REF_CONTA,
    sku: `${P}SKU-${id}`,
  });
  const caminho = `produtos/${P}${id}/estoques/${makeEstoqueUid(`${P}${id}`, DEP)}`;
  await semear(caminho, { depositoOuterRef: CANONICA, ultimaModificacao: carimbo, quantidade: 3 });
  return caminho;
}

async function commitDe(caminho: string): Promise<Timestamp> {
  const t = (await db().doc(caminho).get()).updateTime;
  if (t === undefined) throw new Error(`fixture: ${caminho} ausente`);
  return t;
}

/** Task ids the recording queue holds, and every task it accepted. */
let idsNaFila = new Set<string>();
let enfileiradas: TarefaEstoqueAmazon[] = [];

const produtor = criarProdutorEstoqueAmazon({
  desligado: false,
  fila: () => ({
    enqueue: (tarefa, extras) => {
      const id = extras?.id;
      if (id !== undefined && idsNaFila.has(id)) {
        return Promise.reject(falhaDeTarefaJaExistente(id));
      }
      if (id !== undefined) idsNaFila.add(id);
      enfileiradas.push(tarefa);
      return Promise.resolve();
    },
  }),
});

const recuperar = (snapshotEmMs: number | null, pendenteDesdeMs: number | null) =>
  enviarDeltaEstoqueAmazon(
    {
      db: db(),
      contaId: CONTA,
      depositoId: DEP,
      agora: () => Date.now(),
      logger: loggerEspiao().logger,
      produtor: () => produtor,
    },
    { snapshotEmMs, pendenteDesdeMs },
    { referencia: REF_FEED, prazoMs: Number.MAX_SAFE_INTEGER },
  );

/** Waits until the wall clock has left the millisecond `ms`. */
async function depoisDe(ms: number): Promise<void> {
  while (Date.now() <= ms + 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

describe.skipIf(!EMULATED)('the recovery delta on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
    idsNaFila = new Set();
    enfileiradas = [];
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the catch-up on REAL commit times: the members committed before S − 20 s stay out; a commit-lagged row is FORCED, named by the feed; a second recovery dedupes', async () => {
    // The snapshot is placed so that S − 20 s is the LAST member's commit
    // millisecond (the members committed "before the feed's reads").
    const agora = Date.now();
    const m1 = await moveu('M1', agora - 200_000);
    const m2 = await moveu('M2', agora - 200_000);
    const ultimoMembroMs = Math.max(
      (await commitDe(m1)).toMillis(),
      (await commitDe(m2)).toMillis(),
    );
    const s = ultimoMembroMs + MARGEM_COMMIT_MS;
    await depoisDe(ultimoMembroMs);
    // Stamped BEFORE the snapshot, committed after the margin.
    const x = await moveu('X', s - 60_000);
    // Anti-vacuity: the two sides of the margin really are two sides.
    expect((await commitDe(x)).toMillis()).toBeGreaterThan(s - MARGEM_COMMIT_MS);
    expect((await commitDe(m1)).toMillis()).toBeLessThanOrEqual(s - MARGEM_COMMIT_MS);

    const r = await recuperar(s, null);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      linhas: 3,
      skus: 1,
      forcados: 1,
      tarefas: 1,
    });
    expect(enfileiradas).toEqual([
      {
        v: 1,
        contaId: CONTA,
        sku: `${P}SKU-X`,
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
        referencia: REF_FEED,
        depositoId: null,
      },
    ]);

    const deNovo = await recuperar(s, null);
    expect(deNovo).toMatchObject({ tarefas: 0, jaEnfileiradas: 1 });
    expect(enfileiradas).toHaveLength(1);
  });

  it('★ a pending start and no snapshot: the row is sent UNFORCED, named by the document’s REAL commit time', async () => {
    const p = Date.now() - 120_000;
    const a = await moveu('A', p + 1);
    await moveu('B', p - 1);

    const r = await recuperar(null, p);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      skus: 1,
      forcados: 0,
    });
    expect(enfileiradas).toEqual([
      {
        v: 1,
        contaId: CONTA,
        sku: `${P}SKU-A`,
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
        referencia: referenciaDaObservacao(await commitDe(a)),
        depositoId: null,
      },
    ]);
  });
});
