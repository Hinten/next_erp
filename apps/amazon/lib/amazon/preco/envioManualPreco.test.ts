/**
 * The four price routes' bodies (step 13, PR 13-g) against the fake Firestore,
 * the REAL producers (the price task's and the run's pages) over recording
 * queues that refuse a held name as Cloud Tasks does, and a global `fetch`
 * that must never run. The manual push: the strict body and the produto bound,
 * the read switch and the queue's region before any read, the conta and its
 * normal tabela, the anchor hop and the family's links, the per-SKU skips (the
 * task's own target grammar, the listings path), the 30-SKU switch on the
 * SENDABLE SKUs (all or nothing), the queue valve, the budget and the failures
 * it names — zero Firestore writes and zero Amazon calls on every arm. The run
 * routes: the claim, the status and the cancel, each typed answer mapped to
 * its HTTP status, and nothing decided twice. And, on every route, the
 * environment read is the read switch ALONE: never the price valve, its
 * canary list or the preview flag.
 */
import { inspect } from 'node:util';

import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_PRECO_AMAZON,
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_PRECO_AMAZON,
  MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON,
  envioPrecoManualAmazonSchema,
  erroPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
  respostaCancelamentoExecucaoPrecoAmazonSchema,
  respostaInicioExecucaoPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { FLUXO_AMAZON, alvoValido } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
} from '../feeds/agendadorLotes';
import type { OpcoesDaTarefaListingAmazon } from '../listings/produtorListing';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import { espiaoDeFetch, loggerEspiao } from '../testing/fixtures';
import {
  AmazonPrecoEnfileiramentoFalhouError,
  CAMPOS_CONTA_ROTA_PRECO_AMAZON,
  type DepsConsultaAtualizacaoPrecosAmazon,
  type DepsEnvioManualPrecoAmazon,
  type DepsInicioAtualizacaoPrecosAmazon,
  MAX_CORPO_ROTA_PRECO_BYTES,
  MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON,
  ORCAMENTO_ENVIO_MANUAL_PRECO_MS,
  ROTA_PRECO_AMAZON,
  STATUS_DO_CODIGO_PRECO_AMAZON,
  cancelarAtualizacaoPrecosAmazon,
  enviarPrecoManualAmazon,
  iniciarAtualizacaoPrecosAmazon,
  resumoAtualizacaoPrecosAmazon,
} from './envioManualPreco';
import {
  CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON,
  CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON,
  CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON,
  type FilaExecucaoPrecoAmazon,
  criarProdutorExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import { type FilaPrecoAmazon, criarProdutorPrecoAmazon } from './produtorPreco';
import {
  type TarefaPaginaPrecoAmazon,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  nomePaginaPrecoAmazon,
  nomeRetomadaPrecoAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

const CONTA = 'conta-preco-rotas';
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const TABELA = 'documents/listaDePrecos/tab-normal';
const CAMINHO_CONTA = `integracao/${CONTA}`;
const CAMINHO_RUN = `precosAmazon/${CONTA}`;
const CAMINHO_VEZ = `feedsAmazonEmCurso/preco-${CONTA}`;
const BASE = 'http://localhost:3011/api/marketplace/amazon';
/** The request's id, as the route mints it (any id of the feed core's grammar). */
const REFERENCIA = '00000000-0000-4000-8000-000000000001';
const UID = 'uid-operador';
const AGORA_MS = 1_800_000_000_000;
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
const EXEC = 'exec-viva';
const NOVA = 'exec-nova';

/**
 * The read switch on, and everything that would stop or shape a PRICE write
 * set to its most restrictive value — the routes must not care (the task and
 * the run read them).
 */
const AMBIENTE: AmbienteAmazon = Object.freeze({
  AMAZON_CHAMADAS: 'on',
  AMAZON_MODO_PRECO: 'off',
  AMAZON_CANARIO_PRECO: '',
  AMAZON_PRECO_SO_VALIDACAO: '1',
});

const MSG = MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON;

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

let fake: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;
let lerDb: ReturnType<typeof vi.fn>;
let chamadasFetch: unknown[];
/** Every environment key a body read, in order. */
let chavesLidas: string[];
/** The route's clock, ms. */
let relogio: number;

interface Enfileirada<T> {
  readonly tarefa: T;
  readonly opcoes: OpcoesDaTarefaListingAmazon | undefined;
}

/**
 * A queue that records every enqueue with its options and, like Cloud Tasks,
 * refuses a task id it already holds; `falha` (when set) runs FIRST.
 */
function filaGravadora<T>() {
  const ids = new Set<string>();
  const enfileiradas: Enfileirada<T>[] = [];
  const estado: { falha: (() => unknown) | null } = { falha: null };
  const fila = {
    enqueue: (tarefa: T, opcoes?: OpcoesDaTarefaListingAmazon): Promise<void> => {
      if (estado.falha !== null) return Promise.reject(estado.falha());
      if (opcoes?.id !== undefined) {
        if (ids.has(opcoes.id)) return Promise.reject(falhaDeTarefaJaExistente(opcoes.id));
        ids.add(opcoes.id);
      }
      enfileiradas.push({ tarefa, opcoes });
      return Promise.resolve();
    },
  };
  return { fila, enfileiradas, estado };
}

let filaPreco: ReturnType<typeof filaGravadora<TarefaPrecoSkuAmazon>>;
let filaPaginas: ReturnType<typeof filaGravadora<TarefaPaginaPrecoAmazon>>;
/** The producers each body built (a closed valve or a refusal builds none). */
let produtoresConstruidos: number;
let produtorDesligado: boolean;
/** The run ids the start route mints, in order. */
let idsDeExecucao: string[];

/** `base`, behind a proxy that records every key read. */
function ambienteEspiado(base: AmbienteAmazon): AmbienteAmazon {
  return new Proxy(base, {
    get(alvo, chave) {
      if (typeof chave === 'string') chavesLidas.push(chave);
      return Reflect.get(alvo, chave) as unknown;
    },
  });
}

function depsManual(over: Partial<DepsEnvioManualPrecoAmazon> = {}): DepsEnvioManualPrecoAmazon {
  return {
    ambiente: ambienteEspiado(AMBIENTE),
    db: lerDb as unknown as DepsEnvioManualPrecoAmazon['db'],
    filaDesligada: false,
    regiao: () => 'xx-tarefas-1',
    produtor: () => {
      produtoresConstruidos += 1;
      return criarProdutorPrecoAmazon({
        fila: () => filaPreco.fila as FilaPrecoAmazon,
        desligado: produtorDesligado,
      });
    },
    agora: () => relogio,
    gerarReferencia: () => REFERENCIA,
    logger: espiao.logger,
    ...over,
  };
}

function depsInicio(
  over: Partial<DepsInicioAtualizacaoPrecosAmazon> = {},
): DepsInicioAtualizacaoPrecosAmazon {
  return {
    ambiente: ambienteEspiado(AMBIENTE),
    db: lerDb as unknown as DepsInicioAtualizacaoPrecosAmazon['db'],
    filaDesligada: false,
    regiao: () => 'xx-tarefas-1',
    produtor: () => {
      produtoresConstruidos += 1;
      return criarProdutorExecucaoPrecoAmazon({
        fila: () => filaPaginas.fila as FilaExecucaoPrecoAmazon,
        desligado: produtorDesligado,
      });
    },
    agora: () => relogio,
    gerarExecucaoId: () => idsDeExecucao.shift() ?? 'exec-esgotado',
    logger: espiao.logger,
    ...over,
  };
}

function depsConsulta(
  over: Partial<DepsConsultaAtualizacaoPrecosAmazon> = {},
): DepsConsultaAtualizacaoPrecosAmazon {
  return {
    ambiente: ambienteEspiado(AMBIENTE),
    db: lerDb as unknown as DepsConsultaAtualizacaoPrecosAmazon['db'],
    agora: () => relogio,
    logger: espiao.logger,
    ...over,
  };
}

/** A POST with `corpo` as its body (a string is sent verbatim). */
function post(caminho: string, corpo: unknown): Request {
  return new Request(`${BASE}/${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function enviar(corpo: unknown, over: Partial<DepsEnvioManualPrecoAmazon> = {}) {
  return enviarPrecoManualAmazon(post('enviar-precos', corpo), depsManual(over));
}

function iniciar(corpo: unknown, over: Partial<DepsInicioAtualizacaoPrecosAmazon> = {}) {
  return iniciarAtualizacaoPrecosAmazon(post('atualizar-precos', corpo), UID, depsInicio(over));
}

function status(consulta: string, over: Partial<DepsConsultaAtualizacaoPrecosAmazon> = {}) {
  return resumoAtualizacaoPrecosAmazon(
    new Request(`${BASE}/atualizar-precos/status${consulta}`, { method: 'GET' }),
    depsConsulta(over),
  );
}

function cancelar(corpo: unknown, over: Partial<DepsConsultaAtualizacaoPrecosAmazon> = {}) {
  return cancelarAtualizacaoPrecosAmazon(
    post('atualizar-precos/cancelar', corpo),
    depsConsulta(over),
  );
}

const corpoDe = (...produtoIds: string[]) => ({ integracaoId: CONTA, produtoIds });

/** An INCOMPLETE Amazon conta with its normal tabela (fields over it). */
function semearConta(over: Record<string, unknown> = {}): void {
  fake.seed(CAMINHO_CONTA, {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste',
    ativo: true,
    tabelaNormalOuterRef: TABELA,
    tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-promo',
    depositoOuterRef: 'documents/depositos/dep-1',
    ...over,
  });
}

/** A produto carrying prices no route may read. */
function produto(id: string, extra: Record<string, unknown> = {}): void {
  fake.seed(`produtos/${id}`, {
    nome: `Produto ${id}`,
    precos: { 'tab-normal': { valor: 123.45 }, 'tab-promo': { valor: 99.9 } },
    ...extra,
  });
}

/** A link doc on `dono`, of this conta unless told otherwise, carrying a payload no read returns. */
function vinculo(dono: string, sku: string, opcoes: { conta?: string; id?: string } = {}): void {
  fake.seed(`produtos/${dono}/prodAmazon/${opcoes.id ?? `l-${encodeURIComponent(sku)}`}`, {
    contaAmazonOuterRef: opcoes.conta ?? REF_CONTA,
    sku,
    productDataJson: { pesado: 'x'.repeat(64) },
  });
}

/** `n` SKUs, zero-padded so code-unit order is numeric order. */
const sku = (i: number) => `SKU-${String(i).padStart(3, '0')}`;

/** One produto with `n` linked SKUs of the conta. */
function familiaCom(n: number, extras: readonly string[] = []): void {
  semearConta();
  produto('p1');
  for (let i = 0; i < n; i += 1) vinculo('p1', sku(i));
  for (const s of extras) vinculo('p1', s);
}

/** The enqueued price tasks, in order. */
const tarefas = () => filaPreco.enfileiradas.map((e) => e.tarefa);

/** Every `evento: 'preco'` line's campos. */
function linhasPreco() {
  return espiao.linhas.filter((l) => l.meta?.evento === 'preco').map((l) => l.meta ?? {});
}

/** A 200 manual answer, checked against the contract (and returned RAW). */
function ok(r: Awaited<ReturnType<typeof enviar>>) {
  expect(r.status).toBe(200);
  if (r.status !== 200) throw new Error('esperado 200');
  expect(envioPrecoManualAmazonSchema.safeParse(r.corpo).success).toBe(true);
  return r.corpo;
}

/** An error answer's body, checked against the contract. */
function erroDe(r: { readonly status: number; readonly corpo: unknown }) {
  expect([400, 404, 409, 503]).toContain(r.status);
  return erroPrecoAmazonSchema.parse(r.corpo);
}

type EntradaExecucao = z.input<typeof execucaoPrecoAmazonSchema>;

/** A stored run, every default filled: live, started 3 h ago, never progressed. */
function execucao(over: Partial<EntradaExecucao> = {}): ExecucaoPrecoAmazon {
  return execucaoPrecoAmazonSchema.parse({
    execucaoId: EXEC,
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: 'uid-antigo',
    iniciadaEmMs: AGORA_MS - 3 * HORA_MS,
    ...over,
  });
}

/** One batch Decide named. */
function lote(over: Record<string, unknown> = {}) {
  return { execucaoIdLote: 'exec-viva-l0', parteInicial: 0, partes: 1, itens: 40, ...over };
}

/**
 * The fake db with a hook around each `getAll`, keyed by its first document's
 * path: `depois` runs after it answered. Everything else is the fake itself.
 */
function dbEspiado(depois: (caminho: string) => void): Firestore {
  const real = asDb(fake);
  return new Proxy(real, {
    get(alvo, chave) {
      const v = Reflect.get(alvo, chave) as unknown;
      if (typeof v !== 'function') return v;
      const metodo = v as (...a: unknown[]) => unknown;
      if (chave !== 'getAll') return (...args: unknown[]) => metodo.apply(alvo, args);
      return async (...args: unknown[]) => {
        const saida = await (metodo.apply(alvo, args) as Promise<unknown>);
        depois(String((args[0] as { readonly path?: unknown } | undefined)?.path));
        return saida;
      };
    },
  });
}

beforeEach(() => {
  fake = new FakeDb();
  // Every read of these collections must be masked or projected.
  for (const c of ['integracao', 'produtos', 'prodAmazon', 'precosAmazon', 'feedsAmazonEmCurso']) {
    fake.exigirMascaraEm(c);
  }
  espiao = loggerEspiao();
  lerDb = vi.fn(() => asDb(fake));
  filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
  filaPaginas = filaGravadora<TarefaPaginaPrecoAmazon>();
  produtoresConstruidos = 0;
  produtorDesligado = false;
  idsDeExecucao = [NOVA, 'exec-nova-2'];
  chavesLidas = [];
  relogio = AGORA_MS;
  const fetch = espiaoDeFetch();
  chamadasFetch = fetch.chamadas;
  vi.stubGlobal('fetch', fetch.fetch);
});

afterEach(() => {
  // ★ On EVERY arm: no Amazon call (no fetch at all), and the environment read
  // is the read switch ALONE — never the price valve, its canary or the flag.
  expect(chamadasFetch).toHaveLength(0);
  expect(new Set(chavesLidas)).toEqual(
    chavesLidas.length === 0 ? new Set() : new Set(['AMAZON_CHAMADAS']),
  );
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                         the manual push: the 200                           */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualAmazon — 200, ONE named price task per sendable SKU', () => {
  it('★ one produto, one link ⇒ ONE task NAMED by its own fields on the jobs queue, the payload EXACTLY its identities, the consent and the request’s clock; the row naming the produto', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('p1')));
    // ★ The RAW body, EXACTLY these keys (the schema strips unknown ones).
    expect(corpo).toEqual({
      listings: [
        {
          produtoId: 'p1',
          produtoNome: 'Produto p1',
          sku: 'SKU-1',
          resultado: 'enviado',
          mensagem: MSG.enfileirado,
        },
      ],
      produtosSemEnvio: [],
      pausadoAte: null,
    });
    const payload = {
      v: 1,
      tipo: 'preco-sku',
      contaId: CONTA,
      sku: 'SKU-1',
      origem: 'manual',
      referencia: REFERENCIA,
      parte: null,
      baixarPreco: false,
      solicitadoEmMs: AGORA_MS,
      codigosAntes: [],
    };
    expect(filaPreco.enfileiradas).toEqual([
      {
        tarefa: payload,
        opcoes: { id: nomeDaTarefaPrecoAmazon(payload as TarefaPrecoSkuAmazon) },
      },
    ]);
    expect(fake.escritas).toEqual([]);
  });

  it('★ (mutation 3) every task carries identities, `baixarPreco` and `solicitadoEmMs` only — no price field, and no produto price is ever READ', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    vinculo('p1', 'SKU-2');
    const corpo = ok(await enviar(corpoDe('p1')));
    for (const t of tarefas()) {
      expect(Object.keys(t).sort()).toEqual(
        [
          'baixarPreco',
          'codigosAntes',
          'contaId',
          'origem',
          'parte',
          'referencia',
          'sku',
          'solicitadoEmMs',
          'tipo',
          'v',
        ].sort(),
      );
    }
    // ★ Neither a stored price nor a mask on `precos` (nested or whole).
    const lido = JSON.stringify([fake.leiturasDetalhadas, fake.consultas]);
    expect(lido).not.toContain('precos');
    expect(JSON.stringify([corpo, filaPreco.enfileiradas])).not.toMatch(/123\.45|99\.9|preco"/);
  });

  it('★ the reads are exactly the conta (masked to its gate and normal tabela), the produto, its children and the partitions — every one masked or projected, no estoque', async () => {
    semearConta();
    produto('p1');
    fake.seed('produtos/p1/estoques/e1', { quantidade: 7 });
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    // ★ The masks as LITERALS, never the module's own constants.
    expect(fake.leiturasDetalhadas).toEqual([
      expect.objectContaining({
        caminho: CAMINHO_CONTA,
        via: 'getAll',
        mascara: ['tipo', 'ativo', 'tabelaNormalOuterRef'],
      }),
      expect.objectContaining({
        caminho: 'produtos/p1',
        via: 'getAll',
        mascara: ['paiId', 'nome'],
      }),
    ]);
    expect([...CAMPOS_CONTA_ROTA_PRECO_AMAZON]).toEqual(['tipo', 'ativo', 'tabelaNormalOuterRef']);
    expect(fake.consultas.map((c) => c.colecao).sort()).toEqual([
      'produtos',
      'produtos/p1/prodAmazon',
    ]);
    expect(JSON.stringify(fake.consultas)).not.toContain('estoques');
  });

  it('★ (mutation 5) `baixarPreco: true` rides every task; ABSENT it is `false`, never true', async () => {
    familiaCom(2);
    ok(await enviar({ ...corpoDe('p1'), baixarPreco: true }));
    expect(tarefas().map((t) => t.baixarPreco)).toEqual([true, true]);
    filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
    ok(await enviar(corpoDe('p1'), { gerarReferencia: () => 'req-2' }));
    expect(tarefas().map((t) => t.baixarPreco)).toEqual([false, false]);
    filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
    ok(await enviar({ ...corpoDe('p1'), baixarPreco: false }, { gerarReferencia: () => 'req-3' }));
    expect(tarefas().map((t) => t.baixarPreco)).toEqual([false, false]);
  });

  it('★ a family anchor’s CHILDREN’s links are found, in BOTH stored conta ref forms; another conta’s link is not (NEAR-MISS: the same SKU shape under another conta)', async () => {
    semearConta();
    produto('ancora');
    produto('filho-a', { paiId: 'ancora' });
    produto('filho-b', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-ANCORA');
    vinculo('filho-a', 'SKU-A', { conta: REF_CONTA_NUA });
    vinculo('filho-b', 'SKU-B');
    vinculo('filho-b', 'SKU-OUTRA', { conta: 'documents/integracao/outra-conta' });
    const corpo = ok(await enviar(corpoDe('ancora')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku])).toEqual([
      ['ancora', 'SKU-A'],
      ['ancora', 'SKU-ANCORA'],
      ['ancora', 'SKU-B'],
    ]);
    expect(tarefas().map((t) => t.sku)).toEqual(['SKU-A', 'SKU-ANCORA', 'SKU-B']);
  });

  it('★ (mutation 4) a selected variation CHILD hops ONE paiId level: the rows name the ANCHOR, with the anchor’s own name (NEAR-MISS: answered by itself it would have no listing)', async () => {
    semearConta();
    produto('ancora', { nome: 'Camiseta' });
    produto('filho', { paiId: 'ancora', nome: 'Camiseta P' });
    vinculo('ancora', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('filho')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'ancora',
        produtoNome: 'Camiseta',
        sku: 'SKU-1',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
    expect(tarefas().map((t) => t.sku)).toEqual(['SKU-1']);
  });

  it('a produto with no document, a child whose parent has none, and a family with no listing of the conta are each answered under their OWN id', async () => {
    semearConta();
    produto('filho', { paiId: 'sumiu' });
    produto('sozinho');
    vinculo('sozinho', 'SKU-OUTRA', { conta: 'documents/integracao/outra-conta' });
    const corpo = ok(await enviar(corpoDe('nao-existe', 'filho', 'sozinho')));
    expect(corpo).toEqual({
      listings: [],
      produtosSemEnvio: [
        { produtoId: 'nao-existe', produtoNome: null, mensagem: MSG['produto-ausente'] },
        { produtoId: 'filho', produtoNome: 'Produto filho', mensagem: MSG['pai-ausente'] },
        { produtoId: 'sozinho', produtoNome: 'Produto sozinho', mensagem: MSG['sem-vinculo'] },
      ],
      pausadoAte: null,
    });
    expect(produtoresConstruidos).toBe(0);
  });

  it('★ the same request twice (the same reference) is ONE task per SKU: the second finds the names held', async () => {
    familiaCom(2);
    ok(await enviar(corpoDe('p1')));
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['enviado', 'enviado']);
    expect(filaPreco.enfileiradas).toHaveLength(2);
    expect(linhasPreco().at(-1)).toMatchObject({ enfileirados: 0, jaEnfileirados: 2 });
    // A name already held IS on the queue: the line says so (NEAR-MISS against `nada-enfileirado`).
    expect(linhasPreco().at(-1)).toMatchObject({ resultado: 'enfileirado' });
  });

  it('★ a SKU two selected anchors share is ONE task and counted ONCE by the switch, while each anchor answers its own row for it, the anchors in REQUEST order (NEAR-MISS: 20 SKUs shared by both ⇒ 200 and 20 tasks, never 400)', async () => {
    semearConta();
    produto('zeta');
    produto('alfa');
    vinculo('zeta', 'SKU-ZETA');
    vinculo('zeta', 'SKU-X');
    vinculo('alfa', 'SKU-ALFA');
    vinculo('alfa', 'SKU-X');
    const corpo = ok(await enviar(corpoDe('zeta', 'alfa')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
      ['zeta', 'SKU-X', 'enviado'],
      ['zeta', 'SKU-ZETA', 'enviado'],
      ['alfa', 'SKU-ALFA', 'enviado'],
      ['alfa', 'SKU-X', 'enviado'],
    ]);
    expect(tarefas().map((t) => t.sku)).toEqual(['SKU-X', 'SKU-ZETA', 'SKU-ALFA']);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({
        produtos: 2,
        ancoras: 2,
        anuncios: 3,
        enviaveis: 3,
        enfileirados: 3,
        jaEnfileirados: 0,
      }),
    ]);

    fake = new FakeDb();
    lerDb.mockImplementation(() => asDb(fake));
    filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
    semearConta();
    produto('zeta');
    produto('alfa');
    for (let i = 0; i < 20; i += 1) {
      vinculo('zeta', sku(i));
      vinculo('alfa', sku(i));
    }
    const compartilhado = ok(
      await enviar(corpoDe('zeta', 'alfa'), { gerarReferencia: () => 'req-2' }),
    );
    expect(compartilhado.listings).toHaveLength(40);
    expect(tarefas()).toHaveLength(20);
    expect(linhasPreco().at(-1)).toMatchObject({ anuncios: 20, enviaveis: 20 });
  });

  it('★ duplicate ids are read ONCE: the selection gets the deduplicated list, so a body of repeated ids never multiplies the reads', async () => {
    familiaCom(1);
    ok(await enviar(corpoDe('p1', 'p1', 'p1')));
    expect(fake.leituras.filter((c) => c === 'produtos/p1')).toHaveLength(1);
    expect(tarefas()).toHaveLength(1);
  });

  it('the line counts produtos and anchors apart: a child and its anchor selected are 2 produtos and ONE anchor, its row answered once', async () => {
    semearConta();
    produto('ancora');
    produto('filho', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('filho', 'ancora')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku])).toEqual([['ancora', 'SKU-1']]);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({ produtos: 2, ancoras: 1, anuncios: 1, enviaveis: 1 }),
    ]);
  });

  it('a generated reference outside the feed core’s grammar is a bug: RangeError, nothing enqueued', async () => {
    familiaCom(1);
    await expect(enviar(corpoDe('p1'), { gerarReferencia: () => 'a:b' })).rejects.toThrow(
      RangeError,
    );
    expect(produtoresConstruidos).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                     the manual push: per SKU and the switch                */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualAmazon — per SKU, then THE SWITCH on the sendable SKUs', () => {
  it('★ 40 code points ⇒ enviado; 41 ⇒ `pulado` “fora do formato” (NEAR-MISS pair): the route never answers enviado for a SKU the task refuses', async () => {
    const quarenta = 'S'.repeat(40);
    const quarentaEUm = 'S'.repeat(41);
    semearConta();
    produto('p1');
    vinculo('p1', quarenta);
    vinculo('p1', quarentaEUm);
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => [l.sku.length, l.resultado, l.mensagem])).toEqual([
      [40, 'enviado', MSG.enfileirado],
      [41, 'pulado', MSG['fora-do-formato']],
    ]);
    expect(tarefas().map((t) => t.sku)).toEqual([quarenta]);
    // Why the GRAMMAR is asked, not the payload: the payload's bound alone
    // (80 UTF-16 units) would carry the 41-code-point SKU, which the task's
    // valve then refuses as an invalid target.
    expect(
      tarefaPrecoSkuAmazonSchema.safeParse({ ...tarefas()[0], sku: quarentaEUm }).success,
    ).toBe(true);
    expect(alvoValido(FLUXO_AMAZON.preco, quarentaEUm)).toBe(false);
  });

  it('★ a SKU with a control character ⇒ `pulado` fora do formato; 40 astral code points (80 units) ⇒ enviado', async () => {
    const astral = String.fromCodePoint(0x1f600).repeat(40);
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU\t1', { id: 'l-tab' });
    vinculo('p1', astral, { id: 'l-astral' });
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => [l.sku, l.resultado])).toEqual([
      ['SKU\t1', 'pulado'],
      [astral, 'enviado'],
    ]);
    expect(tarefas().map((t) => t.sku)).toEqual([astral]);
  });

  it('★ no listings path (a SKU holding `/`) ⇒ `pulado` “sem caminho”, nothing enqueued, the producer never built', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'a/b', { id: 'l-barra' });
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'p1',
        produtoNome: 'Produto p1',
        sku: 'a/b',
        resultado: 'pulado',
        mensagem: MSG['sem-caminho'],
      },
    ]);
    expect(produtoresConstruidos).toBe(0);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({ resultado: 'nada-enfileirado', pulados: 1, enviaveis: 0 }),
    ]);
  });

  it(`★ (mutation 2) ${String(LIMIAR_FEED_PRECO_AMAZON)} sendable SKUs ⇒ ${String(LIMIAR_FEED_PRECO_AMAZON)} named tasks; ${String(LIMIAR_FEED_PRECO_AMAZON + 1)} ⇒ 400 and ZERO tasks, the producer never built (NEAR-MISS pair)`, async () => {
    familiaCom(LIMIAR_FEED_PRECO_AMAZON);
    ok(await enviar(corpoDe('p1')));
    expect(new Set(filaPreco.enfileiradas.map((e) => e.opcoes?.id)).size).toBe(30);
    expect(produtoresConstruidos).toBe(1);

    fake = new FakeDb();
    lerDb.mockImplementation(() => asDb(fake));
    filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
    produtoresConstruidos = 0;
    familiaCom(LIMIAR_FEED_PRECO_AMAZON + 1);
    const r = await enviar(corpoDe('p1'));
    expect(r.status).toBe(400);
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    expect(filaPreco.enfileiradas).toEqual([]);
    expect(produtoresConstruidos).toBe(0);
    expect(linhasPreco().at(-1)).toMatchObject({
      resultado: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      motivo: 'anuncios',
      anuncios: 31,
      enviaveis: 31,
    });
  });

  it('★ the switch counts SENDABLE SKUs only: 31 listings of which one is pathless ⇒ 30 tasks and ONE `pulado` row (NEAR-MISS against counting every listing)', async () => {
    familiaCom(LIMIAR_FEED_PRECO_AMAZON, ['x/y']);
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings).toHaveLength(31);
    expect(
      corpo.listings
        .filter((l) => l.resultado === RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.pulado)
        .map((l) => l.sku),
    ).toEqual(['x/y']);
    expect(tarefas()).toHaveLength(30);
  });

  it('the same holds for a SKU outside the grammar: 30 sendable plus a 41-code-point one ⇒ 200, 30 tasks', async () => {
    familiaCom(LIMIAR_FEED_PRECO_AMAZON, ['Z'.repeat(41)]);
    ok(await enviar(corpoDe('p1')));
    expect(tarefas()).toHaveLength(30);
  });

  it('★ a refusal’s `encontrados` counts the SENDABLE SKUs: 31 sendable plus a pathless one ⇒ 31, never 32 (NEAR-MISS against every listing)', async () => {
    familiaCom(LIMIAR_FEED_PRECO_AMAZON + 1, ['x/y']);
    const r = await enviar(corpoDe('p1'));
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    expect(linhasPreco()).toEqual([
      expect.objectContaining({ anuncios: 32, enviaveis: 31, pulados: 1 }),
    ]);
    expect(filaPreco.enfileiradas).toEqual([]);
  });

  it('★ the queue valve CLOSED ⇒ every sendable row `nao-tentado` “Fila de envio desligada.”, the producer never built, the region never resolved', async () => {
    familiaCom(1, ['a/b']);
    const regiao = vi.fn(() => {
      throw new MissingRegionError('sem região', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
    });
    const corpo = ok(await enviar(corpoDe('p1'), { filaDesligada: true, regiao }));
    expect(corpo.listings.map((l) => [l.sku, l.resultado, l.mensagem])).toEqual([
      ['SKU-000', 'nao-tentado', MSG['fila-desligada']],
      ['a/b', 'pulado', MSG['sem-caminho']],
    ]);
    expect(produtoresConstruidos).toBe(0);
    expect(regiao).not.toHaveBeenCalled();
    expect(espiao.linhas.filter((l) => l.meta?.evento === 'preco').map((l) => l.nivel)).toEqual([
      'warn',
    ]);
    expect(linhasPreco()[0]).toMatchObject({ motivo: 'fila-desligada', naoTentados: 1 });
  });

  it('the valve closing between the root’s read and the batch (the producer’s own class) ⇒ the same `nao-tentado` rows', async () => {
    familiaCom(2);
    produtorDesligado = true;
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => [l.resultado, l.mensagem])).toEqual([
      ['nao-tentado', MSG['fila-desligada']],
      ['nao-tentado', MSG['fila-desligada']],
    ]);
    expect(filaPreco.enfileiradas).toEqual([]);
  });

  it.each([
    ['reads that take the whole budget', ORCAMENTO_ENVIO_MANUAL_PRECO_MS, 'nao-tentado'],
    ['NEAR-MISS: reads one ms short of it', ORCAMENTO_ENVIO_MANUAL_PRECO_MS - 1, 'enviado'],
  ] as const)(
    '★ the 40-s budget is asked before each enqueue STARTS, from the request’s start: %s',
    async (_nome, gastoMs, esperado) => {
      familiaCom(1);
      const db = dbEspiado((caminho) => {
        if (caminho === 'produtos/p1') relogio += gastoMs;
      });
      const corpo = ok(await enviar(corpoDe('p1'), { db: () => db }));
      expect(corpo.listings.map((l) => l.resultado)).toEqual([esperado]);
      expect(filaPreco.enfileiradas).toHaveLength(esperado === 'enviado' ? 1 : 0);
      if (esperado === 'nao-tentado') {
        expect(corpo.listings[0]?.mensagem).toBe(MSG['orcamento-esgotado']);
      }
      // The consent window still counts from the request's start.
      for (const t of tarefas()) expect(t.solicitadoEmMs).toBe(AGORA_MS);
    },
  );

  it('★ a SLOW producer ⇒ no enqueue STARTS past the budget: the sent rows are a PREFIX, the rest its TAIL `nao-tentado` “Tempo esgotado”, and the queue holds exactly the rows answered `enviado`', async () => {
    const n = 20;
    familiaCom(n);
    const iniciadasEm: number[] = [];
    const enfileirar = filaPreco.fila.enqueue;
    filaPreco.fila.enqueue = (tarefa, opcoes) => {
      iniciadasEm.push(relogio);
      // Each enqueue takes 3 s of the route's clock (more than the batch's 16 in flight).
      relogio += 3_000;
      return enfileirar(tarefa, opcoes);
    };
    const corpo = ok(await enviar(corpoDe('p1')));
    const resultados = corpo.listings.map((l) => l.resultado);
    const enviados = resultados.filter(
      (r) => r === RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.enviado,
    ).length;
    expect(enviados).toBeGreaterThan(0);
    expect(enviados).toBeLessThan(n);
    // ★ The sent ones are a PREFIX; the rest, the tail, were never started.
    expect(resultados).toEqual([
      ...Array.from({ length: enviados }, () => 'enviado'),
      ...Array.from({ length: n - enviados }, () => 'nao-tentado'),
    ]);
    for (const l of corpo.listings.slice(enviados)) {
      expect(l.mensagem).toBe(MSG['orcamento-esgotado']);
    }
    // ★ What is on the queue is exactly what the answer calls `enviado`.
    expect(tarefas().map((t) => t.sku)).toEqual(
      corpo.listings
        .filter((l) => l.resultado === RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.enviado)
        .map((l) => l.sku),
    );
    // ★ The budget is asked before EACH start, never once for the batch.
    expect(iniciadasEm).toHaveLength(enviados);
    for (const t of iniciadasEm) {
      expect(t).toBeLessThan(AGORA_MS + ORCAMENTO_ENVIO_MANUAL_PRECO_MS);
    }
    expect(linhasPreco()).toEqual([
      expect.objectContaining({
        resultado: 'enfileirado',
        motivo: 'orcamento-esgotado',
        enfileirados: enviados,
        naoTentados: n - enviados,
      }),
    ]);
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['warn']);
  });
});

/* -------------------------------------------------------------------------- */
/*                   the manual push: the body, switch, region, conta         */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualAmazon — refusals before the selection', () => {
  it(`★ ${String(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON)} distinct produtos are accepted; ${String(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON + 1)} ⇒ 400 \`unidade: 'produtos'\`, NOTHING read (NEAR-MISS pair); duplicates count once`, async () => {
    semearConta();
    const cinquenta = Array.from({ length: 50 }, (_, i) => `p${String(i)}`);
    ok(await enviar(corpoDe(...cinquenta)));
    ok(await enviar(corpoDe(...cinquenta, 'p0')));
    const operacoes = fake.operacoes;
    const r = await enviar(corpoDe(...cinquenta, 'p50'));
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 50, unidade: 'produtos', encontrados: 51 },
    });
    expect(r.status).toBe(400);
    expect(fake.operacoes).toBe(operacoes);
  });

  it.each([
    ['a stray key', { ...corpoDe('p1'), reenviar: true }, ['reenviar']],
    [
      '`baixarPreco` as the STRING "true"',
      { ...corpoDe('p1'), baixarPreco: 'true' },
      ['baixarPreco'],
    ],
    ['`baixarPreco: null`', { ...corpoDe('p1'), baixarPreco: null }, ['baixarPreco']],
    ['`baixarPreco: 1`', { ...corpoDe('p1'), baixarPreco: 1 }, ['baixarPreco']],
    ['no produto', corpoDe(), ['produtoIds']],
    ['a produto id that is a path', corpoDe('a/b'), ['produtoIds.0']],
    [
      'a conta id outside its grammar',
      { integracaoId: 'a/b', produtoIds: ['p1'] },
      ['integracaoId'],
    ],
    ['no JSON', '{', ['(corpo)']],
    ['not an object', '[1]', ['(corpo)']],
  ] as const)(
    '★ %s ⇒ 400 AMAZON_PRECO_CORPO_INVALIDO naming the PATHS, the db never built',
    async (_nome, corpo, issues) => {
      semearConta();
      const r = await enviar(corpo);
      expect(r.status).toBe(400);
      expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO, issues });
      expect(lerDb).not.toHaveBeenCalled();
      expect(fake.operacoes).toBe(0);
    },
  );

  it('a body above 64 KiB ⇒ 400 `(corpo)`, nothing read', async () => {
    const r = await enviar(
      JSON.stringify({ ...corpoDe('p1'), x: 'y'.repeat(MAX_CORPO_ROTA_PRECO_BYTES) }),
    );
    expect(erroDe(r)).toMatchObject({ issues: ['(corpo)'] });
    expect(lerDb).not.toHaveBeenCalled();
  });

  it('★ the read switch off ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, ZERO Firestore operations, ONE blocked-call line', async () => {
    familiaCom(1);
    const r = await enviar(corpoDe('p1'), {
      ambiente: ambienteEspiado({ AMAZON_CHAMADAS: 'off' }),
    });
    expect(r.status).toBe(503);
    expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
    expect(espiao.linhas.map((l) => l.meta)).toEqual([
      expect.objectContaining({ evento: 'chamada-bloqueada', rota: ROTA_PRECO_AMAZON.envioManual }),
    ]);
  });

  it.each([
    [
      'unset',
      (): string => {
        throw new MissingRegionError('sem região', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
      },
      MissingRegionError,
      'AMAZON_TASKS_REGION/MissingRegionError',
    ],
    [
      'malformed',
      (): string => 'a/b',
      AmazonLotesRegiaoDaFilaInvalidaError,
      'AMAZON_TASKS_REGION/AmazonLotesRegiaoDaFilaInvalidaError',
    ],
  ] as const)(
    '★ the queue’s region %s (valve open) PROPAGATES before ANY Firestore read, after ONE ERROR line',
    async (_nome, regiao, classe, motivo) => {
      familiaCom(1);
      await expect(enviar(corpoDe('p1'), { regiao })).rejects.toBeInstanceOf(classe);
      expect(lerDb).not.toHaveBeenCalled();
      expect(linhasPreco()).toEqual([
        expect.objectContaining({ resultado: 'falhou', motivo, rota: 'enviar-precos' }),
      ]);
      expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
    },
  );

  it.each([
    ['absent', null],
    ['not an Amazon conta', { tipo: INTEGRACAO_TIPO.amazon + 1 }],
    ['inactive', { ativo: false }],
  ] as const)(
    '★ the conta %s ⇒ 404 AMAZON_PRECO_CONTA_NAO_ENCONTRADA, nothing of the selection read',
    async (_nome, over) => {
      if (over !== null) semearConta(over);
      produto('p1');
      vinculo('p1', 'SKU-1');
      const r = await enviar(corpoDe('p1'));
      expect(r.status).toBe(404);
      expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA });
      expect(fake.leituras).toEqual([CAMINHO_CONTA]);
      expect(fake.consultas).toEqual([]);
    },
  );

  it('NEAR-MISS: a conta with NO `ativo` field is active (only `false` refuses)', async () => {
    fake.seed(CAMINHO_CONTA, {
      tipo: INTEGRACAO_TIPO.amazon,
      tabelaNormalOuterRef: TABELA,
    });
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
  });

  it.each([
    ['no normal tabela', { tabelaNormalOuterRef: null }],
    ['a ref to ANOTHER collection', { tabelaNormalOuterRef: 'documents/depositos/abc' }],
    ['a deeper path', { tabelaNormalOuterRef: 'listaDePrecos/a/b' }],
    ['a non-string', { tabelaNormalOuterRef: 7 }],
  ] as const)(
    '★ %s ⇒ 400 AMAZON_PRECO_CONTA_SEM_TABELA_NORMAL (the ONE parse), nothing of the selection read',
    async (_nome, over) => {
      semearConta(over);
      produto('p1');
      vinculo('p1', 'SKU-1');
      const r = await enviar(corpoDe('p1'));
      expect(r.status).toBe(400);
      expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL });
      expect(fake.consultas).toEqual([]);
    },
  );

  it('NEAR-MISS: the bare ref form `listaDePrecos/<id>` IS a normal tabela', async () => {
    semearConta({ tabelaNormalOuterRef: 'listaDePrecos/abc' });
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
  });
});

/* -------------------------------------------------------------------------- */
/*                   the manual push: an enqueue that fails, and the line     */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualAmazon — an enqueue that fails, and the line', () => {
  it('★ a RAW SDK failure (permission-denied 403) leaves SANITIZED after ONE ERROR line: nothing of the answered body anywhere', async () => {
    familiaCom(1);
    filaPreco.estado.falha = () => falhaDoFunctions('permission-denied', 403);
    const err: unknown = await enviar(corpoDe('p1')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmazonPrecoEnfileiramentoFalhouError);
    expect((err as AmazonPrecoEnfileiramentoFalhouError).httpStatus).toBe(403);
    expect(inspect(err, { depth: 5 })).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(JSON.stringify(espiao.linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({
        resultado: 'falhou',
        motivo: expect.stringMatching(/^enfileiramento\//) as unknown,
      }),
    ]);
  });

  it('★ a Cloud Tasks transient PROPAGATES as it is (part of the batch may have landed), after ONE ERROR line', async () => {
    familiaCom(1);
    filaPreco.estado.falha = () => falhaDoFunctions('unavailable', 503);
    await expect(enviar(corpoDe('p1'))).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({
        resultado: 'falhou',
        motivo: 'enfileiramento/AmazonTarefasTransitoriasError',
      }),
    ]);
  });

  it('a failure no class names crosses UNTOUCHED, with no line of its own (rule 6)', async () => {
    familiaCom(1);
    const bug = new TypeError('teste: um bug');
    filaPreco.estado.falha = () => bug;
    await expect(enviar(corpoDe('p1'))).rejects.toBe(bug);
    expect(linhasPreco()).toEqual([]);
  });

  it('NEAR-MISS: the jobs queue’s OWN valve class is answered, not thrown', async () => {
    familiaCom(1);
    filaPreco.estado.falha = () => new AmazonLotesTarefasDesligadasError();
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['nao-tentado']);
  });

  it("★ ONE `evento: 'preco'` line per answer: the route, the reference, the consent and the counts, never a SKU or a produto id", async () => {
    familiaCom(2, ['a/b']);
    ok(await enviar({ ...corpoDe('p1'), baixarPreco: true }));
    expect(espiao.linhas).toHaveLength(1);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({
        evento: 'preco',
        rota: 'enviar-precos',
        resultado: 'enfileirado',
        referencia: REFERENCIA,
        baixarPreco: true,
        produtos: 1,
        ancoras: 1,
        anuncios: 3,
        enviaveis: 2,
        enfileirados: 2,
        jaEnfileirados: 0,
        pulados: 1,
        naoTentados: 0,
        semEnvio: 0,
      }),
    ]);
    const texto = JSON.stringify(espiao.linhas);
    expect(texto).not.toContain('SKU-000');
    expect(texto).not.toContain('"p1"');
  });
});

/* -------------------------------------------------------------------------- */
/*                               the run's start                              */
/* -------------------------------------------------------------------------- */

describe('iniciarAtualizacaoPrecosAmazon — the claim, mapped', () => {
  it('★ no run ⇒ 202 `{ execucaoId, retomada: false }`, page 0 NAMED on the jobs queue, the run stored with the consent flags and the caller as `solicitadaPor`', async () => {
    semearConta();
    const r = await iniciar({ integracaoId: CONTA, baixarPreco: true });
    expect(r).toEqual({ status: 202, corpo: { execucaoId: NOVA, retomada: false } });
    expect(respostaInicioExecucaoPrecoAmazonSchema.safeParse(r.corpo).success).toBe(true);
    expect(filaPaginas.enfileiradas).toEqual([
      {
        tarefa: { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: NOVA, pagina: 0 },
        opcoes: { id: nomePaginaPrecoAmazon(CONTA, NOVA, 0) },
      },
    ]);
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({
      execucaoId: NOVA,
      fase: 'paginando',
      baixarPreco: true,
      confirmarReducaoEmMassa: false,
      solicitadaPor: UID,
      iniciadaEmMs: AGORA_MS,
    });
    // The conta first, masked; the run masked to what the claim decides from.
    expect(fake.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      [CAMINHO_CONTA, ['tipo', 'ativo', 'tabelaNormalOuterRef']],
      [CAMINHO_RUN, [...CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON]],
    ]);
  });

  it('★ (mutations 5 and 8) both flags ABSENT ⇒ stored `false`; both true ⇒ stored true', async () => {
    semearConta();
    await iniciar({ integracaoId: CONTA });
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({
      baixarPreco: false,
      confirmarReducaoEmMassa: false,
    });
    fake.seed(CAMINHO_RUN, execucao({ fase: 'concluida' }));
    await iniciar({ integracaoId: CONTA, baixarPreco: true, confirmarReducaoEmMassa: true });
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({
      execucaoId: 'exec-nova-2',
      baixarPreco: true,
      confirmarReducaoEmMassa: true,
    });
  });

  it.each([
    [
      '★ `confirmarReducaoEmMassa` as the STRING "true"',
      { integracaoId: CONTA, confirmarReducaoEmMassa: 'true' },
      ['confirmarReducaoEmMassa'],
    ],
    [
      '`baixarPreco` as the STRING "true"',
      { integracaoId: CONTA, baixarPreco: 'true' },
      ['baixarPreco'],
    ],
    ['a stray key', { integracaoId: CONTA, produtoIds: ['p1'] }, ['produtoIds']],
    ['no conta', {}, ['integracaoId']],
  ] as const)('%s ⇒ 400 CORPO_INVALIDO, nothing read or claimed', async (_nome, corpo, issues) => {
    semearConta();
    const r = await iniciar(corpo);
    expect(r.status).toBe(400);
    expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO, issues });
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
  });

  it('★ a live run 10 min idle ⇒ 409 AMAZON_PRECO_EXECUCAO_EM_CURSO with ITS id: nothing written, nothing enqueued', async () => {
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS - 10 * MINUTO_MS }));
    const r = await iniciar({ integracaoId: CONTA });
    expect(r.status).toBe(409);
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId: EXEC,
    });
    expect(fake.escritas).toEqual([]);
    expect(filaPaginas.enfileiradas).toEqual([]);
  });

  it('★ a stalled live run (16 min) is RE-KICKED: 202 with the SAME id and `retomada: true`, the page named by the stall, nothing written', async () => {
    semearConta();
    const marco = AGORA_MS - 16 * MINUTO_MS;
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: marco, proximaPagina: 3 }));
    const r = await iniciar({ integracaoId: CONTA });
    expect(r).toEqual({ status: 202, corpo: { execucaoId: EXEC, retomada: true } });
    expect(filaPaginas.enfileiradas.map((e) => [e.tarefa.pagina, e.opcoes?.id])).toEqual([
      [3, nomeRetomadaPrecoAmazon(CONTA, EXEC, 3, marco)],
    ]);
    expect(fake.escritas).toEqual([]);
  });

  it('★ a re-kick CONTINUES the stalled run under its STORED flags and caller: the request’s `false` flags and uid are not applied, nothing written, and the status shows the flags that govern it', async () => {
    semearConta();
    const marco = AGORA_MS - 16 * MINUTO_MS;
    fake.seed(
      CAMINHO_RUN,
      execucao({
        progressoEmMs: marco,
        proximaPagina: 2,
        baixarPreco: true,
        confirmarReducaoEmMassa: true,
      }),
    );
    const r = await iniciar({
      integracaoId: CONTA,
      baixarPreco: false,
      confirmarReducaoEmMassa: false,
    });
    expect(r).toEqual({ status: 202, corpo: { execucaoId: EXEC, retomada: true } });
    expect(fake.escritas).toEqual([]);
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({
      execucaoId: EXEC,
      baixarPreco: true,
      confirmarReducaoEmMassa: true,
      solicitadaPor: 'uid-antigo',
    });
    expect((await status(`?integracaoId=${CONTA}`)).corpo).toMatchObject({
      execucaoId: EXEC,
      baixarPreco: true,
      confirmarReducaoEmMassa: true,
    });
  });

  it('★ a CANCELLED run is not live: the next start claims a NEW run (202 `retomada: false`, a new id, page 0 named by it), never re-kicks the cancelled one', async () => {
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS - 16 * MINUTO_MS }));
    expect((await cancelar({ integracaoId: CONTA })).corpo).toEqual({
      execucaoId: EXEC,
      fase: 'cancelada',
    });
    const r = await iniciar({ integracaoId: CONTA });
    expect(r).toEqual({ status: 202, corpo: { execucaoId: NOVA, retomada: false } });
    expect(filaPaginas.enfileiradas.map((e) => e.opcoes?.id)).toEqual([
      nomePaginaPrecoAmazon(CONTA, NOVA, 0),
    ]);
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({ execucaoId: NOVA, fase: 'paginando' });
  });

  it('★ (mutation 7) AMAZON_TASKS_DISABLED=1 ⇒ 503 AMAZON_PRECO_ENFILEIRAMENTO_FALHOU `fila-desligada`, ZERO Firestore writes and no run read (NEAR-MISS: unset ⇒ 202)', async () => {
    semearConta();
    const r = await iniciar({ integracaoId: CONTA }, { filaDesligada: true });
    expect(r.status).toBe(503);
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      motivo: 'fila-desligada',
      execucaoId: null,
    });
    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([CAMINHO_CONTA]);
    expect(produtoresConstruidos).toBe(0);

    const aberta = await iniciar({ integracaoId: CONTA });
    expect(aberta.status).toBe(202);
    expect(fake.escritas).toHaveLength(1);
  });

  it('page 0’s enqueue failing (a transient) ⇒ 503 `enfileiramento-incerto` with the claimed id; the run closed `falhou` by the claim', async () => {
    semearConta();
    filaPaginas.estado.falha = () => falhaDoFunctions('unavailable', 503);
    const r = await iniciar({ integracaoId: CONTA });
    expect(r.status).toBe(503);
    expect(erroDe(r)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      motivo: 'enfileiramento-incerto',
      execucaoId: NOVA,
    });
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({ execucaoId: NOVA, fase: 'falhou' });
  });

  it('the read switch off ⇒ 503, ZERO operations; the conta absent ⇒ 404, the run never read; no normal tabela ⇒ 400, nothing claimed', async () => {
    const desligada = await iniciar(
      { integracaoId: CONTA },
      { ambiente: ambienteEspiado({ AMAZON_CHAMADAS: '' }) },
    );
    expect(erroDe(desligada)).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(fake.operacoes).toBe(0);

    const ausente = await iniciar({ integracaoId: CONTA });
    expect(ausente.status).toBe(404);
    expect(fake.leituras).toEqual([CAMINHO_CONTA]);

    semearConta({ tabelaNormalOuterRef: null });
    const semTabela = await iniciar({ integracaoId: CONTA });
    expect(semTabela.status).toBe(400);
    expect(erroDe(semTabela)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL,
    });
    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).not.toContain(CAMINHO_RUN);
  });

  it('the queue’s region unset (valve open) PROPAGATES before any read, after ONE ERROR line; nothing claimed', async () => {
    semearConta();
    await expect(
      iniciar(
        { integracaoId: CONTA },
        {
          regiao: () => {
            throw new MissingRegionError('sem região', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
          },
        },
      ),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(fake.operacoes).toBe(0);
    expect(linhasPreco()).toEqual([
      expect.objectContaining({ rota: 'atualizar-precos', resultado: 'falhou' }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the status                                 */
/* -------------------------------------------------------------------------- */

describe('resumoAtualizacaoPrecosAmazon — the summary, mapped', () => {
  const consulta = `?integracaoId=${CONTA}`;

  it('★ no run ⇒ 404 AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA; nothing written, no lease read', async () => {
    semearConta();
    const r = await status(consulta);
    expect(r.status).toBe(404);
    expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA });
    expect(fake.leituras).toEqual([CAMINHO_CONTA, CAMINHO_RUN]);
    expect(fake.escritas).toEqual([]);
  });

  it('★ a live run 15 min without progress ⇒ `parada: true` (NEAR-MISS: 14 min ⇒ false), the summary as its schema says', async () => {
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS - 15 * MINUTO_MS }));
    const parada = await status(consulta);
    expect(parada.status).toBe(200);
    expect(resumoExecucaoPrecoAmazonSchema.safeParse(parada.corpo).success).toBe(true);
    expect(parada.corpo).toMatchObject({ execucaoId: EXEC, fase: 'paginando', parada: true });
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS - 14 * MINUTO_MS }));
    expect((await status(consulta)).corpo).toMatchObject({ parada: false });
    expect(fake.leiturasDetalhadas.find((l) => l.caminho === CAMINHO_RUN)?.mascara).toEqual([
      ...CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON,
    ]);
  });

  it('★ the price lease `enviado`, written 10 min ago ⇒ the feed in flight with its age', async () => {
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS }));
    fake.seed(CAMINHO_VEZ, {
      estado: 'enviado',
      execucaoId: 'lote-x',
      ateMs: AGORA_MS + HORA_MS,
      atualizadoEmMs: AGORA_MS - 10 * MINUTO_MS,
    });
    expect((await status(consulta)).corpo).toMatchObject({
      feedEmCurso: { estado: 'enviado', idadeMs: 10 * MINUTO_MS },
    });
  });

  it('★ a batch with no recorded end is `pendente` before `esperaLotesAteMs` and `sem-desfecho` at it (NEAR-MISS pair); a recorded end is shown as recorded', async () => {
    semearConta();
    const lotes = { '0': lote({ desfecho: 'concluido' }), '1': lote({ parteInicial: 1 }) };
    const estados = async (esperaLotesAteMs: number) => {
      fake.seed(
        CAMINHO_RUN,
        execucao({ fase: 'concluida', decisao: 'lotes', esperaLotesAteMs, lotes }),
      );
      const r = await status(consulta);
      if (r.status !== 200) throw new Error('esperado 200');
      return r.corpo.lotes.map((l) => [l.indice, l.estado]);
    };
    expect(await estados(AGORA_MS + 1)).toEqual([
      [0, 'concluido'],
      [1, 'pendente'],
    ]);
    expect(await estados(AGORA_MS)).toEqual([
      [0, 'concluido'],
      [1, 'sem-desfecho'],
    ]);
  });

  it.each([
    ['no integracaoId', '', ['integracaoId']],
    ['a stray parameter', `${consulta}&x=1`, ['x']],
    ['integracaoId twice', `${consulta}&integracaoId=${CONTA}`, ['integracaoId']],
    ['a conta id outside its grammar', '?integracaoId=a%2Fb', ['integracaoId']],
  ] as const)(
    '%s ⇒ 400 CORPO_INVALIDO naming the PATHS, nothing read',
    async (_nome, q, issues) => {
      semearConta();
      const r = await status(q);
      expect(r.status).toBe(400);
      expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO, issues });
      expect(fake.operacoes).toBe(0);
    },
  );

  it('the read switch off ⇒ 503, ZERO operations; the conta absent ⇒ 404 CONTA_NAO_ENCONTRADA, never the run’s 404', async () => {
    fake.seed(CAMINHO_RUN, execucao());
    const r = await status(consulta, { ambiente: ambienteEspiado({}) });
    expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(fake.operacoes).toBe(0);
    const ausente = await status(consulta);
    expect(erroDe(ausente)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA });
    expect(fake.leituras).toEqual([CAMINHO_CONTA]);
  });

  it('★ a conta whose normal tabela is gone still SHOWS its run (the view sends nothing; NEAR-MISS: the start route refuses the same conta)', async () => {
    semearConta({ tabelaNormalOuterRef: null });
    fake.seed(
      CAMINHO_RUN,
      execucao({ fase: 'falhou', motivo: 'sem-tabela-normal', progressoEmMs: AGORA_MS }),
    );
    const r = await status(consulta);
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ fase: 'falhou', motivo: 'sem-tabela-normal' });
    expect((await iniciar({ integracaoId: CONTA })).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the cancel                                 */
/* -------------------------------------------------------------------------- */

describe('cancelarAtualizacaoPrecosAmazon — the cancel, mapped', () => {
  const corpo = { integracaoId: CONTA };

  it('★ a `concluida` run with a PENDING batch ⇒ 200 `cancelada`, ONE write on the run', async () => {
    semearConta();
    fake.seed(
      CAMINHO_RUN,
      execucao({
        fase: 'concluida',
        decisao: 'lotes',
        esperaLotesAteMs: AGORA_MS + HORA_MS,
        lotes: { '0': lote() },
        progressoEmMs: AGORA_MS - 3 * HORA_MS,
      }),
    );
    const r = await cancelar(corpo);
    expect(r).toEqual({ status: 200, corpo: { execucaoId: EXEC, fase: 'cancelada' } });
    expect(respostaCancelamentoExecucaoPrecoAmazonSchema.safeParse(r.corpo).success).toBe(true);
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({ fase: 'cancelada' });
    expect(fake.escritasEm(CAMINHO_RUN)).toHaveLength(1);
    expect(fake.leiturasDetalhadas.find((l) => l.caminho === CAMINHO_RUN)?.mascara).toEqual([
      ...CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON,
    ]);
  });

  it.each([
    ['decided `tarefas` 10 min ago', 'cancelada', 10 * MINUTO_MS, 1],
    [
      'NEAR-MISS: decided 2 h 1 min ago, every batch ended',
      'concluida',
      2 * HORA_MS + MINUTO_MS,
      0,
    ],
  ] as const)(
    '★ (mutation 9) a `concluida` run %s ⇒ 200 `%s`',
    async (_nome, fase, idadeMs, escritas) => {
      semearConta();
      fake.seed(
        CAMINHO_RUN,
        execucao({
          fase: 'concluida',
          decisao: 'tarefas',
          lotes: { '0': lote({ desfecho: 'concluido' }) },
          progressoEmMs: AGORA_MS - idadeMs,
        }),
      );
      const r = await cancelar(corpo);
      expect(r).toEqual({ status: 200, corpo: { execucaoId: EXEC, fase } });
      expect(fake.escritasEm(CAMINHO_RUN)).toHaveLength(escritas);
    },
  );

  it('a live (`paginando`) run ⇒ 200 `cancelada`', async () => {
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS }));
    expect(await cancelar(corpo)).toEqual({
      status: 200,
      corpo: { execucaoId: EXEC, fase: 'cancelada' },
    });
  });

  it('★ no run ⇒ 404 AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA, nothing written', async () => {
    semearConta();
    const r = await cancelar(corpo);
    expect(r.status).toBe(404);
    expect(erroDe(r)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA });
    expect(fake.escritas).toEqual([]);
  });

  it('a stray key ⇒ 400, nothing read; the read switch off ⇒ 503, nothing read; the conta absent ⇒ 404 before the run', async () => {
    fake.seed(CAMINHO_RUN, execucao());
    const estranho = await cancelar({ ...corpo, forcar: true });
    expect(erroDe(estranho)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO,
      issues: ['forcar'],
    });
    const desligada = await cancelar(corpo, {
      ambiente: ambienteEspiado({ AMAZON_CHAMADAS: 'ON' }),
    });
    expect(erroDe(desligada)).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(fake.operacoes).toBe(0);
    const ausente = await cancelar(corpo);
    expect(erroDe(ausente)).toMatchObject({ code: CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA });
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({ fase: 'paginando' });
  });

  it('★ a conta whose normal tabela is gone can still STOP its run (NEAR-MISS: the start route refuses it)', async () => {
    semearConta({ tabelaNormalOuterRef: 'documents/depositos/x' });
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS }));
    expect((await cancelar(corpo)).status).toBe(200);
    expect(fake.ler(CAMINHO_RUN)).toMatchObject({ fase: 'cancelada' });
  });
});

/* -------------------------------------------------------------------------- */
/*                            the closed code set                             */
/* -------------------------------------------------------------------------- */

describe('★ CODIGO_ERRO_PRECO_AMAZON is answered EXHAUSTIVELY by the routes', () => {
  it('every code has ONE status, and every code is reached, with that status, by a route scenario', async () => {
    expect(Object.keys(STATUS_DO_CODIGO_PRECO_AMAZON).sort()).toEqual(
      Object.values(CODIGO_ERRO_PRECO_AMAZON).sort(),
    );
    const vistos = new Map<string, number>();
    const anotar = (r: { readonly status: number; readonly corpo: unknown }) => {
      const e = erroPrecoAmazonSchema.parse(r.corpo);
      vistos.set(e.code, r.status);
    };
    anotar(await enviar({ integracaoId: CONTA }));
    anotar(await enviar(corpoDe(...Array.from({ length: 51 }, (_, i) => `p${String(i)}`))));
    anotar(await enviar(corpoDe('p1')));
    semearConta({ tabelaNormalOuterRef: null });
    anotar(await enviar(corpoDe('p1')));
    semearConta();
    fake.seed(CAMINHO_RUN, execucao({ progressoEmMs: AGORA_MS }));
    anotar(await iniciar({ integracaoId: CONTA }));
    anotar(await iniciar({ integracaoId: CONTA }, { filaDesligada: true }));
    fake.apagar(CAMINHO_RUN);
    anotar(await status(`?integracaoId=${CONTA}`));
    expect(new Set(vistos.keys())).toEqual(new Set(Object.values(CODIGO_ERRO_PRECO_AMAZON)));
    for (const [code, s] of vistos) {
      expect(s, code).toBe(
        STATUS_DO_CODIGO_PRECO_AMAZON[code as keyof typeof STATUS_DO_CODIGO_PRECO_AMAZON],
      );
    }
  });
});
