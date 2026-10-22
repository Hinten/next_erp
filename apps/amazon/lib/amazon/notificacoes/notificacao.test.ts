/**
 * The Amazon notification pipeline, offline, through the REAL shared core
 * (`@delfrance/data/admin/notifications`), the real routing read, the real
 * context loader, the real park and the real `escreverAviso`, against the fake
 * Firestore. The importer is a fake; the network is forbidden (`fetchProibido`)
 * except where a test scripts one LWA answer through the fetch spy (D11: no test
 * reaches Amazon).
 */
import { format, inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type CodigoErroLwa,
  type ContextoRequisicaoAmazon,
  URL_TOKEN_LWA,
} from '@delfrance/integrations-amazon-sp-api';
import {
  CONTA_ID_AMAZON_REGEX,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import { chaveReconexao, chaveSegredoRecusado } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import type { ContextoAmazon } from '../core/contexto';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
  EstacionamentoAmazonEmConflitoError,
} from '../core/erros';
import { ID_DE_CONTA } from '../core/idConta';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  AUTORIZADO_EM_MS,
  REFRESH_TOKEN_A,
  SPID_A,
  SPID_B,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  espiaoDeFetch,
  linhasDeChamada,
  loggerEspiao,
  refDe,
  seedConta,
  seedCredencial,
  textoDe,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  DESTINO_TIPO_AMAZON,
  FILA_LEITURA_AMAZON,
  FalhaTarefaAmazonError,
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  MOTIVO_ADIAMENTO_AMAZON,
  TASK_MAX_ATTEMPTS,
  type DepsExecucaoAmazon,
  type DepsLeituraAmazon,
  type ImportadorPedidoAmazon,
  type PayloadNotificacaoAmazon,
  type ResultadoNotificacaoAmazon,
  camposDoDocumentoAmazon,
  camposDoRegistroDaTarefaAmazon,
  classificarFalhaDaTarefaAmazon,
  dedupKeyAmazon,
  docIdNotificacaoAmazon,
  importadorPedidoAmazon,
  persistirFalhaNotificacaoAmazon,
  processarNotificacaoAmazon,
  reprocessarAdiadasAmazon,
  reprocessarNotificacoesAmazon,
  sanitizarFalhaDaTarefaAmazon,
  toDispositionAmazon,
  tratarTarefaLeituraAmazon,
} from './notificacao';

const ID = 'conta-1';
const OUTRA = 'conta-2';
const COLECAO = 'notificacoesAmazon';
const PEDIDO = '000-0000000-0000001';
const NOTIFICACAO = '00000000-0000-0000-0000-000000000001';
const REF_ATUAL = refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS);

let db: FakeDb;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  db = new FakeDb();
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/** Every unscripted `fetch` is a failure: D11, and no test touches the network. */
const chamadasDeRede: string[] = [];
const fetchProibido: typeof globalThis.fetch = (input) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
};
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function push(over: Partial<Extract<PayloadNotificacaoAmazon, { origem: 'push' }>> = {}) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: SPID_A,
    amazonOrderId: PEDIDO,
    notificationId: NOTIFICACAO,
    publishTimeMs: AGORA_MS - 1000,
    ...over,
  } satisfies PayloadNotificacaoAmazon;
}

function poll(over: Partial<Extract<PayloadNotificacaoAmazon, { origem: 'poll' }>> = {}) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: SPID_A,
    amazonOrderId: PEDIDO,
    contaId: ID,
    lastUpdatedUs: AGORA_MS * 1000 + 123,
    ...over,
  } satisfies PayloadNotificacaoAmazon;
}

const caminhoDe = (p: PayloadNotificacaoAmazon) => `${COLECAO}/${docIdNotificacaoAmazon(p)}`;

function depsLeitura(over: Partial<DepsLeituraAmazon> = {}) {
  const log = loggerEspiao();
  const deps: DepsLeituraAmazon = {
    ambiente: AMBIENTE_LIGADO,
    agora: () => AGORA_MS,
    logger: log.logger,
    importador: null,
    increment,
    fetch: fetchProibido,
    ...over,
  };
  return { deps, linhas: log.linhas };
}

function depsExec(over: Partial<DepsLeituraAmazon> = {}, tentativa = 0) {
  const { deps, linhas } = depsLeitura(over);
  const exec: DepsExecucaoAmazon & {
    readonly registro: {
      readonly fluxo: 'intake';
      readonly tentativa: number;
      readonly idTarefa: string;
    };
  } = { ...deps, registro: { fluxo: 'intake', tentativa, idTarefa: 'tarefa-1' } };
  return { deps: exec, linhas };
}

const importa: ImportadorPedidoAmazon = () => Promise.resolve({ kind: 'importado' });
const falhaCom =
  (err: unknown): ImportadorPedidoAmazon =>
  () =>
    Promise.reject(err);

/** A conta that routes: active, bound to `spid`, with a valid credential. */
function contaConectada(
  id = ID,
  spid: string = SPID_A,
  over: Parameters<typeof seedConta>[2] = {},
) {
  seedConta(db, id, { selling_partner_id: spid, ...over });
  seedCredencial(db, id);
}

/** A failure document as the shared store leaves it. */
function seedNotificacao(p: PayloadNotificacaoAmazon, over: Record<string, unknown> = {}): string {
  const caminho = caminhoDe(p);
  db.seed(caminho, {
    ...camposDoDocumentoAmazon(p),
    status: 'failed',
    tentativas: 0,
    erro: null,
    processedAt: 0,
    ...over,
  });
  return caminho;
}

/* --------------------------- the request contexts ------------------------- */

const CTX_SP: ContextoRequisicaoAmazon = {
  destino: 'sp-api',
  operacao: 'getOrder',
  metodo: 'GET',
  caminho: `/orders/2026-01-01/orders/${PEDIDO}`,
  correlationId: 'corr-1',
  requestIdAmazon: null,
  refCredencial: REF_ATUAL,
};
const CTX_LWA: ContextoRequisicaoAmazon = {
  ...CTX_SP,
  destino: 'lwa',
  operacao: 'trocarRefreshToken',
  metodo: 'POST',
  caminho: '/auth/o2/token',
};

const spApiAuth = (status: number) => new AmazonAuthError({ ...CTX_SP, status, codigoLwa: null });
const lwaAuth = (codigoLwa: CodigoErroLwa | null, status = 400, ref = REF_ATUAL) =>
  new AmazonAuthError({ ...CTX_LWA, refCredencial: ref, status, codigoLwa });
const http = (status: number) => new AmazonHttpError({ ...CTX_SP, status });
const throttle = () => new AmazonThrottleError({ ...CTX_SP, status: 429, limiteTaxa: null });

/* -------------------------------------------------------------------------- */

describe('the queue and the importer seam', () => {
  it('the reads queue is named for its function, and the seam is EMPTY in step 3', () => {
    expect(FILA_LEITURA_AMAZON).toBe('filaLeituraAmazon');
    expect(importadorPedidoAmazon()).toBeNull();
    expect(Object.keys(DESTINO_TIPO_AMAZON)).toEqual([TIPO_TAREFA_AMAZON.pedido]);
  });

  it('the conta-id grammar restated in @delfrance/schemas is the app’s, byte for byte', () => {
    expect(CONTA_ID_AMAZON_REGEX.source).toBe(ID_DE_CONTA.source);
    expect(CONTA_ID_AMAZON_REGEX.flags).toBe(ID_DE_CONTA.flags);
  });
});

describe('the doc id — built from validated parts', () => {
  it('push ⇒ push:<NotificationId>; poll ⇒ poll:<conta>:<order>:<µs>', () => {
    expect(docIdNotificacaoAmazon(push())).toBe(`push:${NOTIFICACAO}`);
    expect(docIdNotificacaoAmazon(poll({ lastUpdatedUs: 1_800_000_000_000_123 }))).toBe(
      `poll:${ID}:${PEDIDO}:1800000000000123`,
    );
  });

  it('★ near-miss: two poll ids 1 µs apart are two ids (a later change is a NEW row)', () => {
    const a = docIdNotificacaoAmazon(poll({ lastUpdatedUs: 1_800_000_000_000_000 }));
    const b = docIdNotificacaoAmazon(poll({ lastUpdatedUs: 1_800_000_000_000_001 }));
    expect(a).not.toBe(b);
  });

  it('★ push and poll ids never collide: a push id spelling a poll id gets the push: prefix', () => {
    const idPoll = docIdNotificacaoAmazon(poll());
    const idPush = docIdNotificacaoAmazon(push({ notificationId: idPoll }));
    expect(idPush).toBe(`push:${idPoll}`);
    expect(idPush).not.toBe(idPoll);
  });

  it('★ a NotificationId of `..` or `__x__` yields a safe id, never a reserved one', () => {
    expect(docIdNotificacaoAmazon(push({ notificationId: '..' }))).toBe('push:..');
    expect(docIdNotificacaoAmazon(push({ notificationId: '.' }))).toBe('push:.');
    expect(docIdNotificacaoAmazon(push({ notificationId: '__x__' }))).toBe('push:__x__');
    for (const id of ['..', '.', '__x__']) {
      const docId = docIdNotificacaoAmazon(push({ notificationId: id }));
      expect(docId).not.toMatch(/^__.*__$/);
      expect(docId).not.toContain('/');
    }
  });

  it('a payload the task schema refuses is never turned into an id (a nested path)', () => {
    expect(() => docIdNotificacaoAmazon(push({ notificationId: 'a/b' }))).toThrow(TypeError);
    expect(() => docIdNotificacaoAmazon(poll({ contaId: 'a/b' }))).toThrow(TypeError);
  });
});

describe('the dedup key — the ORDER, whatever origin named it (§3 decision 10)', () => {
  it('is exactly <sellerId>:<amazonOrderId>, and push and poll of one order share it', () => {
    expect(dedupKeyAmazon(push())).toBe(`${SPID_A}:${PEDIDO}`);
    expect(dedupKeyAmazon(poll())).toBe(dedupKeyAmazon(push()));
    // Neither the notification id nor the stamp nor the conta is in it.
    expect(dedupKeyAmazon(push({ notificationId: 'outra' }))).toBe(dedupKeyAmazon(push()));
    expect(dedupKeyAmazon(poll({ lastUpdatedUs: 1, contaId: OUTRA }))).toBe(dedupKeyAmazon(poll()));
  });

  it('★ near-miss: `s1` + an order and `s1:` + an order never alias, and a seller holding `:` stays injective', () => {
    const vendedores = ['s1', 's1:', 's1:0', 'A:B', 'A', ':A', 'AB'];
    const pedidos = [PEDIDO, '000-0000000-0000010', '100-0000000-0000001'];
    const chaves = vendedores.flatMap((sellerId) =>
      pedidos.map((amazonOrderId) => dedupKeyAmazon(push({ sellerId, amazonOrderId }))),
    );
    expect(new Set(chaves).size).toBe(vendedores.length * pedidos.length);
  });

  it('near-miss: another seller or another order is another key', () => {
    expect(dedupKeyAmazon(push({ sellerId: SPID_B }))).not.toBe(dedupKeyAmazon(push()));
    expect(dedupKeyAmazon(push({ amazonOrderId: '000-0000000-0000002' }))).not.toBe(
      dedupKeyAmazon(push()),
    );
  });
});

describe('camposDoDocumentoAmazon — named one by one, never a spread', () => {
  it('★ a payload carrying an extra key stores exactly the named fields', () => {
    const extra = { ...push(), BuyerInfo: { BuyerEmail: 'x@example.com' }, contaId: ID };
    expect(camposDoDocumentoAmazon(extra)).toEqual({
      tipo: 'pedido',
      origem: 'push',
      sellerId: SPID_A,
      amazonOrderId: PEDIDO,
      notificationId: NOTIFICACAO,
      publishTimeMs: AGORA_MS - 1000,
    });
    const extraPoll = { ...poll(), notificationId: 'x', segredo: 'y' };
    expect(Object.keys(camposDoDocumentoAmazon(extraPoll)).sort()).toEqual(
      ['amazonOrderId', 'contaId', 'lastUpdatedUs', 'origem', 'sellerId', 'tipo'].sort(),
    );
  });
});

describe('toDispositionAmazon — total, phase-independent', () => {
  const casos: [ResultadoNotificacaoAmazon, ReturnType<typeof toDispositionAmazon>][] = [
    [{ kind: 'importado' }, { kind: 'resolve', label: 'importado' }],
    [
      { kind: 'conta-inexistente' },
      { kind: 'drop', reason: 'conta-inexistente', label: 'conta-inexistente' },
    ],
    [
      { kind: 'vendedor-mudou' },
      { kind: 'drop', reason: 'vendedor-mudou', label: 'vendedor-mudou' },
    ],
    [
      { kind: 'adiado', motivo: 'importador-ausente' },
      { kind: 'defer', reason: 'adiado/importador-ausente' },
    ],
    [{ kind: 'pedido-inexistente' }, { kind: 'park', reason: 'pedido-inexistente' }],
    [
      { kind: 'recusa-deterministica', classe: 'AmazonHttpError', status: 400 },
      { kind: 'park', reason: 'recusa-deterministica/AmazonHttpError/400' },
    ],
    [
      { kind: 'recusa-deterministica', classe: 'ZodError', status: null },
      { kind: 'park', reason: 'recusa-deterministica/ZodError' },
    ],
  ];

  it.each(casos)('%o → %o', (resultado, esperado) => {
    expect(toDispositionAmazon(resultado)).toEqual(esperado);
  });

  it('every adiamento motivo DEFERS — none parks, none drops (#808)', () => {
    for (const motivo of Object.values(MOTIVO_ADIAMENTO_AMAZON)) {
      expect(toDispositionAmazon({ kind: 'adiado', motivo }).kind, motivo).toBe('defer');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                   The run                                  */
/* -------------------------------------------------------------------------- */

describe('the read switch — checked FIRST', () => {
  it.each([
    ['push', push()],
    ['poll', poll()],
  ] as const)(
    '★ %s, switch off ⇒ adiado/chamadas-desligadas with ZERO Firestore operations and one blocked line',
    async (_o, payload) => {
      contaConectada();
      const { deps, linhas } = depsExec({ ambiente: AMBIENTE_DESLIGADO, importador: importa });
      const r = await processarNotificacaoAmazon(asDb(db), payload, deps);
      expect(r).toEqual({ kind: 'adiado', motivo: 'chamadas-desligadas' });
      expect(db.operacoes).toBe(0);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]?.meta).toMatchObject({ evento: 'chamada-bloqueada', rota: 'intake' });
    },
  );

  it.each(['off', 'ON', ' on', 'on ', 'true', ''])(
    'only the exact `on` opens it — %j stays closed',
    async (valor) => {
      contaConectada();
      const { deps } = depsExec({
        ambiente: { ...AMBIENTE_LIGADO, AMAZON_CHAMADAS: valor },
        importador: importa,
      });
      expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
        kind: 'adiado',
        motivo: 'chamadas-desligadas',
      });
      expect(db.operacoes).toBe(0);
    },
  );

  it('the task with the switch off writes ONE deferred document and reads nothing', async () => {
    contaConectada();
    const { deps } = depsExec({ ambiente: AMBIENTE_DESLIGADO, importador: importa });
    const r = await tratarTarefaLeituraAmazon(asDb(db), push(), deps);
    expect(r.resultado).toBe('deferred');
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', caminhoDe(push())]]);
    expect(db.ler(caminhoDe(push()))).toMatchObject({
      status: 'deferred',
      erro: 'adiado/chamadas-desligadas',
      tentativas: 0,
    });
  });
});

describe('routing a push by seller (uncached, the declared composite, limit 2)', () => {
  it('★ no conta for the seller ⇒ adiado/sem-conta, and the importer never runs', async () => {
    let chamado = false;
    const { deps } = depsExec({
      importador: () => {
        chamado = true;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'sem-conta',
    });
    expect(chamado).toBe(false);
    expect(db.consultas).toEqual([
      {
        colecao: 'integracao',
        filtros: [
          ['tipo', 8],
          ['selling_partner_id', SPID_A],
          ['ativo', true],
        ],
        ordens: [],
        limite: 2,
        apos: null,
      },
    ]);
  });

  it('an INACTIVE conta of that seller does not route either ⇒ adiado/sem-conta', async () => {
    contaConectada(ID, SPID_A, { ativo: false });
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'sem-conta',
    });
  });

  it('★ two contas for one seller ⇒ adiado/vendedor-duplicado and ONE ERROR line naming both contas, never the seller', async () => {
    contaConectada(ID);
    contaConectada(OUTRA);
    let chamado = false;
    const { deps, linhas } = depsExec({
      importador: () => {
        chamado = true;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'vendedor-duplicado',
    });
    expect(chamado).toBe(false);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('error');
    expect(linhas[0]?.meta).toMatchObject({
      evento: 'tarefa',
      motivo: 'vendedor-duplicado',
      contas: `${ID},${OUTRA}`,
      fluxo: 'intake',
      idTarefa: 'tarefa-1',
      idNotificacao: docIdNotificacaoAmazon(push()),
    });
    expect(textoDe(linhas)).not.toContain(SPID_A);
  });

  it('★ exactly one ⇒ the run goes on with THAT conta', async () => {
    contaConectada(ID, SPID_A);
    contaConectada(OUTRA, SPID_B);
    let visto: ContextoAmazon | null = null;
    const { deps } = depsExec({
      importador: (_db, contexto) => {
        visto = contexto;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({ kind: 'importado' });
    expect((visto as ContextoAmazon | null)?.integracaoId).toBe(ID);
  });
});

describe('a poll names its conta', () => {
  it('runs on the payload’s conta with no routing query', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({ kind: 'importado' });
    expect(db.consultas.filter((c) => c.colecao === 'integracao')).toEqual([]);
  });

  it('a conta reconnected to ANOTHER seller ⇒ vendedor-mudou (dropped), and the importer never runs', async () => {
    contaConectada(ID, SPID_B);
    let chamado = false;
    const { deps } = depsExec({
      importador: () => {
        chamado = true;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({
      kind: 'vendedor-mudou',
    });
    expect(chamado).toBe(false);
    expect(toDispositionAmazon({ kind: 'vendedor-mudou' }).kind).toBe('drop');
  });

  it('★ near-miss: a STALE cached seller never drops a current poll — the copy is evicted and the context reloaded', async () => {
    // This instance caches the conta while it holds SPID_A…
    contaConectada(ID, SPID_A);
    const { deps: aquece } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), aquece)).toEqual({
      kind: 'importado',
    });
    // …then another instance reconnects it to SPID_B, and the poll lists under SPID_B.
    seedConta(db, ID, { selling_partner_id: SPID_B });
    const leiturasAntes = db.leituras.length;
    let visto: ContextoAmazon | null = null;
    const { deps } = depsExec({
      importador: (_db, contexto) => {
        visto = contexto;
        return Promise.resolve({ kind: 'importado' });
      },
    });

    const r = await tratarTarefaLeituraAmazon(asDb(db), poll({ sellerId: SPID_B }), deps);

    expect(r).toMatchObject({ resultado: 'done', detalhe: 'importado', contaId: ID });
    // The importer runs on the FRESH copy, never on the stale one.
    expect((visto as ContextoAmazon | null)?.conta.selling_partner_id).toBe(SPID_B);
    // Anti-vacuity: the first load WAS a cache hit (stale), so exactly one conta
    // read happened in this run, the reload's.
    expect(db.leituras.slice(leiturasAntes).filter((l) => l === caminhoConta(ID))).toHaveLength(1);
    expect(db.escritas).toEqual([]);
  });

  it('a seller that still disagrees after the reload drops — decided on exactly one fresh read', async () => {
    contaConectada(ID, SPID_B);
    const { deps } = depsExec({ importador: importa });
    // The cache holds the CURRENT seller.
    expect(await processarNotificacaoAmazon(asDb(db), poll({ sellerId: SPID_B }), deps)).toEqual({
      kind: 'importado',
    });
    // A poll listed under the previous seller: the cached copy disagrees, and so does the re-read.
    const leiturasAntes = db.leituras.length;
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({
      kind: 'vendedor-mudou',
    });
    expect(db.leituras.slice(leiturasAntes).filter((l) => l === caminhoConta(ID))).toHaveLength(1);
  });
});

describe('every context refusal ⇒ its row of the table', () => {
  it('conta gone ⇒ conta-inexistente (dropped)', async () => {
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({
      kind: 'conta-inexistente',
    });
  });

  it('inactive ⇒ adiado/conta-inativa', async () => {
    contaConectada(ID, SPID_A, { ativo: false });
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-inativa',
    });
  });

  it('never connected ⇒ adiado/conta-nao-conectada', async () => {
    seedConta(db, ID, { selling_partner_id: null });
    seedCredencial(db, ID);
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), poll(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-nao-conectada',
    });
  });

  it('no credential ⇒ adiado/credencial-ausente', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'credencial-ausente',
    });
  });

  it('a corrupt credential ⇒ adiado/credencial-invalida', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID, { refresh_token: 42 });
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'credencial-invalida',
    });
  });

  it('a parked conta ⇒ adiado/conta-parada', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID, {
      reconexaoPendente: {
        desdeMs: 1,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: REF_ATUAL,
      },
    });
    const { deps } = depsExec({ importador: importa });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-parada',
    });
  });

  it('★ the LWA pair missing ⇒ ConfigAmazonAusenteError rethrown, the SAME object (our config stays LOUD)', async () => {
    contaConectada();
    const { deps } = depsExec({
      ambiente: { ...AMBIENTE_LIGADO, AMAZON_LWA_CLIENT_SECRET: '' },
      importador: importa,
    });
    const err = await processarNotificacaoAmazon(asDb(db), push(), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigAmazonAusenteError);
  });
});

describe('the importer seam', () => {
  it('★ empty ⇒ adiado/importador-ausente, which DEFERS (never parks): the task writes a deferred row', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: null });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'importador-ausente',
    });
    const r = await tratarTarefaLeituraAmazon(asDb(db), push(), deps);
    expect(r).toMatchObject({ resultado: 'deferred', detalhe: null, contaId: ID });
    expect(db.ler(caminhoDe(push()))).toMatchObject({
      status: 'deferred',
      erro: 'adiado/importador-ausente',
    });
  });

  it('a fake importer’s `importado` ⇒ resolve: the task persists NOTHING', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: importa });
    const r = await tratarTarefaLeituraAmazon(asDb(db), push(), deps);
    expect(r).toEqual({
      resultado: 'done',
      detalhe: 'importado',
      contaId: ID,
      amazonOrderId: PEDIDO,
      origem: 'push',
    });
    expect(db.escritas).toEqual([]);
  });

  it('the run’s registro reaches the call lines: flow, attempt, task id and the doc id as notification id', async () => {
    contaConectada();
    const { fetch, chamadas } = espiaoDeFetch(() => tokenDeAcesso());
    const { deps, linhas } = depsExec(
      {
        fetch,
        importador: async (_db, contexto) => {
          await contexto.obterAcesso({ forcarRenovacao: true });
          return { kind: 'importado' };
        },
      },
      1,
    );
    await processarNotificacaoAmazon(asDb(db), push(), deps);
    expect(chamadas.map((c) => c.url)).toEqual([URL_TOKEN_LWA]);
    expect(linhasDeChamada(linhas)).toEqual([
      expect.objectContaining({
        conta: ID,
        fluxo: 'intake',
        tentativa: 1,
        idTarefa: 'tarefa-1',
        idNotificacao: docIdNotificacaoAmazon(push()),
      }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The classifier                               */
/* -------------------------------------------------------------------------- */

describe('classificarFalhaDaTarefaAmazon — the table, most-derived first', () => {
  const deps = () => depsLeitura().deps;
  const classifica = (err: unknown) => classificarFalhaDaTarefaAmazon(asDb(db), err, null, deps());

  it('the context refusals map to their outcomes', async () => {
    const casos: [unknown, ResultadoNotificacaoAmazon][] = [
      [new ChamadasAmazonDesligadasError(ID), { kind: 'adiado', motivo: 'chamadas-desligadas' }],
      [new ContaAmazonNaoEncontradaError(ID), { kind: 'conta-inexistente' }],
      [new ContaAmazonInativaError(ID), { kind: 'adiado', motivo: 'conta-inativa' }],
      [new ContaAmazonNaoConectadaError(ID), { kind: 'adiado', motivo: 'conta-nao-conectada' }],
      [new CredencialAmazonAusenteError(ID), { kind: 'adiado', motivo: 'credencial-ausente' }],
      [
        new CredencialAmazonInvalidaError(ID, ['x']),
        { kind: 'adiado', motivo: 'credencial-invalida' },
      ],
      [new ContaAmazonParadaError(ID, 400, 1), { kind: 'adiado', motivo: 'conta-parada' }],
    ];
    for (const [err, esperado] of casos) {
      expect(await classifica(err), (err as Error).name).toEqual(esperado);
    }
  });

  it('★ our own misconfiguration is NEVER deferred: ConfigAmazonAusenteError and AmazonConfigError ⇒ null', async () => {
    expect(await classifica(new ConfigAmazonAusenteError(['AMAZON_LWA_CLIENT_ID']))).toBeNull();
    expect(
      await classifica(
        new AmazonConfigError('token', { operacao: 'getOrder', refCredencial: null }),
      ),
    ).toBeNull();
  });

  it('★ subclass order: a 401/403 is never a plain HTTP refusal, a 404 never a 4xx park of another name', async () => {
    expect(await classifica(spApiAuth(401))).toEqual({ kind: 'adiado', motivo: 'sem-permissao' });
    expect(await classifica(spApiAuth(403))).toEqual({ kind: 'adiado', motivo: 'sem-permissao' });
    expect(await classifica(new AmazonNotFoundError({ ...CTX_SP, status: 404 }))).toEqual({
      kind: 'pedido-inexistente',
    });
  });

  it('★ a throttle is rethrown (null) — never parked', async () => {
    expect(await classifica(throttle())).toBeNull();
  });

  it('5xx are rethrown; a non-transient 4xx parks with its class and status only', async () => {
    for (const status of [500, 502, 503, 504]) expect(await classifica(http(status))).toBeNull();
    for (const status of [400, 409, 422]) {
      expect(await classifica(http(status))).toEqual({
        kind: 'recusa-deterministica',
        classe: 'AmazonHttpError',
        status,
      });
    }
  });

  it('a schema refusal and a ZodError park', async () => {
    expect(
      await classifica(
        new AmazonSchemaError({ ...CTX_SP, status: 200, motivo: 'formato', campos: ['payload'] }),
      ),
    ).toEqual({ kind: 'recusa-deterministica', classe: 'AmazonSchemaError', status: 200 });
    const zod = z.object({ a: z.string() }).safeParse({}).error;
    expect(zod).toBeInstanceOf(ZodError);
    expect(await classifica(zod)).toEqual({
      kind: 'recusa-deterministica',
      classe: 'ZodError',
      status: null,
    });
  });

  it('network, timeout, the park’s contention, gRPC, an unknown Error and a non-Error ⇒ null', async () => {
    for (const err of [
      new AmazonNetworkError(CTX_SP, new TypeError('rede')),
      new AmazonTimeoutError({ ...CTX_SP, prazoMs: 10_000 }, new Error('abort')),
      new EstacionamentoAmazonEmConflitoError(ID, 3),
      grpc(14, 'UNAVAILABLE'),
      new TypeError('bug'),
      'texto',
    ]) {
      expect(await classifica(err), String(err)).toBeNull();
    }
  });
});

describe('an LWA refusal — the park’s first production caller', () => {
  it('invalid_grant on the CURRENT grant parks the conta, raises the reconexão aviso, and defers as conta-parada', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: falhaCom(lwaAuth('invalid_grant')) });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-parada',
    });
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toMatchObject({
      status: 400,
      codigoLwa: 'invalid_grant',
      refCredencial: REF_ATUAL,
    });
    // The operator reads the conta's NAME on the aviso, never its id.
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.params).toEqual({
      loja: 'Conta conta-1',
      status: 400,
    });
  });

  it('a conta whose name is empty (a legacy row) is named by its id on the aviso', async () => {
    contaConectada(ID, SPID_A, { nome: '' });
    const { deps } = depsExec({ importador: falhaCom(lwaAuth('invalid_grant')) });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-parada',
    });
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.params).toEqual({ loja: ID, status: 400 });
  });

  it('already parked between the context and the refusal ⇒ conta-parada, nothing re-parked', async () => {
    contaConectada();
    const { deps } = depsExec({
      importador: () => {
        seedCredencial(db, ID, {
          reconexaoPendente: { desdeMs: 5, status: 401, codigoLwa: null, refCredencial: REF_ATUAL },
        });
        return Promise.reject(lwaAuth('invalid_grant'));
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'conta-parada',
    });
    expect(db.escritasEm(caminhoCredencial(ID))).toEqual([]);
  });

  it('a refusal of an OLDER grant ⇒ rethrown (sanitized), nothing parked', async () => {
    contaConectada();
    const velha = refDe('tok|TESTE-refresh-VELHO-sintetico', AUTORIZADO_EM_MS - 1);
    const { deps } = depsExec({ importador: falhaCom(lwaAuth('invalid_grant', 400, velha)) });
    const err = await processarNotificacaoAmazon(asDb(db), push(), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(err).toMatchObject({ classe: 'AmazonAuthError', detalhe: 400 });
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
  });

  it('the credential removed meanwhile ⇒ adiado/credencial-ausente', async () => {
    contaConectada();
    const { deps } = depsExec({
      importador: () => {
        db.apagar(caminhoCredencial(ID));
        return Promise.reject(lwaAuth('invalid_grant'));
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'credencial-ausente',
    });
  });

  it('a credential found corrupt while parking ⇒ adiado/credencial-invalida', async () => {
    contaConectada();
    const { deps } = depsExec({
      importador: () => {
        seedCredencial(db, ID, { refresh_token: 42 });
        return Promise.reject(lwaAuth('invalid_grant'));
      },
    });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'credencial-invalida',
    });
  });

  it('invalid_client ⇒ adiado/segredo-lwa-recusado: the app-wide aviso, and NO park', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: falhaCom(lwaAuth('invalid_client', 401)) });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'segredo-lwa-recusado',
    });
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))).toBeDefined();
  });

  it('★ an SP-API 401 (already past the forced refresh) ⇒ adiado/sem-permissao, and the conta is NOT parked', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: falhaCom(spApiAuth(401)) });
    expect(await processarNotificacaoAmazon(asDb(db), push(), deps)).toEqual({
      kind: 'adiado',
      motivo: 'sem-permissao',
    });
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
    expect(db.escritasEm(caminhoCredencial(ID))).toEqual([]);
  });

  it('an LWA refusal the park table does not claim (invalid_scope) ⇒ rethrown, nothing parked', async () => {
    contaConectada();
    const { deps } = depsExec({ importador: falhaCom(lwaAuth('invalid_scope', 403)) });
    await expect(processarNotificacaoAmazon(asDb(db), push(), deps)).rejects.toBeInstanceOf(
      FalhaTarefaAmazonError,
    );
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          The sanitizing boundary                           */
/* -------------------------------------------------------------------------- */

describe('the sanitizing boundary (§3 decision 31)', () => {
  const SENTINELAS = {
    ref: 'ref-SENTINELA-0f0f0f',
    caminho: 'SENTINELA-CAMINHO-7777',
    causa: 'SENTINELA-CAUSA-9999',
  } as const;
  const CTX_SUJO: ContextoRequisicaoAmazon = {
    ...CTX_SP,
    caminho: `/orders/2026-01-01/orders/${SENTINELAS.caminho}`,
    refCredencial: SENTINELAS.ref,
  };

  /** The package error, carrying a ref, a path and a `cause` — what must never leave. */
  function sujo<E extends Error>(err: E): E {
    Object.defineProperty(err, 'cause', {
      value: new Error(SENTINELAS.causa),
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return err;
  }

  const REJEITADOS: [string, () => Error, string, number | string | null][] = [
    [
      'AmazonThrottleError',
      () => sujo(new AmazonThrottleError({ ...CTX_SUJO, status: 429, limiteTaxa: null })),
      'AmazonThrottleError',
      429,
    ],
    [
      'AmazonHttpError (503)',
      () => sujo(new AmazonHttpError({ ...CTX_SUJO, status: 503 })),
      'AmazonHttpError',
      503,
    ],
    [
      'AmazonNetworkError',
      () => sujo(new AmazonNetworkError(CTX_SUJO, new Error(SENTINELAS.causa))),
      'AmazonNetworkError',
      null,
    ],
    [
      'AmazonTimeoutError',
      () =>
        sujo(new AmazonTimeoutError({ ...CTX_SUJO, prazoMs: 10_000 }, new Error(SENTINELAS.causa))),
      'AmazonTimeoutError',
      null,
    ],
    [
      'AmazonAuthError (an older grant)',
      () =>
        sujo(
          new AmazonAuthError({
            ...CTX_SUJO,
            destino: 'lwa',
            operacao: 'trocarRefreshToken',
            metodo: 'POST',
            status: 400,
            codigoLwa: 'invalid_grant',
          }),
        ),
      'AmazonAuthError',
      400,
    ],
    [
      'AmazonConfigError',
      () =>
        sujo(
          new AmazonConfigError('token', { operacao: 'getOrder', refCredencial: SENTINELAS.ref }),
        ),
      'AmazonConfigError',
      'token',
    ],
  ];

  const vazamentos = (texto: string) => Object.values(SENTINELAS).filter((s) => texto.includes(s));

  it.each(REJEITADOS)(
    '★ %s leaves the run as a FalhaTarefaAmazonError carrying no ref, path or cause',
    async (_nome, criar, classe, detalhe) => {
      contaConectada();
      const original = criar();
      // Anti-vacuity: the original DOES show the sentinels to a logger.
      expect(vazamentos(inspect(original, { showHidden: true, depth: 5 })).length).toBeGreaterThan(
        0,
      );

      const { deps } = depsExec({ importador: falhaCom(original) });
      const err = await processarNotificacaoAmazon(asDb(db), push(), deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
      expect(err).toMatchObject({ classe, detalhe });
      const e = err as FalhaTarefaAmazonError;
      expect(e.cause).toBeUndefined();
      for (const texto of [
        format(e),
        format('%o', e),
        inspect(e, { showHidden: true, depth: 5 }),
        e.message,
        JSON.stringify(e),
        textoDe(e),
      ]) {
        expect(vazamentos(texto), texto).toEqual([]);
      }
    },
  );

  it.each(REJEITADOS)(
    '★ %s on the FINAL attempt: the persisted `erro` holds none of the three',
    async (_nome, criar, classe) => {
      contaConectada();
      const { deps } = depsExec({ importador: falhaCom(criar()) }, TASK_MAX_ATTEMPTS - 1);
      const r = await tratarTarefaLeituraAmazon(asDb(db), push(), deps);
      expect(r.resultado).toBe('failed');
      const doc = db.ler(caminhoDe(push()));
      expect(doc?.status).toBe('failed');
      expect(String(doc?.erro)).toContain(classe);
      expect(vazamentos(JSON.stringify(doc))).toEqual([]);
    },
  );

  it('★ a ConfigAmazonAusenteError and a TypeError come out as the SAME object', async () => {
    for (const original of [
      new ConfigAmazonAusenteError(['AMAZON_LWA_CLIENT_ID']),
      new TypeError('bug'),
    ]) {
      __resetAllReadCaches();
      db = new FakeDb();
      contaConectada();
      const { deps } = depsExec({ importador: falhaCom(original) });
      const err = await processarNotificacaoAmazon(asDb(db), push(), deps).catch((e: unknown) => e);
      expect(err).toBe(original);
    }
  });

  it('the boundary names EVERY package class, never the base, and returns anything else as is', () => {
    expect(
      sanitizarFalhaDaTarefaAmazon(new AmazonNotFoundError({ ...CTX_SUJO, status: 404 })),
    ).toMatchObject({
      classe: 'AmazonNotFoundError',
      detalhe: 404,
    });
    expect(
      sanitizarFalhaDaTarefaAmazon(
        new AmazonSchemaError({ ...CTX_SUJO, status: 200, motivo: 'vazio', campos: [] }),
      ),
    ).toMatchObject({ classe: 'AmazonSchemaError', detalhe: 200 });
    const outro = grpc(14, 'UNAVAILABLE');
    expect(sanitizarFalhaDaTarefaAmazon(outro)).toBe(outro);
    expect(sanitizarFalhaDaTarefaAmazon('texto')).toBe('texto');
  });
});

/* -------------------------------------------------------------------------- */
/*                         The pipeline arms on fakeDb                        */
/* -------------------------------------------------------------------------- */

describe('the task arms', () => {
  it('★ a transient throw is rethrown for the queue until the LAST attempt, then persisted failed', async () => {
    contaConectada();
    for (let tentativa = 0; tentativa < TASK_MAX_ATTEMPTS - 1; tentativa += 1) {
      const { deps } = depsExec({ importador: falhaCom(throttle()) }, tentativa);
      await expect(tratarTarefaLeituraAmazon(asDb(db), push(), deps)).rejects.toBeInstanceOf(
        FalhaTarefaAmazonError,
      );
      expect(db.ler(caminhoDe(push()))).toBeUndefined();
    }
    const { deps } = depsExec({ importador: falhaCom(throttle()) }, TASK_MAX_ATTEMPTS - 1);
    expect(await tratarTarefaLeituraAmazon(asDb(db), push(), deps)).toMatchObject({
      resultado: 'failed',
      detalhe: null,
    });
    expect(db.ler(caminhoDe(push()))).toMatchObject({
      status: 'failed',
      tentativas: 0,
      erro: 'falha da Amazon na tarefa: AmazonThrottleError HTTP 429',
    });
  });

  it('a 404 parks the notification; a dropped one writes nothing', async () => {
    contaConectada();
    const { deps } = depsExec({
      importador: falhaCom(new AmazonNotFoundError({ ...CTX_SP, status: 404 })),
    });
    expect((await tratarTarefaLeituraAmazon(asDb(db), push(), deps)).resultado).toBe('parked');
    expect(db.ler(caminhoDe(push()))).toMatchObject({
      status: 'parked',
      erro: 'pedido-inexistente',
    });

    db = new FakeDb();
    __resetAllReadCaches();
    contaConectada(ID, SPID_B);
    const { deps: d2 } = depsExec({ importador: importa });
    expect(await tratarTarefaLeituraAmazon(asDb(db), poll(), d2)).toMatchObject({
      resultado: 'dropped',
      detalhe: 'vendedor-mudou',
      contaId: ID,
    });
    expect(db.escritas).toEqual([]);
  });

  it('a payload the task schema refuses is DROPPED with no read and no write', async () => {
    const { deps } = depsExec({ importador: importa });
    const r = await tratarTarefaLeituraAmazon(asDb(db), { ...push(), amazonOrderId: 'x' }, deps);
    expect(r).toEqual({
      resultado: 'dropped',
      detalhe: 'payload-invalido',
      contaId: null,
      amazonOrderId: null,
      origem: null,
    });
    expect(db.operacoes).toBe(0);
  });
});

/**
 * A re-drive whose importer forces ONE LWA refresh through the scripted spy, so
 * the run emits exactly one call line, whose registro the sweeps' tests read.
 */
function reDriveComUmaChamada() {
  const { fetch, chamadas } = espiaoDeFetch(() => tokenDeAcesso());
  const { deps, linhas } = depsLeitura({
    fetch,
    importador: async (_db, contexto) => {
      await contexto.obterAcesso({ forcarRenovacao: true });
      return { kind: 'importado' };
    },
  });
  return { deps, linhas, chamadas };
}

/** What a sweep's call line must say: a re-drive, no Cloud Tasks attempt, no task id. */
const LINHA_DA_VARREDURA = expect.objectContaining({
  conta: ID,
  fluxo: 'reprocesso',
  tentativa: null,
  idTarefa: null,
  idNotificacao: docIdNotificacaoAmazon(push()),
});

describe('the HOT sweep', () => {
  const OPTS = { now: AGORA_MS, limit: 10 };

  it('★ a re-drive’s call lines say `reprocesso`, with no attempt and no task id (W10 tells it from intake)', async () => {
    contaConectada();
    const n = seedNotificacao(push());
    const { deps, linhas, chamadas } = reDriveComUmaChamada();
    const r = await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(r.outcomes).toEqual({ importado: 1 });
    expect(chamadas.map((c) => c.url)).toEqual([URL_TOKEN_LWA]);
    expect(linhasDeChamada(linhas)).toEqual([LINHA_DA_VARREDURA]);
    expect(db.ler(n)).toBeUndefined();
  });

  it('resolves (deletes), defers (migrates with a fresh clock), parks, and keeps a throw failed', async () => {
    contaConectada();
    const pedido = (n: number) => `000-0000000-000000${String(n)}`;
    const a = seedNotificacao(push({ notificationId: 'a', amazonOrderId: pedido(1) }));
    // b's seller has no conta: a precondition, learned only now (its enqueue had failed).
    const b = seedNotificacao(
      push({ notificationId: 'b', amazonOrderId: pedido(2), sellerId: SPID_B }),
      { tentativas: 2 },
    );
    const c = seedNotificacao(push({ notificationId: 'c', amazonOrderId: pedido(3) }));
    const d = seedNotificacao(push({ notificationId: 'd', amazonOrderId: pedido(4) }), {
      tentativas: 1,
    });
    const porPedido = new Map<string, () => Promise<{ kind: 'importado' }>>([
      [pedido(1), () => Promise.resolve({ kind: 'importado' })],
      [pedido(3), () => Promise.reject(new AmazonNotFoundError({ ...CTX_SP, status: 404 }))],
      [pedido(4), () => Promise.reject(throttle())],
    ]);
    const { deps } = depsLeitura({
      importador: (_db, _ctx, p) => {
        const f = porPedido.get(p.amazonOrderId);
        if (f === undefined) return Promise.reject(new TypeError('inesperado'));
        return f();
      },
    });

    const r = await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);

    expect(db.ler(a)).toBeUndefined();
    expect(db.ler(b)).toMatchObject({
      status: 'deferred',
      tentativas: 0,
      erro: 'adiado/sem-conta',
    });
    expect(db.ler(c)).toMatchObject({ status: 'parked', erro: 'pedido-inexistente' });
    expect(db.ler(d)).toMatchObject({ status: 'failed', tentativas: 2 });
    expect(r.outcomes).toEqual({ importado: 1, deferred: 1, parked: 1 });
    expect(r.errors).toEqual([
      { docId: 'push:d', message: 'falha da Amazon na tarefa: AmazonThrottleError HTTP 429' },
    ]);
  });

  it('a throw at the cap PARKS (MAX_TENTATIVAS, by constant)', async () => {
    contaConectada();
    const n = seedNotificacao(push(), { tentativas: MAX_TENTATIVAS - 1 });
    const { deps } = depsLeitura({ importador: falhaCom(throttle()) });
    await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS });
  });

  it('★ fromDoc is STRICT: a corrupt row is never processed, and parks at the cap', async () => {
    contaConectada();
    let chamado = 0;
    const { deps } = depsLeitura({
      importador: () => {
        chamado += 1;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    const corrompido = `${COLECAO}/push:corrompido`;
    db.seed(corrompido, {
      tipo: 'pedido',
      origem: 'push',
      sellerId: SPID_A,
      amazonOrderId: 'nao-e-um-pedido',
      notificationId: 'corrompido',
      publishTimeMs: 1,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: 0,
    });
    const r1 = await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(chamado).toBe(0);
    expect(r1.errors.map((e) => e.docId)).toEqual(['push:corrompido']);
    // Refused at REHYDRATION (the schema names the field), never later inside the run.
    expect(r1.errors[0]?.message).toContain('amazonOrderId');
    expect(r1.errors[0]?.message).not.toContain('docIdNotificacaoAmazon');
    expect(db.ler(corrompido)).toMatchObject({ status: 'failed', tentativas: 1 });

    db.seed(corrompido, { ...db.ler(corrompido), tentativas: MAX_TENTATIVAS - 1, processedAt: 0 });
    await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(db.ler(corrompido)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS });
    expect(chamado).toBe(0);
  });

  it('★ a re-driven row reaches the importer as EXACTLY its task payload — no resilience field, no null of the other variant', async () => {
    contaConectada();
    const recebidos: unknown[] = [];
    const { deps } = depsLeitura({
      importador: (_db, _ctx, p) => {
        recebidos.push(p);
        return Promise.resolve({ kind: 'importado' });
      },
    });
    seedNotificacao(push(), { tentativas: 2, erro: 'x', contaId: null, lastUpdatedUs: null });
    await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(recebidos).toEqual([push()]);
  });

  it('a push row and a poll row of ONE order: the second is skipped in the run (the dedup key), not deleted', async () => {
    contaConectada();
    let chamado = 0;
    const { deps } = depsLeitura({
      importador: () => {
        chamado += 1;
        return Promise.resolve({ kind: 'importado' });
      },
    });
    const p1 = seedNotificacao(push(), { processedAt: 1 });
    const p2 = seedNotificacao(poll(), { processedAt: 2 });
    const r = await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(chamado).toBe(1);
    expect(db.ler(p1)).toBeUndefined();
    expect(db.ler(p2)).toBeDefined();
    expect(r.processed).toBe(1);
  });

  it('runs exactly the declared lane query', async () => {
    const { deps } = depsLeitura();
    await reprocessarNotificacoesAmazon(asDb(db), OPTS, deps);
    expect(db.consultas).toEqual([
      {
        colecao: COLECAO,
        filtros: [
          ['status', 'failed'],
          ['processedAt <', AGORA_MS - 60 * 60 * 1000],
        ],
        ordens: [['processedAt', 'asc']],
        limite: 10,
        apos: null,
      },
    ]);
  });
});

describe('the DEFERRED sweep', () => {
  const OPTS = { now: AGORA_MS, limit: 10 };

  it('★ a re-drive’s call lines say `reprocesso`, with no attempt and no task id', async () => {
    contaConectada();
    const n = seedNotificacao(push(), { status: 'deferred', tentativas: 1 });
    const { deps, linhas, chamadas } = reDriveComUmaChamada();
    const r = await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(r.outcomes).toEqual({ importado: 1 });
    expect(chamadas.map((c) => c.url)).toEqual([URL_TOKEN_LWA]);
    expect(linhasDeChamada(linhas)).toEqual([LINHA_DA_VARREDURA]);
    expect(db.ler(n)).toBeUndefined();
  });

  it('a still-blocked row stays deferred with one more pass, and PARKS at MAX_TENTATIVAS_DEFERRED (by constant)', async () => {
    contaConectada();
    const n = seedNotificacao(push(), { status: 'deferred', tentativas: 0 });
    const { deps } = depsLeitura({ importador: null });
    await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toMatchObject({
      status: 'deferred',
      tentativas: 1,
      erro: 'adiado/importador-ausente',
    });

    db.seed(n, { ...db.ler(n), tentativas: MAX_TENTATIVAS_DEFERRED - 1, processedAt: 0 });
    await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS_DEFERRED });
  });

  it('the precondition clears and the import succeeds ⇒ the row is deleted', async () => {
    contaConectada();
    const n = seedNotificacao(push(), { status: 'deferred', tentativas: 3 });
    const { deps } = depsLeitura({ importador: importa });
    const r = await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toBeUndefined();
    expect(r.outcomes).toEqual({ importado: 1 });
  });

  it('graduation: the precondition clears and the import THROWS ⇒ back to the hot lane, fresh', async () => {
    contaConectada();
    const n = seedNotificacao(push(), { status: 'deferred', tentativas: 4 });
    const { deps } = depsLeitura({ importador: falhaCom(http(503)) });
    const r = await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toMatchObject({
      status: 'failed',
      tentativas: 0,
      processedAt: 0,
      erro: 'falha da Amazon na tarefa: AmazonHttpError HTTP 503',
    });
    expect(r.outcomes).toEqual({ redriven: 1 });
  });

  it('near-miss: a STILL-blocked precondition returns adiado and never graduates', async () => {
    const n = seedNotificacao(push(), { status: 'deferred', tentativas: 2 });
    const { deps } = depsLeitura({ importador: falhaCom(http(503)) });
    await reprocessarAdiadasAmazon(asDb(db), OPTS, deps);
    expect(db.ler(n)).toMatchObject({
      status: 'deferred',
      tentativas: 3,
      erro: 'adiado/sem-conta',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         The log line, and the persist                       */
/* -------------------------------------------------------------------------- */

describe('camposDoRegistroDaTarefaAmazon — the raw ids, one by one, by grammar', () => {
  it('reads the five ids of a push and a poll, and NEVER the seller', () => {
    expect(camposDoRegistroDaTarefaAmazon(push())).toEqual({
      tipo: 'pedido',
      origem: 'push',
      amazonOrderId: PEDIDO,
      contaId: null,
      notificationId: NOTIFICACAO,
    });
    expect(camposDoRegistroDaTarefaAmazon(poll())).toEqual({
      tipo: 'pedido',
      origem: 'poll',
      amazonOrderId: PEDIDO,
      contaId: ID,
      notificationId: null,
    });
    expect(textoDe(camposDoRegistroDaTarefaAmazon(push()))).not.toContain(SPID_A);
  });

  it('a malformed or hostile payload logs null — never an object, never text outside its grammar', () => {
    expect(
      camposDoRegistroDaTarefaAmazon({
        tipo: { $: 1 },
        origem: 'webhook',
        amazonOrderId: 'Fulano de Tal',
        contaId: 'a/b',
        notificationId: 'x'.repeat(129),
        sellerId: SPID_A,
      }),
    ).toEqual({
      tipo: null,
      origem: null,
      amazonOrderId: null,
      contaId: null,
      notificationId: null,
    });
    for (const dados of [null, undefined, 'texto', 42, []]) {
      expect(Object.values(camposDoRegistroDaTarefaAmazon(dados)).every((v) => v === null)).toBe(
        true,
      );
    }
  });

  it('a getter on the raw data is never invoked', () => {
    let lido = false;
    const dados = Object.defineProperty({}, 'amazonOrderId', {
      enumerable: true,
      get: () => {
        lido = true;
        return PEDIDO;
      },
    });
    expect(camposDoRegistroDaTarefaAmazon(dados).amazonOrderId).toBeNull();
    expect(lido).toBe(false);
  });
});

describe('persistirFalhaNotificacaoAmazon — the producers’ enqueue-failure fallback', () => {
  it('persists failed at the deterministic id with exactly the named fields; a second persist never forks', async () => {
    await persistirFalhaNotificacaoAmazon(asDb(db), push(), 'enfileiramento/primeiro');
    await persistirFalhaNotificacaoAmazon(asDb(db), push(), 'enfileiramento/segundo');
    expect(db.caminhos()).toEqual([caminhoDe(push())]);
    const doc = db.ler(caminhoDe(push()));
    expect(doc).toMatchObject({
      ...push(),
      contaId: null,
      lastUpdatedUs: null,
      status: 'failed',
      tentativas: 0,
      erro: 'enfileiramento/primeiro',
    });
    expect(Object.keys(doc ?? {}).sort()).toEqual(
      [
        'amazonOrderId',
        'contaId',
        'erro',
        'lastUpdatedUs',
        'notificationId',
        'origem',
        'processedAt',
        'publishTimeMs',
        'sellerId',
        'status',
        'tentativas',
        'tipo',
      ].sort(),
    );
  });

  it('a later change of the same order (poll) is a NEW row — the stamp is in the id', async () => {
    await persistirFalhaNotificacaoAmazon(asDb(db), poll({ lastUpdatedUs: 1 }), 'x');
    await persistirFalhaNotificacaoAmazon(asDb(db), poll({ lastUpdatedUs: 2 }), 'x');
    expect(db.caminhos()).toHaveLength(2);
  });
});
