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
 * Seed `n` filial docs. `razaoSocial` = `<prefix>-NNN`; `fantasia` alternates
 * null/string and the embedded `sede` carries a valid São Paulo address so
 * the nested-object ObjectView fieldset round-trips.
 */
export async function seedFiliais(prefix: string, n: number): Promise<void> {
  const col = db().collection('filiais');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      razaoSocial: `${prefix}-${pad(i)}`,
      fantasia: i % 2 === 0 ? `${prefix}-${pad(i)} fantasia` : null,
      cnae: null,
      cnpj: String(10000000000000 + i),
      ie: String(100000000 + i),
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        logradouro: 'Av. Teste',
        numero: String(i),
        bairro: 'Centro',
        complemento: null,
        cep: '01310100',
        codigoMunicipio: null,
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: null,
        pais: null,
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
      timestamp: new Date().toISOString(),
    });
  }
  await batch.commit();
}

/**
 * Seed a pedido (with `numero = <prefix>-NNN`) plus one NFe doc in its
 * `nfev4` subcollection at the requested estado. Returns the pair of ids so
 * the test can mutate the NFe mid-run via `db().collection(...)...update(...)`.
 *
 * The NFe `timestamp` (ms since epoch) is what `NFCell`'s query orders by;
 * the helper stamps `Date.now()` so the seeded doc is the most-recent NFe.
 */
export async function seedPedidoWithNFe(
  prefix: string,
  index: number,
  estado: string,
): Promise<{ pedidoId: string; nfeId: string }> {
  const pedidoId = `${prefix}-${pad(index)}`;
  const nfeId = `${prefix}-${pad(index)}-nfe`;
  const now = Date.now();
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .set({
      ehSaida: true,
      estado: 'pago',
      numero: pedidoId,
      itens: {},
      itensIds: [],
      descontoTotal: 0,
      timestamp: now,
      ultimaModificacao: now,
      foiImpresso: false,
      // The TableView's NF column reads `pedido.id`, not these inner refs;
      // outer refs stay null so the cell exercises the snapshot path
      // without dragging a cliente lookup into the assertion.
      vendedorPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
      listaDePrecosOuterRef: null,
    });
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(nfeId)
    .set({
      numeracao: 1,
      serie: 1,
      tpEmis: 1,
      estado,
      chave: null,
      idLote: null,
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: null,
      nRec: null,
      retries: null,
      cStat: null,
      xMotivo: null,
      error: null,
      timestamp: now,
      ultima_modificacao: new Date(now).toISOString(),
    });
  return { pedidoId, nfeId };
}

/**
 * Clean up a pedido seeded by `seedPedidoWithNFe` together with the NFe
 * docs in its `nfev4` subcollection. Subcollections are not cascaded by
 * the Firestore SDK; we delete them explicitly.
 */
export async function cleanupPedidoWithNFe(pedidoId: string): Promise<void> {
  const nfeSnap = await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .get();
  if (!nfeSnap.empty) {
    const batch = db().batch();
    nfeSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await db().collection('pedidos').doc(pedidoId).delete();
}

/**
 * Delete every doc in `collection` whose `field` starts with `prefix`. Picks
 * up both seeded docs and UI-created ones (which get Firestore auto-ids).
 */
export async function cleanupByFieldPrefix(
  collection: string,
  field: string,
  prefix: string,
): Promise<void> {
  const snap = await db()
    .collection(collection)
    .where(field, '>=', prefix)
    .where(field, '<', `${prefix}${PREFIX_MAX}`)
    .get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Delete every doc in `collection` whose `nome` starts with `prefix`. Picks
 * up both seeded docs and UI-created ones (which get Firestore auto-ids).
 */
export async function cleanupByNamePrefix(
  collection: string,
  prefix: string,
): Promise<void> {
  await cleanupByFieldPrefix(collection, 'nome', prefix);
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
  return docExistsByField(collection, 'nome', nome);
}

/**
 * True once a document whose `field` equals `value` exists in `collection`.
 * Generalises `docExistsByName` for collections keyed on a different field
 * (e.g. `filiais.razaoSocial`).
 */
export async function docExistsByField(
  collection: string,
  field: string,
  value: string,
): Promise<boolean> {
  const snap = await db()
    .collection(collection)
    .where(field, '==', value)
    .limit(1)
    .get();
  return !snap.empty;
}
