import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupByNamePrefix, e2ePrefix, seedClientes } from './_helpers/seed-data';
import { clickSaveAndContinue, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

test.describe.serial('Cadastro de telefones do cliente', () => {
  const prefix = e2ePrefix('cliente-telefones');
  const id = `${prefix}-003`;
  const read = async () => (await db().collection('clientes').doc(id).get()).data();
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await seedClientes(prefix, 3);
    await db()
      .collection('clientes')
      .doc(id)
      .update({
        telefone: '5511999998888',
        telefonesAdicionais: ['14155552671'],
        telefoneGerenciado: true,
      });
    await warmRoutes(browser, [`/clientes/${id}`]);
  });
  test.afterAll(async () => {
    await cleanupByNamePrefix('clientes', prefix);
  });

  test('salva extras, desfaz remoção e conserva o principal anterior no histórico', async ({
    page,
  }) => {
    await page.goto(`/clientes/${id}`);
    await expect(page.getByLabel('Telefone adicional 1', { exact: true })).toHaveValue(
      '+14155552671',
    );
    await fillField(page, 'Telefone principal', '11911112222');
    await page.getByRole('button', { name: 'Adicionar telefone', exact: true }).click();
    await fillField(page, 'Telefone adicional 2', '21999998888');
    await page.getByRole('button', { name: 'Remover', exact: true }).first().click();
    await expect(page.getByText('Será excluído ao salvar')).toBeVisible();
    expect((await read())?.telefonesAdicionais).toEqual(['14155552671']);
    await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
    await clickSaveAndContinue(page);
    await expect.poll(read).toMatchObject({
      telefone: '5511911112222',
      telefonesAdicionais: ['14155552671', '5521999998888', '5511999998888'],
    });
    await page.reload();
    await expect(page.getByLabel('Telefone principal', { exact: true })).toHaveValue(
      '+5511911112222',
    );
    await expect(page.getByLabel('Telefone adicional 1', { exact: true })).toHaveValue(
      '+14155552671',
    );
  });

  test('edita e remove extras somente ao salvar, persistindo após recarregar', async ({ page }) => {
    await page.goto(`/clientes/${id}`);
    await fillField(page, 'Telefone adicional 1', '+1 (415) 555-2672');
    await page.getByRole('button', { name: 'Remover', exact: true }).nth(1).click();
    await expect(page.getByText('Será excluído ao salvar')).toBeVisible();
    expect((await read())?.telefonesAdicionais).toContain('5521999998888');
    await clickSaveAndContinue(page);
    await expect
      .poll(async () => (await read())?.telefonesAdicionais)
      .toEqual(['14155552672', '5511999998888']);
    await page.reload();
    await expect(page.getByLabel('Telefone adicional 1', { exact: true })).toHaveValue(
      '+14155552672',
    );
    await expect(page.getByLabel('Telefone adicional 2', { exact: true })).toHaveValue(
      '+5511999998888',
    );
    await expect(page.getByLabel('Telefone adicional 3', { exact: true })).toHaveCount(0);
  });
  test('copia telefone internacional sem reaproveitar o histórico ou vínculo de usuário', async ({
    page,
  }) => {
    await db()
      .collection('clientes')
      .doc(id)
      .update({
        telefone: '14155552671',
        telefoneGerenciado: true,
        telefonesAdicionais: ['5511999998888'],
        userCliente: 'documents/usuarios/legacy',
      });
    await page.goto(`/clientes/novo?copyFrom=${id}`);
    await expect(page.getByLabel('Telefone principal', { exact: true })).toHaveValue(
      '+14155552671',
    );
    await expect(page.getByLabel('Telefone adicional 1', { exact: true })).toHaveCount(0);
    await fillField(page, 'Nome', `${prefix} cópia`);
    await page.getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname.startsWith('/clientes/') &&
        !url.pathname.endsWith('/novo') &&
        !url.pathname.endsWith(id),
    );
    const copiedId = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect
      .poll(async () => (await db().collection('clientes').doc(copiedId).get()).data())
      .toMatchObject({ telefone: '14155552671', telefonesAdicionais: [], userCliente: null });
  });
});
