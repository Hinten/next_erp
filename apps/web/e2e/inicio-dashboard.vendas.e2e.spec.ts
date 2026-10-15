import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  INTEGRACAO_TIPO,
  MODALIDADE_FRETE,
  integracaoSchema,
  usuarioSchema,
  pedidoSchema,
  seedFreteInicial,
  inicioDespachoSchema,
  checkoutFretePedidoSchema,
} from '@delfrance/schemas';
import { e2ePrefix } from './_helpers/seed-data';
import { expectRowHidden, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

test.describe.serial('Início — dashboard e links de despacho', () => {
  const prefix = e2ePrefix('inicio');
  const canalId = `${prefix}-balcao`;
  const pedidoId = `${prefix}-pedido`;
  const userId = `${prefix}-colaborador`;
  const tipos = [
    INTEGRACAO_TIPO.mercadoLivre,
    INTEGRACAO_TIPO.lojaIntegrada,
    INTEGRACAO_TIPO.magalu,
    INTEGRACAO_TIPO.shopee,
    INTEGRACAO_TIPO.amazon,
  ];
  const channelIds = [
    canalId,
    ...tipos.map((tipo) => `${prefix}-${tipo}`),
    `${prefix}-facebook`,
    `${prefix}-inactive`,
  ];
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const batch = db().batch();
    const channels = [
      { id: canalId, tipo: INTEGRACAO_TIPO.balcao, ativo: true },
      ...tipos.map((tipo) => ({ id: `${prefix}-${tipo}`, tipo, ativo: true })),
      { id: `${prefix}-facebook`, tipo: INTEGRACAO_TIPO.facebook, ativo: true },
      { id: `${prefix}-inactive`, tipo: INTEGRACAO_TIPO.balcao, ativo: false },
    ];
    for (const channel of channels)
      batch.set(
        db().collection('integracao').doc(channel.id),
        integracaoSchema.parse({ nome: channel.id, tipo: channel.tipo, ativo: channel.ativo }),
      );
    batch.set(
      db().collection('usuarios').doc(userId),
      usuarioSchema.parse({ nome: userId, colaborador: true }),
    );
    batch.set(db().collection('pedidos').doc(pedidoId), {
      ...pedidoSchema.parse({
        numero: pedidoId,
        ehSaida: true,
        estado: ESTADO_PEDIDO.pago,
        timestamp: Date.now() * 1000,
        integracaoPedidoOuterRef: `documents/integracao/${canalId}`,
        freteInicial: {
          ...seedFreteInicial(MODALIDADE_FRETE.semTransporte, true),
          estado: ESTADO_FRETE.empacotado,
          prazoDespacho: null,
        },
        foiImpresso: false,
      }),
      // Seed the legacy wire encoding after validating the current write shape.
      integracaoPedidoOuterRef: `integracao/${canalId}`,
    });
    batch.set(
      db().collection('pedidos').doc(pedidoId).collection('checkout').doc(`${prefix}-checkout`),
      checkoutFretePedidoSchema.parse({
        usuarioCheckoutFretePedidoOuterRef: `documents/usuarios/${userId}`,
        timestamp: Date.now() - 1000,
        freteNoMomentoDoCheckout: seedFreteInicial(MODALIDADE_FRETE.semTransporte, true),
      }),
    );
    await batch.commit();
    await warmRoutes(browser, ['/inicio', '/pedidos']);
  });
  test.afterAll(async () => {
    // The audit triggers append subdocs; recursively remove ONLY this fixture.
    await db().recursiveDelete(db().collection('pedidos').doc(pedidoId));
    await Promise.all([
      ...channelIds.map((id) => db().collection('integracao').doc(id).delete()),
      db().collection('usuarios').doc(userId).delete(),
    ]);
  });
  test('shows every active dispatch channel, including zero orders, and reuses checkout counts', async ({
    page,
  }) => {
    await page.goto('/inicio');
    for (const id of channelIds.slice(0, 6)) {
      const channel = page.getByRole('region', { name: id, exact: true });
      await expect(channel).toBeVisible({
        timeout: 60_000,
      });
      const total = channel.getByRole('link', { name: 'Total', exact: true });
      await expect(total).toBeVisible();
      if (id !== canalId) await expect(total.locator('..')).toContainText('0');
    }
    await expect(page.getByRole('region', { name: `${prefix}-facebook`, exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('region', { name: `${prefix}-inactive`, exact: true })).toHaveCount(
      0,
    );
    const checkout = page.getByRole('region', { name: 'Checkout', exact: true });
    const collaborator = checkout.getByRole('paragraph').filter({ hasText: userId });
    await expect(collaborator).toBeVisible();
    await checkout.getByText('Semana', { exact: true }).last().click();
    await expect(collaborator).toBeVisible();
    await checkout.getByText('Mês', { exact: true }).last().click();
    await expect(collaborator).toBeVisible();
  });
  test('links the unique packed-order Total, persists reload/detail navigation, and clears', async ({
    page,
  }) => {
    await page.goto('/inicio');
    const card = page.getByRole('region', { name: canalId, exact: true });
    const link = card.getByRole('link', { name: 'Total', exact: true });
    await expect(link).toBeVisible({ timeout: 60_000 });
    const href = (await link.getAttribute('href'))!;
    const value = inicioDespachoSchema.parse(
      JSON.parse(new URL(href, 'https://example.com').searchParams.get('inicioDespacho')!.slice(3)),
    );
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .update({ 'freteInicial.prazoDespacho': value.inicioUs });
    await card.getByRole('button', { name: 'Atualizar', exact: true }).click();
    await expect(
      card.getByRole('link', { name: 'Total', exact: true }).locator('..'),
    ).toContainText('1');
    await link.click();
    await expectRowVisible(page, pedidoId);
    await expect(page.getByLabel('Filtros ativos')).toContainText(`${canalId} · Total`);
    await page.reload();
    await expectRowVisible(page, pedidoId);
    await page.getByRole('link', { name: pedidoId, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/pedidos/${pedidoId}`));
    await page.goBack();
    await expectRowVisible(page, pedidoId);
    await expect(page).toHaveURL(/inicioDespacho=/);
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
    await expect(page).not.toHaveURL(/inicioDespacho=/);
  });
  test('a malformed preset shows an error without exposing an unrestricted list', async ({
    page,
  }) => {
    await page.goto('/pedidos?inicioDespacho=eq:malformed');
    await expect(
      page.getByText('O filtro de despacho é inválido. Remova-o para consultar os pedidos.'),
    ).toBeVisible();
    await expectRowHidden(page, pedidoId);
  });
});
