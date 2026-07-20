import { db } from './admin';

/**
 * Dev-seed for product variations — two `grupoDeVariacoes` (Tamanhos P/M/G,
 * Cores Azul/Verde) plus one parent produto ("Camiseta Dev") and its 6
 * Cartesian children, written with the exact Flutter wire shapes:
 *
 *  - parent `grupoDeVariacoesUid`: bare group ids sorted by `ordem`;
 *  - `variacoesUid` (parent + children): fake paths
 *    `documents/grupoDeVariacoes/<grupoId>/variacoes/<varianteId>`,
 *    group-major order;
 *  - child `nome` = parent nome + variant nomes, `sku` = parent sku +
 *    variant códigos, `ordem` = Cartesian position, `paiId` = parent id.
 *
 * Gives the `/produtos/<id>/editar` Variações tab (and the Flutter app) a
 * ready-made parent+children set to exercise Gerar/Reconstituir against.
 *
 * Idempotent: fixed doc ids, plain set() overwrites. Pass `--clean` to
 * delete everything this seed created.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:variacoes
 *   pnpm --filter @delfrance/test-fixtures seed:variacoes --clean
 */

const TAMANHOS_ID = 'DEV_TAMANHOS';
const CORES_ID = 'DEV_CORES';
const PARENT_ID = 'dev-camiseta-pai';

const TAMANHOS = [
  { id: 'tam-p', nome: 'P', codigo: 'P' },
  { id: 'tam-m', nome: 'M', codigo: 'M' },
  { id: 'tam-g', nome: 'G', codigo: 'G' },
];
const CORES = [
  { id: 'cor-azul', nome: 'Azul', codigo: 'AZ' },
  { id: 'cor-verde', nome: 'Verde', codigo: 'VD' },
];

const fakePath = (grupoId: string, varianteId: string): string =>
  `documents/grupoDeVariacoes/${grupoId}/variacoes/${varianteId}`;

export async function seedDevVariacoes(): Promise<{ children: number }> {
  // grupoDeVariacoes datetimes are millisecondsSinceEpoch INT (#484/#486). The
  // produto `timestamp`/`ultimaModificacao` ISO writes below are UNMODELED
  // legacy-wire fields — `produtoSchema` doesn't declare them, so they're
  // soft-stripped on read; dev-seed color only, not a wire contract.
  const nowMs = Date.now();
  const now = new Date().toISOString();
  const batch = db().batch();
  const grupos = db().collection('grupoDeVariacoes');
  const produtos = db().collection('produtos');

  batch.set(grupos.doc(TAMANHOS_ID), {
    nome: 'Tamanhos Dev',
    codigo: 'tamanhos',
    ordem: 1,
    tipo: 1,
    permiteFotos: false,
    variacoesIds: TAMANHOS.map((v) => v.id),
    variacoes: TAMANHOS.map((v) => ({ ...v, timestamp: nowMs })),
    timestamp: nowMs,
  });
  batch.set(grupos.doc(CORES_ID), {
    nome: 'Cores Dev',
    codigo: 'cores',
    ordem: 2,
    tipo: 2,
    permiteFotos: true,
    variacoesIds: CORES.map((v) => v.id),
    variacoes: CORES.map((v) => ({ ...v, timestamp: nowMs })),
    timestamp: nowMs,
  });

  const parentNome = 'Camiseta Dev';
  const parentSku = 'CAMDEV';
  const allUids = [
    ...TAMANHOS.map((v) => fakePath(TAMANHOS_ID, v.id)),
    ...CORES.map((v) => fakePath(CORES_ID, v.id)),
  ];

  /** Shared scalar defaults matching the Flutter `Produto` constructor. */
  const produtoBase = {
    gtin: null,
    codFornecedor: null,
    codPai: null,
    categoriaProdutoOuterRef: null,
    pesoLiquidoKg: 0.2,
    pesoBrutoKg: 0.25,
    alturaCm: 2,
    larguraCm: 30,
    profundidadeCm: 40,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    crossdocking: null,
    componentesKitKeys: [],
    componentesKit: null,
    integracoesComProduto: [],
    marketplaceIds: [],
    marketplace: [],
    statusProdutosMarketplace: null,
    fotos: null,
    videos: null,
    anexos: null,
    fotosArquivosIds: [],
    nome_embedding: null,
    ultimaModificacao: now,
    timestamp: now,
  };

  batch.set(produtos.doc(PARENT_ID), {
    ...produtoBase,
    nome: parentNome,
    sku: parentSku,
    paiId: null,
    ordem: null,
    grupoDeVariacoesUid: [TAMANHOS_ID, CORES_ID],
    variacoesUid: allUids,
  });

  // 6 children — Cartesian (Tamanhos × Cores), group-major order.
  let ordem = 0;
  for (const tam of TAMANHOS) {
    for (const cor of CORES) {
      batch.set(produtos.doc(`dev-camiseta-${tam.id}-${cor.id}`), {
        ...produtoBase,
        nome: `${parentNome} ${tam.nome} ${cor.nome}`,
        sku: `${parentSku}${tam.codigo}${cor.codigo}`,
        paiId: PARENT_ID,
        ordem,
        grupoDeVariacoesUid: null,
        variacoesUid: [fakePath(TAMANHOS_ID, tam.id), fakePath(CORES_ID, cor.id)],
      });
      ordem += 1;
    }
  }

  await batch.commit();
  return { children: ordem };
}

export async function cleanupDevVariacoes(): Promise<{ deleted: number }> {
  const batch = db().batch();
  let deleted = 0;
  batch.delete(db().collection('grupoDeVariacoes').doc(TAMANHOS_ID));
  batch.delete(db().collection('grupoDeVariacoes').doc(CORES_ID));
  deleted += 2;
  const children = await db().collection('produtos').where('paiId', '==', PARENT_ID).get();
  children.docs.forEach((d) => {
    batch.delete(d.ref);
    deleted += 1;
  });
  batch.delete(db().collection('produtos').doc(PARENT_ID));
  deleted += 1;
  await batch.commit();
  return { deleted };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-variacoes-dev.ts') ||
  process.argv[1]?.endsWith('seed-variacoes-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevVariacoes().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-variacoes-dev] removed ${deleted} doc(s)`);
      })
    : seedDevVariacoes().then(({ children }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-variacoes-dev] wrote 2 grupos + produtos/${PARENT_ID} + ${children} children\n` +
            `[seed-variacoes-dev] open /produtos/${PARENT_ID}/editar → aba Variações`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
