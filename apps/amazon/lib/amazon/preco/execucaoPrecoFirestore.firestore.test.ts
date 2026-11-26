/**
 * The price run document's I/O on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-e). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file proves what
 * only holds if the server behaves as the fake says:
 *
 *  - ★ the masked read is projected BY THE SERVER: the snapshot it answers
 *    carries the masked fields alone, and its `updateTime` still feeds the
 *    write's precondition;
 *  - ★ a whole run written over a stored one with `update` REPLACES its maps
 *    and lists whole on the server (no deep merge leaves an old batch or an
 *    old refusal key behind);
 *  - ★ a concurrent `update` between our read and our write fails our
 *    precondition on the server, and the helper re-reads and re-decides; a
 *    concurrent create fails our `create` (ALREADY_EXISTS) the same way, and a
 *    run deleted under our read is re-read as gone;
 *  - ★ the run's `relogioInicio`, a read's `readTime`, round-trips as a
 *    Firestore `Timestamp` of the same instant.
 *
 * The concurrent writer is injected by spying on the database's own `getAll`
 * (the real call runs; the competing write lands right after it answers).
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * here sits under `precosAmazon/e2e-preco-execucao-conta`, which no other suite
 * seeds; no `integracao` and no `nfev4` document is written, nothing is
 * enqueued. Every case wipes what it reads first, and the file leaves nothing
 * behind. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  execucaoPrecoAmazonSchema,
} from '@delfrance/schemas';
import type { z } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  EXECUCAO_PRECO_INTEIRA,
  escreverExecucaoPrecoAmazon,
  lerExecucaoPrecoAmazon,
  mascaraExecucaoPrecoAmazon,
} from './execucaoPrecoFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-execucao-';
/** The conta of this file — an id no other suite seeds (no conta document is written). */
const CONTA = `${P}conta`;
const RUN = `precosAmazon/${CONTA}`;

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(RUN));
}

/** A stored run, every default filled. */
function execucao(
  over: Partial<z.input<typeof execucaoPrecoAmazonSchema>> = {},
): ExecucaoPrecoAmazon {
  return execucaoPrecoAmazonSchema.parse({
    execucaoId: `${P}exec`,
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: `${P}uid`,
    iniciadaEmMs: Date.now(),
    ...over,
  });
}

const FASE = mascaraExecucaoPrecoAmazon(['execucaoId', 'fase']);

/** After the FIRST `getAll` answers, `competir` lands (once): the window a concurrent writer uses. */
function concorrenteAposALeitura(competir: () => Promise<unknown>) {
  const original = db().getAll.bind(db());
  const getAll = vi.spyOn(db(), 'getAll');
  getAll.mockImplementationOnce(async (...args: Parameters<Firestore['getAll']>) => {
    const snaps = await original(...args);
    await competir();
    return snaps;
  });
  return getAll;
}

describe.skipIf(!EMULATED)('the price run document on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the masked read is projected by the SERVER, and its updateTime is the stored commit', async () => {
    await db()
      .doc(RUN)
      .set(execucao({ contagens: { enviaveis: 4 }, proximaPagina: 2 }));
    const original = db().getAll.bind(db());
    const vistos: Record<string, unknown>[] = [];
    vi.spyOn(db(), 'getAll').mockImplementation(async (...args) => {
      const snaps = await original(...args);
      for (const s of snaps) vistos.push(s.data() ?? {});
      return snaps;
    });
    const lida = await lerExecucaoPrecoAmazon(db(), CONTA, FASE);
    expect(Object.keys(vistos[0] ?? {}).sort()).toEqual(['execucaoId', 'fase']);
    expect(lida.estado).toEqual({ execucaoId: `${P}exec`, fase: 'paginando' });
    const cru = await db().doc(RUN).get();
    expect(lida.updateTime?.isEqual(cru.updateTime as Timestamp)).toBe(true);
  });

  it('★ a whole run written over a stored one REPLACES its maps and lists whole on the server', async () => {
    await db()
      .doc(RUN)
      .set(
        execucao({
          fase: 'concluida',
          decisao: 'lotes',
          itensPorParte: [3, 4],
          amostraReducoes: ['A:10>9'],
          contagens: { enviaveis: 7, porChave: { pai: 2 } },
          lotes: {
            '0': { execucaoIdLote: `${P}l0`, parteInicial: 0, partes: 2, itens: 7 },
          },
        }),
      );
    const nova = execucao({ execucaoId: `${P}exec-2` });
    // The claim's own shape: the request's fields alone, every default left to the schema.
    const r = await escreverExecucaoPrecoAmazon(db(), CONTA, FASE, () => ({
      escrita: {
        tipo: 'execucao',
        execucao: {
          execucaoId: nova.execucaoId,
          fase: nova.fase,
          baixarPreco: nova.baixarPreco,
          solicitadaPor: nova.solicitadaPor,
          iniciadaEmMs: nova.iniciadaEmMs,
        },
      },
      resposta: null,
    }));
    const cru = (await db().doc(RUN).get()).data() ?? {};
    expect(execucaoPrecoAmazonSchema.parse(cru)).toEqual(nova);
    expect(cru.lotes).toEqual({});
    expect((cru.contagens as Record<string, unknown>).porChave).toEqual({});
    expect(r.writeTime).not.toBeNull();
  });

  it('★ a concurrent update between our read and our write fails our precondition on the server: re-read and re-decided', async () => {
    await db().doc(RUN).set(execucao());
    concorrenteAposALeitura(() =>
      db()
        .doc(RUN)
        .update({ execucaoId: `${P}exec-outra` }),
    );
    const vistos: (string | null)[] = [];
    const r = await escreverExecucaoPrecoAmazon(db(), CONTA, FASE, (lida) => {
      vistos.push(lida.estado?.execucaoId ?? null);
      return lida.estado?.execucaoId === `${P}exec`
        ? {
            escrita: { tipo: 'campos', campos: { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada } },
            resposta: 'cancelada',
          }
        : { escrita: null, resposta: 'outra' };
    });
    expect(vistos).toEqual([`${P}exec`, `${P}exec-outra`]);
    expect(r.resposta).toBe('outra');
    expect((await db().doc(RUN).get()).data()).toMatchObject({
      execucaoId: `${P}exec-outra`,
      fase: 'paginando',
    });
  });

  it('★ a concurrent create fails our create (ALREADY_EXISTS) on the server: re-read and decided on the winner', async () => {
    concorrenteAposALeitura(() =>
      db()
        .doc(RUN)
        .set(execucao({ execucaoId: `${P}vencedora` })),
    );
    const r = await escreverExecucaoPrecoAmazon(db(), CONTA, FASE, (lida) =>
      lida.estado === null
        ? {
            escrita: { tipo: 'execucao', execucao: execucao({ execucaoId: `${P}minha` }) },
            resposta: 'criada',
          }
        : { escrita: null, resposta: lida.estado.execucaoId },
    );
    expect(r.resposta).toBe(`${P}vencedora`);
    expect((await db().doc(RUN).get()).data()).toMatchObject({ execucaoId: `${P}vencedora` });
  });

  it('★ a run deleted under our read: the precondition fails on the server, and the re-read finds no run', async () => {
    await db().doc(RUN).set(execucao());
    concorrenteAposALeitura(() => db().doc(RUN).delete());
    const r = await escreverExecucaoPrecoAmazon(db(), CONTA, FASE, (lida) =>
      lida.estado === null
        ? { escrita: null, resposta: 'sem-execucao' }
        : {
            escrita: { tipo: 'campos', campos: { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada } },
            resposta: 'cancelada',
          },
    );
    expect(r.resposta).toBe('sem-execucao');
    expect((await db().doc(RUN).get()).exists).toBe(false);
  });

  it('★ relogioInicio, a read’s readTime, round-trips as a Timestamp of the same instant', async () => {
    await db().doc(RUN).set(execucao());
    const lida = await lerExecucaoPrecoAmazon(db(), CONTA, FASE);
    await escreverExecucaoPrecoAmazon(
      db(),
      CONTA,
      FASE,
      () => ({
        escrita: { tipo: 'campos', campos: { relogioInicio: lida.readTime, proximaPagina: 1 } },
        resposta: null,
      }),
      lida,
    );
    const inteira = await lerExecucaoPrecoAmazon(db(), CONTA, EXECUCAO_PRECO_INTEIRA);
    const relogio = inteira.estado?.relogioInicio as Timestamp;
    expect(typeof relogio.toMillis).toBe('function');
    expect(relogio.isEqual(lida.readTime)).toBe(true);
    expect(inteira.estado?.proximaPagina).toBe(1);
  });
});
