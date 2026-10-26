/**
 * The WRITE context: the read loader's refusals in the read loader's order, two
 * clients bound to the conta's stored token, the write pacer, and the credential
 * pin a write run decides under ("the same credential" is literal: a token
 * re-saved between the deciding read and the write sends nothing).
 *
 * D17: every case either stops at the read switch or answers from a stub; the
 * unit config's network kill-switch fails any `fetch` that reaches a real host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  liEcoSituacaoPedidoSchema,
  liPedidoSchema,
  listarHistoricoSituacaoLi,
} from '@delfrance/integrations-loja-integrada';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  TOKEN_A,
  TOKEN_B,
  caminhoConta,
  caminhoCredencial,
  gravadorDeLog,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { NUMERO_LI, pedidoLiBruto } from '../testing/pedidosLi';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import {
  type ContextoEscritaDeps,
  type ContextoEscritaLojaIntegrada,
  OPERACAO_CONTEXTO_ESCRITA_LI,
  loadLojaIntegradaContextoEscrita,
} from './contextoEscrita';
import { refDaCredencial } from './credencial';
import { lerCredencial } from './credentialStore';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialTrocadaError,
} from './erros';
import { estacionarConta } from './estacionamento';
import { RITMO_ESCRITA_LI_MS } from './ritmo';
import { CHAMADAS_ENV_LI } from './valvulas';

const ID = 'conta-li-1';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

interface PedidoGravado {
  readonly metodo: string;
  readonly url: string;
  readonly autorizacao: string | undefined;
}

/** A stub platform: the order detail, an empty history page, 200 to a PUT. Records every request. */
function plataforma(): { fetch: typeof globalThis.fetch; pedidos: PedidoGravado[] } {
  const pedidos: PedidoGravado[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    pedidos.push({
      metodo: init?.method ?? 'GET',
      url,
      autorizacao: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    const corpo = url.includes('/situacao_historico/')
      ? { meta: { limit: 50, offset: 0, next: null, previous: null, total_count: 0 }, objects: [] }
      : pedidoLiBruto();
    return Promise.resolve(
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, pedidos };
}

function deps(over: Partial<ContextoEscritaDeps> = {}): {
  deps: ContextoEscritaDeps;
  esperas: number[];
  linhas: ReturnType<typeof gravadorDeLog>['linhas'];
} {
  const esperas: number[] = [];
  const gravador = gravadorDeLog();
  return {
    deps: {
      ambiente: AMBIENTE_LIGADO,
      esperar: (ms) => {
        esperas.push(ms);
        return Promise.resolve();
      },
      registro: { escrever: gravador.escrever, fluxo: 'rastreio' },
      ...over,
    },
    esperas,
    linhas: gravador.linhas,
  };
}

/** The deciding GET, through the write client. */
function lerPedido(ctx: ContextoEscritaLojaIntegrada) {
  return ctx.escrita.lerAntesDeEscreverLi({
    operacao: 'teste',
    caminho: `/v1/pedido/${String(NUMERO_LI)}/`,
    schema: liPedidoSchema,
  });
}

describe('step 0: the read switch, before ANY Firestore read and before a client exists', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['ON', 'ON'],
    ['on␠', 'on '],
  ])(
    '%s → LiChamadasDesligadasError: zero reads, zero waits, zero fetches, one line',
    async (_n, valor) => {
      const db = new FakeDb();
      seedConta(db, ID);
      seedCredencial(db, ID);
      const p = plataforma();
      const d = deps({
        ambiente: valor === undefined ? {} : { [CHAMADAS_ENV_LI]: valor },
        fetch: p.fetch,
      });
      const err: unknown = await loadLojaIntegradaContextoEscrita(asDb(db), ID, d.deps).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LiChamadasDesligadasError);
      expect(db.leituras).toEqual([]);
      expect(db.escritas).toEqual([]);
      expect(d.esperas).toEqual([]);
      expect(p.pedidos).toEqual([]);
      expect(d.linhas).toHaveLength(1);
      expect(d.linhas[0]?.campos).toMatchObject({
        evento: 'chamada-bloqueada',
        conta: ID,
        fluxo: 'rastreio',
        operacao: OPERACAO_CONTEXTO_ESCRITA_LI,
      });
    },
  );
});

describe('the refusals, in the read loader’s order', () => {
  it('a missing conta → LiContaNaoEncontradaError', async () => {
    await expect(
      loadLojaIntegradaContextoEscrita(asDb(new FakeDb()), ID, deps().deps),
    ).rejects.toBeInstanceOf(LiContaNaoEncontradaError);
  });

  it('inactive is refused BEFORE the credential is looked at', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { ativo: false });
    await expect(
      loadLojaIntegradaContextoEscrita(asDb(db), ID, deps().deps),
    ).rejects.toBeInstanceOf(LiContaInativaError);
    expect(db.leituras).not.toContain(caminhoCredencial(ID));
    expect(db.leituras).toContain(caminhoConta(ID));
  });

  it('no credential → LiCredencialAusenteError; a parked one → LiContaParadaError', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await expect(
      loadLojaIntegradaContextoEscrita(asDb(db), ID, deps().deps),
    ).rejects.toBeInstanceOf(LiCredencialAusenteError);
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 401, refCredencial: 'a.1' },
    });
    await expect(
      loadLojaIntegradaContextoEscrita(asDb(db), ID, deps().deps),
    ).rejects.toBeInstanceOf(LiContaParadaError);
  });
});

describe('the clients', () => {
  it('the write pacer, both clients and an unpinned credential', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContextoEscrita(asDb(db), ID, deps().deps);
    expect(ctx.integracaoId).toBe(ID);
    expect(ctx.ritmo.intervaloMs).toBe(RITMO_ESCRITA_LI_MS);
    expect(Object.keys(ctx.escrita).sort()).toEqual(['enviarEscritaLi', 'lerAntesDeEscreverLi']);
    expect(Object.keys(ctx.leitura)).toEqual(['get']);
    expect(ctx.credencial.fixada()).toBeNull();
  });

  it('the write client does NOT pace (the engine does); the read client paces one interval per request', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const p = plataforma();
    const d = deps({ fetch: p.fetch });
    const ctx = await loadLojaIntegradaContextoEscrita(asDb(db), ID, d.deps);
    await lerPedido(ctx);
    expect(d.esperas).toEqual([]);
    await listarHistoricoSituacaoLi(ctx.leitura, NUMERO_LI);
    expect(d.esperas).toEqual([RITMO_ESCRITA_LI_MS]);
    expect(p.pedidos.map((x) => x.autorizacao)).toEqual([`Basic ${TOKEN_A}`, `Basic ${TOKEN_A}`]);
  });

  it('every call of either client is ONE line, under THIS conta, whatever registro carries', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const p = plataforma();
    const gravador = gravadorDeLog();
    const ctx = await loadLojaIntegradaContextoEscrita(asDb(db), ID, {
      ...deps({ fetch: p.fetch }).deps,
      registro: { escrever: gravador.escrever, fluxo: 'rastreio' },
    });
    await lerPedido(ctx);
    await listarHistoricoSituacaoLi(ctx.leitura, NUMERO_LI);
    expect(gravador.linhas.map((l) => [l.campos.evento, l.campos.conta, l.campos.metodo])).toEqual([
      ['chamada', ID, 'GET'],
      ['chamada', ID, 'GET'],
    ]);
    expect(JSON.stringify(gravador.linhas)).not.toContain(TOKEN_A);
  });
});

describe('the credential pin', () => {
  async function contextoFixado() {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const p = plataforma();
    const ctx = await loadLojaIntegradaContextoEscrita(asDb(db), ID, deps({ fetch: p.fetch }).deps);
    const r = await lerPedido(ctx);
    ctx.credencial.fixar(r.refCredencial);
    return { db, p, ctx, ref: r.refCredencial };
  }

  it('pins the deciding read’s ref; the same credential keeps working', async () => {
    const { p, ctx, ref } = await contextoFixado();
    const lida = await lerPedido(ctx);
    expect(lida.refCredencial).toBe(ref);
    expect(ctx.credencial.fixada()).toBe(ref);
    expect(p.pedidos).toHaveLength(2);
  });

  it('⚠️ another token saved after the pin ⇒ LiCredencialTrocadaError with ZERO requests, on BOTH clients', async () => {
    const { db, p, ctx } = await contextoFixado();
    seedCredencial(db, ID, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
    const antes = p.pedidos.length;
    await expect(lerPedido(ctx)).rejects.toBeInstanceOf(LiCredencialTrocadaError);
    await expect(
      ctx.escrita.enviarEscritaLi({
        operacao: 'teste',
        caminho: `/v1/situacao/pedido/${String(NUMERO_LI)}`,
        corpo: { codigo: 'pedido_enviado' },
        ecoSchema: liEcoSituacaoPedidoSchema,
      }),
    ).rejects.toBeInstanceOf(LiCredencialTrocadaError);
    await expect(listarHistoricoSituacaoLi(ctx.leitura, NUMERO_LI)).rejects.toBeInstanceOf(
      LiCredencialTrocadaError,
    );
    expect(p.pedidos).toHaveLength(antes);
  });

  it('⚠️ NEAR-MISS: the SAME token re-saved is another version — refused too (the ref carries the save)', async () => {
    const { db, p, ctx } = await contextoFixado();
    seedCredencial(db, ID, { personalToken: TOKEN_A, tokenAtualizadoEmMs: AGORA_MS });
    const antes = p.pedidos.length;
    await expect(lerPedido(ctx)).rejects.toBeInstanceOf(LiCredencialTrocadaError);
    expect(p.pedidos).toHaveLength(antes);
  });

  it('a park after the pin is still a park: LiContaParadaError, zero requests', async () => {
    const { db, p, ctx } = await contextoFixado();
    const lida = await lerCredencial(asDb(db), ID);
    await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: refDaCredencial(lida!.credencial), status: 401 },
      { agoraMs: () => AGORA_MS },
    );
    const antes = p.pedidos.length;
    await expect(lerPedido(ctx)).rejects.toBeInstanceOf(LiContaParadaError);
    expect(p.pedidos).toHaveLength(antes);
  });

  it('a second pin to another ref is a programming error; the same ref is a no-op', async () => {
    const { ctx, ref } = await contextoFixado();
    expect(() => ctx.credencial.fixar(ref)).not.toThrow();
    expect(() => ctx.credencial.fixar('outra.1')).toThrow(TypeError);
    expect(ctx.credencial.fixada()).toBe(ref);
  });

  it('before the pin, a token saved mid-run is simply used', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const p = plataforma();
    const ctx = await loadLojaIntegradaContextoEscrita(asDb(db), ID, deps({ fetch: p.fetch }).deps);
    await lerPedido(ctx);
    seedCredencial(db, ID, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
    await lerPedido(ctx);
    expect(p.pedidos.map((x) => x.autorizacao)).toEqual([`Basic ${TOKEN_A}`, `Basic ${TOKEN_B}`]);
  });
});
