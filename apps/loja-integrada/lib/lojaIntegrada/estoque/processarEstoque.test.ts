/**
 * ONE stock send run (master plan step 12, PR 12-e), offline: the REAL engine, write context,
 * park, ERP reads and aviso writer, against the fake Firestore and a stateful Loja Integrada
 * (`testing/plataformaEscritaLi.ts`, the store's stock rows by PRODUCT id).
 *
 * Every case pins its COST: Firestore operations (document reads + queries, the credential reads
 * apart), credential reads, store calls, Firestore writes and enqueues — every skip at zero
 * credential reads and zero calls, and never more than one PUT in any run (checked after every
 * test).
 *
 * No call to the store: the global `fetch` is stubbed to throw for every test of this file, the unit config's
 * kill-switch fails any real host, and the platform is the only `fetch` a client gets.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  LiAuthError,
  LiHttpError,
  LiNetworkError,
  LiThrottleError,
  PRAZO_LI_MS,
} from '@delfrance/integrations-loja-integrada';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  type OrigemTarefaEstoqueLi,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  type TarefaEstoqueLi,
  tarefaEstoqueLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes, lerContaEmCache } from '../core/contaCache';
import { docCredencial } from '../core/credentialStore';
import { PRAZO_ULTIMA_ESCRITA_MS, PrazoDeEscritaEsgotadoLiError } from '../core/escrita';
import { LiCredencialTrocadaError } from '../core/erros';
import { RITMO_ESCRITA_LI_MS } from '../core/ritmo';
import {
  type AmbienteLi,
  CANARIO_ENV_LI,
  CHAMADAS_ENV_LI,
  MODO_LI,
  VALVULA_ENV_LI,
} from '../core/valvulas';
import { LiTarefasDesligadasError, LiTarefasTransitoriasError } from '../notificacoes/agendador';
import { FakeDb, asDb, type DocData, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  type LinhaGravada,
  seedCredencial,
} from '../testing/fixtures';
import { ID_PRODUTO_LI } from '../testing/pedidosLi';
import {
  CAMINHO_ESTOQUE_PRODUTO_LI,
  type PlataformaEscritaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  naProxima,
  respostaJson,
} from '../testing/plataformaEscritaLi';
import { type OpcoesEnfileiramentoEstoqueLi, idDaTarefaEstoqueLi } from './agendadorEstoque';
import { chaveDoAvisoEstoqueRecusadoLi } from './avisosEstoque';
import {
  type DepsEstoqueLi,
  PIOR_EXECUCAO_ESTOQUE_LI_MS,
  type ResultadoEstoqueLi,
  TETO_ESTOQUE_ENV_LI,
  lerTetoEstoqueLi,
  processarTarefaEstoqueLi,
  tipoEscritaDaOrigemLi,
} from './processarEstoque';

const CONTA = 'conta-li-est';
const DEP = 'dep-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const OUTRO_DEP = 'documents/depositos/dep-2';
const PRODUTO = 'p-filho';
const CANONICO = `est-${PRODUTO}-${DEP}`;
const ID_LI = String(ID_PRODUTO_LI);
const JANELA = Math.floor(AGORA_MS / 60_000);
const CREDENCIAL = caminhoCredencial(CONTA);
const AVISO_RECUSADO = caminhoAviso(chaveDoAvisoEstoqueRecusadoLi(CONTA, PRODUTO));

const GET = `GET ${CAMINHO_ESTOQUE_PRODUTO_LI}`;
const PUT = `PUT ${CAMINHO_ESTOQUE_PRODUTO_LI}`;

/** One Loja Integrada call that runs to its whole deadline, read or write. */
const PRAZO_DE_UMA_CHAMADA_MS = Math.max(PRAZO_LI_MS.leitura, PRAZO_LI_MS.escrita);

/** Every scenario a test built: none may have sent more than one PUT (checked after each test). */
const cenariosDoTeste: Cenario[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  // No call to the store, per file: nothing here may reach the global `fetch`.
  vi.stubGlobal('fetch', () => {
    throw new Error('processarEstoque.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  for (const c of cenariosDoTeste.splice(0)) expect(c.p.puts().length).toBeLessThanOrEqual(1);
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                                  The harness                                */
/* -------------------------------------------------------------------------- */

/** A child link of the conta to store product `ID_LI`, in the stored wire shape. */
function link(over: DocData = {}): DocData {
  return {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: ID_PRODUTO_LI,
    paiProdutoIntegradaId: 900_001,
    sku: 'SKU-F',
    ...over,
  };
}

function tarefa(over: Partial<TarefaEstoqueLi> = {}): TarefaEstoqueLi {
  return {
    tipo: 'estoque',
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
    janela: JANELA,
    estoqueId: null,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
    ...over,
  };
}

interface OpcoesCenario {
  /** The stock valve (`null`: unset). Default `on`. */
  readonly modo?: string | null;
  /** The stock canary (`null`: unset). Default `*`. */
  readonly canario?: string | null;
  /** The read switch on (default). */
  readonly chamadas?: boolean;
  /** `LOJA_INTEGRADA_ESTOQUE_MAX` (unset by default). */
  readonly teto?: string;
  /** The conta document (`null`: none). */
  readonly conta?: DocData | null;
  /** The produto document (`null`: none). Default a plain child. */
  readonly produto?: DocData | null;
  /** The produto's own links, by doc id. Default ONE child link of the conta. */
  readonly links?: Readonly<Record<string, DocData>>;
  /** Stock records: [produtoId, recordId, data]. Default the canonical record, 5 in stock. */
  readonly estoques?: readonly (readonly [string, string, DocData])[];
  /** The store's row for `ID_LI` (`null`: none, a 404). Default managed, 1 in stock, none reserved. */
  readonly linha?: DocData | null;
  /** The Cloud Tasks attempt. Default 0. */
  readonly tentativa?: number;
  /** A clock that every wait advances by its length and every call by a FULL deadline. */
  readonly cronometrado?: boolean;
  readonly inicioDaTarefaMs?: number;
  /** What the producer answers. Default: it records and resolves. */
  readonly enfileirar?: () => Promise<void>;
  /** Runs (and is awaited) after each store call is answered (`n`: its 0-based index). */
  readonly aoResponder?: (
    metodo: string,
    caminho: string,
    n: number,
    c: Cenario,
  ) => void | Promise<void>;
}

interface Cenario {
  readonly db: FakeDb;
  readonly p: PlataformaEscritaLi;
  readonly linhas: LinhaGravada[];
  readonly avisos: unknown[][];
  readonly erros: unknown[][];
  readonly enfileiradas: { tarefa: unknown; opcoes: OpcoesEnfileiramentoEstoqueLi }[];
  /** The clock at each store call, as it started (the timed scenarios). */
  readonly instantes: number[];
  decorridoMs(): number;
  rodar(dados?: unknown): Promise<ResultadoEstoqueLi>;
  custo(): {
    erp: number;
    credencial: number;
    chamadas: number;
    escritas: number;
    enfileiradas: number;
  };
  /** The run's own WARNING lines (`[loja-integrada/estoque] <motivo>`), by motivo. */
  motivosAviso(): string[];
  /** The run's own ERROR lines, by motivo. */
  motivosErro(): string[];
}

function ambiente(o: OpcoesCenario): AmbienteLi {
  const modo = o.modo === undefined ? MODO_LI.on : o.modo;
  const canario = o.canario === undefined ? '*' : o.canario;
  return {
    ...(o.chamadas === false ? {} : { [CHAMADAS_ENV_LI]: MODO_LI.on }),
    ...(modo === null ? {} : { [VALVULA_ENV_LI.estoque]: modo }),
    ...(canario === null ? {} : { [CANARIO_ENV_LI.estoque]: canario }),
    ...(o.teto === undefined ? {} : { [TETO_ESTOQUE_ENV_LI]: o.teto }),
  };
}

function cenario(o: OpcoesCenario = {}): Cenario {
  const db = new FakeDb();
  const conta =
    o.conta === undefined
      ? {
          tipo: INTEGRACAO_TIPO.lojaIntegrada,
          nome: 'Loja E',
          ativo: true,
          depositoOuterRef: CANONICA,
        }
      : o.conta;
  if (conta !== null) db.seed(`integracao/${CONTA}`, conta);
  seedCredencial(db, CONTA);
  const produto = o.produto === undefined ? { ehKit: false, sku: 'SKU-F' } : o.produto;
  if (produto !== null) db.seed(`produtos/${PRODUTO}`, produto);
  for (const [id, dados] of Object.entries(o.links ?? { l1: link() })) {
    db.seed(`produtos/${PRODUTO}/produtolojaintegrada/${id}`, dados);
  }
  for (const [produtoId, id, dados] of o.estoques ?? [
    [PRODUTO, CANONICO, { depositoOuterRef: CANONICA, quantidade: 5, quantidadeReservada: 0 }],
  ]) {
    db.seed(`produtos/${produtoId}/estoques/${id}`, dados);
  }
  const linhaLi =
    o.linha === undefined
      ? linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 1, quantidade_reservada: 0 })
      : o.linha === null
        ? null
        : linhaEstoqueLi(ID_PRODUTO_LI, o.linha);
  const p = criarPlataformaEscritaLi({ estoque: linhaLi === null ? [] : [linhaLi] });
  const gravador = gravadorDeLog();
  const avisos: unknown[][] = [];
  const erros: unknown[][] = [];
  const enfileiradas: Cenario['enfileiradas'] = [];
  const instantes: number[] = [];
  const relogio = { ms: AGORA_MS };
  const cronometrado = o.cronometrado === true;
  let n = 0;
  const c: Cenario = {
    db,
    p,
    linhas: gravador.linhas,
    avisos,
    erros,
    enfileiradas,
    instantes,
    decorridoMs: () => relogio.ms - AGORA_MS,
    rodar: (dados = tarefa()) => processarTarefaEstoqueLi(asDb(db), dados, deps),
    custo: () => ({
      erp: db.leituras.filter((l) => l !== CREDENCIAL).length + db.consultas.length,
      credencial: db.leituras.filter((l) => l === CREDENCIAL).length,
      chamadas: p.requisicoes.length,
      escritas: db.escritas.length,
      enfileiradas: enfileiradas.length,
    }),
    motivosAviso: () => avisos.map((args) => String((args[1] as { motivo?: unknown }).motivo)),
    motivosErro: () => erros.map((args) => String((args[1] as { motivo?: unknown }).motivo)),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    instantes.push(relogio.ms);
    const resposta = await p.fetch(input, init);
    if (cronometrado) relogio.ms += PRAZO_DE_UMA_CHAMADA_MS;
    const indice = n;
    n += 1;
    await o.aoResponder?.(init?.method ?? 'GET', new URL(String(input)).pathname, indice, c);
    return resposta;
  };
  const deps: DepsEstoqueLi = {
    ambiente: ambiente(o),
    esperar: (ms) => {
      if (cronometrado) relogio.ms += ms;
      return p.esperar(ms);
    },
    agoraMs: () => relogio.ms,
    inicioDaTarefaMs: o.inicioDaTarefaMs ?? AGORA_MS,
    increment,
    logger: {
      warn: (...args: unknown[]) => avisos.push(args),
      error: (...args: unknown[]) => erros.push(args),
    },
    registro: { escrever: gravador.escrever, tentativa: o.tentativa ?? 0, idTarefa: 't-1' },
    fetch,
    tentativa: o.tentativa ?? 0,
    agendador: {
      enfileirar: (t, opcoes) => {
        enfileiradas.push({ tarefa: t, opcoes });
        return o.enfileirar === undefined ? Promise.resolve() : o.enfileirar();
      },
    },
  };
  cenariosDoTeste.push(c);
  return c;
}

const doEvento = (c: Cenario, evento: string) => c.linhas.filter((l) => l.campos.evento === evento);

const SEM_CUSTO = { erp: 0, credencial: 0, chamadas: 0, escritas: 0, enfileiradas: 0 };
const custoDeSkip = (erp: number) => ({ ...SEM_CUSTO, erp });

/** The store row moves under the run: an order LEAVES between the GET and the PUT (q−k, r−k). */
function pedidoSaiDuranteOEnvio(p: PlataformaEscritaLi, k: number): void {
  p.fila.push((r) => {
    if (r.metodo !== 'GET' || r.caminho !== CAMINHO_ESTOQUE_PRODUTO_LI) return null;
    const linha = p.estado.estoque.get(ID_PRODUTO_LI);
    if (linha === undefined) throw new TypeError('sem linha');
    const resposta = respostaJson(200, structuredClone(linha));
    linha.quantidade = Number(linha.quantidade) - k;
    linha.quantidade_reservada = Number(linha.quantidade_reservada) - k;
    linha.quantidade_disponivel = Number(linha.quantidade) - Number(linha.quantidade_reservada);
    return resposta;
  });
}

/** Change the store's row right after the PUT lands (what the read-back then sees). */
function depoisDoPut(mudar: (linha: DocData, p: PlataformaEscritaLi) => void) {
  return (metodo: string, _caminho: string, _n: number, c: Cenario) => {
    if (metodo !== 'PUT') return;
    const linha = c.p.estado.estoque.get(ID_PRODUTO_LI);
    if (linha !== undefined) mudar(linha, c.p);
  };
}

/* -------------------------------------------------------------------------- */
/*                          The payload, the valve, the cap                    */
/* -------------------------------------------------------------------------- */

describe('before anything is read: the payload, the valve, the cap', () => {
  it.each([
    ['a quantity', { quantidade: 7 }],
    ['an S', { S: 5 }],
    ['the store’s reservation', { quantidade_reservada: 2 }],
    ['generation 1 on an event', { geracao: 1 }],
    ['generation 0 on a deriva', { origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva }],
    ['no tipo', { tipo: undefined }],
  ])('a payload with %s is refused: zero reads, zero calls, no valve line', async (_r, over) => {
    const c = cenario();
    const dados: Record<string, unknown> = { ...tarefa(), ...over };
    if (Object.hasOwn(over, 'tipo')) delete dados.tipo;
    expect(await c.rodar(dados)).toEqual({ kind: 'payload-invalido' });
    expect(c.custo()).toEqual(SEM_CUSTO);
    expect(doEvento(c, 'valvula')).toEqual([]);
  });

  it.each([null, '', 'ON', ' on', 'on ', 'true', 'off'])(
    'the valve %j ⇒ desligado with ZERO reads and zero calls',
    async (modo) => {
      const c = cenario({ modo });
      expect(await c.rodar()).toEqual({ kind: 'desligado' });
      expect(c.custo()).toEqual(SEM_CUSTO);
      expect(doEvento(c, 'valvula')).toHaveLength(1);
    },
  );

  it.each(['0', '-1', '1.5', ' 3', '3 ', '03', 'abc', '1e3', String(2 ** 53)])(
    'the cap %j is unreadable ⇒ teto-invalido, one ERROR line, zero reads and zero calls',
    async (teto) => {
      const c = cenario({ teto });
      expect(await c.rodar()).toEqual({ kind: 'teto-invalido' });
      expect(c.custo()).toEqual(SEM_CUSTO);
      expect(c.motivosErro()).toEqual(['teto-invalido']);
      expect(c.motivosAviso()).toEqual([]);
    },
  );

  it('the cap reader: unset or EXACTLY blank ⇒ none; a canonical positive integer ⇒ itself', () => {
    expect(lerTetoEstoqueLi({})).toBe(Number.POSITIVE_INFINITY);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: '' })).toBe(Number.POSITIVE_INFINITY);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: '3' })).toBe(3);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: '120' })).toBe(120);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: ' ' })).toBeNull();
  });

  it('the cap from the environment: ESTOQUE_MAX 3, S 5, R 1 ⇒ PUT 4', async () => {
    const c = cenario({ teto: '3', linha: { quantidade: 0, quantidade_reservada: 1 } });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 4 });
  });
});

/* -------------------------------------------------------------------------- */
/*                 The skips: zero credential reads, zero store calls          */
/* -------------------------------------------------------------------------- */

describe('every skip costs ZERO credential reads and ZERO store calls', () => {
  const pai = { ...link(), paiProdutoIntegradaId: null, grades: ['Cor'] };
  const simples = { ...link(), paiProdutoIntegradaId: null, grades: null };
  const doisAutoIds: OpcoesCenario['estoques'] = [
    [PRODUTO, 'auto-a', { depositoOuterRef: CANONICA, quantidade: 5 }],
    [PRODUTO, 'auto-b', { depositoOuterRef: NUA, quantidade: 2 }],
  ];

  it.each<[string, OpcoesCenario, ResultadoEstoqueLi, number]>([
    ['no conta', { conta: null }, { kind: 'pulado', motivo: 'conta-inexistente' }, 1],
    [
      'another channel’s conta',
      { conta: { tipo: INTEGRACAO_TIPO.lojaIntegrada + 1, nome: 'x', ativo: true } },
      { kind: 'pulado', motivo: 'conta-inexistente' },
      1,
    ],
    [
      'an inactive conta',
      {
        conta: {
          tipo: INTEGRACAO_TIPO.lojaIntegrada,
          nome: 'x',
          ativo: false,
          depositoOuterRef: CANONICA,
        },
      },
      { kind: 'pulado', motivo: 'conta-inativa' },
      1,
    ],
    [
      'a conta with no depósito',
      { conta: { tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'x', ativo: true } },
      { kind: 'pulado', motivo: 'conta-sem-deposito' },
      1,
    ],
    ['no produto', { produto: null }, { kind: 'pulado', motivo: 'produto-inexistente' }, 3],
    ['no link', { links: {} }, { kind: 'pulado', motivo: 'sem-vinculo' }, 3],
    [
      'a trashed link',
      { links: { l1: link({ removido: true }) } },
      { kind: 'pulado', motivo: 'sem-vinculo' },
      3,
    ],
    ['a parent link', { links: { l1: pai } }, { kind: 'pulado', motivo: 'pai' }, 3],
    ['a simple root', { links: { l1: simples } }, { kind: 'pulado', motivo: 'nao-suportado' }, 3],
    [
      'two store products',
      { links: { l1: link(), l2: link({ id: ID_PRODUTO_LI + 1 }) } },
      { kind: 'pulado', motivo: 'vinculo-ambiguo' },
      3,
    ],
    [
      'the parity switch off',
      {
        produto: {
          ehKit: false,
          statusProdutosMarketplace: { [`${CONTA}_${ID_LI}`]: { enviarEstoque: false } },
        },
      },
      { kind: 'pulado', motivo: 'paridade' },
      3,
    ],
    [
      'two auto-id records, no canonical',
      { estoques: doisAutoIds },
      { kind: 'pulado', motivo: 'estoque-ambiguo' },
      4,
    ],
    ['no record anywhere', { estoques: [] }, { kind: 'pulado', motivo: 'retido' }, 5],
  ])('%s', async (_rotulo, o, esperado, erp) => {
    const c = cenario(o);
    expect(await c.rodar()).toEqual(esperado);
    expect(c.custo()).toEqual(custoDeSkip(erp));
  });

  it('⚠️ a link skip reads NO stock record: conta, produto and links only (3)', async () => {
    const c = cenario({ links: { l1: pai } });
    await c.rodar();
    expect(c.db.leituras).toEqual([`integracao/${CONTA}`, `produtos/${PRODUTO}`]);
    expect(c.db.consultas.map((q) => q.colecao)).toEqual([
      `produtos/${PRODUTO}/produtolojaintegrada`,
    ]);
  });

  it('a duplicate link on ANOTHER produto ⇒ vinculo-duplicado after the two probe queries (6), one WARNING', async () => {
    const c = cenario();
    c.db.seed('produtos/outro/produtolojaintegrada/l9', link({ id: ID_LI }));
    expect(await c.rodar()).toEqual({ kind: 'pulado', motivo: 'vinculo-duplicado' });
    expect(c.custo()).toEqual(custoDeSkip(6));
    expect(c.motivosAviso()).toEqual(['vinculo-duplicado']);
    expect(c.motivosErro()).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a TRASHED link on another produto is no duplicate — the run sends', async () => {
    const c = cenario();
    c.db.seed('produtos/outro/produtolojaintegrada/l9', link({ removido: true }));
    expect((await c.rodar()).kind).toBe('escrito');
  });

  it.each<[string, OpcoesCenario, string]>([
    ['held', { estoques: [] }, 'retido'],
    ['ambiguous', { estoques: doisAutoIds }, 'estoque-ambiguo'],
  ])(
    'the %s produto is ONE WARNING line, never an ERROR, and no aviso written (its per-conta aviso is the reconcile’s)',
    async (_r, o, motivo) => {
      const c = cenario(o);
      expect(await c.rodar()).toEqual({ kind: 'pulado', motivo });
      expect(c.motivosAviso()).toEqual([motivo]);
      expect(c.motivosErro()).toEqual([]);
      expect(c.custo().escritas).toBe(0);
    },
  );

  it('the read switch off ⇒ dropped at the context: the ERP reads paid (6), ZERO credential reads, zero calls', async () => {
    const c = cenario({ chamadas: false });
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'chamadas-desligadas' });
    expect(c.custo()).toEqual(custoDeSkip(6));
    expect(doEvento(c, 'chamada-bloqueada')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                          The own record and the hint                        */
/* -------------------------------------------------------------------------- */

describe('a reconcile send carries its run’s depósito (PR 12-g)', () => {
  const doReconcile = (depositoId: string) =>
    tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile, depositoId });
  const leiturasDaConta = (c: Cenario) =>
    c.db.leituras.filter((l) => l === `integracao/${CONTA}`).length;
  const contaEm = (depositoOuterRef: string) => ({
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja E',
    ativo: true,
    depositoOuterRef,
  });

  it('⚠️ the conta names ANOTHER depósito now ⇒ dropped (deposito-mudou, ONE WARNING) before the produto is read: zero credential reads, zero store calls', async () => {
    const c = cenario({ conta: contaEm(OUTRO_DEP) });
    expect(await c.rodar(doReconcile(DEP))).toEqual({ kind: 'pulado', motivo: 'deposito-mudou' });
    expect(c.motivosAviso()).toEqual(['deposito-mudou']);
    // The conta read twice (the second past the cache), nothing else.
    expect(c.custo()).toEqual(custoDeSkip(2));
  });

  it('⚠️ NEAR-MISS: the SAME depósito in the other stored form is the run’s depósito — sent, ONE conta read, no second', async () => {
    const c = cenario({ conta: contaEm(NUA) });
    expect(await c.rodar(doReconcile(DEP))).toEqual({ kind: 'escrito-lote' });
    expect(leiturasDaConta(c)).toBe(1);
  });

  it('⚠️ a CACHED copy of the conta from before a re-point: the send of the NEW depósito evicts it and reads the conta once more — computed at the new depósito, never the cached one', async () => {
    const c = cenario();
    await lerContaEmCache(asDb(c.db), CONTA);
    c.db.seed(`integracao/${CONTA}`, contaEm(OUTRO_DEP));
    expect(await c.rodar(doReconcile('dep-2'))).toEqual({ kind: 'escrito-lote' });
    expect(leiturasDaConta(c)).toBe(2);
    // dep-2 holds no record of the produto, the old depósito does: the real 0 is sent.
    expect(c.p.puts()).toHaveLength(1);
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 0 });
  });

  it('⚠️ NEAR-MISS: another origin carries no depósito and pays no check — the cached copy serves it', async () => {
    const c = cenario();
    await lerContaEmCache(asDb(c.db), CONTA);
    c.db.seed(`integracao/${CONTA}`, contaEm(OUTRO_DEP));
    expect((await c.rodar(tarefa())).kind).toBe('escrito');
    expect(leiturasDaConta(c)).toBe(1);
  });

  it('the payload refuses a depósito on any origin but reconcile, and a reconcile send without one', async () => {
    const c = cenario();
    expect(await c.rodar({ ...tarefa(), depositoId: DEP })).toEqual({ kind: 'payload-invalido' });
    expect(
      await c.rodar({
        ...tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile }),
        depositoId: null,
      }),
    ).toEqual({ kind: 'payload-invalido' });
    expect(c.custo()).toEqual(SEM_CUSTO);
  });
});

describe('the own record: the hint, the canonical record, the never-had-stock hold', () => {
  it('the canonical hint at the depósito ⇒ one point read and NO estoques query', async () => {
    const c = cenario();
    expect((await c.rodar(tarefa({ estoqueId: CANONICO }))).kind).toBe('escrito');
    expect(c.db.leituras).toContain(`produtos/${PRODUTO}/estoques/${CANONICO}`);
    expect(c.db.consultas.some((q) => q.colecao === `produtos/${PRODUTO}/estoques`)).toBe(false);
  });

  it('⚠️ NEAR-MISS: the canonical hint stored at ANOTHER depósito ⇒ the query decides, and its S is sent', async () => {
    const c = cenario({
      estoques: [
        [PRODUTO, CANONICO, { depositoOuterRef: OUTRO_DEP, quantidade: 40 }],
        [PRODUTO, 'auto-a', { depositoOuterRef: CANONICA, quantidade: 3 }],
      ],
    });
    await c.rodar(tarefa({ estoqueId: CANONICO }));
    expect(c.db.consultas.some((q) => q.colecao === `produtos/${PRODUTO}/estoques`)).toBe(true);
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 3 });
  });

  it('⚠️ a LEGACY hint beside a live canonical record ⇒ the CANONICAL record’s S is sent', async () => {
    const c = cenario({
      estoques: [
        [PRODUTO, 'auto-a', { depositoOuterRef: CANONICA, quantidade: 9 }],
        [PRODUTO, CANONICO, { depositoOuterRef: CANONICA, quantidade: 4 }],
      ],
      linha: { quantidade: 0, quantidade_reservada: 2 },
    });
    await c.rodar(tarefa({ estoqueId: 'auto-a' }));
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 6 });
  });

  it('a record stored with the BARE depósito ref is found', async () => {
    const c = cenario({ estoques: [[PRODUTO, 'nua', { depositoOuterRef: NUA, quantidade: 8 }]] });
    await c.rodar();
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 8 });
  });

  it('⚠️ the canonical record beside TWO legacy ones is still the one read (the limit-3 near-miss)', async () => {
    const c = cenario({
      estoques: [
        [PRODUTO, 'a-legado', { depositoOuterRef: CANONICA, quantidade: 1 }],
        [PRODUTO, 'b-legado', { depositoOuterRef: NUA, quantidade: 2 }],
        [PRODUTO, CANONICO, { depositoOuterRef: CANONICA, quantidade: 6 }],
      ],
    });
    await c.rodar();
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 6 });
  });

  it('never-had-stock, read literally: a record only at ANOTHER depósito ⇒ the depósito’s real 0 is pushed, the listing read once', async () => {
    const c = cenario({
      estoques: [[PRODUTO, 'longe', { depositoOuterRef: OUTRO_DEP, quantidade: 30 }]],
      linha: { quantidade: 4, quantidade_reservada: 2 },
    });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 2 });
    expect(
      c.db.consultas.filter((q) => q.colecao === `produtos/${PRODUTO}/estoques` && q.limite === 1),
    ).toHaveLength(1);
  });

  it('⚠️ a DELETE’s canonical hint names the record deleted: NO point read of it, exactly ONE estoques query', async () => {
    const c = cenario({ estoques: [], linha: { quantidade: 4, quantidade_reservada: 2 } });
    expect((await c.rodar(tarefa({ apagado: true, estoqueId: CANONICO }))).kind).toBe('escrito');
    expect(c.db.leituras).not.toContain(`produtos/${PRODUTO}/estoques/${CANONICO}`);
    expect(c.db.consultas.filter((q) => q.colecao === `produtos/${PRODUTO}/estoques`)).toHaveLength(
      1,
    );
    expect(c.custo()).toEqual({ erp: 7, credencial: 4, chamadas: 3, escritas: 0, enfileiradas: 0 });
  });

  it('a DELETE’s task with no record left ⇒ 0 + R is pushed, and the listing is NOT read', async () => {
    const c = cenario({ estoques: [], linha: { quantidade: 4, quantidade_reservada: 2 } });
    expect((await c.rodar(tarefa({ apagado: true }))).kind).toBe('escrito');
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 2 });
    expect(c.db.consultas.filter((q) => q.limite === 1)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Model A, reflected, identity                       */
/* -------------------------------------------------------------------------- */

describe('model A on the deciding GET', () => {
  it('R 2, S 5 ⇒ PUT {gerenciado: true, quantidade: 7, 0, −1}, numbers unquoted', async () => {
    const c = cenario({ linha: { quantidade: 3, quantidade_reservada: 2 } });
    await c.rodar();
    expect(c.p.puts()[0]?.corpo).toEqual({
      gerenciado: true,
      quantidade: 7,
      situacao_em_estoque: 0,
      situacao_sem_estoque: -1,
    });
    expect(c.p.textosDosPuts[0]).toMatch(/"quantidade":7[,}]/);
  });

  it('⚠️ R −3 is no reservation: S 5 ⇒ PUT 5 (never less than S)', async () => {
    const c = cenario({ linha: { quantidade: 1, quantidade_reservada: -3 } });
    await c.rodar();
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 5 });
  });

  it('⚠️ the store’s own available quantity is never the input: a disagreeing one changes nothing', async () => {
    const c = cenario({
      linha: { quantidade: 3, quantidade_reservada: 2, quantidade_disponivel: 40 },
    });
    await c.rodar();
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 7 });
  });

  it('reflected (all four leaves) ⇒ ONE call, no PUT; under `on` the aviso is pre-read (7 ops)', async () => {
    const c = cenario({ linha: { quantidade: 7, quantidade_reservada: 2 } });
    expect(await c.rodar()).toEqual({ kind: 'refletido' });
    expect(c.p.chamadas()).toEqual([GET]);
    expect(c.custo()).toEqual({ erp: 7, credencial: 2, chamadas: 1, escritas: 0, enfileiradas: 0 });
  });

  it.each([
    ['unmanaged', { gerenciado: false }],
    ['a lead time on', { situacao_em_estoque: 3 }],
    ['purchasable at zero', { situacao_sem_estoque: 0 }],
  ])('⚠️ NEAR-MISS: the target quantity but %s ⇒ PUT', async (_r, over) => {
    const c = cenario({ linha: { quantidade: 7, quantidade_reservada: 2, ...over } });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.puts()).toHaveLength(1);
  });

  it.each([
    ['another produto', '/api/v1/produto/999'],
    ['a leading zero', `/api/v1/produto/0${ID_LI}`],
  ])('a row naming %s ⇒ linha-divergente, one ERROR, no PUT and no diff', async (_r, produto) => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () =>
        respostaJson(200, linhaEstoqueLi(ID_PRODUTO_LI, { produto })),
      ),
    );
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'linha-divergente' });
    expect(c.p.puts()).toEqual([]);
    expect(doEvento(c, 'diff')).toEqual([]);
    expect(c.motivosErro()).toEqual(['linha-divergente']);
    expect(c.motivosAviso()).toEqual([]);
  });

  it('the deciding GET answers 404 ⇒ ausente, one WARNING, ONE call', async () => {
    const c = cenario({ linha: null });
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'ausente' });
    expect(c.custo()).toEqual({ erp: 6, credencial: 2, chamadas: 1, escritas: 0, enfileiradas: 0 });
    expect(c.motivosAviso()).toEqual(['ausente']);
    expect(c.motivosErro()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        Dry-run, canary, origin and kind                     */
/* -------------------------------------------------------------------------- */

describe('dry-run and the canary', () => {
  it('dry-run ⇒ every read, ONE restore line, ONE diff line, no PUT, no aviso read or write', async () => {
    const c = cenario({ modo: MODO_LI.dryRun, linha: { quantidade: 3, quantidade_reservada: 2 } });
    expect(await c.rodar()).toEqual({ kind: 'nao-enviado', motivo: 'valvula' });
    expect(c.custo()).toEqual({ erp: 6, credencial: 2, chamadas: 1, escritas: 0, enfileiradas: 0 });
    expect(doEvento(c, 'restauracao')).toHaveLength(1);
    const [diff] = doEvento(c, 'diff');
    expect(doEvento(c, 'diff')).toHaveLength(1);
    expect(JSON.parse(String(diff?.campos.depois))).toEqual({
      gerenciado: true,
      quantidade: 7,
      situacao_em_estoque: 0,
      situacao_sem_estoque: -1,
    });
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
  });

  it.each<[string | null, ResultadoEstoqueLi['kind'], string | null]>([
    [`${CONTA}:${ID_LI}`, 'escrito', null],
    [`${CONTA}:9`, 'nao-enviado', 'fora-do-canario'],
    ['*', 'escrito', null],
    [' *', 'nao-enviado', 'fora-do-canario'],
    [null, 'nao-enviado', 'sem-canario'],
    [`${CONTA}:${PRODUTO}`, 'nao-enviado', 'fora-do-canario'],
  ])('the canary %j ⇒ %s', async (canario, kind, motivo) => {
    const c = cenario({ canario });
    const r = await c.rodar();
    expect(r.kind).toBe(kind);
    if (r.kind === 'nao-enviado') expect(r.motivo).toBe(motivo);
  });
});

describe('the origin decides the write kind, and whether there is a read-back call', () => {
  it.each(['evento', 'manual', 'publicacao'] as const)(
    '%s ⇒ estoque-produto: GET, PUT, then the read-back GET (7 ops / 4 credential reads / 3 calls)',
    async (origem) => {
      const c = cenario();
      expect(await c.rodar(tarefa({ origem }))).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
      expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
      expect(c.custo()).toEqual({
        erp: 7,
        credencial: 4,
        chamadas: 3,
        escritas: 0,
        enfileiradas: 0,
      });
    },
  );

  it('deriva ⇒ estoque-produto too (a generation-1 payload)', async () => {
    const c = cenario();
    const r = await c.rodar(tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva, geracao: 1 }));
    expect(r).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
  });

  it.each(['reconcile', 'kit'] as const)(
    '%s ⇒ estoque-produto-lote: GET and PUT, NO read-back call (7 / 3 / 2)',
    async (origem) => {
      const c = cenario();
      // A reconcile send carries its run's depósito (the conta's, here: no extra read).
      const depositoId = origem === ORIGEM_TAREFA_ESTOQUE_LI.reconcile ? DEP : null;
      expect(await c.rodar(tarefa({ origem, depositoId }))).toEqual({ kind: 'escrito-lote' });
      expect(c.p.chamadas()).toEqual([GET, PUT]);
      expect(c.custo()).toEqual({
        erp: 7,
        credencial: 3,
        chamadas: 2,
        escritas: 0,
        enfileiradas: 0,
      });
      expect(doEvento(c, 'escrita')[0]?.campos.tipo).toBe('estoque-produto-lote');
    },
  );

  it('the table, exhaustive over the origins', () => {
    const tabela = Object.fromEntries(
      Object.values(ORIGEM_TAREFA_ESTOQUE_LI).map((o: OrigemTarefaEstoqueLi) => [
        o,
        tipoEscritaDaOrigemLi(o),
      ]),
    );
    expect(tabela).toEqual({
      evento: 'estoque-produto',
      kit: 'estoque-produto-lote',
      reconcile: 'estoque-produto-lote',
      manual: 'estoque-produto',
      publicacao: 'estoque-produto',
      deriva: 'estoque-produto',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                       The leave race and the one follow-up                  */
/* -------------------------------------------------------------------------- */

describe('the read-back and the ONE deriva follow-up', () => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it('an order LEAVES between the GET and the PUT ⇒ exactly ONE follow-up: deriva, generation 1, ids copied, window read AFTER the read-back', async () => {
    const c = cenario({ cronometrado: true, linha: { quantidade: 8, quantidade_reservada: 4 } });
    pedidoSaiDuranteOEnvio(c.p, 2);
    const estoqueIds = null;
    const r = await c.rodar(tarefa({ estoqueId: CANONICO, apagado: false, estoqueIds }));
    expect(r).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 9 });
    expect(c.custo()).toEqual({ erp: 7, credencial: 4, chamadas: 3, escritas: 0, enfileiradas: 1 });
    const [enfileirada] = c.enfileiradas;
    // The clock after the read-back is past the dispatch's window: the window is read THEN.
    const janela = Math.floor((AGORA_MS + PIOR_EXECUCAO_ESTOQUE_LI_MS) / 60_000);
    expect(janela).toBe(JANELA + 1);
    const esperada = {
      tipo: 'estoque',
      contaId: CONTA,
      produtoId: PRODUTO,
      origem: 'deriva',
      estoqueId: CANONICO,
      apagado: false,
      estoqueIds,
      geracao: 1,
      janela,
    };
    expect(enfileirada?.tarefa).toEqual(esperada);
    expect(tarefaEstoqueLiSchema.safeParse(enfileirada?.tarefa).success).toBe(true);
    expect(enfileirada?.opcoes.id).toBe(
      `estoque-${sha(`estoque:deriva:${CONTA}:${PRODUTO}:w:${String(janela)}`)}`,
    );
    expect(enfileirada?.opcoes.id).toBe(idDaTarefaEstoqueLi(tarefaEstoqueLiSchema.parse(esperada)));
    expect(c.motivosAviso()).toContain('reserva-moveu');
  });

  it('the follow-up copies a delete flag and the component ids', async () => {
    const c = cenario({ linha: { quantidade: 8, quantidade_reservada: 4 } });
    pedidoSaiDuranteOEnvio(c.p, 1);
    await c.rodar(tarefa({ apagado: true, estoqueIds: { c1: 'x', c2: null } }));
    expect(c.enfileiradas[0]?.tarefa).toMatchObject({
      apagado: true,
      estoqueIds: { c1: 'x', c2: null },
    });
  });

  it('⚠️ the same race in a GENERATION-1 run ⇒ ZERO enqueues and one WARNING (no loop)', async () => {
    const c = cenario({ linha: { quantidade: 8, quantidade_reservada: 4 } });
    pedidoSaiDuranteOEnvio(c.p, 2);
    const r = await c.rodar(tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva, geracao: 1 }));
    expect(r).toEqual({ kind: 'escrito', seguimento: 'sem-seguimento' });
    expect(c.enfileiradas).toEqual([]);
    expect(c.motivosAviso()).toContain('deriva-sem-seguimento');
  });

  it('EQUAL pair of the drift fold: R read 0 and read back −3 — model A targets the same quantity ⇒ no follow-up', async () => {
    const c = cenario({
      linha: { quantidade: 1, quantidade_reservada: 0 },
      aoResponder: depoisDoPut((linha) => {
        linha.quantidade_reservada = -3;
      }),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.enfileiradas).toEqual([]);
  });

  it.each<[string, (linha: DocData) => void]>([
    [
      'R read 2, read back 1',
      (linha) => {
        linha.quantidade_reservada = 1;
      },
    ],
    [
      'the quantity read back one above what was sent',
      (linha) => {
        linha.quantidade = Number(linha.quantidade) + 1;
      },
    ],
    [
      'the row unmanaged right after the write',
      (linha) => {
        linha.gerenciado = false;
      },
    ],
  ])('⚠️ NEAR-MISS of the drift fold: %s ⇒ ONE follow-up', async (_r, mudar) => {
    const c = cenario({
      linha: { quantidade: 1, quantidade_reservada: 2 },
      aoResponder: depoisDoPut(mudar),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('⚠️ a read-back that cannot be made (a 503, contained) ⇒ fail open: ONE follow-up', async () => {
    const c = cenario({
      aoResponder: depoisDoPut((_linha, p) => {
        p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(503, {})));
      }),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.motivosAviso()).toContain('sem-conferencia');
  });

  it('a read-back refused with 401 parks the conta, and the follow-up is still enqueued', async () => {
    const c = cenario({
      aoResponder: depoisDoPut((_linha, p) => {
        p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(401, {})));
      }),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('the queue switched off ⇒ one WARNING and the write stands (no throw)', async () => {
    const c = cenario({
      linha: { quantidade: 8, quantidade_reservada: 4 },
      enfileirar: () => Promise.reject(new LiTarefasDesligadasError()),
    });
    pedidoSaiDuranteOEnvio(c.p, 2);
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'tarefas-desligadas' });
    // ONE line for the closed queue (beside the drift's own), never an ERROR, never a throw.
    expect(c.motivosAviso().filter((m) => m === 'deriva-tarefas-desligadas')).toHaveLength(1);
    expect(c.erros).toEqual([]);
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('⚠️ a TRANSIENT enqueue failure is rethrown: the retry re-derives from a fresh GET', async () => {
    const transitoria = new LiTarefasTransitoriasError(
      'FirebaseFunctionsError',
      'functions/unknown-error',
      503,
    );
    const c = cenario({
      linha: { quantidade: 8, quantidade_reservada: 4 },
      enfileirar: () => Promise.reject(transitoria),
    });
    pedidoSaiDuranteOEnvio(c.p, 2);
    await expect(c.rodar()).rejects.toBe(transitoria);
  });
});

/* -------------------------------------------------------------------------- */
/*                                The errors                                   */
/* -------------------------------------------------------------------------- */

describe('a PUT answered 429 or 5xx may have landed: it throws, and the retry re-derives', () => {
  it.each([0, TASK_MAX_ATTEMPTS - 1])(
    'attempt %i: 429 ⇒ LiThrottleError, two calls, no read-back, no aviso, nothing written',
    async (tentativa) => {
      const c = cenario({ tentativa, linha: { quantidade: 1, quantidade_reservada: 2 } });
      c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(429, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiThrottleError);
      expect(c.custo()).toEqual({
        erp: 6,
        credencial: 3,
        chamadas: 2,
        escritas: 0,
        enfileiradas: 0,
      });
      expect(c.erros).toEqual([]);
    },
  );

  it('a later attempt is a run like any other: S 5 + the R ITS OWN deciding GET reads (3) ⇒ PUT 8', async () => {
    const c = cenario({ linha: { quantidade: 1, quantidade_reservada: 3 }, tentativa: 1 });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 8 });
  });

  it.each([
    [500, 0],
    [503, 0],
    [500, TASK_MAX_ATTEMPTS - 1],
    [503, TASK_MAX_ATTEMPTS - 1],
  ])(
    '%i at attempt %i ⇒ thrown — never `recusado`, even on the LAST attempt: no read-back, no aviso, no ERROR line',
    async (status, tentativa) => {
      const c = cenario({ tentativa });
      c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(status, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.p.chamadas()).toEqual([GET, PUT]);
      expect(c.custo().escritas).toBe(0);
      expect(c.db.ler(AVISO_RECUSADO)).toBeUndefined();
      expect(c.erros).toEqual([]);
    },
  );

  it('a PUT whose connection fails (network) ⇒ LiNetworkError rethrown: no read-back, no aviso, nothing written', async () => {
    const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => new TypeError('rede')));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiNetworkError);
    expect(c.p.chamadas()).toEqual([GET, PUT]);
    expect(c.custo().escritas).toBe(0);
    expect(c.erros).toEqual([]);
  });
});

describe('a PUT refused with a 3xx/4xx (not 401/403/429): rethrown until the LAST attempt, then recusado and the aviso', () => {
  it.each([0, 1])('attempt %i ⇒ rethrown, no aviso', async (tentativa) => {
    const c = cenario({ tentativa });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(400, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
    expect(c.custo().escritas).toBe(0);
  });

  it('the LAST attempt ⇒ recusado 400, ONE ERROR line, the aviso with its params, clocked by the DISPATCH START (not now)', async () => {
    expect(TASK_MAX_ATTEMPTS - 1).toBe(2);
    const inicioDaTarefaMs = AGORA_MS - 5_000;
    const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1, inicioDaTarefaMs });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(400, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', status: 400 });
    expect(c.motivosErro()).toEqual(['recusado']);
    expect(c.motivosAviso()).toEqual([]);
    expect(c.custo()).toEqual({ erp: 6, credencial: 3, chamadas: 2, escritas: 1, enfileiradas: 0 });
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado,
      severidade: SEVERIDADE_AVISO.atencao,
      params: { loja: 'Loja E', produto: PRODUTO, idLi: ID_LI, status: 400 },
      relogioEvento: inicioDaTarefaMs * 1000,
      resolvidoEm: null,
    });
  });

  it.each([0, 1])(
    'a PUT answered 302 (a 3xx) at attempt %i ⇒ rethrown, no aviso',
    async (tentativa) => {
      const c = cenario({ tentativa });
      c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(302, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.custo().escritas).toBe(0);
    },
  );

  it('a PUT answered 302 (a 3xx: redirects are never followed, nothing landed) on the LAST attempt ⇒ recusado 302 and the aviso', async () => {
    const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(302, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', status: 302 });
    expect(c.motivosErro()).toEqual(['recusado']);
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ params: { status: 302 }, resolvidoEm: null });
  });

  it('⚠️ under dry-run nothing is ever sent, so nothing is ever refused', async () => {
    const c = cenario({ modo: MODO_LI.dryRun, tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(400, {})));
    expect((await c.rodar()).kind).toBe('nao-enviado');
    expect(c.custo().escritas).toBe(0);
  });
});

describe('the refusal aviso is resolved only when OPEN, under `on`', () => {
  const abrir = (c: Cenario, relogioUs: number) =>
    c.db.seed(AVISO_RECUSADO, {
      tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado,
      conta: CONTA,
      entidade: PRODUTO,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: 'lojaIntegrada',
      params: { loja: 'Loja E', produto: PRODUTO, idLi: ID_LI, status: 400 },
      motivo: null,
      destinatarioUid: null,
      urlInterna: null,
      urlExterna: null,
      prazo: null,
      relogioEvento: relogioUs,
      criadoEm: relogioUs,
      atualizadoEm: relogioUs,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });

  it.each([
    ['escrito', {}],
    ['refletido', { linha: { quantidade: 5, quantidade_reservada: 0 } }],
    ['escrito-lote', { origem: 'reconcile' }],
  ])('an open row and a later `on` run ending %s ⇒ resolved, its clock advanced', async (_r, o) => {
    const c = cenario('linha' in o ? { linha: o.linha } : {});
    abrir(c, (AGORA_MS - 3_600_000) * 1000);
    await c.rodar(
      'origem' in o
        ? tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile, depositoId: DEP })
        : tarefa(),
    );
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
      resolucaoMotivo: 'estoque-enviado',
      relogioEvento: AGORA_MS * 1000,
    });
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).not.toBeNull();
  });

  it('⚠️ NO open row ⇒ the write log stays EMPTY (a clocked resolve would seed one)', async () => {
    for (const o of [{}, { linha: { quantidade: 5, quantidade_reservada: 0 } }]) {
      const c = cenario(o);
      await c.rodar();
      expect(c.db.escritas).toEqual([]);
      expect(c.db.leituras).toContain(AVISO_RECUSADO);
      __resetAllReadCaches();
    }
  });

  it('⚠️ an ALREADY resolved row ⇒ nothing written either', async () => {
    const c = cenario();
    abrir(c, (AGORA_MS - 3_600_000) * 1000);
    c.db.seed(AVISO_RECUSADO, {
      ...c.db.ler(AVISO_RECUSADO),
      resolvidoEm: AGORA_MS * 1000 - 1,
      resolucaoMotivo: 'estoque-enviado',
    });
    await c.rodar();
    expect(c.db.escritas).toEqual([]);
  });

  it('a NEWER run’s open row is never closed by an older run (the clock)', async () => {
    const c = cenario();
    abrir(c, (AGORA_MS + 60_000) * 1000);
    await c.rodar();
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it('⚠️ the clock is the run’s DISPATCH START, not now: a row raised after this run STARTED stays open', async () => {
    // Started 120 s ago; the row was raised 60 s ago by a run that started later. Clocked by
    // `now` this run would close it.
    const c = cenario({ inicioDaTarefaMs: AGORA_MS - 120_000 });
    abrir(c, (AGORA_MS - 60_000) * 1000);
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it('under dry-run: not even the pre-read', async () => {
    const c = cenario({ modo: MODO_LI.dryRun });
    abrir(c, (AGORA_MS - 3_600_000) * 1000);
    await c.rodar();
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it.each<[string, OpcoesCenario]>([
    ['under dry-run', { modo: MODO_LI.dryRun }],
    ['outside the canary', { canario: `${CONTA}:9` }],
  ])(
    '⚠️ a row ALREADY reflected %s ⇒ refletido, and the open aviso is neither read nor closed',
    async (_r, o) => {
      const c = cenario({ ...o, linha: { quantidade: 5, quantidade_reservada: 0 } });
      abrir(c, (AGORA_MS - 3_600_000) * 1000);
      expect(await c.rodar()).toEqual({ kind: 'refletido' });
      expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
      expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
      expect(c.custo().escritas).toBe(0);
    },
  );

  it('no Firestore write on ANY success with no open aviso', async () => {
    for (const o of [
      {},
      { linha: { quantidade: 5, quantidade_reservada: 0 } },
      { modo: MODO_LI.dryRun },
    ] satisfies OpcoesCenario[]) {
      const c = cenario(o);
      await c.rodar();
      expect(c.db.escritas).toEqual([]);
      __resetAllReadCaches();
    }
    const lote = cenario();
    expect(await lote.rodar(tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.kit }))).toEqual({
      kind: 'escrito-lote',
    });
    expect(lote.db.escritas).toEqual([]);
  });
});

describe('401/403', () => {
  it.each([401, 403])(
    '%i on the deciding GET ⇒ the conta is PARKED, the run drops, no PUT',
    async (status) => {
      const c = cenario();
      c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(status, {})));
      expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'conta-parada' });
      expect(c.p.puts()).toEqual([]);
      expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status });
      expect(c.db.escritasEm(CREDENCIAL)).toHaveLength(1);
    },
  );

  it('⚠️ a 401 for an OLDER token (re-saved while the GET was in flight) ⇒ nothing parked, the LiAuthError rethrown: the retry reads with the new token', async () => {
    const c = cenario({
      tentativa: TASK_MAX_ATTEMPTS - 1,
      aoResponder: (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) {
          seedCredencial(cen.db, CONTA, { tokenAtualizadoEmMs: AGORA_MS - 1000 });
        }
      },
    });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(401, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
    expect(c.p.puts()).toEqual([]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toBeNull();
    expect(c.db.escritasEm(CREDENCIAL)).toEqual([]);
    expect(c.custo().escritas).toBe(0);
  });

  it('a 401 on the deciding GET, the credential DELETED meanwhile ⇒ dropped credencial-ausente, nothing parked', async () => {
    const c = cenario({
      aoResponder: async (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) await docCredencial(asDb(cen.db), CONTA).delete();
      },
    });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'credencial-ausente' });
    expect(c.p.puts()).toEqual([]);
    expect(c.db.ler(CREDENCIAL)).toBeUndefined();
    // The test's own delete is the only write.
    expect(c.db.escritas.map((e) => e.verbo)).toEqual(['delete']);
  });

  it('a 401 on the deciding GET, the credential CORRUPT meanwhile ⇒ dropped credencial-invalida, nothing parked', async () => {
    const c = cenario({
      aoResponder: (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) cen.db.seed(CREDENCIAL, { personalToken: 7 });
      },
    });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'credencial-invalida' });
    expect(c.p.puts()).toEqual([]);
    expect(c.custo().escritas).toBe(0);
  });

  it('401 on the PUT, refused again by the confirming deciding read ⇒ parked, dropped', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(401, {})));
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'conta-parada' });
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('⚠️ 401 on the PUT while the token still READS ⇒ nothing parked; rethrown before the last attempt', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(401, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toBeNull();
    expect(c.custo().escritas).toBe(0);
  });

  it('401 on the PUT while the token still reads, on the LAST attempt ⇒ recusado 401 and the aviso', async () => {
    const c = cenario({ tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', status: 401 });
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ params: { status: 401 } });
  });

  it('401 on the PUT, the confirming read finds no row ⇒ nothing to conclude: the 401 is rethrown', async () => {
    const c = cenario({ tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(401, {})));
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(404, undefined)));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
  });
});

describe('the deciding read refused otherwise', () => {
  it('a row OFF its schema (a fractional reservation) ⇒ leitura-ilegivel at once, one ERROR, no PUT', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () =>
        respostaJson(200, linhaEstoqueLi(ID_PRODUTO_LI, { quantidade_reservada: 1.5 })),
      ),
    );
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'leitura-ilegivel' });
    expect(c.motivosErro()).toEqual(['leitura-ilegivel']);
    expect(c.motivosAviso()).toEqual([]);
  });

  it('⚠️ an EMPTY 200 is the transport’s: rethrown for the retry', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => new Response('', { status: 200 })),
    );
    await expect(c.rodar()).rejects.toMatchObject({ name: 'LiSchemaError' });
  });

  it('another 4xx: rethrown before the last attempt, then dropped with one ERROR and NO aviso', async () => {
    const antes = cenario({ tentativa: 1 });
    antes.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(400, {})));
    await expect(antes.rodar()).rejects.toBeInstanceOf(LiHttpError);
    __resetAllReadCaches();
    const ultima = cenario({ tentativa: 2 });
    ultima.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(400, {})));
    expect(await ultima.rodar()).toEqual({ kind: 'descartado', motivo: 'leitura-recusada' });
    expect(ultima.custo().escritas).toBe(0);
  });

  it('a 429 on the deciding read is thrown', async () => {
    const c = cenario({ tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(429, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiThrottleError);
  });

  it.each([500, 503])(
    '⚠️ a %i on the deciding read is thrown even on the LAST attempt — never dropped as leitura-recusada',
    async (status) => {
      const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
      c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => respostaJson(status, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.p.chamadas()).toEqual([GET]);
      expect(c.erros).toEqual([]);
    },
  );

  it('a deciding read whose connection fails (network) ⇒ LiNetworkError rethrown on the LAST attempt, nothing sent', async () => {
    const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
    c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'GET', () => new TypeError('rede')));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiNetworkError);
    expect(c.p.chamadas()).toEqual([GET]);
    expect(c.erros).toEqual([]);
    expect(c.custo().escritas).toBe(0);
  });
});

describe('what always THROWS, with nothing sent', () => {
  it('the credential re-saved between the GET and the PUT ⇒ LiCredencialTrocadaError, no PUT', async () => {
    const c = cenario({
      aoResponder: (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) {
          seedCredencial(cen.db, CONTA, { tokenAtualizadoEmMs: AGORA_MS - 1000 });
        }
      },
    });
    await expect(c.rodar()).rejects.toBeInstanceOf(LiCredencialTrocadaError);
    expect(c.p.puts()).toEqual([]);
  });

  it('a dispatch that began past the write deadline ⇒ PrazoDeEscritaEsgotadoLiError, no PUT', async () => {
    const c = cenario({ inicioDaTarefaMs: AGORA_MS - PRAZO_ULTIMA_ESCRITA_MS - 1000 });
    await expect(c.rodar()).rejects.toBeInstanceOf(PrazoDeEscritaEsgotadoLiError);
    expect(c.p.puts()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   Kits                                      */
/* -------------------------------------------------------------------------- */

describe('a kit its components bound', () => {
  const KIT = {
    ehKit: true,
    componentesKit: {
      c1: { quantidade: 2, limitarEstoque: true, timestamp: null },
      c2: { quantidade: 1, limitarEstoque: true, timestamp: null },
    },
  };
  const C1 = `est-c1-${DEP}`;
  const C2 = `est-c2-${DEP}`;

  it('the payload’s ids ⇒ ONE getAll of exactly those paths; the kit’s own record is NOT read; S = min ⌊c / q⌋', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [
        [PRODUTO, CANONICO, { depositoOuterRef: CANONICA, quantidade: 100 }],
        ['c1', C1, { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'c1' }],
        ['c2', C2, { depositoOuterRef: CANONICA, quantidade: 6, parentId: 'c2' }],
      ],
    });
    await c.rodar(tarefa({ estoqueIds: { c1: C1, c2: C2 } }));
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 4 });
    expect(c.db.leituras).toEqual(
      expect.arrayContaining([`produtos/c1/estoques/${C1}`, `produtos/c2/estoques/${C2}`]),
    );
    expect(c.db.leituras.some((l) => l.startsWith(`produtos/${PRODUTO}/estoques/`))).toBe(false);
    expect(c.db.consultas.some((q) => q.colecao === `produtos/${PRODUTO}/estoques`)).toBe(false);
    expect(c.db.consultas.some((q) => q.colecao === 'estoques')).toBe(false);
    // 3 + k (2) + the probe (2), + the aviso pre-read under `on`.
    expect(c.custo()).toEqual({ erp: 8, credencial: 4, chamadas: 3, escritas: 0, enfileiradas: 0 });
  });

  it('COST without the payload’s ids, one bounding component with NO record at the depósito: 3 + 2 group queries + 1 own-collection query + the probe (2) + the aviso pre-read = 9', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [['c1', C1, { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'c1' }]],
      linha: { quantidade: 5, quantidade_reservada: 1 },
    });
    expect((await c.rodar()).kind).toBe('escrito');
    // c2 has no record: it counts 0, so S = 0 and the PUT carries the reservation alone.
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 1 });
    expect(c.db.consultas.filter((q) => q.grupo === true && q.colecao === 'estoques')).toHaveLength(
      2,
    );
    expect(c.db.consultas.filter((q) => q.colecao === 'produtos/c2/estoques')).toHaveLength(1);
    expect(c.custo()).toEqual({ erp: 9, credencial: 4, chamadas: 3, escritas: 0, enfileiradas: 0 });
  });

  it('⚠️ a LEGACY component record the join finds never hides the CANONICAL one stored with no parentId: the PUT follows the canonical 0, not the legacy 20', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [
        ['c1', 'legado', { depositoOuterRef: CANONICA, quantidade: 20, parentId: 'c1' }],
        ['c1', C1, { depositoOuterRef: NUA, quantidade: 0 }],
        ['c2', C2, { depositoOuterRef: CANONICA, quantidade: 6, parentId: 'c2' }],
      ],
      linha: { quantidade: 5, quantidade_reservada: 1 },
    });
    expect((await c.rodar()).kind).toBe('escrito');
    // S = min(⌊0 / 2⌋, ⌊6 / 1⌋) = 0, so the PUT carries the reservation alone. Read through the
    // legacy record alone it would be min(⌊20 / 2⌋, 6) = 6 ⇒ 7: stock the store does not have.
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 1 });
    expect(c.db.consultas.filter((q) => q.colecao === 'produtos/c1/estoques')).toHaveLength(1);
    expect(c.db.consultas.filter((q) => q.colecao === 'produtos/c2/estoques')).toHaveLength(0);
  });

  it('⚠️ two LEGACY component records, only one carrying parentId ⇒ estoque-ambiguo, zero credential reads', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [
        ['c1', 'a', { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'c1' }],
        ['c1', 'b', { depositoOuterRef: CANONICA, quantidade: 1 }],
        ['c2', C2, { depositoOuterRef: CANONICA, quantidade: 6, parentId: 'c2' }],
      ],
    });
    expect(await c.rodar()).toEqual({ kind: 'pulado', motivo: 'estoque-ambiguo' });
    expect(c.custo().credencial).toBe(0);
    expect(c.custo().chamadas).toBe(0);
  });

  it('⚠️ a component with TWO non-canonical records ⇒ estoque-ambiguo, zero credential reads', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [
        ['c1', 'a', { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'c1' }],
        ['c1', 'b', { depositoOuterRef: NUA, quantidade: 1, parentId: 'c1' }],
        ['c2', C2, { depositoOuterRef: CANONICA, quantidade: 6, parentId: 'c2' }],
      ],
    });
    expect(await c.rodar()).toEqual({ kind: 'pulado', motivo: 'estoque-ambiguo' });
    expect(c.custo().credencial).toBe(0);
    expect(c.custo().chamadas).toBe(0);
  });

  it('no component resolves ⇒ the safe 0 + R is pushed, with one WARNING', async () => {
    const c = cenario({
      produto: KIT,
      estoques: [],
      linha: { quantidade: 5, quantidade_reservada: 1 },
    });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.puts()[0]?.corpo).toMatchObject({ quantidade: 1 });
    expect(c.motivosAviso()).toContain('kit-nao-verificavel');
  });
});

/* -------------------------------------------------------------------------- */
/*                         The worst run, measured                             */
/* -------------------------------------------------------------------------- */

describe('the worst case of one run, measured (the stock queue sizes its timeout on it)', () => {
  it('an event-origin PUT with every call at its full deadline ⇒ exactly PIOR_EXECUCAO_ESTOQUE_LI_MS; the PUT starts by 24 s', async () => {
    const c = cenario({ cronometrado: true, linha: { quantidade: 3, quantidade_reservada: 2 } });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.decorridoMs()).toBe(PIOR_EXECUCAO_ESTOQUE_LI_MS);
    expect(PIOR_EXECUCAO_ESTOQUE_LI_MS).toBe(
      2 * (2 * RITMO_ESCRITA_LI_MS + PRAZO_DE_UMA_CHAMADA_MS) + PRAZO_DE_UMA_CHAMADA_MS,
    );
    const inicioDoPut = (c.instantes[1] ?? Number.NaN) - AGORA_MS;
    expect(inicioDoPut).toBe(2 * RITMO_ESCRITA_LI_MS + PRAZO_DE_UMA_CHAMADA_MS);
    expect(inicioDoPut).toBeLessThan(PRAZO_ULTIMA_ESCRITA_MS);
  });

  it('no case of the grid is slower', async () => {
    const grade: [string, OpcoesCenario, (c: Cenario) => void, TarefaEstoqueLi][] = [
      [
        'refletido',
        { linha: { quantidade: 5, quantidade_reservada: 0 } },
        () => undefined,
        tarefa(),
      ],
      ['dry-run', { modo: MODO_LI.dryRun }, () => undefined, tarefa()],
      [
        'lote',
        {},
        () => undefined,
        tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile, depositoId: DEP }),
      ],
      [
        'corrida',
        { linha: { quantidade: 8, quantidade_reservada: 4 } },
        (c) => pedidoSaiDuranteOEnvio(c.p, 2),
        tarefa(),
      ],
      [
        '401 confirmado no último',
        { tentativa: 2 },
        (c) =>
          c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(401, {}))),
        tarefa(),
      ],
      [
        '400 no último',
        { tentativa: 2 },
        (c) =>
          c.p.fila.push(naProxima(CAMINHO_ESTOQUE_PRODUTO_LI, 'PUT', () => respostaJson(400, {}))),
        tarefa(),
      ],
    ];
    for (const [rotulo, o, preparar, t] of grade) {
      __resetAllReadCaches();
      const c = cenario({ ...o, cronometrado: true });
      preparar(c);
      await c.rodar(t);
      expect(c.decorridoMs(), rotulo).toBeLessThanOrEqual(PIOR_EXECUCAO_ESTOQUE_LI_MS);
    }
  });
});
