/**
 * The NF-e upload's two Delivery-API calls (step 14, PR 14-c): the status read
 * through the REAL context over the fake db and a scripted `fetch` (the
 * forced-refresh-once rule, the refused-read classifier), and the submit through
 * a RECORDING write client (exactly one POST, no refresh rule of its own).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one serves model shapes.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonThrottleError,
  type SpApiEscritaClient,
} from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { AGORA_MS } from '../testing/fixtures';
import { harnessImportador } from '../testing/importadorAmazon';
import { ORDER_ID_TESTE } from '../testing/pedidoWireAmazon';
import { conteudoDaNfeAmazon } from './conteudoNfe';
import { enviarNfeNaAmazon, lerStatusNfeNaAmazon } from './entregaAmazon';

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

const ACEITA = {
  orderInvoicingStatus: 'Accepted',
  invoiceStatus: 'Accepted',
  invoices: [{ id: 'inv-sintetico-1', status: 'Accepted' }],
};

async function ler(...respostas: { status: number; corpo: unknown }[]) {
  const h = harnessImportador(respostas);
  const contexto = await h.contexto();
  return { h, leitura: lerStatusNfeNaAmazon(contexto, ORDER_ID_TESTE) };
}

describe('lerStatusNfeNaAmazon — the status read', () => {
  it('★ one GET of the four NAMED keys, read by the status reader', async () => {
    const { h, leitura } = await ler({ status: 200, corpo: ACEITA });
    await expect(leitura).resolves.toEqual({ tipo: 'aceita' });
    expect(h.gets).toHaveLength(1);
    expect(h.gets[0]?.pathname).toBe('/delivery/2022-07-01/invoice/status');
    expect([...(h.gets[0]?.searchParams.keys() ?? [])].sort()).toEqual([
      'invoiceType',
      'marketplaceId',
      'orderId',
      'programType',
    ]);
    expect(h.gets[0]?.searchParams.get('orderId')).toBe(ORDER_ID_TESTE);
  });

  it.each<[string, { status: number; corpo: unknown }, string]>([
    ['a 404', { status: 404, corpo: { errors: [{ code: 'NotFound', message: 'x' }] } }, 'sem-nota'],
    [
      'a 400 EntityNotFound',
      { status: 400, corpo: { errors: [{ code: 'EntityNotFound', message: 'x' }] } },
      'sem-nota',
    ],
    [
      'NEAR-MISS a 400 InvalidInput',
      { status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } },
      'indeterminado',
    ],
  ])('★ a REFUSED read that is still a reading: %s ⇒ %s', async (_c, resposta, tipo) => {
    const { leitura } = await ler(resposta);
    await expect(leitura).resolves.toMatchObject({ tipo });
  });

  it('★ a 401 ⇒ EXACTLY one forced refresh and one more read', async () => {
    const { h, leitura } = await ler(
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      { status: 200, corpo: ACEITA },
    );
    await expect(leitura).resolves.toEqual({ tipo: 'aceita' });
    expect(h.gets).toHaveLength(2);
    expect(h.lwa).toBe(1);
  });

  it('a 429 and a 5xx are NOT readings: rethrown untouched (the caller’s pause and transient rules)', async () => {
    const throttle = await ler({ status: 429, corpo: { errors: [] } });
    await expect(throttle.leitura).rejects.toBeInstanceOf(AmazonThrottleError);
    const falha = await ler({ status: 503, corpo: { errors: [] } });
    await expect(falha.leitura).rejects.toSatisfy(
      (e: unknown) => e instanceof AmazonHttpError && e.status === 503 && e.transitorio,
    );
  });
});

describe('enviarNfeNaAmazon — the engine’s `escrever`', () => {
  const XML = '<?xml version="1.0" encoding="UTF-8"?><nfeProc/>';

  function escritor(resposta: () => Promise<unknown>) {
    const post = vi.fn((..._args: unknown[]) => resposta());
    return { cliente: { post } as unknown as SpApiEscritaClient, post };
  }

  it('★ ONE POST: the order in the query, the stored bytes and their digest in the body', async () => {
    const { cliente, post } = escritor(() =>
      Promise.resolve({ status: 200, dados: null, correlationId: 'c' }),
    );
    await expect(
      enviarNfeNaAmazon(cliente, ORDER_ID_TESTE, conteudoDaNfeAmazon(XML)),
    ).resolves.toEqual({ tipo: 'aceito-para-processamento' });
    expect(post).toHaveBeenCalledTimes(1);
    const pedido = post.mock.calls[0]?.[0] as { query: unknown; corpo: string; caminho: string };
    expect(pedido.caminho).toBe('/delivery/2022-07-01/invoice');
    expect(pedido.query).toEqual({ orderId: ORDER_ID_TESTE });
    expect(JSON.parse(pedido.corpo)).toMatchObject(conteudoDaNfeAmazon(XML));
  });

  it('★ a 401 PROPAGATES after ONE post: the refresh rule is the engine’s, never applied twice', async () => {
    const recusa = new AmazonAuthError({
      destino: 'sp-api',
      operacao: 'submitInvoice',
      metodo: 'POST',
      caminho: '/delivery/2022-07-01/invoice',
      status: 401,
      refCredencial: null,
      codigoLwa: null,
    } as never);
    const { cliente, post } = escritor(() => Promise.reject(recusa));
    await expect(enviarNfeNaAmazon(cliente, ORDER_ID_TESTE, conteudoDaNfeAmazon(XML))).rejects.toBe(
      recusa,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
});
