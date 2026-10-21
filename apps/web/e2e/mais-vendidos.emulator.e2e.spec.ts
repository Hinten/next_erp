import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { deleteApp, initializeApp, type FirebaseApp, type FirebaseError } from 'firebase/app';
import {
  connectAuthEmulator,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { documentId, execute, field } from 'firebase/firestore/pipelines';
import { getAuth } from 'firebase-admin/auth';
import { db, ensureTestUser, getApp, grantAllPerms } from '@delfrance/test-fixtures';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  buildTopProductsPipeline,
  hydrateTopProductsRows,
  loadTopProductsReport,
  topProductsDateRange,
  type TopProductsFilters,
} from '../lib/reports/topProducts';
import { e2ePrefix } from './_helpers/seed-data';
import { readEmulatorAccessConfig } from './_helpers/verify-emulator-access';

// The real client query and the screen consume the same isolated orders. These
// assertions cover array expansion, aggregation and document-source projections
// together; mocking a pipeline stage would not establish this query's support.
test.describe.serial('Best-selling products — complete quantities and persistent cache', () => {
  const prefix = e2ePrefix('top-products');
  const accountId = prefix + '-account';
  const accountName = prefix + '-channel';
  const parentId = prefix + '-shirt';
  const smallId = prefix + '-shirt-small';
  const largeId = prefix + '-shirt-large';
  const kitId = prefix + '-kit';
  const otherId = prefix + '-other';
  const missingId = prefix + '-deleted';
  const orderId = prefix + '-order';
  const photoId = prefix + '-photo';
  const photoUrl = 'https://example.com/' + photoId + '.jpg';
  const paths: string[] = [];
  const apps: FirebaseApp[] = [];
  const clients: Firestore[] = [];
  let clientDb: Firestore;
  let anonymousDb: Firestore;
  let authUid: string | undefined;
  let filters: TopProductsFilters;

  const item = (quantidade: number) => ({ quantidade });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // Validate every destination before the first Admin fixture can write.
    const config = readEmulatorAccessConfig();
    const range = topProductsDateRange('2026-01-10', '2026-01-11');
    if (!range) throw new RangeError('Invalid report fixture dates.');
    filters = {
      ...range,
      estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
      accountIds: [accountId],
      ehSaida: true,
    };
    const write = (collection: string, id: string, data: Record<string, unknown>) => {
      paths.push(collection + '/' + id);
      return db().collection(collection).doc(id).set(data);
    };
    await Promise.all([
      write('integracao', accountId, {
        nome: accountName,
        tipo: INTEGRACAO_TIPO.balcao,
        ativo: false,
      }),
      write('produtos', parentId, {
        nome: prefix + '-Shirt',
        sku: 'SHIRT',
        fotos: [{ arquivoOuterRef: 'arquivos/' + photoId }],
        paiId: null,
        ehKit: false,
      }),
      write('produtos', smallId, {
        nome: prefix + '-Small',
        sku: 'SHIRT-S',
        paiId: parentId,
        ehKit: false,
      }),
      write('produtos', largeId, {
        nome: prefix + '-Large',
        sku: 'SHIRT-L',
        paiId: parentId,
        ehKit: false,
      }),
      write('produtos', kitId, {
        nome: prefix + '-Kit',
        paiId: null,
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: {
          [smallId]: { quantidade: 3, limitarEstoque: false },
          [largeId]: { quantidade: 2 },
        },
      }),
      write('arquivos', photoId, { url: photoUrl }),
      write('produtos', otherId, {
        nome: prefix + '-Other',
        sku: 'OTHER',
        paiId: null,
        ehKit: false,
      }),
    ]);
    const order = {
      nome: prefix,
      ehSaida: true,
      estado: ESTADO_PEDIDO.pago,
      timestamp: range.startUs + 12 * 3_600_000_000,
      integracaoPedidoOuterRef: 'documents/integracao/' + accountId,
    };
    await Promise.all([
      write('pedidos', orderId, {
        ...order,
        itens: {
          [kitId]: [item(2)],
          [smallId]: [item(1)],
          [otherId]: [item(11.5)],
          [missingId]: [item(0.5)],
        },
      }),
      write('pedidos', prefix + '-bare', {
        ...order,
        estado: ESTADO_PEDIDO.finalizado,
        integracaoPedidoOuterRef: 'integracao/' + accountId,
        itens: { [largeId]: [item(1)] },
      }),
      write('pedidos', prefix + '-cancelled', {
        ...order,
        estado: ESTADO_PEDIDO.cancelado,
        itens: { [otherId]: [item(100)] },
      }),
      write('pedidos', prefix + '-inbound', {
        ...order,
        ehSaida: false,
        itens: { [otherId]: [item(100)] },
      }),
      write('pedidos', prefix + '-other-account', {
        ...order,
        integracaoPedidoOuterRef: 'documents/integracao/another-account',
        itens: { [otherId]: [item(100)] },
      }),
      write('pedidos', prefix + '-outside', {
        ...order,
        timestamp: range.endExclusiveUs,
        itens: { [otherId]: [item(100)] },
      }),
    ]);
    const email = prefix + '@example.com';
    const password = randomUUID();
    const user = await ensureTestUser(email, password);
    authUid = user.uid;
    await grantAllPerms(email);
    for (const anonymous of [false, true]) {
      const app = initializeApp(
        { projectId: config.projectId, apiKey: config.apiKey },
        prefix + (anonymous ? '-anonymous' : '-authenticated'),
      );
      apps.push(app);
      const auth = initializeAuth(app, { persistence: inMemoryPersistence });
      connectAuthEmulator(auth, 'http://' + config.authHost + ':9099', { disableWarnings: true });
      const instance = initializeFirestore(app, { localCache: memoryLocalCache() }, 'default');
      clients.push(instance);
      connectFirestoreEmulator(instance, config.firestoreHost, 8080);
      if (anonymous) anonymousDb = instance;
      else {
        clientDb = instance;
        await signInWithEmailAndPassword(auth, email, password);
      }
    }
  });

  test.afterAll(async () => {
    try {
      await Promise.all(clients.map((client) => terminate(client)));
    } finally {
      try {
        await Promise.all(apps.map((app) => deleteApp(app)));
      } finally {
        try {
          await Promise.all(paths.map((path) => db().doc(path).delete()));
        } finally {
          if (authUid) await getAuth(getApp()).deleteUser(authUid);
        }
      }
    }
  });

  test('aggregates both reference encodings and ranks expanded component parents', async () => {
    const report = await loadTopProductsReport(clientDb, filters);
    expect(report.totalQuantidade).toBe(24);
    expect(report.rows.map((row) => [row.produtoId, row.quantidade])).toEqual([
      [parentId, 12],
      [otherId, 11.5],
      [missingId, 0.5],
    ]);
    expect(report.rows[0]?.variations).toEqual([
      { produtoId: smallId, quantidade: 7 },
      { produtoId: largeId, quantidade: 5 },
    ]);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-product', produtoId: missingId }),
      ]),
    );
    // Hydration uses the production documents/select builder for display fields
    // and the arquivo URL, independently of the structural kit projections above.
    const hydrated = await hydrateTopProductsRows(clientDb, report.rows);
    expect(hydrated[0]).toMatchObject({
      produtoId: parentId,
      nome: prefix + '-Shirt',
      sku: 'SHIRT',
      quantidade: 12,
      photoUrl,
      variations: [
        { produtoId: smallId, nome: prefix + '-Small', sku: 'SHIRT-S', quantidade: 7 },
        { produtoId: largeId, nome: prefix + '-Large', sku: 'SHIRT-L', quantidade: 5 },
      ],
    });
  });

  test('denies the identical aggregate to an unauthenticated client', async () => {
    await expect(execute(buildTopProductsPipeline(anonymousDb, filters))).rejects.toMatchObject({
      code: 'permission-denied',
    } satisfies Partial<FirebaseError>);
  });

  test('denies structural, display and photo document projections to an unauthenticated client', async () => {
    for (const [collection, id, fields] of [
      ['produtos', kitId, ['paiId', 'ehKit', 'componentesKit']],
      ['produtos', parentId, ['nome', 'sku', 'fotos', 'variacoesUid']],
      ['arquivos', photoId, ['url']],
    ] as const) {
      await expect(
        execute(
          anonymousDb
            .pipeline()
            .documents([collection + '/' + id])
            .select(documentId(field('__name__')).as('rowId'), ...fields),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' } satisfies Partial<FirebaseError>);
    }
  });

  async function selectReport(page: Page) {
    await page.getByLabel('Data inicial', { exact: true }).fill('2026-01-10');
    await page.getByLabel('Data final', { exact: true }).fill('2026-01-11');
    await page.getByRole('combobox', { name: 'Canais de venda', exact: true }).click();
    await page.getByRole('option', { name: new RegExp(accountName) }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Gerar relatório', exact: true }).click();
  }

  test('keeps quantities across reloads until explicitly refreshed', async ({ page }) => {
    await page.goto('/relatorios/mais-vendidos');
    await expect(
      page.getByRole('heading', { name: 'Produtos mais vendidos', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Produtos mais vendidos' })).toHaveCount(0);
    await selectReport(page);
    const shirt = () => page.getByTestId('top-product-' + parentId);
    await expect(shirt()).toHaveAttribute('data-quantity', '12');
    await expect(page.getByText(prefix + '-Small', { exact: true })).toBeVisible();
    await db()
      .collection('pedidos')
      .doc(orderId)
      .update({
        itens: {
          [kitId]: [item(2)],
          [smallId]: [item(4)],
          [otherId]: [item(11.5)],
          [missingId]: [item(0.5)],
        },
      });
    // A new JS context must retrieve the persistent report, rather than merely
    // reuse an in-memory TanStack value or rerun the aggregate over new orders.
    await page.reload();
    await selectReport(page);
    await expect(shirt()).toHaveAttribute('data-quantity', '12');
    await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click();
    await expect(shirt()).toHaveAttribute('data-quantity', '15');
  });
});
