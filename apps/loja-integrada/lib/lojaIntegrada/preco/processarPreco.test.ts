/**
 * ONE price send run (master plan step 13, PR 13-d), offline: the REAL engine, write context,
 * park, ERP reads and aviso writer, against the fake Firestore and a stateful Loja Integrada
 * (`testing/plataformaEscritaLi.ts`, the store's produto details by id and the price PUT).
 *
 * Every case pins its COST: Firestore operations (document reads + queries, the credential reads
 * apart), credential reads, store calls, Firestore writes and enqueues — every skip at zero
 * credential reads and zero calls, and never more than one PUT in any run (checked after every
 * test). A CHILD reads its parent; a ROOT does not, so a root costs one ERP read less.
 *
 * Every value is INVENTED (`testing/precoLi.ts`: store product 1001, a variation of 1000; a price
 * row's own id is its produto's + 8000; repeated-digit amounts). No call to the store: the global
 * `fetch` is stubbed to throw for every test of this file, the unit config's kill-switch fails any
 * real host, and the platform is the only `fetch` a client gets.
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
  MOTIVO_PRECO_RECUSADO_LI,
  ORIGEM_TAREFA_PRECO_LI,
  type OrigemTarefaPrecoLi,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  type TarefaPrecoLi,
  tarefaPrecoLiSchema,
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
import {
  type PlataformaEscritaLi,
  caminhoPrecoProdutoLi,
  caminhoProdutoDetalheLi,
  criarPlataformaEscritaLi,
  gravarPrecoPadraoLi,
  naProxima,
  respostaJson,
} from '../testing/plataformaEscritaLi';
import { ID_PAI_PRECO_LI, detalhePrecoLi, idDaLinhaDePrecoLi } from '../testing/precoLi';
import { type OpcoesEnfileiramentoPrecoLi, idDaTarefaPrecoLi } from './agendadorPreco';
import { chaveDoAvisoPrecoRecusadoLi } from './avisosPreco';
import { FORMA_PROMO_LIMPA_ENV_LI } from './configPrecoLi';
import {
  type DepsPrecoLi,
  LINHA_PRECO_LI,
  PIOR_EXECUCAO_PRECO_LI_MS,
  type ResultadoPrecoLi,
  processarTarefaPrecoLi,
  tipoEscritaDaOrigemPrecoLi,
} from './processarPreco';

const CONTA = 'conta-li-preco';
const PRODUTO = 'p-filho-preco';
const PAI = 'p-pai-preco';
const TAB_N = 'tab-normal';
const TAB_P = 'tab-promo';
const REF_N = `documents/listaDePrecos/${TAB_N}`;
const REF_P = `documents/listaDePrecos/${TAB_P}`;
const ID = 1001;
const ID_LI = String(ID);
const JANELA = Math.floor(AGORA_MS / 60_000);
const CREDENCIAL = caminhoCredencial(CONTA);
const AVISO_RECUSADO = caminhoAviso(chaveDoAvisoPrecoRecusadoLi(CONTA, PRODUTO));

const CAMINHO_DETALHE = caminhoProdutoDetalheLi(ID);
const CAMINHO_PUT = caminhoPrecoProdutoLi(ID);
const GET = `GET ${CAMINHO_DETALHE}`;
const PUT = `PUT ${CAMINHO_PUT}`;

/** One Loja Integrada call that runs to its whole deadline, read or write. */
const PRAZO_DE_UMA_CHAMADA_MS = Math.max(PRAZO_LI_MS.leitura, PRAZO_LI_MS.escrita);

/**
 * Every scenario a test built: none may have sent more than one PUT, and none of the run's own
 * lines may carry a key outside {@link CHAVES_DAS_LINHAS} or a fractional number (checked after
 * each test).
 */
const cenariosDoTeste: Cenario[] = [];

/**
 * Every key the run's own WARNING/ERROR lines may carry: ids, motivos and classes, the task's
 * generation and `baixar`, an HTTP status — never a price, a custo or a body. A line that gained
 * any other key (a price "for context") fails every test that writes it.
 */
const CHAVES_DAS_LINHAS: ReadonlySet<string> = new Set([
  'integracaoId',
  'produtoId',
  'origem',
  'geracao',
  'baixar',
  'motivo',
  'idLi',
  'status',
  'classe',
  'retencao',
  'variavel',
]);

/** The run's own lines (`[loja-integrada/preco] <motivo>`), WARNING and ERROR alike. */
function linhasProprias(c: Cenario): { readonly linha: string; readonly meta: object }[] {
  return [...c.avisos, ...c.erros]
    .filter((args) => typeof args[0] === 'string' && args[0].startsWith(`${LINHA_PRECO_LI} `))
    .map((args) => ({ linha: String(args[0]), meta: (args[1] ?? {}) as object }));
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  // No call to the store, per file: nothing here may reach the global `fetch`.
  vi.stubGlobal('fetch', () => {
    throw new Error('processarPreco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  for (const c of cenariosDoTeste.splice(0)) {
    expect(c.p.puts().length).toBeLessThanOrEqual(1);
    for (const { linha, meta } of linhasProprias(c)) {
      for (const [chave, valor] of Object.entries(meta)) {
        expect(CHAVES_DAS_LINHAS.has(chave), `${linha}: ${chave}`).toBe(true);
        if (typeof valor === 'number')
          expect(Number.isInteger(valor), `${linha}: ${chave}`).toBe(true);
      }
    }
  }
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                                  The harness                                */
/* -------------------------------------------------------------------------- */

/** A `precos` map: the normal tabela's price, and the promotional one's when given. */
function precos(cheio: unknown, promo?: unknown): DocData {
  return {
    [TAB_N]: { valor: cheio },
    ...(promo === undefined ? {} : { [TAB_P]: { valor: promo } }),
  };
}

/** A child link of the conta to store product {@link ID}, in the stored wire shape. */
function link(over: DocData = {}): DocData {
  return {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: ID,
    paiProdutoIntegradaId: ID_PAI_PRECO_LI,
    sku: `SKU-INVENTADO-${ID_LI}`,
    ...over,
  };
}

function tarefa(over: Partial<TarefaPrecoLi> = {}): TarefaPrecoLi {
  return {
    tipo: 'preco',
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    janela: JANELA,
    geracao: 0,
    baixar: false,
    ...over,
  };
}

const doLote = (over: Partial<TarefaPrecoLi> = {}) =>
  tarefa({
    origem: ORIGEM_TAREFA_PRECO_LI.reconcile,
    tabelaNormalId: TAB_N,
    tabelaPromocionalId: TAB_P,
    ...over,
  });
const daDeriva = (over: Partial<TarefaPrecoLi> = {}) =>
  tarefa({ origem: ORIGEM_TAREFA_PRECO_LI.deriva, geracao: 1, ...over });

interface OpcoesCenario {
  /** The price valve (`null`: unset). Default `on`. */
  readonly modo?: string | null;
  /** The price canary (`null`: unset). Default `*`. */
  readonly canario?: string | null;
  /** The read switch on (default). */
  readonly chamadas?: boolean;
  /** `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` (unset by default). */
  readonly forma?: string;
  /** The conta document (`null`: none). */
  readonly conta?: DocData | null;
  /** Seed the credential (default yes). */
  readonly credencial?: DocData | null;
  /** The produto document (`null`: none). Default a child of {@link PAI} with no price of its own. */
  readonly produto?: DocData | null;
  /** The parent document (`null`: none). Default propagating, normal tabela at 55.56, no promo. */
  readonly pai?: DocData | null;
  /** The produto's own links, by doc id. Default ONE child link of the conta. */
  readonly links?: Readonly<Record<string, DocData>>;
  /** Leaves replacing the store's detail of {@link ID} (`null`: no product, a 404). Default 55.55 / none. */
  readonly detalhe?: DocData | null;
  readonly gravacaoPreco?: (corpo: DocData, detalhe: DocData) => void;
  readonly ecoPreco?: (detalhe: DocData) => Response;
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
  readonly enfileiradas: { tarefa: unknown; opcoes: OpcoesEnfileiramentoPrecoLi }[];
  /** The clock at each store call, as it started (the timed scenarios). */
  readonly instantes: number[];
  decorridoMs(): number;
  rodar(dados?: unknown): Promise<ResultadoPrecoLi>;
  custo(): {
    erp: number;
    credencial: number;
    chamadas: number;
    escritas: number;
    enfileiradas: number;
  };
  /** The run's own WARNING lines (`[loja-integrada/preco] <motivo>`), by motivo. */
  motivosAviso(): string[];
  /** The run's own ERROR lines, by motivo. */
  motivosErro(): string[];
}

function ambiente(o: OpcoesCenario): AmbienteLi {
  const modo = o.modo === undefined ? MODO_LI.on : o.modo;
  const canario = o.canario === undefined ? '*' : o.canario;
  return {
    ...(o.chamadas === false ? {} : { [CHAMADAS_ENV_LI]: MODO_LI.on }),
    ...(modo === null ? {} : { [VALVULA_ENV_LI.preco]: modo }),
    ...(canario === null ? {} : { [CANARIO_ENV_LI.preco]: canario }),
    ...(o.forma === undefined ? {} : { [FORMA_PROMO_LIMPA_ENV_LI]: o.forma }),
  };
}

const CONTA_PADRAO: DocData = {
  tipo: INTEGRACAO_TIPO.lojaIntegrada,
  nome: 'Loja P',
  ativo: true,
  tabelaNormalOuterRef: REF_N,
  tabelaPromocionalOuterRef: REF_P,
};

/** A root produto (no parent) with its own price. */
const RAIZ: DocData = { precos: precos(55.56), custo: 99.99 };

function cenario(o: OpcoesCenario = {}): Cenario {
  const db = new FakeDb();
  const conta = o.conta === undefined ? CONTA_PADRAO : o.conta;
  if (conta !== null) db.seed(`integracao/${CONTA}`, conta);
  if (o.credencial !== null) seedCredencial(db, CONTA, o.credencial ?? {});
  const produto =
    o.produto === undefined ? { paiId: PAI, precos: {}, custo: 99.99, sku: 'SKU-F' } : o.produto;
  if (produto !== null) db.seed(`produtos/${PRODUTO}`, produto);
  const pai =
    o.pai === undefined
      ? { precos: precos(55.56), propagatePriceToChildren: true, custo: 77.77 }
      : o.pai;
  if (pai !== null) db.seed(`produtos/${PAI}`, pai);
  for (const [id, dados] of Object.entries(o.links ?? { l1: link() })) {
    db.seed(`produtos/${PRODUTO}/produtolojaintegrada/${id}`, dados);
  }
  const p = criarPlataformaEscritaLi({
    produtos:
      o.detalhe === null
        ? []
        : [
            {
              ...detalhePrecoLi(ID, {
                preco_cheio: 55.55,
                preco_promocional: null,
                preco_custo: null,
              }),
              ...o.detalhe,
            },
          ],
    gravacaoPreco: o.gravacaoPreco,
    ecoPreco: o.ecoPreco,
  });
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
    rodar: (dados = tarefa()) => processarTarefaPrecoLi(asDb(db), dados, deps),
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
  const deps: DepsPrecoLi = {
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
const custoDe = (erp: number, credencial: number, chamadas: number, outros: object = {}) => ({
  ...SEM_CUSTO,
  erp,
  credencial,
  chamadas,
  ...outros,
});

/** The store keeps whole reais of a promotion (a store that truncates what it stores). */
function truncaPromocao(corpo: DocData, detalhe: DocData): void {
  gravarPrecoPadraoLi(corpo, detalhe);
  if (typeof corpo.promocional === 'number')
    detalhe.preco_promocional = Math.trunc(corpo.promocional);
}

/** A store 33.33 / 22.22 and a target 55.56 / 44.44: a raise of every leaf, sent at any `baixar`. */
const SUBIDA: Pick<OpcoesCenario, 'detalhe' | 'pai'> = {
  detalhe: { preco_cheio: 33.33, preco_promocional: 22.22 },
  pai: { precos: precos(55.56, 44.44), propagatePriceToChildren: true },
};

/** Answer the next GET of the detail with `resposta` (once the PUT has landed: the read-back). */
function depoisDoPut(resposta: () => Response | Error) {
  return (metodo: string, _caminho: string, _n: number, c: Cenario) => {
    if (metodo === 'PUT') c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', resposta));
  };
}

/** The open refusal row of {@link PRODUTO}, raised at `relogioUs` with motivo `recusado`. */
function abrirRecusa(c: Cenario, relogioUs: number): void {
  c.db.seed(AVISO_RECUSADO, {
    tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
    conta: CONTA,
    entidade: PRODUTO,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: 'lojaIntegrada',
    params: { loja: 'Loja P', produto: PRODUTO, idLi: ID_LI, motivo: 'recusado', status: 400 },
    motivo: 'recusado',
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
}

/* -------------------------------------------------------------------------- */
/*                  Before anything: the payload, the valve, the forma          */
/* -------------------------------------------------------------------------- */

describe('before anything is read: the payload, the valve, the clear forma', () => {
  it.each([
    ['a full price', { cheio: 55.56 }],
    ['a promotion', { promocional: 44.44 }],
    ['a custo', { custo: 12.34 }],
    ['generation 1 on an event', { geracao: 1 }],
    ['generation 0 on a deriva', { origem: ORIGEM_TAREFA_PRECO_LI.deriva }],
    ['a bulk origin without its tabelas', { origem: ORIGEM_TAREFA_PRECO_LI.atualizacao }],
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

  it.each([null, MODO_LI.off])(
    '⚠️ the valve comes BEFORE the clear forma: valve %j with an unreadable forma ⇒ desligado, zero reads, NO ERROR line',
    async (modo) => {
      const c = cenario({ modo, forma: 'NULO' });
      expect(await c.rodar()).toEqual({ kind: 'desligado' });
      expect(c.custo()).toEqual(SEM_CUSTO);
      expect(c.erros).toEqual([]);
      expect(doEvento(c, 'valvula')).toHaveLength(1);
    },
  );

  it.each(['NULO', ' nulo', 'null', '0', 'igual_cheio'])(
    'the forma %j cannot be read ⇒ forma-invalida, ONE ERROR line, zero reads — under dry-run and on alike',
    async (forma) => {
      for (const modo of [MODO_LI.on, MODO_LI.dryRun]) {
        __resetAllReadCaches();
        const c = cenario({ forma, modo });
        expect(await c.rodar()).toEqual({ kind: 'forma-invalida' });
        expect(c.custo()).toEqual(SEM_CUSTO);
        expect(c.motivosErro()).toEqual(['forma-promo-invalida']);
        expect(c.erros[0]?.[1]).toMatchObject({ variavel: 'LOJA_INTEGRADA_PRECO_PROMO_LIMPO' });
        expect(c.motivosAviso()).toEqual([]);
      }
    },
  );

  it('⚠️ NEAR-MISS: the forma blank ⇒ the default `nulo`: the run proceeds and sends `promocional: null`', async () => {
    const c = cenario({ forma: '' });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.textosDosPuts[0]).toBe('{"cheio":55.56,"promocional":null,"sob_consulta":false}');
  });

  it('the run’s own lines carry the prefix and ids, motivos and numbers only — never a price', async () => {
    const c = cenario({ forma: 'x' });
    await c.rodar();
    expect(c.erros[0]?.[0]).toBe(`${LINHA_PRECO_LI} forma-promo-invalida`);
    expect(c.erros[0]?.[1]).toEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      origem: 'evento',
      geracao: 0,
      baixar: false,
      motivo: 'forma-promo-invalida',
      variavel: 'LOJA_INTEGRADA_PRECO_PROMO_LIMPO',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                 The skips: zero credential reads, zero store calls          */
/* -------------------------------------------------------------------------- */

describe('every skip costs ZERO credential reads and ZERO store calls', () => {
  const linkPai = { ...link(), paiProdutoIntegradaId: null, grades: ['Cor'] };
  const linkSimples = { ...link(), paiProdutoIntegradaId: null, grades: null };

  /** [label, options, result, ERP ops for a CHILD, ERP ops for a ROOT (null: no root case)]. */
  const SKIPS: [string, OpcoesCenario, ResultadoPrecoLi, number, number | null][] = [
    ['no conta', { conta: null }, { kind: 'pulado', motivo: 'conta-inexistente' }, 1, 1],
    [
      'another channel’s conta',
      { conta: { ...CONTA_PADRAO, tipo: INTEGRACAO_TIPO.lojaIntegrada + 1 } },
      { kind: 'pulado', motivo: 'conta-inexistente' },
      1,
      1,
    ],
    [
      'an inactive conta',
      { conta: { ...CONTA_PADRAO, ativo: false } },
      { kind: 'pulado', motivo: 'conta-inativa' },
      1,
      1,
    ],
    [
      'a conta with no normal tabela',
      { conta: { ...CONTA_PADRAO, tabelaNormalOuterRef: null } },
      { kind: 'pulado', motivo: 'sem-tabela' },
      1,
      1,
    ],
    [
      'a conta whose normal tabela ref names another collection',
      { conta: { ...CONTA_PADRAO, tabelaNormalOuterRef: 'documents/outra/x' } },
      { kind: 'pulado', motivo: 'sem-tabela' },
      1,
      1,
    ],
    ['no produto', { produto: null }, { kind: 'pulado', motivo: 'produto-inexistente' }, 3, 3],
    ['no link', { links: {} }, { kind: 'pulado', motivo: 'sem-vinculo' }, 3, 3],
    [
      'a trashed link',
      { links: { l1: link({ removido: true }) } },
      { kind: 'pulado', motivo: 'sem-vinculo' },
      3,
      3,
    ],
    ['a parent link', { links: { l1: linkPai } }, { kind: 'pulado', motivo: 'pai' }, 3, 3],
    [
      'a simple root link',
      { links: { l1: linkSimples } },
      { kind: 'pulado', motivo: 'nao-suportado' },
      3,
      3,
    ],
    [
      'two store products',
      { links: { l1: link(), l2: link({ id: ID + 1 }) } },
      { kind: 'pulado', motivo: 'vinculo-ambiguo' },
      3,
      3,
    ],
    [
      'a parent id that names no document (held, NO parent read)',
      { produto: { paiId: 'a/b', precos: {} } },
      { kind: 'pulado', motivo: 'retido' },
      3,
      null,
    ],
    [
      'a parent that is not there (held after the parent read)',
      { pai: null },
      { kind: 'pulado', motivo: 'retido' },
      4,
      null,
    ],
    [
      'no normal-tabela price',
      { pai: { precos: {}, propagatePriceToChildren: true } },
      { kind: 'pulado', motivo: 'retido' },
      4,
      3,
    ],
    [
      'an unreadable entry',
      { pai: { precos: { [TAB_N]: { valor: 'x' } }, propagatePriceToChildren: true } },
      { kind: 'pulado', motivo: 'retido' },
      4,
      3,
    ],
  ];

  it.each(SKIPS)('CHILD: %s', async (_r, o, esperado, erp) => {
    const c = cenario(o);
    expect(await c.rodar()).toEqual(esperado);
    expect(c.custo()).toEqual(custoDeSkip(erp));
  });

  it.each(SKIPS.filter(([, , , , raiz]) => raiz !== null))(
    'ROOT: %s',
    async (_r, o, esperado, _f, raiz) => {
      // The same case for a produto with no parent: its own `precos` price it.
      const precosDoCaso = (o.pai as DocData | null | undefined)?.precos;
      const produto =
        o.produto === null
          ? null
          : { ...RAIZ, ...(precosDoCaso === undefined ? {} : { precos: precosDoCaso }) };
      const c = cenario({ ...o, produto, pai: null });
      expect(await c.rodar()).toEqual(esperado);
      expect(c.custo()).toEqual(custoDeSkip(raiz ?? -1));
    },
  );

  it('a held target is ONE WARNING with its reason; the conta’s missing tabela ONE WARNING too', async () => {
    const semPreco = cenario({ pai: { precos: {}, propagatePriceToChildren: true } });
    await semPreco.rodar();
    expect(semPreco.motivosAviso()).toEqual(['retido']);
    expect(semPreco.avisos[0]?.[1]).toMatchObject({ idLi: ID_LI, retencao: 'sem-preco' });
    expect(semPreco.motivosErro()).toEqual([]);
    __resetAllReadCaches();
    const paiAusente = cenario({ pai: null });
    await paiAusente.rodar();
    expect(paiAusente.avisos[0]?.[1]).toMatchObject({ retencao: 'pai-ausente' });
    __resetAllReadCaches();
    const semTabela = cenario({ conta: { ...CONTA_PADRAO, tabelaNormalOuterRef: null } });
    await semTabela.rodar();
    expect(semTabela.motivosAviso()).toEqual(['sem-tabela']);
  });

  it('⚠️ a link skip reads NO parent: conta and produto read, the links listed — nothing else', async () => {
    const c = cenario({ links: { l1: linkPai } });
    await c.rodar();
    expect(c.db.leituras).toEqual([`integracao/${CONTA}`, `produtos/${PRODUTO}`]);
    expect(c.db.consultas.map((q) => q.colecao)).toEqual([
      `produtos/${PRODUTO}/produtolojaintegrada`,
    ]);
  });

  it('⚠️ a parent id that names no document is never read: conta, produto and links only', async () => {
    const c = cenario({ produto: { paiId: '__x__', precos: {} } });
    expect(await c.rodar()).toEqual({ kind: 'pulado', motivo: 'retido' });
    expect(c.db.leituras).toEqual([`integracao/${CONTA}`, `produtos/${PRODUTO}`]);
  });

  it('a duplicate link on ANOTHER produto ⇒ vinculo-duplicado after the two probe queries, one WARNING (child 6 / root 5)', async () => {
    const filho = cenario();
    filho.db.seed('produtos/outro/produtolojaintegrada/l9', link({ id: ID_LI }));
    expect(await filho.rodar()).toEqual({ kind: 'pulado', motivo: 'vinculo-duplicado' });
    expect(filho.custo()).toEqual(custoDeSkip(6));
    expect(filho.motivosAviso()).toEqual(['vinculo-duplicado']);
    expect(filho.motivosErro()).toEqual([]);
    __resetAllReadCaches();
    const raiz = cenario({ produto: RAIZ, pai: null });
    raiz.db.seed('produtos/outro/produtolojaintegrada/l9', link({ id: ID_LI }));
    expect(await raiz.rodar()).toEqual({ kind: 'pulado', motivo: 'vinculo-duplicado' });
    expect(raiz.custo()).toEqual(custoDeSkip(5));
  });

  it('⚠️ NEAR-MISS: a TRASHED link on another produto is no duplicate — the run sends', async () => {
    const c = cenario();
    c.db.seed('produtos/outro/produtolojaintegrada/l9', link({ removido: true }));
    expect((await c.rodar()).kind).toBe('escrito');
  });

  it('the read switch off ⇒ dropped at the context: the ERP reads paid (child 6 / root 5), ZERO credential reads, zero calls', async () => {
    const c = cenario({ chamadas: false });
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'chamadas-desligadas' });
    expect(c.custo()).toEqual(custoDeSkip(6));
    expect(doEvento(c, 'chamada-bloqueada')).toHaveLength(1);
    __resetAllReadCaches();
    const raiz = cenario({ chamadas: false, produto: RAIZ, pai: null });
    expect(await raiz.rodar()).toEqual({ kind: 'descartado', motivo: 'chamadas-desligadas' });
    expect(raiz.custo()).toEqual(custoDeSkip(5));
  });

  it.each<[string, OpcoesCenario, string]>([
    ['no credential', { credencial: null }, 'credencial-ausente'],
    ['a corrupt credential', { credencial: { personalToken: 7 } }, 'credencial-invalida'],
    [
      'a parked conta',
      {
        credencial: {
          reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 401, refCredencial: 'a.1' },
        },
      },
      'conta-parada',
    ],
  ])(
    '%s ⇒ dropped at the context: ONE credential read, zero calls (child 6 / root 5)',
    async (_r, o, motivo) => {
      const c = cenario(o);
      expect(await c.rodar()).toEqual({ kind: 'descartado', motivo });
      expect(c.custo()).toEqual(custoDe(6, 1, 0));
      __resetAllReadCaches();
      const raiz = cenario({ ...o, produto: RAIZ, pai: null });
      expect(await raiz.rodar()).toEqual({ kind: 'descartado', motivo });
      expect(raiz.custo()).toEqual(custoDe(5, 1, 0));
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                         A bulk send carries its tabelas                     */
/* -------------------------------------------------------------------------- */

describe('a bulk send carries its run’s tabelas', () => {
  const leiturasDaConta = (c: Cenario) =>
    c.db.leituras.filter((l) => l === `integracao/${CONTA}`).length;

  it('the conta’s own tabelas ⇒ no extra read, sent as a lote', async () => {
    const c = cenario();
    expect(await c.rodar(doLote())).toEqual({ kind: 'escrito-lote' });
    expect(leiturasDaConta(c)).toBe(1);
  });

  it('⚠️ the conta names ANOTHER normal tabela ⇒ tabela-mudou (ONE WARNING) after ONE re-read: 2 conta reads, zero credential reads, zero calls', async () => {
    const c = cenario();
    expect(await c.rodar(doLote({ tabelaNormalId: 'tab-velha' }))).toEqual({
      kind: 'pulado',
      motivo: 'tabela-mudou',
    });
    expect(c.motivosAviso()).toEqual(['tabela-mudou']);
    expect(c.custo()).toEqual(custoDeSkip(2));
    // A ROOT pays the same: the skip comes before the produto is read.
    __resetAllReadCaches();
    const raiz = cenario({ produto: RAIZ, pai: null });
    expect(await raiz.rodar(doLote({ tabelaNormalId: 'tab-velha' }))).toEqual({
      kind: 'pulado',
      motivo: 'tabela-mudou',
    });
    expect(raiz.custo()).toEqual(custoDeSkip(2));
  });

  it('⚠️ a BULK send whose conta is gone ⇒ pulado conta-inexistente after ONE conta read: no re-read, no throw', async () => {
    const c = cenario({ conta: null });
    expect(await c.rodar(doLote())).toEqual({ kind: 'pulado', motivo: 'conta-inexistente' });
    expect(c.custo()).toEqual(custoDeSkip(1));
  });

  it('⚠️ the promotional tabela moved ⇒ tabela-mudou too', async () => {
    const c = cenario();
    expect(await c.rodar(doLote({ tabelaPromocionalId: 'tab-velha' }))).toEqual({
      kind: 'pulado',
      motivo: 'tabela-mudou',
    });
  });

  it('⚠️ a CACHED copy from before a re-point: evicted, read once more, sent at the NEW tabela', async () => {
    const c = cenario();
    await lerContaEmCache(asDb(c.db), CONTA);
    c.db.seed(`integracao/${CONTA}`, {
      ...CONTA_PADRAO,
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-nova',
    });
    c.db.seed(`produtos/${PAI}`, {
      precos: { [TAB_N]: { valor: 55.56 }, 'tab-nova': { valor: 66.66 } },
      propagatePriceToChildren: true,
    });
    expect(await c.rodar(doLote({ tabelaNormalId: 'tab-nova' }))).toEqual({ kind: 'escrito-lote' });
    expect(leiturasDaConta(c)).toBe(2);
    expect(c.p.textosDosPuts[0]).toBe('{"cheio":66.66,"promocional":null,"sob_consulta":false}');
  });

  it.each<[string, DocData, Partial<TarefaPrecoLi>]>([
    [
      'the conta’s promo IS its normal one, the task carries none',
      { ...CONTA_PADRAO, tabelaPromocionalOuterRef: REF_N },
      { tabelaPromocionalId: null },
    ],
    [
      'the task’s promo is its normal one, the conta names none',
      { ...CONTA_PADRAO, tabelaPromocionalOuterRef: null },
      { tabelaPromocionalId: TAB_N },
    ],
    [
      'the conta stores the bare ref forms',
      {
        ...CONTA_PADRAO,
        tabelaNormalOuterRef: `listaDePrecos/${TAB_N}`,
        tabelaPromocionalOuterRef: `listaDePrecos/${TAB_P}`,
      },
      {},
    ],
  ])('EQUAL: %s ⇒ the same pricing, sent, ONE conta read', async (_r, conta, over) => {
    const c = cenario({ conta });
    expect(await c.rodar(doLote(over))).toEqual({ kind: 'escrito-lote' });
    expect(leiturasDaConta(c)).toBe(1);
  });

  it('⚠️ NEAR-MISS: a promo the task names against a conta naming none ⇒ tabela-mudou', async () => {
    const c = cenario({ conta: { ...CONTA_PADRAO, tabelaPromocionalOuterRef: null } });
    expect((await c.rodar(doLote())).kind).toBe('pulado');
  });

  it('⚠️ NEAR-MISS: a non-bulk origin carries no tabelas and pays no check — the cached copy serves it', async () => {
    const c = cenario();
    await lerContaEmCache(asDb(c.db), CONTA);
    c.db.seed(`integracao/${CONTA}`, {
      ...CONTA_PADRAO,
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-nova',
    });
    expect((await c.rodar(tarefa())).kind).toBe('escrito');
    expect(leiturasDaConta(c)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                       The guard, after the deciding GET                     */
/* -------------------------------------------------------------------------- */

describe('the guard on the deciding read: 6/2/1, no PUT, no diff line', () => {
  it.each<[string, DocData, string, 'aviso' | 'erro' | null]>([
    ['another product’s id', { id: 1002 }, 'linha-divergente', 'erro'],
    ['the price row’s own id', { id: idDaLinhaDePrecoLi(ID) }, 'linha-divergente', 'erro'],
    ['a parent (`atributo`)', { tipo: 'atributo' }, 'nao-e-variacao', 'aviso'],
    ['a simple product (`normal`)', { tipo: 'normal' }, 'nao-e-variacao', 'aviso'],
    ['removido', { removido: true }, 'removido', null],
    ['bloqueado', { bloqueado: true }, 'bloqueado', null],
    ['removido unreadable', { removido: 'false' }, 'guarda-ilegivel', 'aviso'],
    ['bloqueado unreadable', { bloqueado: null }, 'guarda-ilegivel', 'aviso'],
    ['sob_consulta unreadable', { preco_sob_consulta: 'false' }, 'sob-consulta-ilegivel', 'aviso'],
    ['an unreadable full price', { preco_cheio: 'abc' }, 'atual-ilegivel', 'aviso'],
    ['an unreadable promotion', { preco_promocional: '1,50' }, 'atual-ilegivel', 'aviso'],
  ])('%s ⇒ descartado/%s', async (_r, detalhe, motivo, linha) => {
    const c = cenario();
    // The deciding GET of product 1001 answers the detail with these leaves (an `id` included:
    // the store answering ANOTHER product's detail on our path).
    const lido = {
      ...detalhePrecoLi(ID, { preco_cheio: 55.55, preco_promocional: null, preco_custo: null }),
      ...detalhe,
    };
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(200, lido)));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo });
    expect(c.custo()).toEqual(custoDe(6, 2, 1));
    expect(c.p.chamadas()).toEqual([GET]);
    expect(doEvento(c, 'diff')).toEqual([]);
    expect(c.motivosAviso()).toEqual(linha === 'aviso' ? [motivo] : []);
    expect(c.motivosErro()).toEqual(linha === 'erro' ? [motivo] : []);
  });

  it('⚠️ `ativo: false` is PRICED: an inactive child is written like any other', async () => {
    const c = cenario({ detalhe: { ativo: false } });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
  });

  it('the deciding GET answers 404 ⇒ ausente, one WARNING, ONE call', async () => {
    const c = cenario({ detalhe: null });
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'ausente' });
    expect(c.custo()).toEqual(custoDe(6, 2, 1));
    expect(c.motivosAviso()).toEqual(['ausente']);
    expect(c.motivosErro()).toEqual([]);
  });

  it('a detail missing one of its nine leaves (preco_custo) ⇒ leitura-ilegivel, ONE ERROR, no PUT', async () => {
    const c = cenario();
    const { preco_custo: _semCusto, ...semCusto } = detalhePrecoLi(ID, {
      preco_cheio: 55.55,
      preco_promocional: null,
      preco_custo: null,
    });
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(200, semCusto)));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'leitura-ilegivel' });
    expect(c.motivosErro()).toEqual(['leitura-ilegivel']);
    expect(c.p.puts()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              No-lower, end to end                           */
/* -------------------------------------------------------------------------- */

describe('no-lower, end to end (the PUT body by its exact text)', () => {
  const comAlvo = (cheio: number, promo?: number): Pick<OpcoesCenario, 'pai'> => ({
    pai: { precos: precos(cheio, promo), propagatePriceToChildren: true },
  });

  it('store 55.55 / none, target 55.54 + clear ⇒ nao-baixado [cheio, efetivo]: 0 PUT, 6/2/1, no aviso read', async () => {
    const c = cenario(comAlvo(55.54));
    expect(await c.rodar()).toEqual({ kind: 'nao-baixado', folhas: ['cheio', 'efetivo'] });
    expect(c.custo()).toEqual(custoDe(6, 2, 1));
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
  });

  it('target 55.55 + clear ⇒ refletido: ONE call, no PUT', async () => {
    const c = cenario(comAlvo(55.55));
    expect(await c.rodar()).toEqual({ kind: 'refletido' });
    expect(c.p.chamadas()).toEqual([GET]);
  });

  it('target 55.56 + clear ⇒ PUT `{"cheio":55.56,"promocional":null,"sob_consulta":false}`', async () => {
    const c = cenario(comAlvo(55.56));
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.textosDosPuts).toEqual(['{"cheio":55.56,"promocional":null,"sob_consulta":false}']);
  });

  it('a promotion lowered 44.44 → 44.43 ⇒ refused', async () => {
    const c = cenario({ ...comAlvo(55.55, 44.43), detalhe: { preco_promocional: 44.44 } });
    expect(await c.rodar()).toEqual({ kind: 'nao-baixado', folhas: ['promocional', 'efetivo'] });
  });

  it('⚠️ a NEW promotion 44.43 where the store shows none: refused under baixar false, PUT under true', async () => {
    const recusa = cenario(comAlvo(55.55, 44.43));
    expect(await recusa.rodar()).toEqual({ kind: 'nao-baixado', folhas: ['efetivo'] });
    __resetAllReadCaches();
    const envio = cenario(comAlvo(55.55, 44.43));
    expect((await envio.rodar(tarefa({ baixar: true }))).kind).toBe('escrito');
    expect(envio.p.textosDosPuts).toEqual([
      '{"cheio":55.55,"promocional":44.43,"sob_consulta":false}',
    ]);
  });

  it('a promotion 44.44 cleared ⇒ PUT (a clear never lowers)', async () => {
    const c = cenario({ ...comAlvo(55.55), detalhe: { preco_promocional: 44.44 } });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.textosDosPuts).toEqual(['{"cheio":55.55,"promocional":null,"sob_consulta":false}']);
  });

  it('an event with baixar true sends a LOWER full price', async () => {
    const c = cenario(comAlvo(55.54));
    expect((await c.rodar(tarefa({ baixar: true }))).kind).toBe('escrito');
    expect(c.p.textosDosPuts).toEqual(['{"cheio":55.54,"promocional":null,"sob_consulta":false}']);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Custo and sob_consulta                         */
/* -------------------------------------------------------------------------- */

describe('the custo and sob_consulta are the STORE’s, echoed from the deciding read', () => {
  it('a store custo of null ⇒ the PUT text has NO custo key, and no WARNING', async () => {
    const c = cenario({ detalhe: { preco_custo: null } });
    await c.rodar();
    expect(c.p.textosDosPuts[0]).not.toContain('custo');
    expect(c.motivosAviso()).toEqual([]);
  });

  it.each([
    [12.34, '{"cheio":55.56,"custo":12.34,"promocional":null,"sob_consulta":false}'],
    [0, '{"cheio":55.56,"custo":0,"promocional":null,"sob_consulta":false}'],
  ])('a store custo of %j ⇒ sent verbatim', async (custo, texto) => {
    const c = cenario({ detalhe: { preco_custo: custo } });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.textosDosPuts).toEqual([texto]);
    expect(c.motivosAviso()).toEqual([]);
  });

  it.each([-1.5, '12.34'])(
    'a store custo of %j the route cannot send ⇒ omitted, ONE WARNING custo-omitido, still written',
    async (custo) => {
      const c = cenario({ detalhe: { preco_custo: custo } });
      expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
      expect(c.p.textosDosPuts).toEqual([
        '{"cheio":55.56,"promocional":null,"sob_consulta":false}',
      ]);
      expect(c.motivosAviso()).toEqual(['custo-omitido']);
      expect(c.avisos[0]?.[1]).toMatchObject({ produtoId: PRODUTO, idLi: ID_LI });
    },
  );

  it.each(['abc', true])(
    '⚠️ a store custo of %j the restore line cannot carry ⇒ sem-restauracao: ONE ERROR naming the produto, 0 PUTs, NO custo WARNING',
    async (custo) => {
      const c = cenario({ detalhe: { preco_custo: custo } });
      expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'sem-restauracao' });
      expect(c.p.puts()).toEqual([]);
      expect(c.motivosErro()).toEqual(['sem-restauracao']);
      expect(c.erros[0]?.[1]).toMatchObject({ produtoId: PRODUTO, idLi: ID_LI });
      expect(c.motivosAviso()).toEqual([]);
      expect(c.custo()).toEqual(custoDe(6, 2, 1));
    },
  );

  it('⚠️ under dry-run the same custo `abc` ⇒ nao-enviado (dry-run comes first) with the ONE WARNING', async () => {
    const c = cenario({ modo: MODO_LI.dryRun, detalhe: { preco_custo: 'abc' } });
    expect(await c.rodar()).toEqual({ kind: 'nao-enviado', motivo: 'valvula' });
    expect(c.motivosAviso()).toEqual(['custo-omitido']);
    expect(c.motivosErro()).toEqual([]);
  });

  it('sob_consulta true on the store is echoed: `"sob_consulta":true`', async () => {
    const c = cenario({ detalhe: { preco_sob_consulta: true } });
    await c.rodar();
    expect(c.p.textosDosPuts).toEqual(['{"cheio":55.56,"promocional":null,"sob_consulta":true}']);
  });

  it('⚠️ the ERP custo (99.99 on the produto, 77.77 on the parent) is never read and never sent', async () => {
    const c = cenario({ detalhe: { preco_custo: 12.34 } });
    // NEVER READ is pinned on the reads themselves: the reader projects the same fields in code,
    // so an unmasked (or custo-widened) read would leave the run's answer unchanged.
    const getAll = vi.spyOn(c.db, 'getAll');
    await c.rodar();
    expect(getAll).toHaveBeenCalledTimes(2);
    for (const chamada of getAll.mock.calls) {
      expect(chamada.at(-1)).toEqual({
        fieldMask: ['paiId', 'precos', 'propagatePriceToChildren'],
      });
    }
    expect(c.p.textosDosPuts[0]).not.toContain('99.99');
    expect(c.p.textosDosPuts[0]).not.toContain('77.77');
    expect(c.p.textosDosPuts[0]).toContain('"custo":12.34');
  });

  it('a custo-only difference is no difference ⇒ refletido, no PUT', async () => {
    const c = cenario({
      pai: { precos: precos(55.55), propagatePriceToChildren: true },
      detalhe: { preco_custo: 11.11 },
    });
    expect(await c.rodar()).toEqual({ kind: 'refletido' });
    expect(c.p.puts()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The kind by origin, the clear forma                 */
/* -------------------------------------------------------------------------- */

describe('the origin decides the write kind, and whether there is a read-back call', () => {
  it.each(['evento', 'manual', 'publicacao'] as const)(
    '%s ⇒ preco-produto: GET, PUT, then the read-back GET (7 / 4 / 3)',
    async (origem) => {
      const c = cenario();
      const baixar = origem === ORIGEM_TAREFA_PRECO_LI.publicacao;
      expect(await c.rodar(tarefa({ origem, baixar }))).toEqual({
        kind: 'escrito',
        seguimento: 'nenhum',
      });
      expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
      expect(c.custo()).toEqual(custoDe(7, 4, 3));
      expect(doEvento(c, 'escrita')[0]?.campos.tipo).toBe('preco-produto');
    },
  );

  it('a ROOT costs one ERP read less (6 / 4 / 3)', async () => {
    const c = cenario({ produto: RAIZ, pai: null });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.custo()).toEqual(custoDe(6, 4, 3));
  });

  it('deriva ⇒ preco-produto too (a generation-1 payload)', async () => {
    const c = cenario();
    expect(await c.rodar(daDeriva())).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
  });

  it.each(['reconcile', 'atualizacao'] as const)(
    '%s ⇒ preco-produto-lote: GET and PUT, NO read-back call (7 / 3 / 2)',
    async (origem) => {
      const c = cenario();
      expect(await c.rodar(doLote({ origem }))).toEqual({ kind: 'escrito-lote' });
      expect(c.p.chamadas()).toEqual([GET, PUT]);
      expect(c.custo()).toEqual(custoDe(7, 3, 2));
      expect(doEvento(c, 'escrita')[0]?.campos.tipo).toBe('preco-produto-lote');
    },
  );

  it('⚠️ a lote whose PUT echo drifts neither reads back nor enqueues: the `eco` line is the only evidence', async () => {
    const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao });
    expect(await c.rodar(doLote({ origem: ORIGEM_TAREFA_PRECO_LI.atualizacao }))).toEqual({
      kind: 'escrito-lote',
    });
    expect(c.p.chamadas()).toEqual([GET, PUT]);
    expect(c.enfileiradas).toEqual([]);
    expect(doEvento(c, 'eco')[0]?.campos.resultado).toBe('deriva');
  });

  it('the table is the plan’s, re-exported', () => {
    expect(
      Object.fromEntries(
        Object.values(ORIGEM_TAREFA_PRECO_LI).map((o: OrigemTarefaPrecoLi) => [
          o,
          tipoEscritaDaOrigemPrecoLi(o),
        ]),
      ),
    ).toEqual({
      evento: 'preco-produto',
      manual: 'preco-produto',
      publicacao: 'preco-produto',
      deriva: 'preco-produto',
      reconcile: 'preco-produto-lote',
      atualizacao: 'preco-produto-lote',
    });
  });
});

describe('the clear forma, from the environment', () => {
  const limpar = { detalhe: { preco_promocional: 44.44 } };

  it.each<[string | undefined, string]>([
    [undefined, '{"cheio":55.56,"promocional":null,"sob_consulta":false}'],
    ['', '{"cheio":55.56,"promocional":null,"sob_consulta":false}'],
    ['nulo', '{"cheio":55.56,"promocional":null,"sob_consulta":false}'],
    ['zero', '{"cheio":55.56,"promocional":0,"sob_consulta":false}'],
    ['igual-cheio', '{"cheio":55.56,"promocional":55.56,"sob_consulta":false}'],
  ])('%j ⇒ the clear sent as %s', async (forma, texto) => {
    const c = cenario({ ...limpar, forma });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.p.textosDosPuts).toEqual([texto]);
  });

  it('under igual-cheio a store promotion EQUAL to the full price is a landed clear ⇒ refletido, ONE call', async () => {
    const c = cenario({
      forma: 'igual-cheio',
      pai: { precos: precos(55.55), propagatePriceToChildren: true },
      detalhe: { preco_promocional: 55.55 },
    });
    expect(await c.rodar()).toEqual({ kind: 'refletido' });
    expect(c.p.chamadas()).toEqual([GET]);
  });

  it('⚠️ NEAR-MISS: the same store under nulo is a stored promotion ⇒ the clear is sent', async () => {
    const c = cenario({
      pai: { precos: precos(55.55), propagatePriceToChildren: true },
      detalhe: { preco_promocional: 55.55 },
    });
    expect((await c.rodar()).kind).toBe('escrito');
  });
});

/* -------------------------------------------------------------------------- */
/*                               Dry-run and canary                            */
/* -------------------------------------------------------------------------- */

describe('dry-run and the canary', () => {
  it('dry-run ⇒ every read, ONE restore line, ONE diff line whose `depois` is the built body, no PUT, no aviso read or write', async () => {
    const c = cenario({ modo: MODO_LI.dryRun });
    expect(await c.rodar()).toEqual({ kind: 'nao-enviado', motivo: 'valvula' });
    expect(c.custo()).toEqual(custoDe(6, 2, 1));
    expect(doEvento(c, 'restauracao')).toHaveLength(1);
    const diffs = doEvento(c, 'diff');
    expect(diffs).toHaveLength(1);
    expect(JSON.parse(String(diffs[0]?.campos.depois))).toEqual({
      cheio: 55.56,
      promocional: null,
      sob_consulta: false,
    });
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
  });

  it.each<[string | null, ResultadoPrecoLi['kind'], string | null]>([
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
    if (r.kind === 'nao-enviado') {
      expect(r.motivo).toBe(motivo);
      expect(c.custo()).toEqual(custoDe(6, 2, 1));
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       The read-back and the one follow-up                   */
/* -------------------------------------------------------------------------- */

describe('the read-back and the ONE deriva follow-up', () => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it.each([false, true])(
    'a store that truncates the promotion ⇒ exactly ONE follow-up: deriva, generation 1, baixar %s inherited, no tabela ids, window read AFTER the read-back',
    async (baixar) => {
      const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao, cronometrado: true });
      expect(await c.rodar(tarefa({ baixar }))).toEqual({
        kind: 'escrito',
        seguimento: 'enfileirado',
      });
      expect(c.custo()).toEqual(custoDe(6, 4, 3, { enfileiradas: 1 }));
      const [enfileirada] = c.enfileiradas;
      // The clock after the read-back is past the dispatch's window: the window is read THEN.
      const janela = Math.floor((AGORA_MS + PIOR_EXECUCAO_PRECO_LI_MS) / 60_000);
      expect(janela).toBe(JANELA + 1);
      const esperada = {
        tipo: 'preco',
        contaId: CONTA,
        produtoId: PRODUTO,
        origem: 'deriva',
        geracao: 1,
        baixar,
        janela,
      };
      expect(enfileirada?.tarefa).toEqual(esperada);
      expect(tarefaPrecoLiSchema.safeParse(enfileirada?.tarefa).success).toBe(true);
      expect(enfileirada?.opcoes.id).toBe(
        `preco-${sha(`preco:deriva:${CONTA}:${PRODUTO}:${baixar ? 'b' : 'n'}:${String(janela)}`)}`,
      );
      expect(enfileirada?.opcoes.id).toBe(idDaTarefaPrecoLi(tarefaPrecoLiSchema.parse(esperada)));
      expect(doEvento(c, 'deriva')).toHaveLength(1);
      expect(c.db.escritas).toEqual([]);
    },
  );

  it('⚠️ NEAR-MISS: a store that keeps the price as four-decimal TEXT (`55.5600`) ⇒ igual: nenhum, no enqueue', async () => {
    const c = cenario({
      gravacaoPreco: (corpo, d) => {
        gravarPrecoPadraoLi(corpo, d);
        d.preco_cheio = '55.5600';
      },
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'nenhum' });
    expect(c.enfileiradas).toEqual([]);
  });

  it('⚠️ the same drift in a GENERATION-1 run ⇒ ZERO enqueues, ONE ERROR, and under `on` the aviso nao-refletido — an OPEN row left OPEN (never resolved, then raised)', async () => {
    const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao });
    abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
    expect(await c.rodar(daDeriva())).toEqual({ kind: 'escrito', seguimento: 'sem-seguimento' });
    expect(c.enfileiradas).toEqual([]);
    expect(c.motivosErro()).toEqual(['deriva-sem-seguimento']);
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
      motivo: 'nao-refletido',
      params: { loja: 'Loja P', produto: PRODUTO, idLi: ID_LI, motivo: 'nao-refletido' },
      relogioEvento: AGORA_MS * 1000,
      resolvidoEm: null,
    });
    expect(Object.hasOwn((c.db.ler(AVISO_RECUSADO)?.params ?? {}) as object, 'status')).toBe(false);
  });

  it('a generation-1 drift with NO row ⇒ the aviso nao-refletido is created: 6 / 4 / 3 and ONE write, no pre-read', async () => {
    const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao });
    await c.rodar(daDeriva());
    expect(c.custo()).toEqual(custoDe(6, 4, 3, { escritas: 1 }));
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
      motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido,
      severidade: SEVERIDADE_AVISO.atencao,
      resolvidoEm: null,
    });
  });

  it('⚠️ under dry-run a generation-1 run raises nothing (nothing is even sent)', async () => {
    const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao, modo: MODO_LI.dryRun });
    expect((await c.rodar(daDeriva())).kind).toBe('nao-enviado');
    expect(c.db.escritas).toEqual([]);
  });

  it('⚠️ outside the canary a generation-1 drift cannot happen either: no PUT, no aviso', async () => {
    const c = cenario({ ...SUBIDA, gravacaoPreco: truncaPromocao, canario: `${CONTA}:9` });
    expect((await c.rodar(daDeriva())).kind).toBe('nao-enviado');
    expect(c.db.escritas).toEqual([]);
  });

  it('⚠️ a read-back that cannot be made (a 503, contained) ⇒ fail open: ONE follow-up + WARNING sem-conferencia', async () => {
    const c = cenario({ aoResponder: depoisDoPut(() => respostaJson(503, {})) });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.motivosAviso()).toContain('sem-conferencia');
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('a read-back refused with 401 parks the conta, and the follow-up is still enqueued', async () => {
    const c = cenario({ aoResponder: depoisDoPut(() => respostaJson(401, {})) });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('⚠️ a read-back of ANOTHER product’s detail is no verification ⇒ fail open: ONE follow-up', async () => {
    const c = cenario({
      aoResponder: depoisDoPut(() =>
        respostaJson(
          200,
          detalhePrecoLi(1002, { preco_cheio: 55.56, preco_promocional: null, preco_custo: null }),
        ),
      ),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'enfileirado' });
    expect(c.motivosAviso()).toEqual(['sem-conferencia']);
    expect(c.avisos[0]?.[1]).toMatchObject({ classe: 'linha-divergente' });
  });

  it('⚠️ a generation-1 run whose read-back could not be made ⇒ ONE ERROR, NO aviso (an unread value proves nothing)', async () => {
    const c = cenario({ aoResponder: depoisDoPut(() => respostaJson(503, {})) });
    abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
    expect(await c.rodar(daDeriva())).toEqual({ kind: 'escrito', seguimento: 'sem-seguimento' });
    expect(c.motivosErro()).toEqual(['deriva-sem-seguimento']);
    expect(c.motivosAviso()).toEqual(['sem-conferencia']);
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ motivo: 'recusado', resolvidoEm: null });
    expect(c.db.escritas).toEqual([]);
  });

  it('the queue switched off ⇒ one WARNING and the write stands (no throw)', async () => {
    const c = cenario({
      ...SUBIDA,
      gravacaoPreco: truncaPromocao,
      enfileirar: () => Promise.reject(new LiTarefasDesligadasError()),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito', seguimento: 'tarefas-desligadas' });
    expect(c.motivosAviso()).toEqual(['deriva-tarefas-desligadas']);
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
      ...SUBIDA,
      gravacaoPreco: truncaPromocao,
      enfileirar: () => Promise.reject(transitoria),
    });
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
      const c = cenario({ tentativa });
      c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(429, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiThrottleError);
      expect(c.custo()).toEqual(custoDe(6, 3, 2));
      expect(c.erros).toEqual([]);
    },
  );

  it.each([
    [500, 0],
    [503, TASK_MAX_ATTEMPTS - 1],
  ])(
    '%i at attempt %i ⇒ thrown — never `recusado`, even on the LAST attempt',
    async (status, tentativa) => {
      const c = cenario({ tentativa });
      c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(status, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.p.chamadas()).toEqual([GET, PUT]);
      expect(c.custo().escritas).toBe(0);
      expect(c.db.ler(AVISO_RECUSADO)).toBeUndefined();
      expect(c.erros).toEqual([]);
    },
  );

  it('a PUT whose connection fails (network) ⇒ LiNetworkError rethrown: no read-back, nothing written', async () => {
    const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => new TypeError('rede')));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiNetworkError);
    expect(c.p.chamadas()).toEqual([GET, PUT]);
    expect(c.custo().escritas).toBe(0);
  });

  it('a later attempt is a run like any other: its OWN GET reads the store at the target ⇒ refletido', async () => {
    const c = cenario({ tentativa: 1, detalhe: { preco_cheio: 55.56 } });
    expect(await c.rodar()).toEqual({ kind: 'refletido' });
    expect(c.p.puts()).toEqual([]);
  });
});

describe('a PUT refused with a 3xx/4xx (not 401/403/429): rethrown until the LAST attempt, then recusado and the aviso', () => {
  it.each([
    [400, 0],
    [400, 1],
    [302, 0],
    [302, 1],
  ])('%i at attempt %i ⇒ rethrown, no aviso', async (status, tentativa) => {
    const c = cenario({ tentativa });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(status, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
    expect(c.custo().escritas).toBe(0);
  });

  it.each([400, 302])(
    'the LAST attempt, %i ⇒ recusado, ONE ERROR line, the aviso with its params, clocked by the DISPATCH START (not now)',
    async (status) => {
      expect(TASK_MAX_ATTEMPTS - 1).toBe(2);
      const inicioDaTarefaMs = AGORA_MS - 5_000;
      const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1, inicioDaTarefaMs });
      c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(status, {})));
      expect(await c.rodar()).toEqual({ kind: 'recusado', status });
      expect(c.motivosErro()).toEqual(['recusado']);
      expect(c.motivosAviso()).toEqual([]);
      expect(c.custo()).toEqual(custoDe(6, 3, 2, { escritas: 1 }));
      expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
        tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
        severidade: SEVERIDADE_AVISO.atencao,
        motivo: 'recusado',
        params: { loja: 'Loja P', produto: PRODUTO, idLi: ID_LI, motivo: 'recusado', status },
        relogioEvento: inicioDaTarefaMs * 1000,
        resolvidoEm: null,
      });
    },
  );

  it('a conta whose nome is EMPTY names the store by its conta id in the refusal aviso', async () => {
    const c = cenario({ conta: { ...CONTA_PADRAO, nome: '' }, tentativa: TASK_MAX_ATTEMPTS - 1 });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(400, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', status: 400 });
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ params: { loja: CONTA } });
  });

  it('⚠️ under dry-run nothing is ever sent, so nothing is ever refused', async () => {
    const c = cenario({ modo: MODO_LI.dryRun, tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(400, {})));
    expect((await c.rodar()).kind).toBe('nao-enviado');
    expect(c.custo().escritas).toBe(0);
  });
});

describe('401/403', () => {
  it.each([401, 403])(
    '%i on the deciding GET ⇒ the conta is PARKED, the run drops, no PUT, one credential write',
    async (status) => {
      const c = cenario();
      c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(status, {})));
      expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'conta-parada' });
      expect(c.p.puts()).toEqual([]);
      expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status });
      expect(c.db.escritasEm(CREDENCIAL)).toHaveLength(1);
    },
  );

  it('⚠️ a 401 for an OLDER token (re-saved while the GET was in flight) ⇒ nothing parked, the LiAuthError rethrown', async () => {
    const c = cenario({
      tentativa: TASK_MAX_ATTEMPTS - 1,
      aoResponder: (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) {
          seedCredencial(cen.db, CONTA, { tokenAtualizadoEmMs: AGORA_MS - 1000 });
        }
      },
    });
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(401, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
    expect(c.p.puts()).toEqual([]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toBeNull();
    expect(c.custo().escritas).toBe(0);
  });

  it('a 401 on the deciding GET, the credential DELETED meanwhile ⇒ dropped credencial-ausente, nothing parked', async () => {
    const c = cenario({
      aoResponder: async (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) await docCredencial(asDb(cen.db), CONTA).delete();
      },
    });
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'credencial-ausente' });
    expect(c.p.puts()).toEqual([]);
  });

  it('a 401 on the deciding GET, the credential CORRUPT meanwhile ⇒ dropped credencial-invalida, nothing parked', async () => {
    const c = cenario({
      aoResponder: (metodo, _caminho, n, cen) => {
        if (metodo === 'GET' && n === 0) cen.db.seed(CREDENCIAL, { personalToken: 7 });
      },
    });
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'credencial-invalida' });
    expect(c.p.puts()).toEqual([]);
    expect(c.custo().escritas).toBe(0);
  });

  it('401 on the PUT, refused again by the confirming deciding read ⇒ parked, dropped', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {})));
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'conta-parada' });
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('⚠️ 401 on the PUT while the token still READS ⇒ nothing parked; rethrown before the last attempt', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
    expect(c.p.chamadas()).toEqual([GET, PUT, GET]);
    expect(c.db.ler(CREDENCIAL)?.reconexaoPendente).toBeNull();
    expect(c.custo().escritas).toBe(0);
  });

  it('401 on the PUT while the token still reads, on the LAST attempt ⇒ recusado 401 and the aviso', async () => {
    const c = cenario({ tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', status: 401 });
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ params: { status: 401 } });
  });

  it('401 on the PUT, the confirming read finds no product ⇒ nothing to conclude: the 401 is rethrown', async () => {
    const c = cenario({ tentativa: 2 });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {})));
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(404, undefined)));
    await expect(c.rodar()).rejects.toBeInstanceOf(LiAuthError);
  });

  it('401 on the PUT, the credential DELETED before the confirming read ⇒ dropped credencial-ausente on the LAST attempt: the confirming GET is never sent, no aviso', async () => {
    const c = cenario({
      tentativa: TASK_MAX_ATTEMPTS - 1,
      aoResponder: async (metodo, _caminho, _n, cen) => {
        if (metodo === 'PUT') await docCredencial(asDb(cen.db), CONTA).delete();
      },
    });
    c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {})));
    expect(await c.rodar()).toEqual({ kind: 'descartado', motivo: 'credencial-ausente' });
    expect(c.p.chamadas()).toEqual([GET, PUT]);
    expect(c.db.ler(AVISO_RECUSADO)).toBeUndefined();
  });
});

describe('the deciding read refused otherwise', () => {
  it('⚠️ an EMPTY 200 is the transport’s: rethrown for the retry', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => new Response('', { status: 200 })));
    await expect(c.rodar()).rejects.toMatchObject({ name: 'LiSchemaError' });
  });

  it('another 4xx: rethrown before the last attempt, then dropped with one ERROR and NO aviso', async () => {
    const antes = cenario({ tentativa: 1 });
    antes.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(400, {})));
    await expect(antes.rodar()).rejects.toBeInstanceOf(LiHttpError);
    __resetAllReadCaches();
    const ultima = cenario({ tentativa: 2 });
    ultima.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(400, {})));
    expect(await ultima.rodar()).toEqual({ kind: 'descartado', motivo: 'leitura-recusada' });
    expect(ultima.motivosErro()).toEqual(['leitura-recusada']);
    expect(ultima.custo().escritas).toBe(0);
  });

  it.each([429, 503])(
    'a %i on the deciding read is thrown even on the LAST attempt (6 / 2 / 1)',
    async (status) => {
      const c = cenario({ tentativa: TASK_MAX_ATTEMPTS - 1 });
      c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(status, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.custo()).toEqual(custoDe(6, 2, 1));
      expect(c.erros).toEqual([]);
    },
  );
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

describe('the write getter’s refusals DROP with their class, with nothing sent', () => {
  it.each<[string, string, (cen: Cenario) => Promise<void> | void]>([
    [
      'the conta PARKED',
      'conta-parada',
      (cen) => {
        seedCredencial(cen.db, CONTA, {
          reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 401, refCredencial: 'a.1' },
        });
      },
    ],
    [
      'the credential DELETED',
      'credencial-ausente',
      async (cen) => {
        await docCredencial(asDb(cen.db), CONTA).delete();
      },
    ],
  ])(
    '%s between the deciding GET and the PUT ⇒ dropped %s: the PUT is never sent',
    async (_r, motivo, mudar) => {
      const c = cenario({
        aoResponder: async (metodo, _caminho, n, cen) => {
          if (metodo === 'GET' && n === 0) await mudar(cen);
        },
      });
      expect(await c.rodar()).toEqual({ kind: 'descartado', motivo });
      expect(c.p.chamadas()).toEqual([GET]);
      expect(c.db.ler(AVISO_RECUSADO)).toBeUndefined();
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                               The refusal row                               */
/* -------------------------------------------------------------------------- */

describe('the refusal aviso is resolved only when OPEN, under `on`, and only by an outcome that proves the price', () => {
  it.each<[string, OpcoesCenario, TarefaPrecoLi, ResultadoPrecoLi]>([
    ['escrito/nenhum', {}, tarefa(), { kind: 'escrito', seguimento: 'nenhum' }],
    [
      'refletido',
      { pai: { precos: precos(55.55), propagatePriceToChildren: true } },
      tarefa(),
      { kind: 'refletido' },
    ],
    ['escrito-lote', {}, doLote(), { kind: 'escrito-lote' }],
  ])(
    'an open row and a later `on` run ending %s ⇒ resolved, its clock advanced',
    async (_r, o, t, esperado) => {
      const c = cenario(o);
      abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
      expect(await c.rodar(t)).toEqual(esperado);
      expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({
        resolucaoMotivo: 'preco-enviado',
        relogioEvento: AGORA_MS * 1000,
      });
      expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).not.toBeNull();
    },
  );

  it('⚠️ NO open row ⇒ the write log stays EMPTY (a clocked resolve would seed one), after its one pre-read', async () => {
    for (const o of [
      {},
      { pai: { precos: precos(55.55), propagatePriceToChildren: true } },
    ] satisfies OpcoesCenario[]) {
      const c = cenario(o);
      await c.rodar();
      expect(c.db.escritas).toEqual([]);
      expect(c.db.leituras).toContain(AVISO_RECUSADO);
      __resetAllReadCaches();
    }
  });

  it('⚠️ an ALREADY resolved row ⇒ nothing written either', async () => {
    const c = cenario();
    abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
    c.db.seed(AVISO_RECUSADO, {
      ...c.db.ler(AVISO_RECUSADO),
      resolvidoEm: AGORA_MS * 1000 - 1,
      resolucaoMotivo: 'preco-enviado',
    });
    await c.rodar();
    expect(c.db.escritas).toEqual([]);
  });

  it('a NEWER run’s open row is never closed by an older run (the clock)', async () => {
    const c = cenario();
    abrirRecusa(c, (AGORA_MS + 60_000) * 1000);
    await c.rodar();
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it('⚠️ the clock is the run’s DISPATCH START, not now: a row raised after this run STARTED stays open', async () => {
    const c = cenario({ inicioDaTarefaMs: AGORA_MS - 120_000 });
    abrirRecusa(c, (AGORA_MS - 60_000) * 1000);
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it('under dry-run: not even the pre-read', async () => {
    const c = cenario({ modo: MODO_LI.dryRun });
    abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
    await c.rodar();
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
    expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
  });

  it.each<[string, OpcoesCenario]>([
    ['under dry-run', { modo: MODO_LI.dryRun }],
    ['outside the canary', { canario: `${CONTA}:9` }],
    ['with no canary', { canario: null }],
  ])(
    '⚠️ a store ALREADY reflected %s ⇒ refletido at 6 / 2 / 1: the open aviso is neither read nor closed',
    async (_r, o) => {
      const c = cenario({ ...o, pai: { precos: precos(55.55), propagatePriceToChildren: true } });
      abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
      expect(await c.rodar()).toEqual({ kind: 'refletido' });
      expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
      expect(c.db.ler(AVISO_RECUSADO)?.resolvidoEm).toBeNull();
      expect(c.custo()).toEqual(custoDe(6, 2, 1));
    },
  );

  it('refletido under `on` pays the one pre-read: 7 / 2 / 1 (a root 6 / 2 / 1)', async () => {
    const reflete = { pai: { precos: precos(55.55), propagatePriceToChildren: true } };
    const filho = cenario(reflete);
    expect(await filho.rodar()).toEqual({ kind: 'refletido' });
    expect(filho.custo()).toEqual(custoDe(7, 2, 1));
    __resetAllReadCaches();
    const raiz = cenario({ produto: { precos: precos(55.55) }, pai: null });
    expect(await raiz.rodar()).toEqual({ kind: 'refletido' });
    expect(raiz.custo()).toEqual(custoDe(6, 2, 1));
  });

  it.each<[string, OpcoesCenario, TarefaPrecoLi]>([
    ['nao-baixado', { pai: { precos: precos(55.54), propagatePriceToChildren: true } }, tarefa()],
    ['removido', { detalhe: { removido: true } }, tarefa()],
    ['a generation-0 drift', { ...SUBIDA, gravacaoPreco: truncaPromocao }, tarefa()],
    ['a skip (no link)', { links: {} }, tarefa()],
  ])('⚠️ %s ⇒ the open row is untouched and NOT pre-read', async (_r, o, t) => {
    const c = cenario(o);
    abrirRecusa(c, (AGORA_MS - 3_600_000) * 1000);
    await c.rodar(t);
    expect(c.db.leituras).not.toContain(AVISO_RECUSADO);
    expect(c.db.ler(AVISO_RECUSADO)).toMatchObject({ motivo: 'recusado', resolvidoEm: null });
    expect(c.db.escritas).toEqual([]);
  });

  it('⚠️ a refused lowering costs 6 / 2 / 1: no aviso pre-read', async () => {
    const c = cenario({ pai: { precos: precos(55.54), propagatePriceToChildren: true } });
    expect((await c.rodar()).kind).toBe('nao-baixado');
    expect(c.custo()).toEqual(custoDe(6, 2, 1));
  });

  it('no Firestore write on ANY success with no open aviso', async () => {
    for (const [o, t] of [
      [{}, tarefa()],
      [{ pai: { precos: precos(55.55), propagatePriceToChildren: true } }, tarefa()],
      [{ modo: MODO_LI.dryRun }, tarefa()],
      [{}, doLote()],
      [{ ...SUBIDA, gravacaoPreco: truncaPromocao }, tarefa()],
    ] satisfies [OpcoesCenario, TarefaPrecoLi][]) {
      const c = cenario(o);
      await c.rodar(t);
      expect(c.db.escritas).toEqual([]);
      __resetAllReadCaches();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                  The cost table: child and root, past the context           */
/* -------------------------------------------------------------------------- */

describe('the cost of every outcome past the write context, CHILD and ROOT (a root reads no parent)', () => {
  type Caso = [
    string,
    OpcoesCenario,
    (c: Cenario) => void,
    TarefaPrecoLi,
    ResultadoPrecoLi | 'lanca',
    ReturnType<typeof custoDe>,
  ];
  const nada = () => undefined;
  const { preco_custo: _semCusto, ...semCusto } = detalhePrecoLi(ID, {
    preco_cheio: 55.55,
    preco_promocional: null,
    preco_custo: null,
  });
  const refletePai = { pai: { precos: precos(55.55), propagatePriceToChildren: true } };
  const CASOS: Caso[] = [
    [
      'already reflected under dry-run',
      { ...refletePai, modo: MODO_LI.dryRun },
      nada,
      tarefa(),
      { kind: 'refletido' },
      custoDe(6, 2, 1),
    ],
    [
      'already reflected outside the canary',
      { ...refletePai, canario: `${CONTA}:9` },
      nada,
      tarefa(),
      { kind: 'refletido' },
      custoDe(6, 2, 1),
    ],
    [
      'already reflected with no canary',
      { ...refletePai, canario: null },
      nada,
      tarefa(),
      { kind: 'refletido' },
      custoDe(6, 2, 1),
    ],
    [
      'already reflected under `on` (the one refusal-aviso pre-read)',
      refletePai,
      nada,
      tarefa(),
      { kind: 'refletido' },
      custoDe(7, 2, 1),
    ],
    [
      'leitura-ilegivel (a detail missing one of its nine leaves)',
      {},
      (c) => c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(200, semCusto))),
      tarefa(),
      { kind: 'descartado', motivo: 'leitura-ilegivel' },
      custoDe(6, 2, 1),
    ],
    [
      'dry-run',
      { modo: MODO_LI.dryRun },
      nada,
      tarefa(),
      { kind: 'nao-enviado', motivo: 'valvula' },
      custoDe(6, 2, 1),
    ],
    [
      'a guard skip',
      { detalhe: { bloqueado: true } },
      nada,
      tarefa(),
      { kind: 'descartado', motivo: 'bloqueado' },
      custoDe(6, 2, 1),
    ],
    [
      'ausente',
      { detalhe: null },
      nada,
      tarefa(),
      { kind: 'descartado', motivo: 'ausente' },
      custoDe(6, 2, 1),
    ],
    [
      'nao-baixado',
      { detalhe: { preco_cheio: 99.99 } },
      nada,
      tarefa(),
      { kind: 'nao-baixado', folhas: ['cheio', 'efetivo'] },
      custoDe(6, 2, 1),
    ],
    [
      'sem-restauracao',
      { detalhe: { preco_custo: 'abc' } },
      nada,
      tarefa(),
      { kind: 'descartado', motivo: 'sem-restauracao' },
      custoDe(6, 2, 1),
    ],
    [
      'escrito/nenhum',
      {},
      nada,
      tarefa(),
      { kind: 'escrito', seguimento: 'nenhum' },
      custoDe(7, 4, 3),
    ],
    [
      'a generation-0 drift',
      { ...SUBIDA, gravacaoPreco: truncaPromocao },
      nada,
      tarefa(),
      { kind: 'escrito', seguimento: 'enfileirado' },
      custoDe(6, 4, 3, { enfileiradas: 1 }),
    ],
    [
      'a generation-1 verified drift under `on`',
      { ...SUBIDA, gravacaoPreco: truncaPromocao },
      nada,
      daDeriva(),
      { kind: 'escrito', seguimento: 'sem-seguimento' },
      custoDe(6, 4, 3, { escritas: 1 }),
    ],
    ['escrito-lote', {}, nada, doLote(), { kind: 'escrito-lote' }, custoDe(7, 3, 2)],
    [
      'recusado on the last attempt',
      { tentativa: TASK_MAX_ATTEMPTS - 1 },
      (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(400, {}))),
      tarefa(),
      { kind: 'recusado', status: 400 },
      custoDe(6, 3, 2, { escritas: 1 }),
    ],
    [
      'a PUT that throws (429)',
      {},
      (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(429, {}))),
      tarefa(),
      'lanca',
      custoDe(6, 3, 2),
    ],
    [
      'a PUT answered 503 on the last attempt (thrown, never recusado)',
      { tentativa: TASK_MAX_ATTEMPTS - 1 },
      (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(503, {}))),
      tarefa(),
      'lanca',
      custoDe(6, 3, 2),
    ],
    [
      'a PUT refused 400 before the last attempt (rethrown)',
      {},
      (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(400, {}))),
      tarefa(),
      'lanca',
      custoDe(6, 3, 2),
    ],
    [
      'a deciding GET that throws (503)',
      {},
      (c) => c.p.fila.push(naProxima(CAMINHO_DETALHE, 'GET', () => respostaJson(503, {}))),
      tarefa(),
      'lanca',
      custoDe(6, 2, 1),
    ],
  ];
  /** The same case for a ROOT: its own `precos` hold what the parent's held. */
  const raiz = (o: OpcoesCenario): OpcoesCenario => {
    const pai = o.pai === undefined ? { precos: precos(55.56) } : o.pai;
    return { ...o, produto: { precos: pai?.precos ?? {}, custo: 99.99 }, pai: null };
  };

  it.each(CASOS)('CHILD: %s', async (_r, o, preparar, t, esperado, custo) => {
    const c = cenario(o);
    preparar(c);
    if (esperado === 'lanca') await expect(c.rodar(t)).rejects.toBeInstanceOf(LiHttpError);
    else expect(await c.rodar(t)).toEqual(esperado);
    expect(c.custo()).toEqual(custo);
  });

  it.each(CASOS)('ROOT: %s (one ERP read less)', async (_r, o, preparar, t, esperado, custo) => {
    const c = cenario(raiz(o));
    preparar(c);
    if (esperado === 'lanca') await expect(c.rodar(t)).rejects.toBeInstanceOf(LiHttpError);
    else expect(await c.rodar(t)).toEqual(esperado);
    expect(c.custo()).toEqual({ ...custo, erp: custo.erp - 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*                         The worst run, measured                             */
/* -------------------------------------------------------------------------- */

describe('the worst case of one run, measured (the price queue sizes its timeout on it)', () => {
  it('an event-origin PUT with every call at its full deadline ⇒ exactly PIOR_EXECUCAO_PRECO_LI_MS; the PUT starts by 24 s', async () => {
    const c = cenario({ cronometrado: true });
    expect((await c.rodar()).kind).toBe('escrito');
    expect(c.decorridoMs()).toBe(PIOR_EXECUCAO_PRECO_LI_MS);
    expect(PIOR_EXECUCAO_PRECO_LI_MS).toBe(68_000);
    expect(PIOR_EXECUCAO_PRECO_LI_MS).toBe(
      2 * (2 * RITMO_ESCRITA_LI_MS + PRAZO_DE_UMA_CHAMADA_MS) + PRAZO_DE_UMA_CHAMADA_MS,
    );
    const inicioDoPut = (c.instantes[1] ?? Number.NaN) - AGORA_MS;
    expect(inicioDoPut).toBe(2 * RITMO_ESCRITA_LI_MS + PRAZO_DE_UMA_CHAMADA_MS);
    expect(inicioDoPut).toBeLessThan(PRAZO_ULTIMA_ESCRITA_MS);
  });

  it('no case of the grid is slower', async () => {
    const grade: [string, OpcoesCenario, (c: Cenario) => void, TarefaPrecoLi][] = [
      [
        'refletido',
        { pai: { precos: precos(55.55), propagatePriceToChildren: true } },
        () => undefined,
        tarefa(),
      ],
      ['dry-run', { modo: MODO_LI.dryRun }, () => undefined, tarefa()],
      ['lote', {}, () => undefined, doLote()],
      ['deriva', { ...SUBIDA, gravacaoPreco: truncaPromocao }, () => undefined, tarefa()],
      [
        '401 confirmado no último',
        { tentativa: 2 },
        (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(401, {}))),
        tarefa(),
      ],
      [
        '400 no último',
        { tentativa: 2 },
        (c) => c.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', () => respostaJson(400, {}))),
        tarefa(),
      ],
      ['404', { detalhe: null }, () => undefined, tarefa()],
      ['guarda', { detalhe: { removido: true } }, () => undefined, tarefa()],
      [
        'nao-baixado',
        { pai: { precos: precos(55.54), propagatePriceToChildren: true } },
        () => undefined,
        tarefa(),
      ],
    ];
    for (const [rotulo, o, preparar, t] of grade) {
      __resetAllReadCaches();
      const c = cenario({ ...o, cronometrado: true });
      preparar(c);
      await c.rodar(t);
      expect(c.decorridoMs(), rotulo).toBeLessThanOrEqual(PIOR_EXECUCAO_PRECO_LI_MS);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                   Property: whole runs over drawn store states              */
/* -------------------------------------------------------------------------- */

/** mulberry32: a deterministic generator in [0, 1). */
function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('PROPERTY: whole runs over drawn store states and targets', () => {
  const escolher = <T>(r: () => number, de: readonly T[]): T =>
    de[Math.floor(r() * de.length)] as T;
  const PRECOS: readonly unknown[] = [null, 0, 22.22, 44.44, 55.55, '55.5500', 'abc'];
  const CUSTOS: readonly unknown[] = [null, 0, 12.34, -1.5, '12.34', 'abc'];
  const SORTEIOS = 300;

  // CI runners are ~5× slower under load: 300 whole runs through the fake get their own budget.
  it(
    `${String(SORTEIOS)} seeded runs: at most one PUT, the PUT custo is the store's own or absent, a refused lowering never sends`,
    { timeout: 120_000 },
    async () => {
      const r = mulberry32(13_404);
      const vistos = new Set<string>();
      for (let i = 0; i < SORTEIOS; i++) {
        __resetAllReadCaches();
        const custo = escolher(r, CUSTOS);
        const detalhe = {
          preco_cheio: escolher(r, PRECOS),
          preco_promocional: escolher(r, PRECOS),
          preco_custo: custo,
          preco_sob_consulta: r() < 0.5,
        };
        const promo = r() < 0.5 ? undefined : escolher(r, [11.11, 44.44, 66.66]);
        const pai = {
          precos: precos(escolher(r, [22.22, 55.55, 66.66]), promo),
          propagatePriceToChildren: true,
        };
        const c = cenario({ detalhe, pai, modo: escolher(r, [MODO_LI.on, MODO_LI.dryRun]) });
        const resultado = await c.rodar(tarefa({ baixar: r() < 0.5 }));
        const rotulo = `sorteio ${String(i)}: ${JSON.stringify({ detalhe, pai, resultado })}`;
        vistos.add(resultado.kind);
        expect(c.p.puts().length, rotulo).toBeLessThanOrEqual(1);
        if (resultado.kind === 'nao-baixado') expect(c.p.puts(), rotulo).toEqual([]);
        const [put] = c.p.puts();
        if (put !== undefined) {
          const corpo = put.corpo as Readonly<Record<string, unknown>>;
          if (Object.hasOwn(corpo, 'custo'))
            expect(Object.is(corpo.custo, custo), rotulo).toBe(true);
          expect(corpo.sob_consulta, rotulo).toBe(detalhe.preco_sob_consulta);
        }
        // Anything that is no landed or refused write leaves Firestore untouched.
        if (resultado.kind !== 'recusado' && resultado.kind !== 'escrito') {
          expect(c.db.escritas, rotulo).toEqual([]);
        }
      }
      // Anti-vacuity: the sweep met sends, reflected stores, refused lowerings and unreadable ones.
      for (const kind of ['escrito', 'refletido', 'nao-baixado', 'descartado', 'nao-enviado']) {
        expect(vistos, kind).toContain(kind);
      }
    },
  );
});
