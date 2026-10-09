import { expect, test } from '@playwright/test';
import { COLOR_SCHEME_STORAGE_KEY } from '../lib/theme/colorScheme';
import { expectThemeReadable } from './helpers/theme-a11y';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/**
 * Smoke coverage for every (app) route. Asserts:
 *   - GET returns < 400 (Next.js shell renders)
 *   - URL doesn't bounce to /login (auth + claims came through)
 *   - No uncaught exceptions, unreadable text, hidden essential controls, or
 *     imperceptible header icons/focus outlines in either theme
 *
 * Per-domain specs (clientes-crud.spec.ts, categorias-crud.spec.ts) cover
 * functionality. This file's job is "the page exists and doesn't explode."
 */

// Production routes that render without an :id. The checkout harness and print
// preview (/despacho/checkout/harness, /pedidos/preview-impressao) deliberately
// render development-only notices in production and are outside this coverage.
const STATIC_ROUTES: string[] = [
  '/inicio',
  '/chat',
  '/chat/vinculos-whatsapp',
  '/pedidos',
  '/pedidos/novo',
  '/pedidos/entradas',
  '/pedidos/entradas/novo',
  '/despacho/checkout',
  '/operacoes',
  '/operacoes/novo',
  '/motivos-incidente',
  '/motivos-incidente/novo',
  '/bandeiras-cartao',
  '/bandeiras-cartao/novo',
  '/nfe/exportar',
  '/nfe/comunicacoes',
  '/produtos',
  '/produtos/novo',
  '/variacoes',
  '/variacoes/novo',
  '/categorias',
  '/categorias/novo',
  '/medidas',
  '/medidas/novo',
  '/listas-de-precos',
  '/listas-de-precos/novo',
  '/produtos/recalcular-precos',
  '/produtos/alterar-precos',
  '/depositos',
  '/depositos/novo',
  '/etiquetas',
  '/balanco',
  '/balanco/novo',
  '/clientes',
  '/clientes/novo',
  '/canais',
  '/canais/amazon',
  '/canais/balcao',
  '/canais/balcao/novo',
  '/canais/facebook',
  '/canais/loja-integrada',
  '/canais/magalu',
  '/canais/mercado-livre',
  '/canais/mercado-livre/novo',
  '/canais/shopee',
  '/canais/shopee/novo',
  '/canais/whatsapp',
  '/canais/whatsapp/novo',
  '/whatsapp',
  '/logistica/fob',
  '/logistica/fob/novo',
  '/logistica/melhor-envios',
  '/logistica/melhor-envios/novo',
  '/logistica/motoboy',
  '/logistica/motoboy/novo',
  '/logistica/retirada',
  '/logistica/retirada/novo',
  '/pagamentos',
  '/pagamentos/mercado-pago',
  '/pagamentos/mercado-pago/novo',
  '/relatorios',
  '/relatorios/vendas',
  '/relatorios/produtos',
  '/relatorios/checkouts',
  '/relatorios/mais-vendidos',
  '/relatorios/localizacao-produtos',
  '/relatorios/vendas-estampas',
  '/configuracoes',
  '/configuracoes/ia',
  '/configuracoes/filiais',
  '/configuracoes/filiais/novo',
  '/configuracoes/cargos',
  '/configuracoes/cargos/novo',
  '/configuracoes/usuarios',
  '/configuracoes/usuarios/novo',
];

test.describe('All pages load', () => {
  // globalSetup requires a working authenticated session; missing prerequisites
  // fail the run instead of silently skipping the theme coverage.
  for (const route of STATIC_ROUTES) {
    test(`renders ${route} readably in both themes`, async ({ page }, testInfo) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      // Network errors (failed fetches) often surface as page errors not
      // console errors; capture those too so we don't miss them.
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.addInitScript(
        (key) => localStorage.setItem(key, 'light'),
        COLOR_SCHEME_STORAGE_KEY,
      );
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

      const mainHeading = page.getByRole('main').getByRole('heading').first();
      await expect(mainHeading).toBeVisible({ timeout: 15_000 });
      // A skeleton is initial content still arriving. A small Loader can instead
      // represent a legitimate running job, which must also remain readable.
      await expect(
        page.locator('main .mantine-Skeleton-root').filter({ visible: true }),
      ).toHaveCount(0, { timeout: 20_000 });
      const toggle = page.getByRole('button', { name: 'Alternar tema', exact: true });
      const avisos = page.getByRole('button', { name: /^Avisos(?: \(|$)/ });
      for (const scheme of ['light', 'dark'] as const) {
        await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
        await expectThemeReadable(page, testInfo, {
          scheme,
          required: [mainHeading, toggle, avisos],
          icons: [toggle, avisos],
          focus: [toggle],
        });
        if (scheme === 'light') await toggle.click();
      }

      // Strict signal: any uncaught page exception is a hard fail. Console
      // errors are noisy in dev (Mantine controlled-input warnings, React 19
      // forwardRef notices, Firebase init chatter, missing icons from Next
      // Image preloads, etc.) so we don't gate the build on them — instead
      // we log them via the test runner output for inspection.
      if (consoleErrors.length > 0) {
        console.warn(
          `[smoke ${route}] ${consoleErrors.length} console.error(s):\n${consoleErrors.join('\n')}`,
        );
      }
      expect(pageErrors, `pageerror on ${route}`).toEqual([]);
    });
  }
});
