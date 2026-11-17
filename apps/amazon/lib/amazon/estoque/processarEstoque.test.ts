/**
 * The stock queue's body (step 12, PR 12-e1), P0–P10, end to end against the
 * fake Firestore: the REAL context, the REAL write engine, the REAL link
 * resolver, family read, verdict, gate, plan and outcome write-back, the REAL
 * listing read and availability PATCH over a scripted `fetch` routed by path
 * and method (and REFUSING anything unscripted), and the REAL stock producer
 * over a recording, name-keeping queue (so every enqueue is re-validated
 * against the payload schema).
 *
 * After EVERY test: no network call left the scripted `fetch`, and no
 * scenario wrote anything but link-doc outcomes, avisos and the context's own
 * credential patch — never a produto, an estoque row or a lease.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioEstoqueAmazon,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  makeEstoqueUid,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON } from './envioEstoqueFirestore';
import { JANELA_VISIBILIDADE_MS } from './planoEstoque';
import {
  ACAO_TAREFA_ESTOQUE_AMAZON,
  AmazonEstoquePrazoDaTarefaError,
  CAMPO_FEED_RECENTE_ESTOQUE_AMAZON,
  DADOS_LEITURA_ESTOQUE_AMAZON,
  type DepsProcessarEstoqueAmazon,
  ORCAMENTO_ANTES_DO_PATCH_MS,
  type ResultadoTarefaEstoqueAmazon,
  depositoIdDaContaEstoqueAmazon,
  processarEstoqueAmazon,
  registrarDespachoEstoqueAmazon,
  severidadeDoDespachoEstoqueAmazon,
} from './processarEstoque';
import {
  ATRASO_PAUSA_ESTOQUE_S,
  ATRASO_VERIFICACAO_ESTOQUE_S,
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  type FilaEstoqueAmazon,
  type ProdutorEstoqueAmazon,
  criarProdutorEstoqueAmazon,
} from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  nomeTarefaEstoque,
} from './tarefaEstoque';

const CONTA = 'conta-amz-estoque';
const DEP = 'dep-estoque-1';
const REF_DEP = `documents/depositos/${DEP}`;
const SKU = 'SKU-ESTOQUE-1';
const ASIN = 'B0ESTOQUE01';
const PRODUTO = 'prod-estoque-1';
const LINK = 'link-1';
const CAMINHO_LINK = `produtos/${PRODUTO}/prodAmazon/${LINK}`;
const CAMINHO_ESTOQUE = `produtos/${PRODUTO}/estoques/${makeEstoqueUid(PRODUTO, DEP)}`;
const CAMINHO_ITEM = `${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`;
const CAMINHO_VEZ = `feedsAmazonEmCurso/estoque-${CONTA}`;
const AVISO_RECUSADO = caminhoAviso(
  chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon),
);
const SUBMISSAO = 'sub-estoque-0001';
const OBS_1 = '1700000000.000000001';
const OBS_2 = '1700000001.000000002';
const MINUTO_MS = 60_000;

/* -------------------------------------------------------------------------- */
/*                               the recording queue                          */
/* -------------------------------------------------------------------------- */

interface EnfileiradaEstoque {
  readonly tarefa: TarefaEstoqueAmazon;
  readonly id: string | null;
  readonly atrasoS: number;
}

interface FilaEstoqueDeTeste {
  readonly enfileiradas: EnfileiradaEstoque[];
  readonly nomes: Set<string>;
  falha: (() => unknown) | null;
  desligado: boolean;
  produtor(): ProdutorEstoqueAmazon;
}

/** The REAL producer over a queue that records, keeps every name, and refuses a held one with the SDK's 409. */
function filaEstoqueDeTeste(): FilaEstoqueDeTeste {
  const f: FilaEstoqueDeTeste = {
    enfileiradas: [],
    nomes: new Set(),
    falha: null,
    desligado: false,
    produtor: () =>
      criarProdutorEstoqueAmazon({
        desligado: f.desligado,
        fila: (): FilaEstoqueAmazon => ({
          enqueue: (tarefa, opcoes) => {
            if (f.falha !== null) return Promise.reject(f.falha());
            const id = opcoes?.id ?? null;
            if (id !== null) {
              if (f.nomes.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
              f.nomes.add(id);
            }
            f.enfileiradas.push({ tarefa, id, atrasoS: opcoes?.scheduleDelaySeconds ?? 0 });
            return Promise.resolve();
          },
        }),
      }),
  };
  return f;
}

/* -------------------------------------------------------------------------- */
/*                                 the scenario                               */
/* -------------------------------------------------------------------------- */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** The connection drops instead of an answer (`fetch` rejects). */
  readonly rede?: true;
}

/** A listing as the model shapes it: BR summary, MFN availability at `quantidade`, no relationship. */
function listing(quantidade: number | null, extra: Record<string, unknown> = {}): Roteiro {
  return {
    status: 200,
    corpo: {
      sku: SKU,
      summaries: [
        {
          marketplaceId: MARKETPLACE_ID_BR,
          asin: ASIN,
          productType: 'PRODUCT',
          status: ['BUYABLE'],
        },
      ],
      fulfillmentAvailability:
        quantidade === null ? [] : [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
      relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
      ...extra,
    },
  };
}

/** Amazon's submission answer. */
function submissao(status: string, issues: unknown[] = []): Roteiro {
  return { status: 200, corpo: { sku: SKU, status, submissionId: SUBMISSAO, issues } };
}

const ACEITO = submissao('ACCEPTED');
const erroHttp = (status: number, codigo = 'InvalidInput'): Roteiro => ({
  status,
  corpo: { errors: [{ code: codigo, message: 'texto da Amazon' }] },
});

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly fila: FilaEstoqueDeTeste;
  get: Roteiro[];
  patch: Roteiro[];
  /** Every request that reached the scripted fetch: `GET`, `PATCH` or `LWA`. */
  readonly chamadas: string[];
  /** The quantity of every PATCH body, in order. */
  readonly patches: number[];
  /** The `includedData` of every GET. */
  readonly incluidos: (string | null)[];
  ambiente: Record<string, string | undefined>;
  /** The clock every dep reads. */
  relogio: number;
  agora: (() => number) | null;
  /** Runs once, right after the GET is answered (before the plan). */
  depoisDoGet: (() => void) | null;
  tentativa: number;
  deps(): DepsProcessarEstoqueAmazon;
  rodar(t?: unknown): Promise<ResultadoTarefaEstoqueAmazon>;
}

const cenarios: Cenario[] = [];

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('sem resposta roteirizada');
  return r;
}

/** The PATCH body's quantity (the package's stock merge). */
function quantidadeDoCorpo(corpo: unknown): number {
  const lido = JSON.parse(String(corpo)) as {
    patches: { value: { quantity: number }[] }[];
  };
  const q = lido.patches[0]?.value[0]?.quantity;
  if (typeof q !== 'number') throw new Error('PATCH sem quantidade');
  return q;
}

/** A conta with a depósito (or none), connected; a simple produto linked to the SKU; ERP = `erp`. */
function cenario(
  opcoes: { readonly erp?: number; readonly deposito?: string | null } = {},
): Cenario {
  const fake = new FakeDb();
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta estoque',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: opcoes.deposito === undefined ? REF_DEP : opcoes.deposito,
  });
  seedCredencial(fake, CONTA);
  fake.seed(`produtos/${PRODUTO}`, { nome: 'Produto estoque', precos: { varejo: 10 } });
  fake.seed(CAMINHO_LINK, {
    contaAmazonOuterRef: `documents/integracao/${CONTA}`,
    sku: SKU,
    asin: ASIN,
    productDataJson: { pesado: 'x'.repeat(64) },
  });
  const log = loggerEspiao();
  const fila = filaEstoqueDeTeste();
  const c: Cenario = {
    fake,
    log,
    fila,
    get: [listing(7)],
    patch: [ACEITO],
    chamadas: [],
    patches: [],
    incluidos: [],
    ambiente: {
      ...AMBIENTE_LIGADO,
      AMAZON_MODO_ESTOQUE: 'on',
      AMAZON_CANARIO_ESTOQUE: '*',
    },
    relogio: AGORA_MS,
    agora: null,
    depoisDoGet: null,
    tentativa: 0,
    deps: () => ({
      db: asDb(fake),
      ambiente: c.ambiente,
      agora: () => (c.agora === null ? c.relogio : c.agora()),
      logger: log.logger,
      increment,
      carregarContexto: loadAmazonContext,
      produtor: () => fila.produtor(),
      registro: { tentativa: c.tentativa, idTarefa: 'tarefa-estoque-teste' },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return tokenDeAcesso();
        }
        if (url.pathname !== CAMINHO_ITEM || (metodo !== 'GET' && metodo !== 'PATCH')) {
          throw new Error(`rota não roteirizada: ${metodo} ${url.pathname}`);
        }
        c.chamadas.push(metodo);
        if (metodo === 'GET') {
          c.incluidos.push(url.searchParams.get('includedData'));
          const r = proxima(c.get);
          if (r.rede === true) throw new TypeError('fetch failed');
          const gancho = c.depoisDoGet;
          c.depoisDoGet = null;
          gancho?.();
          return respostaJson(r.status ?? 200, r.corpo ?? {});
        }
        c.patches.push(quantidadeDoCorpo(init?.body));
        const r = proxima(c.patch);
        if (r.rede === true) throw new TypeError('fetch failed');
        return respostaJson(r.status ?? 200, r.corpo ?? {});
      },
      gerarCorrelationId: () => 'corr-estoque-teste',
    }),
    rodar: (t = tarefa()) => processarEstoqueAmazon(t, c.deps()),
  };
  erp(c, opcoes.erp ?? 3);
  cenarios.push(c);
  return c;
}

/** The unit's row at the conta's depósito: `quantidade` available, nothing reserved. */
function erp(c: Cenario, quantidade: number): void {
  c.fake.seed(CAMINHO_ESTOQUE, {
    depositoOuterRef: REF_DEP,
    parentId: PRODUTO,
    quantidade,
    quantidadeReservada: 0,
  });
}

/** The link's stored outcome, as an earlier dispatch left it. */
function envioArmazenado(c: Cenario, envio: EnvioEstoqueAmazon): void {
  c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), envioEstoqueAmazon: envio });
}

function envioPatch(
  quantidade: number,
  emMs: number,
  resultado: EnvioEstoqueAmazon['resultado'] = RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
): EnvioEstoqueAmazon {
  return {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    quantidade,
    resultado,
    submissionId: null,
    feedId: null,
    problemas: [],
  };
}

/** A payload; a `delta` of observation 1 unless said otherwise. */
function tarefa(over: Partial<TarefaEstoqueAmazon> = {}): TarefaEstoqueAmazon {
  return {
    v: 1,
    contaId: CONTA,
    sku: SKU,
    origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
    referencia: OBS_1,
    depositoId: null,
    ...over,
  };
}

const reconciliacao = (depositoId = DEP) =>
  tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao, referencia: 'exec-1', depositoId });
const catchUp = () =>
  tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, referencia: 'feed-1' });
const verificacao = () =>
  tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao, referencia: SUBMISSAO });

/** The ONE dispatch line (the `fila` campo tells it from the engine's diff line). */
function despachos(c: Cenario) {
  return c.log.linhas.filter((l) => l.meta?.evento === 'estoque' && l.meta.fila !== undefined);
}

const lidoEm = (c: Cenario, prefixo: string) =>
  c.fake.leiturasDetalhadas.filter((l) => l.caminho.startsWith(prefixo));
/** How many times the conta's credential document was read so far. */
const leiturasDaCredencial = (c: Cenario) =>
  c.fake.leituras.filter((p) => p === caminhoCredencial(CONTA)).length;
const avisosTocados = (c: Cenario) =>
  lidoEm(c, 'avisos/').length +
  c.fake.escritas.filter((w) => w.caminho.startsWith('avisos/')).length;
const envioDoLink = (c: Cenario) =>
  c.fake.ler(CAMINHO_LINK)?.envioEstoqueAmazon as EnvioEstoqueAmazon | undefined;

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
  // The task writes ONLY link outcomes, avisos and the context's credential
  // patch: never a produto, an estoque row or the lease.
  for (const c of cenarios) {
    const outras = c.fake.escritas
      .map((w) => w.caminho)
      .filter(
        (p) =>
          !p.startsWith('avisos/') &&
          p !== caminhoCredencial(CONTA) &&
          !/^produtos\/[^/]+\/prodAmazon\/[^/]+$/.test(p),
      );
    expect(outras).toEqual([]);
  }
  cenarios.length = 0;
});

/* -------------------------------------------------------------------------- */

describe('P0 — the payload', () => {
  it('an invalid payload is DROPPED (payload-invalido, WARNING): nothing read, nothing called', async () => {
    const c = cenario();
    const r = await c.rodar({ contaId: CONTA });
    expect(r).toMatchObject({ acao: ACAO_TAREFA_ESTOQUE_AMAZON.payloadInvalido, motivo: null });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(despachos(c)).toHaveLength(1);
  });

  it('★ (mutation 1) a payload carrying a quantity is refused whole: the quantity is never baked in', async () => {
    const c = cenario();
    const r = await c.rodar({ ...tarefa(), quantidade: 5 });
    expect(r.acao).toBe(ACAO_TAREFA_ESTOQUE_AMAZON.payloadInvalido);
    expect(c.fake.operacoes).toBe(0);
    expect(c.patches).toEqual([]);
  });
});

describe('★ a stale task loses to a fresh one: the quantity is computed at DISPATCH', () => {
  it('two tasks enqueued at ERP 5 and at ERP 3, both dispatched after ERP = 3 ⇒ both PATCH 3', async () => {
    const c = cenario({ erp: 5 });
    await c.fila.produtor().enfileirar(tarefa({ referencia: OBS_1 }));
    erp(c, 3);
    await c.fila.produtor().enfileirar(tarefa({ referencia: OBS_2 }));
    const enfileiradas = c.fila.enfileiradas.map((x) => x.tarefa);
    expect(enfileiradas).toHaveLength(2);
    // The payloads carry identities only.
    for (const t of enfileiradas) expect(Object.keys(t).sort()).not.toContain('quantidade');

    c.get = [listing(7)];
    for (const t of enfileiradas) await c.rodar(t);
    expect(c.patches).toEqual([3, 3]);
  });
});

describe('P1 — the valve, before any read', () => {
  it('★ off ⇒ ZERO Firestore operations and zero Amazon calls; the valve line, then the dispatch line', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_ESTOQUE: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'desligado' });
    expect(c.fake.operacoes).toBe(0);
    expect(c.fake.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 0, escritas: 0 });
    expect(c.chamadas).toEqual([]);
    expect(c.log.linhas.map((l) => l.meta?.evento)).toEqual(['valvula', 'estoque']);
  });

  it('★ dry-run ⇒ the live read and ONE diff line; no PATCH, no write-back', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_ESTOQUE: 'dry-run' };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', motivo: 'simulado', dryRun: 'valvula' });
    expect(c.chamadas).toEqual(['GET']);
    const diff = c.log.linhas.filter(
      (l) => l.meta?.evento === 'estoque' && l.meta.fila === undefined,
    );
    expect(diff).toHaveLength(1);
    expect(diff[0]?.meta).toMatchObject({
      quantidadeErp: 3,
      quantidadeAmazon: 7,
      direcao: 'desce',
      escreveria: true,
    });
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('★ on OUTSIDE the canary ⇒ the same: one GET, one diff line, no PATCH (fora-do-canario)', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_ESTOQUE: `${CONTA}:OUTRO-SKU` };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', motivo: 'fora-do-canario' });
    expect(c.chamadas).toEqual(['GET']);
    const diff = c.log.linhas.filter(
      (l) => l.meta?.evento === 'estoque' && l.meta.fila === undefined,
    );
    expect(diff).toHaveLength(1);
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('NEAR-MISS: on INSIDE the canary list ⇒ one PATCH', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_ESTOQUE: `${CONTA}:${SKU}` };
    await c.rodar();
    expect(c.patches).toEqual([3]);
  });

  it('a dry-run of a plan that writes nothing names the plan’s motivo (igual)', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_ESTOQUE: 'dry-run' };
    c.get = [listing(3)];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', motivo: 'igual' });
  });
});

describe('P2 — the context and the conta’s depósito', () => {
  it('★ (mutation 6) without a depósito ⇒ conta-sem-deposito: ZERO aviso reads or writes, no link read, no Amazon call', async () => {
    const c = cenario({ deposito: null });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'conta-sem-deposito' });
    expect(avisosTocados(c)).toBe(0);
    expect(c.fake.consultas).toEqual([]);
    expect(c.chamadas).toEqual([]);
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
  });

  it('★ (mutation 10) a reconcile task whose depósito is not the conta’s ⇒ deposito-mudou, zero Amazon calls, no link read', async () => {
    const c = cenario();
    const r = await c.rodar(reconciliacao('dep-outro'));
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'deposito-mudou' });
    expect(c.chamadas).toEqual([]);
    expect(c.fake.consultas).toEqual([]);
    // Like every P2 end: no aviso is read or written per task (the tick owns them).
    expect(avisosTocados(c)).toBe(0);
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
  });

  it('NEAR-MISS: a reconcile task AT the conta’s depósito ⇒ one PATCH, and NO read-back', async () => {
    const c = cenario();
    const r = await c.rodar(reconciliacao());
    expect(c.patches).toEqual([3]);
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', verificacao: null });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('the read switch off ⇒ desligado (WARNING), nothing read past the switch, zero Amazon calls', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ motivo: 'desligado', falha: 'chamadas-desligadas' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
  });

  it('a parked conta ⇒ conta-indisponivel (WARNING), zero Amazon calls', async () => {
    const c = cenario();
    seedCredencial(c.fake, CONTA, {
      reconexaoPendente: { status: 'reautorizar', desdeMs: AGORA_MS - MINUTO_MS },
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ motivo: 'conta-indisponivel', falha: 'conta-indisponivel' });
    expect(c.chamadas).toEqual([]);
  });

  it('an INACTIVE conta ⇒ conta-indisponivel (WARNING), NO throw (never a transient retry), zero Amazon calls', async () => {
    const c = cenario();
    c.fake.seed(caminhoConta(CONTA), { ...(c.fake.ler(caminhoConta(CONTA)) ?? {}), ativo: false });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'conta-indisponivel',
      falha: 'conta-inativa',
    });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(c.chamadas).toEqual([]);
  });

  it('LWA refusing the refresh of a STALE token (invalid_grant) ⇒ conta-indisponivel (WARNING), NO throw, no SP-API call', async () => {
    const c = cenario();
    seedCredencial(c.fake, CONTA, { expirationDate: AGORA_MS - 1 });
    const base = c.deps();
    const r = await processarEstoqueAmazon(tarefa(), {
      ...base,
      fetch: (input, init) => {
        if (new URL(String(input)).pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return Promise.resolve(respostaJson(400, { error: 'invalid_grant' }));
        }
        return (base.fetch ?? fetch)(input, init);
      },
    });
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'conta-indisponivel', falha: 'auth-lwa' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(c.chamadas).toEqual(['LWA']);
    expect(c.patches).toEqual([]);
  });
});

describe('★ P3 — every link refusal ends with ZERO Amazon calls and no aviso', () => {
  const refusais: [string, (c: Cenario) => void][] = [
    [
      'vinculo-ambiguo',
      (c) => {
        c.fake.seed('produtos/prod-outro', { nome: 'Outro' });
        c.fake.seed('produtos/prod-outro/prodAmazon/l2', {
          contaAmazonOuterRef: `documents/integracao/${CONTA}`,
          sku: SKU,
        });
      },
    ],
    ['produto-ausente', (c) => c.fake.apagar(`produtos/${PRODUTO}`)],
    [
      'filho-com-sku-do-pai',
      (c) => {
        c.fake.seed('produtos/prod-pai/prodAmazon/lp', { sku: SKU, asin: 'ASIN-PAI-TESTE' });
        c.fake.seed(CAMINHO_LINK, {
          ...(c.fake.ler(CAMINHO_LINK) ?? {}),
          produtoAmazonPaiOuterRef: 'documents/produtos/prod-pai/prodAmazon/lp',
        });
      },
    ],
    [
      'pai-do-vinculo-ilegivel',
      (c) =>
        c.fake.seed(CAMINHO_LINK, {
          ...(c.fake.ler(CAMINHO_LINK) ?? {}),
          produtoAmazonPaiOuterRef: 'nao-e-um-caminho',
        }),
    ],
    [
      'unidade-com-variacoes',
      (c) => c.fake.seed('produtos/prod-filho', { nome: 'Filho', paiId: PRODUTO }),
    ],
    [
      'envio-desligado',
      (c) =>
        c.fake.seed(`produtos/${PRODUTO}`, {
          nome: 'Produto estoque',
          statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: false } },
        }),
    ],
  ];

  it.each(refusais)('%s', async (motivo, preparar) => {
    const c = cenario();
    preparar(c);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo, quantidadeErp: null });
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
    expect(c.fake.escritas).toEqual([]);
    // A refused SKU pays no lease read: the lease is read only on the way to the engine.
    expect(lidoEm(c, 'feedsAmazonEmCurso/')).toEqual([]);
  });

  it('NEAR-MISS: the same conta, the produto apt ⇒ one GET and one PATCH', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.chamadas).toEqual(['GET', 'PATCH']);
  });
});

describe('P4 — the ERP quantity, P5 — the path', () => {
  it('a unit whose produto is gone after the verdict read ⇒ unidade-ausente, no Amazon call', async () => {
    // A family-of-one wrapper whose member is gone: the resolver names the
    // member, the family read finds no document.
    const c = cenario();
    c.fake.seed(`produtos/${PRODUTO}`, {
      nome: 'Embrulho',
      filhoUnicoId: 'prod-membro',
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ motivo: 'unidade-ausente' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
    expect(lidoEm(c, 'feedsAmazonEmCurso/')).toEqual([]);
  });

  it('a SKU no listings path can carry ⇒ sem-caminho, after the ERP read, before any Amazon call', async () => {
    const c = cenario();
    const sku = 'SKU/COM/BARRA';
    c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), sku });
    const r = await c.rodar(tarefa({ sku }));
    expect(r).toMatchObject({ motivo: 'sem-caminho', quantidadeErp: 3 });
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
    expect(lidoEm(c, 'feedsAmazonEmCurso/')).toEqual([]);
  });
});

describe('★ P6 — the live read and the listing gate: one GET, no PATCH', () => {
  const casos: [string, Roteiro][] = [
    ['nao-listado', erroHttp(404, 'NOT_FOUND')],
    [
      'pai',
      listing(0, {
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: 'VARIATION', childSkus: ['FILHO-1'] }],
          },
        ],
      }),
    ],
    [
      'afn',
      listing(null, {
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 2 }],
      }),
    ],
    [
      'asin-divergente',
      listing(7, {
        summaries: [
          { marketplaceId: MARKETPLACE_ID_BR, asin: 'ASIN-OUTRO-TESTE', productType: 'PRODUCT' },
        ],
      }),
    ],
  ];

  it.each(casos)('%s', async (motivo, resposta) => {
    const c = cenario();
    c.get = [resposta];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo });
    expect(c.chamadas).toEqual(['GET']);
    expect(envioDoLink(c)).toBeUndefined();
    // No aviso per SKU: the reconcile counts the refusals.
    expect(avisosTocados(c)).toBe(0);
  });

  it('the GET asks for summaries, availability and relationships — exactly what the gate reads', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.incluidos).toEqual([[...DADOS_LEITURA_ESTOQUE_AMAZON].join(',')]);
  });
});

describe('★ P6 — the plan', () => {
  it('equal quantities ⇒ no PATCH (igual), nothing written back', async () => {
    const c = cenario();
    c.get = [listing(3)];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'igual', quantidadeAmazon: 3 });
    expect(c.chamadas).toEqual(['GET']);
    expect(envioDoLink(c)).toBeUndefined();
    expect(avisosTocados(c)).toBe(0);
  });

  it('the recent-send rule: equal quantities, but a DIFFERENT quantity sent two minutes ago ⇒ one PATCH', async () => {
    const c = cenario({ erp: 5 });
    envioArmazenado(c, envioPatch(3, AGORA_MS - 2 * MINUTO_MS));
    c.get = [listing(5)];
    const r = await c.rodar();
    expect(c.patches).toEqual([5]);
    expect(r.regra).toBe('envio-recente');
  });

  it('★ a delta 10 min after our PATCH of 2, the ERP back at Amazon’s still-visible 3 ⇒ one PATCH of 3', async () => {
    const c = cenario({ erp: 3 });
    envioArmazenado(c, envioPatch(2, AGORA_MS - 10 * MINUTO_MS));
    c.get = [listing(3)];
    await c.rodar();
    expect(c.patches).toEqual([3]);
  });

  it('NEAR-MISS: the same PATCH of 2 sixteen minutes ago ⇒ igual, no PATCH', async () => {
    const c = cenario({ erp: 3 });
    envioArmazenado(c, envioPatch(2, AGORA_MS - 16 * MINUTO_MS));
    c.get = [listing(3)];
    await c.rodar();
    expect(c.patches).toEqual([]);
  });

  it('the feed-recent rule: equal quantities 4 min after the stock lease’s last feed end ⇒ one PATCH', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_VEZ, { [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: AGORA_MS - 4 * MINUTO_MS });
    c.get = [listing(3)];
    const r = await c.rodar();
    expect(c.patches).toEqual([3]);
    expect(r.regra).toBe('feed-recente');
  });

  it('NEAR-MISS: 16 min after the feed’s end ⇒ igual, no PATCH', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_VEZ, { [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: AGORA_MS - 16 * MINUTO_MS });
    c.get = [listing(3)];
    await c.rodar();
    expect(c.patches).toEqual([]);
  });

  it('the lease is read ONCE, by id, masked to that one field', async () => {
    const c = cenario();
    await c.rodar();
    expect(lidoEm(c, 'feedsAmazonEmCurso/')).toEqual([
      expect.objectContaining({
        caminho: CAMINHO_VEZ,
        via: 'getAll',
        mascara: [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON],
      }),
    ]);
  });

  it.each([['um texto'], [-1], [1.5]])(
    'a lease value no ms writer stamps (%s) reads as no feed on record: igual, no PATCH, no throw',
    async (valor) => {
      const c = cenario();
      c.fake.seed(CAMINHO_VEZ, { [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: valor });
      c.get = [listing(3)];
      const r = await c.rodar();
      expect(r.motivo).toBe('igual');
      expect(c.patches).toEqual([]);
    },
  );

  it('★ a catch-up with ERP 3 and a live read of 3 ⇒ one PATCH of 3 (forced)', async () => {
    const c = cenario();
    c.get = [listing(3)];
    const r = await c.rodar(catchUp());
    expect(c.patches).toEqual([3]);
    expect(r.regra).toBe('forcado');
  });

  it('NEAR-MISS: a delta task in the same state ⇒ no PATCH', async () => {
    const c = cenario();
    c.get = [listing(3)];
    await c.rodar();
    expect(c.patches).toEqual([]);
  });

  it.each<[string, () => TarefaEstoqueAmazon]>([
    ['a reconcile task (at the conta’s depósito)', () => reconciliacao()],
    [
      'a manual task',
      () => tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.manual, referencia: 'pedido-manual-1' }),
    ],
  ])(
    'NEAR-MISS: %s in the same state ⇒ igual, no PATCH: only a catch-up is forced',
    async (_c, t) => {
      const c = cenario();
      c.get = [listing(3)];
      const r = await c.rodar(t());
      expect(r).toMatchObject({ acao: 'encerrado', motivo: 'igual' });
      expect(c.patches).toEqual([]);
    },
  );
});

describe('★ P6 — the task’s own budget, right before the PATCH', () => {
  it('★ (mutation 9) a slow fake db pushing P3/P4 past the budget ⇒ ZERO PATCH calls and a throw', async () => {
    const c = cenario();
    // Every document read costs 60 s of the clock.
    c.agora = () => AGORA_MS + c.fake.contagem.leituras * 60_000;
    const r = c.rodar();
    await expect(r).rejects.toBeInstanceOf(AmazonEstoquePrazoDaTarefaError);
    expect(c.patches).toEqual([]);
    expect(c.chamadas).not.toContain('PATCH');
    expect(despachos(c).map((l) => l.meta?.motivo)).toEqual(['prazo-da-tarefa']);
    expect(despachos(c)[0]?.nivel).toBe('warn');
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('the bound: exactly the budget after the dispatch began ⇒ the PATCH goes out', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      c.relogio = AGORA_MS + ORCAMENTO_ANTES_DO_PATCH_MS;
    };
    await c.rodar();
    expect(c.patches).toEqual([3]);
  });

  it('NEAR-MISS: one ms past it ⇒ no PATCH, a throw', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      c.relogio = AGORA_MS + ORCAMENTO_ANTES_DO_PATCH_MS + 1;
    };
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonEstoquePrazoDaTarefaError);
    expect(c.patches).toEqual([]);
  });

  it('the outcome’s emMs is OUR clock immediately before the PATCH (ms)', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      c.relogio = AGORA_MS + 1234;
    };
    await c.rodar();
    expect(envioDoLink(c)).toMatchObject({
      via: 'patch',
      emMs: AGORA_MS + 1234,
      quantidade: 3,
      resultado: 'aceito',
      submissionId: SUBMISSAO,
    });
  });

  it('NEAR-MISS: the clock moving while the PATCH is in flight leaves emMs at the instant BEFORE it', async () => {
    const c = cenario();
    // Every PATCH that reached the scripted fetch costs 5 s of the clock.
    c.agora = () => AGORA_MS + 1234 + c.patches.length * 5_000;
    await c.rodar();
    expect(c.patches).toEqual([3]);
    expect(envioDoLink(c)?.emMs).toBe(AGORA_MS + 1234);
  });

  it('★ the budget is checked with the write’s credential IN HAND: the write client’s credential read crossing it ⇒ ZERO PATCH calls, prazo-da-tarefa, a throw', async () => {
    const c = cenario();
    // The credential is read by the context, by the GET's client, then by the
    // write client right before the PATCH: only that third read is slow.
    c.agora = () => AGORA_MS + (leiturasDaCredencial(c) >= 3 ? ORCAMENTO_ANTES_DO_PATCH_MS + 1 : 0);
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonEstoquePrazoDaTarefaError);
    expect(leiturasDaCredencial(c)).toBe(3);
    expect(c.patches).toEqual([]);
    expect(c.chamadas).not.toContain('PATCH');
    expect(despachos(c).map((l) => l.meta?.motivo)).toEqual(['prazo-da-tarefa']);
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('★ (mutation 9) NEAR-MISS: only the CONTEXT is slow, everything after it instant ⇒ still no PATCH: the budget counts from the dispatch’s start', async () => {
    const c = cenario();
    const r = processarEstoqueAmazon(tarefa(), {
      ...c.deps(),
      carregarContexto: async (db, integracaoId, depsDoContexto) => {
        const contexto = await loadAmazonContext(db, integracaoId, depsDoContexto);
        c.relogio = AGORA_MS + ORCAMENTO_ANTES_DO_PATCH_MS + 1;
        return contexto;
      },
    });
    await expect(r).rejects.toBeInstanceOf(AmazonEstoquePrazoDaTarefaError);
    expect(c.patches).toEqual([]);
    const [linha] = despachos(c);
    expect(linha).toMatchObject({ nivel: 'warn', meta: { motivo: 'prazo-da-tarefa' } });
  });
});

describe('★ P6 — the PATCH’s forced refresh (a 401/403 on the PATCH: not processed)', () => {
  it('401, then ACCEPTED ⇒ two PATCH calls around ONE LWA refresh; emMs is the SECOND PATCH’s instant', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized'), ACEITO];
    // Every PATCH that reached the scripted fetch costs 5 s of the clock.
    c.agora = () => AGORA_MS + 1234 + c.patches.length * 5_000;
    const r = await c.rodar();
    expect(c.chamadas).toEqual(['GET', 'PATCH', 'LWA', 'PATCH']);
    expect(c.patches).toEqual([3, 3]);
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', status: 'ACCEPTED' });
    expect(envioDoLink(c)?.emMs).toBe(AGORA_MS + 1234 + 5_000);
  });

  it('NEAR-MISS: the clock crossing the budget between the two ⇒ exactly ONE PATCH, prazo-da-tarefa, a throw', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized'), ACEITO];
    c.agora = () => AGORA_MS + (c.patches.length >= 1 ? ORCAMENTO_ANTES_DO_PATCH_MS + 1 : 0);
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonEstoquePrazoDaTarefaError);
    expect(c.patches).toEqual([3]);
    expect(despachos(c).map((l) => l.meta?.motivo)).toEqual(['prazo-da-tarefa']);
  });

  it('a SECOND 401 ⇒ escrita-falhou, ERROR, NO throw, nothing written back', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized'), erroHttp(401, 'Unauthorized')];
    const r = await c.rodar();
    expect(c.chamadas).toEqual(['GET', 'PATCH', 'LWA', 'PATCH']);
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'escrita-falhou' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('ERROR');
    expect(envioDoLink(c)).toBeUndefined();
  });

  /** The scenario's fetch, with the LWA exchange answered by `lwa` instead. */
  const comLwa = (c: Cenario, lwa: () => Promise<Response>): DepsProcessarEstoqueAmazon => {
    const base = c.deps();
    return {
      ...base,
      fetch: (input, init) => {
        if (new URL(String(input)).pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return lwa();
        }
        return (base.fetch ?? fetch)(input, init);
      },
    };
  };

  it('NEAR-MISS: a 401 on the PATCH, then LWA REFUSING the forced refresh ⇒ not the PATCH’s answer: the read ladder (conta-indisponivel, WARNING), never escrita-falhou', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized'), ACEITO];
    const r = await processarEstoqueAmazon(
      tarefa(),
      comLwa(c, () => Promise.resolve(respostaJson(400, { error: 'invalid_grant' }))),
    );
    expect(c.chamadas).toEqual(['GET', 'PATCH', 'LWA']);
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'conta-indisponivel', falha: 'auth-lwa' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('NEAR-MISS: a 401 on the PATCH, then the forced refresh’s LWA exchange DROPPED ⇒ nothing sent: NO provisional incerto, a read-side retry', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized'), ACEITO];
    const r = processarEstoqueAmazon(
      tarefa(),
      comLwa(c, () => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(r).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(c.chamadas).toEqual(['GET', 'PATCH', 'LWA']);
    expect(envioDoLink(c)).toBeUndefined();
    expect(despachos(c).map((l) => [l.meta?.acao, l.meta?.motivo, l.meta?.falha])).toEqual([
      ['retentar', 'leitura-falhou', 'transitorio'],
    ]);
  });
});

describe('★ P7–P8 — the outcome, after a PATCH Amazon answered', () => {
  it('ACCEPTED ⇒ aceito written back, and ONE read-back: named after the submission, 360 s later', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      motivo: 'enviado',
      status: 'ACCEPTED',
      gravados: 1,
      verificacao: 'enfileirada',
      avisoLevantado: false,
    });
    expect(c.fila.enfileiradas).toEqual([
      {
        tarefa: tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao, referencia: SUBMISSAO }),
        id: nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao, CONTA, SKU, SUBMISSAO),
        atrasoS: ATRASO_VERIFICACAO_ESTOQUE_S,
      },
    ]);
    expect(avisosTocados(c)).toBe(0);
  });

  it('ACCEPTED with issues ⇒ aceito-com-avisos, still ONE read-back; the line keeps the codes, never the message', async () => {
    const c = cenario();
    c.patch = [
      submissao('ACCEPTED', [
        { code: '90220', message: 'MENSAGEM-SENTINELA', severity: 'WARNING' },
        { code: 'código com espaço', message: 'MENSAGEM-SENTINELA', severity: 'WARNING' },
      ]),
    ];
    await c.rodar();
    expect(envioDoLink(c)?.resultado).toBe('aceito-com-avisos');
    expect(c.fila.enfileiradas).toHaveLength(1);
    const [linha] = despachos(c);
    expect(linha?.meta?.problemas).toBe('90220,<outro>');
    expect(JSON.stringify(c.log.linhas)).not.toContain('MENSAGEM-SENTINELA');
  });

  it('★ INVALID ⇒ recusado written back AND the conta aviso raised; no read-back', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', status: 'INVALID', avisoLevantado: true });
    expect(envioDoLink(c)?.resultado).toBe('recusado');
    expect(c.fake.ler(AVISO_RECUSADO)).toMatchObject({ resolvidoEm: null });
    expect(c.fila.enfileiradas).toEqual([]);
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
  });

  it('★ a STALE INVALID — the link already holds a NEWER outcome — is kept out, and raises NO aviso: zero aviso reads or writes', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(3, AGORA_MS + MINUTO_MS));
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      status: 'INVALID',
      gravados: 0,
      emConflito: 0,
      avisoLevantado: false,
    });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'aceito', emMs: AGORA_MS + MINUTO_MS });
    expect(avisosTocados(c)).toBe(0);
  });

  it('NEAR-MISS: the link holding an OLDER outcome ⇒ recusado written over it, and the aviso raised', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(3, AGORA_MS - 20 * MINUTO_MS));
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    const r = await c.rodar();
    expect(r).toMatchObject({ gravados: 1, avisoLevantado: true });
    expect(envioDoLink(c)?.resultado).toBe('recusado');
    expect(c.fake.ler(AVISO_RECUSADO)).toMatchObject({ resolvidoEm: null });
  });

  it('an INVALID whose link doc is gone (no link to hold it) raises NO aviso', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    c.depoisDoGet = () => c.fake.apagar(CAMINHO_LINK);
    const r = await c.rodar();
    expect(r).toMatchObject({ status: 'INVALID', gravados: 0, avisoLevantado: false });
    expect(avisosTocados(c)).toBe(0);
  });

  it('NEAR-MISS: an INVALID still in CONFLICT after every attempt (it may be the latest) ⇒ the aviso raised', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    const link = c.fake.ler(CAMINHO_LINK) ?? {};
    // Another writer moves the link doc right before each of our attempts.
    for (let i = 0; i < MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON; i += 1) {
      c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
        c.fake.seed(CAMINHO_LINK, { ...link, outro: i });
      });
    }
    const r = await c.rodar();
    expect(r).toMatchObject({
      status: 'INVALID',
      gravados: 0,
      emConflito: 1,
      avisoLevantado: true,
    });
    expect(envioDoLink(c)).toBeUndefined();
    expect(c.fake.ler(AVISO_RECUSADO)).toMatchObject({ resolvidoEm: null });
  });

  it('★ (mutation 2) a reconcile-origin ACCEPTED ⇒ NO read-back', async () => {
    const c = cenario();
    await c.rodar(reconciliacao());
    expect(c.patches).toEqual([3]);
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ (mutation 2) a read-back that finds the quantity applied ⇒ no PATCH and no further read-back', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(3, AGORA_MS - 6 * MINUTO_MS));
    c.get = [listing(3)];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ motivo: 'igual' });
    expect(c.patches).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ (mutation 2) a read-back that finds it NOT applied ⇒ one PATCH and NO further read-back', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(3, AGORA_MS - 6 * MINUTO_MS));
    c.get = [listing(7)];
    const r = await c.rodar(verificacao());
    expect(c.patches).toEqual([3]);
    expect(r.verificacao).toBeNull();
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('a 2xx that is neither ACCEPTED nor INVALID ⇒ incerto written back, no read-back, no throw', async () => {
    const c = cenario();
    c.patch = [submissao('PENDENTE')];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'escrita-incerta' });
    expect(envioDoLink(c)?.resultado).toBe('incerto');
    expect(c.fila.enfileiradas).toEqual([]);
    expect(despachos(c)[0]?.meta?.status).toBe('<outro>');
  });

  it('an ACCEPTED answer without a submission id ⇒ no read-back (sem-submissao)', async () => {
    const c = cenario();
    c.patch = [{ status: 200, corpo: { sku: SKU, status: 'ACCEPTED' } }];
    const r = await c.rodar();
    expect(r.verificacao).toBe('sem-submissao');
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('NEAR-MISS: a submission id outside the task-name grammar ⇒ no read-back, no throw', async () => {
    const c = cenario();
    c.patch = [
      { status: 200, corpo: { sku: SKU, status: 'ACCEPTED', submissionId: 'sub:com:dois-pontos' } },
    ];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', verificacao: 'sem-submissao', perda: null });
    expect(c.fila.enfileiradas).toEqual([]);
  });
});

describe('the no-throw boundary after the PATCH', () => {
  it('the write-back failing (Firestore) ⇒ no throw; the read-back is still enqueued; the loss is named', async () => {
    const c = cenario();
    c.fake.falharEscrita(CAMINHO_LINK, grpc(14, 'indisponível'));
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      perda: { efeito: 'gravacao', erro: 'Firestore/14' },
      verificacao: 'enfileirada',
    });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
  });

  it('the read-back enqueue refused by the queue valve ⇒ no throw, the loss is named', async () => {
    const c = cenario();
    c.fila.desligado = true;
    const r = await c.rodar();
    expect(r).toMatchObject({
      verificacao: 'perdida',
      perda: { efeito: 'verificacao', erro: 'AmazonEstoqueTarefasDesligadasError' },
    });
    expect(envioDoLink(c)?.resultado).toBe('aceito');
  });

  it.each<[string, () => unknown, string]>([
    [
      'a Cloud Tasks transient',
      () => falhaDoFunctions('unknown-error', 503),
      'AmazonTarefasTransitoriasError',
    ],
    [
      'a raw SDK failure (not transient)',
      () => falhaDoFunctions('invalid-argument', 400),
      'FirebaseFunctionsError/functions/invalid-argument',
    ],
    [
      'a missing queue region',
      () => new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']),
      'MissingRegionError',
    ],
    [
      'a malformed queue region',
      () => new AmazonEstoqueRegiaoDaFilaInvalidaError(),
      'AmazonEstoqueRegiaoDaFilaInvalidaError',
    ],
  ])(
    'the read-back enqueue failing with %s after an ACCEPTED PATCH ⇒ NO throw (a retry would PATCH again), the loss named',
    async (_c, falha, erro) => {
      const c = cenario();
      c.fila.falha = falha;
      const r = await c.rodar();
      expect(r).toMatchObject({
        acao: 'enviado',
        verificacao: 'perdida',
        perda: { efeito: 'verificacao', erro },
      });
      expect(c.patches).toEqual([3]);
      expect(envioDoLink(c)?.resultado).toBe('aceito');
      expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('WARNING');
    },
  );

  it('an UNNAMED failure (a bug) crosses the boundary', async () => {
    const c = cenario();
    c.fila.falha = () => new TypeError('bug');
    await expect(c.rodar()).rejects.toBeInstanceOf(TypeError);
  });

  it('the INVALID aviso write failing (Firestore) ⇒ no throw, avisoLevantado false, the loss named; recusado still written back', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [{ code: '8541', message: 'x', severity: 'ERROR' }])];
    c.fake.falharEscrita(AVISO_RECUSADO, grpc(14, 'indisponível'));
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      status: 'INVALID',
      avisoLevantado: false,
      perda: { efeito: 'aviso', erro: 'Firestore/14' },
    });
    expect(envioDoLink(c)?.resultado).toBe('recusado');
    expect(c.fake.ler(AVISO_RECUSADO)).toBeUndefined();
  });
});

describe('★ P9 — the failures', () => {
  it('★ (mutation 3) a 429 on the PATCH ⇒ the same payload re-enqueued UNNAMED 60 s later, NO throw, no write-back', async () => {
    const c = cenario();
    c.patch = [erroHttp(429, 'QuotaExceeded')];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'pausado', motivo: 'pausado' });
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: tarefa(), id: null, atrasoS: ATRASO_PAUSA_ESTOQUE_S },
    ]);
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('a 429 on the GET ⇒ the same pause, nothing sent', async () => {
    const c = cenario();
    c.get = [erroHttp(429, 'QuotaExceeded')];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'pausado', falha: 'pausa' });
    expect(c.patches).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: tarefa(), id: null, atrasoS: ATRASO_PAUSA_ESTOQUE_S },
    ]);
  });

  it.each<[string, (c: Cenario) => void, abstract new (...a: never[]) => unknown, string]>([
    [
      'refused by the queue valve',
      (c) => {
        c.fila.desligado = true;
      },
      AmazonEstoqueTarefasDesligadasError,
      'AmazonEstoqueTarefasDesligadasError',
    ],
    [
      'hitting a Cloud Tasks transient',
      (c) => {
        c.fila.falha = () => falhaDoFunctions('unknown-error', 503);
      },
      AmazonTarefasTransitoriasError,
      'AmazonTarefasTransitoriasError',
    ],
  ])(
    'the pause re-enqueue %s ⇒ the queue’s OWN retry (nothing was sent, a retry needs no enqueue): ONE WARNING line first (retentar, the loss named), then a throw',
    async (_c, preparar, classe, erroPerda) => {
      const c = cenario();
      c.patch = [erroHttp(429, 'QuotaExceeded')];
      preparar(c);
      await expect(c.rodar()).rejects.toBeInstanceOf(classe);
      expect(c.patches).toEqual([3]);
      expect(c.fila.enfileiradas).toEqual([]);
      expect(envioDoLink(c)).toBeUndefined();
      const linhas = despachos(c);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        nivel: 'warn',
        meta: {
          acao: 'retentar',
          motivo: 'pausado',
          erro: 'AmazonThrottleError',
          perda: 'pausa',
          erroPerda,
        },
      });
    },
  );

  it('NEAR-MISS: an UNNAMED failure of the pause re-enqueue (a bug) crosses, with no line', async () => {
    const c = cenario();
    c.patch = [erroHttp(429, 'QuotaExceeded')];
    c.fila.falha = () => new TypeError('bug');
    await expect(c.rodar()).rejects.toBeInstanceOf(TypeError);
    expect(despachos(c)).toEqual([]);
  });

  it('★ (mutation 8) a CUT PATCH ⇒ the provisional incerto written back FIRST, then a throw', async () => {
    const c = cenario();
    c.patch = [{ rede: true }];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', quantidade: 3, emMs: AGORA_MS });
    expect(despachos(c).map((l) => l.meta?.motivo)).toEqual(['escrita-incerta']);
    expect(despachos(c)[0]?.nivel).toBe('warn');
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('NEAR-MISS: the clock moving while the cut PATCH is in flight leaves the provisional emMs at the instant BEFORE it', async () => {
    const c = cenario();
    c.patch = [{ rede: true }];
    // Every PATCH that reached the scripted fetch costs 5 s of the clock.
    c.agora = () => AGORA_MS + 1234 + c.patches.length * 5_000;
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(c.patches).toEqual([3]);
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', emMs: AGORA_MS + 1234 });
  });

  it('a 5xx PATCH ⇒ the same: incerto, then a throw', async () => {
    const c = cenario();
    c.patch = [erroHttp(503, 'ServiceUnavailable')];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonHttpError' });
    expect(envioDoLink(c)?.resultado).toBe('incerto');
  });

  it('a 2xx PATCH off its schema ⇒ the same: incerto, then a throw', async () => {
    const c = cenario();
    c.patch = [{ status: 200, corpo: { semSku: true } }];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonSchemaError' });
    expect(envioDoLink(c)?.resultado).toBe('incerto');
  });

  it('a cut PATCH whose provisional write-back fails ⇒ still the original throw, the loss named', async () => {
    const c = cenario();
    c.patch = [{ rede: true }];
    c.fake.falharEscrita(CAMINHO_LINK, grpc(14, 'indisponível'));
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(despachos(c)[0]?.meta).toMatchObject({ motivo: 'escrita-incerta', perda: 'gravacao' });
  });

  it('★ a 400 PATCH ⇒ escrita-falhou, ERROR, NO throw, nothing written back', async () => {
    const c = cenario();
    c.patch = [erroHttp(400, 'InvalidInput')];
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'escrita-falhou',
      codigos: ['InvalidInput'],
    });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('ERROR');
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('a 5xx GET ⇒ a throw for the retry (nothing sent), its line first', async () => {
    const c = cenario();
    c.get = [erroHttp(500, 'InternalFailure')];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonHttpError' });
    expect(c.patches).toEqual([]);
    expect(despachos(c)[0]?.meta).toMatchObject({ acao: 'retentar', falha: 'transitorio' });
    // A transient the retry absorbs is a WARNING, never the definite read failure's ERROR.
    expect(despachos(c)[0]?.nivel).toBe('warn');
    expect(envioDoLink(c)).toBeUndefined();
  });

  it('a 400 GET ⇒ leitura-falhou, ERROR, no throw', async () => {
    const c = cenario();
    c.get = [erroHttp(400, 'InvalidInput')];
    const r = await c.rodar();
    expect(r).toMatchObject({ motivo: 'leitura-falhou', falha: 'http-definitivo' });
    expect(severidadeDoDespachoEstoqueAmazon(r)).toBe('ERROR');
  });

  it('a Firestore error in P3 is the queue’s to retry: thrown, no dispatch line', async () => {
    const c = cenario();
    c.fake.falharConsulta('prodAmazon', grpc(14, 'indisponível'));
    await expect(c.rodar()).rejects.toMatchObject({ code: 14 });
    expect(despachos(c)).toEqual([]);
    expect(c.chamadas).toEqual([]);
  });
});

describe('★ the lost-answer case', () => {
  it('Amazon 3, ERP 4, the PATCH of 4 cut; ERP back to 3; the retry reads 3 ⇒ exactly ONE PATCH of 3', async () => {
    const c = cenario({ erp: 4 });
    c.get = [listing(3)];
    c.patch = [{ rede: true }];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(c.patches).toEqual([4]);

    erp(c, 3);
    c.patch = [ACEITO];
    c.relogio = AGORA_MS + MINUTO_MS;
    c.tentativa = 1;
    await c.rodar();
    expect(c.patches).toEqual([4, 3]);
  });

  it('NEAR-MISS: without the provisional entry the retry reads igual, and the late 4 would stand', async () => {
    const c = cenario({ erp: 4 });
    c.get = [listing(3)];
    c.patch = [{ rede: true }];
    await expect(c.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    // The provisional entry, gone.
    const { envioEstoqueAmazon: _apagado, ...link } = c.fake.ler(CAMINHO_LINK) ?? {};
    c.fake.seed(CAMINHO_LINK, link);

    erp(c, 3);
    c.relogio = AGORA_MS + MINUTO_MS;
    const r = await c.rodar();
    expect(r.motivo).toBe('igual');
    expect(c.patches).toEqual([4]);
  });
});

describe('★ (mutation 11) the masks: the whole task reads every link doc, produto, estoque row and the lease MASKED', () => {
  it('opted in on all four collections, the happy path still sends ONE PATCH', async () => {
    const c = cenario();
    c.fake.exigirMascaraEm('prodAmazon');
    c.fake.exigirMascaraEm('produtos');
    c.fake.exigirMascaraEm('estoques');
    c.fake.exigirMascaraEm('feedsAmazonEmCurso');
    await c.rodar();
    expect(c.patches).toEqual([3]);
    for (const l of c.fake.leiturasDetalhadas.filter((x) => x.caminho.startsWith('produtos/'))) {
      expect(l.mascara, l.caminho).not.toBeNull();
    }
  });
});

describe('the dispatch line', () => {
  it('ONE line per run, evento estoque, carrying ids, closed codes and both quantities', async () => {
    const c = cenario();
    await c.rodar();
    const linhas = despachos(c);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({
      evento: 'estoque',
      fila: 'processAmazonStockPatch',
      acao: 'enviado',
      motivo: 'enviado',
      origem: 'delta',
      sku: SKU,
      quantidadeErp: 3,
      quantidadeAmazon: 7,
      direcao: 'desce',
      regra: 'diferente',
      status: 'ACCEPTED',
      conta: CONTA,
      fluxo: 'estoque',
      tentativa: 0,
    });
  });

  it('the shapes the verdict and the gate only COUNT ride the result and the line — on a returned run AND on a retry', async () => {
    /** The link carries no ASIN (the verdict counts it); the answer carries no relationships (the gate counts it). */
    const contavel = () => {
      const c = cenario();
      c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), asin: null });
      c.get = [listing(7, { relationships: undefined })];
      return c;
    };
    const c = contavel();
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', contagens: ['semAsinNoVinculo', 'semRelacoes'] });
    expect(despachos(c)[0]?.meta?.contagens).toBe('semAsinNoVinculo,semRelacoes');

    const d = contavel();
    d.patch = [{ rede: true }];
    await expect(d.rodar()).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(despachos(d)[0]?.meta).toMatchObject({
      acao: 'retentar',
      contagens: 'semAsinNoVinculo,semRelacoes',
    });
  });

  it('NEAR-MISS: a link with its ASIN and an answer with relationships count nothing', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r.contagens).toEqual([]);
    expect(despachos(c)[0]?.meta?.contagens).toBeNull();
  });

  it('registrarDespachoEstoqueAmazon maps an unknown HTTP code and status to <outro>', () => {
    const log = loggerEspiao();
    registrarDespachoEstoqueAmazon(
      log.logger,
      {
        acao: 'encerrado',
        motivo: 'escrita-falhou',
        contaId: CONTA,
        sku: SKU,
        origem: 'delta',
        quantidadeErp: 1,
        quantidadeAmazon: null,
        direcao: null,
        regra: null,
        dryRun: null,
        status: 'QUALQUER',
        problemas: [],
        codigos: ['CodigoInventado'],
        falha: null,
        erro: 'AmazonHttpError',
        contagens: [],
        gravados: null,
        emConflito: null,
        avisoLevantado: false,
        verificacao: null,
        perda: null,
      },
      { tentativa: 2, idTarefa: null },
    );
    expect(log.linhas[0]?.nivel).toBe('error');
    expect(log.linhas[0]?.meta).toMatchObject({ status: '<outro>', codigos: '<outro>' });
  });
});

describe('depositoIdDaContaEstoqueAmazon — the conta’s depósito, in either stored form', () => {
  it('both forms name the depósito', () => {
    expect(depositoIdDaContaEstoqueAmazon(`documents/depositos/${DEP}`)).toBe(DEP);
    expect(depositoIdDaContaEstoqueAmazon(`depositos/${DEP}`)).toBe(DEP);
  });

  it.each([
    null,
    undefined,
    '',
    DEP,
    `documents/outra/${DEP}`,
    `documents/depositos/${DEP}/sub/x`,
    `/depositos/${DEP}`,
    'depositos/..',
    42,
  ])('NEAR-MISS: %s names no depósito', (ref) => {
    expect(depositoIdDaContaEstoqueAmazon(ref)).toBeNull();
  });
});

describe('the reads of a happy dispatch, counted', () => {
  it('a simple produto costs EXACTLY: the conta, the credential THREE times (the context, then the getter before the GET and before the PATCH), the dono TWICE (the verdict’s mask, then the family’s), its row, the lease, the link doc for the write-back; ONE link query and ONE children seek; one write', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.fake.contagem).toEqual({ leituras: 9, chamadasGetAll: 5, consultas: 2, escritas: 1 });
    const caminhoDono = `produtos/${PRODUTO}`;
    expect(c.fake.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      [caminhoConta(CONTA), null],
      [caminhoCredencial(CONTA), null],
      [caminhoDono, ['ehKit', 'paiId', 'filhoUnicoId', 'statusProdutosMarketplace']],
      [caminhoDono, ['ehKit', 'ehKitVirtual', 'publicado', 'componentesKit', 'timestamp']],
      [CAMINHO_ESTOQUE, ['depositoOuterRef', 'quantidade', 'quantidadeReservada']],
      [CAMINHO_VEZ, [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]],
      [caminhoCredencial(CONTA), null],
      [caminhoCredencial(CONTA), null],
      [CAMINHO_LINK, ['envioEstoqueAmazon']],
    ]);
    expect(c.fake.consultas.map((q) => [q.colecao, q.limite])).toEqual([
      ['prodAmazon', 10],
      ['produtos', 2],
    ]);
    expect(c.fake.escritas.map((w) => [w.verbo, w.caminho])).toEqual([['update', CAMINHO_LINK]]);
  });
});

describe('the deps’ shape', () => {
  it('the producer is built only when an enqueue is due', async () => {
    const c = cenario();
    c.get = [listing(3)];
    const produtor = vi.fn(() => c.fila.produtor());
    const r = await processarEstoqueAmazon(tarefa(), { ...c.deps(), produtor });
    expect(r.motivo).toBe('igual');
    expect(produtor).not.toHaveBeenCalled();
  });

  it('a re-run of an ACCEPTED dispatch dedupes its read-back by the submission’s name', async () => {
    const c = cenario();
    await c.rodar();
    c.get = [listing(7)];
    const r = await c.rodar();
    expect(r.verificacao).toBe('ja-enfileirada');
    expect(c.fila.enfileiradas).toHaveLength(1);
  });

  it('the lease written by another run is never written here (only read)', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_VEZ, {
      [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: AGORA_MS - JANELA_VISIBILIDADE_MS,
    });
    await c.rodar();
    expect(c.fake.escritasEm(CAMINHO_VEZ)).toEqual([]);
  });
});
