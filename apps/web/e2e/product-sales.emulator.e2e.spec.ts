import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { deleteApp, initializeApp } from 'firebase/app';
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
} from 'firebase/firestore';
import { getAuth } from 'firebase-admin/auth';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import { db, ensureTestUser, getApp } from '@delfrance/test-fixtures';
import { orderReportDateRange } from '../lib/reports/orderReportFilters';
import { loadProductSalesReport } from '../lib/reports/productSales';
import { e2ePrefix } from './_helpers/seed-data';
import { readEmulatorAccessConfig } from './_helpers/verify-emulator-access';

test('product sales reads the full period and counts each order once per product', async () => {
  test.setTimeout(120_000);
  const config = readEmulatorAccessConfig();
  const range = orderReportDateRange('2023-04-11', '2023-04-12');
  if (!range) throw new RangeError('Invalid product sales fixture dates.');
  const prefix = e2ePrefix('product-sales');
  const produtoUid = prefix + '-camisa';
  const account = prefix + '-canal';
  const filters = {
    ...range,
    estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
    accountIds: [account],
    ehSaida: true,
  };
  const baseOrder = {
    ehSaida: true,
    estado: ESTADO_PEDIDO.pago,
    timestamp: range.startUs + 3_600_000_000,
    integracaoPedidoOuterRef: 'documents/integracao/' + account,
    itens: { [produtoUid]: [{ quantidade: 1, precoDeVenda: 10 }] },
  };
  const excludedItem = { [produtoUid]: [{ quantidade: 999, precoDeVenda: 10 }] };
  const orders = [
    ...Array.from({ length: 501 }, () => baseOrder),
    {
      ...baseOrder,
      timestamp: range.startUs,
      itens: {
        [produtoUid]: [
          { quantidade: 2, precoDeVenda: 10, descontoUnitario: 1, nomeDeVenda: 'Camisa' },
          { quantidade: 1, precoDeVenda: 10, sku: 'SKU', produtoUid: 'legacy-mismatch' },
        ],
        NONE: [{ quantidade: 999, precoDeVenda: 999 }],
      },
    },
    {
      ...baseOrder,
      estado: ESTADO_PEDIDO.finalizado,
      timestamp: range.endExclusiveUs / 1000 - 1,
      integracaoPedidoOuterRef: 'integracao/' + account,
      itens: { [produtoUid]: [{ quantidade: 3, precoDeVenda: 20, descontoUnitario: 5 }] },
    },
    {
      ...baseOrder,
      integracaoPedidoOuterRef: 'documents/integracao/' + prefix + '-outro',
      itens: { [produtoUid]: [{ quantidade: 5, precoDeVenda: 8 }] },
    },
    { ...baseOrder, timestamp: range.startUs - 1, itens: excludedItem },
    { ...baseOrder, timestamp: range.startUs / 1000 - 1, itens: excludedItem },
    { ...baseOrder, timestamp: range.endExclusiveUs, itens: excludedItem },
    { ...baseOrder, timestamp: range.endExclusiveUs / 1000, itens: excludedItem },
    { ...baseOrder, estado: ESTADO_PEDIDO.cancelado, itens: excludedItem },
    { ...baseOrder, ehSaida: false, itens: excludedItem },
  ];
  const app = initializeApp({ projectId: config.projectId, apiKey: config.apiKey }, prefix);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, 'http://' + config.authHost + ':9099', { disableWarnings: true });
  const firestore = initializeFirestore(app, { localCache: memoryLocalCache() }, 'default');
  connectFirestoreEmulator(firestore, config.firestoreHost, 8080);
  const admin = db();
  const refs = orders.map((_, index) => admin.doc('pedidos/' + prefix + '-' + index));
  let authUid: string | undefined;

  try {
    for (let start = 0; start < refs.length; start += 250) {
      const batch = admin.batch();
      for (const [offset, ref] of refs.slice(start, start + 250).entries()) {
        batch.set(ref, orders[start + offset]!);
      }
      await batch.commit();
    }

    await expect(loadProductSalesReport(firestore, filters)).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const email = prefix + '@example.com';
    const password = randomUUID();
    const user = await ensureTestUser(email, password);
    authUid = user.uid;
    await getAuth(getApp()).setCustomUserClaims(user.uid, {
      permissions: PERM.pedido.read.toString(),
      ...rulesClaimsFromBits(PERM.pedido.read),
    });
    await signInWithEmailAndPassword(auth, email, password);

    const selected = await loadProductSalesReport(firestore, filters);
    expect(selected).toEqual({
      rows: [{ produtoUid, label: 'Camisa', quantidade: 507, pedidos: 503, receita: 5083 }],
      invalidLines: 0,
    });

    const allChannels = await loadProductSalesReport(firestore, { ...filters, accountIds: [] });
    expect(allChannels.rows.find((row) => row.produtoUid === produtoUid)).toMatchObject({
      quantidade: 512,
      pedidos: 504,
      receita: 5123,
    });
  } finally {
    try {
      await terminate(firestore);
      await deleteApp(app);
    } finally {
      try {
        for (let start = 0; start < refs.length; start += 250) {
          const batch = admin.batch();
          for (const ref of refs.slice(start, start + 250)) batch.delete(ref);
          await batch.commit();
        }
      } finally {
        if (authUid) await getAuth(getApp()).deleteUser(authUid);
      }
    }
  }
});
