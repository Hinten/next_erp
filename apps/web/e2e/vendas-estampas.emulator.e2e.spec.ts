import { expect, test } from '@playwright/test';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, initializeFirestore, terminate } from 'firebase/firestore';
import { execute } from 'firebase/firestore/pipelines';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import { db } from '@delfrance/test-fixtures';
import { buildPrintSalesPipeline, printSalesDateRange } from '../lib/reports/printSales';
import { e2ePrefix } from './_helpers/seed-data';
import { readEmulatorAccessConfig } from './_helpers/verify-emulator-access';

test.describe('Sales by print', () => {
  test.describe.configure({ mode: 'default' });
  const prefix = e2ePrefix('print-sales');
  const print = prefix + '-print';
  const printSku = prefix + '-sku';
  const child = prefix + '-variation';
  const kit = prefix + '-kit';
  const plain = prefix + '-plain';
  const paths: string[] = [];
  const day = '2033-03-14';
  const range = printSalesDateRange(day, day);
  if (!range) throw new RangeError('Invalid sales fixture date.');
  const item = { quantidade: 1, precoDeVenda: 25, descontoUnitario: 5, custo: 7 };

  test.beforeAll(async () => {
    readEmulatorAccessConfig();
    const write = (path: string, data: Record<string, unknown>) => {
      paths.push(path);
      return db().doc(path).set(data);
    };
    const order = { estado: ESTADO_PEDIDO.pago, ehSaida: true, timestamp: range.startUs };
    await Promise.all([
      write('produtos/' + prefix + '-legacy-print', {
        nome: 'Estampa padrão ' + prefix,
        sku: '108555999',
        paiId: null,
      }),
      write('produtos/' + print, { nome: 'Estampa ' + prefix, sku: printSku, paiId: null }),
      write('produtos/' + child, { nome: 'Estampa P ' + prefix, paiId: print }),
      write('produtos/' + kit, {
        nome: 'Kit ' + prefix,
        ehKit: true,
        componentesKit: { [child]: { quantidade: 3 } },
      }),
      write('produtos/' + plain, { nome: 'Lisa ' + prefix }),
      write('pedidos/' + prefix + '-current', {
        ...order,
        timestamp: range.endExclusiveUs - 1,
        itens: {
          [kit]: [
            { ...item, quantidade: 2 },
            { quantidade: 80, precoDeVenda: 'inválido' },
          ],
          [plain]: [{ ...item, descontoUnitario: null, custo: null }],
        },
      }),
      write('pedidos/' + prefix + '-legacy', {
        ...order,
        estado: ESTADO_PEDIDO.finalizado,
        timestamp: range.startUs / 1000,
        itens: { [child]: [item] },
      }),
      write('pedidos/' + prefix + '-cancelled', {
        ...order,
        estado: ESTADO_PEDIDO.cancelado,
        itens: { [plain]: [{ ...item, quantidade: 7 }] },
      }),
      write('pedidos/' + prefix + '-inbound', {
        ...order,
        ehSaida: false,
        itens: { [kit]: [{ ...item, quantidade: 80 }] },
      }),
      write('pedidos/' + prefix + '-before', {
        ...order,
        timestamp: range.startUs - 1,
        itens: { [plain]: [{ ...item, quantidade: 80 }] },
      }),
      write('pedidos/' + prefix + '-after', {
        ...order,
        timestamp: range.endExclusiveUs / 1000,
        itens: { [kit]: [{ ...item, quantidade: 80 }] },
      }),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all(paths.map((path) => db().doc(path).delete()));
  });

  test('compares printed and plain sales and lists the matching sold products', async ({
    page,
  }) => {
    await page.goto('/relatorios/vendas-estampas');
    const prints = page.getByRole('combobox', { name: 'Estampas', exact: true });
    await expect(
      page.getByText('Estampa padrão ' + prefix + ' · 108555999', { exact: true }),
    ).toBeVisible();
    await prints.fill(printSku);
    await page.getByRole('option', { name: 'Estampa ' + prefix + ' · ' + printSku }).click();
    await page.getByLabel(/^Data inicial/).fill(day);
    await page.getByLabel(/^Data final/).fill(day);
    const generate = page.getByRole('button', { name: 'Gerar relatório' });
    await generate.click();

    const comparison = page.getByRole('table', { name: 'Comparativo de vendas' });
    await expect(comparison.getByRole('row', { name: /^Unidades vendidas/ })).toHaveText(
      /Unidades vendidas\s*3\s*1/,
    );
    await expect(comparison.getByRole('row', { name: /^Receita líquida/ })).toHaveText(
      /R\$\s*60,00\s*R\$\s*25,00/,
    );
    await expect(comparison.getByRole('row', { name: /^Lucro/ })).toHaveText(
      /R\$\s*39,00\s*R\$\s*25,00/,
    );
    const products = page.getByRole('table', { name: 'Produtos vendidos com estampa' });
    await expect(products.getByRole('link', { name: 'Kit ' + prefix })).toBeVisible();
    await expect(products.getByRole('link', { name: 'Estampa P ' + prefix })).toBeVisible();
    await expect(products.getByRole('link', { name: 'Lisa ' + prefix })).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Estados do pedido', exact: true }).click();
    await page.getByRole('option', { name: 'Cancelado', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(products).toHaveCount(0);
    await generate.click();
    await expect(comparison.getByRole('row', { name: /^Unidades vendidas/ })).toHaveText(
      /Unidades vendidas\s*3\s*8/,
    );
  });

  test('denies the real grouped sales query to an unauthenticated client', async () => {
    const config = readEmulatorAccessConfig();
    const app = initializeApp({ projectId: config.projectId, apiKey: config.apiKey }, prefix);
    const client = initializeFirestore(app, {}, 'default');
    connectFirestoreEmulator(client, config.firestoreHost, 8080);
    try {
      await expect(
        execute(
          buildPrintSalesPipeline(client, {
            ...range,
            estados: [ESTADO_PEDIDO.pago],
            printIds: [print],
          }),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    } finally {
      try {
        await terminate(client);
      } finally {
        await deleteApp(app);
      }
    }
  });
});
