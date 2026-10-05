import { expect, test, type Page, type Route } from '@playwright/test';

import type { WhatsappVinculoResumo } from '@delfrance/schemas';
import {
  cleanupConversas,
  e2ePrefix,
  seedConversas,
  seedMensagem,
  type SeededChat,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * Browser interaction contract: WhatsApp HTTP projections/commands are mocked;
 * authenticated cliente/conversa reads use emulator fixtures. These scenarios
 * cover navigation, conflict UX, recovery progress and drafts, not backend
 * transaction/replay correctness (covered by the WhatsApp Firestore suite).
 */
const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
async function answer(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.describe.serial('WhatsApp — vínculo e continuidade do atendimento', () => {
  const prefix = e2ePrefix('wa-vinculos');
  const clienteId = `${prefix}-conv-vermelha-cliente`;
  const pendingId = `${prefix}-pending`;
  const oldId = `${prefix}-old`;
  const messageId = `${prefix}-mapped-message`;
  const timestamp = Date.now();
  let chat: SeededChat;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    chat = await seedConversas(prefix);
    await seedMensagem(chat.vermelha.id, messageId, {
      conteudo: `${prefix} histórico preservado`,
      timestampMs: timestamp,
    });
    await warmRoutes(browser, [
      '/chat/vinculos-whatsapp',
      `/chat/vinculos-whatsapp/${pendingId}`,
      `/chat/${chat.vermelha.id}`,
    ]);
  });
  test.afterAll(async () => {
    await cleanupConversas(prefix);
  });

  async function api(page: Page, options: { conflict?: boolean } = {}) {
    let resolved = false;
    let completed = false;
    const commands: unknown[] = [];
    const pending = (): WhatsappVinculoResumo => ({
      id: pendingId,
      revision: 1,
      integracaoId: `${prefix}-chat-integracao`,
      integracaoNome: 'Conta de atendimento',
      nome: `${prefix} contato`,
      telefone: null,
      bsuid: 'test-bsuid',
      motivo: 'Nenhum cliente vinculado',
      ultimaMensagemEm: timestamp,
      quantidadeMensagens: 1,
      estado: completed ? 'resolvido' : resolved ? 'recuperando' : 'aguardando',
      clienteId: resolved ? clienteId : null,
      conversaId: resolved ? chat.vermelha.id : null,
    });
    await page.route('**/api/whatsapp/vinculos**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers });
        return;
      }
      if (route.request().method() === 'POST') {
        commands.push(route.request().postDataJSON() as unknown);
        if (options.conflict) {
          await answer(
            route,
            { error: 'Outro operador vinculou este contato.', code: 'WA_CONFLICT' },
            409,
          );
          return;
        }
        resolved = true;
        await answer(route, { clienteId, conversaId: chat.vermelha.id, replayPending: true });
        return;
      }
      if (new URL(route.request().url()).pathname.endsWith('/vinculos')) {
        await answer(route, { items: completed ? [] : [pending()], nextCursor: null });
        return;
      }
      if (new URL(route.request().url()).pathname.endsWith('/previsao')) {
        await answer(route, {
          cliente: { id: clienteId, nome: clienteId, cpf_cnpj: null, telefone: null },
          conversaId: chat.vermelha.id,
        });
        return;
      }
      await answer(route, {
        pendencia: pending(),
        candidates: [
          { id: clienteId, nome: clienteId, cpf_cnpj: null, telefone: null, email: null },
        ],
        messages: [
          {
            id: 'retained',
            timestamp,
            conteudo: `${prefix} mensagem aguardando vínculo`,
            anexoUrl: null,
            anexoTipo: null,
          },
        ],
        nextCursor: null,
      });
    });
    return {
      commands,
      complete: () => {
        completed = true;
      },
    };
  }

  test('vincula um cliente existente e acompanha a recuperação na conversa original', async ({
    page,
  }) => {
    const state = await api(page);
    await page.goto('/chat/vinculos-whatsapp');
    await page.getByRole('link', { name: `${prefix} contato`, exact: true }).click();
    await expect(page.getByText(`${prefix} mensagem aguardando vínculo`)).toBeVisible();
    await page.getByRole('button', { name: 'Selecionar', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Ver conversa que será continuada' }),
    ).toHaveAttribute('href', `/chat/${chat.vermelha.id}`);
    await page.getByRole('button', { name: 'Vincular e abrir conversa', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === `/chat/${chat.vermelha.id}`);
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toMatchObject({
      requestId: expect.any(String),
      revision: 1,
      choice: { kind: 'existing', clienteId },
    });
    await expect(page.getByText(/Recuperando mensagens recebidas/)).toBeVisible();
    await expect(page.getByText(`${prefix} histórico preservado`).last()).toBeVisible();
    state.complete();
    await expect(page.getByText(/Recuperando mensagens recebidas/)).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test('mantém o contato e a escolha visíveis quando outro operador vence', async ({ page }) => {
    await api(page, { conflict: true });
    await page.goto(`/chat/vinculos-whatsapp/${pendingId}`);
    await page.getByRole('button', { name: 'Selecionar', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Ver conversa que será continuada' }),
    ).toHaveAttribute('href', `/chat/${chat.vermelha.id}`);
    await page.getByRole('button', { name: 'Vincular e abrir conversa', exact: true }).click();
    await expect(page.getByText('Outro operador vinculou este contato.')).toBeVisible();
    await expect(page.getByText(`${prefix} mensagem aguardando vínculo`)).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === `/chat/vinculos-whatsapp/${pendingId}`);
  });

  test('redireciona links antigos de mensagem e preserva dois rascunhos diferentes', async ({
    page,
  }) => {
    await api(page);
    await page.route('**/api/whatsapp/conversas/**/alias**', (route) =>
      answer(route, { conversaId: chat.vermelha.id, mensagemId: messageId }),
    );
    await page.addInitScript(
      ({ source, target }) => {
        localStorage.setItem(`chat:draft:${source}`, 'Rascunho da conversa anterior');
        localStorage.setItem(`chat:draft:${target}`, 'Rascunho da conversa atual');
      },
      { source: oldId, target: chat.vermelha.id },
    );
    await page.goto(`/chat/${oldId}?msg=old-message&ts=${String(timestamp)}`);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/chat/${chat.vermelha.id}` &&
        url.searchParams.get('msg') === messageId &&
        url.searchParams.get('rascunhoOrigem') === oldId,
    );
    await expect(page.getByLabel('Rascunho da conversa anterior')).toHaveValue(
      'Rascunho da conversa anterior',
    );
    expect(
      await page.evaluate((id) => localStorage.getItem(`chat:draft:${id}`), chat.vermelha.id),
    ).toBe('Rascunho da conversa atual');
    await expect(page.getByText(`${prefix} histórico preservado`).last()).toBeVisible();
  });
});
