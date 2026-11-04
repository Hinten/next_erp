/**
 * The anchor trigger, end to end, against the real emulators (`ci-loja-integrada.yml`; master
 * plan step 9, PR 9-v) — and the FIRST real-Firestore run of the shared `integracoesComProduto`
 * core under a Loja Integrada binding: its `arrayUnion`, its guarded remove (the core's
 * inventoried multi-document read-and-write, which this app's fake does not model) and the
 * binding's UNFILTERED survivor read inside it.
 *
 * What runs for real here, with nothing mocked:
 *
 *   a write to produtos/{produtoId}/produtolojaintegrada/{linkId} from THIS process
 *     → the Firestore emulator → the Functions emulator
 *     → onProdutoLojaIntegradaLinkChanged            the real deployed onDocumentWritten
 *     → planejarMudancaDeLinkLi → adicionarContaLi | removerContaLiSeOrfa (the core)
 *     → produtos/{produtoId}.integracoesComProduto, read back RAW
 *
 * Four behaviours, one case each:
 *   - a link create ADDS its conta to its produto's anchor;
 *   - `removido: true` on the ONLY link REMOVES it;
 *   - a second counting link of the same conta (stored in the bare ref form) is OBSERVED keeping
 *     it, and losing that last one removes it through the real guarded write — see below for
 *     how far the "keeps" half goes;
 *   - a link under ANOTHER conta never touches this one, on its add or on its removal.
 *
 * ⚠️ NOT covered here, and deliberately so:
 *   - every zero-read ABSENCE (an edit of `nome`, a mirror field, another channel's link). An
 *     emulator cannot prove that a function did nothing; those are pinned offline
 *     (`onProdutoLojaIntegradaLinkChanged.test.ts`, with a handle that throws on any touch).
 *   - the DATABASE binding. The emulator serves whatever database it is asked for, so a wrong one
 *     is not proven to fail here; `index.test.ts` pins `eventFilters.database` to exactly
 *     `'default'`. The positive existence read of each seeded produto is what stops a
 *     mis-targeted suite from passing on "not found".
 *   - Eventarc's ordering and redelivery; the emulator delivers each write once. The remove
 *     re-derives from what is stored, so it is order-proof; the add is NOT (an add handled after
 *     its link's close leaves a stale entry — the accepted residual in the trigger's docblock).
 *
 * ⚠️ "Keeps" and "never touches" are absences, never polled for. "Never touches" IS proved by
 * later positives: the other conta's add and removal are writes of the very invocations that
 * could have touched the first conta, observed before it is looked at. "Keeps" is NOT proved
 * here: a check that keeps writes nothing, so nothing marks when it ended, and the sentinel
 * conta's add (written AFTER the flip) orders the flip's check before the look at the kept conta
 * only as far as the functions emulator serializes the two invocations — which it need not. A
 * broken survivor read (say, one narrowed to the canonical ref form) could therefore drop the
 * conta after the look and still pass this file. The KEEP verdict and the survivor read's fold of
 * both stored ref forms are pinned OFFLINE (`integracoesComProdutoLi.test.ts`: the survivor pairs
 * and the whole-subcollection read); this case shows only that the real guarded write runs on
 * this produto and that losing the LAST counting link removes the conta.
 *
 * ⚠️ This suite SHARES its emulators with every other `*.tasks.test.ts` / `*.firestore.test.ts`
 * file, and this trigger fires on THEIR link writes too (`pedidos/importarPedido.firestore.test.ts`
 * seeds some). So: its produto and conta ids (`*-li-ancora-ci-*`) are seeded by no other suite;
 * it writes no `integracao` doc (the anchor reads no conta), so the conta trigger never runs for
 * it; and every case ends by deleting its links and awaiting the anchor's last write
 * (`testing/ancoraLi.ts`) before the produto goes, so no anchor write of this file lands in the
 * next one.
 */
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  aguardarAncoraLi,
  comConta,
  contasDaAncoraLi,
  semConta,
} from '../../lib/lojaIntegrada/testing/ancoraLi';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The functions emulator is mandatory in this lane's run; the tasks host proves the `--only` set. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake produto ids, seeded by no other emulator suite. */
const PRODUTO = {
  criar: 'produto-li-ancora-ci-criar',
  remover: 'produto-li-ancora-ci-remover',
  manter: 'produto-li-ancora-ci-manter',
  outraConta: 'produto-li-ancora-ci-outra-conta',
} as const;

/** Obviously fake conta ids: the anchor reads no conta document, so none is seeded. */
const CONTA_A = 'conta-li-ancora-ci-a';
const CONTA_B = 'conta-li-ancora-ci-b';
const SENTINELA = 'conta-li-ancora-ci-sentinela';

/** The spec's public example produto id. */
const ID_LI = 182904918;

function db(): Firestore {
  return getAdminFirestore();
}

function produtoRef(produto: string): DocumentReference {
  return db().collection('produtos').doc(produto);
}

function linkRef(produto: string, link: string): DocumentReference {
  return produtoRef(produto).collection('produtolojaintegrada').doc(link);
}

/** A counting link (a store product id, not in the trash) of `conta`, as the import writes it. */
function link(conta: string, over: DocumentData = {}): DocumentData {
  return {
    contaLojaIntegrada: `documents/integracao/${conta}`,
    id: ID_LI,
    paiProdutoIntegradaId: null,
    sku: 'SKU-ANCORA-CI',
    nome: 'Produto de teste da âncora',
    ativo: true,
    bloqueado: false,
    removido: false,
    ...over,
  };
}

/** Seed the produto, and prove by a POSITIVE read that this process sees the trigger's database. */
async function semearProduto(produto: string): Promise<void> {
  await produtoRef(produto).set({ nome: 'Produto de teste da âncora', sku: `sku-${produto}` });
  expect(await contasDaAncoraLi(db(), produto)).toEqual([]);
}

/**
 * Delete the produto's links ONE BY ONE, wait for the anchor's last write (every conta of this
 * suite exists only through links under this produto, so the array ends EMPTY: the last delete's
 * check finds no survivor), then delete the produto. In that order, so no anchor write of this
 * file is still running when the next file starts.
 */
async function encerrar(produto: string): Promise<void> {
  const links = await produtoRef(produto).collection('produtolojaintegrada').get();
  for (const doc of links.docs) await doc.ref.delete();
  if ((await produtoRef(produto).get()).exists) {
    await aguardarAncoraLi(db(), produto, (contas) => contas.length === 0, 'vazio (encerramento)');
    await produtoRef(produto).delete();
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'onProdutoLojaIntegradaLinkChanged → o integracoesComProduto segue os vínculos (emuladores)',
  () => {
    beforeAll(() => {
      db();
    });

    async function limpar(): Promise<void> {
      for (const produto of Object.values(PRODUTO)) await encerrar(produto);
    }

    // In a fresh emulator nothing here exists yet, so these deletes fire no trigger; they only
    // matter after an earlier case failed mid-way.
    beforeEach(limpar);
    // The teardown that keeps this file's anchor writes inside this file.
    afterEach(limpar);

    it('a criação de um vínculo ADICIONA a conta ao integracoesComProduto do produto', async () => {
      const produto = PRODUTO.criar;
      await semearProduto(produto);

      await linkRef(produto, String(ID_LI)).set(link(CONTA_A));

      const contas = await aguardarAncoraLi(db(), produto, comConta(CONTA_A), 'com a conta A');
      // Exactly the bare conta id: the array stores ids, the link stores a ref.
      expect(contas).toEqual([CONTA_A]);
      // Only the array key was written: the produto's own fields are byte-equal.
      expect((await produtoRef(produto).get()).data()).toEqual({
        nome: 'Produto de teste da âncora',
        sku: `sku-${produto}`,
        integracoesComProduto: [CONTA_A],
      });
    }, 120_000);

    it('removido: true no ÚNICO vínculo REMOVE a conta', async () => {
      const produto = PRODUTO.remover;
      await semearProduto(produto);
      await linkRef(produto, String(ID_LI)).set(link(CONTA_A));
      await aguardarAncoraLi(db(), produto, comConta(CONTA_A), 'com a conta A');

      await linkRef(produto, String(ID_LI)).update({ removido: true });

      const contas = await aguardarAncoraLi(db(), produto, semConta(CONTA_A), 'sem a conta A');
      expect(contas).toEqual([]);
      // The link itself stays: the anchor writes only the produto.
      expect((await linkRef(produto, String(ID_LI)).get()).data()?.removido).toBe(true);
    }, 120_000);

    it('um segundo vínculo vivo da MESMA conta a MANTÉM — e só a perda do último a remove', async () => {
      const produto = PRODUTO.manter;
      await semearProduto(produto);
      await linkRef(produto, 'vinculo-1').set(link(CONTA_A));
      // The same conta in the BARE stored form, and another store product id: the real survivor
      // read sees it here, but the fold of both forms is PINNED offline (the docblock: this case
      // cannot order a no-write check).
      await linkRef(produto, 'vinculo-2').set(
        link(CONTA_A, { contaLojaIntegrada: `integracao/${CONTA_A}`, id: ID_LI + 1 }),
      );
      await aguardarAncoraLi(db(), produto, comConta(CONTA_A), 'com a conta A');

      await linkRef(produto, 'vinculo-1').update({ removido: true });
      // The LATER sentinel: a conta written after the flip, observed before A is looked at. It
      // orders the flip's (no-write) check first only if the emulator serialized the two.
      await linkRef(produto, 'sentinela').set(link(SENTINELA, { id: ID_LI + 2 }));
      const comSentinela = await aguardarAncoraLi(
        db(),
        produto,
        comConta(SENTINELA),
        'com a sentinela',
      );
      expect(comSentinela).toContain(CONTA_A);

      // The closing positive: losing the LAST counting link of A removes it, through the same
      // real guarded remove — and leaves the sentinel's conta alone.
      await linkRef(produto, 'vinculo-2').update({ removido: true });
      const semA = await aguardarAncoraLi(db(), produto, semConta(CONTA_A), 'sem a conta A');
      expect(semA).toEqual([SENTINELA]);
    }, 120_000);

    it('um vínculo de OUTRA conta nunca toca esta — nem ao entrar, nem ao sair', async () => {
      const produto = PRODUTO.outraConta;
      await semearProduto(produto);
      await linkRef(produto, 'vinculo-a').set(link(CONTA_A));
      await aguardarAncoraLi(db(), produto, comConta(CONTA_A), 'com a conta A');

      // B's add is a write this file observes: once it landed, A is looked at.
      await linkRef(produto, 'vinculo-b').set(link(CONTA_B, { id: ID_LI + 3 }));
      const comB = await aguardarAncoraLi(db(), produto, comConta(CONTA_B), 'com a conta B');
      expect([...comB].sort()).toEqual([CONTA_A, CONTA_B].sort());

      // B's removal is a write too: once it landed, A is still there.
      await linkRef(produto, 'vinculo-b').update({ removido: true });
      const semB = await aguardarAncoraLi(db(), produto, semConta(CONTA_B), 'sem a conta B');
      expect(semB).toEqual([CONTA_A]);
    }, 120_000);
  },
);
