import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupEnderecos,
  cleanupPedidoFreteFixtures,
  e2ePrefix,
  seedPedidoFreteFixtures,
} from './_helpers/seed-data';
import { selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

test.describe.serial('Pedido — cópia confirmada de endereço', () => {
  const prefix = e2ePrefix('pec');
  const targetClienteId = `${prefix}-cli-002`;
  const targetClienteNome = `${prefix}-cliente-destino`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFreteFixtures>>;
  let sourceBefore: Record<string, unknown>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFreteFixtures(prefix);
    const produtoId = fixtures.base.produtoPath.split('/').pop()!;
    const sourceRef = `documents/${fixtures.enderecoPath}`;
    const now = Date.now();
    const batch = db().batch();
    batch.set(db().collection('clientes').doc(targetClienteId), {
      tipo: '1',
      nome: targetClienteNome,
      cpf_cnpj: null,
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: null,
      telefone: null,
      observacoesInternas: null,
      timestamp: now,
      ultimaModificacao: now,
      userCliente: null,
    });
    batch.update(db().collection('pedidos').doc(fixtures.motPedidoId), {
      estado: 'iniciado',
      itens: {
        [produtoId]: [
          {
            produtoUid: produtoId,
            ordem: 1,
            ensureUniqueId: null,
            mktplaceId: null,
            sku: fixtures.base.produtoSku,
            gtin: null,
            nomeDeVenda: fixtures.base.produtoNome,
            precoDeVenda: fixtures.base.listaPreco,
            descontoUnitario: 0,
            quantidade: 1,
            custo: null,
            timestamp: null,
            imposto: null,
          },
        ],
      },
      itensIds: [produtoId],
      valorCobrado: fixtures.base.listaPreco + 15,
      ultimaModificacao: now * 1000,
      enderecoFiscalOuterRef: sourceRef,
      integracaoPedidoOuterRef: `documents/${fixtures.base.integracaoPath}`,
      operacaoPedidoOuterRef: `documents/${fixtures.base.operacaoPath}`,
      listaDePrecosOuterRef: `documents/listaDePrecos/${prefix}-lista-001`,
    });
    await batch.commit();

    const source = await db().doc(fixtures.enderecoPath).get();
    sourceBefore = source.data() as Record<string, unknown>;
    await warmRoutes(browser, [`/pedidos/${fixtures.motPedidoId}/editar`]);
  });

  test.afterAll(async () => {
    await cleanupEnderecos(targetClienteId);
    await cleanupPedidoFreteFixtures(prefix);
  });

  test('cancels once, then copies one shared fiscal/delivery address and keeps the source', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${fixtures.motPedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Limpar' }).first().click();
    await expect(page.getByRole('combobox', { name: 'Cliente', exact: true })).toBeVisible();
    await selectFieldWithSearch(page, 'Cliente', targetClienteNome, new RegExp(targetClienteNome));
    await page.getByRole('button', { name: 'Salvar alterações' }).click();

    const dialog = page.getByRole('dialog', {
      name: 'Copiar endereço para o cliente selecionado?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/endereços fiscal e de entrega/i)).toBeVisible();
    await expect(dialog.getByText(/endereço original será mantido/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Revisar' }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/pedidos/${fixtures.motPedidoId}/editar$`));
    expect(
      (await db().collection('clientes').doc(targetClienteId).collection('enderecos').get()).size,
    ).toBe(0);
    expect((await db().doc(fixtures.enderecoPath).get()).data()).toEqual(sourceBefore);

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await dialog.getByRole('button', { name: 'Copiar e salvar' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    const [sourceAfter, copies, pedido] = await Promise.all([
      db().doc(fixtures.enderecoPath).get(),
      db().collection('clientes').doc(targetClienteId).collection('enderecos').get(),
      db().collection('pedidos').doc(fixtures.motPedidoId).get(),
    ]);
    expect(sourceAfter.data()).toEqual(sourceBefore);
    expect(copies.size).toBe(1);
    const copy = copies.docs[0]!;
    expect(copy.data()).toMatchObject({
      logradouro: sourceBefore.logradouro,
      timestamp: expect.any(Number),
      ultimaModificacao: expect.any(Number),
    });
    const copyRef = `documents/clientes/${targetClienteId}/enderecos/${copy.id}`;
    const pedidoData = pedido.data() as {
      enderecoFiscalOuterRef?: unknown;
      freteInicial?: { enderecoFreteOuterReference?: unknown };
    };
    expect(pedidoData.enderecoFiscalOuterRef).toBe(copyRef);
    expect(pedidoData.freteInicial?.enderecoFreteOuterReference).toBe(copyRef);
  });
});
