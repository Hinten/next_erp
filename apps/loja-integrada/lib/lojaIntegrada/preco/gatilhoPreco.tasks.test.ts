/**
 * The price TRIGGER's work (master plan step 13, PR 13-e) against the real emulators
 * (`ci-loja-integrada.yml`).
 *
 * What runs for real here:
 *
 *   tratarEventoPrecoLi(deps, event)            the trigger's work, IN THIS PROCESS
 *     → lerMapaTabelasLi: the real `integracao` query (tipo == 3, ordered by nome) — a conta
 *       storing its normal tabela under the BARE ref form and its promotional one CANONICAL
 *     → a child: the parent's ONE masked `getAll` (its flag and its anchor; a miss for a parent
 *       id no document has)
 *     → a root: the family query (`paiId ==` the root, `integracoesComProduto array-contains` the
 *       conta, projected to `paiId`, limited)
 *     → criarAgendadorPrecoLiDoAmbiente()  the real price producer root
 *       → the region-qualified `filaPrecoLojaIntegrada` → the Cloud Tasks emulator, which
 *         ACCEPTS a task only if the deployed artifact registers that queue (a 404 otherwise)
 *
 * Every positive is the in-process result plus the payloads the producer root ACCEPTED (each
 * recorded only once its real enqueue resolved); nothing here polls for an absence. A dispatched
 * price run passes the lane's `dry-run` price valve and stops at its write context on the read
 * switch: it reads, writes nothing and logs in the emulator's process, so that hop is unobservable
 * here by design (`processarPreco.tasks.test.ts` says the same of its follow-up).
 *
 * ⚠️ Why the trigger's work runs IN PROCESS and not through the deployed trigger. Its conta map
 * is a 15-minute cache in the emulator's worker, warmed by whichever suite first writes a produto,
 * so a deployed event could be judged against a map built before this suite's conta existed — an
 * order-dependent flake. In process, the cache is reset per case, the valve is a PARAMETER
 * (`ambiente`), and each event's before and after are handed in.
 *
 * Isolation (`vitest.tasks.config.ts`, the price trigger's rules): a conta and produto ids no other
 * suite uses (the produtos carry a per-run suffix, so a named-task dedup across runs against one
 * emulator can never hide an enqueue); the conta is CREATED, never updated, with `nome` (the map's
 * query orders by it), no filial and no `dataCadastro` (the conta trigger only reads); every
 * produto is CREATED at its after state and never edited — only the anchor writes its array — so
 * the DEPLOYED price trigger, which fires on each of those writes, never passes its relevance gate
 * here; no stock record is written (the stock trigger never fires); every link create fires the
 * anchor trigger, so each linked produto's anchor add is awaited before its case runs, and every
 * case ends by deleting its links and awaiting the conta leaving each array before its produtos go
 * (`testing/ancoraLi.ts`). Every value is INVENTED (`testing/precoLi.ts`: store ids from 1000,
 * repeated-digit prices).
 *
 * NOT proven here: the deployed trigger end to end, its gate order and its cost per event (pinned
 * offline by counting, `gatilhoPreco.test.ts` and `functions/src/onPrecoLojaIntegrada.test.ts`),
 * the map's TTL, named-task dedup, the declared indexes (the emulator auto-creates every one;
 * `gatilhoPreco.test.ts` and `mapaTabelasLi.test.ts` pin both queries against
 * `firestore.indexes.json`), the scan cost on Enterprise, and any call to Loja Integrada (none: the
 * global fetch is watched, and the trigger builds no client).
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import { INTEGRACAO_TIPO, ORIGEM_TAREFA_PRECO_LI, type TarefaPrecoLi } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorPrecoLiDoAmbiente } from '../../../functions/src/agendadorPreco';
import { CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../core/valvulas';
import { aguardarAncoraLi, comConta, semConta } from '../testing/ancoraLi';
import { ID_PAI_PRECO_LI } from '../testing/precoLi';
import type { AgendadorPrecoLi } from './agendadorPreco';
import { type DepsGatilhoPrecoLi, type EventoPrecoLi, tratarEventoPrecoLi } from './gatilhoPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The producer root's enqueues are half of what this suite proves — gate on the tasks emulator. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-gatilho-preco-ci';
const TAB_N = 'tab-li-gatilho-preco-ci-normal';
const TAB_P = 'tab-li-gatilho-preco-ci-promo';
const RODADA = Date.now().toString(36);
const id = (nome: string) => `p-li-gatilho-preco-ci-${nome}-${RODADA}`;

/** A propagating root, its two anchored children, an unanchored one, another root's child. */
const R = id('raiz');
const F1 = id('f1');
const F2 = id('f2');
const F3 = id('f3');
const G = id('g');
const OUTRA_RAIZ = id('outra-raiz');
/** A propagating parent with NO link, and its anchored child. */
const S = id('pai-sem-vinculo');
const H = id('h');
/** A parent that does NOT propagate, anchored, and its anchored child. */
const T = id('pai-sem-propagacao');
const K = id('k');
/** A child whose parent id names no document. */
const X = id('x');
const SEM_PAI = id('sem-pai');
/** A childless root. */
const SIMPLES = id('simples');
/** A root stored with `paiId: ''`, and its two anchored children. */
const VAZIA = id('raiz-vazia');
const V1 = id('v1');
const V2 = id('v2');
const PRODUTOS = [R, F1, F2, F3, G, S, H, T, K, X, SIMPLES, VAZIA, V1, V2] as const;

function db(): Firestore {
  return getAdminFirestore();
}

/** Every produto's links, then the produto; the anchor's last write awaited between. */
async function limparProduto(produtoId: string): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  const links = await ref.collection('produtolojaintegrada').get();
  for (const link of links.docs) await link.ref.delete();
  if (!links.empty && (await ref.get()).exists) {
    await aguardarAncoraLi(db(), produtoId, semConta(CONTA), `sem a conta (${produtoId})`);
  }
  await db().recursiveDelete(ref);
}

async function limpar(): Promise<void> {
  for (const produtoId of PRODUTOS) await limparProduto(produtoId);
  await db().recursiveDelete(db().collection('integracao').doc(CONTA));
}

/**
 * The conta, by a CREATE (never an update: the conta trigger's arms fire on updates): its normal
 * tabela under the BARE ref form, its promotional one CANONICAL. No filial, no `dataCadastro`, no
 * credential: the conta trigger only reads, and the trigger's work never reads a credential.
 */
async function semearConta(): Promise<void> {
  await db()
    .collection('integracao')
    .doc(CONTA)
    .create({
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'Loja do gatilho de preço',
      ativo: true,
      tabelaNormalOuterRef: `listaDePrecos/${TAB_N}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_P}`,
    });
}

/** A counting link of the conta to store product `idLi` (a variation of `paiLi` when given). */
function link(idLi: number, paiLi?: number): DocumentData {
  return {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: idLi,
    ...(paiLi === undefined ? {} : { paiProdutoIntegradaId: paiLi }),
    sku: `SKU-CI-PRECO-GATILHO-${String(idLi)}`,
  };
}

/**
 * A produto CREATED at its after state (never `set`: an existing document must fail loudly, not
 * become an update the deployed trigger could act on), then its link — and, for a linked produto,
 * the anchor's add awaited UNCONDITIONALLY before anything reads it.
 */
async function semearProduto(
  produtoId: string,
  dados: DocumentData,
  vinculo?: DocumentData,
): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  await ref.create({ nome: `Produto ${produtoId}`, ...dados });
  if (vinculo !== undefined) {
    await ref.collection('produtolojaintegrada').doc('l1').set(vinculo);
    await aguardarAncoraLi(db(), produtoId, comConta(CONTA), `com a conta (${produtoId})`);
  }
}

/** A `precos` map: the given tabela entries as `{ valor }` (invented prices). */
const precos = (entradas: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(entradas).map(([t, valor]) => [t, { valor }]));

/**
 * One event as the trigger receives it: the produto's before and after payloads, both anchored to
 * the conta (the anchor is a payload field), differing only in what `antes` overrides.
 */
function evento(
  produtoId: string,
  depois: DocumentData,
  antes: DocumentData,
  ancorado = true,
): EventoPrecoLi {
  const ancora = ancorado ? { integracoesComProduto: [CONTA] } : {};
  return {
    produtoId,
    antes: { nome: `Produto ${produtoId}`, ...depois, ...antes, ...ancora },
    depois: { nome: `Produto ${produtoId}`, ...depois, ...ancora },
  };
}

describe.skipIf(!EMULATED || !TASKS)(
  'the price trigger’s work, in process → the real map, parent and family reads → the real producer root',
  () => {
    const redeGlobal: string[] = [];
    const linhas: (readonly [string, string, unknown])[] = [];
    /** The payloads the REAL producer root accepted, in the order they resolved. */
    const aceitas: TarefaPrecoLi[] = [];

    /** The real producer root, each enqueue recorded once it RESOLVED (a 404 throws instead). */
    function agendadorGravado(): AgendadorPrecoLi {
      const real = criarAgendadorPrecoLiDoAmbiente();
      return {
        async enfileirar(tarefa, opcoes) {
          await real.enfileirar(tarefa, opcoes);
          aceitas.push(tarefa);
        },
      };
    }

    function deps(): DepsGatilhoPrecoLi {
      return {
        // The valve as a PARAMETER: the functions emulator reads the job env (also `dry-run`).
        ambiente: { [VALVULA_ENV_LI.preco]: MODO_LI.dryRun },
        db,
        agendador: agendadorGravado,
        agoraMs: () => Date.now(),
        logger: {
          info: (m, meta) => linhas.push(['INFO', m, meta]),
          warn: (m, meta) => linhas.push(['WARNING', m, meta]),
          error: (m, meta) => linhas.push(['ERROR', m, meta]),
        },
      };
    }

    /** What every accepted task must say besides its ids: an event, generation 0. */
    function aceitasDe(contaId: string): { produtoId: string; baixar: boolean }[] {
      for (const t of aceitas) {
        expect(t.contaId).toBe(contaId);
        expect(t.origem).toBe(ORIGEM_TAREFA_PRECO_LI.evento);
        expect(t.geracao).toBe(0);
      }
      return aceitas
        .map((t) => ({ produtoId: t.produtoId, baixar: t.baixar }))
        .sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0));
    }

    beforeAll(() => {
      // The admin app FIRST, with the project the setup pinned: the producer root reuses it.
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
      linhas.length = 0;
      aceitas.length = 0;
      await limpar();
      await semearConta();
      const anterior = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          redeGlobal.push(url);
          return anterior(input, init);
        },
      );
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      __resetAllReadCaches();
      // Nothing here reached the store: the trigger builds no client.
      const loja = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === loja);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
      await limpar();
    });

    afterAll(async () => {
      await limpar();
    });

    it('a propagating ROOT’s price edit at the conta’s BARE normal tabela ⇒ the real map finds the conta, the real family query finds the ANCHORED children only ⇒ one task each, accepted by the queue', async () => {
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
      expect(process.env[VALVULA_ENV_LI.preco]).not.toBe('on');
      const depois = { precos: precos({ [TAB_N]: 66.66 }), propagatePriceToChildren: true };
      await semearProduto(R, depois, link(ID_PAI_PRECO_LI));
      await semearProduto(F1, { paiId: R, precos: {} }, link(1001, ID_PAI_PRECO_LI));
      await semearProduto(F2, { paiId: R, precos: {} }, link(1002, ID_PAI_PRECO_LI));
      // Under the root but not anchored (no link), and another root's anchored child.
      await semearProduto(F3, { paiId: R, precos: {} });
      await semearProduto(G, { paiId: OUTRA_RAIZ, precos: {} }, link(1009, 1008));

      const r = await tratarEventoPrecoLi(
        deps(),
        evento(R, depois, { precos: precos({ [TAB_N]: 55.56 }) }),
      );

      // `tarefas: 2` only after the producer root's enqueues RESOLVED: a queue the artifact does
      // not register answers 404 and the work rethrows.
      expect(r).toEqual({
        tipo: 'processado',
        caminho: 'raiz',
        contas: [CONTA],
        leiturasDoPai: 0,
        consultas: 1,
        tarefas: 2,
        recusadas: 0,
        familiasAcimaDoLimite: 0,
        tarefasDesligadas: false,
      });
      expect(aceitasDe(CONTA)).toEqual([
        { produtoId: F1, baixar: true },
        { produtoId: F2, baixar: true },
      ]);
      expect(linhas).toContainEqual([
        'INFO',
        '[loja-integrada/preco] gatilho decidido',
        expect.objectContaining({ produtoId: R, consultas: 1, tarefas: 2 }),
      ]);
    });

    it('a CHILD’s own price edit ⇒ the real masked parent read: under a propagating parent anchored to the conta, NO task; under one with no link, or one that does not propagate, ONE task each', async () => {
      // The echo: R propagates and its anchor names the conta (read back from Firestore).
      await semearProduto(
        R,
        { precos: precos({ [TAB_N]: 66.66 }), propagatePriceToChildren: true },
        link(ID_PAI_PRECO_LI),
      );
      const deF1 = { paiId: R, precos: precos({ [TAB_N]: 66.66 }) };
      await semearProduto(F1, deF1, link(1001, ID_PAI_PRECO_LI));

      const eco = await tratarEventoPrecoLi(
        deps(),
        evento(F1, deF1, { precos: precos({ [TAB_N]: 55.56 }) }),
      );
      expect(eco).toMatchObject({
        tipo: 'processado',
        caminho: 'filho',
        leiturasDoPai: 1,
        consultas: 0,
        tarefas: 0,
      });
      expect(aceitas).toEqual([]);

      // A propagating parent whose anchor LACKS the conta: the real read returns its anchor.
      await semearProduto(S, {
        precos: precos({ [TAB_N]: 77.77 }),
        propagatePriceToChildren: true,
      });
      const deH = { paiId: S, precos: precos({ [TAB_N]: 66.66 }) };
      await semearProduto(H, deH, link(1011, 1010));
      // An ANCHORED parent that does not propagate: the real read returns its flag (an absent
      // flag would read as propagating, and this anchored parent would then own the family).
      await semearProduto(
        T,
        { precos: precos({ [TAB_N]: 77.77 }), propagatePriceToChildren: false },
        link(1020),
      );
      const deK = { paiId: T, precos: precos({ [TAB_N]: 66.66 }) };
      await semearProduto(K, deK, link(1021, 1020));

      const semVinculo = await tratarEventoPrecoLi(
        deps(),
        evento(H, deH, { precos: precos({ [TAB_N]: 55.56 }) }),
      );
      const semPropagacao = await tratarEventoPrecoLi(
        deps(),
        evento(K, deK, { precos: precos({ [TAB_N]: 55.56 }) }),
      );

      expect(semVinculo).toMatchObject({ tipo: 'processado', leiturasDoPai: 1, tarefas: 1 });
      expect(semPropagacao).toMatchObject({ tipo: 'processado', leiturasDoPai: 1, tarefas: 1 });
      expect(aceitasDe(CONTA)).toEqual([
        { produtoId: H, baixar: true },
        { produtoId: K, baixar: true },
      ]);
    });

    it('a child whose parent id names NO document ⇒ the real getAll misses ⇒ ONE task', async () => {
      const deX = { paiId: SEM_PAI, precos: precos({ [TAB_N]: 66.66 }) };
      await semearProduto(X, deX, link(1031, 1030));

      const r = await tratarEventoPrecoLi(
        deps(),
        evento(X, deX, { precos: precos({ [TAB_N]: 55.56 }) }),
      );

      expect(r).toMatchObject({
        tipo: 'processado',
        caminho: 'filho',
        leiturasDoPai: 1,
        tarefas: 1,
      });
      expect(aceitasDe(CONTA)).toEqual([{ produtoId: X, baixar: true }]);
    });

    it('a CHILDLESS root’s edit at the conta’s CANONICAL promotional tabela ⇒ the real map folds it, the real family query answers nothing ⇒ the root’s own task', async () => {
      const depois = {
        precos: precos({ [TAB_N]: 66.66, [TAB_P]: 33.33 }),
        propagatePriceToChildren: true,
      };
      await semearProduto(SIMPLES, depois, link(1040));

      const r = await tratarEventoPrecoLi(
        deps(),
        evento(SIMPLES, depois, { precos: precos({ [TAB_N]: 66.66, [TAB_P]: 44.44 }) }),
      );

      expect(r).toMatchObject({ tipo: 'processado', caminho: 'raiz', consultas: 1, tarefas: 1 });
      expect(aceitasDe(CONTA)).toEqual([{ produtoId: SIMPLES, baixar: true }]);
    });

    it('a root stored with `paiId: ""` ⇒ queried by its OWN id, never read at produtos/"" (the SDK refuses an empty id) ⇒ its anchored children’s tasks', async () => {
      const depois = {
        paiId: '',
        precos: precos({ [TAB_N]: 66.66 }),
        propagatePriceToChildren: true,
      };
      await semearProduto(VAZIA, depois, link(1050));
      await semearProduto(V1, { paiId: VAZIA, precos: {} }, link(1051, 1050));
      await semearProduto(V2, { paiId: VAZIA, precos: {} }, link(1052, 1050));

      const r = await tratarEventoPrecoLi(
        deps(),
        evento(VAZIA, depois, { precos: precos({ [TAB_N]: 55.56 }) }),
      );

      expect(r).toMatchObject({
        tipo: 'processado',
        caminho: 'raiz',
        leiturasDoPai: 0,
        consultas: 1,
        tarefas: 2,
      });
      expect(aceitasDe(CONTA)).toEqual([
        { produtoId: V1, baixar: true },
        { produtoId: V2, baixar: true },
      ]);
    });
  },
);
