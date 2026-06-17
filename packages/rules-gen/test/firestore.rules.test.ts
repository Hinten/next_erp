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
