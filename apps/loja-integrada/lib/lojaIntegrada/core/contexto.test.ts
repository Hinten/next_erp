import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { z } from 'zod';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  TOKEN_B,
  caminhoCredencial,
  espiarStdout,
  gravadorDeLog,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import { fingerprintDoToken, refDaCredencial } from './credencial';
import { lerCredencial, salvarCredencial } from './credentialStore';
import {
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from './erros';
import { estacionarConta } from './estacionamento';
import { ENVIAR_CORRELATION_ID_LI, loadLojaIntegradaContext } from './contexto';

const ID = 'conta-li-1';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/** A `fetch` double that records each request and answers an empty page. */
function fetchEspiao(): {
  fetch: typeof globalThis.fetch;
  pedidos: { url: string; headers: Record<string, string> }[];
} {
  const pedidos: { url: string; headers: Record<string, string> }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    pedidos.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    return Promise.resolve(
      new Response(JSON.stringify({ meta: {}, objects: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, pedidos };
}

function chamar(cliente: Awaited<ReturnType<typeof loadLojaIntegradaContext>>['cliente']) {
  return cliente.get({ operacao: 'teste', caminho: '/v1/categoria/', schema: z.unknown() });
}

describe('loadLojaIntegradaContext — the refusals, in order', () => {
  it('a missing conta → LiContaNaoEncontradaError', async () => {
    await expect(loadLojaIntegradaContext(asDb(new FakeDb()), ID)).rejects.toBeInstanceOf(
      LiContaNaoEncontradaError,
    );
  });

  it('near-miss: a tipo-5 conta → LiContaNaoEncontradaError, even with a valid credential', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { tipo: 5 });
    seedCredencial(db, ID);
    await expect(loadLojaIntegradaContext(asDb(db), ID)).rejects.toBeInstanceOf(
      LiContaNaoEncontradaError,
    );
  });

  it('inactive is refused BEFORE the credential is looked at (missing, corrupt or parked)', async () => {
    for (const credencial of ['ausente', 'corrompida', 'parada'] as const) {
      __resetAllReadCaches();
      const db = new FakeDb();
      seedConta(db, ID, { ativo: false });
      if (credencial === 'corrompida') seedCredencial(db, ID, { tokenFingerprint: 'x' });
      if (credencial === 'parada') {
        seedCredencial(db, ID, {
          reconexaoPendente: { desdeMs: 1, status: 401, refCredencial: 'a.1' },
        });
      }
      await expect(loadLojaIntegradaContext(asDb(db), ID), credencial).rejects.toBeInstanceOf(
        LiContaInativaError,
      );
      expect(db.leituras).not.toContain(caminhoCredencial(ID));
    }
  });

  it('no credential → LiCredencialAusenteError', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await expect(loadLojaIntegradaContext(asDb(db), ID)).rejects.toBeInstanceOf(
      LiCredencialAusenteError,
    );
  });

  it('a corrupt credential → LiCredencialInvalidaError, paths only', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, { reconexaoPendente: { desdeMs: 1, status: 500, refCredencial: 'a' } });
    const err: unknown = await loadLojaIntegradaContext(asDb(db), ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiCredencialInvalidaError);
    expect((err as LiCredencialInvalidaError).campos).toEqual(['reconexaoPendente.status']);
    expect(String(err)).not.toContain(TOKEN_A);
  });

  it('a parked credential → LiContaParadaError carrying status and desdeMs', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 403, refCredencial: 'a.1' },
    });
    const err: unknown = await loadLojaIntegradaContext(asDb(db), ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiContaParadaError);
    expect(err).toMatchObject({ status: 403, desdeMs: AGORA_MS - 10, integracaoId: ID });
  });

  it('the healthy case returns the conta and a client', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { nome: 'Loja Teste' });
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContext(asDb(db), ID);
    expect(ctx.integracaoId).toBe(ID);
    expect(ctx.conta).toMatchObject({ nome: 'Loja Teste', tipo: 3, ativo: true });
    expect(typeof ctx.cliente.get).toBe('function');
  });
});

describe('the client re-reads the credential on EVERY request', () => {
  it('sends the stored token in Authorization, with no x-correlation-id', async () => {
    expect(ENVIAR_CORRELATION_ID_LI).toBe(false);
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: espiao.fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    await chamar(ctx.cliente);
    expect(espiao.pedidos).toHaveLength(1);
    const [pedido] = espiao.pedidos;
    expect(pedido?.headers.Authorization).toBe(`Basic ${TOKEN_A}`);
    expect(Object.keys(pedido?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'x-correlation-id',
    );
    expect(pedido?.url).not.toContain(TOKEN_A);
  });

  it('after a park, the next request throws LiContaParadaError with ZERO fetch calls', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: espiao.fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    const lida = await lerCredencial(asDb(db), ID);
    await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: refDaCredencial(lida!.credencial), status: 401 },
      { agoraMs: () => AGORA_MS },
    );
    await expect(chamar(ctx.cliente)).rejects.toBeInstanceOf(LiContaParadaError);
    expect(espiao.pedidos).toEqual([]);
  });

  it('picks up a token saved mid-batch', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: espiao.fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    await chamar(ctx.cliente);
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    await chamar(ctx.cliente);
    expect(espiao.pedidos.map((p) => p.headers.Authorization)).toEqual([
      `Basic ${TOKEN_A}`,
      `Basic ${TOKEN_B}`,
    ]);
  });

  it('the credential read is never cached: one fresh read per request', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: fetchEspiao().fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    const antes = db.leituras.filter((p) => p === caminhoCredencial(ID)).length;
    await chamar(ctx.cliente);
    await chamar(ctx.cliente);
    await chamar(ctx.cliente);
    expect(db.leituras.filter((p) => p === caminhoCredencial(ID)).length - antes).toBe(3);
  });

  it('each call is ONE log line: the credential VERSION, never the token or its fingerprint', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    const atualizadoEmMs = AGORA_MS - DIA_MS;
    seedCredencial(db, ID, { tokenAtualizadoEmMs: atualizadoEmMs });
    const gravador = gravadorDeLog();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: fetchEspiao().fetch,
      registro: { escrever: gravador.escrever, fluxo: 'intake', tentativa: 2, idTarefa: 't-1' },
    });
    await chamar(ctx.cliente);
    expect(gravador.linhas).toHaveLength(1);
    const [linha] = gravador.linhas;
    expect(linha?.severidade).toBe('INFO');
    expect(linha?.campos).toMatchObject({
      evento: 'chamada',
      conta: ID,
      fluxo: 'intake',
      tentativa: 2,
      idTarefa: 't-1',
      idNotificacao: null,
      operacao: 'teste',
      credencial: 'personal-token',
      versaoCredencial: String(atualizadoEmMs),
      enviouCorrelationId: false,
      status: 200,
      resultado: 'ok',
    });
    const texto = JSON.stringify(gravador.linhas);
    expect(texto).not.toContain(TOKEN_A);
    expect(texto).not.toContain(fingerprintDoToken(TOKEN_A));
  });

  it('near-miss: a conta smuggled into registro is ignored — the line names THIS context', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const gravador = gravadorDeLog();
    const registro = { escrever: gravador.escrever, conta: 'outra-conta' };
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      fetch: fetchEspiao().fetch,
      registro,
    });
    await chamar(ctx.cliente);
    expect(gravador.linhas.map((l) => l.campos.conta)).toEqual([ID]);
  });

  it('near-miss: an observer smuggled into deps or registro is never called — only the logger sees the event', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const gravador = gravadorDeLog();
    const vistos: unknown[] = [];
    const onChamada = (e: unknown) => {
      vistos.push(e);
    };
    // A variable, not a literal: the type system allows the extra keys, so only
    // the loader's own wiring keeps them out.
    const deps = {
      fetch: fetchEspiao().fetch,
      registro: { escrever: gravador.escrever, onChamada },
      onChamada,
    };
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, deps);
    await chamar(ctx.cliente);
    expect(vistos).toEqual([]);
    expect(gravador.linhas.map((l) => l.campos.conta)).toEqual([ID]);
  });

  it('with no registro, one call writes exactly ONE JSON line through the default sink', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const stdout = espiarStdout();
    try {
      const ctx = await loadLojaIntegradaContext(asDb(db), ID, { fetch: fetchEspiao().fetch });
      await chamar(ctx.cliente);
      const escritas = stdout.escritas();
      expect(escritas).toHaveLength(1);
      expect(escritas[0]?.endsWith('\n')).toBe(true);
      expect(JSON.parse(escritas[0] ?? '')).toMatchObject({
        severity: 'INFO',
        evento: 'chamada',
        conta: ID,
      });
      expect(escritas.join('')).not.toContain(TOKEN_A);
    } finally {
      stdout.restaurar();
    }
  });
});
