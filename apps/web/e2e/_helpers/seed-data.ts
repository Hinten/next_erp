/**
 * Mock-data seeding for the TableView/ObjectView e2e suites. Writes docs
 * straight to Firestore via the Admin SDK (bypassing rules), then sweeps
 * them out by `nome` prefix afterwards.
 *
 * Every test doc — seeded here OR created through the UI during a test —
 * has its `nome` start with the run-scoped prefix from `e2ePrefix()`, so a
 * single prefix sweep cleans the whole suite without tracking ids.
 */
import { db } from '@delfrance/test-fixtures';
import { getRunId } from './run-id';

/** High Unicode code point — upper bound for a Firestore prefix range query. */
const PREFIX_MAX = String.fromCharCode(0xffff);

/**
 * Run-scoped, tag-scoped `nome` prefix. The run id keeps parallel CI runs
 * from clobbering each other; the tag separates suites (cli / cat).
 */
export function e2ePrefix(tag: string): string {
  return `e2e-${getRunId()}-${tag}`;
}

const pad = (n: number): string => String(n).padStart(3, '0');

/**
 * Seed `n` cliente docs. `nome` = `<prefix>-NNN`; `tipo`, `cpf_cnpj` and
 * `email` are varied so filter/sort tests have something to bite on.
 */
export async function seedClientes(prefix: string, n: number): Promise<void> {
  const tipos = ['0', '1', '2'] as const;
  const col = db().collection('clientes');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      tipo: tipos[i % tipos.length],
      nome: `${prefix}-${pad(i)}`,
      cpf_cnpj: String(10000000000 + i),
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: i % 2 === 0 ? `${prefix}-${pad(i)}@example.com` : null,
      telefone: null,
      observacoesInternas: null,
      timestamp: new Date().toISOString(),
      nome_embedding: null,
      telefone_embedding: null,
      userCliente: null,
    });
  }
  await batch.commit();
}

/**
 * Seed `n` categoria docs. `permiteCadastro` alternates so the boolean
 * column filter has both states.
 */
export async function seedCategorias(prefix: string, n: number): Promise<void> {
  const col = db().collection('categorias');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      nomeCompleto: i % 2 === 0 ? `${prefix}-${pad(i)} completo` : null,
      permiteCadastro: i % 2 === 0,
      categoriaGoogleId: null,
      categoriaPaiOuterRef: null,
      timestamp: new Date().toISOString(),
    });
  }
  await batch.commit();
}

/**
 * Seed `n` deposito docs. `ativo` alternates so the boolean column filter
 * has both states to bite on.
 */
export async function seedDepositos(prefix: string, n: number): Promise<void> {
  const col = db().collection('depositos');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      ativo: i % 2 === 0,
      timestamp: new Date().toISOString(),
    });
  }
  await batch.commit();
}

/**
 * Seed `n` motivoIncidente docs. `ativo` alternates for the boolean filter.
 */
export async function seedMotivosIncidente(
  prefix: string,
  n: number,
): Promise<void> {
  const col = db().collection('motivosincidentes');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      ativo: i % 2 === 0,
    });
  }
  await batch.commit();
}

/**
 * Seed `n` bandeiraCartao docs. `bandeira` cycles through Visa/Mastercard/Elo
 * and `ehCredito` alternates, so the enum + boolean column filters have
 * something to bite on.
 */
export async function seedBandeirasCartao(
  prefix: string,
  n: number,
): Promise<void> {
  const bandeiras = ['01', '02', '06'] as const; // Visa, Mastercard, Elo
  const col = db().collection('bandeirasCartao');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      ehCredito: i % 2 === 0,
      nome: `${prefix}-${pad(i)}`,
      cnpj_instituicao: null,
      bandeira: bandeiras[i % bandeiras.length],
      tarifa: 0,
      tarifaFixa: 0,
      maxParcelas: 1 + (i % 12),
      prazoRecebimento: 0,
      dataCadastro: new Date().toISOString(),
      ultimaModificacao: new Date().toISOString(),
    });
  }
  await batch.commit();
}

/**
 * Seed `n` lixeira docs — snapshots of deleted categorias, as the `onDelete`
 * Cloud Function trigger would write them. `docId` is the id the categoria
 * would be restored to and `data.nome` carries the prefix, so both the
 * lixeira sweep (by `label`) and the categorias sweep (by `nome`) catch the
 * leftovers — including the restored docs the recovery test produces.
 */
export async function seedLixeira(prefix: string, n: number): Promise<void> {
  const col = db().collection('lixeira');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    const name = `${prefix}-${pad(i)}`;
    batch.set(col.doc(), {
      collectionPath: 'categorias',
      docId: name,
      label: name,
      data: {
        nome: name,
        nomeCompleto: null,
        permiteCadastro: true,
        categoriaGoogleId: null,
        categoriaPaiOuterRef: null,
        timestamp: new Date().toISOString(),
      },
      deletedAt: new Date(Date.now() - i * 1000).toISOString(),
      deletedBy: 'e2e-seed',
    });
  }
  await batch.commit();
}

/** Delete every `lixeira` doc whose `label` starts with `prefix`. */
export async function cleanupLixeira(prefix: string): Promise<void> {
  const snap = await db()
    .collection('lixeira')
    .where('label', '>=', prefix)
    .where('label', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * True once a `lixeira` entry with the given `label` exists. The recovery
 * specs poll the negative of this — Admin SDK reads are strongly consistent —
 * to confirm a restore/purge committed before navigating on.
 */
export async function lixeiraEntryExists(label: string): Promise<boolean> {
  const snap = await db()
    .collection('lixeira')
    .where('label', '==', label)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Delete every doc in `collection` whose `nome` starts with `prefix`. Picks
 * up both seeded docs and UI-created ones (which get Firestore auto-ids).
 */
export async function cleanupByNamePrefix(
  collection: string,
  prefix: string,
): Promise<void> {
  const snap = await db()
    .collection(collection)
    .where('nome', '>=', prefix)
    .where('nome', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * True once a document with the given `nome` exists in `collection`. The
 * create-flow specs poll this to confirm a UI-created doc actually committed
 * — Admin SDK reads are strongly consistent — before navigating on, so the
 * list query can't race ahead of the write.
 */
export async function docExistsByName(
  collection: string,
  nome: string,
): Promise<boolean> {
  const snap = await db()
    .collection(collection)
    .where('nome', '==', nome)
    .limit(1)
    .get();
  return !snap.empty;
}
