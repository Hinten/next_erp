import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore, Timestamp, GeoPoint, type DocumentReference } from 'firebase-admin/firestore';
// The executable migration is imported only by this Node test, never by app runtime.
import {
  inventory,
  firestoreStore,
} from '../../../../tools/migrations/src/2026-09-whatsapp-contato-cliente/migrate';
import {
  executePlan,
  verifyPlan,
} from '../../../../tools/migrations/src/2026-09-whatsapp-contato-cliente/execute';
import { encodeFirestore } from '../../../../tools/migrations/src/2026-09-whatsapp-contato-cliente/codec';
import {
  fingerprint,
  planWhatsappMigration,
  providerMessageId,
  registryId,
  type Raw,
} from '../../../../tools/migrations/src/2026-09-whatsapp-contato-cliente/transform';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || project !== 'demo-erp') {
  throw new Error(
    'Migration Firestore tests require localhost FIRESTORE_EMULATOR_HOST and project demo-erp.',
  );
}
if (process.env.FIREBASE_DATABASE_ID && process.env.FIREBASE_DATABASE_ID !== 'default') {
  throw new Error('Migration Firestore tests require the named database default.');
}
const db = new Firestore({ projectId: project, databaseId: 'default', host, ssl: false });
// These raw refs intentionally represent imported, unknown legacy fields and subcollections.
// eslint-disable-next-line no-restricted-syntax -- Testing lossless raw migration, not schema writes.
const ref = (path: string) => db.doc(path);
// eslint-disable-next-line no-restricted-syntax -- Restricted local-emulator fixture roots only.
const collection = (path: string) => db.collection(path);
const roots = [
  'clientes',
  'integracao',
  'usuarios',
  'user',
  'chat',
  'whatsappConversas',
  'whatsappIdentidades',
  'whatsappMensagens',
  'whatsappConversaAliases',
  'whatsappVinculos',
  'arquivos',
];
const T = 1_800_000_000_000;
const PHONE = '5511999998888';
const messageId = providerMessageId('migration-i', 'wamid.imported');
const options = { apply: true, finalize: true, log: (_record: unknown) => {} };

async function clearDocument(document: DocumentReference): Promise<void> {
  for (const children of await document.listCollections()) {
    for (const child of await children.listDocuments()) await clearDocument(child);
  }
  await document.delete();
}
async function clearFixtures(): Promise<void> {
  for (const root of roots) {
    for (const document of await collection(root).listDocuments()) await clearDocument(document);
    expect((await collection(root).get()).empty).toBe(true);
  }
}
async function seedImportedFixture(): Promise<void> {
  await ref('integracao/migration-i').create({ tipo: 6, nome: 'Fixture integration' });
  await ref('integracao/migration-i/credenciaisWhatsapp/synthetic').create({
    sentinel: 'SYNTHETIC-NOT-A-CREDENTIAL',
  });
  await ref('clientes/migration-c').create({
    nome: 'Cliente importado',
    telefone: PHONE,
    unknown: { keep: '01' },
  });
  await ref('arquivos/migration-media').create({
    url: 'https://example.invalid/fixture-media',
    opaque: true,
  });
  const chat = {
    origem: 'whatsapp',
    integracaoOuterRef: 'integracao/migration-i',
    clienteOuterRef: 'clientes/migration-c',
    sender_id: `5511888888888_${PHONE}`,
    estadoConversa: 0,
    data_cadastro: T,
    ultima_modificacao: T,
  };
  await ref('chat/a').create(chat);
  await ref('chat/z').create(chat);
  const message = {
    mid: 'wamid.imported',
    tipo: 'c',
    estadoEnvio: 7,
    timestamp: T,
    conteudo: '01',
    image: { image: 'documents/arquivos/migration-media' },
    custom: { untouched: '90,50' },
  };
  await ref('chat/a/mensagem/old-a').create(message);
  await ref('chat/z/mensagem/old-z').create(message);
  await ref('chat/z/mensagem/reply').create({
    tipo: 'c',
    estadoEnvio: 7,
    timestamp: T + 1000,
    context: { mensagemOuterRef: 'documents/chat/z/mensagem/old-z' },
    conteudo: 'continuidade',
  });
  await ref('chat/z/arbitrary/native/nested/leaf').create({
    timestamp: new Timestamp(1_800_000_000, 123456789),
    point: new GeoPoint(-23.5, -46.6),
    bytes: Buffer.from([0, 128, 255]),
    nativeReference: ref('chat/z/mensagem/old-z'),
    'literal.key': { $whatsappMigrationValue: 'ordinary-user-map' },
    values: [null, '01', 42, Number.NaN, Number.POSITIVE_INFINITY],
  });
}
beforeEach(async () => {
  await clearFixtures();
});
afterAll(async () => {
  await clearFixtures();
  await db.terminate();
});

describe('one-time WhatsApp migration with real Firestore storage', () => {
  it('preserves imported raw types, media, aliases and orphan subtrees; finalization reruns write nothing', async () => {
    await seedImportedFixture();
    const originalNative = (await ref('chat/z/arbitrary/native/nested/leaf').get()).data()!;
    const source = await inventory(db);
    expect(source.some((d) => d.path.includes('credenciaisWhatsapp'))).toBe(false);
    expect(source.some((d) => d.path.startsWith('arquivos/'))).toBe(false);
    expect(JSON.stringify(source)).not.toContain('SYNTHETIC-NOT-A-CREDENTIAL');
    const plan = planWhatsappMigration('demo-erp', source);
    expect(plan.pending).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    const store = firestoreStore(db);
    const copy = await executePlan(store, plan, { ...options, finalize: false });
    expect(copy.writes).toBeGreaterThan(0);
    expect(copy.deletes).toBe(0);
    expect((await ref('chat/z').get()).exists).toBe(true);
    await verifyPlan(store, plan);
    const finalized = await executePlan(store, plan, options);
    expect(finalized.writes).toBe(0);
    expect(finalized.deletes).toBeGreaterThan(0);
    await verifyPlan(store, plan, true);
    expect(await executePlan(store, plan, options)).toEqual({ writes: 0, deletes: 0 });
    expect((await collection('chat').get()).docs.map((d) => d.id)).toEqual(['a']);
    expect(
      (await ref(`whatsappConversas/${registryId('migration-i', 'migration-c')}`).get()).data()
        ?.conversaId,
    ).toBe('a');
    expect((await ref('whatsappConversaAliases/z/mensagens/old-z').get()).data()).toEqual({
      conversaId: 'a',
      mensagemId: messageId,
    });
    expect((await ref(`chat/a/mensagem/${messageId}`).get()).data()).toMatchObject({
      conteudo: '01',
      custom: { untouched: '90,50' },
      image: { image: 'documents/arquivos/migration-media' },
    });
    expect((await ref('chat/a/mensagem/reply').get()).data()?.context).toEqual({
      mensagemOuterRef: `documents/chat/a/mensagem/${messageId}`,
    });
    const native = (await ref('chat/a/arbitrary/native/nested/leaf').get()).data()!;
    expect(native.timestamp).toBeInstanceOf(Timestamp);
    expect((native.timestamp as Timestamp).isEqual(originalNative.timestamp as Timestamp)).toBe(
      true,
    );
    expect(native.point).toBeInstanceOf(GeoPoint);
    expect(native.bytes).toEqual(Buffer.from([0, 128, 255]));
    expect((native.nativeReference as DocumentReference).path).toBe(`chat/a/mensagem/${messageId}`);
    expect(native['literal.key']).toEqual({ $whatsappMigrationValue: 'ordinary-user-map' });
    expect((await ref('arquivos/migration-media').get()).data()).toEqual({
      url: 'https://example.invalid/fixture-media',
      opaque: true,
    });
    const second = planWhatsappMigration('demo-erp', await inventory(db));
    expect(second.conflicts).toEqual([]);
    expect(second.writes).toEqual([]);
    expect(second.deletes).toEqual([]);
  });

  it('an operator change after inventory aborts before the migration writes or deletes anything', async () => {
    await seedImportedFixture();
    const plan = planWhatsappMigration('demo-erp', await inventory(db));
    await ref('chat/z').update({ interveningOperatorEdit: true });
    const before = fingerprint(await inventory(db));
    await expect(executePlan(firestoreStore(db), plan, options)).rejects.toThrow(
      'mudou desde o inventário',
    );
    expect(fingerprint(await inventory(db))).toBe(before);
    expect((await collection('whatsappConversas').get()).empty).toBe(true);
    expect((await collection('chat').get()).size).toBe(2);
  });

  it('the native adapter replaces literal fields without dropping children and rejects stale deletes', async () => {
    const document = ref('chat/adapter');
    await document.create({ 'literal.key': 'old', omitted: true, preserved: { a: 1 } });
    await ref('chat/adapter/unknown/child').create({ keep: true });
    const store = firestoreStore(db);
    const initial = (await store.read(document.path))!;
    await document.update({ operator: 'won' });
    await expect(store.remove(document.path, initial.version)).rejects.toMatchObject({ code: 9 });
    await expect(
      store.replace(document.path, { shouldNotOverwrite: true }, initial.version),
    ).rejects.toThrow('Documento mudou');
    const current = (await store.read(document.path))!;
    const after = encodeFirestore({
      'literal.key': 'new',
      time: new Timestamp(123, 456000),
      bytes: Buffer.from([255]),
    }) as Raw;
    await store.replace(document.path, after, current.version);
    expect((await store.read(document.path))?.data).toEqual(after);
    expect((await document.get()).data()).not.toHaveProperty('literal');
    expect((await document.get()).data()).not.toHaveProperty('omitted');
    expect((await ref('chat/adapter/unknown/child').get()).data()).toEqual({ keep: true });
  });
});
