/**
 * The draft route's decisions (`./rascunho.ts`, #1911 P4) against a REAL
 * Firestore — the emulator lane, `ci-shopee.yml`'s ONE job
 * (`vitest.tasks.config.ts` collects the `.firestore.` suffix).
 *
 * `rascunho.test.ts` covers every decision over `FakeDb`. That is a good test
 * of the LOGIC, but the double is the test telling itself what the engine does
 * — and P4 extended it (the guarded `delete`) precisely to make these paths
 * expressible. So this file covers only what the real engine must confirm:
 *
 *  1. **`create()` answers a real `ALREADY_EXISTS`** — a double click writes
 *     ONE document and the retry is decided by the content compare (200
 *     `criado: false`, or 409 `CONFLITO` with the document untouched); another
 *     owner's document at the id is 409 `ID_EM_USO`.
 *  2. **A stale `update(…, {lastUpdateTime})` is REFUSED by the engine**, and
 *     the module re-derives: a concurrent edit of the same field surfaces as
 *     `CONFLITO` with the winner intact; one of another field lets both land.
 *  3. **A stale `delete({lastUpdateTime})` is REFUSED by the engine** — the
 *     discard decided on an old read never removes a newer edit.
 *  4. **The `default` database wiring**, through the PRODUCTION accessor
 *     `getAdminFirestore()`: every case carries a POSITIVE existence assertion,
 *     because in the emulator a mis-targeted `(default)` database silently
 *     exists (`vitest.tasks.setup.ts` (3)).
 *
 * "Nothing was written" is read through the server `updateTime`: a refused
 * write leaves it where it was.
 *
 * ⚠️ **Shared emulators — why this file may write the link-trigger path.** The
 * functions emulator loads `onProdutoShopeeLinkChanged` on
 * `produtos/{id}/prodshopee/{id}`, and this file writes there. It may, because
 * EVERY document it writes there is a DRAFT (`item_id: null`, never
 * `anuncioShopeeVivo`): the trigger's fast path (`planejarMudancaDeLinkShopee`)
 * answers the empty plan for a create, an edit or a delete of a non-vivo link
 * and returns with ZERO reads and ZERO writes, so nothing lands after this
 * file's cleanup. The cases that need a LIVE link (`JA_PUBLICADO`, a vivo
 * sibling for D15) stay on `FakeDb`. It NEVER writes `integracao/{id}` — the
 * create's conta read is injected (`lerConta`), so `onIntegracaoShopeeChanged`
 * cannot fire — and `produtos/{id}` itself has no trigger in this codebase.
 * Contas are minted (`int-rasc-1`, `int-rasc-2`; the round trips own
 * `int-1`…`int-4`), every produto id is a fresh `prod-rasc-<uuid>`, and
 * `afterEach` deletes everything the file wrote.
 *
 * ⚠️ No network and no Shopee: the draft route makes no provider call at all.
 */
import { randomUUID } from 'node:crypto';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { produtoCollection, produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  INTEGRACAO_TIPO,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  camposDoRascunhoShopee,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  RecusaDeRascunhoShopeeError,
  atualizarRascunhoShopee,
  criarRascunhoShopee,
  descartarRascunhoShopee,
  type DepsDoRascunhoShopee,
} from './rascunho';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

/** Minted for this file — never `int-1`…`int-4`, which belong to the round trips. */
const CONTA = 'int-rasc-1';
const OUTRA_CONTA = 'int-rasc-2';
const AGORA = 1_757_000_000_000;

/**
 * Resolved per call, never at import: without the emulator this file must SKIP,
 * and `getAdminFirestore()` throws when no project id is configured.
 */
const db = (): Firestore => getAdminFirestore();

/** Every produto this file wrote (the produto doc and its drafts), for `afterEach`. */
const produtos = new Set<string>();
/** Every draft path this file may have written, for `afterEach`. */
const rascunhos = new Set<string>();

/** A fresh produto id, with its produto document written (no trigger watches it). */
async function novoProduto(): Promise<string> {
  const produtoId = `prod-rasc-${randomUUID()}`;
  produtos.add(produtoId);
  await produtoCollection
    .docRef(db(), {}, produtoId)
    .set({ nome: 'Camiseta Básica', paiId: null, ehKit: false, ehKitVirtual: false });
  return produtoId;
}

/** A fresh client-generated draft id — Firestore's auto-id shape, 20 characters. */
function novoId(): string {
  return produtoShopeeLinkCollection.newDocId(db(), { produtoId: 'qualquer' });
}

function refDoRascunho(produtoId: string, linkDocId: string): DocumentReference {
  rascunhos.add(produtoShopeeLinkCollection.docPath({ produtoId }, linkDocId));
  return produtoShopeeLinkCollection.docRef(db(), { produtoId }, linkDocId);
}

/** A DRAFT of `conta` — the only kind of link this file ever writes (see the header). */
function rascunho(conta: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contaProdutoShopeeOuterRef: `documents/integracao/${conta}`,
    item_id: null,
    item_name: 'Camiseta do rascunho',
    description: null,
    category_id: 100_017,
    brand_id: 0,
    original_brand_name: null,
    ...extra,
  };
}

/** The create's conta read, injected: `integracao/{id}` is never written here. */
const deps = (over: Partial<DepsDoRascunhoShopee> = {}): DepsDoRascunhoShopee => ({
  db: db(),
  nowMs: AGORA,
  lerConta: () => Promise.resolve({ tipo: INTEGRACAO_TIPO.shopee }),
  ...over,
});

/**
 * The stored fields of a draft that must exist (the positive assertion), and
 * its server `updateTime` at FULL precision (seconds + nanoseconds — a
 * millisecond rendering could make two writes in one millisecond look equal).
 */
async function lido(ref: DocumentReference): Promise<{
  readonly dados: Record<string, unknown>;
  readonly updateTime: string;
}> {
  const snap = await ref.get();
  expect(snap.exists).toBe(true);
  const t = snap.updateTime;
  return {
    dados: snap.data() ?? {},
    updateTime: t === undefined ? '' : `${String(t.seconds)}:${String(t.nanoseconds)}`,
  };
}

async function recusaDe(p: Promise<unknown>): Promise<RecusaDeRascunhoShopeeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof RecusaDeRascunhoShopeeError)) {
    throw new Error(`esperava RecusaDeRascunhoShopeeError, veio ${String(err)}`);
  }
  return err;
}

/** Binds a method to the REAL target, so the Admin SDK's internals see their own object. */
function ligado(alvo: object, prop: string | symbol): unknown {
  const valor = Reflect.get(alvo, prop, alvo) as unknown;
  return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
}

/**
 * The real database, except that the FIRST read of `caminho` lets a concurrent
 * writer land right after it — between the module's decision and its guarded
 * write. The engine, not the test, then refuses the stale write.
 */
function comEscritaConcorrente(caminho: string, escrever: () => Promise<void>): Firestore {
  const real = db();
  let lido1 = false;
  return new Proxy(real, {
    get(t, prop) {
      if (prop !== 'collection') return ligado(t, prop);
      return (colPath: string) =>
        new Proxy(t.collection(colPath), {
          get(ct, cp) {
            if (cp !== 'doc') return ligado(ct, cp);
            return (id: string) =>
              new Proxy(ct.doc(id), {
                get(rt, rp) {
                  if (rp !== 'get' || rt.path !== caminho) return ligado(rt, rp);
                  return async () => {
                    const snap = await rt.get();
                    if (!lido1) {
                      lido1 = true;
                      await escrever();
                    }
                    return snap;
                  };
                },
              });
          },
        });
    },
  });
}

afterEach(async () => {
  const fs = db();
  await Promise.all([...rascunhos].map((caminho) => fs.doc(caminho).delete()));
  await Promise.all(
    [...produtos].map((produtoId) => produtoCollection.docRef(fs, {}, produtoId).delete()),
  );
  rascunhos.clear();
  produtos.clear();
});

/* -------------------------------------------------------------------------- */
/*                                   Cases                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(!EMULATED)('the draft route on the Firestore emulator', () => {
  describe('create() at the client id — the real ALREADY_EXISTS', () => {
    it('a double click writes ONE document: 201, then 200 criado:false with the stored document untouched', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      const corpo = corpoCriarRascunhoShopeeSchema.parse({
        integracaoId: CONTA,
        produtoId,
        linkDocId,
        conteudo: { item_name: 'Camiseta Azul', category_id: 100_017 },
      });

      expect(await criarRascunhoShopee(deps(), corpo)).toEqual({ linkDocId, criado: true });
      const primeiro = await lido(ref);
      expect(await criarRascunhoShopee(deps({ nowMs: AGORA + 5_000 }), corpo)).toEqual({
        linkDocId,
        criado: false,
      });

      const segundo = await lido(ref);
      expect(segundo.updateTime).toBe(primeiro.updateTime);
      expect(segundo.dados).toMatchObject({
        contaProdutoShopeeOuterRef: `documents/integracao/${CONTA}`,
        item_id: null,
        item_name: 'Camiseta Azul',
        dataCadastro: AGORA,
      });
      expect(segundo.dados).not.toHaveProperty('publicacaoEmCurso');
    });

    it('a retry with OTHER content ⇒ 409 CONFLITO, nothing written', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      const corpo = (item_name: string) =>
        corpoCriarRascunhoShopeeSchema.parse({
          integracaoId: CONTA,
          produtoId,
          linkDocId,
          conteudo: { item_name },
        });

      await criarRascunhoShopee(deps(), corpo('Camiseta'));
      const antes = await lido(ref);
      const err = await recusaDe(criarRascunhoShopee(deps(), corpo('Camiseta Azul')));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' }]);
      expect((await lido(ref)).updateTime).toBe(antes.updateTime);
    });

    it("another CONTA's draft at the id ⇒ 409 ID_EM_USO, untouched — ⛔ the same id under ANOTHER produto is another document (201)", async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      await ref.set(rascunho(OUTRA_CONTA));
      const antes = await lido(ref);

      const err = await recusaDe(
        criarRascunhoShopee(
          deps(),
          corpoCriarRascunhoShopeeSchema.parse({ integracaoId: CONTA, produtoId, linkDocId }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.idEmUso);
      expect(await lido(ref)).toEqual(antes);

      // A document id is per produto: the SAME id one produto over is free.
      const outroProduto = await novoProduto();
      const outroRef = refDoRascunho(outroProduto, linkDocId);
      expect(
        await criarRascunhoShopee(
          deps(),
          corpoCriarRascunhoShopeeSchema.parse({
            integracaoId: CONTA,
            produtoId: outroProduto,
            linkDocId,
          }),
        ),
      ).toEqual({ linkDocId, criado: true });
      expect((await lido(outroRef)).dados.contaProdutoShopeeOuterRef).toBe(
        `documents/integracao/${CONTA}`,
      );
    });
  });

  describe('the guarded update — a real stale lastUpdateTime', () => {
    it('a concurrent edit of the SAME field after the read ⇒ the engine refuses ours, the re-read surfaces CONFLITO, the winner stays', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      await ref.set(rascunho(CONTA));
      const corrida = comEscritaConcorrente(ref.path, async () => {
        await db().doc(ref.path).update({ item_name: 'Escrito pela outra aba' });
      });

      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps({ db: corrida }),
          corpoAtualizarRascunhoShopeeSchema.parse({
            integracaoId: CONTA,
            produtoId,
            linkDocId,
            base: { item_name: 'Camiseta do rascunho' },
            patch: { item_name: 'Camiseta Azul' },
          }),
        ),
      );

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([
        { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Escrito pela outra aba' },
      ]);
      expect((await lido(ref)).dados.item_name).toBe('Escrito pela outra aba');
    });

    it('⛔ a concurrent edit of ANOTHER field ⇒ refused once, re-derived, and BOTH edits land', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      await ref.set(rascunho(CONTA));
      const corrida = comEscritaConcorrente(ref.path, async () => {
        await db().doc(ref.path).update({ description: 'Escrita pela outra aba' });
      });

      const r = await atualizarRascunhoShopee(
        deps({ db: corrida }),
        corpoAtualizarRascunhoShopeeSchema.parse({
          integracaoId: CONTA,
          produtoId,
          linkDocId,
          base: { item_name: 'Camiseta do rascunho' },
          patch: { item_name: 'Camiseta Azul' },
        }),
      );

      expect(r).toEqual({ linkDocId, gravados: [CAMPO_RASCUNHO_SHOPEE.itemName] });
      expect((await lido(ref)).dados).toMatchObject({
        item_name: 'Camiseta Azul',
        description: 'Escrita pela outra aba',
        ultimaModificacao: AGORA,
      });
    });
  });

  describe('the guarded delete — a real stale lastUpdateTime', () => {
    it('the discard decided on the read it made ⇒ the draft is gone', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      await ref.set(rascunho(CONTA));
      await lido(ref);

      expect(
        await descartarRascunhoShopee(
          deps(),
          corpoDescartarRascunhoShopeeSchema.parse({
            integracaoId: CONTA,
            produtoId,
            linkDocId,
            base: camposDoRascunhoShopee(rascunho(CONTA)),
          }),
        ),
      ).toEqual({ linkDocId, descartado: true, criacaoIncerta: false });
      expect((await ref.get()).exists).toBe(false);
    });

    it('a concurrent edit after the read ⇒ the engine refuses the stale delete, the re-read surfaces CONFLITO, the edit survives', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      await ref.set(rascunho(CONTA));
      const corrida = comEscritaConcorrente(ref.path, async () => {
        await db().doc(ref.path).update({ item_name: 'Editado em outra aba' });
      });

      const err = await recusaDe(
        descartarRascunhoShopee(
          deps({ db: corrida }),
          corpoDescartarRascunhoShopeeSchema.parse({
            integracaoId: CONTA,
            produtoId,
            linkDocId,
            base: camposDoRascunhoShopee(rascunho(CONTA)),
          }),
        ),
      );

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect((await lido(ref)).dados.item_name).toBe('Editado em outra aba');
    });

    it('an INCERTA draft without the attestation ⇒ 409 CRIACAO_INCERTA, the document untouched', async () => {
      const produtoId = await novoProduto();
      const linkDocId = novoId();
      const ref = refDoRascunho(produtoId, linkDocId);
      const expiraEm = AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;
      await ref.set(
        rascunho(CONTA, {
          publicacaoEmCurso: {
            desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
            expiraEm,
            token: 'token-de-outra-execucao',
          },
        }),
      );
      const antes = await lido(ref);

      const err = await recusaDe(
        descartarRascunhoShopee(
          deps(),
          corpoDescartarRascunhoShopeeSchema.parse({
            integracaoId: CONTA,
            produtoId,
            linkDocId,
            base: camposDoRascunhoShopee(antes.dados),
          }),
        ),
      );

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.criacaoIncerta);
      expect(await lido(ref)).toEqual(antes);
    });
  });
});
