/**
 * The import's one `getOrder` read, through the REAL context over the fake db
 * and a scripted `fetch` (no network: the global `fetch` refuses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { AGORA_MS } from '../testing/fixtures';
import {
  harnessImportador,
  payloadPoll,
  payloadPush,
  registroTeste,
  respostaDoPedido,
} from '../testing/importadorAmazon';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  linhaAmazon,
  pedidoAmazon,
} from '../testing/pedidoWireAmazon';
import { AmazonLeituraDefasadaError, PedidoAmazonIlegivelError } from './erros';
import { lerPedidoAmazon } from './lerPedidoAmazon';

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/** The order as JSON, with a raw override merged last (a value the builder would refuse). */
function corpo(over: Record<string, unknown> = {}) {
  return { ...JSON.parse(JSON.stringify(pedidoAmazon())), ...over } as Record<string, unknown>;
}

async function ler(
  resposta: Record<string, unknown>,
  opcoes: { payload?: ReturnType<typeof payloadPush>; tentativa?: number | null } = {},
) {
  const h = harnessImportador([respostaDoPedido(resposta)]);
  const contexto = await h.contexto();
  const leituras = h.db.leituras.length;
  const p = lerPedidoAmazon(
    contexto,
    opcoes.payload ?? payloadPush(),
    registroTeste(opcoes.tentativa === undefined ? 0 : opcoes.tentativa),
  );
  return { h, p, leiturasAntes: leituras };
}

describe('lerPedidoAmazon — the one getOrder', () => {
  it('GETs the order once, with the fixed includedData, and answers its µs watermark', async () => {
    const { h, p } = await ler(corpo());
    const r = await p;
    expect(r).toMatchObject({ tipo: 'lido', watermarkUs: ATUALIZADO_US, defasadaAceita: false });
    expect(h.gets).toHaveLength(1);
    expect(h.gets[0]?.pathname).toBe(`/orders/2026-01-01/orders/${ORDER_ID_TESTE}`);
    expect([...(h.gets[0]?.searchParams.keys() ?? [])]).toEqual(['includedData']);
  });

  it('★ a wrong orderId (one digit off) ⇒ PedidoAmazonIlegivelError pedido-divergente, no Firestore read of its own', async () => {
    const { h, p, leiturasAntes } = await ler(corpo({ orderId: '171-9876543-2109877' }));
    await expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof PedidoAmazonIlegivelError && e.motivo === 'pedido-divergente',
    );
    // The client re-reads the credential per request; nothing else is read.
    expect(h.db.leituras.slice(leiturasAntes).every((c) => c.includes('/credenciais/'))).toBe(true);
  });

  it('★ an order id outside the grammar, even when it equals the payload, is refused the same way', async () => {
    const { p } = await ler(corpo({ orderId: '171-9876543-21098' }), {
      payload: { ...payloadPush(), amazonOrderId: '171-9876543-21098' },
    });
    await expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof PedidoAmazonIlegivelError && e.motivo === 'pedido-divergente',
    );
  });

  it('★ an offset-less lastUpdatedTime ⇒ instante-ilegivel (never a guessed instant)', async () => {
    const { p } = await ler(corpo({ lastUpdatedTime: '2026-10-01T12:00:00' }));
    await expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof PedidoAmazonIlegivelError && e.motivo === 'instante-ilegivel',
    );
  });

  it('★ a duplicate orderItemId ⇒ linha-duplicada', async () => {
    const linha = linhaAmazon('L1', { qtd: 1, preco: '10.00' });
    const { p } = await ler(corpo({ orderItems: [linha, linha] }));
    await expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof PedidoAmazonIlegivelError && e.motivo === 'linha-duplicada',
    );
  });

  describe('★ a poll payload NEWER than the read (plan §3 decision 3)', () => {
    it('on a QUEUE attempt ⇒ AmazonLeituraDefasadaError (retry)', async () => {
      const { p } = await ler(corpo(), { payload: payloadPoll(ATUALIZADO_US + 1), tentativa: 0 });
      await expect(p).rejects.toBeInstanceOf(AmazonLeituraDefasadaError);
    });

    it('on the queue’s LAST attempt too (the queue persists failed, the sweep re-drives)', async () => {
      const { p } = await ler(corpo(), { payload: payloadPoll(ATUALIZADO_US + 1), tentativa: 2 });
      await expect(p).rejects.toBeInstanceOf(AmazonLeituraDefasadaError);
    });

    it('NEAR-MISS: in a SWEEP re-drive (no attempt) ⇒ imported, flagged for the count line', async () => {
      const { p } = await ler(corpo(), {
        payload: payloadPoll(ATUALIZADO_US + 1),
        tentativa: null,
      });
      await expect(p).resolves.toMatchObject({ tipo: 'lido', defasadaAceita: true });
    });

    it('NEAR-MISS: an EQUAL stamp is no lag', async () => {
      const { p } = await ler(corpo(), { payload: payloadPoll(ATUALIZADO_US), tentativa: 0 });
      await expect(p).resolves.toMatchObject({ tipo: 'lido', defasadaAceita: false });
    });

    it('a push payload carries no order clock: never compared', async () => {
      const { p } = await ler(corpo(), { payload: payloadPush(), tentativa: 0 });
      await expect(p).resolves.toMatchObject({ tipo: 'lido', defasadaAceita: false });
    });
  });

  describe('★ the BR marketplace', () => {
    it.each<[string, Record<string, unknown>]>([
      ['another marketplace id', { marketplaceId: 'ATVPDKIKX0DER', channelName: 'AMAZON' }],
      ['another channel', { marketplaceId: 'A2Q3Y263D00KWC', channelName: 'NON_AMAZON' }],
    ])('%s ⇒ marketplace-estrangeiro', async (_c, salesChannel) => {
      const { p } = await ler(corpo({ salesChannel }));
      await expect(p).resolves.toEqual({ tipo: 'marketplace-estrangeiro' });
    });

    it.each<[string, Record<string, unknown> | undefined]>([
      ['BR, named', { marketplaceId: 'A2Q3Y263D00KWC', channelName: 'AMAZON' }],
      ['absent', undefined],
      ['blank', { marketplaceId: '', channelName: '  ' }],
    ])('NEAR-MISS: %s ⇒ read', async (_c, salesChannel) => {
      const { p } = await ler(corpo(salesChannel === undefined ? {} : { salesChannel }));
      await expect(p).resolves.toMatchObject({ tipo: 'lido' });
    });
  });

  it('★ a 401 on getOrder ⇒ EXACTLY one forced refresh and one retry', async () => {
    const h = harnessImportador([
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      respostaDoPedido(corpo()),
    ]);
    const contexto = await h.contexto();
    const r = await lerPedidoAmazon(contexto, payloadPush(), registroTeste(0));
    expect(r).toMatchObject({ tipo: 'lido' });
    expect(h.gets).toHaveLength(2);
    expect(h.lwa).toBe(1);
  });
});
