/**
 * The price run's claim, cancel and status on a REAL Firestore — the emulator
 * of `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-e). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file proves what
 * only holds if the server behaves as the fake says:
 *
 *  - ★ the claim: no run ⇒ created; a run 2 h without progress ⇒ replaced
 *    whole on the server under its own commit (its batches gone); a live run
 *    ⇒ 409 and its commit unmoved; a stalled one ⇒ re-kicked, unmoved;
 *  - ★ the queue valve closed ⇒ not one read and not one write reach the
 *    server;
 *  - ★ page 0's enqueue failing ⇒ the run closed `falhou` on the claim's own
 *    commit — and, when the page did land and advanced the run on the server
 *    first, the close fails that commit, re-reads and still closes it;
 *  - ★ the cancel: a `concluida` run with a pending batch ⇒ `cancelada`, and a
 *    concurrent write between its read and its write is re-read and decided
 *    again;
 *  - ★ the status: the run and the PRICE lease read under masks the SERVER
 *    projects, and the feed in flight with its age.
 *
 * The concurrent writer is injected by spying on the database's own `getAll`,
 * or by the recording queue itself (between the claim's write and its close).
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * here is `precosAmazon/e2e-preco-inicio-conta` or the lease
 * `feedsAmazonEmCurso/preco-e2e-preco-inicio-conta`, which no other suite
 * seeds; no `integracao` and no `nfev4` document is written. The producer is a
 * RECORDER: nothing is enqueued onto a queue the lane dispatches. Every case
 * wipes what it reads first, and the file leaves nothing behind. PLACEHOLDERS
 * ONLY (public repository).
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

import type { OpcoesDaTarefaListingAmazon } from '../listings/produtorListing';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { loggerEspiao } from '../testing/fixtures';
import {
  CAMPOS_VEZ_RESUMO_PRECO_AMAZON,
  type DepsExecucaoPrecoAmazon,
  cancelarExecucaoPrecoAmazon,
  criarProdutorExecucaoPrecoAmazon,
  iniciarExecucaoPrecoAmazon,
  resumoExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import { nomePaginaPrecoAmazon, nomeRetomadaPrecoAmazon } from './tarefaPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-inicio-';
/** The conta of this file — an id no other suite seeds (no conta document is written). */
const CONTA = `${P}conta`;
const RUN = `precosAmazon/${CONTA}`;
const VEZ = `feedsAmazonEmCurso/preco-${CONTA}`;
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
const PEDIDO = { baixarPreco: false, confirmarReducaoEmMassa: false, solicitadaPor: `${P}uid` };

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(RUN));
  await db().doc(VEZ).delete();
}

function execucao(
  agora: number,
  over: Partial<z.input<typeof execucaoPrecoAmazonSchema>> = {},
): ExecucaoPrecoAmazon {
  return execucaoPrecoAmazonSchema.parse({
    execucaoId: `${P}viva`,
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: `${P}uid`,
    iniciadaEmMs: agora - 3 * HORA_MS,
    ...over,
  });
}

/** A recording queue: nothing reaches Cloud Tasks; `falha` runs first and may reject. */
function gravador() {
  const ids: (string | undefined)[] = [];
  const estado: { falha: (() => Promise<Error | undefined>) | null } = { falha: null };
  const fila = {
    enqueue: async (_t: unknown, opcoes?: OpcoesDaTarefaListingAmazon) => {
      const erro = estado.falha === null ? undefined : await estado.falha();
      if (erro !== undefined) throw erro;
      ids.push(opcoes?.id);
    },
  };
  return { ids, estado, fila };
}

function deps(
  agora: number,
  g: ReturnType<typeof gravador>,
  over: Partial<DepsExecucaoPrecoAmazon> = {},
): DepsExecucaoPrecoAmazon {
  return {
    filaDesligada: false,
    produtor: () => criarProdutorExecucaoPrecoAmazon({ fila: () => g.fila, desligado: false }),
    agora: () => agora,
    gerarExecucaoId: () => `${P}nova`,
    logger: loggerEspiao().logger,
    ...over,
  };
}

async function commit(): Promise<Timestamp | undefined> {
  return (await db().doc(RUN).get()).updateTime;
}

/** After the FIRST `getAll` answers, `competir` lands (once): the window a concurrent writer uses. */
function concorrenteAposALeitura(competir: () => Promise<unknown>) {
  const original = db().getAll.bind(db());
  vi.spyOn(db(), 'getAll').mockImplementationOnce(
    async (...args: Parameters<Firestore['getAll']>) => {
      const snaps = await original(...args);
      await competir();
      return snaps;
    },
  );
}

describe.skipIf(!EMULATED)(
  'the price run’s claim, cancel and status on real Firestore (emulator)',
  () => {
    beforeEach(async () => {
      await limpar();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await limpar();
    });

    it('★ the claim: no run ⇒ created and page 0 named; a run 2 h without progress ⇒ replaced whole under its commit', async () => {
      const agora = Date.now();
      const g = gravador();
      expect(await iniciarExecucaoPrecoAmazon(db(), CONTA, PEDIDO, deps(agora, g))).toMatchObject({
        ok: true,
        corpo: { execucaoId: `${P}nova`, retomada: false },
      });
      expect(execucaoPrecoAmazonSchema.parse((await db().doc(RUN).get()).data())).toMatchObject({
        execucaoId: `${P}nova`,
        fase: 'paginando',
        iniciadaEmMs: agora,
      });
      expect(g.ids).toEqual([nomePaginaPrecoAmazon(CONTA, `${P}nova`, 0)]);

      await db()
        .doc(RUN)
        .set(
          execucao(agora, {
            fase: 'decidindo',
            progressoEmMs: agora - 2 * HORA_MS - 1,
            lotes: { '0': { execucaoIdLote: `${P}l0`, parteInicial: 0, partes: 1, itens: 31 } },
          }),
        );
      const h = gravador();
      const r = await iniciarExecucaoPrecoAmazon(
        db(),
        CONTA,
        PEDIDO,
        deps(agora, h, { gerarExecucaoId: () => `${P}nova-2` }),
      );
      expect(r).toMatchObject({ ok: true, corpo: { execucaoId: `${P}nova-2`, retomada: false } });
      const cru = (await db().doc(RUN).get()).data() ?? {};
      expect(cru.lotes).toEqual({});
      expect(cru).toMatchObject({ execucaoId: `${P}nova-2`, fase: 'paginando', decisao: null });
    });

    it('★ a live run ⇒ 409 and its commit unmoved; a stalled one ⇒ re-kicked by the stall, its commit unmoved', async () => {
      const agora = Date.now();
      await db()
        .doc(RUN)
        .set(execucao(agora, { progressoEmMs: agora - 10 * MINUTO_MS }));
      const antes = await commit();
      const g = gravador();
      expect(await iniciarExecucaoPrecoAmazon(db(), CONTA, PEDIDO, deps(agora, g))).toMatchObject({
        ok: false,
        execucaoId: `${P}viva`,
      });
      const progresso = agora - 16 * MINUTO_MS;
      await db().doc(RUN).update({ progressoEmMs: progresso, proximaPagina: 3 });
      const parado = await commit();
      expect(await iniciarExecucaoPrecoAmazon(db(), CONTA, PEDIDO, deps(agora, g))).toMatchObject({
        ok: true,
        corpo: { execucaoId: `${P}viva`, retomada: true },
      });
      expect((await commit())?.isEqual(parado as Timestamp)).toBe(true);
      expect(antes?.isEqual(parado as Timestamp)).toBe(false);
      expect(g.ids).toEqual([nomeRetomadaPrecoAmazon(CONTA, `${P}viva`, 3, progresso)]);
    });

    it('★ the queue valve closed ⇒ not one read and not one write reach the server', async () => {
      const leituras = vi.spyOn(db(), 'getAll');
      const g = gravador();
      expect(
        await iniciarExecucaoPrecoAmazon(
          db(),
          CONTA,
          PEDIDO,
          deps(Date.now(), g, { filaDesligada: true }),
        ),
      ).toMatchObject({ ok: false, motivo: 'fila-desligada', execucaoId: null });
      expect(leituras).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect((await db().doc(RUN).get()).exists).toBe(false);
      expect(g.ids).toEqual([]);
    });

    it('★ page 0 failing ⇒ closed falhou on the claim’s commit; a page that landed and advanced the run first fails that commit, and the re-read still closes it', async () => {
      const agora = Date.now();
      const g = gravador();
      g.estado.falha = async () => {
        // The page ran meanwhile, on the server: the claim's commit is stale now.
        await db().doc(RUN).update({ proximaPagina: 1, progressoEmMs: agora });
        return falhaDoFunctions('unknown-error', 503);
      };
      expect(await iniciarExecucaoPrecoAmazon(db(), CONTA, PEDIDO, deps(agora, g))).toMatchObject({
        ok: false,
        execucaoId: `${P}nova`,
        motivo: 'enfileiramento-incerto',
      });
      expect((await db().doc(RUN).get()).data()).toMatchObject({
        execucaoId: `${P}nova`,
        fase: 'falhou',
        motivo: 'enfileiramento-falhou',
        proximaPagina: 1,
      });
    });

    it('★ the cancel: a concluida run with a pending batch ⇒ cancelada; a concurrent write between its read and write is re-read and decided again', async () => {
      const agora = Date.now();
      await db()
        .doc(RUN)
        .set(
          execucao(agora, {
            fase: 'decidindo',
            progressoEmMs: agora - MINUTO_MS,
          }),
        );
      concorrenteAposALeitura(() =>
        db()
          .doc(RUN)
          .update({
            fase: 'concluida',
            decisao: 'lotes',
            esperaLotesAteMs: agora + HORA_MS,
            lotes: { '0': { execucaoIdLote: `${P}l0`, parteInicial: 0, partes: 1, itens: 31 } },
          }),
      );
      expect(
        await cancelarExecucaoPrecoAmazon(db(), CONTA, {
          agora: () => agora,
          logger: loggerEspiao().logger,
        }),
      ).toEqual({
        ok: true,
        acao: 'cancelada',
        corpo: { execucaoId: `${P}viva`, fase: 'cancelada' },
      });
      expect((await db().doc(RUN).get()).data()).toMatchObject({
        fase: 'cancelada',
        decisao: 'lotes',
      });
    });

    it('★ the status: the run and the PRICE lease under masks the SERVER projects; the feed in flight with its age', async () => {
      const agora = Date.now();
      await db()
        .doc(RUN)
        .set(execucao(agora, { progressoEmMs: agora - 15 * MINUTO_MS, proximaPagina: 4 }));
      await db()
        .doc(VEZ)
        .set({
          estado: 'enviado',
          execucaoId: `${P}l0`,
          feedId: '123456789',
          ateMs: agora + HORA_MS,
          atualizadoEmMs: agora - 10 * MINUTO_MS,
          mensagens: 10,
        });
      const original = db().getAll.bind(db());
      const campos: string[][] = [];
      vi.spyOn(db(), 'getAll').mockImplementation(async (...args) => {
        const snaps = await original(...args);
        for (const s of snaps) campos.push(Object.keys(s.data() ?? {}).sort());
        return snaps;
      });
      const r = await resumoExecucaoPrecoAmazon(db(), CONTA, { agora: () => agora });
      expect(r).toMatchObject({
        execucaoId: `${P}viva`,
        parada: true,
        feedEmCurso: { estado: 'enviado', idadeMs: 10 * MINUTO_MS },
      });
      expect(campos[0]).not.toContain('proximaPagina');
      expect(campos[0]).not.toContain('cursores');
      expect(campos[1]).toEqual([...CAMPOS_VEZ_RESUMO_PRECO_AMAZON].sort());
    });
  },
);
