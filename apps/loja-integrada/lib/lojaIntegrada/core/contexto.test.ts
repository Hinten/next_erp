import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { z } from 'zod';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  TOKEN_A,
  TOKEN_B,
  caminhoConta,
  caminhoCredencial,
  espiarStdout,
  gravadorDeLog,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import { fingerprintDoToken, refDaCredencial } from './credencial';
import { lerCredencial, salvarCredencial } from './credentialStore';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from './erros';
import { estacionarConta } from './estacionamento';
import {
  type ContextoDeps,
  ENVIAR_CORRELATION_ID_LI,
  OPERACAO_CONTEXTO_LI,
  loadLojaIntegradaContext,
} from './contexto';
import { RITMO_LEITURA_LI_MS } from './ritmo';
import { CHAMADAS_ENV_LI } from './valvulas';

const ID = 'conta-li-1';

/** The switch ON and a pacer that never sleeps — what every case below needs to get past step 0. */
function depsLigado(): ContextoDeps {
  return { ambiente: AMBIENTE_LIGADO, ritmo: ritmoFalso().ritmo };
}

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

describe('step 0: the read switch, before ANY Firestore read', () => {
  // Only the exact `on` passes. Every near-miss — a stray space, the wrong case,
  // a truthy word, blank, unset, an explicit `off` — refuses identically.
  const recusados: readonly [string, string | undefined][] = [
    ['on␠', 'on '],
    ['␠on', ' on'],
    ['ON', 'ON'],
    ['true', 'true'],
    ['1', '1'],
    ['blank', ''],
    ['unset', undefined],
    ['off', 'off'],
  ];

  it.each(recusados)(
    '%s → LiChamadasDesligadasError, zero reads, zero waits, zero fetches, one line',
    async (_nome, valor) => {
      const db = new FakeDb();
      seedConta(db, ID);
      seedCredencial(db, ID);
      const espiao = fetchEspiao();
      const { ritmo, esperas } = ritmoFalso();
      const gravador = gravadorDeLog();
      const err: unknown = await loadLojaIntegradaContext(asDb(db), ID, {
        ambiente: valor === undefined ? {} : { [CHAMADAS_ENV_LI]: valor },
        ritmo,
        fetch: espiao.fetch,
        registro: { escrever: gravador.escrever, fluxo: 'intake', tentativa: 1, idTarefa: 't-1' },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LiChamadasDesligadasError);
      expect((err as LiChamadasDesligadasError).integracaoId).toBe(ID);
      // Nothing at all touched Firestore, the pacer or the network.
      expect(db.leituras).toEqual([]);
      expect(db.consultas).toEqual([]);
      expect(db.escritas).toEqual([]);
      expect(esperas).toEqual([]);
      expect(espiao.pedidos).toEqual([]);
      // Exactly one `chamada-bloqueada` line, naming THIS conta and the step-3 ids.
      expect(gravador.linhas).toHaveLength(1);
      expect(gravador.linhas[0]?.campos).toMatchObject({
        evento: 'chamada-bloqueada',
        conta: ID,
        fluxo: 'intake',
        tentativa: 1,
        idTarefa: 't-1',
        operacao: OPERACAO_CONTEXTO_LI,
        chave: CHAMADAS_ENV_LI,
      });
    },
  );

  it('the switch beats every later refusal: a missing conta still reads as switched off', async () => {
    const db = new FakeDb();
    const err: unknown = await loadLojaIntegradaContext(asDb(db), ID, {
      ambiente: {},
      ritmo: ritmoFalso().ritmo,
      registro: { escrever: gravadorDeLog().escrever },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiChamadasDesligadasError);
    expect(db.leituras).not.toContain(caminhoConta(ID));
  });

  it('a smuggled conta in registro never renames the refusal line', async () => {
    const gravador = gravadorDeLog();
    const registro = { escrever: gravador.escrever, conta: 'outra-conta' };
    await loadLojaIntegradaContext(asDb(new FakeDb()), ID, {
      ambiente: {},
      ritmo: ritmoFalso().ritmo,
      registro,
    }).catch((e: unknown) => e);
    expect(gravador.linhas.map((l) => l.campos.conta)).toEqual([ID]);
  });

  it("near-miss: the exact 'on' passes step 0 and reads the conta", async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, depsLigado());
    expect(ctx.integracaoId).toBe(ID);
    expect(db.leituras).toContain(caminhoCredencial(ID));
  });
});

describe('loadLojaIntegradaContext — the refusals, in order', () => {
  it('a missing conta → LiContaNaoEncontradaError', async () => {
    await expect(
      loadLojaIntegradaContext(asDb(new FakeDb()), ID, depsLigado()),
    ).rejects.toBeInstanceOf(LiContaNaoEncontradaError);
  });

  it('near-miss: a tipo-5 conta → LiContaNaoEncontradaError, even with a valid credential', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { tipo: 5 });
    seedCredencial(db, ID);
    await expect(loadLojaIntegradaContext(asDb(db), ID, depsLigado())).rejects.toBeInstanceOf(
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
      await expect(
        loadLojaIntegradaContext(asDb(db), ID, depsLigado()),
        credencial,
      ).rejects.toBeInstanceOf(LiContaInativaError);
      expect(db.leituras).not.toContain(caminhoCredencial(ID));
    }
  });

  it('no credential → LiCredencialAusenteError', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await expect(loadLojaIntegradaContext(asDb(db), ID, depsLigado())).rejects.toBeInstanceOf(
      LiCredencialAusenteError,
    );
  });

  it('a corrupt credential → LiCredencialInvalidaError, paths only', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, { reconexaoPendente: { desdeMs: 1, status: 500, refCredencial: 'a' } });
    const err: unknown = await loadLojaIntegradaContext(asDb(db), ID, depsLigado()).catch(
      (e: unknown) => e,
    );
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
    const err: unknown = await loadLojaIntegradaContext(asDb(db), ID, depsLigado()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LiContaParadaError);
    expect(err).toMatchObject({ status: 403, desdeMs: AGORA_MS - 10, integracaoId: ID });
  });

  it('the healthy case returns the conta and a client', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { nome: 'Loja Teste' });
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, depsLigado());
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      ...depsLigado(),
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
      const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
        ...depsLigado(),
        fetch: fetchEspiao().fetch,
      });
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

describe('the pacer: one full interval BEFORE every request', () => {
  it('three calls give three waits, each one before its fetch', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const eventos: string[] = [];
    const { ritmo, esperas } = ritmoFalso(() => {
      eventos.push('esperar');
    });
    const espiao = fetchEspiao();
    const fetch: typeof globalThis.fetch = (input, init) => {
      eventos.push('fetch');
      return espiao.fetch(input, init);
    };
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      ambiente: AMBIENTE_LIGADO,
      ritmo,
      fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    // Loading the context makes no call, so it waits for nothing.
    expect(esperas).toEqual([]);
    const leiturasAntes = db.leituras.length;
    await chamar(ctx.cliente);
    await chamar(ctx.cliente);
    await chamar(ctx.cliente);
    expect(eventos).toEqual(['esperar', 'fetch', 'esperar', 'fetch', 'esperar', 'fetch']);
    expect(esperas).toEqual([RITMO_LEITURA_LI_MS, RITMO_LEITURA_LI_MS, RITMO_LEITURA_LI_MS]);
    expect(db.leituras.length - leiturasAntes).toBe(3);
  });

  it('the wait comes before the credential re-read: a park landing during it stops the call', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    let estacionar: Promise<unknown> = Promise.resolve();
    const { ritmo } = ritmoFalso(() => {
      estacionar = estacionarConta(
        asDb(db),
        ID,
        { refCredencial: refDaCredencial(lida!.credencial), status: 401 },
        { agoraMs: () => AGORA_MS },
      );
    });
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      ambiente: AMBIENTE_LIGADO,
      ritmo: {
        intervaloMs: ritmo.intervaloMs,
        esperar: async (ms) => {
          await ritmo.esperar(ms);
          await estacionar;
        },
      },
      fetch: espiao.fetch,
      registro: { escrever: gravadorDeLog().escrever },
    });
    await expect(chamar(ctx.cliente)).rejects.toBeInstanceOf(LiContaParadaError);
    expect(espiao.pedidos).toEqual([]);
  });

  it('two contexts back to back keep at least one interval between their requests', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    // A fake clock the pacer advances; each fetch records when it was sent.
    let agora = 0;
    const enviadosEm: number[] = [];
    const espiao = fetchEspiao();
    const fetch: typeof globalThis.fetch = (input, init) => {
      enviadosEm.push(agora);
      agora += 150; // the request itself takes time too
      return espiao.fetch(input, init);
    };
    const novoContexto = () =>
      loadLojaIntegradaContext(asDb(db), ID, {
        ambiente: AMBIENTE_LIGADO,
        ritmo: ritmoFalso((ms) => {
          agora += ms;
        }).ritmo,
        fetch,
        registro: { escrever: gravadorDeLog().escrever },
      });
    const primeiro = await novoContexto();
    await chamar(primeiro.cliente);
    const segundo = await novoContexto();
    await chamar(segundo.cliente);
    await chamar(segundo.cliente);
    expect(enviadosEm).toHaveLength(3);
    for (let i = 1; i < enviadosEm.length; i += 1) {
      expect((enviadosEm[i] ?? 0) - (enviadosEm[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        RITMO_LEITURA_LI_MS,
      );
    }
  });
});

describe('the credential VERSION: on the context, and reported per request', () => {
  /** A context whose every per-request report lands in `vistas`. */
  async function contextoQueRelata(db: FakeDb, fetch = fetchEspiao().fetch) {
    const vistas: (string | null)[] = [];
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      ...depsLigado(),
      fetch,
      registro: { escrever: gravadorDeLog().escrever },
      aoUsarCredencial: (versao) => {
        vistas.push(versao);
      },
    });
    return { ctx, vistas };
  }

  it('`versaoCredencial` is the stored save stamp, from the ONE fail-fast read (no new read)', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    const atualizadoEmMs = AGORA_MS - 3 * DIA_MS;
    seedCredencial(db, ID, { tokenAtualizadoEmMs: atualizadoEmMs });
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, depsLigado());
    expect(ctx.versaoCredencial).toBe(String(atualizadoEmMs));
    expect(db.leituras.filter((p) => p === caminhoCredencial(ID))).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the version is never the ref, the fingerprint or the token', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, depsLigado());
    const lida = await lerCredencial(asDb(db), ID);
    expect(ctx.versaoCredencial).not.toBe(refDaCredencial(lida!.credencial));
    expect(ctx.versaoCredencial).not.toContain(fingerprintDoToken(TOKEN_A));
    expect(ctx.versaoCredencial).not.toContain(TOKEN_A);
  });

  it('a stamp with no version form (negative) ⇒ `null`, never a guessed one', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, { tokenAtualizadoEmMs: -1 });
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, depsLigado());
    expect(ctx.versaoCredencial).toBeNull();
  });

  it('`aoUsarCredencial` gets the version of EACH request, after the re-read and before the fetch', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const eventos: string[] = [];
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      ...depsLigado(),
      fetch: (input, init) => {
        eventos.push('fetch');
        return espiao.fetch(input, init);
      },
      registro: { escrever: gravadorDeLog().escrever },
      aoUsarCredencial: (versao) => {
        eventos.push(`versao:${String(versao)}`);
      },
    });
    // Loading the context makes no request, so nothing is reported.
    expect(eventos).toEqual([]);
    const leiturasAntes = db.leituras.filter((p) => p === caminhoCredencial(ID)).length;
    await chamar(ctx.cliente);
    await chamar(ctx.cliente);
    const versao = String(AGORA_MS - DIA_MS);
    expect(eventos).toEqual([`versao:${versao}`, 'fetch', `versao:${versao}`, 'fetch']);
    // Still exactly one credential read per request: the report adds none.
    expect(db.leituras.filter((p) => p === caminhoCredencial(ID)).length - leiturasAntes).toBe(2);
  });

  it('a token saved mid-batch is reported under its NEW version, while the context keeps the old one', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const { ctx, vistas } = await contextoQueRelata(db);
    await chamar(ctx.cliente);
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    await chamar(ctx.cliente);
    expect(vistas).toEqual([String(AGORA_MS - DIA_MS), String(AGORA_MS)]);
    expect(ctx.versaoCredencial).toBe(String(AGORA_MS - DIA_MS));
    const texto = JSON.stringify(vistas);
    expect(texto).not.toContain(fingerprintDoToken(TOKEN_A));
    expect(texto).not.toContain(fingerprintDoToken(TOKEN_B));
  });

  it('⚠️ NEAR-MISS: the SAME token saved again is a new version (the save stamp, not the token)', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const { ctx, vistas } = await contextoQueRelata(db);
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_A,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    await chamar(ctx.cliente);
    expect(vistas).toEqual([String(AGORA_MS)]);
    expect(vistas[0]).not.toBe(ctx.versaoCredencial);
  });

  it('a stamp with no version form is reported as `null`, so a caller comparing versions sees it', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const { ctx, vistas } = await contextoQueRelata(db);
    seedCredencial(db, ID, { tokenAtualizadoEmMs: -1 });
    await chamar(ctx.cliente);
    expect(vistas).toEqual([null]);
  });

  it('a request refused by a park reports nothing: no credential was handed out', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const espiao = fetchEspiao();
    const { ctx, vistas } = await contextoQueRelata(db, espiao.fetch);
    const lida = await lerCredencial(asDb(db), ID);
    await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: refDaCredencial(lida!.credencial), status: 401 },
      { agoraMs: () => AGORA_MS },
    );
    await expect(chamar(ctx.cliente)).rejects.toBeInstanceOf(LiContaParadaError);
    expect(vistas).toEqual([]);
    expect(espiao.pedidos).toEqual([]);
  });

  it('what the report throws is what the call throws, and that request is never sent', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const recusa = new TypeError('outra versão');
    const espiao = fetchEspiao();
    const ctx = await loadLojaIntegradaContext(asDb(db), ID, {
      ...depsLigado(),
      fetch: espiao.fetch,
      registro: { escrever: gravadorDeLog().escrever },
      aoUsarCredencial: () => {
        throw recusa;
      },
    });
    await expect(chamar(ctx.cliente)).rejects.toBe(recusa);
    expect(espiao.pedidos).toEqual([]);
  });
});
