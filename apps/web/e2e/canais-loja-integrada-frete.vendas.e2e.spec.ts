import { expect, test, type Page } from '@playwright/test';
import {
  appendMapaFreteRow,
  cleanupLojaIntegradaFreteFixtures,
  e2ePrefix,
  getIntFreteDoc,
  intFreteIdDaContaLi,
  mapaFreteLiE2e,
  seedLojaIntegradaFreteFixtures,
} from './_helpers/seed-data';
import { clickSave } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The Loja Integrada conta screen's freight tabs (master plan step 20, #1826):
 * "Mapeamento do Frete" and "Horário de Corte" edit the conta's `int_frete`
 * doc, and the conta's own "Salvar" writes them as a guarded sibling of the
 * conta.
 *
 * Every conta is seeded WITH its freight doc (see
 * `seedLojaIntegradaFreteFixtures`), so nothing here depends on a server
 * trigger. The Melhor Envio service list is the apps/melhor-envio route the
 * browser calls on whatever backend the build points at; every case STUBS it
 * with `page.route`, the real route being covered by its own offline tests.
 * Writes are verified with an Admin read of the stored doc.
 */

/** The service-list route, whatever host the build points at. */
const SERVICOS = '**/api/freight/melhor-envio/servicos**';

const SERVICOS_STUB = {
  servicos: [
    { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
    { id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios' } },
  ],
};

/** Register the service-list stub. MUST run BEFORE `page.goto`. */
async function stubServicos(page: Page, resposta: 'lista' | 404): Promise<void> {
  await page.route(SERVICOS, async (route) => {
    if (resposta === 404) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not Found' }),
      });
      return;
    }
    await route.fulfill({ status: 200, json: SERVICOS_STUB });
  });
}

/** Open a conta on its "Mapeamento do Frete" tab, once the doc is loaded from the server. */
async function abrirMapeamento(page: Page, contaId: string): Promise<void> {
  await page.goto(`/canais/loja-integrada/${contaId}`);
  await page.getByRole('tab', { name: 'Mapeamento do Frete' }).click();
  // Enabled only once the freight doc's server-truth snapshot seeded the tab.
  await expect(destino(page, 1)).toBeEnabled({ timeout: 30_000 });
}

function destino(page: Page, n: number) {
  return page.getByRole('combobox', { name: `Destino da forma de envio ${n}`, exact: true });
}

async function escolher(page: Page, campo: string, opcao: string): Promise<void> {
  await page.getByRole('combobox', { name: campo, exact: true }).click();
  await page.getByRole('option', { name: opcao, exact: true }).click();
}

async function salvarEVoltar(page: Page): Promise<void> {
  await clickSave(page, 'Salvar alterações');
  await page.waitForURL(/\/canais\/loja-integrada$/, { timeout: 15_000 });
}

test.describe.serial('Canais Loja Integrada e2e — freight tabs of a conta', () => {
  const prefix = e2ePrefix('ljf');
  let contaIds: string[] = [];
  let motoboyId = '';
  let melhorEnvioId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [fixtures] = await Promise.all([
      seedLojaIntegradaFreteFixtures(prefix, 5),
      warmRoutes(browser, ['/canais/loja-integrada/__aquecimento__']),
    ]);
    ({ contaIds, motoboyId, melhorEnvioId } = fixtures);
  });

  test.afterAll(async () => {
    await cleanupLojaIntegradaFreteFixtures(prefix);
  });

  test('maps a shipping method to a motoboy integration and leaves every other row as it was', async ({
    page,
  }) => {
    const contaId = contaIds[0]!;
    await stubServicos(page, 'lista');
    await abrirMapeamento(page, contaId);
    await escolher(page, 'Destino da forma de envio 1', `${motoboyId} (Motoboy)`);
    await salvarEVoltar(page);

    const [linha1, ...resto] = mapaFreteLiE2e();
    await expect
      .poll(async () => (await getIntFreteDoc(intFreteIdDaContaLi(contaId)))?.mapa, {
        timeout: 15_000,
      })
      .toEqual([
        {
          ...linha1,
          integracaoUid: motoboyId,
          targetTipoIntegracao: 'motoboy',
          targetData: null,
          nomeTarget: null,
        },
        ...resto,
      ]);
  });

  test('maps a shipping method to a Melhor Envio service and stores the service', async ({
    page,
  }) => {
    const contaId = contaIds[1]!;
    await stubServicos(page, 'lista');
    await abrirMapeamento(page, contaId);
    await escolher(page, 'Destino da forma de envio 2', `${melhorEnvioId} (Melhor Envios)`);
    // The account alone changes nothing: the row waits for its service.
    await expect(page.getByText(/Escolha o serviço do Melhor Envio para concluir/)).toBeVisible();
    await escolher(page, 'Serviço da forma de envio 2', 'Correios — SEDEX');
    await salvarEVoltar(page);

    await expect
      .poll(
        async () =>
          (
            (await getIntFreteDoc(intFreteIdDaContaLi(contaId)))?.mapa as
              | Record<string, unknown>[]
              | undefined
          )?.[1],
        { timeout: 15_000 },
      )
      .toMatchObject({
        integracaoUid: melhorEnvioId,
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios' } },
        nomeTarget: 'Correios — SEDEX',
      });
  });

  test('degrades the service picker when the service list cannot be read', async ({ page }) => {
    const contaId = contaIds[2]!;
    await stubServicos(page, 404);
    await abrirMapeamento(page, contaId);
    await escolher(page, 'Destino da forma de envio 1', `${melhorEnvioId} (Melhor Envios)`);
    await expect(page.getByText(/não é possível escolher outro agora/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('combobox', { name: 'Serviço da forma de envio 1', exact: true }),
    ).toBeDisabled();
  });

  test('raises the conflict when the mapping changed after the page loaded, and keeps the stored rows', async ({
    page,
  }) => {
    const contaId = contaIds[3]!;
    const intFreteId = intFreteIdDaContaLi(contaId);
    await stubServicos(page, 'lista');
    await abrirMapeamento(page, contaId);
    // Another writer — here, as the order importer would — registers a new
    // shipping method while the screen is open.
    const nova = { ...mapaFreteLiE2e()[0], idOriginal: '1009---Z', nomeOriginal: 'Forma 9' };
    await appendMapaFreteRow(intFreteId, nova);
    await escolher(page, 'Destino da forma de envio 1', `${motoboyId} (Motoboy)`);
    await clickSave(page, 'Salvar alterações');

    await expect(page.getByText('Registro alterado')).toBeVisible({ timeout: 15_000 });
    expect((await getIntFreteDoc(intFreteId))?.mapa).toEqual([...mapaFreteLiE2e(), nova]);
  });

  test('saves a cut-off hour on the Horário de Corte tab', async ({ page }) => {
    const contaId = contaIds[4]!;
    await stubServicos(page, 'lista');
    await page.goto(`/canais/loja-integrada/${contaId}`);
    await page.getByRole('tab', { name: 'Horário de Corte' }).click();
    const adicionar = page.getByRole('button', { name: 'Adicionar horário' });
    await expect(adicionar).toBeEnabled({ timeout: 30_000 });
    await adicionar.click();
    await page.getByRole('textbox', { name: 'Corte (h) 1' }).fill('15');
    await salvarEVoltar(page);

    await expect
      .poll(async () => (await getIntFreteDoc(intFreteIdDaContaLi(contaId)))?.horarioDeCorte, {
        timeout: 15_000,
      })
      .toEqual([
        {
          diaDaSemana: 1,
          horaDeCorte: 15,
          minutosDeCorte: null,
          prazoDePostagem: null,
          horaPostagem: null,
          minutosPostagem: null,
        },
      ]);
    expect((await getIntFreteDoc(intFreteIdDaContaLi(contaId)))?.mapa).toEqual(mapaFreteLiE2e());
  });
});
