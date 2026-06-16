import { expect, test } from '@playwright/test';
import { clickSave, expectErrorText, expectToast } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * Per-tab validation feedback on an invalid `/pedidos/novo` submit (issue #177).
 *
 * The custom `PedidoForm` must, like the schema-driven `ObjectView`, name the
 * erroring tab in a red toast, auto-switch to it, and show the inline field
 * error there. No fixtures needed: the test submits an empty form, which the
 * form resolver rejects (integração + at least one item are required), and
 * asserts the feedback. Mirrors the logistica "invalid create from a non-first
 * tab" test (`logistica.vendas.e2e.spec.ts`).
 */
test.describe('Pedido form — per-tab validation feedback', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await warmRoutes(browser, ['/pedidos/novo']);
  });

  test('invalid submit from a non-Principal tab toasts + jumps back to Principal', async ({
    page,
  }) => {
    await page.goto('/pedidos/novo');
    await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible({
      timeout: 15_000,
    });

    // Move away from the tab that holds the empty required fields.
    await page.getByRole('tab', { name: 'Fiscal' }).click();
    await expect(page.getByRole('tab', { name: 'Fiscal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await clickSave(page, 'Criar');

    // Red toast names Principal (assert first — it auto-dismisses), the form
    // jumps there (the erroring tab's accessible name now carries the error
    // icon label, so match by regex), and the inline required errors are
    // visible on the now-active tab.
    await expectToast(page, /Corrija os campos inválidos na aba "Principal"/);
    await expect(page.getByRole('tab', { name: /Principal/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectErrorText(page, 'Selecione a integração.');
    await expectErrorText(page, 'Adicione ao menos um item.');

    // Validation blocked the save — still on the create page.
    await expect(page).toHaveURL(/\/pedidos\/novo$/);
  });
});
