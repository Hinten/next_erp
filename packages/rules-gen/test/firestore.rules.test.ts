import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import { createTestEnv, EMULATED } from './helpers';

// Behavior matrix for the GENERATED firestore.rules, on the emulator. Each
// context carries hand-picked d_* claims so every assertion is bit-exact —
// the old project's `>=`-lattice model would have passed several of the
// "denied" cases here.
describe.skipIf(!EMULATED)('generated firestore.rules', () => {
  let env: RulesTestEnvironment;

  function db(claims?: Record<string, unknown>): Firestore {
    const uid = `u${Math.random().toString(36).slice(2)}`;
    const ctx = claims ? env.authenticatedContext(uid, claims) : env.unauthenticatedContext();
    return ctx.firestore() as unknown as Firestore;
  }

  async function seed(path: string, data: Record<string, unknown>): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, path), data);
    });
  }

  beforeAll(async () => {
    env = await createTestEnv();
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  describe('authentication baseline', () => {
    it('denies unauthenticated reads and writes everywhere', async () => {
      await seed('produtos/p-anon', { nome: 'x' });
      await assertFails(getDoc(doc(db(), 'produtos/p-anon')));
      await assertFails(setDoc(doc(db(), 'produtos/p-anon2'), { nome: 'y' }));
      await assertFails(getDoc(doc(db(), 'grupoEconomico/g1')));
    });

    it('denies signed-in users without claims (token.get defaults to 0)', async () => {
      await seed('produtos/p-noclaims', { nome: 'x' });
      await assertFails(getDoc(doc(db({}), 'produtos/p-noclaims')));
    });

    it('denies paths with no match block at all (default deny)', async () => {
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(getDoc(doc(su, 'colecao-inexistente/x')));
    });

    it('denies even a superuser on the admin-only filial cert secret', async () => {
      // The encrypted A1 private key lives at filiais/{id}/certificadoSecreto —
      // intentionally unregistered in ALL_DOMAINS, so no client (even max
      // claims) can read or write it. Only the Admin SDK (apps/nfe), which
      // bypasses rules, reaches the secret.
      await seed('filiais/F-1/certificadoSecreto/default', {
        encPrivateKey: { ciphertext: 'x' },
      });
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(getDoc(doc(su, 'filiais/F-1/certificadoSecreto/default')));
      await assertFails(setDoc(doc(su, 'filiais/F-1/certificadoSecreto/default'), { x: 1 }));
    });
  });

  describe('bit-exactness (no >= lattice)', () => {
    it('{d_cliente: 4} deletes but cannot read or write', async () => {
      await seed('clientes/c-del', { nome: 'a' });
      await seed('clientes/c-del2', { nome: 'b' });
      const deleter = db({ d_cliente: 4 });
      await assertFails(getDoc(doc(deleter, 'clientes/c-del')));
      await assertFails(updateDoc(doc(deleter, 'clientes/c-del'), { nome: 'x' }));
      await assertSucceeds(deleteDoc(doc(deleter, 'clientes/c-del2')));
    });

    it('{d_cliente: 1} reads but cannot delete', async () => {
      await seed('clientes/c-read', { nome: 'a' });
      const reader = db({ d_cliente: 1 });
      await assertSucceeds(getDoc(doc(reader, 'clientes/c-read')));
      await assertFails(deleteDoc(doc(reader, 'clientes/c-read')));
    });
  });

  describe('byte-sharing independence', () => {
    it('cliente claims do not leak into enderecos (byte 0)', async () => {
      await seed('clientes/c1/enderecos/e1', { rua: 'r' });
      await assertFails(getDoc(doc(db({ d_cliente: 7 }), 'clientes/c1/enderecos/e1')));
      await assertSucceeds(getDoc(doc(db({ d_endereco: 1 }), 'clientes/c1/enderecos/e1')));
    });

    it('produto claims do not leak into categorias (byte 1, promoted domain)', async () => {
      await seed('categorias/cat1', { nome: 'c' });
      await assertFails(getDoc(doc(db({ d_produto: 7 }), 'categorias/cat1')));
      await assertSucceeds(getDoc(doc(db({ d_categoria: 1 }), 'categorias/cat1')));
    });

    it('chat claims do not grant the mensagem subcollection (byte 6)', async () => {
      await seed('chat/conv1/mensagem/m1', { texto: 'oi' });
      await assertFails(getDoc(doc(db({ d_chat: 7 }), 'chat/conv1/mensagem/m1')));
      await assertSucceeds(getDoc(doc(db({ d_mensagem: 1 }), 'chat/conv1/mensagem/m1')));
    });
  });

  describe('action-bit reuse metas', () => {
    it('cargos delete requires the configuracoes WRITE bit', async () => {
      await seed('cargos/cg1', { nome: 'admin' });
      await seed('cargos/cg2', { nome: 'op' });
      await assertFails(deleteDoc(doc(db({ d_configuracoes: 1 }), 'cargos/cg1')));
      await assertSucceeds(deleteDoc(doc(db({ d_configuracoes: 2 }), 'cargos/cg2')));
    });

    it('tokenMelEnv reads require the frete WRITE bit', async () => {
      await seed('int_frete/i1/tokenMelEnv/t1', { token: 's3cret' });
      await assertFails(getDoc(doc(db({ d_frete: 1 }), 'int_frete/i1/tokenMelEnv/t1')));
      await assertSucceeds(getDoc(doc(db({ d_frete: 2 }), 'int_frete/i1/tokenMelEnv/t1')));
    });
  });

  describe('produto validator', () => {
    const writer = () => db({ d_produto: 2 });

    it('accepts a well-typed create', async () => {
      await assertSucceeds(
        setDoc(doc(writer(), 'produtos/v-ok'), { nome: 'Caneca', sku: null, ehKit: false }),
      );
    });

    it('rejects a wrongly-typed field', async () => {
      await assertFails(setDoc(doc(writer(), 'produtos/v-tipo'), { nome: 123 }));
      await assertFails(setDoc(doc(writer(), 'produtos/v-bool'), { nome: 'ok', ehKit: 'sim' }));
    });

    it('rejects oversize strings', async () => {
      await assertFails(setDoc(doc(writer(), 'produtos/v-size'), { nome: 'x'.repeat(101) }));
    });

    it('denies removing a required field via deleteField()', async () => {
      await seed('produtos/v-req', { nome: 'tem-nome' });
      await assertFails(updateDoc(doc(writer(), 'produtos/v-req'), { nome: deleteField() }));
    });

    it('allows removing a nullable field via deleteField()', async () => {
      await seed('produtos/v-null', { nome: 'n', sku: 'SKU-1' });
      await assertSucceeds(updateDoc(doc(writer(), 'produtos/v-null'), { sku: deleteField() }));
    });

    it('allows partial updates on legacy docs with out-of-schema shapes', async () => {
      // Flutter-era doc: ordem as string would fail today's clause, but an
      // update not touching it must pass (affectedKeys short-circuit).
      await seed('produtos/v-legacy', { nome: 'velho', ordem: 'not-an-int' });
      await assertSucceeds(updateDoc(doc(writer(), 'produtos/v-legacy'), { publicado: true }));
      await assertFails(updateDoc(doc(writer(), 'produtos/v-legacy'), { ordem: 'still-wrong' }));
    });
  });

  describe('collection-group reads', () => {
    it('nfeconfig group queries follow the fiscal read bit', async () => {
      await seed('filiais/f1/nfeconfig/n1', { ambiente: '2' });
      await assertSucceeds(getDocs(collectionGroup(db({ d_fiscal: 1 }), 'nfeconfig')));
      await assertFails(getDocs(collectionGroup(db({ d_nfe: 7 }), 'nfeconfig')));
    });

    it('enderecos group queries follow the endereco read bit', async () => {
      await seed('clientes/c2/enderecos/e2', { rua: 'x' });
      await assertSucceeds(getDocs(collectionGroup(db({ d_endereco: 1 }), 'enderecos')));
      await assertFails(getDocs(collectionGroup(db({ d_cliente: 7 }), 'enderecos')));
    });

    it('checkout group queries follow the pedido read bit', async () => {
      await seed('pedidos/p-chk/checkout/c1', {
        freteNoMomentoDoCheckout: { estado: 'checkFinalizado' },
        usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/u1',
        itensCheckout: [],
        timestamp: 1_700_000_000_000,
      });
      await assertSucceeds(getDocs(collectionGroup(db({ d_pedido: 1 }), 'checkout')));
      await assertFails(getDocs(collectionGroup(db({ d_nfe: 7 }), 'checkout')));
    });
  });

  describe('server-owned pedido.estoqueAplicado (meta.serverOwnedFields)', () => {
    // A client with pedido-write forging (or clearing) the applied-stock
    // snapshot could make the admin-privileged estoque sync mint or leak stock;
    // only the Admin SDK (rules-bypassing) may write real values.
    const writer = () => db({ d_pedido: 2 });
    const snapshotForjado = {
      depositoId: 'dep1',
      ehSaida: true,
      removido: { p1: 1000 },
      atualizadoEm: 1,
    };

    it('allows a create carrying the field only as null (client parse default)', async () => {
      await assertSucceeds(
        setDoc(doc(writer(), 'pedidos/so-null'), {
          estado: 'iniciado',
          ehSaida: true,
          estoqueAplicado: null,
        }),
      );
      await assertSucceeds(
        setDoc(doc(writer(), 'pedidos/so-absent'), { estado: 'iniciado', ehSaida: true }),
      );
    });

    it('denies a create forging a snapshot', async () => {
      await assertFails(
        setDoc(doc(writer(), 'pedidos/so-forge'), {
          estado: 'cancelado',
          ehSaida: true,
          estoqueAplicado: snapshotForjado,
        }),
      );
    });

    it('denies any update touching the field — set, clear, or delete', async () => {
      await seed('pedidos/so-upd', {
        estado: 'pago',
        ehSaida: true,
        estoqueAplicado: { depositoId: 'dep1', ehSaida: true, reservado: { p1: 5 } },
      });
      await assertFails(
        updateDoc(doc(writer(), 'pedidos/so-upd'), { estoqueAplicado: snapshotForjado }),
      );
      await assertFails(updateDoc(doc(writer(), 'pedidos/so-upd'), { estoqueAplicado: null }));
      await assertFails(
        updateDoc(doc(writer(), 'pedidos/so-upd'), { estoqueAplicado: deleteField() }),
      );
    });

    it('allows updates that leave the field untouched', async () => {
      await seed('pedidos/so-other', {
        estado: 'pago',
        ehSaida: true,
        estoqueAplicado: { depositoId: 'dep1', ehSaida: true, reservado: { p1: 5 } },
      });
      await assertSucceeds(updateDoc(doc(writer(), 'pedidos/so-other'), { foiImpresso: true }));
    });

    it('does not yield to the super-user claim (server-owned beats su)', async () => {
      await seed('pedidos/so-su', { estado: 'pago', ehSaida: true });
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(updateDoc(doc(su, 'pedidos/so-su'), { estoqueAplicado: snapshotForjado }));
    });
  });

  describe('server-owned integracao.user_id (meta.serverOwnedFields) — #821/T4', () => {
    // `user_id` is the Mercado Livre webhook ROUTING key: an inbound
    // notification finds its account with `where('user_id','==',…)`. A client
    // able to write it could repoint another seller's notification stream at
    // its own integração, or break routing outright. The only legitimate writer
    // is the OAuth exchange, through the rules-bypassing Admin SDK.
    const writer = () => db({ d_integracao: 2 });

    it('allows a create carrying the field only as null (client parse default)', async () => {
      await assertSucceeds(
        setDoc(doc(writer(), 'integracao/uid-null'), {
          nome: 'ML',
          tipo: 'mercadoLivre',
          user_id: null,
        }),
      );
      await assertSucceeds(
        setDoc(doc(writer(), 'integracao/uid-absent'), { nome: 'ML', tipo: 'mercadoLivre' }),
      );
    });

    it('denies a create forging a seller id', async () => {
      await assertFails(
        setDoc(doc(writer(), 'integracao/uid-forge'), {
          nome: 'ML',
          tipo: 'mercadoLivre',
          user_id: 123456789,
        }),
      );
    });

    it('denies any update touching the field — set, clear, or delete', async () => {
      await seed('integracao/uid-upd', { nome: 'ML', tipo: 'mercadoLivre', user_id: 111 });
      // The hijack: repoint this account at another seller's stream.
      await assertFails(updateDoc(doc(writer(), 'integracao/uid-upd'), { user_id: 222 }));
      await assertFails(updateDoc(doc(writer(), 'integracao/uid-upd'), { user_id: null }));
      await assertFails(updateDoc(doc(writer(), 'integracao/uid-upd'), { user_id: deleteField() }));
    });

    it('allows updates that leave the field untouched', async () => {
      await seed('integracao/uid-other', { nome: 'ML', tipo: 'mercadoLivre', user_id: 111 });
      await assertSucceeds(updateDoc(doc(writer(), 'integracao/uid-other'), { nome: 'ML 2' }));
    });

    it('does not yield to the super-user claim (server-owned beats su)', async () => {
      await seed('integracao/uid-su', { nome: 'ML', tipo: 'mercadoLivre', user_id: 111 });
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(updateDoc(doc(su, 'integracao/uid-su'), { user_id: 222 }));
    });
  });

  describe('server-owned produtos/historicoDeModificacoes (meta.serverOwned)', () => {
    // Written EXCLUSIVELY by the onProdutoChanged trigger (Admin SDK, which
    // bypasses rules entirely). Reads follow the ordinary produto read bit;
    // ALL client writes are denied outright — including a superuser, unlike
    // the per-field serverOwnedFields guard tested above.
    const entry = {
      path: 'produtos/p-hist',
      subcolecao: null,
      docId: 'p-hist',
      kind: 'update',
      campos: ['nome'],
      changes: { nome: { old: 'a', new: 'b' } },
      timestamp: 1_700_000_000_000,
      eventId: 'evt-1',
    };

    it('the produto read bit reads a single entry and lists the subcollection', async () => {
      await seed('produtos/p-hist/historicoDeModificacoes/evt-1', entry);
      const reader = db({ d_produto: 1 });
      await assertSucceeds(getDoc(doc(reader, 'produtos/p-hist/historicoDeModificacoes/evt-1')));
      await assertSucceeds(getDocs(collection(reader, 'produtos/p-hist/historicoDeModificacoes')));
    });

    it('the produto read bit collection-group-reads across produtos', async () => {
      await assertSucceeds(
        getDocs(collectionGroup(db({ d_produto: 1 }), 'historicoDeModificacoes')),
      );
      await assertFails(getDocs(collectionGroup(db({ d_pedido: 7 }), 'historicoDeModificacoes')));
    });

    it('denies every client write, even with the produto write bit', async () => {
      const writer = db({ d_produto: 2 });
      await assertFails(
        setDoc(doc(writer, 'produtos/p-hist/historicoDeModificacoes/evt-2'), entry),
      );
      await assertFails(
        updateDoc(doc(writer, 'produtos/p-hist/historicoDeModificacoes/evt-1'), { campos: [] }),
      );
      await assertFails(deleteDoc(doc(writer, 'produtos/p-hist/historicoDeModificacoes/evt-1')));
    });

    it('denies every write even for a superuser (no su bypass)', async () => {
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(setDoc(doc(su, 'produtos/p-hist/historicoDeModificacoes/evt-3'), entry));
      await assertFails(
        updateDoc(doc(su, 'produtos/p-hist/historicoDeModificacoes/evt-1'), { campos: [] }),
      );
      await assertFails(deleteDoc(doc(su, 'produtos/p-hist/historicoDeModificacoes/evt-1')));
    });
  });

  describe('balanço (#454)', () => {
    // The counting screen writes movimentos freely; everything that decides
    // whether a count has been APPLIED to stock is server-owned, so a client
    // with estoque-write can open a balanço and never move it forward.
    const escritor = () => db({ d_estoque: 2 });

    it('opens a balanço only with the workflow fields null or absent', async () => {
      await assertSucceeds(
        setDoc(doc(escritor(), 'balanco/b-null'), {
          nome: 'Contagem',
          depositoOuterRef: 'documents/depositos/dep1',
          estado: null,
          dataFinalizado: null,
          finalizacao: null,
        }),
      );
      await assertSucceeds(
        setDoc(doc(escritor(), 'balanco/b-absent'), {
          nome: 'Contagem',
          depositoOuterRef: 'documents/depositos/dep1',
        }),
      );
    });

    it('denies a create that opens straight into a finalized state', async () => {
      await assertFails(
        setDoc(doc(escritor(), 'balanco/b-forjado'), {
          nome: 'Já contado',
          depositoOuterRef: 'documents/depositos/dep1',
          estado: 'finalizado',
          dataFinalizado: 1_700_000_000_000,
        }),
      );
    });

    it('denies any update touching estado, dataFinalizado or finalizacao', async () => {
      await seed('balanco/b-upd', {
        nome: 'Contagem',
        depositoOuterRef: 'documents/depositos/dep1',
        estado: 'finalizado',
        dataFinalizado: 1_700_000_000_000,
      });
      // Re-opening a finalized balanço is the attack this blocks: it would let
      // the same movimentos be applied a second time over whatever stock moved
      // since.
      await assertFails(updateDoc(doc(escritor(), 'balanco/b-upd'), { estado: null }));
      await assertFails(updateDoc(doc(escritor(), 'balanco/b-upd'), { estado: 'finalizando' }));
      await assertFails(
        updateDoc(doc(escritor(), 'balanco/b-upd'), { dataFinalizado: deleteField() }),
      );
      await assertFails(
        updateDoc(doc(escritor(), 'balanco/b-upd'), { finalizacao: { shardCursor: 99 } }),
      );
      // Renaming is still an ordinary write.
      await assertSucceeds(updateDoc(doc(escritor(), 'balanco/b-upd'), { nome: 'Contagem 2' }));
    });

    it('does not yield the workflow lock to the super-user claim', async () => {
      await seed('balanco/b-su', {
        nome: 'Contagem',
        depositoOuterRef: 'documents/depositos/dep1',
        estado: 'finalizado',
        dataFinalizado: 1,
      });
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(updateDoc(doc(su, 'balanco/b-su'), { estado: null }));
    });

    it('lets the estoque write bit lançar and soft-cancel a movimento', async () => {
      await assertSucceeds(
        setDoc(doc(escritor(), 'balanco/b-null/movimentos/m1'), {
          produtoOuterRef: 'documents/produtos/p1',
          produtoId: 'p1',
          quantidade: 3,
          usuarioOuterRef: 'documents/usuarios/u1',
          error: false,
          removido: false,
        }),
      );
      await assertSucceeds(
        updateDoc(doc(escritor(), 'balanco/b-null/movimentos/m1'), { removido: true }),
      );
    });

    it('denies every client write to the stored relatório (serverOwned, no su)', async () => {
      const shard = { itens: { p1: { sku: 'A', nome: 'N', estoque: 8, contado: 5 } } };
      await seed('balanco/b-null/relatorios/0000', shard);
      await assertSucceeds(getDoc(doc(db({ d_estoque: 1 }), 'balanco/b-null/relatorios/0000')));
      await assertFails(setDoc(doc(escritor(), 'balanco/b-null/relatorios/0001'), shard));
      await assertFails(
        updateDoc(doc(escritor(), 'balanco/b-null/relatorios/0000'), { itens: {} }),
      );
      await assertFails(deleteDoc(doc(escritor(), 'balanco/b-null/relatorios/0000')));
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(deleteDoc(doc(su, 'balanco/b-null/relatorios/0000')));
    });

    it('denies collection-group reads of movimentos and relatorios', async () => {
      // `meta.noCollectionGroupRead` — every read of these is scoped to one
      // balanço, so the recursive `{path=**}` block the generator emits by
      // default is a query surface with no caller. The legacy ruleset shipped
      // exactly that block for both (#454).
      const leitor = db({ d_estoque: 1 });
      await assertFails(getDocs(collectionGroup(leitor, 'movimentos')));
      await assertFails(getDocs(collectionGroup(leitor, 'relatorios')));
      // The parent-scoped list still works — this is about the query SHAPE.
      await assertSucceeds(getDocs(collection(leitor, 'balanco/b-null/movimentos')));
    });

    it('keeps balanço on the estoque bits — produto claims do not reach it', async () => {
      await assertFails(getDoc(doc(db({ d_produto: 7 }), 'balanco/b-upd')));
      await assertSucceeds(getDoc(doc(db({ d_estoque: 1 }), 'balanco/b-upd')));
    });
  });

  // ⚠️ DUAL-RUN ONLY — delete this whole block with the Flutter decommission
  // (#829). These four Mercado Livre collections are reached by the NEW app only
  // through the Admin SDK (or not at all); they carry client match blocks purely
  // so the generated ruleset reproduces the grants the deployed legacy ruleset
  // already gives the Flutter client (perm codes m1/m2/m4/mb,
  // `.old/firestore.rules:168-191,219-224`). See #783.
  describe('Mercado Livre dual-run client grants (#829)', () => {
    it('{d_integracao: 1} reads the ML token stores the Flutter app depends on', async () => {
      // The Flutter OAuth connect screen writes both docs and every ML action
      // screen reads tokenDuravel through MercadoLivreApi — without these blocks
      // the whole Flutter ML UI dies the moment this ruleset deploys.
      await seed('integracao/i-ml/token6h/t1', { token: 'TG-code', expires_in: 1 });
      await seed('integracao/i-ml/tokenDuravel/t1', {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 1,
      });
      const reader = db({ d_integracao: 1 });
      await assertSucceeds(getDoc(doc(reader, 'integracao/i-ml/token6h/t1')));
      await assertSucceeds(getDoc(doc(reader, 'integracao/i-ml/tokenDuravel/t1')));
    });

    it('{d_integracao: 2} creates and refreshes tokenDuravel, {4} deletes it', async () => {
      const writer = db({ d_integracao: 2 });
      await assertSucceeds(
        setDoc(doc(writer, 'integracao/i-ml/tokenDuravel/t-new'), {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 1,
        }),
      );
      // The Flutter refresh path rewrites the doc in place.
      await assertSucceeds(
        updateDoc(doc(writer, 'integracao/i-ml/tokenDuravel/t-new'), { access_token: 'a2' }),
      );
      // The conta deleteCascade removes both token docs client-side.
      await assertSucceeds(
        deleteDoc(doc(db({ d_integracao: 4 }), 'integracao/i-ml/tokenDuravel/t-new')),
      );
    });

    it('is bit-exact: a read claim cannot write, and another domain cannot read', async () => {
      await seed('integracao/i-ml/tokenDuravel/t-bits', {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 1,
      });
      await assertFails(
        updateDoc(doc(db({ d_integracao: 1 }), 'integracao/i-ml/tokenDuravel/t-bits'), {
          access_token: 'x',
        }),
      );
      await assertFails(getDoc(doc(db({ d_produto: 7 }), 'integracao/i-ml/tokenDuravel/t-bits')));
      await assertFails(getDoc(doc(db({}), 'integracao/i-ml/tokenDuravel/t-bits')));
    });

    it('exposes the token collection groups, mirroring the legacy {parent=**} blocks', async () => {
      await assertSucceeds(getDocs(collectionGroup(db({ d_integracao: 1 }), 'tokenDuravel')));
      await assertSucceeds(getDocs(collectionGroup(db({ d_integracao: 1 }), 'token6h')));
      await assertFails(getDocs(collectionGroup(db({ d_frete: 7 }), 'tokenDuravel')));
    });

    it('grants the two top-level ML collections on the same claim', async () => {
      await seed('notificacoesMercadoLivre/n1', { resource: '/orders/1', topic: 'orders_v2' });
      await seed('questionsML/q1', { id: 1, seller_id: 2, item_id: 'MLB1', text: 'oi' });
      const reader = db({ d_integracao: 1 });
      await assertSucceeds(getDoc(doc(reader, 'notificacoesMercadoLivre/n1')));
      await assertSucceeds(getDoc(doc(reader, 'questionsML/q1')));
      await assertFails(getDoc(doc(db({ d_pedido: 7 }), 'notificacoesMercadoLivre/n1')));
      await assertFails(getDoc(doc(db({ d_chat: 7 }), 'questionsML/q1')));
    });

    it('does NOT relax the sibling credential stores, even for a superuser', async () => {
      // The dual-run exception is ML-token-only: `credenciais` and
      // `credenciaisWhatsapp` hold live refresh tokens with no legacy client
      // grant to preserve, so they must stay unregistered and default-denied.
      await seed('integracao/i-ml/credenciais/c1', { access_token: 'a', refresh_token: 'r' });
      await seed('integracao/i-wa/credenciaisWhatsapp/c1', { permanent_token: 'p' });
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await assertFails(getDoc(doc(su, 'integracao/i-ml/credenciais/c1')));
      await assertFails(getDoc(doc(su, 'integracao/i-wa/credenciaisWhatsapp/c1')));
      await assertFails(setDoc(doc(su, 'integracao/i-ml/credenciais/c2'), { x: 1 }));
    });
  });

  describe('grupoEconomico tenant registry', () => {
    it('signed-in users read exactly their own grupo doc', async () => {
      await seed('grupoEconomico/g1', { nome: 'Grupo 1' });
      await seed('grupoEconomico/g2', { nome: 'Grupo 2' });
      const tenant = db({ grupoEconomico: 'g1' });
      await assertSucceeds(getDoc(doc(tenant, 'grupoEconomico/g1')));
      await assertFails(getDoc(doc(tenant, 'grupoEconomico/g2')));
      await assertFails(updateDoc(doc(tenant, 'grupoEconomico/g1'), { nome: 'hack' }));
    });
  });

  describe('superuser-shaped claims', () => {
    it('the minted superuser projection passes everywhere gated by claims', async () => {
      const su = db(rulesClaimsFromBits((1n << 128n) - 1n));
      await seed('pedidos/su-p', { ehSaida: true });
      await assertSucceeds(getDoc(doc(su, 'pedidos/su-p')));
      await assertSucceeds(updateDoc(doc(su, 'pedidos/su-p'), { foiImpresso: true }));
      await assertSucceeds(deleteDoc(doc(su, 'pedidos/su-p')));
      await assertSucceeds(
        setDoc(doc(su, 'metodo_pgto/su-m'), { tipo: 1, nome: 'MP', hasLinkPagamento: true }),
      );
      await assertSucceeds(getDocs(collection(su, 'usuarios')));
    });
  });
});
