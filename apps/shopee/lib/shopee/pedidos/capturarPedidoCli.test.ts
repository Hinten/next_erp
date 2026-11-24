/**
 * The pure half of `capturar:pedido`, in twelve parts:
 *
 *  - §1 the parser, near-misses included;
 *  - §2 the credential reader — which variables it reads (ONLY the four), what
 *    it refuses, and that a refusal names the variable, never the value;
 *  - §3 the path guards (the replay's, imported) over POSIX and Windows doubles;
 *  - §4 the network guard and its look-alike hosts, verbs and paths — and the
 *    installed guard, which never follows a redirect;
 *  - §5 the tee: the same status and the same BYTES, and the real client still
 *    parses what it hands back;
 *  - §6 THE FIDELITY PIN: the capture's two requests, recorded, against the
 *    importer's own two requests over the same kind of stub;
 *  - §7 the capture's outcomes — what is saved, what stops the run, a failed
 *    write;
 *  - §7b THE ROUND TRIP: every escrow outcome, captured and then REPLAYED
 *    through `reproduzirPedidoShopee` — a saved file is always replayable;
 *  - §7c the atomic writer, over a double and over the real filesystem;
 *  - §8 THE PROPERTY: no printed line carries the token, the key, a sign, the
 *    shop id, the URL or a buyer value;
 *  - §9 the error describer, and §10 the source pins (`scripts/` is outside
 *    vitest's include, so the script is pinned on its SOURCE).
 *
 * Every credential below is a FIXTURE (partner 1000001, shop 987654); every
 * buyer value is invented. Nothing here reaches a network: each `fetch` is a
 * stub. §7c's one real-filesystem test writes only inside a fresh OS temp
 * directory, and removes it.
 */
import nodePath from 'node:path';
import nodeOs from 'node:os';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_ESCROW_DETAIL_PATH,
  SHOPEE_GET_ORDER_DETAIL_PATH,
  SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
  SHOPEE_PROD_API_HOST,
  SHOPEE_PROD_AUTH_HOST,
  SHOPEE_SANDBOX_API_HOST,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  createShopeeClient,
} from '@delfrance/integrations-shopee';

import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  WIRE_DIR,
} from '../fixtures/wireCorpus';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ArgumentoInvalidoError,
  ArquivoRecusadoError,
  CAMINHOS_DA_CAPTURA,
  CredencialDaCapturaError,
  HOSTS_DA_CAPTURA,
  HOST_DA_CAPTURA,
  RequisicaoBloqueadaNaCapturaError,
  SUFIXO_PARCIAL,
  USO_CAPTURAR_PEDIDO,
  VARIAVEIS_DA_CAPTURA,
  alvoParaRelatorio,
  argumentoDeShell,
  caminhoParcial,
  codigoDoEnvelope,
  criarClienteDaCaptura,
  criarFetchEspelho,
  criarFetchGuardado,
  descreverErroCaptura,
  escrowReproduzivel,
  executarCaptura,
  exigirCaminhosDaCaptura,
  gravarSemSobrescrever,
  hostPermitidoNaCaptura,
  lerCredenciaisDaCaptura,
  metodoDaRequisicao,
  montarSaidaDaCaptura,
  parseArgsCapturarPedido,
  requisicaoPermitidaNaCaptura,
  resumoDoDetalhe,
  urlDaRequisicao,
  type CaminhosDaCaptura,
  type CredenciaisDaCaptura,
  type OperacoesDeGravacao,
  type PapelDaCaptura,
  type ResultadoDaGravacao,
  type TipoDoCaminho,
} from './capturarPedidoCli';
import { falhaDeEscrowNaoContida } from './escrowNaoContido';
import { prepararImportacaoPedidoShopee } from './importarPedido';
import {
  INTEGRACAO_DA_REPRODUCAO,
  LOJA_DA_REPRODUCAO,
  PARCEIRO_DA_REPRODUCAO,
  linhasDeSemente,
  reproduzirPedidoShopee,
} from './reproduzirPedido';
import {
  CapturaInvalidaError,
  encontrarResiduos,
  valoresSensiveisDaCaptura,
} from './reproduzirPedidoCli';

/* -------------------------------------------------------------------------- */
/*                                  vectors                                    */
/* -------------------------------------------------------------------------- */

const NOW_MS = 1_789_000_000_000;

/** Fixture credentials — the replay's own fixture ids, an invented key and token. */
const CREDENCIAIS: CredenciaisDaCaptura = {
  partnerId: PARCEIRO_DA_REPRODUCAO,
  partnerKey: 'chave-de-teste-da-captura-k9q2',
  shopId: LOJA_DA_REPRODUCAO,
  accessToken: 'token-de-teste-da-captura-t7w4',
};

const AMBIENTE_VALIDO: Record<string, string> = {
  SHOPEE_CAP_PARTNER_ID: String(CREDENCIAIS.partnerId),
  SHOPEE_CAP_PARTNER_KEY: CREDENCIAIS.partnerKey,
  SHOPEE_CAP_SHOP_ID: String(CREDENCIAIS.shopId),
  SHOPEE_CAP_ACCESS_TOKEN: CREDENCIAIS.accessToken,
};

const CAMINHOS: CaminhosDaCaptura = {
  pasta: '/fora/capturas',
  detalhe: '/fora/capturas/pedido-a.detalhe.json',
  escrow: '/fora/capturas/pedido-a.escrow.json',
};

/** The repo's one sanctioned fake CPF. */
const CPF_FALSO = '12345678909';

/** The committed SG bodies, as the RAW file text — the bytes, not a re-serialisation. */
const DETALHE_SG_TEXTO = readFileSync(
  nodePath.join(WIRE_DIR, FIXTURE_ORDER_DETAIL_QTY2_SG),
  'utf8',
);
const ESCROW_SG_TEXTO = readFileSync(
  nodePath.join(WIRE_DIR, FIXTURE_ESCROW_DETAIL_QTY2_SG),
  'utf8',
);

interface Envelope {
  readonly error: string;
  readonly message: string;
  readonly response: Record<string, unknown>;
}

const DETALHE_SG = JSON.parse(DETALHE_SG_TEXTO) as Envelope;
const ESCROW_SG = JSON.parse(ESCROW_SG_TEXTO) as Envelope;
const LINHA_SG = (DETALHE_SG.response.order_list as Record<string, unknown>[])[0]!;
const ORDER_SN = LINHA_SG.order_sn as string;

/** A BR order with a CLEAR, invented buyer — the `reproduzirPedidoCli.test.ts` shape. */
function linhaBR(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(LINHA_SG),
    region: 'BR',
    currency: 'BRL',
    buyer_cpf_id: CPF_FALSO,
    buyer_username: 'compradora.exemplo',
    buyer_user_id: 734512908,
    message_to_seller: 'Deixar com o porteiro Beltrano Exemplo',
    recipient_address: {
      name: 'Fulana Exemplo da Silva',
      phone: '11988887777',
      town: '',
      district: 'Jardim Exemplo',
      city: 'Cidade Exemplo',
      state: 'SP',
      region: 'BR',
      zipcode: '01001000',
      full_address: 'Rua das Acacias Exemplo, 742, Jardim Exemplo',
    },
    ...patch,
  };
}

function detalheTexto(...linhas: Record<string, unknown>[]): string {
  return JSON.stringify({ error: '', message: '', response: { order_list: linhas } });
}

function erroTexto(codigo: string, mensagem = 'mensagem da Shopee'): string {
  return JSON.stringify({ error: codigo, message: mensagem, request_id: 'req-fixture-1' });
}

/* ------------------------------- the stub -------------------------------- */

interface Corpo {
  readonly texto: string;
  readonly status?: number;
  readonly tipo?: string;
}

interface Gravada {
  readonly metodo: string;
  readonly url: URL;
  readonly corpo: unknown;
}

/** A recording stand-in for the network: answers by PATH, records every request. */
function stubDeShopee(corpos: Readonly<Record<string, Corpo>>): {
  readonly fetch: typeof globalThis.fetch;
  readonly gravadas: Gravada[];
} {
  const gravadas: Gravada[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(urlDaRequisicao(input));
    gravadas.push({ metodo: metodoDaRequisicao(input, init), url, corpo: init?.body });
    const c = corpos[url.pathname];
    if (c === undefined) return Promise.reject(new TypeError('o stub não tem esta rota'));
    return Promise.resolve(
      new Response(c.texto, {
        status: c.status ?? 200,
        headers: { 'Content-Type': c.tipo ?? 'application/json' },
      }),
    );
  };
  return { fetch, gravadas };
}

const PAR_SG: Readonly<Record<string, Corpo>> = {
  [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: DETALHE_SG_TEXTO },
  [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: ESCROW_SG_TEXTO },
};

const GRAVADO: ResultadoDaGravacao = { salvo: true, codigo: null, parcialRestante: null };

/** A Node system error as `node:fs` raises it — the three fields the writer narrows on. */
function erroDeSistema(codigo: string, syscall: string): Error {
  return Object.assign(new Error(`${codigo}: falha simulada, ${syscall}`), {
    code: codigo,
    errno: -1,
    syscall,
  });
}

async function capturar(
  corpos: Readonly<Record<string, Corpo>>,
  orderSn = ORDER_SN,
  resultadoDaGravacao: (papel: PapelDaCaptura) => ResultadoDaGravacao = () => GRAVADO,
) {
  const stub = stubDeShopee(corpos);
  const espelho = criarFetchEspelho(stub.fetch);
  const client = criarClienteDaCaptura(CREDENCIAIS, espelho.fetch, { now: () => NOW_MS });
  const gravados: { readonly papel: PapelDaCaptura; readonly texto: string }[] = [];
  const resultado = await executarCaptura({
    client,
    respostas: espelho.respostas,
    orderSn,
    gravar: (papel, texto) => {
      gravados.push({ papel, texto });
      return resultadoDaGravacao(papel);
    },
  });
  const saida = montarSaidaDaCaptura(resultado, CAMINHOS);
  return { stub, espelho, resultado, gravados, saida, texto: saida.linhas.join('\n') };
}

/** The query of a recorded request, minus the per-call signature parameters. */
function parametrosSemAssinatura(url: URL): [string, string][] {
  return [...url.searchParams]
    .filter(([k]) => !['sign', 'timestamp', 'access_token'].includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/* ========================================================================== */
/*  1 · the parser                                                            */
/* ========================================================================== */

describe('§1 parseArgsCapturarPedido', () => {
  const validos = ['--order-sn', ORDER_SN, '--pasta', '/fora/capturas', '--nome', 'pedido-a'];

  it('os três obrigatórios ⇒ capturar, valores aparados', () => {
    expect(parseArgsCapturarPedido(validos)).toEqual({
      kind: 'capturar',
      args: { orderSn: ORDER_SN, pasta: '/fora/capturas', nome: 'pedido-a' },
    });
    expect(
      parseArgsCapturarPedido([`--order-sn= ${ORDER_SN} `, '--pasta=/fora/capturas', '--nome=x']),
    ).toEqual({
      kind: 'capturar',
      args: { orderSn: ORDER_SN, pasta: '/fora/capturas', nome: 'x' },
    });
  });

  it('--help / -h vencem antes de qualquer validação', () => {
    expect(parseArgsCapturarPedido(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsCapturarPedido(['--order-sn', 'minusculo', '-h'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsCapturarPedido(['--desconhecida', '--help'])).toEqual({ kind: 'ajuda' });
  });

  it('falta um obrigatório ⇒ recusa nomeando a flag', () => {
    expect(() => parseArgsCapturarPedido(validos.slice(2))).toThrow(
      /--order-sn <sn> é obrigatório/,
    );
    expect(() => parseArgsCapturarPedido([...validos.slice(0, 2), ...validos.slice(4)])).toThrow(
      /--pasta <pasta> é obrigatório/,
    );
    expect(() => parseArgsCapturarPedido(validos.slice(0, 4))).toThrow(
      /--nome <rótulo> é obrigatório/,
    );
    expect(() => parseArgsCapturarPedido(['--order-sn'])).toThrow(/--order-sn exige um valor/);
    expect(() => parseArgsCapturarPedido(['--order-sn', '--pasta', '/x'])).toThrow(
      /exige um valor/,
    );
  });

  it('order_sn: maiúsculas e dígitos, 6 a 32 — e as quase-erros recusadas SEM repetir o valor', () => {
    for (const ok of ['ABC123', 'A'.repeat(32), '220810QSK8S7BX']) {
      const c = parseArgsCapturarPedido(['--order-sn', ok, '--pasta', '/p', '--nome', 'n']);
      expect(c.kind, ok).toBe('capturar');
    }
    for (const ruim of [
      '220810qsk8s7bx',
      'ABC12',
      'A'.repeat(33),
      'ABC,123',
      'ABC 123',
      'ABC-123',
      'ÁBC123',
    ]) {
      const f = () => parseArgsCapturarPedido(['--order-sn', ruim, '--pasta', '/p', '--nome', 'n']);
      expect(f, ruim).toThrow(ArgumentoInvalidoError);
      expect(f, ruim).toThrow(/MAIÚSCULAS e dígitos/);
      try {
        f();
      } catch (err) {
        if (!(err instanceof ArgumentoInvalidoError)) throw err;
        expect(err.message, ruim).not.toContain(ruim);
      }
    }
  });

  it('--nome: [a-z0-9-]{1,40}, nunca um caminho', () => {
    for (const ok of ['a', 'pedido-cpf-1', 'x'.repeat(40)]) {
      expect(
        parseArgsCapturarPedido(['--order-sn', ORDER_SN, '--pasta', '/p', '--nome', ok]).kind,
      ).toBe('capturar');
    }
    for (const ruim of ['Pedido', 'a/b', 'a\\b', '..', 'a.b', 'a_b', 'x'.repeat(41), 'ação']) {
      expect(
        () => parseArgsCapturarPedido(['--order-sn', ORDER_SN, '--pasta', '/p', '--nome', ruim]),
        ruim,
      ).toThrow(/--nome tem de ser só letras minúsculas/);
    }
  });

  it('opção desconhecida, duplicada, solta ou o separador -- ⇒ recusa', () => {
    expect(() => parseArgsCapturarPedido([...validos, '--live'])).toThrow(
      /Opção desconhecida: --live/,
    );
    expect(() => parseArgsCapturarPedido([...validos, '--orderSn=X'])).toThrow(
      /Opção desconhecida: --orderSn=…/,
    );
    expect(() => parseArgsCapturarPedido([...validos, '--dry-run'])).toThrow(/Opção desconhecida/);
    expect(() => parseArgsCapturarPedido([...validos, '--nome', 'b'])).toThrow(
      /--nome informado duas vezes/,
    );
    expect(() => parseArgsCapturarPedido(['--', ...validos])).toThrow(/Separador "--"/);
    // A loose value is NOT echoed — it could be a token typed in the wrong place.
    const solto = 'token-colado-no-lugar-errado';
    expect(() => parseArgsCapturarPedido([...validos, solto])).toThrow(/Argumento solto/);
    try {
      parseArgsCapturarPedido([...validos, solto]);
    } catch (err) {
      if (!(err instanceof ArgumentoInvalidoError)) throw err;
      expect(err.message).not.toContain(solto);
    }
  });

  it('a ajuda nomeia as quatro variáveis, os três obrigatórios e não traz o separador --', () => {
    for (const v of Object.values(VARIAVEIS_DA_CAPTURA)) expect(USO_CAPTURAR_PEDIDO).toContain(v);
    for (const f of ['--order-sn', '--pasta', '--nome']) expect(USO_CAPTURAR_PEDIDO).toContain(f);
    expect(USO_CAPTURAR_PEDIDO).not.toMatch(/capturar:pedido --(?!\w)/);
  });
});

/* ========================================================================== */
/*  2 · the credential reader                                                 */
/* ========================================================================== */

function recusa(env: Record<string, string | undefined>): CredencialDaCapturaError {
  try {
    lerCredenciaisDaCaptura(env);
  } catch (err) {
    if (err instanceof CredencialDaCapturaError) return err;
    throw err;
  }
  throw new Error('esperava uma CredencialDaCapturaError');
}

describe('§2 lerCredenciaisDaCaptura', () => {
  it('as quatro, aparadas, viram ids inteiros e dois segredos', () => {
    const env = Object.fromEntries(
      Object.entries(AMBIENTE_VALIDO).map(([k, v]) => [k, `  ${v}\r\n`]),
    );
    expect(lerCredenciaisDaCaptura(env)).toEqual(CREDENCIAIS);
  });

  it('lê SÓ as quatro chaves — nenhuma outra variável do ambiente é tocada', () => {
    const lidas: string[] = [];
    const env = new Proxy(
      { ...AMBIENTE_VALIDO, SHOPEE_PARTNER_ID: '1', SHOPEE_PARTNER_KEY: 'x', HOME: '/h' },
      {
        get(alvo, chave, receptor) {
          lidas.push(String(chave));
          return Reflect.get(alvo, chave, receptor) as unknown;
        },
      },
    );
    lerCredenciaisDaCaptura(env);
    expect([...lidas].sort()).toEqual(Object.values(VARIAVEIS_DA_CAPTURA).sort());
  });

  it('as variáveis do app de STAGING são ignoradas: sozinhas não servem, ao lado das CAP não vencem', () => {
    const soStaging = { SHOPEE_PARTNER_ID: '1000001', SHOPEE_PARTNER_KEY: 'chave-de-staging' };
    expect(recusa(soStaging).variaveis).toEqual([
      'SHOPEE_CAP_PARTNER_ID',
      'SHOPEE_CAP_PARTNER_KEY',
      'SHOPEE_CAP_SHOP_ID',
      'SHOPEE_CAP_ACCESS_TOKEN',
    ]);
    const ambos = { ...AMBIENTE_VALIDO, ...soStaging, SHOPEE_PARTNER_ID: '42' };
    expect(lerCredenciaisDaCaptura(ambos)).toEqual(CREDENCIAIS);
  });

  it('ausente ou em branco ⇒ recusa nomeando CADA variável', () => {
    expect(recusa({}).variaveis).toHaveLength(4);
    const e = recusa({
      ...AMBIENTE_VALIDO,
      SHOPEE_CAP_SHOP_ID: '   ',
      SHOPEE_CAP_ACCESS_TOKEN: '',
    });
    expect(e.variaveis).toEqual(['SHOPEE_CAP_SHOP_ID', 'SHOPEE_CAP_ACCESS_TOKEN']);
    expect(e.message).toMatch(/SHOPEE_CAP_SHOP_ID: não definida, ou vazia/);
  });

  it('id: só dígitos, sem zero à esquerda, inteiro seguro e positivo', () => {
    for (const ruim of [
      '0123',
      '0',
      '12a',
      '1e5',
      '-5',
      '1.0',
      '"123"',
      '12 34',
      '99999999999999999999',
    ]) {
      const e = recusa({ ...AMBIENTE_VALIDO, SHOPEE_CAP_PARTNER_ID: ruim });
      expect(e.variaveis, ruim).toEqual(['SHOPEE_CAP_PARTNER_ID']);
      expect(e.message, ruim).not.toContain(ruim);
    }
    expect(lerCredenciaisDaCaptura({ ...AMBIENTE_VALIDO, SHOPEE_CAP_SHOP_ID: '1' }).shopId).toBe(1);
  });

  it('segredo com espaço no meio ⇒ recusa; a recusa NUNCA repete um valor', () => {
    const chave = 'chave secreta-distinta-77';
    const e = recusa({ ...AMBIENTE_VALIDO, SHOPEE_CAP_PARTNER_KEY: chave });
    expect(e.variaveis).toEqual(['SHOPEE_CAP_PARTNER_KEY']);
    expect(e.message).toMatch(/espaço ou quebra de linha/);
    for (const v of [chave, 'chave', 'distinta', ...Object.values(AMBIENTE_VALIDO)]) {
      expect(e.message).not.toContain(v);
    }
  });
});

/* ========================================================================== */
/*  3 · the path guards                                                       */
/* ========================================================================== */

describe('§3 exigirCaminhosDaCaptura', () => {
  const posix = (
    existentes: string[],
    tipos: Record<string, TipoDoCaminho> = {},
    realpath?: Record<string, string>,
  ) => ({
    existe: (p: string) => existentes.includes(p) || tipos[p] !== undefined,
    tipo: (p: string): TipoDoCaminho => tipos[p] ?? 'ausente',
    caminhos: nodePath.posix,
    ...(realpath === undefined ? {} : { realpath: (p: string) => realpath[p] ?? p }),
  });

  it('pasta fora do checkout, existente ⇒ os dois arquivos dentro dela', () => {
    const fs = posix(['/home/u/next_erp/.git'], { '/home/u/capturas': 'diretorio' });
    expect(exigirCaminhosDaCaptura({ pasta: '/home/u/capturas/', nome: 'pedido-a' }, fs)).toEqual({
      pasta: '/home/u/capturas',
      detalhe: '/home/u/capturas/pedido-a.detalhe.json',
      escrow: '/home/u/capturas/pedido-a.escrow.json',
    });
  });

  it('dentro de um checkout (o .git de um worktree é um ARQUIVO) ⇒ recusa nomeando --pasta', () => {
    const fs = posix(['/home/u/next_erp/.claude/worktrees/w/.git'], {
      '/home/u/next_erp/.claude/worktrees/w/cap': 'diretorio',
    });
    expect(() =>
      exigirCaminhosDaCaptura({ pasta: '/home/u/next_erp/.claude/worktrees/w/cap', nome: 'a' }, fs),
    ).toThrow(/--pasta aponta para dentro de um checkout/);
  });

  it('QUASE-ERRO do prefixo: next_erp-capturas não está dentro de next_erp', () => {
    const fs = posix(['/home/u/next_erp/.git'], { '/home/u/next_erp-capturas': 'diretorio' });
    expect(
      exigirCaminhosDaCaptura({ pasta: '/home/u/next_erp-capturas', nome: 'a' }, fs).pasta,
    ).toBe('/home/u/next_erp-capturas');
  });

  it('uma junção de fora para DENTRO de um checkout ⇒ recusa', () => {
    const fs = posix(
      ['/home/u/next_erp/.git'],
      { '/fora/link': 'diretorio' },
      { '/fora/link': '/home/u/next_erp/cap' },
    );
    expect(() => exigirCaminhosDaCaptura({ pasta: '/fora/link', nome: 'a' }, fs)).toThrow(
      /através de um link ou junção/,
    );
  });

  it('relativa, inexistente ou um arquivo ⇒ recusa antes de qualquer credencial', () => {
    expect(() => exigirCaminhosDaCaptura({ pasta: 'capturas', nome: 'a' }, posix([]))).toThrow(
      /--pasta precisa de um caminho ABSOLUTO/,
    );
    expect(() => exigirCaminhosDaCaptura({ pasta: '/fora/nada', nome: 'a' }, posix([]))).toThrow(
      /--pasta não existe/,
    );
    expect(() =>
      exigirCaminhosDaCaptura(
        { pasta: '/fora/a.txt', nome: 'a' },
        posix([], { '/fora/a.txt': 'outro' }),
      ),
    ).toThrow(/--pasta não é uma pasta/);
  });

  it('um arquivo de saída que já existe ⇒ recusa nomeando o PAPEL (nunca sobrescreve)', () => {
    const fs = posix(['/fora/c/a.detalhe.json'], { '/fora/c': 'diretorio' });
    expect(() => exigirCaminhosDaCaptura({ pasta: '/fora/c', nome: 'a' }, fs)).toThrow(
      /<nome>\.detalhe\.json já existe; esta ferramenta nunca sobrescreve/,
    );
    const fs2 = posix(['/fora/c/a.escrow.json'], { '/fora/c': 'diretorio' });
    expect(() => exigirCaminhosDaCaptura({ pasta: '/fora/c', nome: 'a' }, fs2)).toThrow(
      /<nome>\.escrow\.json já existe/,
    );
  });

  it('um .parcial que sobrou de uma captura interrompida ⇒ recusa ANTES da chamada, nomeando o papel', () => {
    expect(caminhoParcial('/fora/c/a.detalhe.json')).toBe(
      `/fora/c/a.detalhe.json${SUFIXO_PARCIAL}`,
    );
    for (const [arquivo, papel] of [
      ['/fora/c/a.detalhe.json.parcial', /<nome>\.detalhe\.json\.parcial sobrou/],
      ['/fora/c/a.escrow.json.parcial', /<nome>\.escrow\.json\.parcial sobrou/],
    ] as const) {
      const fs = posix([arquivo], { '/fora/c': 'diretorio' });
      expect(() => exigirCaminhosDaCaptura({ pasta: '/fora/c', nome: 'a' }, fs), arquivo).toThrow(
        papel,
      );
    }
    // QUASE-ERRO: another label's partial does not block this one.
    const fs = posix(['/fora/c/b.detalhe.json.parcial'], { '/fora/c': 'diretorio' });
    expect(exigirCaminhosDaCaptura({ pasta: '/fora/c', nome: 'a' }, fs).detalhe).toBe(
      '/fora/c/a.detalhe.json',
    );
  });

  it('Windows: caixa da letra do drive não escapa do checkout', () => {
    const conjunto = new Set(['c:\\users\\x\\next_erp\\.git']);
    const fs = {
      existe: (p: string) => conjunto.has(p.toLowerCase()),
      tipo: (): TipoDoCaminho => 'diretorio',
      caminhos: nodePath.win32,
    };
    expect(() =>
      exigirCaminhosDaCaptura({ pasta: 'c:\\Users\\X\\next_erp\\cap', nome: 'a' }, fs),
    ).toThrow(ArquivoRecusadoError);
    expect(
      exigirCaminhosDaCaptura({ pasta: 'C:\\Users\\x\\shopee-capturas', nome: 'a' }, fs).detalhe,
    ).toBe('C:\\Users\\x\\shopee-capturas\\a.detalhe.json');
  });
});

/* ========================================================================== */
/*  4 · the network guard                                                     */
/* ========================================================================== */

describe('§4 a guarda de rede', () => {
  it('os hosts são os de PRODUÇÃO, exatamente como resolveShopeeHosts os monta', () => {
    expect(HOSTS_DA_CAPTURA.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(HOSTS_DA_CAPTURA.authHost).toBe(SHOPEE_PROD_AUTH_HOST);
    expect(HOST_DA_CAPTURA).toBe('openplatform.shopee.com.br');
    expect(CAMINHOS_DA_CAPTURA).toEqual([
      SHOPEE_GET_ORDER_DETAIL_PATH,
      SHOPEE_GET_ESCROW_DETAIL_PATH,
    ]);
  });

  it('hostPermitidoNaCaptura: só https, o host EXATO, porta padrão, sem userinfo', () => {
    expect(hostPermitidoNaCaptura(`${SHOPEE_PROD_API_HOST}/api/v2/x?a=1`)).toBe(true);
    expect(hostPermitidoNaCaptura('https://openplatform.shopee.com.br:443/api')).toBe(true);
    for (const ruim of [
      `${SHOPEE_SANDBOX_API_HOST}/api/v2/order/get_order_detail`,
      'http://openplatform.shopee.com.br/api/v2/order/get_order_detail',
      'https://openplatform.shopee.com.br:8443/api',
      'https://openplatform.shopee.com.br.evil.example/api',
      'https://evil-openplatform.shopee.com.br/api',
      'https://open.shopee.com.br/api',
      'https://openplatform.shopee.com/api',
      'https://openplatform.shopee.com.br./api',
      'https://u:p@openplatform.shopee.com.br/api',
      'https://openplatform.shopee.com.br@evil.example/api',
      'nao é url',
    ]) {
      expect(hostPermitidoNaCaptura(ruim), ruim).toBe(false);
    }
  });

  it('requisicaoPermitidaNaCaptura: GET nos DOIS caminhos do importador, e mais nada — nem o token', () => {
    const base = SHOPEE_PROD_API_HOST;
    expect(requisicaoPermitidaNaCaptura(`${base}${SHOPEE_GET_ORDER_DETAIL_PATH}?x=1`, 'GET')).toBe(
      true,
    );
    expect(requisicaoPermitidaNaCaptura(`${base}${SHOPEE_GET_ESCROW_DETAIL_PATH}`, 'GET')).toBe(
      true,
    );
    for (const [url, metodo] of [
      [`${base}${SHOPEE_GET_ORDER_DETAIL_PATH}`, 'POST'],
      [`${base}/api/v2/auth/access_token/get`, 'POST'],
      [`${base}/api/v2/auth/access_token/get`, 'GET'],
      [`${base}/api/v2/auth/token/get`, 'POST'],
      [`${base}/api/v2/order/get_order_list`, 'GET'],
      [`${base}${SHOPEE_GET_ORDER_DETAIL_PATH}/`, 'GET'],
      [`${SHOPEE_SANDBOX_API_HOST}${SHOPEE_GET_ORDER_DETAIL_PATH}`, 'GET'],
    ] as const) {
      expect(requisicaoPermitidaNaCaptura(url, metodo), `${metodo} ${url}`).toBe(false);
    }
  });

  it('o alvo de uma recusa: método + host (+ o caminho só no host da Shopee), NUNCA a query', () => {
    expect(
      alvoParaRelatorio(
        `${SHOPEE_PROD_API_HOST}/api/v2/auth/access_token/get?sign=abc&access_token=t`,
        'POST',
      ),
    ).toBe('POST openplatform.shopee.com.br/api/v2/auth/access_token/get');
    expect(alvoParaRelatorio('https://evil.example/segredo?access_token=t', 'GET')).toBe(
      'GET evil.example',
    );
    expect(alvoParaRelatorio('lixo', 'GET')).toBe('GET (url ilegível)');
    expect(metodoDaRequisicao('https://x', { method: 'post' })).toBe('POST');
    expect(metodoDaRequisicao(new Request('https://x', { method: 'PUT' }))).toBe('PUT');
    expect(metodoDaRequisicao('https://x')).toBe('GET');
  });

  describe('criarFetchGuardado — a guarda que o script instala', () => {
    const detalheUrl = `${SHOPEE_PROD_API_HOST}${SHOPEE_GET_ORDER_DETAIL_PATH}?sign=s&access_token=t`;

    function gravador(resposta: () => Response = () => new Response('{}')) {
      const inits: (RequestInit | undefined)[] = [];
      const fetch: typeof globalThis.fetch = (_input, init) => {
        inits.push(init);
        return Promise.resolve(resposta());
      };
      return { fetch, inits };
    }

    it('a permitida sai com redirect: "error" — o resto do init intacto', async () => {
      const g = gravador();
      const guardado = criarFetchGuardado(g.fetch);
      const res = await guardado(detalheUrl, { method: 'GET', headers: { Accept: 'x' } });
      expect(res.status).toBe(200);
      expect(g.inits).toEqual([{ method: 'GET', headers: { Accept: 'x' }, redirect: 'error' }]);
      // No init at all still goes out with the mode.
      await guardado(`${SHOPEE_PROD_API_HOST}${SHOPEE_GET_ESCROW_DETAIL_PATH}?order_sn=X`);
      expect(g.inits[1]).toEqual({ redirect: 'error' });
      // A caller that asked to FOLLOW is overridden.
      await guardado(detalheUrl, { redirect: 'follow' });
      expect(g.inits[2]?.redirect).toBe('error');
    });

    it('a recusada nunca chega ao fetch de baixo — e a recusa não traz a query', async () => {
      const g = gravador();
      const guardado = criarFetchGuardado(g.fetch);
      for (const [url, metodo] of [
        [`${SHOPEE_PROD_API_HOST}/api/v2/auth/access_token/get?sign=s&access_token=t`, 'POST'],
        [`${SHOPEE_SANDBOX_API_HOST}${SHOPEE_GET_ORDER_DETAIL_PATH}?access_token=t`, 'GET'],
        [`https://evil.example${SHOPEE_GET_ORDER_DETAIL_PATH}?access_token=t`, 'GET'],
        [detalheUrl, 'POST'],
      ] as const) {
        const err: unknown = await guardado(url, { method: metodo }).catch((e: unknown) => e);
        expect(err, url).toBeInstanceOf(RequisicaoBloqueadaNaCapturaError);
        // The token endpoint's PATH spells `access_token`; the QUERY must never appear.
        expect(String((err as Error).message), url).not.toMatch(/[?&=]/);
      }
      expect(g.inits).toEqual([]);
    });

    it('uma resposta que diz redirected é RECUSADA, mesmo se o fetch de baixo ignorou o modo', async () => {
      const redirecionada = () =>
        Object.defineProperty(new Response('{"error":""}'), 'redirected', { value: true });
      const guardado = criarFetchGuardado(gravador(redirecionada).fetch);
      await expect(guardado(detalheUrl)).rejects.toThrow(/redirecionada — recusada/);
      // QUASE-ERRO: an ordinary response passes.
      await expect(criarFetchGuardado(gravador().fetch)(detalheUrl)).resolves.toBeInstanceOf(
        Response,
      );
    });

    it('pelo cliente de verdade: um 3xx rejeitado vira ShopeeNetworkError, NADA é salvo', async () => {
      // `redirect: 'error'` makes the real fetch REJECT on a 3xx; the stub does the same.
      const guardado = criarFetchGuardado((_input, init) =>
        init?.redirect === 'error'
          ? Promise.reject(new TypeError('fetch failed: unexpected redirect'))
          : Promise.resolve(new Response(DETALHE_SG_TEXTO)),
      );
      const espelho = criarFetchEspelho(guardado);
      const gravados: string[] = [];
      const r = await executarCaptura({
        client: criarClienteDaCaptura(CREDENCIAIS, espelho.fetch, { now: () => NOW_MS }),
        respostas: espelho.respostas,
        orderSn: ORDER_SN,
        gravar: (papel) => {
          gravados.push(papel);
          return GRAVADO;
        },
      });
      expect(r.detalhe.erro).toBeInstanceOf(ShopeeNetworkError);
      expect(r.detalhe.resposta).toBeNull();
      expect(gravados).toEqual([]);
      expect(montarSaidaDaCaptura(r, CAMINHOS).codigo).toBe(1);
    });
  });
});

/* ========================================================================== */
/*  5 · the tee                                                               */
/* ========================================================================== */

describe('§5 criarFetchEspelho', () => {
  it('devolve a MESMA resposta e guarda os MESMOS bytes — e o cliente de verdade ainda faz o parse', async () => {
    const stub = stubDeShopee(PAR_SG);
    const espelho = criarFetchEspelho(stub.fetch);
    const client = criarClienteDaCaptura(CREDENCIAIS, espelho.fetch, { now: () => NOW_MS });

    const detalhe = await client.getOrderDetail({
      orderSnList: [ORDER_SN],
      requestOrderStatusPending: true,
    });
    const escrow = await client.getEscrowDetail({ orderSn: ORDER_SN });

    expect(detalhe.order_list.map((l) => l.order_sn)).toEqual([ORDER_SN]);
    expect(escrow.order_sn).toBe(ORDER_SN);
    expect(espelho.respostas).toEqual([
      { path: SHOPEE_GET_ORDER_DETAIL_PATH, status: 200, texto: DETALHE_SG_TEXTO },
      { path: SHOPEE_GET_ESCROW_DETAIL_PATH, status: 200, texto: ESCROW_SG_TEXTO },
    ]);
  });

  it('um status que não é 2xx também é guardado — o status e o texto como vieram', async () => {
    const html = '<html>gateway</html>';
    const stub = stubDeShopee({ '/x': { texto: html, status: 403, tipo: 'text/html' } });
    const espelho = criarFetchEspelho(stub.fetch);
    const res = await espelho.fetch(`${SHOPEE_PROD_API_HOST}/x?sign=s`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(html);
    expect(espelho.respostas).toEqual([{ path: '/x', status: 403, texto: html }]);
  });

  it('sem resposta (rede) ⇒ nada guardado, e a rejeição segue igual', async () => {
    const espelho = criarFetchEspelho(() => Promise.reject(new TypeError('sem rede')));
    await expect(espelho.fetch(`${SHOPEE_PROD_API_HOST}/x`)).rejects.toThrow('sem rede');
    expect(espelho.respostas).toEqual([]);
  });
});

/* ========================================================================== */
/*  6 · THE FIDELITY PIN                                                      */
/* ========================================================================== */

describe('§6 a captura pede EXATAMENTE o que o importador pede', () => {
  beforeEach(() => __resetAllReadCaches());
  afterEach(() => __resetAllReadCaches());

  it('get_order_detail: order_sn_list, request_order_status_pending=true e a lista PADRÃO do pacote', async () => {
    const { stub } = await capturar(PAR_SG);
    expect(stub.gravadas).toHaveLength(2);
    const [detalhe, escrow] = stub.gravadas;

    expect(detalhe!.metodo).toBe('GET');
    expect(detalhe!.url.origin).toBe(SHOPEE_PROD_API_HOST);
    expect(detalhe!.url.pathname).toBe(SHOPEE_GET_ORDER_DETAIL_PATH);
    expect(detalhe!.url.searchParams.get('order_sn_list')).toBe(ORDER_SN);
    expect(detalhe!.url.searchParams.get('request_order_status_pending')).toBe('true');
    expect(detalhe!.url.searchParams.get('response_optional_fields')).toBe(
      SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
    );

    expect(escrow!.metodo).toBe('GET');
    expect(escrow!.corpo).toBeUndefined();
    expect(escrow!.url.origin).toBe(SHOPEE_PROD_API_HOST);
    expect(escrow!.url.pathname).toBe(SHOPEE_GET_ESCROW_DETAIL_PATH);
    expect(escrow!.url.searchParams.get('order_sn')).toBe(ORDER_SN);
  });

  it('o MESMO conjunto de parâmetros que prepararImportacaoPedidoShopee manda — nas duas chamadas', async () => {
    const captura = (await capturar(PAR_SG)).stub.gravadas;

    const doImportador = stubDeShopee(PAR_SG);
    const db = new FakeDb();
    for (const [caminho, dados] of linhasDeSemente()) db.seed(caminho, { ...dados });
    const preparo = await prepararImportacaoPedidoShopee(
      asDb(db),
      {
        integracaoId: INTEGRACAO_DA_REPRODUCAO,
        shopId: LOJA_DA_REPRODUCAO,
        orderSn: ORDER_SN,
        nowMs: NOW_MS,
      },
      {
        // The importer's ONE client seam, with the package's real client —
        // a different key, token and clock, so only the signature params differ.
        clientFor: () =>
          Promise.resolve(
            createShopeeClient({
              partnerId: PARCEIRO_DA_REPRODUCAO,
              partnerKey: 'outra-chave-do-importador',
              hosts: HOSTS_DA_CAPTURA,
              shopId: LOJA_DA_REPRODUCAO,
              getAccessToken: () => Promise.resolve('outro-token-do-importador'),
              fetch: doImportador.fetch,
              now: () => NOW_MS + 60_000,
            }),
          ),
      },
    );
    expect(preparo.kind).toBe('preparo');

    const importador = doImportador.gravadas;
    expect(importador.map((g) => `${g.metodo} ${g.url.pathname}`)).toEqual([
      `GET ${SHOPEE_GET_ORDER_DETAIL_PATH}`,
      `GET ${SHOPEE_GET_ESCROW_DETAIL_PATH}`,
    ]);
    expect(captura.map((g) => `${g.metodo} ${g.url.pathname}`)).toEqual(
      importador.map((g) => `${g.metodo} ${g.url.pathname}`),
    );
    for (const i of [0, 1]) {
      expect(parametrosSemAssinatura(captura[i]!.url)).toEqual(
        parametrosSemAssinatura(importador[i]!.url),
      );
      expect(captura[i]!.corpo).toEqual(importador[i]!.corpo);
    }
    // ÂNCORA: the comparison is not vacuous — the detail call carries its
    // three operation parameters, and the signature params really were dropped.
    expect(parametrosSemAssinatura(captura[0]!.url).map(([k]) => k)).toEqual([
      'order_sn_list',
      'partner_id',
      'request_order_status_pending',
      'response_optional_fields',
      'shop_id',
    ]);
    expect(captura[0]!.url.searchParams.get('sign')).not.toBe(
      importador[0]!.url.searchParams.get('sign'),
    );
  });
});

/* ========================================================================== */
/*  7 · the capture's outcomes                                                */
/* ========================================================================== */

describe('§7 executarCaptura', () => {
  it('o par: os dois corpos CRUS gravados, byte a byte, o detalhe ANTES de pedir o escrow', async () => {
    const ordem: string[] = [];
    const stub = stubDeShopee(PAR_SG);
    const espelho = criarFetchEspelho((input, init) => {
      ordem.push(`fetch ${new URL(urlDaRequisicao(input)).pathname}`);
      return stub.fetch(input, init);
    });
    const r = await executarCaptura({
      client: criarClienteDaCaptura(CREDENCIAIS, espelho.fetch, { now: () => NOW_MS }),
      respostas: espelho.respostas,
      orderSn: ORDER_SN,
      gravar: (papel) => {
        ordem.push(`gravar ${papel}`);
        return GRAVADO;
      },
    });
    expect(ordem).toEqual([
      `fetch ${SHOPEE_GET_ORDER_DETAIL_PATH}`,
      'gravar detalhe',
      `fetch ${SHOPEE_GET_ESCROW_DETAIL_PATH}`,
      'gravar escrow',
    ]);
    expect(r.detalhe.salva).toBe(true);
    expect(r.escrow?.salva).toBe(true);

    const { gravados, saida } = await capturar(PAR_SG);
    expect(gravados).toEqual([
      { papel: 'detalhe', texto: DETALHE_SG_TEXTO },
      { papel: 'escrow', texto: ESCROW_SG_TEXTO },
    ]);
    expect(saida.codigo).toBe(0);
    expect(saida.linhas).toContain(
      `  pnpm --filter @delfrance/shopee-app reproduzir:pedido --detalhe ${CAMINHOS.detalhe} --escrow ${CAMINHOS.escrow}`,
    );
  });

  it('o escrow responde um envelope de ERRO (order não paga) ⇒ salvo como veio, reportado, código 0', async () => {
    const erro = erroTexto('order.order_not_paid', 'This order is unpaid.');
    const { gravados, saida, resultado, texto } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: DETALHE_SG_TEXTO },
      [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: erro },
    });
    expect(gravados.map((g) => g.papel)).toEqual(['detalhe', 'escrow']);
    expect(gravados[1]!.texto).toBe(erro);
    expect(resultado.escrow?.erro).toBeInstanceOf(ShopeeApiError);
    expect(saida.codigo).toBe(0);
    expect(texto).toContain('error (envelope) ....... order.order_not_paid');
    expect(texto).toContain(`--escrow ${CAMINHOS.escrow}`);
    expect(texto).not.toContain('This order is unpaid');
  });

  it('o escrow responde HTML da borda ⇒ NÃO salvo (o replay o recusaria), detalhe salvo, comando sem --escrow', async () => {
    const { gravados, saida, texto } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: DETALHE_SG_TEXTO },
      [SHOPEE_GET_ESCROW_DETAIL_PATH]: {
        texto: '<html>502</html>',
        status: 502,
        tipo: 'text/html',
      },
    });
    expect(gravados.map((g) => g.papel)).toEqual(['detalhe']);
    expect(saida.codigo).toBe(0);
    expect(texto).toContain(
      `reproduzir:pedido --detalhe ${CAMINHOS.detalhe}\n  (sem --escrow: o escrow não foi salvo`,
    );
  });

  it('o detalhe não bate com o schema ⇒ o corpo CRU é salvo (o replay mostra os campos) e o escrow é pedido', async () => {
    const texto0 = detalheTexto(linhaBR({ order_status: 7 }));
    const { gravados, resultado, saida, texto } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: texto0 },
      [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: ESCROW_SG_TEXTO },
    });
    expect(resultado.detalhe.erro).toBeInstanceOf(ShopeeSchemaError);
    expect(gravados).toEqual([
      { papel: 'detalhe', texto: texto0 },
      { papel: 'escrow', texto: ESCROW_SG_TEXTO },
    ]);
    expect(saida.codigo).toBe(0);
    expect(texto).toContain('order_status ........... (formato inesperado)');
    expect(texto).toMatch(/campos: .*order_status/);
  });

  const PARADAS: readonly [string, string, RegExp][] = [
    ['error_auth', erroTexto('error_auth', 'Invalid access_token.'), /PARE.*token de acesso/],
    ['common.error_auth', erroTexto('common.error_auth'), /PARE.*token de acesso/],
    ['invalid_acceess_token', erroTexto('invalid_acceess_token'), /PARE.*token de acesso/],
    ['error_sign', erroTexto('error_sign', 'Wrong sign.'), /PARE.*assinatura.*relógio/],
    ['source_ip_undeclared', erroTexto('source_ip_undeclared'), /PARE.*restringe IPs/],
    ['error_permission', erroTexto('error_permission'), /PARE.*restringe IPs/],
    ['shop_access_expired', erroTexto('shop_access_expired'), /PARE: ShopeeReauthRequiredError/],
    ['error_rate_limit', erroTexto('error_rate_limit'), /ShopeeRateLimitError \(burst\).*/],
    ['error_limit', erroTexto('error_limit'), /ShopeeRateLimitError \(daily\)/],
  ];

  it.each(PARADAS)(
    'o detalhe responde %s ⇒ PARA: nada salvo, nada mais chamado, código 1',
    async (_codigo, corpo, mensagem) => {
      const { gravados, stub, saida, texto, resultado } = await capturar({
        [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: corpo },
        [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: ESCROW_SG_TEXTO },
      });
      expect(gravados).toEqual([]);
      expect(stub.gravadas).toHaveLength(1);
      expect(resultado.escrow).toBeNull();
      expect(saida.codigo).toBe(1);
      expect(texto).toMatch(mensagem);
      expect(texto).toContain('nada foi salvo para a reprodução');
      expect(texto).not.toContain('mensagem da Shopee');
    },
  );

  it('QUASE-ERRO: error_param, order_not_found e um código parecido NÃO dizem PARE — mas também não salvam', async () => {
    for (const codigo of ['error_param', 'order_not_found', 'error_authx', 'x.y.error_auth']) {
      const { gravados, stub, saida, texto } = await capturar({
        [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: erroTexto(codigo) },
      });
      expect(gravados, codigo).toEqual([]);
      expect(stub.gravadas, codigo).toHaveLength(1);
      expect(saida.codigo, codigo).toBe(1);
      expect(texto, codigo).not.toContain('PARE');
      expect(texto, codigo).toContain(`code=${codigo}`);
    }
  });

  it('a borda responde HTML 403 (lista de IPs) ⇒ PARE, e a linha do pacote com o corpo é SUPRIMIDA', async () => {
    const espiao = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const html = '<html>forbidden token-que-a-borda-ecoou</html>';
      const { gravados, saida, texto, resultado } = await capturar({
        [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: html, status: 403, tipo: 'text/html' },
      });
      expect(resultado.detalhe.erro).toBeInstanceOf(ShopeeHttpError);
      expect(gravados).toEqual([]);
      expect(saida.codigo).toBe(1);
      expect(texto).toMatch(/PARE: ShopeeHttpError httpStatus=403/);
      expect(texto).toContain('error (envelope) ....... (corpo não é JSON)');
      expect(resultado.linhasDeLogSuprimidas).toBeGreaterThan(0);
      expect(texto).toMatch(/linhas de log do pacote suprimidas: \d+/);
      expect(texto).not.toContain('token-que-a-borda-ecoou');
      // The package's console line never reached the real console, which is restored.
      expect(espiao).not.toHaveBeenCalled();
      expect(console.error).toBe(espiao);
    } finally {
      espiao.mockRestore();
    }
  });

  it('a lista volta SEM a order pedida (outra loja, sn errado) ⇒ nada salvo, escrow não pedido', async () => {
    const { gravados, stub, saida, texto } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: detalheTexto() },
    });
    expect(gravados).toEqual([]);
    expect(stub.gravadas).toHaveLength(1);
    expect(saida.codigo).toBe(1);
    expect(texto).toContain('linhas em order_list ... 0');
    expect(texto).toContain('NÃO veio — confira o order_sn e a loja');
  });

  it('falha de rede no detalhe ⇒ nenhuma resposta, nada salvo, código 1', async () => {
    const { gravados, saida, texto, resultado } = await capturar({});
    expect(resultado.detalhe.resposta).toBeNull();
    expect(resultado.detalhe.erro).toBeInstanceOf(ShopeeNetworkError);
    expect(gravados).toEqual([]);
    expect(saida.codigo).toBe(1);
    expect(texto).toContain('resposta ............... nenhuma');
  });

  it('a gravação do DETALHE falha (disco cheio) ⇒ código 1, escrow NÃO pedido, o relatório diz o código', async () => {
    const falhou: ResultadoDaGravacao = { salvo: false, codigo: 'ENOSPC', parcialRestante: null };
    const { gravados, stub, saida, texto, resultado } = await capturar(
      PAR_SG,
      ORDER_SN,
      () => falhou,
    );
    expect(gravados.map((g) => g.papel)).toEqual(['detalhe']);
    expect(stub.gravadas).toHaveLength(1);
    expect(resultado.detalhe.salva).toBe(false);
    expect(resultado.escrow).toBeNull();
    expect(saida.codigo).toBe(1);
    expect(texto).toContain('NÃO salvo — a gravação falhou (ENOSPC); nada ficou com o nome final');
    expect(texto).toContain('o mesmo --nome serve');
    expect(texto).not.toContain('reproduzir:pedido');
  });

  it('a gravação do detalhe esbarra num arquivo que APARECEU (EEXIST) ⇒ outro --nome, nunca o mesmo', async () => {
    const falhou: ResultadoDaGravacao = { salvo: false, codigo: 'EEXIST', parcialRestante: null };
    const { saida, texto } = await capturar(PAR_SG, ORDER_SN, () => falhou);
    expect(saida.codigo).toBe(1);
    expect(texto).toContain('use OUTRO --nome');
    expect(texto).not.toContain('o mesmo --nome serve');
  });

  it('a gravação do ESCROW falha ⇒ o detalhe salvo vale: código 0, comando SEM --escrow', async () => {
    const { saida, texto, resultado } = await capturar(PAR_SG, ORDER_SN, (papel) =>
      papel === 'escrow' ? { salvo: false, codigo: 'EIO', parcialRestante: null } : GRAVADO,
    );
    expect(resultado.detalhe.salva).toBe(true);
    expect(resultado.escrow?.salva).toBe(false);
    expect(saida.codigo).toBe(0);
    expect(texto).toContain('NÃO salvo — a gravação falhou (EIO)');
    expect(texto).toContain(`reproduzir:pedido --detalhe ${CAMINHOS.detalhe}\n  (sem --escrow`);
  });

  it('um .parcial que não pôde ser apagado ⇒ o relatório o NOMEIA e manda apagar', async () => {
    const parcial = `${CAMINHOS.detalhe}${SUFIXO_PARCIAL}`;
    const { saida, texto } = await capturar(PAR_SG, ORDER_SN, () => ({
      salvo: false,
      codigo: 'ENOSPC',
      parcialRestante: parcial,
    }));
    expect(saida.codigo).toBe(1);
    expect(texto).toContain(
      `sobrou o arquivo parcial ${parcial} — tem dados do comprador: apague-o.`,
    );
    // Not "same --nome": the pre-check would refuse it until the partial is gone.
    expect(texto).not.toContain('o mesmo --nome serve');
  });

  it('um escritor que LANÇA (um bug, não um erro de sistema reportado) sobe como veio — nada é engolido', async () => {
    const espelho = criarFetchEspelho(stubDeShopee(PAR_SG).fetch);
    const falha = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
    await expect(
      executarCaptura({
        client: criarClienteDaCaptura(CREDENCIAIS, espelho.fetch, { now: () => NOW_MS }),
        respostas: espelho.respostas,
        orderSn: ORDER_SN,
        gravar: () => {
          throw falha;
        },
      }),
    ).rejects.toBe(falha);
    expect(espelho.respostas.map((r) => r.path)).toEqual([SHOPEE_GET_ORDER_DETAIL_PATH]);
  });

  it('resumoDoDetalhe e codigoDoEnvelope: contagens, tokens e booleanos — nunca um valor', () => {
    const r = resumoDoDetalhe(detalheTexto(linhaBR({ item_list: undefined })), ORDER_SN);
    expect(r).toEqual({
      linhas: 1,
      linhaDaOrder: true,
      linha: {
        regiao: 'BR',
        orderStatus: LINHA_SG.order_status as string,
        recipientAddress: true,
        buyerCpfId: true,
        itemList: false,
      },
    });
    expect(resumoDoDetalhe('não json', ORDER_SN)).toEqual({
      linhas: null,
      linhaDaOrder: false,
      linha: null,
    });
    expect(codigoDoEnvelope(DETALHE_SG_TEXTO)).toBe('(vazio)');
    expect(codigoDoEnvelope(erroTexto('product.error_param'))).toBe('product.error_param');
    expect(codigoDoEnvelope(erroTexto('código com espaço'))).toBe('(formato inesperado)');
    expect(codigoDoEnvelope('<html/>')).toBe('(corpo não é JSON)');
    expect(codigoDoEnvelope('{"outra":1}')).toBe('(não é um envelope da Shopee)');
  });
});

/* ========================================================================== */
/*  7b · THE ROUND TRIP: what the capture saves, the replay can serve         */
/* ========================================================================== */

describe('§7b o que a captura salva e o comando que ela imprime, a reprodução RODA', () => {
  beforeEach(() => __resetAllReadCaches());
  afterEach(() => __resetAllReadCaches());

  const escrowRate = erroTexto('error_rate_limit');

  /** The SG escrow fixture with its `response` patched — the replay's own pre-checks decide. */
  function escrowComResposta(patch: Record<string, unknown> | null): string {
    const envelope = JSON.parse(ESCROW_SG_TEXTO) as Record<string, unknown>;
    const resposta = envelope.response as Record<string, unknown>;
    return JSON.stringify({
      ...envelope,
      response: patch === null ? null : { ...resposta, ...patch },
    });
  }
  /** `{"error":"","response":null}` — the replay refuses it before the importer runs. */
  const escrowRespostaNula = escrowComResposta(null);
  /** A `response` for ANOTHER order — the replay refuses the pair. */
  const escrowOutraOrder = escrowComResposta({ order_sn: 'OUTRAORDER01' });
  /** A `response` with NO `order_sn` at all — the replay cannot pair it, and refuses. */
  const escrowSemOrderSn = JSON.stringify({
    error: '',
    message: '',
    response: { order_income: {} },
  });
  /**
   * QUASE-ERRO: the SAME order, a field the wire schema refuses — the replay
   * SERVES it, the client throws `ShopeeSchemaError` and the importer contains
   * it (detail prices), exactly as live. It must be saved.
   */
  const escrowSchemaInvalidoMesmaOrder = escrowComResposta({ order_income: 'não é um objeto' });

  /** Each escrow outcome, and whether the capture must save it. */
  const SAIDAS_DO_ESCROW: readonly [string, Corpo, boolean][] = [
    ['response null com error vazio (a reprodução recusa)', { texto: escrowRespostaNula }, false],
    ['response de OUTRA order (a reprodução recusa o par)', { texto: escrowOutraOrder }, false],
    ['response sem order_sn (a reprodução recusa o par)', { texto: escrowSemOrderSn }, false],
    ['schema inválido na MESMA order (contido)', { texto: escrowSchemaInvalidoMesmaOrder }, true],
    ['sucesso', { texto: ESCROW_SG_TEXTO }, true],
    ['order.order_not_paid', { texto: erroTexto('order.order_not_paid') }, true],
    ['error_server (transitório, contido)', { texto: erroTexto('error_server') }, true],
    ['error_permission (contido)', { texto: erroTexto('error_permission') }, true],
    ['error_rate_limit (burst)', { texto: escrowRate }, false],
    ['error_rate_limit em HTTP 429', { texto: escrowRate, status: 429 }, false],
    ['error_limit (diário)', { texto: erroTexto('error_limit') }, false],
    ['shop_access_expired', { texto: erroTexto('shop_access_expired') }, false],
    ['refresh_token_expired', { texto: erroTexto('refresh_token_expired') }, false],
    ['HTML 502 da borda', { texto: '<html>502</html>', status: 502, tipo: 'text/html' }, false],
  ];

  it.each(SAIDAS_DO_ESCROW)(
    'escrow %s ⇒ salvo só se reproduzível, e o comando impresso RESOLVE',
    async (_nome, escrow, salvo) => {
      const detalhe = detalheTexto(linhaBR());
      const { gravados, saida, resultado } = await capturar({
        [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: detalhe },
        [SHOPEE_GET_ESCROW_DETAIL_PATH]: escrow,
      });
      expect(saida.codigo).toBe(0);
      expect(resultado.escrow?.salva).toBe(salvo);
      expect(gravados.map((g) => g.papel)).toEqual(salvo ? ['detalhe', 'escrow'] : ['detalhe']);

      // The printed next step is the contract: run EXACTLY what it says.
      const comando = saida.linhas.find((l) => l.includes('reproduzir:pedido'));
      expect(comando).toBeDefined();
      const comEscrow = comando!.includes('--escrow');
      expect(comEscrow).toBe(salvo);
      const escrowGravado = gravados.find((g) => g.papel === 'escrow')?.texto ?? null;

      const r = await reproduzirPedidoShopee(asDb(novoDbDaReproducao()), {
        detalheTexto: gravados[0]!.texto,
        escrowTexto: comEscrow ? escrowGravado : null,
        orderSn: null,
        nowMs: NOW_MS,
        viaCep: { buscarCep: () => Promise.resolve(null) },
      });
      expect(r.primeira.acao).toBe('criado');
      expect(r.escrowCapturado).toBe(
        !salvo
          ? 'ausente'
          : (JSON.parse(escrow.texto) as { response?: unknown }).response == null
            ? 'erro'
            : 'resposta',
      );
    },
  );

  it('ÂNCORA: o escrow que a captura recusa salvar FARIA a reprodução falhar (a regra não é vazia)', async () => {
    for (const texto of [escrowRate, erroTexto('error_limit'), erroTexto('shop_access_expired')]) {
      const err: unknown = await reproduzirPedidoShopee(asDb(novoDbDaReproducao()), {
        detalheTexto: detalheTexto(linhaBR()),
        escrowTexto: texto,
        orderSn: null,
        nowMs: NOW_MS,
        viaCep: { buscarCep: () => Promise.resolve(null) },
      }).catch((e: unknown) => e);
      expect(falhaDeEscrowNaoContida(err), texto).toBe(true);
    }
  });

  it('escrowReproduzivel lê a lista do IMPORTADOR — e não o código do envelope sozinho', () => {
    const resposta = { path: SHOPEE_GET_ESCROW_DETAIL_PATH, status: 200, texto: escrowRate };
    const limite = new ShopeeRateLimitError('x', {
      code: 'error_rate_limit',
      kind: 'burst',
      httpStatus: 200,
      path: SHOPEE_GET_ESCROW_DETAIL_PATH,
    });
    const comum = new ShopeeApiError('x', {
      code: 'error_rate_limit',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_GET_ESCROW_DETAIL_PATH,
    });
    expect(escrowReproduzivel({ resposta, erro: limite }, ORDER_SN)).toBe(false);
    // QUASE-ERRO: the same envelope text, classified as a plain failure, IS contained.
    expect(escrowReproduzivel({ resposta, erro: comum }, ORDER_SN)).toBe(true);
    expect(escrowReproduzivel({ resposta, erro: null }, ORDER_SN)).toBe(true);
    expect(escrowReproduzivel({ resposta: null, erro: null }, ORDER_SN)).toBe(false);
  });

  it('escrowReproduzivel lê também as pré-checagens da REPRODUÇÃO — a mesma função, não uma cópia', async () => {
    const com = (texto: string) => ({
      resposta: { path: SHOPEE_GET_ESCROW_DETAIL_PATH, status: 200, texto },
      erro: null,
    });
    expect(escrowReproduzivel(com(escrowRespostaNula), ORDER_SN)).toBe(false);
    expect(escrowReproduzivel(com(escrowOutraOrder), ORDER_SN)).toBe(false);
    expect(escrowReproduzivel(com(escrowSemOrderSn), ORDER_SN)).toBe(false);
    // QUASE-ERRO: the very same body, asked for the order it DOES carry.
    expect(escrowReproduzivel(com(escrowOutraOrder), 'OUTRAORDER01')).toBe(true);
    expect(escrowReproduzivel(com(ESCROW_SG_TEXTO), ORDER_SN)).toBe(true);

    // ÂNCORA: each body the capture refuses is one the replay itself refuses —
    // and each it accepts, the replay serves (`CapturaInvalidaError` is the
    // replay's pre-check class; anything else would be the importer's).
    const veredito = async (texto: string): Promise<'servido' | 'recusado'> => {
      const err: unknown = await reproduzirPedidoShopee(asDb(novoDbDaReproducao()), {
        detalheTexto: detalheTexto(linhaBR()),
        escrowTexto: texto,
        orderSn: null,
        nowMs: NOW_MS,
        viaCep: { buscarCep: () => Promise.resolve(null) },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      return err instanceof CapturaInvalidaError ? 'recusado' : 'servido';
    };
    for (const texto of [
      escrowRespostaNula,
      escrowOutraOrder,
      escrowSemOrderSn,
      escrowSchemaInvalidoMesmaOrder,
      ESCROW_SG_TEXTO,
    ]) {
      expect(await veredito(texto), texto).toBe(
        escrowReproduzivel(com(texto), ORDER_SN) ? 'servido' : 'recusado',
      );
    }
  });

  it('o relatório de um escrow não reproduzível explica por que ficou de fora', async () => {
    const { texto } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: DETALHE_SG_TEXTO },
      [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: escrowRate },
    });
    expect(texto).toContain('o importador NÃO contém esta falha do escrow');
    expect(texto).toContain('(sem --escrow: o escrow não foi salvo');
    expect(texto).not.toContain(`--escrow ${CAMINHOS.escrow}`);
  });

  it('um escrow que a REPRODUÇÃO recusaria fica de fora, com a frase dela — e o comando vai sem --escrow', async () => {
    const { texto, resultado, saida } = await capturar({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: DETALHE_SG_TEXTO },
      [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: escrowRespostaNula },
    });
    expect(resultado.escrow?.salva).toBe(false);
    expect(resultado.escrow?.recusaDaReproducao).toContain('--escrow não traz "response"');
    expect(texto).toContain('a reprodução recusaria este escrow');
    // The FIRST line naming the command is the next step itself (the round-trip
    // table finds it that way) — the note above it must not name it.
    expect(
      saida.linhas
        .find((l) => l.includes('reproduzir:pedido'))
        ?.trimStart()
        .startsWith('pnpm '),
    ).toBe(true);
    expect(texto).toContain('--escrow não traz "response"');
    expect(texto).toContain('(sem --escrow: o escrow não foi salvo');
    expect(texto).not.toContain(`--escrow ${CAMINHOS.escrow}`);
    // The rate-limit sentence is a DIFFERENT reason, and must not be borrowed.
    expect(texto).not.toContain('o importador NÃO contém esta falha do escrow');
  });
});

function novoDbDaReproducao(): FakeDb {
  const db = new FakeDb();
  for (const [caminho, dados] of linhasDeSemente()) db.seed(caminho, { ...dados });
  return db;
}

/* ========================================================================== */
/*  7c · the atomic writer                                                    */
/* ========================================================================== */

describe('§7c gravarSemSobrescrever', () => {
  const DESTINO = '/fora/c/a.detalhe.json';
  const PARCIAL = `${DESTINO}${SUFIXO_PARCIAL}`;

  /** A filesystem double: a map of path → text, with a fault per step. */
  function fsDuplo(falhas: Partial<Record<keyof OperacoesDeGravacao, Error>> = {}) {
    const arquivos = new Map<string, string>();
    const passos: string[] = [];
    const fds = new Map<number, string>();
    const ops: OperacoesDeGravacao = {
      criarExclusivo: (c) => {
        passos.push(`criar ${c}`);
        if (falhas.criarExclusivo !== undefined) throw falhas.criarExclusivo;
        if (arquivos.has(c)) throw erroDeSistema('EEXIST', 'open');
        arquivos.set(c, '');
        fds.set(7, c);
        return 7;
      },
      escrever: (fd, texto) => {
        passos.push('escrever');
        const c = fds.get(fd)!;
        // A fault mid-write leaves a TRUNCATED body behind, as Node does.
        arquivos.set(c, falhas.escrever === undefined ? texto : texto.slice(0, 3));
        if (falhas.escrever !== undefined) throw falhas.escrever;
      },
      fechar: () => {
        passos.push('fechar');
        if (falhas.fechar !== undefined) throw falhas.fechar;
      },
      vincular: (de, para) => {
        passos.push(`vincular ${para}`);
        if (falhas.vincular !== undefined) throw falhas.vincular;
        if (arquivos.has(para)) throw erroDeSistema('EEXIST', 'link');
        arquivos.set(para, arquivos.get(de)!);
      },
      remover: (c) => {
        passos.push(`remover ${c}`);
        if (falhas.remover !== undefined) throw falhas.remover;
        arquivos.delete(c);
      },
    };
    return { ops, arquivos, passos };
  }

  it('o caminho feliz: parcial exclusivo → escrever → fechar → vincular → remover o parcial', () => {
    const d = fsDuplo();
    expect(gravarSemSobrescrever(DESTINO, 'corpo', d.ops)).toEqual(GRAVADO);
    expect(d.passos).toEqual([
      `criar ${PARCIAL}`,
      'escrever',
      'fechar',
      `vincular ${DESTINO}`,
      `remover ${PARCIAL}`,
    ]);
    expect([...d.arquivos]).toEqual([[DESTINO, 'corpo']]);
  });

  it('falha NO MEIO da escrita (ENOSPC) ⇒ nada com o nome final, o parcial truncado é REMOVIDO', () => {
    const d = fsDuplo({ escrever: erroDeSistema('ENOSPC', 'write') });
    expect(gravarSemSobrescrever(DESTINO, 'corpo-inteiro', d.ops)).toEqual({
      salvo: false,
      codigo: 'ENOSPC',
      parcialRestante: null,
    });
    expect(d.passos).toContain('fechar');
    expect(d.passos).not.toContain(`vincular ${DESTINO}`);
    expect([...d.arquivos]).toEqual([]);
  });

  it('o destino apareceu depois da checagem ⇒ EEXIST, o arquivo de outro INTACTO, o parcial removido', () => {
    const d = fsDuplo();
    d.arquivos.set(DESTINO, 'de outra pessoa');
    expect(gravarSemSobrescrever(DESTINO, 'novo', d.ops)).toEqual({
      salvo: false,
      codigo: 'EEXIST',
      parcialRestante: null,
    });
    expect([...d.arquivos]).toEqual([[DESTINO, 'de outra pessoa']]);
  });

  it('o PARCIAL já existia ⇒ EEXIST e nada é apagado: um arquivo que não criamos nunca é nosso', () => {
    const d = fsDuplo();
    d.arquivos.set(PARCIAL, 'sobra antiga');
    expect(gravarSemSobrescrever(DESTINO, 'novo', d.ops)).toEqual({
      salvo: false,
      codigo: 'EEXIST',
      parcialRestante: null,
    });
    expect(d.passos).toEqual([`criar ${PARCIAL}`]);
    expect(d.arquivos.get(PARCIAL)).toBe('sobra antiga');
  });

  it('o parcial não pôde ser removido ⇒ salvo, mas o parcial é NOMEADO para apagar', () => {
    const d = fsDuplo({ remover: erroDeSistema('EBUSY', 'unlink') });
    expect(gravarSemSobrescrever(DESTINO, 'corpo', d.ops)).toEqual({
      salvo: true,
      codigo: null,
      parcialRestante: PARCIAL,
    });
  });

  it('o fechamento falha (EIO numa pasta de rede) ⇒ não vincula, remove o parcial', () => {
    const d = fsDuplo({ fechar: erroDeSistema('EIO', 'close') });
    expect(gravarSemSobrescrever(DESTINO, 'corpo', d.ops).codigo).toBe('EIO');
    expect(d.passos).not.toContain(`vincular ${DESTINO}`);
    expect(d.arquivos.has(PARCIAL)).toBe(false);
  });

  it('QUASE-ERRO: um erro que não é de sistema (sem errno/syscall) é RELANÇADO — e o parcial ainda sai', () => {
    const bug = new TypeError('bug');
    const d = fsDuplo({ escrever: bug });
    expect(() => gravarSemSobrescrever(DESTINO, 'corpo', d.ops)).toThrow(bug);
    expect(d.arquivos.has(PARCIAL)).toBe(false);
    const soCodigo = Object.assign(new Error('x'), { code: 'ENOSPC' });
    expect(() =>
      gravarSemSobrescrever(DESTINO, 'corpo', fsDuplo({ vincular: soCodigo }).ops),
    ).toThrow(soCodigo);
  });

  it('no sistema de arquivos DE VERDADE: grava byte a byte, nunca sobrescreve, não deixa parcial', () => {
    const pasta = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'captura-teste-'));
    try {
      const fs: OperacoesDeGravacao = {
        criarExclusivo: (c) => openSync(c, 'wx'),
        escrever: (fd, t) => {
          writeFileSync(fd, t, { encoding: 'utf8' });
        },
        fechar: (fd) => {
          closeSync(fd);
        },
        vincular: (de, para) => {
          linkSync(de, para);
        },
        remover: (c) => {
          rmSync(c, { force: true });
        },
      };
      const destino = nodePath.join(pasta, 'a.detalhe.json');
      expect(gravarSemSobrescrever(destino, DETALHE_SG_TEXTO, fs)).toEqual(GRAVADO);
      expect(readFileSync(destino, 'utf8')).toBe(DETALHE_SG_TEXTO);
      expect(readdirSync(pasta)).toEqual(['a.detalhe.json']);

      // A second write to the same name: refused, the first body untouched, no partial.
      expect(gravarSemSobrescrever(destino, 'outro corpo', fs)).toEqual({
        salvo: false,
        codigo: 'EEXIST',
        parcialRestante: null,
      });
      expect(readFileSync(destino, 'utf8')).toBe(DETALHE_SG_TEXTO);
      expect(readdirSync(pasta)).toEqual(['a.detalhe.json']);
      expect(existsSync(caminhoParcial(destino))).toBe(false);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */
/*  8 · THE PROPERTY                                                          */
/* ========================================================================== */

describe('§8 nada impresso carrega credencial, URL ou valor do comprador', () => {
  const escrowBR = { ...ESCROW_SG.response, buyer_user_name: 'compradora.exemplo' };

  async function relatorioDe(corpos: Readonly<Record<string, Corpo>>) {
    const c = await capturar(corpos);
    const descricoes = [c.resultado.detalhe.erro, c.resultado.escrow?.erro]
      .filter((e) => e != null)
      .flatMap((e) => descreverErroCaptura(e));
    return { ...c, tudo: [c.texto, ...descricoes].join('\n') };
  }

  it.each([
    [
      'o par completo',
      {
        [SHOPEE_GET_ESCROW_DETAIL_PATH]: {
          texto: JSON.stringify({ ...ESCROW_SG, response: escrowBR }),
        },
      },
    ],
    ['escrow com erro', { [SHOPEE_GET_ESCROW_DETAIL_PATH]: { texto: erroTexto('error_server') } }],
    ['escrow sem rede', {}],
  ] as const)('%s', async (_nome, escrow) => {
    const linha = linhaBR();
    const { tudo, stub } = await relatorioDe({
      [SHOPEE_GET_ORDER_DETAIL_PATH]: { texto: detalheTexto(linha) },
      ...escrow,
    });

    // The credentials and every per-call secret the stub saw.
    const segredos = [
      CREDENCIAIS.accessToken,
      CREDENCIAIS.partnerKey,
      String(CREDENCIAIS.shopId),
      String(CREDENCIAIS.partnerId),
      ORDER_SN,
      ...stub.gravadas.map((g) => g.url.searchParams.get('sign') ?? 'sem-sign'),
      ...stub.gravadas.map((g) => g.url.search),
    ];
    expect(stub.gravadas.length).toBeGreaterThan(0);
    for (const s of segredos) expect(tudo, s).not.toContain(s);
    expect(tudo).not.toMatch(/[?&](sign|access_token|shop_id|partner_id|timestamp)=/);
    expect(tudo).not.toMatch(/https?:\/\//);

    // Every buyer value of the capture — the replay's own residue scan.
    const sensiveis = valoresSensiveisDaCaptura(linha, escrowBR);
    expect(sensiveis.length).toBeGreaterThan(8);
    expect(encontrarResiduos(tudo, sensiveis)).toEqual([]);
  });

  it('ÂNCORA: a varredura acharia um valor vazado (não passa no vazio)', () => {
    const sensiveis = valoresSensiveisDaCaptura(linhaBR(), escrowBR);
    expect(encontrarResiduos(`linha com ${CPF_FALSO}`, sensiveis)).toEqual(['buyer_cpf_id']);
  });

  it('argumentoDeShell: caminho limpo verbatim; com espaço ou aspas, entre aspas simples do PowerShell', () => {
    expect(argumentoDeShell('C:\\Users\\x\\shopee-capturas\\a.detalhe.json')).toBe(
      'C:\\Users\\x\\shopee-capturas\\a.detalhe.json',
    );
    expect(argumentoDeShell('C:\\Users\\x\\minhas capturas\\a.json')).toBe(
      "'C:\\Users\\x\\minhas capturas\\a.json'",
    );
    expect(argumentoDeShell("C:\\d'agua\\a.json")).toBe("'C:\\d''agua\\a.json'");
    expect(argumentoDeShell('C:\\$env\\a.json')).toBe("'C:\\$env\\a.json'");
  });
});

/* ========================================================================== */
/*  9 · the error describer                                                   */
/* ========================================================================== */

describe('§9 descreverErroCaptura', () => {
  const SEGREDO = 'access_token=token-ecoado-pela-shopee';
  const init = { httpStatus: 200, path: SHOPEE_GET_ORDER_DETAIL_PATH, providerMessage: SEGREDO };

  it('nunca imprime a mensagem da Shopee (providerMessage nem err.message)', () => {
    const erros = [
      new ShopeeApiError(`Shopee x respondeu error_param — ${SEGREDO}`, {
        ...init,
        code: 'error_param',
        kind: SHOPEE_ERROR_KIND.other,
      }),
      new ShopeeApiError(`… ${SEGREDO}`, {
        ...init,
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.other,
      }),
      new ShopeeReauthRequiredError(`… ${SEGREDO}`, {
        ...init,
        code: 'shop_access_expired',
        kind: SHOPEE_ERROR_KIND.reauth,
      }),
      new ShopeeRateLimitError(`… ${SEGREDO}`, {
        ...init,
        code: 'error_rate_limit',
        kind: 'burst',
      }),
      new ShopeeConfigError(`shop_id deve ser … (recebido: ${SEGREDO})`),
      new ShopeeNetworkError(`… ${SEGREDO}`, new TypeError(SEGREDO)),
      new ShopeeHttpError(`… ${SEGREDO}`, { httpStatus: 403, path: SHOPEE_GET_ORDER_DETAIL_PATH }),
      new ShopeeSchemaError(`… ${SEGREDO}`, {
        campos: ['response.order_list.0.order_status'],
        httpStatus: 200,
        path: SHOPEE_GET_ORDER_DETAIL_PATH,
      }),
    ];
    for (const e of erros) {
      const linhas = descreverErroCaptura(e).join('\n');
      expect(linhas, e.name).not.toContain('token-ecoado');
      expect(linhas.length, e.name).toBeGreaterThan(10);
    }
  });

  it('a ORDEM: o limite e a autorização morta antes do ShopeeApiError que ambos estendem', () => {
    const limite = new ShopeeRateLimitError('x', { ...init, code: 'error_limit', kind: 'daily' });
    expect(descreverErroCaptura(limite)[0]).toMatch(/^⏸ ShopeeRateLimitError \(daily\)/);
    expect(descreverErroCaptura(limite).join('\n')).toMatch(/13:00 em Brasília/);
    const morta = new ShopeeReauthRequiredError('x', {
      ...init,
      code: 'refresh_token_expired',
      kind: SHOPEE_ERROR_KIND.reauth,
    });
    expect(descreverErroCaptura(morta)[0]).toMatch(/^🛑 PARE: ShopeeReauthRequiredError/);
    expect(descreverErroCaptura(morta)[1]).toMatch(/Não renove o token/);
  });

  it('HTTP sem envelope: 4xx é PARE (a forma da lista de IPs); 5xx é instabilidade — uma tentativa', () => {
    const http = (s: number) =>
      descreverErroCaptura(
        new ShopeeHttpError('x', { httpStatus: s, path: SHOPEE_GET_ORDER_DETAIL_PATH }),
      );
    expect(http(403)[0]).toMatch(/^🛑 PARE: ShopeeHttpError httpStatus=403/);
    expect(http(403)[1]).toMatch(/Não renove o token/);
    expect(http(502)).toHaveLength(1);
    expect(http(502)[0]).toMatch(/^⚠️ ShopeeHttpError httpStatus=502 .*UMA vez/);
  });

  it('o código só sai quando tem forma de token; o schema sai por PATHS', () => {
    const estranho = new ShopeeApiError('x', {
      ...init,
      code: 'código <script>',
      kind: SHOPEE_ERROR_KIND.other,
    });
    expect(descreverErroCaptura(estranho)[0]).toContain('code=(formato inesperado)');
    const schema = new ShopeeSchemaError('x', {
      campos: ['response.order_list.0.order_status'],
      httpStatus: 200,
      path: SHOPEE_GET_ORDER_DETAIL_PATH,
    });
    expect(descreverErroCaptura(schema)).toEqual([
      '⚠️ ShopeeSchemaError — o corpo não bate com o schema de wire (o mesmo da produção).',
      `   path=${SHOPEE_GET_ORDER_DETAIL_PATH}`,
      '   campos: response.order_list.0.order_status',
    ]);
  });

  it('os erros da própria CLI saem inteiros; a guarda de rede pela causa; o resto pela CLASSE', () => {
    expect(descreverErroCaptura(new ArgumentoInvalidoError('x'))).toEqual([
      '❌ x',
      '',
      USO_CAPTURAR_PEDIDO,
    ]);
    expect(descreverErroCaptura(new ArquivoRecusadoError('--pasta y'))).toEqual(['❌ --pasta y']);
    expect(descreverErroCaptura(recusa({}))[0]).toMatch(/SHOPEE_CAP_PARTNER_ID/);
    const bloqueada = new RequisicaoBloqueadaNaCapturaError(
      'POST openplatform.shopee.com.br/api/v2/auth/access_token/get',
    );
    expect(descreverErroCaptura(new ShopeeNetworkError('x', bloqueada))).toEqual([
      '❌ ShopeeNetworkError — a guarda de rede bloqueou: POST openplatform.shopee.com.br/api/v2/auth/access_token/get',
    ]);
    const fs = Object.assign(new Error('EEXIST: C:\\x\\a.detalhe.json'), { code: 'EEXIST' });
    expect(descreverErroCaptura(fs)).toEqual(['❌ erro inesperado: Error (EEXIST)']);
    expect(descreverErroCaptura('texto')).toEqual(['❌ erro inesperado: string']);
  });
});

/* ========================================================================== */
/* 10 · the source pins                                                       */
/* ========================================================================== */

/** `apps/shopee/`. */
const RAIZ_DO_APP = new URL('../../../', import.meta.url);

const CLI = 'lib/shopee/pedidos/capturarPedidoCli.ts';
const SCRIPT = 'scripts/capturar-pedido.ts';
const ESCROW_NAO_CONTIDO = 'lib/shopee/pedidos/escrowNaoContido.ts';

function fonte(arquivo: string): string {
  return readFileSync(new URL(arquivo, RAIZ_DO_APP), 'utf8');
}

/**
 * What the two new files may never spell: any token-renewal or context path,
 * the admin singleton, this app's own (staging) partner key variable, the env
 * loader — plus the two identifiers other guards grep for, assembled from
 * pieces so THIS file never spells them either.
 */
const PROIBIDOS: readonly string[] = [
  'refresh_access_token',
  'refreshAccessToken',
  'tokenStore',
  'loadShopeeContext',
  'firebase/admin',
  'getAdminFirestore',
  'SHOPEE_PARTNER_KEY',
  'SHOPEE_PARTNER_ID',
  'dotenv',
  ['run', 'Transaction'].join(''),
  ['simulacao', 'Comprador'].join(''),
  CPF_FALSO,
];

describe('§10 as fontes', () => {
  it('a lib e o script não soletram nenhum caminho de renovação, de contexto, de admin ou de env', () => {
    for (const arquivo of [CLI, SCRIPT, ESCROW_NAO_CONTIDO]) {
      const texto = fonte(arquivo);
      expect(texto.length, arquivo).toBeGreaterThan(1000);
      for (const p of PROIBIDOS) expect(texto, `${arquivo} ∌ ${p}`).not.toContain(p);
    }
  });

  it('a lista do escrow não contido é UMA: o importador e a captura a importam, nenhum a reescreve', () => {
    // It imports the package's error classes and nothing else — no importer graph.
    expect(fonte(ESCROW_NAO_CONTIDO).match(/^import .*$/gm)).toEqual([
      "import { ShopeeRateLimitError, ShopeeReauthRequiredError } from '@delfrance/integrations-shopee';",
    ]);
    for (const arquivo of ['lib/shopee/pedidos/importarPedido.ts', CLI]) {
      const texto = fonte(arquivo);
      expect(texto, arquivo).toContain("from './escrowNaoContido'");
      expect(texto, arquivo).not.toMatch(/instanceof ShopeeRateLimitError\) throw err/);
      expect(texto, arquivo).not.toMatch(/instanceof ShopeeReauthRequiredError\) throw err/);
    }
    // The capture must not load the importer's graph (contexts, token store, admin).
    expect(fonte(CLI)).not.toMatch(/from '\.\/importarPedido'/);
  });

  it('a lib não lê o ambiente nem um relógio', () => {
    expect(fonte(CLI)).not.toContain('process.env');
    expect(fonte(CLI)).not.toContain('Date.now(');
  });

  it('o package.json roda o script SEM carregar arquivo de env', () => {
    const pacote = JSON.parse(fonte('package.json')) as { scripts: Record<string, string> };
    expect(pacote.scripts['capturar:pedido']).toBe('tsx scripts/capturar-pedido.ts');
  });

  it('o script: a guarda PRIMEIRO, depois caminhos, credenciais, o espelho e o cliente; gravação atômica', () => {
    const texto = fonte(SCRIPT);
    const posicoes = [
      'globalThis.fetch = criarFetchGuardado(globalThis.fetch)',
      'parseArgsCapturarPedido(process.argv.slice(2))',
      'exigirCaminhosDaCaptura(args,',
      'lerCredenciaisDaCaptura(process.env)',
      'criarFetchEspelho(globalThis.fetch)',
      'criarClienteDaCaptura(credenciais, espelho.fetch)',
      'executarCaptura({',
    ].map((trecho) => {
      const i = texto.indexOf(trecho);
      expect(i, trecho).toBeGreaterThan(-1);
      return i;
    });
    expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b));
    // The guard is the lib's tested one; the script holds no second copy.
    expect(texto.match(/globalThis\.fetch = /g)).toHaveLength(1);
    expect(texto).not.toContain('fetchOriginal(');
    // Every write goes through the atomic writer: an exclusive open, a hard link.
    expect(texto).toContain("openSync(caminho, 'wx')");
    expect(texto).toContain('linkSync(de, para)');
    expect(texto).toContain('gravarSemSobrescrever(');
    expect(texto.match(/\bwriteFileSync\(/g)).toHaveLength(1);
    expect(texto).toContain('writeFileSync(fd, texto,');
    expect(texto).not.toMatch(/\brenameSync\(|\bcopyFileSync\(/);
    expect(texto.match(/\bprocess\.env\b/g)).toHaveLength(1);
    expect(texto.match(/\bprocess\.argv\b/g)).toHaveLength(1);
    expect(texto).toContain('realpath: (c: string) => realpathSync.native(c)');
  });

  it('o README traz o runbook: as quatro variáveis e o comando', () => {
    const readme = fonte('scripts/README.md');
    expect(readme).toContain('pnpm --filter @delfrance/shopee-app capturar:pedido --order-sn');
    for (const v of Object.values(VARIAVEIS_DA_CAPTURA)) expect(readme).toContain(v);
    expect(readme).toContain('`capturar-pedido.ts`');
  });
});
