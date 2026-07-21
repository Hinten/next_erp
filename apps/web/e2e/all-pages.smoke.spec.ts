import { expect, test } from '@playwright/test';
import { requiresAuthEnv } from './helpers/env';

/**
 * Smoke coverage for every (app) route. Asserts:
 *   - GET returns < 400 (Next.js shell renders)
 *   - URL doesn't bounce to /login (auth + claims came through)
 *   - No uncaught console errors during the initial paint
 *
 * Per-domain specs (clientes-crud.spec.ts, categorias-crud.spec.ts) cover
 * functionality. This file's job is "the page exists and doesn't explode."
 */

// Routes that render without an :id — covers every static placeholder.
const STATIC_ROUTES: string[] = [
  '/inicio',
  '/chat',
  '/pedidos',
  '/pedidos/entradas',
  '/pedidos/entradas/novo',
  '/operacoes',
  '/motivos-incidente',
  '/bandeiras-cartao',
  '/nfe',
  '/nfe/exportar',
  '/produtos',
  '/produtos/novo',
  '/variacoes',
  '/categorias',
  '/categorias/novo',
  '/medidas',
  '/medidas/novo',
  '/listas-de-precos',
  '/produtos/recalcular-precos',
  '/depositos',
  '/etiquetas',
  '/balanco',
  '/clientes',
  '/clientes/novo',
  '/canais',
  '/canais/amazon',
  '/canais/balcao',
  '/canais/facebook',
  '/canais/loja-integrada',
  '/canais/magalu',
  '/canais/mercado-livre',
  '/canais/shopee',
  '/canais/webchat',
  '/whatsapp',
  '/logistica/fob',
  '/logistica/melhor-envios',
  '/logistica/motoboy',
  '/logistica/retirada',
  '/pagamentos',
  '/pagamentos/mercado-pago',
  '/relatorios',
  '/relatorios/vendas',
  '/relatorios/produtos',
  '/relatorios/checkouts',
  '/relatorios/mais-vendidos',
  '/relatorios/localizacao-produtos',
  '/relatorios/vendas-estampas',
  '/configuracoes',
  '/configuracoes/filiais',
  '/configuracoes/cargos',
  '/configuracoes/cargos/novo',
  '/configuracoes/usuarios',
  '/configuracoes/usuarios/novo',
];

test.describe('All pages load', () => {
  // The (app) routes redirect unauthenticated users to /login. Skip the
  // whole suite when the auth env isn't configured (globalSetup logs which
  // vars are missing).
  test.skip(
    !requiresAuthEnv(),
    'E2E auth env not configured (E2E_USER_EMAIL/PASSWORD + Firebase Admin secrets)',
  );

  for (const route of STATIC_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      // Network errors (failed fetches) often surface as page errors not
      // console errors; capture those too so we don't miss them.
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      const response = await page.goto(route);
      expect(response?.status() ?? 0).toBeLessThan(400);

      // Wait for the app shell instead of `domcontentloaded` so client
      // routing + RequirePerm have a chance to settle. The Delfrance title
      // lives in the AppShell header.
      await expect(page.getByRole('heading', { name: 'Delfrance' }).first()).toBeVisible({
        timeout: 10_000,
      });

      // Auth + claim check: the test user has all PERM bits, so we should
      // never end up bounced back to /login or stuck on the "Sem permissão"
      // fallback.
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByText('Sem permissão')).toHaveCount(0);

      // Strict signal: any uncaught page exception is a hard fail. Console
      // errors are noisy in dev (Mantine controlled-input warnings, React 19
      // forwardRef notices, Firebase init chatter, missing icons from Next
      // Image preloads, etc.) so we don't gate the build on them — instead
      // we log them via the test runner output for inspection.
      if (consoleErrors.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[smoke ${route}] ${consoleErrors.length} console.error(s):\n${consoleErrors.join('\n')}`,
        );
      }
      expect(pageErrors, `pageerror on ${route}`).toEqual([]);
    });
  }
});
