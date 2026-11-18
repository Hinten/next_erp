/**
 * ONE stock send run (master plan step 12, PR 12-e), IN-PROCESS against the real emulators
 * (`ci-loja-integrada.yml`), on the `pollPedidos.tasks.test.ts` precedent.
 *
 * What runs for real here:
 *
 *   processarTarefaEstoqueLi(db, task, deps)     the real run, in THIS process
 *     → lerContaEmCache, the produto's masked read and its where-less links listing
 *     → the own record by the `in` query over BOTH depósito ref forms, limit 3
 *     → the never-had-stock listing (where-less, limit 1) when nothing is at the depósito
 *     → the duplicate probe: a COLLECTION-GROUP query per conta ref form,
 *       `contaLojaIntegrada == form AND id in [n, 'n']`
 *     → loadLojaIntegradaContextoEscrita: the conta, the credential (real Firestore)
 *     → the write engine against a SCRIPTED store (`deps.fetch`, `testing/plataformaEscritaLi.ts`)
 *     → the read-back, and on a drift the ONE `deriva` follow-up through
 *       criarAgendadorEstoqueLiDoAmbiente()  the real producer root of the codebase
 *       → the region-qualified `filaEstoqueLojaIntegrada` → the Cloud Tasks emulator, which
 *         ACCEPTS it only if the deployed artifact registers that queue (a 404 otherwise)
 *
 * ⚠️ The valve, the canary and the read switch are ON in THIS process only, passed as a PARAMETER
 * (`ambiente`): `process.env` is never touched — the setup refuses to start with any of them on
 * there, because the functions emulator inherits this shell's environment. So the DISPATCHED
 * follow-up passes the stock valve (`dry-run` in the lane, since PR 12-f) and stops at its write
 * context on the read switch: it runs its ERP reads, writes nothing and logs its lines in the
 * emulator's process. That hop is unobservable here BY DESIGN (no failure store, no write on
 * success); the queue's options and its dispatch are pinned offline
 * (`functions/src/index.test.ts`, `functions/src/filaEstoque.test.ts`). The emulator ignores the
 * task's schedule (firebase-tools#8254), so nothing here asserts it.
 *
 * ⚠️ Every record this suite writes also fires the DEPLOYED stock trigger (PR 12-f): at the lane's
 * `dry-run` valve it may enqueue a send run for a linked produto here, which stops at its write
 * context and writes nothing. No kits header is seeded, so it never fans out (no slot write).
 *
 * What this proves that the offline suite cannot: each query shape the run builds is accepted by
 * a real Firestore and finds what it must — a record stored under the BARE depósito ref, a record
 * at another depósito, another produto's link under the bare conta ref with a TEXT id — and the
 * producer root reaches a queue the artifact registers. NOT proven: the declared indexes (the
 * emulator auto-creates every one; `leituraEstoqueErp.test.ts` pins each query against
 * `firestore.indexes.json`), the scan cost on Enterprise, and any real store call (none before the cutover).
 *
 * Isolation (`vitest.tasks.config.ts`): a conta id and produto ids no other suite seeds; the conta
 * carries no filial and no `dataCadastro`, so the conta trigger only reads; every link create
 * fires the anchor trigger, so each linked produto's anchor write is awaited before the run, and
 * every case ends by deleting its links and awaiting the conta leaving each array before its
 * produtos go (`testing/ancoraLi.ts`). Nothing here writes `historicoFtIni` or an import job.
 */
import { type DocumentData, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueLi,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorEstoqueLiDoAmbiente } from '../../../functions/src/agendadorEstoque';
import { CANARIO_ENV_LI, CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../core/valvulas';
import { aguardarAncoraLi, comConta, semConta } from '../testing/ancoraLi';
import { AGORA_MS, credencialDoc, gravadorDeLog } from '../testing/fixtures';
import { ID_PRODUTO_LI } from '../testing/pedidosLi';
import {
  CAMINHO_ESTOQUE_PRODUTO_LI,
  type PlataformaEscritaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  respostaJson,
} from '../testing/plataformaEscritaLi';
import { type DepsEstoqueLi, processarTarefaEstoqueLi } from './processarEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The producer root's enqueue is half of what this suite proves — gate on the tasks emulator too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-estoque-ci';
const DEP = 'dep-li-estoque-ci';
const OUTRO_DEP = 'dep-li-estoque-ci-outro';
const PRODUTO = 'p-li-estoque-ci';
const OUTRO_PRODUTO = 'p-li-estoque-ci-dup';
const PRODUTOS = [PRODUTO, OUTRO_PRODUTO] as const;

function db(): Firestore {
  return getAdminFirestore();
}

/** Every produto's links and records, then the produto; the anchor's last write awaited between. */
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

/** The conta on the depósito, with a usable credential. No filial: the conta trigger only reads. */
async function semearConta(): Promise<void> {
  const conta = db().collection('integracao').doc(CONTA);
  await conta.set({
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja de teste',
    ativo: true,
    depositoOuterRef: `documents/depositos/${DEP}`,
  });
  await conta.collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());
}

/**
 * A produto with its records, then its links — the produto FIRST (the anchor never creates one) —
 * and the anchor's add awaited, unconditionally, before anything reads it.
 */
async function semearProduto(
  produtoId: string,
  registros: Readonly<Record<string, DocumentData>>,
  links: Readonly<Record<string, DocumentData>>,
): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  await ref.set({ ehKit: false, sku: `SKU-${produtoId}` });
  for (const [id, dados] of Object.entries(registros)) {
    await ref.collection('estoques').doc(id).set(dados);
  }
  for (const [id, dados] of Object.entries(links)) {
    await ref.collection('produtolojaintegrada').doc(id).set(dados);
  }
  if (Object.keys(links).length > 0) {
    await aguardarAncoraLi(db(), produtoId, comConta(CONTA), `com a conta (${produtoId})`);
  }
}

/** Our child link of the conta to store product `ID_PRODUTO_LI`, canonical ref, number id. */
const LINK = {
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id: ID_PRODUTO_LI,
  paiProdutoIntegradaId: 900_001,
  sku: 'SKU-CI',
};

function tarefa(over: Partial<TarefaEstoqueLi> = {}): TarefaEstoqueLi {
  return {
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
    janela: Math.floor(AGORA_MS / 60_000),
    estoqueId: null,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
    ...over,
  };
}

/** The run's deps: everything ON as a PARAMETER (header), the scripted store, the REAL producer root. */
function deps(p: PlataformaEscritaLi): DepsEstoqueLi {
  return {
    ambiente: {
      [CHAMADAS_ENV_LI]: MODO_LI.on,
      [VALVULA_ENV_LI.estoque]: MODO_LI.on,
      [CANARIO_ENV_LI.estoque]: '*',
    },
    esperar: p.esperar,
    agoraMs: () => AGORA_MS,
    inicioDaTarefaMs: AGORA_MS,
    increment: (by: number) => FieldValue.increment(by),
    logger: { warn: () => undefined, error: () => undefined },
    registro: { escrever: gravadorDeLog().escrever, tentativa: 0, idTarefa: 'estoque-ci' },
    fetch: p.fetch,
    tentativa: 0,
    agendador: criarAgendadorEstoqueLiDoAmbiente(),
  };
}

describe.skipIf(!EMULATED || !TASKS)(
  'one stock send run, in process → the real queries → the scripted store → the real producer root',
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
      const loja = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === loja);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
      await limpar();
    });

    afterAll(async () => {
      await limpar();
    });

    it('a record stored under the BARE depósito ref, no hint ⇒ found by the real `in` query; GET, PUT S + R, read-back ⇒ written', async () => {
      // The emulator process must see the switch OFF; this process passes it ON as a parameter only.
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
      expect(process.env[VALVULA_ENV_LI.estoque]).not.toBe('on');
      await semearProduto(
        PRODUTO,
        // An auto-id record, the bare form: neither the canonical id nor the canonical ref.
        {
          'auto-ci-1': {
            depositoOuterRef: `depositos/${DEP}`,
            quantidade: 5,
            quantidadeReservada: 0,
          },
        },
        { l1: LINK },
      );
      const p = criarPlataformaEscritaLi({
        estoque: [linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 1, quantidade_reservada: 2 })],
      });

      const r = await processarTarefaEstoqueLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
      expect(p.chamadas()).toEqual([
        `GET ${CAMINHO_ESTOQUE_PRODUTO_LI}`,
        `PUT ${CAMINHO_ESTOQUE_PRODUTO_LI}`,
        `GET ${CAMINHO_ESTOQUE_PRODUTO_LI}`,
      ]);
      // Model A: S 5 + the store's reservation 2, under the four fixed leaves.
      expect(p.puts()[0]?.corpo).toEqual({
        gerenciado: true,
        quantidade: 7,
        situacao_em_estoque: 0,
        situacao_sem_estoque: -1,
      });
    });

    it('nothing at the conta’s depósito, a record at ANOTHER ⇒ the real where-less listing finds it ⇒ PUT 0 + R', async () => {
      await semearProduto(
        PRODUTO,
        {
          [`est-${PRODUTO}-${OUTRO_DEP}`]: {
            depositoOuterRef: `documents/depositos/${OUTRO_DEP}`,
            quantidade: 9,
            quantidadeReservada: 0,
          },
        },
        { l1: LINK },
      );
      const p = criarPlataformaEscritaLi({
        estoque: [linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 4, quantidade_reservada: 3 })],
      });

      const r = await processarTarefaEstoqueLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
      // The other depósito's 9 never counts: 0 at ours, plus the reservation.
      expect(p.puts()[0]?.corpo).toMatchObject({ quantidade: 3 });
    });

    it('ANOTHER produto holds a counting link of the same conta and store id — bare conta ref, TEXT id ⇒ the real collection-group probe finds it: skipped, no store call', async () => {
      await semearProduto(
        PRODUTO,
        {
          [`est-${PRODUTO}-${DEP}`]: {
            depositoOuterRef: `documents/depositos/${DEP}`,
            quantidade: 5,
            quantidadeReservada: 0,
          },
        },
        { l1: LINK },
      );
      await semearProduto(
        OUTRO_PRODUTO,
        {},
        {
          l9: {
            contaLojaIntegrada: `integracao/${CONTA}`,
            id: String(ID_PRODUTO_LI),
            paiProdutoIntegradaId: 900_001,
            sku: 'SKU-CI-DUP',
          },
        },
      );
      const p = criarPlataformaEscritaLi({
        estoque: [linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 1 })],
      });

      const r = await processarTarefaEstoqueLi(db(), tarefa(), deps(p));

      expect(r).toEqual({ kind: 'pulado', motivo: 'vinculo-duplicado' });
      expect(p.requisicoes).toEqual([]);
    });

    it('an order LEAVES between the GET and the PUT ⇒ the read-back sees the reservation moved ⇒ ONE deriva follow-up through the REAL producer root, and the enqueue RESOLVES', async () => {
      await semearProduto(
        PRODUTO,
        {
          [`est-${PRODUTO}-${DEP}`]: {
            depositoOuterRef: `documents/depositos/${DEP}`,
            quantidade: 5,
            quantidadeReservada: 0,
          },
        },
        { l1: LINK },
      );
      const p = criarPlataformaEscritaLi({
        estoque: [linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 8, quantidade_reservada: 4 })],
      });
      // The deciding GET answers the row as it stood, and the order then leaves: q − 2, r − 2.
      p.fila.push((req) => {
        if (req.metodo !== 'GET' || req.caminho !== CAMINHO_ESTOQUE_PRODUTO_LI) return null;
        const linha = p.estado.estoque.get(ID_PRODUTO_LI);
        if (linha === undefined) throw new TypeError('sem linha');
        const resposta = respostaJson(200, structuredClone(linha));
        linha.quantidade = Number(linha.quantidade) - 2;
        linha.quantidade_reservada = Number(linha.quantidade_reservada) - 2;
        linha.quantidade_disponivel = Number(linha.quantidade) - Number(linha.quantidade_reservada);
        return resposta;
      });

      const r = await processarTarefaEstoqueLi(db(), tarefa(), deps(p));

      // `enfileirado` is returned only after the producer root's enqueue RESOLVED: a queue the
      // artifact does not register answers 404 and the run rethrows; a closed valve would be
      // `tarefas-desligadas`.
      expect(r).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
      expect(p.puts()[0]?.corpo).toMatchObject({ quantidade: 9 });
    });
  },
);
