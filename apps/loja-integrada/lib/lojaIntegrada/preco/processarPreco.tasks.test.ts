/**
 * ONE price send run (master plan step 13, PR 13-d), IN-PROCESS against the real emulators
 * (`ci-loja-integrada.yml`), on the stock send run's precedent (`estoque/processarEstoque.tasks.test.ts`).
 *
 * What runs for real here:
 *
 *   processarTarefaPrecoLi(db, task, deps)       the real run, in THIS process
 *     → lerContaEmCache, the produto's masked point read and its where-less links listing
 *     → the parent's masked point read (only after the link verdict, only for a valid id)
 *     → the duplicate probe: a COLLECTION-GROUP query per conta ref form,
 *       `contaLojaIntegrada == form AND id in [n, 'n']`
 *     → loadLojaIntegradaContextoEscrita: the conta, the credential (real Firestore)
 *     → the write engine against a SCRIPTED store (`deps.fetch`, `testing/plataformaEscritaLi.ts`)
 *     → the read-back, and on a drift the ONE `deriva` follow-up through
 *       criarAgendadorPrecoLiDoAmbiente()  the real producer root of the codebase
 *       → the region-qualified `filaPrecoLojaIntegrada` → the Cloud Tasks emulator, which
 *         ACCEPTS it only if the deployed artifact registers that queue (a 404 otherwise)
 *
 * ⚠️ The valve, the canary and the read switch are ON in THIS process only, passed as a PARAMETER
 * (`ambiente`): `process.env` is never touched — the setup refuses to start with any of them on
 * there, because the functions emulator inherits this shell's environment. So the DISPATCHED
 * follow-up passes the price valve (`dry-run` in the lane) and stops at its write context on the
 * read switch: it runs its ERP reads, writes nothing and logs its lines in the emulator's process.
 * That hop is unobservable here BY DESIGN (no failure store, no write on success); the queue's
 * options and its dispatch are pinned offline (`functions/src/index.test.ts`,
 * `functions/src/filaPreco.test.ts`). The emulator ignores the task's schedule
 * (firebase-tools#8254), so nothing here asserts it.
 *
 * What this proves that the offline suite cannot: each read the run builds is accepted by a real
 * Firestore and finds what it must — the masked produto and parent reads (the parent's price
 * propagated to its child), a parent id that names no document, another produto's link under the
 * BARE conta ref with a TEXT id — and the producer root reaches a queue the artifact registers.
 * NOT proven: the declared indexes (the emulator auto-creates every one; the stock reader's suite
 * pins the shared probe against `firestore.indexes.json`), the scan cost on Enterprise, and any
 * real store call (none before the cutover).
 *
 * Isolation (`vitest.tasks.config.ts`): a conta id and produto ids no other suite seeds; the conta
 * is CREATED, never updated, and carries no filial and no `dataCadastro`, so the conta trigger only
 * reads; no stock record is written, so the stock trigger never fires; every link create fires the
 * anchor trigger, so each linked produto's anchor write is awaited before the run, and every case
 * ends by deleting its links and awaiting the conta leaving each array before its produtos go
 * (`testing/ancoraLi.ts`). Every produto is CREATED after a delete and never edited, so the price
 * trigger (`onPrecoLojaIntegrada`, PR 13-e) never passes its relevance gate on this suite. Nothing
 * here writes `historicoFtIni` or an import job. Every value is INVENTED (`testing/precoLi.ts`).
 */
import { type DocumentData, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorPrecoLiDoAmbiente } from '../../../functions/src/agendadorPreco';
import { CANARIO_ENV_LI, CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../core/valvulas';
import { aguardarAncoraLi, comConta, semConta } from '../testing/ancoraLi';
import type { DocData } from '../testing/fakeDb';
import { AGORA_MS, credencialDoc, gravadorDeLog } from '../testing/fixtures';
import {
  type PlataformaEscritaLi,
  caminhoPrecoProdutoLi,
  caminhoProdutoDetalheLi,
  criarPlataformaEscritaLi,
  gravarPrecoPadraoLi,
} from '../testing/plataformaEscritaLi';
import { ID_PAI_PRECO_LI, detalhePrecoLi } from '../testing/precoLi';
import { type DepsPrecoLi, processarTarefaPrecoLi } from './processarPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The producer root's enqueue is half of what this suite proves — gate on the tasks emulator too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-preco-ci';
const PRODUTO = 'p-li-preco-ci';
const PAI = 'p-li-preco-ci-pai';
const OUTRO_PRODUTO = 'p-li-preco-ci-dup';
const PRODUTOS = [PRODUTO, PAI, OUTRO_PRODUTO] as const;
const TAB_N = 'tab-li-preco-ci-normal';
const TAB_P = 'tab-li-preco-ci-promo';

/** The invented store product linked to {@link PRODUTO}: a variation of {@link ID_PAI_PRECO_LI}. */
const ID = 1001;
const GET = `GET ${caminhoProdutoDetalheLi(ID)}`;
const PUT = `PUT ${caminhoPrecoProdutoLi(ID)}`;

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
 * The conta with both tabelas and a usable credential, by a CREATE (never an update: the conta
 * trigger's arms fire on updates). No filial: the conta trigger only reads.
 */
async function semearConta(): Promise<void> {
  const conta = db().collection('integracao').doc(CONTA);
  await conta.create({
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja de teste',
    ativo: true,
    tabelaNormalOuterRef: `documents/listaDePrecos/${TAB_N}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_P}`,
  });
  await conta.collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());
}

/**
 * A produto, then its links — the produto FIRST (the anchor never creates one) — and the anchor's
 * add awaited, unconditionally, before anything reads it.
 */
async function semearProduto(
  produtoId: string,
  dados: DocumentData,
  links: Readonly<Record<string, DocumentData>> = {},
): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  await ref.set({ sku: `SKU-${produtoId}`, ...dados });
  for (const [id, link] of Object.entries(links)) {
    await ref.collection('produtolojaintegrada').doc(id).set(link);
  }
  if (Object.keys(links).length > 0) {
    await aguardarAncoraLi(db(), produtoId, comConta(CONTA), `com a conta (${produtoId})`);
  }
}

/** Our child link of the conta to store product {@link ID}: canonical ref, number id. */
const LINK = {
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id: ID,
  paiProdutoIntegradaId: ID_PAI_PRECO_LI,
  sku: 'SKU-CI-PRECO',
};

/** A child with no price of its own, under `paiId`. */
const filho = (paiId: string) => ({ paiId, precos: {} });

/** A propagating parent: the normal tabela at `cheio`, the promotional one at `promo` when given. */
function pai(cheio: number, promo?: number): DocumentData {
  return {
    precos: {
      [TAB_N]: { valor: cheio },
      ...(promo === undefined ? {} : { [TAB_P]: { valor: promo } }),
    },
    propagatePriceToChildren: true,
  };
}

function tarefa(over: Partial<TarefaPrecoLi> = {}): TarefaPrecoLi {
  return {
    tipo: TIPO_TAREFA_PRECO_LI,
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    janela: Math.floor(AGORA_MS / 60_000),
    geracao: 0,
    baixar: false,
    ...over,
  };
}

/** The run's deps: everything ON as a PARAMETER (header), the scripted store, the REAL producer root. */
function deps(p: PlataformaEscritaLi): DepsPrecoLi {
  return {
    ambiente: {
      [CHAMADAS_ENV_LI]: MODO_LI.on,
      [VALVULA_ENV_LI.preco]: MODO_LI.on,
      [CANARIO_ENV_LI.preco]: '*',
    },
    esperar: p.esperar,
    agoraMs: () => AGORA_MS,
    inicioDaTarefaMs: AGORA_MS,
    increment: (by: number) => FieldValue.increment(by),
    logger: { warn: () => undefined, error: () => undefined },
    registro: { escrever: gravadorDeLog().escrever, tentativa: 0, idTarefa: 'preco-ci' },
    fetch: p.fetch,
    tentativa: 0,
    agendador: criarAgendadorPrecoLiDoAmbiente(),
  };
}

/** The store's detail of {@link ID}, its prices as given (invented). */
const loja = (cheio: number, promo: number | null) =>
  criarPlataformaEscritaLi({
    produtos: [
      detalhePrecoLi(ID, { preco_cheio: cheio, preco_promocional: promo, preco_custo: null }),
    ],
  });

describe.skipIf(!EMULATED || !TASKS)(
  'one price send run, in process → the real reads → the scripted store → the real producer root',
  () => {
    /** Every request that reached the GLOBAL fetch — the scripted store is `deps.fetch`. */
    const redeGlobal: string[] = [];

    beforeAll(() => {
      // Initialise the admin app FIRST, with the project the setup pinned: the producer root's
      // `getAdminApp()` reuses the default app.
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
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
      // The store was reached ONLY through the scripted `deps.fetch`.
      const host = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === host);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
      await limpar();
    });

    afterAll(async () => {
      await limpar();
    });

    it('a CHILD under a propagating PARENT ⇒ the real masked reads of both, the links and the probe; GET, PUT, read-back ⇒ written', async () => {
      // The emulator process must see the switch OFF; this process passes it ON as a parameter only.
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
      expect(process.env[VALVULA_ENV_LI.preco]).not.toBe('on');
      await semearProduto(PAI, pai(55.56));
      await semearProduto(PRODUTO, filho(PAI), { l1: LINK });
      const p = loja(33.33, 22.22);

      const r = await processarTarefaPrecoLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
      expect(p.chamadas()).toEqual([GET, PUT, GET]);
      // The full price is the parent's normal entry; the parent names no promotion, so the
      // store's is cleared under the default forma (`nulo`).
      expect(p.textosDosPuts).toEqual(['{"cheio":55.56,"promocional":null,"sob_consulta":false}']);
      expect(p.estado.produtos.get(ID)).toMatchObject({
        preco_cheio: 55.56,
        preco_promocional: null,
      });
    });

    it('a parent id that names NO document ⇒ the real parent read misses ⇒ held (`retido`), no store call', async () => {
      await semearProduto(PRODUTO, filho('p-li-preco-ci-sem-pai'), { l1: LINK });
      const p = loja(33.33, null);

      const r = await processarTarefaPrecoLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'pulado', motivo: 'retido' });
      expect(p.requisicoes).toEqual([]);
    });

    it('ANOTHER produto holds a counting link of the same conta and store id — bare conta ref, TEXT id ⇒ the real collection-group probe finds it: skipped, no store call', async () => {
      await semearProduto(PAI, pai(55.56));
      await semearProduto(PRODUTO, filho(PAI), { l1: LINK });
      await semearProduto(
        OUTRO_PRODUTO,
        { precos: {} },
        {
          l9: {
            contaLojaIntegrada: `integracao/${CONTA}`,
            id: String(ID),
            paiProdutoIntegradaId: ID_PAI_PRECO_LI,
            sku: 'SKU-CI-PRECO-DUP',
          },
        },
      );
      const p = loja(33.33, null);

      const r = await processarTarefaPrecoLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'pulado', motivo: 'vinculo-duplicado' });
      expect(p.requisicoes).toEqual([]);
    });

    it('a store that TRUNCATES the promotion it stores ⇒ the read-back sees a drift ⇒ ONE deriva follow-up through the REAL producer root, and the enqueue RESOLVES', async () => {
      await semearProduto(PAI, pai(55.56, 44.44));
      await semearProduto(PRODUTO, filho(PAI), { l1: LINK });
      const p = criarPlataformaEscritaLi({
        produtos: [
          detalhePrecoLi(ID, { preco_cheio: 33.33, preco_promocional: 22.22, preco_custo: null }),
        ],
        // The store keeps whole reais of a promotion.
        gravacaoPreco: (corpo: DocData, detalhe: DocData) => {
          gravarPrecoPadraoLi(corpo, detalhe);
          if (typeof corpo.promocional === 'number') {
            detalhe.preco_promocional = Math.trunc(corpo.promocional);
          }
        },
      });

      const r = await processarTarefaPrecoLi(db(), tarefa(), deps(p));

      // `enfileirado` is returned only after the producer root's enqueue RESOLVED: a queue the
      // artifact does not register answers 404 and the run rethrows; a closed valve would be
      // `tarefas-desligadas`.
      expect(r).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
      expect(p.chamadas()).toEqual([GET, PUT, GET]);
      expect(p.textosDosPuts).toEqual(['{"cheio":55.56,"promocional":44.44,"sob_consulta":false}']);
    });
  },
);
