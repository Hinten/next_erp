/**
 * The order poller, end to end against the fake Firestore: the REAL context
 * loader, the REAL package client and paging, the REAL notification store and
 * the REAL `escreverAviso` / `resolverAviso`. Only the transport is faked: Loja
 * Integrada is a scripted `fetch` handed in through `deps.fetch`, the queue a
 * recording producer, the clock and the pacer's sleep a manual clock.
 *
 * ⚠️ No network: the global `fetch` is stubbed to refuse and record, and every
 * test ends by asserting it was never called.
 *
 * The rows are built from the public document's `GET /v1/pedido/search`
 * example (numeros 164 and 165, their own stamps) and its `/api/v1` `meta.next`
 * form; everything else is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { LiConfigError } from '@delfrance/integrations-loja-integrada';
import {
  CANAL_AVISO,
  MARCA_DATA_ILEGIVEL_LI,
  MOTIVO_IMPORTACAO_PARADA_LI,
  ORIGEM_NOTIFICACAO_LI,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_TAREFA_LI,
} from '@delfrance/schemas';

import {
  avisarImportacaoParada,
  chaveImportacaoParada,
  chaveReconexao,
  relogioDoDocumentoUs,
  resolverImportacaoParada,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { docCredencial } from '../core/credentialStore';
import { CHAMADAS_ENV_LI } from '../core/valvulas';
import { LiTarefasDesligadasError } from '../notificacoes/agendador';
import { type PayloadNotificacaoLi, docIdNotificacaoLi } from '../notificacoes/notificacao';
import { type DocData, FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  falhaDeConfiguracaoDoFunctions,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  type LinhaGravada,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  loggerEspiao,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import {
  LATENCIA_LI_ESTIMADA_MS,
  MAX_PAGINAS_POLL,
  ORCAMENTO_CONTA_MS,
  ORCAMENTO_MINIMO_CONTA_MS,
} from './orcamentoPoll';
import {
  AVISO_APOS_FALHAS_SEGUIDAS_LI,
  type DepsPollLi,
  LIMIAR_AVISO_IMPORTACAO_PARADA_LI,
  type ResultadoContaPollLi,
  type ResultadoTickPollLi,
  executarContaPollLi,
  executarPollPedidosLi,
  resumirTickPollLi,
} from './pollPedidos';

const ID = 'conta-li-1';
const CAMINHO_POLL = `pollPedidosLojaIntegrada/${ID}`;
const COLECAO_NOTIFICACOES = 'notificacoesLojaIntegrada';

/** A stored cursor, in the naive text: the window starts 4 h 02 min before it. */
const CURSOR = '2027-01-15T10:00:00';
/** `CURSOR − SOBREPOSICAO_S` (14 520 s). */
const SINCE = '2027-01-15T05:58:00';
/** `SINCE − TOLERANCIA_FILTRO_S` (15 000 s): the filter-ignored floor and the prune bound. */
const TOLERANCIA = '2027-01-15T01:48:00';
/** AGORA_MS − 72 h, in São Paulo time: the bootstrap bound of a cursorless conta. */
const BOOTSTRAP_72H = '2027-01-12T12:00:00';

/** A search row as Loja Integrada sends it (only what the poller decides on, plus a passthrough field). */
interface LinhaLi {
  readonly numero: unknown;
  readonly data_modificacao?: unknown;
  readonly [campo: string]: unknown;
}

function linha(numero: unknown, dataModificacao: unknown): LinhaLi {
  return {
    numero,
    data_modificacao: dataModificacao,
    resource_uri: `/api/v1/pedido/${String(numero)}`,
  };
}

/** The public document's two example rows, verbatim stamps. */
const EXEMPLO_164 = linha(164, '2022-10-31T12:17:58.949670');
const EXEMPLO_165 = linha(165, '2022-10-31T12:28:12.653648');

interface RespostaLi {
  readonly status: number;
  readonly corpo: unknown;
}

/**
 * Loja Integrada's paging over `paginas`, served by the requested `offset`:
 * `meta.next` in the document's `/api/v1` form, WITHOUT the date filter (the
 * client must re-add it). `total` omitted = the row count; `null` = no
 * `total_count` key at all; a string is sent as is (the provider's empty `''`,
 * or a near-miss).
 */
function paginado(
  paginas: readonly (readonly LinhaLi[])[],
  opts: { readonly limit?: number; readonly total?: number | string | null } = {},
): (url: URL) => RespostaLi {
  const limit = opts.limit ?? 15;
  const total = opts.total === undefined ? paginas.flat().length : opts.total;
  return (url) => {
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const i = Math.floor(offset / limit);
    const ultima = i >= paginas.length - 1;
    const meta: Record<string, unknown> = {
      limit,
      offset,
      previous: null,
      next: ultima
        ? null
        : `/api/v1/pedido/search/?limit=${String(limit)}&offset=${String(offset + limit)}`,
    };
    if (total !== null) meta.total_count = total;
    return { status: 200, corpo: { meta, objects: paginas[i] ?? [] } };
  };
}

const vazio = paginado([[]]);

/** One harness per test: the fake, the clock, the scripted platform, the queue and the log. */
function montar() {
  const fake = new FakeDb();
  let agora = AGORA_MS;
  let execucoes = 0;
  const h = {
    fake,
    agora: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    },
    /** Every Loja Integrada request the fake platform answered, in order. */
    urls: [] as string[],
    /** The Authorization header of each request (to tell contas apart). */
    autorizacoes: [] as string[],
    responder: vazio as (url: URL) => RespostaLi | Promise<RespostaLi>,
    latenciaMs: 0,
    custoDoEnfileiramentoMs: 0,
    enfileirados: [] as PayloadNotificacaoLi[],
    falhaDoEnfileiramento: null as ((p: PayloadNotificacaoLi) => Promise<void>) | null,
    esperas: [] as number[],
    gravador: gravadorDeLog(),
    avisosDoLogger: loggerEspiao(),
    deps(over: Partial<DepsPollLi> = {}): DepsPollLi {
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        h.urls.push(String(input));
        h.autorizacoes.push(
          String((init?.headers as Record<string, string> | undefined)?.Authorization),
        );
        const r = await h.responder(url);
        h.avancar(h.latenciaMs);
        return new Response(typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        });
      };
      return {
        ambiente: AMBIENTE_LIGADO,
        importadorPresente: true,
        lookbackHoras: 72,
        agendador: {
          enfileirar: async (p) => {
            h.avancar(h.custoDoEnfileiramentoMs);
            if (h.falhaDoEnfileiramento !== null) return h.falhaDoEnfileiramento(p);
            h.enfileirados.push(p);
          },
        },
        agoraMs: () => agora,
        esperar: (ms) => {
          h.esperas.push(ms);
          h.avancar(ms);
          return Promise.resolve();
        },
        increment,
        gerarExecucaoId: () => {
          execucoes += 1;
          return `exec-${String(execucoes)}`;
        },
        logger: h.avisosDoLogger.logger,
        escrever: h.gravador.escrever,
        fetch,
        ...over,
      };
    },
    tick(over: Partial<DepsPollLi> = {}): Promise<ResultadoTickPollLi> {
      return executarPollPedidosLi(asDb(fake), h.deps(over));
    },
    /** One tick for the one conta, its result. */
    async umTick(over: Partial<DepsPollLi> = {}): Promise<ResultadoContaPollLi> {
      const r = await h.tick(over);
      const conta = r.contas.find((c) => c.integracaoId === ID);
      if (conta === undefined) throw new Error('teste: a conta não rodou');
      return conta;
    },
    poll: (): DocData | undefined => fake.ler(CAMINHO_POLL),
    /** The `evento: 'poll'` lines. */
    linhasDoPoll: (): LinhaGravada[] => h.gravador.linhas.filter((l) => l.campos.evento === 'poll'),
  };
  return h;
}

type Harness = ReturnType<typeof montar>;

/** A stored poll document, as the poller leaves one. */
function seedPoll(h: Harness, over: DocData = {}, caminho = CAMINHO_POLL): void {
  h.fake.seed(caminho, {
    cursor: CURSOR,
    emExecucaoAteMs: 0,
    execucaoId: null,
    ultimaVarreduraEmMs: null,
    ultimoErro: null,
    falhasSeguidas: 0,
    vistos: {},
    ...over,
  });
}

/** An active conta with a valid credential — and, unless `cursorless`, a stored cursor. */
function contaPronta(h: Harness, opts: { readonly cursorless?: boolean } = {}): void {
  seedConta(h.fake, ID);
  seedCredencial(h.fake, ID);
  if (opts.cursorless !== true) seedPoll(h);
}

function payload(numero: string, dataModificacaoLi: string | null): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: ID,
    numero,
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi,
  };
}

/** The aviso row of this conta's import-stopped tipo. */
function avisoImportacao(h: Harness): DocData | undefined {
  return h.fake.ler(caminhoAviso(chaveImportacaoParada(ID)));
}

const chamadasDeRede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                                  The gates                                 */
/* -------------------------------------------------------------------------- */

describe('the gates: ZERO reads before them', () => {
  it('no importer in the seam → one INFO line and nothing else at all', async () => {
    const h = montar();
    contaPronta(h);

    const r = await h.tick({ importadorPresente: false });

    expect(r).toEqual({ portao: 'importador-ausente', contas: [] });
    expect(h.fake.leituras).toEqual([]);
    expect(h.fake.consultas).toEqual([]);
    expect(h.fake.escritas).toEqual([]);
    expect(h.urls).toEqual([]);
    expect(h.gravador.linhas).toHaveLength(1);
    expect(h.gravador.linhas[0]).toMatchObject({
      severidade: 'INFO',
      campos: { evento: 'poll', conta: null, fluxo: 'poll', desfecho: 'importador-ausente' },
    });
  });

  it('BOTH gates closed → the importer gate answers first: its INFO line, never a chamada-bloqueada one', async () => {
    // The header's order (1, then 2): with no importer the switch is never
    // consulted, so the tick names the gate that would still stop it once the
    // window sets the switch.
    const h = montar();
    contaPronta(h);

    const r = await h.tick({ importadorPresente: false, ambiente: {} });

    expect(r).toEqual({ portao: 'importador-ausente', contas: [] });
    expect(h.fake.leituras).toEqual([]);
    expect(h.fake.consultas).toEqual([]);
    expect(h.fake.escritas).toEqual([]);
    expect(h.urls).toEqual([]);
    expect(h.gravador.linhas).toHaveLength(1);
    expect(h.gravador.linhas[0]).toMatchObject({
      severidade: 'INFO',
      campos: { evento: 'poll', conta: null, fluxo: 'poll', desfecho: 'importador-ausente' },
    });
  });

  it.each([
    ['on␠', 'on '],
    ['ON', 'ON'],
    ['true', 'true'],
    ['blank', ''],
    ['unset', undefined],
  ])('the read switch %s → one chamada-bloqueada line, zero reads', async (_nome, valor) => {
    const h = montar();
    contaPronta(h);

    const r = await h.tick({
      ambiente: valor === undefined ? {} : { [CHAMADAS_ENV_LI]: valor },
    });

    expect(r.portao).toBe('chamadas-desligadas');
    expect(h.fake.leituras).toEqual([]);
    expect(h.fake.consultas).toEqual([]);
    expect(h.fake.escritas).toEqual([]);
    expect(h.urls).toEqual([]);
    expect(h.gravador.linhas).toHaveLength(1);
    expect(h.gravador.linhas[0]?.campos).toMatchObject({
      evento: 'chamada-bloqueada',
      conta: null,
      fluxo: 'poll',
      operacao: 'pollPedidos',
    });
  });

  it('an inactive conta is skipped in code — no call, no write, no line — and the active one beside it runs', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-inativa', { nome: 'A inativa', ativo: false });
    seedCredencial(h.fake, 'conta-inativa');
    contaPronta(h);

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho])).toEqual([
      ['conta-inativa', 'inativa'],
      [ID, 'janela-vazia'],
    ]);
    expect(h.fake.ler('pollPedidosLojaIntegrada/conta-inativa')).toBeUndefined();
    expect(h.fake.escritas.some((e) => e.caminho.includes('conta-inativa'))).toBe(false);
    expect(h.urls).toHaveLength(1);
    expect(h.linhasDoPoll().map((l) => l.campos.conta)).toEqual([ID]);
  });

  it('an inactive conta costs no READ either: it is dropped from the list before any context is loaded', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-inativa', { nome: 'A inativa', ativo: false });
    seedCredencial(h.fake, 'conta-inativa');
    contaPronta(h);

    await h.tick();

    // The context would refuse it too, but only after reading it — every tick.
    expect(h.fake.leituras.filter((p) => p.includes('conta-inativa'))).toEqual([]);
  });

  it('a conta run checks the switch AGAIN itself (defence in depth): off → chamadas-desligadas, zero reads, nothing written', async () => {
    const h = montar();
    contaPronta(h);

    const r = await executarContaPollLi(
      asDb(h.fake),
      { integracaoId: ID, nome: `Loja ${ID}`, ativo: true },
      ORCAMENTO_CONTA_MS,
      h.deps({ ambiente: {} }),
    );

    expect(r).toMatchObject({ desfecho: 'chamadas-desligadas', motivo: null });
    expect(h.fake.leituras).toEqual([]);
    expect(h.fake.escritas).toEqual([]);
    expect(h.urls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        The wire (the document's example)                    */
/* -------------------------------------------------------------------------- */

describe('the wire, from the public example', () => {
  it('the exact first URL, both rows enqueued, the cursor on their max floored to the second', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { cursor: '2022-10-31T12:00:00' });
    h.responder = paginado([[EXEMPLO_164, EXEMPLO_165]], { limit: 15 });

    const r = await h.umTick();

    // `%3A`: the client always encodes it; `limit=50` is what is REQUESTED.
    expect(h.urls).toEqual([
      'https://api.awsli.com.br/v1/pedido/search/?since_atualizado=2022-10-31T07%3A58%3A00&limit=50',
    ]);
    expect(h.enfileirados).toEqual([
      payload('164', '2022-10-31T12:17:58.949670'),
      payload('165', '2022-10-31T12:28:12.653648'),
    ]);
    expect(r).toMatchObject({ desfecho: 'sucesso', enfileiradas: 2, cursorAvancou: true });
    expect(h.poll()).toMatchObject({
      cursor: '2022-10-31T12:28:12',
      vistos: { '164': '2022-10-31T12:17:58.949670', '165': '2022-10-31T12:28:12.653648' },
      emExecucaoAteMs: 0,
      execucaoId: null,
      falhasSeguidas: 0,
      ultimoErro: null,
    });
    expect(h.poll()?.vistos).toEqual({
      '164': '2022-10-31T12:17:58.949670',
      '165': '2022-10-31T12:28:12.653648',
    });
  });

  it('meta.next is rebuilt against the slash path and the dropped filter re-added', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { cursor: '2022-10-31T12:00:00' });
    h.responder = paginado([[EXEMPLO_164], [EXEMPLO_165]], { limit: 1 });

    await h.umTick();

    expect(h.urls).toEqual([
      'https://api.awsli.com.br/v1/pedido/search/?since_atualizado=2022-10-31T07%3A58%3A00&limit=50',
      'https://api.awsli.com.br/v1/pedido/search/?limit=1&offset=1&since_atualizado=2022-10-31T07%3A58%3A00',
    ]);
    expect(h.enfileirados.map((p) => p.numero)).toEqual(['164', '165']);
  });

  it('every call is paced: one 2 000 ms wait before each request', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { cursor: '2022-10-31T12:00:00' });
    h.responder = paginado([[EXEMPLO_164], [EXEMPLO_165]], { limit: 1 });

    await h.umTick();

    expect(h.esperas).toEqual([2000, 2000]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The cursor                                */
/* -------------------------------------------------------------------------- */

describe('the cursor', () => {
  it.each([
    ['DELETED (what the runbook prescribes)', 'apagado'],
    ['set to the null type', 'nulo'],
  ] as const)(
    'the re-bootstrap runbook (DEPLOY.md): a cursor field %s is re-anchored by the lease, and the stored count resolves the aviso',
    async (_nome, como) => {
      const h = montar();
      contaPronta(h);
      // The open row the refusals left, and the document with its cursor removed by hand.
      await avisarImportacaoParada(
        asDb(h.fake),
        {
          integracaoId: ID,
          lojaNome: 'Loja',
          motivo: MOTIVO_IMPORTACAO_PARADA_LI.janelaGrandeDemais,
          relogioUs: 1,
        },
        { increment, nowMs: AGORA_MS },
      );
      const editado: DocData = {
        emExecucaoAteMs: 0,
        execucaoId: null,
        ultimaVarreduraEmMs: null,
        falhasSeguidas: 4,
        ultimoErro: 'janela-grande-demais',
        vistos: { '1': '2026-11-01T10:00:00.000000' },
      };
      h.fake.seed(CAMINHO_POLL, como === 'apagado' ? editado : { ...editado, cursor: null });

      const r = await h.umTick();

      expect(r.desfecho).toBe('janela-vazia');
      expect(h.poll()).toMatchObject({
        cursor: BOOTSTRAP_72H,
        falhasSeguidas: 0,
        ultimoErro: null,
        // The old entry is far below the new window: pruned.
        vistos: {},
      });
      expect(h.poll()?.vistos).toEqual({});
      expect(avisoImportacao(h)).toMatchObject({ resolucaoMotivo: 'importacao-retomada' });
      expect(avisoImportacao(h)?.resolvidoEm).not.toBeNull();
    },
  );

  it('the bootstrap is rendered in São Paulo time and ANCHORED by the first lease: a failing run never slides it', async () => {
    const h = montar();
    contaPronta(h, { cursorless: true });
    h.responder = () => ({ status: 503, corpo: 'indisponivel' });

    await h.umTick();
    // The lease wrote the bound; the failure kept it.
    expect(h.poll()).toMatchObject({ cursor: BOOTSTRAP_72H, falhasSeguidas: 1 });
    expect(h.urls[0]).toContain('since_atualizado=2027-01-12T07%3A58%3A00');

    h.avancar(6 * 60 * 60 * 1000);
    h.responder = vazio;
    await h.umTick();

    // Six hours later the window still starts at the SAME bound.
    expect(h.urls[1]).toContain('since_atualizado=2027-01-12T07%3A58%3A00');
    expect(h.poll()).toMatchObject({ cursor: BOOTSTRAP_72H, falhasSeguidas: 0 });
  });

  it('a refusal record’s cursorless document is anchored by its FIRST lease, even when that run fails', async () => {
    const h = montar();
    contaPronta(h, { cursorless: true });
    seedPoll(h, { cursor: null, falhasSeguidas: 1, ultimoErro: 'credencial-ausente' });
    h.responder = () => ({ status: 503, corpo: 'indisponivel' });

    await h.umTick();
    expect(h.poll()).toMatchObject({ cursor: BOOTSTRAP_72H, falhasSeguidas: 2 });

    h.avancar(6 * 60 * 60 * 1000);
    await h.umTick();
    // Six hours later the window still starts at the anchored bound.
    expect(h.urls[1]).toContain('since_atualizado=2027-01-12T07%3A58%3A00');
  });

  it('near-miss: the bootstrap is NOT the UTC rendering of the same instant', async () => {
    const h = montar();
    contaPronta(h, { cursorless: true });

    await h.umTick();

    expect(h.poll()?.cursor).toBe(BOOTSTRAP_72H);
    expect(h.poll()?.cursor).not.toBe('2027-01-12T15:00:00');
  });

  it('an empty window keeps the cursor and counts as a success', async () => {
    const h = montar();
    contaPronta(h);

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'janela-vazia', cursorAvancou: false });
    // The window starts 4 h 02 min before the stored cursor.
    expect(h.urls).toEqual([
      `https://api.awsli.com.br/v1/pedido/search/?since_atualizado=${SINCE.replaceAll(':', '%3A')}&limit=50`,
    ]);
    // One pacer wait (2 s) went by before the run finished.
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 0,
      ultimaVarreduraEmMs: AGORA_MS + 2_000,
    });
  });

  it('never moves backwards: rows older than the stored cursor leave it where it is', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T07:00:00.000000')]]);

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'sucesso', cursorAvancou: false });
    expect(h.poll()?.cursor).toBe(CURSOR);
  });

  // The decision is taken one pacer wait (2 s) after AGORA_MS: the ceiling is
  // then 15:00:02 + 10 min, in UTC.
  it('a stamp past now + 10 min (UTC) is clamped to that ceiling, with one carimbo-no-futuro line', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T15:10:03.000000')]]);

    await h.umTick();

    expect(h.poll()?.cursor).toBe('2027-01-15T15:10:02');
    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'carimbo-no-futuro')).toHaveLength(1);
  });

  it('near-miss: a stamp exactly at the ceiling is not clamped and logs nothing', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T15:10:02.000000')]]);

    await h.umTick();

    expect(h.poll()?.cursor).toBe('2027-01-15T15:10:02');
    expect(h.linhasDoPoll().some((l) => l.campos.alerta === 'carimbo-no-futuro')).toBe(false);
  });

  it('a stamp later than now in São Paulo logs zona-suspeita ONCE per run (WARNING), and the run still advances', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([
      [
        linha(1001, '2027-01-15T12:30:00.000000'),
        linha(1002, '2027-01-15T13:00:00.000000'),
        linha(1003, '2027-01-15T11:00:00.000000'),
      ],
    ]);

    const r = await h.umTick();

    const zona = h.linhasDoPoll().filter((l) => l.campos.alerta === 'zona-suspeita');
    expect(zona).toHaveLength(1);
    expect(zona[0]?.severidade).toBe('WARNING');
    expect(r.desfecho).toBe('sucesso');
    expect(h.poll()?.cursor).toBe('2027-01-15T13:00:00');
  });

  // The page arrives one pacer wait after AGORA_MS: 12:00:02 in São Paulo, so
  // the bound is 12:10:02 (FOLGA_RELOGIO_S, the ceiling's own slack).
  it('a change made AFTER the drain started is not suspect: up to the page’s arrival + 10 min (São Paulo) is not flagged', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([
      [linha(1001, '2027-01-15T12:00:01.000000'), linha(1002, '2027-01-15T12:10:02.000000')],
    ]);

    await h.umTick();

    expect(h.linhasDoPoll().some((l) => l.campos.alerta === 'zona-suspeita')).toBe(false);
  });

  it('near-miss: 1 µs past the page’s arrival + 10 min is suspect', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T12:10:02.000001')]]);

    await h.umTick();

    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'zona-suspeita')).toHaveLength(1);
  });

  it('the zone flag reads the clock when EACH page arrives, never once before the drain', async () => {
    const h = montar();
    contaPronta(h);
    h.latenciaMs = 30_000;
    // Page 2 arrives at AGORA_MS + 2 × (2 s + 30 s) = 12:01:04 in São Paulo: its
    // row is past the drain's START + 10 min (12:10:00), not past ITS page's.
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T12:10:30')]],
      { limit: 1 },
    );

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.linhasDoPoll().some((l) => l.campos.alerta === 'zona-suspeita')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                Dedup: vistos                               */
/* -------------------------------------------------------------------------- */

describe('dedup through vistos', () => {
  it('a row re-listed by the overlap with the SAME stamp is not re-enqueued; 1 µs newer is', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00.123456')]]);
    await h.umTick();
    expect(h.enfileirados).toHaveLength(1);

    // The next tick re-lists it (the overlap): nothing new.
    h.avancar(300_000);
    await h.umTick();
    expect(h.enfileirados).toHaveLength(1);

    // NEAR-MISS: the same order, changed one microsecond later.
    h.avancar(300_000);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00.123457')]]);
    await h.umTick();
    expect(h.enfileirados.map((p) => p.dataModificacaoLi)).toEqual([
      '2027-01-15T10:30:00.123456',
      '2027-01-15T10:30:00.123457',
    ]);
    expect(h.poll()?.vistos).toEqual({ '1001': '2027-01-15T10:30:00.123457' });
  });

  it('the same numero on two pages (offset paging under an edit) is enqueued once', async () => {
    const h = montar();
    contaPronta(h);
    const r1 = linha(1001, '2027-01-15T10:30:00.000000');
    h.responder = paginado([[r1, linha(1002, '2027-01-15T10:31:00.000000')], [r1]], {
      limit: 2,
      total: 2,
    });

    await h.umTick();

    expect(h.enfileirados.map((p) => p.numero)).toEqual(['1001', '1002']);
  });

  it('after a zone mismatch, a row 3 h below the window start is still recognised — and kept by the prune', async () => {
    const h = montar();
    contaPronta(h);
    // SINCE − 3 h: inside the tolerance (4 h 10 min), already enqueued.
    const tresHorasAbaixo = '2027-01-15T02:58:00.000000';
    seedPoll(h, { vistos: { '1001': tresHorasAbaixo } });
    h.responder = paginado([[linha(1001, tresHorasAbaixo)]]);

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.enfileirados).toEqual([]);
    expect(h.poll()?.vistos).toEqual({ '1001': tresHorasAbaixo });
  });

  it('the prune drops an entry 1 s below the tolerance floor and keeps one exactly at it', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, {
      vistos: {
        '1': `${TOLERANCIA}.000000`,
        '2': '2027-01-15T01:47:59.999999',
        '3': MARCA_DATA_ILEGIVEL_LI,
      },
    });

    await h.umTick();

    // The unreadable marker is never pruned by the bound.
    expect(h.poll()?.vistos).toEqual({ '1': `${TOLERANCIA}.000000`, '3': MARCA_DATA_ILEGIVEL_LI });
  });

  it('an unreadable stamp is enqueued ONCE (stamp null, marker recorded), blocks the advance and counts formato-de-data', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '31/10/2022 12:17'), linha(1002, '2027-01-15T10:30:00')]]);

    const r1 = await h.umTick();

    expect(h.enfileirados).toEqual([
      payload('1001', null),
      payload('1002', '2027-01-15T10:30:00.000000'),
    ]);
    expect(r1).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_LI.formatoDeData,
    });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'formato-de-data',
      vistos: { '1001': MARCA_DATA_ILEGIVEL_LI, '1002': '2027-01-15T10:30:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({
      '1001': MARCA_DATA_ILEGIVEL_LI,
      '1002': '2027-01-15T10:30:00.000000',
    });

    h.avancar(300_000);
    await h.umTick();
    // Not re-enqueued on the next tick.
    expect(h.enfileirados).toHaveLength(2);
    expect(h.poll()?.falhasSeguidas).toBe(2);
  });

  it('a row whose numero is not a positive integer is never enqueued; the others are, and the run counts resposta-invalida', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(0, '2027-01-15T10:30:00'), linha(1002, '2027-01-15T10:31:00')]]);

    const r = await h.umTick();

    expect(h.enfileirados.map((p) => p.numero)).toEqual(['1002']);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'resposta-invalida' });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      vistos: { '1002': '2027-01-15T10:31:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({ '1002': '2027-01-15T10:31:00.000000' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                The fail-safes                              */
/* -------------------------------------------------------------------------- */

describe('the fail-safes', () => {
  it('filtro-ignorado: a row below the tolerance floor stops the run before ANY row of its page is enqueued; aviso at once', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado(
      [
        [linha(1001, '2027-01-15T10:30:00')],
        [linha(1002, '2027-01-15T10:31:00'), linha(1003, '2027-01-15T01:47:59.999999')],
      ],
      { limit: 1, total: 3 },
    );

    const r = await h.umTick();

    // Page 1 went out; page 2 was refused WHOLE.
    expect(h.enfileirados.map((p) => p.numero)).toEqual(['1001']);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'filtro-ignorado' });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'filtro-ignorado',
      vistos: { '1001': '2027-01-15T10:30:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({ '1001': '2027-01-15T10:30:00.000000' });
    expect(avisoImportacao(h)).toMatchObject({
      resolvidoEm: null,
      params: { motivo: 'filtro-ignorado' },
    });
  });

  it('near-miss: a row exactly AT the tolerance floor is legitimate', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, `${TOLERANCIA}.000000`)]]);

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.enfileirados).toHaveLength(1);
  });

  it('janela-grande-demais: page 1 announcing more than meta.limit × 20 is refused before draining; aviso at once', async () => {
    const h = montar();
    contaPronta(h);
    const linhas = Array.from({ length: 41 }, (_, i) => linha(2000 + i, '2027-01-15T10:30:00'));
    const paginas = Array.from({ length: 21 }, (_, i) => linhas.slice(i * 2, i * 2 + 2));
    h.responder = paginado(paginas, { limit: 2, total: 41 });

    const r = await h.umTick();

    expect(h.urls).toHaveLength(1);
    expect(h.enfileirados).toEqual([]);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'janela-grande-demais', paginas: 1 });
    expect(avisoImportacao(h)).toMatchObject({ params: { motivo: 'janela-grande-demais' } });
  });

  it('an IGNORED filter is filtro-ignorado even when page 1’s total_count (then the whole history) is past the cap', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00'), linha(1002, '2026-03-01T08:00:00')]],
      { limit: 2, total: 5_000 },
    );

    const r = await h.umTick();

    expect(h.urls).toHaveLength(1);
    expect(h.enfileirados).toEqual([]);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'filtro-ignorado', paginas: 1 });
    expect(h.poll()).toMatchObject({ cursor: CURSOR, ultimoErro: 'filtro-ignorado' });
    expect(avisoImportacao(h)).toMatchObject({ params: { motivo: 'filtro-ignorado' } });
  });

  it('near-miss: total == meta.limit (AS READ BACK) × 20 drains whole and advances', async () => {
    const h = montar();
    contaPronta(h);
    const linhas = Array.from({ length: 40 }, (_, i) => linha(2000 + i, '2027-01-15T10:30:00'));
    const paginas = Array.from({ length: 20 }, (_, i) => linhas.slice(i * 2, i * 2 + 2));
    h.responder = paginado(paginas, { limit: 2, total: 40 });

    const r = await h.umTick();

    expect(h.urls).toHaveLength(MAX_PAGINAS_POLL);
    expect(h.enfileirados).toHaveLength(40);
    expect(r).toMatchObject({ desfecho: 'sucesso', paginas: 20, cursorAvancou: true });
  });

  it('the page cap: with no total_count, a 21st page counts limite-de-paginas (the 20 read are kept)', async () => {
    const h = montar();
    contaPronta(h);
    const paginas = Array.from({ length: 21 }, (_, i) => [linha(3000 + i, '2027-01-15T10:30:00')]);
    h.responder = paginado(paginas, { limit: 1, total: null });

    const r = await h.umTick();

    expect(h.urls).toHaveLength(MAX_PAGINAS_POLL);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'limite-de-paginas' });
    expect(Object.keys(h.poll()?.vistos as object)).toHaveLength(20);
    expect(h.poll()?.cursor).toBe(CURSOR);
  });

  it('janela-instavel: fewer distinct rows than the largest total_count → no advance, vistos merged', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00'), linha(1002, '2027-01-15T10:31:00')]],
      {
        total: 3,
      },
    );

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'janela-instavel', enfileiradas: 2 });
    expect(h.poll()).toMatchObject({ cursor: CURSOR, falhasSeguidas: 1 });
    expect(Object.keys(h.poll()?.vistos as object)).toEqual(['1001', '1002']);
  });

  it('a total_count that grows past the cap AFTER page 1 is janela-instavel (it may heal), never janela-grande-demais', async () => {
    const h = montar();
    contaPronta(h);
    const linhas = [1001, 1002, 1003, 1004].map((n, i) =>
      linha(n, `2027-01-15T10:3${String(i)}:00`),
    );
    h.responder = (url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const meta = {
        limit: 2,
        offset,
        previous: null,
        next: offset === 0 ? '/api/v1/pedido/search/?limit=2&offset=2' : null,
        // Page 1 announces a window that fits; page 2, one row past the cap (limit × 20).
        total_count: offset === 0 ? 4 : 2 * MAX_PAGINAS_POLL + 1,
      };
      return { status: 200, corpo: { meta, objects: linhas.slice(offset, offset + 2) } };
    };

    const r = await h.umTick();

    // Page 2 was drained, not refused: the size check belongs to page 1 only.
    expect(h.enfileirados.map((p) => p.numero)).toEqual(['1001', '1002', '1003', '1004']);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'janela-instavel', paginas: 2 });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'janela-instavel',
    });
    // Counted at 3, unlike janela-grande-demais, raised at once.
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it.each([
    [
      'an invalid numero outranks an unreadable stamp and an unstable window',
      [linha(0, '2027-01-15T10:30:00'), linha(1001, '31/10/2022 12:17')],
      MOTIVO_IMPORTACAO_PARADA_LI.respostaInvalida,
    ],
    [
      'an unreadable stamp outranks an unstable window',
      [linha(1001, '31/10/2022 12:17'), linha(1002, '2027-01-15T10:31:00')],
      MOTIVO_IMPORTACAO_PARADA_LI.formatoDeData,
    ],
  ])('the motivo after a complete drain: %s', async (_n, linhas, motivo) => {
    const h = montar();
    contaPronta(h);
    // One row more announced than listed: the window is ALSO unstable.
    h.responder = paginado([linhas], { total: 3 });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo });
    expect(h.poll()).toMatchObject({ cursor: CURSOR, falhasSeguidas: 1, ultimoErro: motivo });
  });

  it('no total_count on any page: the check is skipped and logged, and the run advances', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]], { total: null });

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'sem-total')).toHaveLength(1);
  });

  it("an EMPTY total_count ('') is no total: the row is enqueued, the check skipped, the run advances", async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]], { total: '' });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'sucesso', cursorAvancou: true });
    expect(h.enfileirados).toHaveLength(1);
    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'sem-total')).toHaveLength(1);
  });

  it("near-miss: a total_count that is not one integer ('abc') is resposta-invalida and keeps the cursor", async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]], { total: 'abc' });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'resposta-invalida' });
    expect(h.enfileirados).toHaveLength(0);
    expect(h.poll()).toMatchObject({ cursor: CURSOR, falhasSeguidas: 1 });
  });

  it('paginacao-invalida: a next offset that does not advance', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({
      status: 200,
      corpo: {
        meta: {
          limit: 1,
          offset: 0,
          previous: null,
          next: '/api/v1/pedido/search/?offset=0',
          total_count: 2,
        },
        objects: [linha(1001, '2027-01-15T10:30:00')],
      },
    });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'paginacao-invalida' });
  });

  it('resposta-invalida: a body that is not the paging envelope', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({ status: 200, corpo: { objects: 'nada' } });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'resposta-invalida' });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'resposta-invalida',
    });
  });

  it.each([
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
    [400, 'Bad Request'],
  ])('a %s counts falha-transitoria and keeps the cursor', async (status, corpo) => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({ status, corpo });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'falha-transitoria' });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'falha-transitoria',
      emExecucaoAteMs: 0,
      execucaoId: null,
    });
  });

  it('a 401 mid-drain PARKS the conta: conta-parada, cursor and counter untouched, the run’s additions dropped', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, {
      vistos: { '900': '2027-01-15T09:00:00.000000' },
      falhasSeguidas: 1,
      ultimoErro: 'falha-transitoria',
    });
    let pedidos = 0;
    const pagina1 = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      {
        limit: 1,
      },
    );
    h.responder = (url) => {
      pedidos += 1;
      return pedidos === 1 ? pagina1(url) : { status: 401, corpo: '{"error":"Unauthorized"}' };
    };

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'conta-parada', enfileiradas: 1 });
    // The park and its own aviso — not the import-stopped one.
    expect(h.fake.ler(caminhoCredencial(ID))?.reconexaoPendente).toMatchObject({ status: 401 });
    expect(h.fake.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({ resolvidoEm: null });
    expect(avisoImportacao(h)).toBeUndefined();
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'falha-transitoria',
      vistos: { '900': '2027-01-15T09:00:00.000000' },
      emExecucaoAteMs: 0,
      execucaoId: null,
    });
    expect(h.poll()?.vistos).toEqual({ '900': '2027-01-15T09:00:00.000000' });

    // While parked: the context refuses, nothing written.
    h.avancar(300_000);
    const parada = await h.umTick();
    expect(parada.desfecho).toBe('conta-parada');

    // A token save: the next tick re-enqueues what the parked run had enqueued.
    seedCredencial(h.fake, ID, { personalToken: TOKEN_B });
    h.avancar(300_000);
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      {
        limit: 1,
      },
    );
    const depois = await h.umTick();
    expect(depois.desfecho).toBe('sucesso');
    expect(h.enfileirados.map((p) => p.numero)).toEqual(['1001', '1001', '1002']);
  });

  it('a conta parked by ANOTHER run mid-drain (the getter re-reads the credential) is conta-parada too', async () => {
    const h = montar();
    contaPronta(h);
    const paginas = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      { limit: 1 },
    );
    h.responder = (url) => {
      // After page 1 is answered, another task parks the conta.
      seedCredencial(h.fake, ID, {
        reconexaoPendente: { desdeMs: AGORA_MS, status: 403, refCredencial: 'ref-de-outra-tarefa' },
      });
      return paginas(url);
    };

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'conta-parada', enfileiradas: 1 });
    expect(h.urls).toHaveLength(1);
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      vistos: {},
      falhasSeguidas: 0,
      execucaoId: null,
    });
    expect(h.poll()?.vistos).toEqual({});
  });

  it('a NETWORK failure (the fetch rejects with a TypeError → LiNetworkError) counts falha-transitoria, and the next conta still runs', async () => {
    const h = montar();
    contaPronta(h);
    seedConta(h.fake, 'conta-z', { nome: 'Z' });
    seedCredencial(h.fake, 'conta-z');
    h.responder = (url) => {
      // The first request is this conta's; conta-z's comes after it.
      if (h.urls.length === 1) throw new TypeError('fetch failed');
      return vazio(url);
    };

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho, c.motivo])).toEqual([
      [ID, 'falha', 'falha-transitoria'],
      ['conta-z', 'janela-vazia', null],
    ]);
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'falha-transitoria',
      emExecucaoAteMs: 0,
      execucaoId: null,
    });
  });

  it.each([
    [
      'removed (LiCredencialAusenteError)',
      async (h: Harness): Promise<void> => {
        await docCredencial(asDb(h.fake), ID).delete();
      },
    ],
    [
      'corrupted (LiCredencialInvalidaError)',
      (h: Harness): Promise<void> => {
        h.fake.seed(caminhoCredencial(ID), { personalToken: 42 });
        return Promise.resolve();
      },
    ],
  ])(
    'a credential %s mid-drain (the getter re-reads it) is conta-parada: stored vistos kept, counter untouched',
    async (_nome, estragar) => {
      const h = montar();
      contaPronta(h);
      seedPoll(h, {
        vistos: { '900': '2027-01-15T09:00:00.000000' },
        falhasSeguidas: 1,
        ultimoErro: 'falha-transitoria',
      });
      const paginas = paginado(
        [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
        { limit: 1 },
      );
      h.responder = async (url) => {
        // After page 1 is answered, the credential goes; the getter of page 2 finds it.
        await estragar(h);
        return paginas(url);
      };

      const r = await h.umTick();

      expect(r).toMatchObject({ desfecho: 'conta-parada', enfileiradas: 1 });
      expect(h.urls).toHaveLength(1);
      expect(h.poll()).toMatchObject({
        cursor: CURSOR,
        falhasSeguidas: 1,
        ultimoErro: 'falha-transitoria',
        execucaoId: null,
      });
      expect(h.poll()?.vistos).toEqual({ '900': '2027-01-15T09:00:00.000000' });
      expect(avisoImportacao(h)).toBeUndefined();
    },
  );

  it('a 401 whose PARK finds the credential corrupt (LiCredencialInvalidaError) is conta-parada, nothing counted', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { vistos: { '900': '2027-01-15T09:00:00.000000' } });
    h.responder = () => {
      // Between the getter's read and the park's: the credential is corrupted.
      h.fake.seed(caminhoCredencial(ID), { personalToken: 42 });
      return { status: 401, corpo: '{"error":"Unauthorized"}' };
    };

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'conta-parada' });
    expect(h.poll()).toMatchObject({ falhasSeguidas: 0, ultimoErro: null, execucaoId: null });
    expect(h.poll()?.vistos).toEqual({ '900': '2027-01-15T09:00:00.000000' });
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it('a conta DELETED after the list was read (while an earlier conta drained) is conta-inexistente: nothing written', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-a', { nome: 'A' });
    seedCredencial(h.fake, 'conta-a');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-a');
    seedConta(h.fake, 'conta-b', { nome: 'B' });
    seedCredencial(h.fake, 'conta-b');
    seedPoll(h, { falhasSeguidas: 2 }, 'pollPedidosLojaIntegrada/conta-b');
    h.responder = async (url) => {
      await integracaoCollection.docRef(asDb(h.fake), {}, 'conta-b').delete();
      return vazio(url);
    };

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho])).toEqual([
      ['conta-a', 'janela-vazia'],
      ['conta-b', 'conta-inexistente'],
    ]);
    expect(h.urls).toHaveLength(1);
    expect(h.fake.escritasEm('pollPedidosLojaIntegrada/conta-b')).toEqual([]);
    expect(h.fake.ler('pollPedidosLojaIntegrada/conta-b')).toMatchObject({ falhasSeguidas: 2 });
  });

  it('a poll document a hand edit broke (the TEXT "null" as cursor) costs only its own conta: documento-invalido, nothing written, the next conta runs', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { cursor: 'null', falhasSeguidas: 1 });
    seedConta(h.fake, 'conta-z', { nome: 'Z' });
    seedCredencial(h.fake, 'conta-z');

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho])).toEqual([
      [ID, 'documento-invalido'],
      ['conta-z', 'janela-vazia'],
    ]);
    expect(h.fake.escritasEm(CAMINHO_POLL)).toEqual([]);
    expect(h.urls).toHaveLength(1);
    // The field NAME only, never its value.
    expect(h.linhasDoPoll().find((l) => l.campos.alerta === 'documento-invalido')).toMatchObject({
      severidade: 'WARNING',
      campos: { conta: ID, campos: 'cursor' },
    });
    expect(h.linhasDoPoll().find((l) => l.campos.desfecho === 'documento-invalido')).toMatchObject({
      severidade: 'WARNING',
      campos: { conta: ID },
    });
  });

  it('the refusal record reads the same document: a malformed one is documento-invalido there too, never a failed tick', async () => {
    const h = montar();
    seedConta(h.fake, ID);
    seedPoll(h, { vistos: { '1': 'ontem' } });

    const r = await h.umTick();

    expect(r.desfecho).toBe('documento-invalido');
    expect(h.fake.escritasEm(CAMINHO_POLL)).toEqual([]);
    expect(
      h.linhasDoPoll().find((l) => l.campos.alerta === 'documento-invalido')?.campos.campos,
    ).toBe('vistos');
  });

  it('a park that keeps losing its precondition (LiEstacionamentoEmConflitoError) counts falha-transitoria', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({ status: 401, corpo: '{"error":"Unauthorized"}' });
    // Every one of the park's attempts meets a concurrent write of the credential.
    for (let i = 0; i < 3; i += 1) {
      h.fake.antesDaProximaEscrita(caminhoCredencial(ID), () => {
        seedCredencial(h.fake, ID);
      });
    }

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'falha-transitoria' });
    expect(h.fake.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
    expect(h.poll()).toMatchObject({ falhasSeguidas: 1, ultimoErro: 'falha-transitoria' });
  });

  it('our own misconfiguration (LiConfigError) is RETHROWN, never counted as a platform failure', async () => {
    const h = montar();
    contaPronta(h);
    // A token the client refuses to send (a space in it): `LiConfigError('token')`.
    seedCredencial(h.fake, ID, { personalToken: 'token com espaco' });

    await expect(h.tick()).rejects.toBeInstanceOf(LiConfigError);

    expect(h.urls).toEqual([]);
    expect(h.poll()).toMatchObject({ falhasSeguidas: 0, ultimoErro: null, execucaoId: 'exec-1' });
  });

  it('anything unknown is RETHROWN: the tick fails, nothing is written, the lease is left to expire', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => {
      throw new RangeError('transporte quebrado');
    };

    await expect(h.tick()).rejects.toBeInstanceOf(RangeError);

    expect(h.poll()).toMatchObject({ cursor: CURSOR, execucaoId: 'exec-1', falhasSeguidas: 0 });
    expect((h.poll()?.emExecucaoAteMs as number) > AGORA_MS).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The budget                                */
/* -------------------------------------------------------------------------- */

describe('the budget', () => {
  it('spent with NO new row → orcamento-esgotado, counted', async () => {
    const h = montar();
    contaPronta(h);
    h.latenciaMs = ORCAMENTO_CONTA_MS;
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      {
        limit: 1,
      },
    );

    // The first answer takes the whole budget: the enqueue checkpoint refuses.
    const r = await h.umTick();

    expect(h.enfileirados).toEqual([]);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'orcamento-esgotado' });
    expect(h.poll()).toMatchObject({ cursor: CURSOR, falhasSeguidas: 1 });
  });

  it('spent AFTER progress → counter unchanged, vistos persisted', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'orcamento-esgotado' });
    h.custoDoEnfileiramentoMs = ORCAMENTO_CONTA_MS;
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      {
        limit: 1,
      },
    );

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'orcamento-com-progresso', enfileiradas: 1 });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 2,
      ultimoErro: 'orcamento-esgotado',
      vistos: { '1001': '2027-01-15T10:30:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({ '1001': '2027-01-15T10:30:00.000000' });
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it('spent after progress that was only PERSISTED (the sweep-only valve) is progress too: counter unchanged', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'orcamento-esgotado' });
    h.falhaDoEnfileiramento = () => Promise.reject(new LiTarefasDesligadasError());
    h.custoDoEnfileiramentoMs = ORCAMENTO_CONTA_MS;
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      { limit: 1 },
    );

    const r = await h.umTick();

    expect(r).toMatchObject({
      desfecho: 'orcamento-com-progresso',
      enfileiradas: 0,
      persistidas: 1,
    });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 2,
      ultimoErro: 'orcamento-esgotado',
    });
    expect(h.poll()?.vistos).toEqual({ '1001': '2027-01-15T10:30:00.000000' });
    expect(avisoImportacao(h)).toBeUndefined();
  });

  // The run's budget starts at AGORA_MS; the 2 s pacer wait plus this answer
  // put the enqueue checkpoint exactly AT the deadline, or 1 ms short of it.
  it.each([
    ['at exactly its deadline the run stops before the enqueue', 0, 'falha', 0],
    ['near-miss: 1 ms before it, the row is enqueued', 1, 'sucesso', 1],
  ])('the budget, %s', async (_n, folgaMs, desfecho, enfileiradas) => {
    const h = montar();
    contaPronta(h);
    h.latenciaMs = ORCAMENTO_CONTA_MS - 2_000 - folgaMs;
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho, enfileiradas });
  });

  it('no call goes out past the deadline: a budget spent DURING a pacer wait stops the run before the next request', async () => {
    const h = montar();
    contaPronta(h);
    // Page 1's row was already seen: no enqueue, so no checkpoint on that page.
    seedPoll(h, { vistos: { '1001': '2027-01-15T10:30:00.000000' } });
    // Page 1 ends 1 s before the deadline (2 s wait + 97 s answer); page 2's 2 s wait crosses it.
    h.latenciaMs = ORCAMENTO_CONTA_MS - 3_000;
    h.responder = paginado(
      [[linha(1001, '2027-01-15T10:30:00')], [linha(1002, '2027-01-15T10:31:00')]],
      { limit: 1 },
    );

    const r = await h.umTick();

    expect(h.esperas).toEqual([2_000, 2_000]);
    expect(h.urls).toHaveLength(1);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'orcamento-esgotado', enfileiradas: 0 });
  });

  it('a conta started late in the tick gets only what the tick has LEFT, never a full conta budget', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-a', { nome: 'A' });
    seedCredencial(h.fake, 'conta-a');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-a');
    seedConta(h.fake, 'conta-b', { nome: 'B' });
    seedCredencial(h.fake, 'conta-b');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-b');
    // A's answer leaves B 20 s of the tick (above the minimum); B's own answer
    // takes 25 s, so B's budget is spent before its first row is enqueued.
    const comUmaLinha = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    h.responder = (url) => {
      const primeira = h.urls.length === 1;
      h.avancar(primeira ? 220_000 - 2_000 - 20_000 : 25_000);
      return primeira ? vazio(url) : comUmaLinha(url);
    };

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho, c.motivo])).toEqual([
      ['conta-a', 'janela-vazia', null],
      ['conta-b', 'falha', 'orcamento-esgotado'],
    ]);
    expect(h.enfileirados).toEqual([]);
  });

  it('a window three budgets long CONVERGES in ≤ 4 ticks, and the cursor moves only on the last', async () => {
    const h = montar();
    contaPronta(h);
    const linhas = Array.from({ length: 30 }, (_, i) =>
      linha(4000 + i, `2027-01-15T10:${String(10 + i).padStart(2, '0')}:00`),
    );
    h.responder = paginado([linhas.slice(0, 10), linhas.slice(10, 20), linhas.slice(20)], {
      limit: 10,
      total: 30,
    });
    // 30 enqueues × 10 s = 300 s of work against 100 s per run.
    h.custoDoEnfileiramentoMs = 10_000;

    const desfechos: string[] = [];
    const cursores: unknown[] = [];
    for (let t = 0; t < 4 && h.enfileirados.length < 30; t += 1) {
      const r = await h.umTick();
      desfechos.push(r.desfecho);
      cursores.push(h.poll()?.cursor);
      h.avancar(300_000);
    }

    expect(desfechos).toEqual(['orcamento-com-progresso', 'orcamento-com-progresso', 'sucesso']);
    expect(cursores).toEqual([CURSOR, CURSOR, '2027-01-15T10:39:00']);
    expect(new Set(h.enfileirados.map((p) => p.numero)).size).toBe(30);
    expect(h.enfileirados).toHaveLength(30);
    expect(h.poll()?.falhasSeguidas).toBe(0);
  });

  it('sem-tempo: a conta the tick can no longer give one page’s cost is not started, and nothing is written for it', async () => {
    const h = montar();
    // Ordered by nome: A runs first and eats the tick.
    seedConta(h.fake, 'conta-a', { nome: 'A' });
    seedCredencial(h.fake, 'conta-a');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-a');
    seedConta(h.fake, 'conta-b', { nome: 'B' });
    seedCredencial(h.fake, 'conta-b');
    // 220 s of tick: 2 s of pacer + this answer leave B exactly the minimum − 1 ms.
    h.latenciaMs = 220_000 - 2_000 - ORCAMENTO_MINIMO_CONTA_MS + 1;

    const r = await h.tick();

    expect(r.contas.map((c) => c.desfecho)).toEqual(['janela-vazia', 'sem-tempo']);
    expect(h.fake.ler('pollPedidosLojaIntegrada/conta-b')).toBeUndefined();
    expect(h.urls).toHaveLength(1);
    expect(h.linhasDoPoll().find((l) => l.campos.conta === 'conta-b')).toMatchObject({
      severidade: 'WARNING',
      campos: { desfecho: 'sem-tempo' },
    });
  });

  it('near-miss: with exactly the minimum left, the conta runs — and reads AND enqueues a page at the planned latency', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-a', { nome: 'A' });
    seedCredencial(h.fake, 'conta-a');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-a');
    seedConta(h.fake, 'conta-b', { nome: 'B' });
    seedCredencial(h.fake, 'conta-b');
    seedPoll(h, {}, 'pollPedidosLojaIntegrada/conta-b');
    // A's one answer leaves B exactly the minimum; B's own answer takes the
    // planned latency, and its page holds a NEW row: no counted budget failure.
    const comUmaLinha = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    h.responder = (url) => {
      const primeira = h.urls.length === 1;
      h.avancar(primeira ? 220_000 - 2_000 - ORCAMENTO_MINIMO_CONTA_MS : LATENCIA_LI_ESTIMADA_MS);
      return primeira ? vazio(url) : comUmaLinha(url);
    };

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho])).toEqual([
      ['conta-a', 'janela-vazia'],
      ['conta-b', 'sucesso'],
    ]);
    expect(h.enfileirados.map((p) => [p.contaId, p.numero])).toEqual([['conta-b', '1001']]);
  });

  it('the tick ROTATES its first conta: the one a full tick skipped (sem-tempo) runs FIRST on the next tick', async () => {
    const h = montar();
    seedConta(h.fake, 'conta-a', { nome: 'A' });
    seedCredencial(h.fake, 'conta-a');
    seedConta(h.fake, 'conta-b', { nome: 'B' });
    seedCredencial(h.fake, 'conta-b');
    // Whichever conta runs first eats its whole tick, every tick.
    h.latenciaMs = 220_000 - 2_000 - ORCAMENTO_MINIMO_CONTA_MS + 1;
    const desfechos = (r: ResultadoTickPollLi) => r.contas.map((c) => [c.integracaoId, c.desfecho]);

    // AGORA_MS sits on a 5-minute slot boundary; the next tick starts on the next slot.
    const primeiro = await h.tick();
    h.avancar(AGORA_MS + 300_000 - h.agora());
    const segundo = await h.tick();

    expect(desfechos(primeiro)).toEqual([
      ['conta-a', 'janela-vazia'],
      ['conta-b', 'sem-tempo'],
    ]);
    expect(desfechos(segundo)).toEqual([
      ['conta-b', 'janela-vazia'],
      ['conta-a', 'sem-tempo'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The lease                                 */
/* -------------------------------------------------------------------------- */

describe('the lease', () => {
  it('held → lease-ocupado: zero calls, nothing written', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outro' });

    const r = await h.umTick();

    expect(r.desfecho).toBe('lease-ocupado');
    expect(h.urls).toEqual([]);
    expect(h.fake.escritasEm(CAMINHO_POLL)).toEqual([]);
  });

  it('near-miss: a lease expiring at exactly now is FREE, and is taken over', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { emExecucaoAteMs: AGORA_MS, execucaoId: 'antigo' });

    const r = await h.umTick();

    expect(r.desfecho).toBe('janela-vazia');
    const [lease] = h.fake.escritasEm(CAMINHO_POLL);
    expect(lease?.dados).toEqual({ emExecucaoAteMs: AGORA_MS + 300_000, execucaoId: 'exec-1' });
    expect(h.poll()).toMatchObject({ emExecucaoAteMs: 0, execucaoId: null });
  });

  it('a lease update that loses its precondition (another writer after our read) exits with zero calls', async () => {
    const h = montar();
    contaPronta(h);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      // Another writer between our read and our lease: the precondition loses.
      seedPoll(h, { emExecucaoAteMs: 0, execucaoId: null, falhasSeguidas: 4 });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('lease-ocupado');
    expect(h.urls).toEqual([]);
    expect(h.poll()?.falhasSeguidas).toBe(4);
  });

  it('the ALREADY_EXISTS loser of a first lease exits with zero calls', async () => {
    const h = montar();
    contaPronta(h, { cursorless: true });
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { emExecucaoAteMs: AGORA_MS + 300_000, execucaoId: 'vencedor' });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('lease-ocupado');
    expect(h.urls).toEqual([]);
    expect(h.poll()).toMatchObject({ execucaoId: 'vencedor' });
  });

  it.each([
    ['the first lease (create) on an absent document', true],
    ['a lease update on an expired one', false],
  ])(
    '%s failing UNAVAILABLE is a contained Firestore error, never read as a busy lease',
    async (_n, cursorless) => {
      const h = montar();
      contaPronta(h, { cursorless });
      h.fake.falharEscrita(CAMINHO_POLL, grpc(14, 'UNAVAILABLE'));

      const r = await h.umTick();

      expect(r).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
      expect(h.urls).toEqual([]);
    },
  );

  it('a retry that loses its precondition AGAIN gives up as lease-perdido (one WARNING), never as an error', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    const aindaNosso = { emExecucaoAteMs: AGORA_MS + 300_000, execucaoId: 'exec-1' };
    // Write 1 is the lease; before write 2 (the final write) AND write 3 (its
    // one retry) a write lands that leaves the lease ours.
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { ...aindaNosso, falhasSeguidas: 1 });
    });
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { ...aindaNosso, falhasSeguidas: 2 });
    });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'lease-perdido', codigoGrpc: null, enfileiradas: 1 });
    expect(h.poll()).toMatchObject({ ...aindaNosso, cursor: CURSOR, falhasSeguidas: 2 });
    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'lease-perdido')).toHaveLength(1);
  });

  it('a STALE run (taken over mid-run) neither moves the cursor back nor clears the other run’s lease', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    // Write 1 is our lease; before write 2 (our final write) another run takes over.
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, {
        cursor: '2027-01-15T11:00:00',
        emExecucaoAteMs: AGORA_MS + 600_000,
        execucaoId: 'outro',
        vistos: { '7': '2027-01-15T10:59:00.000000' },
      });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('lease-perdido');
    expect(h.poll()).toMatchObject({
      cursor: '2027-01-15T11:00:00',
      emExecucaoAteMs: AGORA_MS + 600_000,
      execucaoId: 'outro',
      vistos: { '7': '2027-01-15T10:59:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({ '7': '2027-01-15T10:59:00.000000' });
    expect(h.linhasDoPoll().filter((l) => l.campos.alerta === 'lease-perdido')).toHaveLength(1);
  });

  it('a lost final write still ours is RE-DERIVED from the re-read and retried once: max(cursor), merged vistos', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      // Same owner, a later cursor and another entry: what changed must survive.
      seedPoll(h, {
        cursor: '2027-01-15T11:00:00',
        emExecucaoAteMs: AGORA_MS + 300_000,
        execucaoId: 'exec-1',
        vistos: { '7': '2027-01-15T10:59:00.000000' },
      });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.poll()).toMatchObject({
      cursor: '2027-01-15T11:00:00',
      emExecucaoAteMs: 0,
      execucaoId: null,
      vistos: { '7': '2027-01-15T10:59:00.000000', '1001': '2027-01-15T10:30:00.000000' },
    });
    expect(h.poll()?.vistos).toEqual({
      '7': '2027-01-15T10:59:00.000000',
      '1001': '2027-01-15T10:30:00.000000',
    });
  });

  it('a retry that re-reads a count this run did not resolve leaves it for the next clean run', async () => {
    const h = montar();
    contaPronta(h);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, {
        emExecucaoAteMs: AGORA_MS + 300_000,
        execucaoId: 'exec-1',
        falhasSeguidas: 2,
        ultimoErro: 'credencial-ausente',
      });
    });

    await h.umTick();

    expect(h.poll()).toMatchObject({ falhasSeguidas: 2, ultimoErro: 'credencial-ausente' });
  });

  it('near-miss: a count that GREW after the lease (2 → 3) survives the retry although THIS run resolved — and the next clean run closes the aviso it reopened', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'credencial-ausente' });
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, async () => {
      // After this run's resolve, a refusal record (this run outlived its
      // lease) counts 3 and raises at its own, LATER commit time.
      const registro = h.fake.seed(CAMINHO_POLL, {
        cursor: CURSOR,
        emExecucaoAteMs: AGORA_MS + 300_000,
        execucaoId: 'exec-1',
        ultimaVarreduraEmMs: AGORA_MS,
        ultimoErro: 'credencial-ausente',
        falhasSeguidas: 3,
        vistos: {},
      });
      await avisarImportacaoParada(
        asDb(h.fake),
        {
          integracaoId: ID,
          lojaNome: `Loja ${ID}`,
          motivo: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente,
          relogioUs: relogioDoDocumentoUs(registro),
        },
        { increment, nowMs: AGORA_MS },
      );
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('janela-vazia');
    expect(h.poll()).toMatchObject({
      falhasSeguidas: 3,
      ultimoErro: 'credencial-ausente',
      execucaoId: null,
    });
    expect(avisoImportacao(h)).toMatchObject({ resolvidoEm: null });

    // The stored count is above 0, so the next clean run resolves it.
    h.avancar(300_000);
    await h.umTick();
    expect(h.poll()).toMatchObject({ falhasSeguidas: 0, ultimoErro: null });
    expect(avisoImportacao(h)).toMatchObject({ resolucaoMotivo: 'importacao-retomada' });
    expect(avisoImportacao(h)?.resolvidoEm).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              The refusal record                            */
/* -------------------------------------------------------------------------- */

describe('the refusal record', () => {
  it('an active conta with NO credential: counted each tick, the aviso on the THIRD, never a cursor', async () => {
    const h = montar();
    seedConta(h.fake, ID);

    const r1 = await h.umTick();
    expect(r1).toMatchObject({ desfecho: 'recusa', motivo: 'credencial-ausente' });
    expect(h.poll()).toMatchObject({
      cursor: null,
      falhasSeguidas: 1,
      ultimoErro: 'credencial-ausente',
      emExecucaoAteMs: 0,
      execucaoId: null,
      vistos: {},
      ultimaVarreduraEmMs: AGORA_MS,
    });
    expect(h.poll()?.vistos).toEqual({});
    expect(avisoImportacao(h)).toBeUndefined();

    h.avancar(300_000);
    await h.umTick();
    expect(h.poll()?.falhasSeguidas).toBe(2);
    expect(avisoImportacao(h)).toBeUndefined();

    h.avancar(300_000);
    await h.umTick();
    const registro = h.fake.escritasEm(CAMINHO_POLL).at(-1);
    expect(h.poll()).toMatchObject({ falhasSeguidas: 3, cursor: null });
    expect(avisoImportacao(h)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: `Loja ${ID}`, motivo: 'credencial-ausente' },
      // The record's own commit time is the clock.
      relogioEvento: relogioDoDocumentoUs(registro?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
      resolvidoEm: null,
    });
    expect(h.urls).toEqual([]);

    // A token saved: the first lease anchors the bootstrap NOW, and the clean run resolves.
    seedCredencial(h.fake, ID);
    h.avancar(300_000);
    const limpo = await h.umTick();
    expect(limpo.desfecho).toBe('janela-vazia');
    expect(h.poll()).toMatchObject({
      cursor: '2027-01-12T12:15:00',
      falhasSeguidas: 0,
      ultimoErro: null,
    });
    expect(avisoImportacao(h)).toMatchObject({ resolucaoMotivo: 'importacao-retomada' });
  });

  it('a corrupt credential records credencial-invalida', async () => {
    const h = montar();
    contaPronta(h);
    h.fake.seed(caminhoCredencial(ID), { personalToken: 42 });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'recusa', motivo: 'credencial-invalida' });
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'credencial-invalida',
    });
  });

  it('near-miss: an INACTIVE conta with no credential writes nothing at all', async () => {
    const h = montar();
    seedConta(h.fake, ID, { ativo: false });

    const r = await h.umTick();

    expect(r.desfecho).toBe('inativa');
    expect(h.fake.escritas).toEqual([]);
  });

  it('a busy lease skips the record (the next tick retries)', async () => {
    const h = montar();
    seedConta(h.fake, ID);
    seedPoll(h, { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outro', falhasSeguidas: 2 });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'recusa-adiada', motivo: 'credencial-ausente' });
    expect(h.fake.escritasEm(CAMINHO_POLL)).toEqual([]);
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it('the record writes its three fields only: an EXPIRED lease it finds, and the cursor, are left exactly as they were', async () => {
    const h = montar();
    seedConta(h.fake, ID);
    seedPoll(h, { emExecucaoAteMs: AGORA_MS - 1, execucaoId: 'antigo', falhasSeguidas: 1 });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'recusa', motivo: 'credencial-ausente' });
    expect(h.fake.escritasEm(CAMINHO_POLL).map((e) => e.dados)).toEqual([
      { ultimoErro: 'credencial-ausente', falhasSeguidas: 2, ultimaVarreduraEmMs: AGORA_MS },
    ]);
    expect(h.poll()).toMatchObject({
      cursor: CURSOR,
      emExecucaoAteMs: AGORA_MS - 1,
      execucaoId: 'antigo',
    });
  });

  it('a record that loses its precondition is skipped, never retried over the winner', async () => {
    const h = montar();
    seedConta(h.fake, ID);
    seedPoll(h, { falhasSeguidas: 1 });
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { falhasSeguidas: 7 });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('recusa-adiada');
    expect(h.poll()?.falhasSeguidas).toBe(7);
  });

  it('lookback-invalido: a cursorless conta refuses at ONCE with the aviso; one with a cursor is unaffected', async () => {
    const h = montar();
    contaPronta(h, { cursorless: true });

    const r = await h.umTick({ lookbackHoras: null });

    expect(r).toMatchObject({ desfecho: 'recusa', motivo: 'lookback-invalido' });
    expect(h.poll()).toMatchObject({ cursor: null, falhasSeguidas: 1 });
    expect(avisoImportacao(h)).toMatchObject({
      params: { motivo: 'lookback-invalido' },
      resolvidoEm: null,
    });
    expect(h.urls).toEqual([]);

    const h2 = montar();
    contaPronta(h2);
    const r2 = await h2.umTick({ lookbackHoras: null });
    expect(r2.desfecho).toBe('janela-vazia');
  });

  it('id-de-conta-invalido: an id no notification can carry is refused at once, with zero calls', async () => {
    const h = montar();
    const id = 'conta.li';
    seedConta(h.fake, id);
    seedCredencial(h.fake, id);

    const r = await h.tick();

    expect(r.contas[0]).toMatchObject({ desfecho: 'recusa', motivo: 'id-de-conta-invalido' });
    expect(h.fake.ler(`pollPedidosLojaIntegrada/${id}`)).toMatchObject({ falhasSeguidas: 1 });
    expect(h.fake.ler(caminhoAviso(chaveImportacaoParada(id)))).toMatchObject({
      params: { motivo: 'id-de-conta-invalido' },
    });
    expect(h.urls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The enqueue split                            */
/* -------------------------------------------------------------------------- */

describe('enqueue failures, split by meaning', () => {
  it.each([
    [
      'a transient Cloud Tasks failure',
      () => rejeicaoDoTransporte(falhaDoFunctions('unknown-error')),
    ],
    ['the sweep-only valve', () => Promise.reject(new LiTarefasDesligadasError())],
  ])(
    '%s → every row persisted `failed`, recorded in vistos, and the cursor still advances',
    async (_n, falha) => {
      const h = montar();
      contaPronta(h);
      h.falhaDoEnfileiramento = falha;
      h.responder = paginado([
        [linha(1001, '2027-01-15T10:30:00'), linha(1002, '2027-01-15T10:31:00')],
      ]);

      const r = await h.umTick();

      expect(r).toMatchObject({ desfecho: 'sucesso', enfileiradas: 0, persistidas: 2 });
      const ids = h.fake.idsEm(COLECAO_NOTIFICACOES).sort();
      expect(ids).toEqual(
        [
          docIdNotificacaoLi(payload('1001', '2027-01-15T10:30:00.000000')),
          docIdNotificacaoLi(payload('1002', '2027-01-15T10:31:00.000000')),
        ].sort(),
      );
      for (const id of ids) {
        expect(h.fake.ler(`${COLECAO_NOTIFICACOES}/${id}`)).toMatchObject({ status: 'failed' });
      }
      expect(h.poll()?.cursor).toBe('2027-01-15T10:31:00');
      expect(Object.keys(h.poll()?.vistos as object)).toEqual(['1001', '1002']);
    },
  );

  it.each([
    ['a missing queue (functions/not-found)', () => falhaDoFunctions('not-found', 404)],
    [
      'an unresolvable project (unknown-error WITHOUT a response)',
      () => falhaDeConfiguracaoDoFunctions('projeto'),
    ],
  ])('%s is a broken deploy: RETHROWN, the tick fails, nothing persisted', async (_n, erro) => {
    const h = montar();
    contaPronta(h);
    const falha = erro();
    h.falhaDoEnfileiramento = () => rejeicaoDoTransporte(falha);
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);

    await expect(h.tick()).rejects.toBe(falha);

    expect(h.fake.idsEm(COLECAO_NOTIFICACOES)).toEqual([]);
    expect(h.poll()).toMatchObject({ cursor: CURSOR, execucaoId: 'exec-1' });
  });

  it('a failed PERSIST aborts the run (contained per conta as a gRPC error); the next conta still runs', async () => {
    const h = montar();
    contaPronta(h);
    seedConta(h.fake, 'conta-z', { nome: 'Z' });
    seedCredencial(h.fake, 'conta-z');
    h.falhaDoEnfileiramento = () => Promise.reject(new LiTarefasDesligadasError());
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);
    h.fake.falharEscrita(
      `${COLECAO_NOTIFICACOES}/${docIdNotificacaoLi(payload('1001', '2027-01-15T10:30:00.000000'))}`,
      grpc(14, 'UNAVAILABLE'),
    );

    const r = await h.tick();

    expect(r.contas.map((c) => [c.integracaoId, c.desfecho, c.codigoGrpc])).toEqual([
      [ID, 'erro-firestore', 14],
      ['conta-z', 'sucesso', null],
    ]);
    // Nothing more was written: the lease is left to expire.
    expect(h.poll()).toMatchObject({ execucaoId: 'exec-1', vistos: {} });
    expect(h.poll()?.vistos).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The aviso                                 */
/* -------------------------------------------------------------------------- */

describe('the import-stopped aviso', () => {
  it('the thresholds: 3 for what may heal, at once for what will not — total over the motivos', () => {
    expect(AVISO_APOS_FALHAS_SEGUIDAS_LI).toBe(3);
    const imediatos = Object.entries(LIMIAR_AVISO_IMPORTACAO_PARADA_LI)
      .filter(([, n]) => n === 1)
      .map(([m]) => m)
      .sort();
    expect(imediatos).toEqual([
      'filtro-ignorado',
      'id-de-conta-invalido',
      'janela-grande-demais',
      'lookback-invalido',
    ]);
    expect(Object.keys(LIMIAR_AVISO_IMPORTACAO_PARADA_LI)).toHaveLength(13);
  });

  it('falha-transitoria: none on runs 1–2, RAISED on run 3 at the lease clock, refreshed on run 4', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({ status: 429, corpo: 'devagar' });

    for (let i = 0; i < 2; i += 1) {
      await h.umTick();
      h.avancar(300_000);
    }
    expect(avisoImportacao(h)).toBeUndefined();

    await h.umTick();
    // Writes on the poll document: lease, final, lease, final, LEASE (run 3).
    const lease3 = h.fake.escritasEm(CAMINHO_POLL)[4];
    const primeiro = avisoImportacao(h);
    expect(primeiro).toMatchObject({
      resolvidoEm: null,
      ocorrencias: 1,
      params: { loja: `Loja ${ID}`, motivo: 'falha-transitoria' },
      relogioEvento: relogioDoDocumentoUs(lease3?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
    });

    h.avancar(300_000);
    await h.umTick();
    expect(avisoImportacao(h)).toMatchObject({ ocorrencias: 2, criadoEm: primeiro?.criadoEm });
  });

  // The invariant: an OPEN aviso always has a stored count above 0, so a later
  // clean run resolves it. A raise lands only once its count is stored.
  it('a threshold-1 failure whose FINAL write fails (gRPC 14) raises NOTHING, and the next clean run leaves nothing open', async () => {
    const h = montar();
    contaPronta(h);
    // A row below the tolerance floor: filtro-ignorado, raised at once.
    h.responder = paginado([[linha(1001, '2027-01-15T01:47:59.999999')]]);
    // Write 1 is the lease; write 2, the final write, fails UNAVAILABLE.
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      throw grpc(14, 'UNAVAILABLE');
    });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
    expect(h.poll()).toMatchObject({ falhasSeguidas: 0, ultimoErro: null });
    expect(avisoImportacao(h)).toBeUndefined();

    // The lease expires; a clean window.
    h.avancar(300_000);
    h.responder = vazio;
    expect((await h.umTick()).desfecho).toBe('janela-vazia');
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it('near-miss: the same failure whose final write LANDS opens the aviso, clocked by the lease', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T01:47:59.999999')]]);

    const r = await h.umTick();

    const [lease] = h.fake.escritasEm(CAMINHO_POLL);
    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'filtro-ignorado' });
    expect(h.poll()).toMatchObject({ falhasSeguidas: 1, ultimoErro: 'filtro-ignorado' });
    expect(avisoImportacao(h)).toMatchObject({
      resolvidoEm: null,
      params: { motivo: 'filtro-ignorado' },
      relogioEvento: relogioDoDocumentoUs(lease?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
    });
  });

  it('a run whose lease was taken over raises NOTHING, even at threshold 1 with no newer clock on the row', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[linha(1001, '2027-01-15T01:47:59.999999')]]);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      // Another run took the lease over and runs clean from a count of 0: it writes no aviso.
      seedPoll(h, { emExecucaoAteMs: AGORA_MS + 600_000, execucaoId: 'outro' });
    });

    const r = await h.umTick();

    expect(r.desfecho).toBe('lease-perdido');
    expect(avisoImportacao(h)).toBeUndefined();
  });

  it('the count a RE-DERIVED final write stored is the one the threshold reads', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = () => ({ status: 503, corpo: 'x' });
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.fake.antesDaProximaEscrita(CAMINHO_POLL, () => {
      // Two refusal records after the lease: the retry stores 2 + 1 = 3.
      seedPoll(h, {
        emExecucaoAteMs: AGORA_MS + 300_000,
        execucaoId: 'exec-1',
        falhasSeguidas: 2,
        ultimoErro: 'credencial-ausente',
      });
    });

    const r = await h.umTick();

    expect(r).toMatchObject({ desfecho: 'falha', motivo: 'falha-transitoria' });
    expect(h.poll()).toMatchObject({ falhasSeguidas: 3, ultimoErro: 'falha-transitoria' });
    expect(avisoImportacao(h)).toMatchObject({
      resolvidoEm: null,
      params: { motivo: 'falha-transitoria' },
    });
  });

  it('a clean run with a stored count of 0 makes NO aviso call', async () => {
    const h = montar();
    contaPronta(h);

    await h.umTick();

    expect(h.fake.leituras.filter((p) => p.startsWith('avisos/'))).toEqual([]);
    expect(h.fake.escritas.filter((e) => e.caminho.startsWith('avisos/'))).toEqual([]);
  });

  it('a clean run after a stored failure resolves (seeding a resolved row) and only then resets', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'falha-transitoria' });

    await h.umTick();

    expect(avisoImportacao(h)).toMatchObject({
      resolucaoMotivo: 'importacao-retomada',
      params: { loja: `Loja ${ID}` },
    });
    expect(h.poll()).toMatchObject({ falhasSeguidas: 0, ultimoErro: null });
  });

  it('a resolve that FAILS keeps falhasSeguidas (the next clean run retries), and the cursor still advances', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 3, ultimoErro: 'falha-transitoria' });
    h.fake.falharLeitura(caminhoAviso(chaveImportacaoParada(ID)), grpc(14, 'UNAVAILABLE'));
    h.responder = paginado([[linha(1001, '2027-01-15T10:30:00')]]);

    const r = await h.umTick();

    expect(r.desfecho).toBe('sucesso');
    expect(h.poll()).toMatchObject({
      cursor: '2027-01-15T10:30:00',
      falhasSeguidas: 3,
      ultimoErro: 'falha-transitoria',
      execucaoId: null,
    });
    expect(h.linhasDoPoll().find((l) => l.campos.alerta === 'aviso-nao-gravado')).toMatchObject({
      severidade: 'WARNING',
      campos: { passo: 'resolver', codigoGrpc: 14 },
    });
  });

  it('a NON-gRPC failure in the aviso step is a defect: rethrown, the tick fails, the final write never lands', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 3, ultimoErro: 'falha-transitoria' });
    h.fake.falharLeitura(caminhoAviso(chaveImportacaoParada(ID)), new RangeError('defeito'));

    await expect(h.tick()).rejects.toBeInstanceOf(RangeError);

    // Only a gRPC status error is logged and swallowed there.
    expect(h.linhasDoPoll().some((l) => l.campos.alerta === 'aviso-nao-gravado')).toBe(false);
    expect(h.poll()).toMatchObject({ falhasSeguidas: 3, execucaoId: 'exec-1' });
  });

  it('the clock: an OLDER raise after a newer resolve stays resolved', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2 });
    await resolverImportacaoParada(
      asDb(h.fake),
      ID,
      { nowMs: AGORA_MS },
      {
        relogioUs: 9_000_000_000_000_000,
        lojaNome: 'Loja',
      },
    );
    h.responder = () => ({ status: 503, corpo: 'x' });

    await h.umTick();

    expect(h.poll()?.falhasSeguidas).toBe(3);
    expect(avisoImportacao(h)).toMatchObject({ resolucaoMotivo: 'importacao-retomada' });
    expect(avisoImportacao(h)?.resolvidoEm).not.toBeNull();
  });

  it('near-miss: a NEWER raise reopens it', async () => {
    const h = montar();
    contaPronta(h);
    seedPoll(h, { falhasSeguidas: 2 });
    await resolverImportacaoParada(
      asDb(h.fake),
      ID,
      { nowMs: AGORA_MS },
      {
        relogioUs: 1,
        lojaNome: 'Loja',
      },
    );
    h.responder = () => ({ status: 503, corpo: 'x' });

    await h.umTick();

    expect(avisoImportacao(h)).toMatchObject({
      resolvidoEm: null,
      params: { motivo: 'falha-transitoria' },
    });
  });

  it('never for a parked conta, a busy lease or a budget run with progress', async () => {
    const h = montar();
    contaPronta(h);
    seedCredencial(h.fake, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS - 1, status: 401, refCredencial: 'ref-estacionada' },
    });
    seedPoll(h, { falhasSeguidas: 9 });

    const r = await h.umTick();

    expect(r.desfecho).toBe('conta-parada');
    expect(avisoImportacao(h)).toBeUndefined();
    expect(h.fake.escritasEm(CAMINHO_POLL)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                The tick's line                             */
/* -------------------------------------------------------------------------- */

describe('the log', () => {
  it('one poll line per conta run, primitives only, and no row value in it', async () => {
    const h = montar();
    contaPronta(h);
    h.responder = paginado([[EXEMPLO_164]]);
    seedPoll(h, { cursor: '2022-10-31T12:00:00' });

    await h.umTick();

    const [linhaDaConta] = h.linhasDoPoll();
    expect(h.linhasDoPoll()).toHaveLength(1);
    expect(linhaDaConta).toMatchObject({
      severidade: 'INFO',
      campos: {
        evento: 'poll',
        conta: ID,
        fluxo: 'poll',
        desfecho: 'sucesso',
        enfileiradas: 1,
        persistidas: 0,
        paginas: 1,
        cursorAvancou: true,
      },
    });
    expect(JSON.stringify(h.gravador.linhas)).not.toContain('/api/v1/cliente/');
  });

  it('resumirTickPollLi counts the outcomes', () => {
    expect(
      resumirTickPollLi({
        portao: null,
        contas: [
          {
            integracaoId: 'a',
            desfecho: 'sucesso',
            motivo: null,
            enfileiradas: 2,
            persistidas: 1,
            paginas: 1,
            cursorAvancou: true,
            codigoGrpc: null,
          },
          {
            integracaoId: 'b',
            desfecho: 'sucesso',
            motivo: null,
            enfileiradas: 1,
            persistidas: 0,
            paginas: 1,
            cursorAvancou: true,
            codigoGrpc: null,
          },
          {
            integracaoId: 'c',
            desfecho: 'inativa',
            motivo: null,
            enfileiradas: 0,
            persistidas: 0,
            paginas: 0,
            cursorAvancou: false,
            codigoGrpc: null,
          },
        ],
      }),
    ).toEqual({
      portao: null,
      contas: 3,
      desfechos: { sucesso: 2, inativa: 1 },
      enfileiradas: 3,
      persistidas: 1,
    });
  });
});
