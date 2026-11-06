/**
 * One Easy Ship scheduling run (step 15, PR 15-b), end to end against the fake
 * Firestore: the REAL context (`loadAmazonContext`), the REAL write engine, the
 * REAL order read, decision and plan, and the REAL mint and bulk — over a
 * scripted `fetch` routed by path and method (getOrder, the LWA refresh, the
 * token mint, the bulk).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
} from '@delfrance/integrations-amazon-sp-api';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import {
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from '../core/erros';
import { CANARIO_ENV_AMAZON, FLUXO_AMAZON, VALVULA_ENV_AMAZON, lerValvula } from '../core/valvulas';
import { AmazonLeituraDefasadaError, PedidoAmazonIlegivelError } from '../pedidos/erros';
import { classificarFalhaDeLeituraAmazon } from '../pedidos/falhaLeituraAmazon';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  pacoteAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import {
  type GateNotasAgendamentoAmazon,
  type ModoAgendamentoAmazon,
  desfechoImpressaoAgendamentoAmazon,
  lerRespostaAgendamentoAmazon,
} from './decisaoAgendamento';
import { type ResultadoAgendamentoAmazon, executarAgendamentoAmazon } from './executarAgendamento';

/** `agendarNaAmazon`, real by default; a test may make it throw. */
const h = vi.hoisted(() => ({ falha: null as unknown }));
vi.mock('./easyShipAmazon', async (original) => {
  const real = await original<typeof import('./easyShipAmazon')>();
  return {
    ...real,
    agendarNaAmazon: (...args: Parameters<typeof real.agendarNaAmazon>) =>
      h.falha === null ? real.agendarNaAmazon(...args) : Promise.reject(h.falha),
  };
});

const CONTA = 'conta-amz-agendamento';
const ORDER = ORDER_ID_TESTE;
const RDT = 'Atz.TESTE-rdt-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';
const GET_ORDER = `/orders/2026-01-01/orders/${ORDER}`;
const POST_MINT = `POST ${CAMINHO_MINT}`;
const POST_BULK = `POST ${CAMINHO_BULK}`;

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** The connection drops instead of an answer (`fetch` rejects). */
  readonly rede?: boolean;
}

type Rota = 'getOrder' | 'mint' | 'bulk';

/** The DBA order getOrder sends: one package, its status and the order-level invoice status. */
function ordem(detalhe = 'PENDING_SCHEDULE', opcoes: OpcoesPedidoTeste = {}): Roteiro {
  return {
    status: 200,
    corpo: {
      order: JSON.parse(
        JSON.stringify(
          pedidoAmazon({
            status: 'UNSHIPPED',
            programs: ['DELIVERY_BY_AMAZON'],
            invoiceStatus: 'ACCEPTED',
            pacotesBrutos: [pacoteAmazon('PKG-1', detalhe, { status: 'PENDING' })],
            ...opcoes,
          }),
        ),
      ) as unknown,
    },
  };
}

const BULK_OK: Roteiro = {
  status: 200,
  corpo: {
    scheduledPackages: [
      {
        scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-TESTE-1' },
        packageStatus: 'ReadyForPickup',
      },
    ],
  },
};

const erro = (status: number, code: string): Roteiro => ({
  status,
  corpo: { errors: [{ code, message: 'texto da Amazon' }] },
});

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly rotas: Record<Rota, Roteiro[]>;
  /** Every request that reached the scripted fetch: `<METHOD> <path>` (`LWA` for a refresh). */
  readonly chamadas: string[];
  /** The `x-amz-access-token` each SP-API request carried, in order. */
  readonly tokens: string[];
  /** Runs once, right after the context loaded (before the run). */
  depoisDoContexto: (() => void) | null;
  /** Runs once, right after getOrder is answered. */
  depoisDoGetOrder: (() => void) | null;
  rodar(o?: {
    modo?: ModoAgendamentoAmazon;
    podeAgendar?: boolean;
    notas?: GateNotasAgendamentoAmazon;
    tentativa?: number | null;
    pisoUs?: number | null;
    valvula?: string;
    /** The conta the caller PROVED the pedido under; the context is always {@link CONTA}'s. */
    contaId?: string;
  }): Promise<ResultadoAgendamentoAmazon>;
}

function cenario(rotas: Partial<Record<Rota, Roteiro[]>> = {}): Cenario {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta agendamento', selling_partner_id: SPID_A });
  seedCredencial(fake, CONTA);
  const log = loggerEspiao();
  const c: Cenario = {
    fake,
    log,
    rotas: {
      getOrder: rotas.getOrder ?? [ordem()],
      mint: rotas.mint ?? [{ status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } }],
      bulk: rotas.bulk ?? [BULK_OK],
    },
    chamadas: [],
    tokens: [],
    depoisDoContexto: null,
    depoisDoGetOrder: null,
    rodar: async (o = {}) => {
      const fetch: typeof globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return Promise.resolve(tokenDeAcesso());
        }
        c.chamadas.push(`${metodo} ${url.pathname}`);
        c.tokens.push(new Headers(init?.headers).get('x-amz-access-token') ?? '');
        const rota: Rota | null =
          url.pathname === GET_ORDER
            ? 'getOrder'
            : url.pathname === CAMINHO_MINT && metodo === 'POST'
              ? 'mint'
              : url.pathname === CAMINHO_BULK && metodo === 'POST'
                ? 'bulk'
                : null;
        if (rota === null) {
          return Promise.reject(new Error(`rota não roteirizada: ${url.pathname}`));
        }
        const fila = c.rotas[rota];
        const r = fila.length > 1 ? fila.shift() : fila[0];
        if (r === undefined) return Promise.reject(new Error(`sem resposta para ${rota}`));
        if (r.rede === true) return Promise.reject(new TypeError('fetch failed'));
        const resposta = respostaJson(r.status ?? 200, r.corpo ?? {});
        if (rota === 'getOrder' && c.depoisDoGetOrder !== null) {
          c.depoisDoGetOrder();
          c.depoisDoGetOrder = null;
        }
        return Promise.resolve(resposta);
      };
      const registro = {
        fluxo: FLUXO_AMAZON.agendamento,
        tentativa: o.tentativa === undefined ? 0 : o.tentativa,
        idTarefa: 'tarefa-agendamento-teste-1',
      };
      const deps = {
        ambiente: AMBIENTE_LIGADO,
        agora: () => AGORA_MS,
        logger: log.logger,
        registro,
        fetch,
        gerarCorrelationId: () => 'corr-agendamento-teste',
      };
      const contexto = await loadAmazonContext(asDb(fake), CONTA, deps);
      c.depoisDoContexto?.();
      return executarAgendamentoAmazon({
        valvula: lerValvula(FLUXO_AMAZON.agendamento, {
          [VALVULA_ENV_AMAZON.agendamento]: o.valvula ?? 'on',
          [CANARIO_ENV_AMAZON.agendamento]: '*',
        }),
        alvo: { contaId: o.contaId ?? CONTA, orderId: ORDER, pisoUs: o.pisoUs ?? null },
        contexto,
        deps,
        registro,
        modo: o.modo ?? 'tarefa',
        podeAgendar: o.podeAgendar ?? true,
        notas: o.notas ?? { segue: true },
      });
    },
  };
  return c;
}

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  h.falha = null;
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
});

const posts = (c: Cenario) => c.chamadas.filter((x) => x.startsWith('POST '));

/** Park the stored credential (the conta's next credential read throws). */
function estacionar(c: Cenario): void {
  c.fake.seed(
    caminhoCredencial(CONTA),
    credencialDoc({
      reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
    }),
  );
}

describe('executarAgendamentoAmazon — the valve and the plan', () => {
  it('off reads nothing: no getOrder, no POST', async () => {
    const c = cenario();
    await expect(c.rodar({ valvula: 'off' })).resolves.toEqual({ tipo: 'desligado' });
    expect(c.chamadas).toEqual([]);
  });

  it('★ dry-run: one getOrder, ONE diff line (evento agendamento, the exact plan keys), zero POSTs', async () => {
    const c = cenario();
    const r = await c.rodar({ valvula: 'dry-run' });
    expect(r).toMatchObject({ tipo: 'simulado', decisao: { acao: 'agendar' } });
    expect(c.chamadas).toEqual([`GET ${GET_ORDER}`]);
    const linhas = c.log.linhas.filter((l) => l.meta?.evento === 'agendamento');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toEqual({
      acao: 'agendar',
      motivo: null,
      fase: 'UNSHIPPED',
      invoiceStatus: 'ACCEPTED',
      modoExecucao: 'tarefa',
      escreveria: true,
      modo: 'dry-run',
      motivoDryRun: 'valvula',
      evento: 'agendamento',
      conta: CONTA,
      fluxo: 'agendamento',
      tentativa: 0,
      idTarefa: 'tarefa-agendamento-teste-1',
    });
  });

  it('★ on + agendar: exactly two POSTs, in order — the mint, then the bulk carrying the RDT; the answer reads agendado', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(c.chamadas).toEqual([`GET ${GET_ORDER}`, POST_MINT, POST_BULK]);
    expect(c.tokens[2]).toBe(RDT);
    expect(c.tokens[1]).not.toBe(RDT);
    if (r.tipo !== 'escrito') throw new Error(`esperava escrito, veio ${r.tipo}`);
    expect(r.decisao.acao).toBe('agendar');
    expect(lerRespostaAgendamentoAmazon(r.resposta, ORDER)).toMatchObject({
      tipo: 'agendado',
      pacotes: 1,
    });
    expect(JSON.stringify(r)).not.toContain(RDT);
  });

  it('★ tarefa + ja-agendado: zero POSTs', async () => {
    const c = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    const r = await c.rodar();
    expect(r).toMatchObject({ tipo: 'sem-escrita', decisao: { acao: 'ja-agendado' } });
    expect(posts(c)).toEqual([]);
  });

  it('★ impressao + ja-agendado without podeAgendar still prints (two POSTs); impressao + agendar without it sends nothing', async () => {
    const reimpressao = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    await expect(
      reimpressao.rodar({ modo: 'impressao', podeAgendar: false, tentativa: null }),
    ).resolves.toMatchObject({ tipo: 'escrito' });
    expect(posts(reimpressao)).toEqual([POST_MINT, POST_BULK]);

    const primeira = cenario();
    await expect(
      primeira.rodar({ modo: 'impressao', podeAgendar: false, tentativa: null }),
    ).resolves.toMatchObject({ tipo: 'sem-escrita', decisao: { acao: 'agendar' } });
    expect(posts(primeira)).toEqual([]);
  });

  it('★ the NF-e gate: an agendar with nfe-ambigua sends nothing (NEAR-MISS: a ja-agendado print with the same gate still prints)', async () => {
    const ambigua: GateNotasAgendamentoAmazon = { segue: false, motivo: 'nfe-ambigua' };
    const tarefa = cenario();
    const r = await tarefa.rodar({ notas: ambigua });
    expect(r).toMatchObject({ tipo: 'sem-escrita', plano: { motivo: 'nfe-ambigua' } });
    expect(posts(tarefa)).toEqual([]);

    const impressao = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    await impressao.rodar({ modo: 'impressao', notas: ambigua, tentativa: null });
    expect(posts(impressao)).toEqual([POST_MINT, POST_BULK]);
  });

  it('★ a STALE read on the print (no attempt) never writes: leitura-defasada, zero POSTs; on a queue attempt it is a read failure', async () => {
    const impressao = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    const r = await impressao.rodar({
      modo: 'impressao',
      tentativa: null,
      pisoUs: ATUALIZADO_US + 1,
    });
    expect(r).toMatchObject({ tipo: 'sem-escrita', plano: { motivo: 'leitura-defasada' } });
    expect(posts(impressao)).toEqual([]);

    const tarefa = cenario();
    const t = await tarefa.rodar({ tentativa: 0, pisoUs: ATUALIZADO_US + 1 });
    expect(t).toMatchObject({ tipo: 'falha', fase: 'leitura' });
    if (t.tipo !== 'falha') throw new Error('esperava falha');
    expect(t.erro).toBeInstanceOf(AmazonLeituraDefasadaError);
    expect(classificarFalhaDeLeituraAmazon(t.erro)).toBe('transitorio');
    expect(posts(tarefa)).toEqual([]);
  });
});

describe('executarAgendamentoAmazon — the PHASE of a failure (§3 decision 11)', () => {
  it('★ mutation 20: a getOrder 404 ⇒ falha, fase leitura, zero POSTs (NEAR-MISS: a bulk 404 ⇒ fase escrita, with its plan)', async () => {
    const leitura = cenario({ getOrder: [erro(404, 'NotFound')] });
    const r = await leitura.rodar();
    expect(r).toMatchObject({ tipo: 'falha', fase: 'leitura' });
    if (r.tipo !== 'falha') throw new Error('esperava falha');
    expect(r.erro).toBeInstanceOf(AmazonNotFoundError);
    expect(classificarFalhaDeLeituraAmazon(r.erro)).toBe('nao-encontrado');
    expect(posts(leitura)).toEqual([]);

    const escrita = cenario({ bulk: [erro(404, 'InvalidOrderState')] });
    const w = await escrita.rodar({ modo: 'impressao', tentativa: null });
    expect(w).toMatchObject({
      tipo: 'falha',
      fase: 'escrita',
      decisao: { acao: 'agendar' },
      plano: { acao: 'agendar' },
    });
    if (w.tipo !== 'falha' || w.fase !== 'escrita') throw new Error('esperava falha de escrita');
    expect(w.erro).toBeInstanceOf(AmazonNotFoundError);
    expect(posts(escrita)).toEqual([POST_MINT, POST_BULK]);
    // The print over a FIRST schedule reads the bulk 404 as a refusal.
    expect(desfechoImpressaoAgendamentoAmazon('agendar', { tipo: 'erro', erro: w.erro })).toEqual({
      tipo: 'recusada',
      motivo: 'agendamento-recusado',
    });
  });

  it('a getOrder answer for ANOTHER order (an illegible read) ⇒ falha, fase leitura, PedidoAmazonIlegivelError — never a 500', async () => {
    const c = cenario({
      getOrder: [ordem('PENDING_SCHEDULE', { extra: { orderId: '171-0000000-0000001' } })],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ tipo: 'falha', fase: 'leitura' });
    if (r.tipo !== 'falha') throw new Error('esperava falha');
    expect(r.erro).toBeInstanceOf(PedidoAmazonIlegivelError);
    expect(classificarFalhaDeLeituraAmazon(r.erro)).toBe('ilegivel');
  });

  /** What the credential getter meets mid-run, and the class it throws. */
  const CREDENCIAL_NO_MEIO: [
    string,
    (c: Cenario) => void,
    abstract new (...a: never[]) => Error,
  ][] = [
    ['PARKED', estacionar, ContaAmazonParadaError],
    ['DELETED', (c) => c.fake.apagar(caminhoCredencial(CONTA)), CredencialAmazonAusenteError],
    [
      'CORRUPTED (it no longer parses)',
      (c) => c.fake.seed(caminhoCredencial(CONTA), credencialDoc({ acessoRef: 42 })),
      CredencialAmazonInvalidaError,
    ],
  ];

  it.each(CREDENCIAL_NO_MEIO)(
    '★ mutation 25: a credential %s between the context load and getOrder ⇒ falha, fase leitura, zero requests; the classifier answers conta-indisponivel',
    async (_nome, mudar, classe) => {
      const c = cenario();
      // The context loads (its fail-fast credential read passes), then the credential changes.
      c.depoisDoContexto = () => mudar(c);
      const r = await c.rodar();
      expect(r).toMatchObject({ tipo: 'falha', fase: 'leitura' });
      if (r.tipo !== 'falha') throw new Error('esperava falha');
      expect(r.erro).toBeInstanceOf(classe);
      expect(classificarFalhaDeLeituraAmazon(r.erro)).toBe('conta-indisponivel');
      expect(c.chamadas).toEqual([]);
    },
  );

  it.each(CREDENCIAL_NO_MEIO)(
    '★ NEAR-MISS: the same credential %s at the WRITE client’s getter (after getOrder) ⇒ falha, fase escrita, zero POSTs',
    async (_nome, mudar, classe) => {
      const c = cenario();
      c.depoisDoGetOrder = () => mudar(c);
      const r = await c.rodar();
      expect(r).toMatchObject({ tipo: 'falha', fase: 'escrita' });
      if (r.tipo !== 'falha') throw new Error('esperava falha');
      expect(r.erro).toBeInstanceOf(classe);
      expect(classificarFalhaDeLeituraAmazon(r.erro)).toBe('conta-indisponivel');
      expect(posts(c)).toEqual([]);
      expect(desfechoImpressaoAgendamentoAmazon('agendar', { tipo: 'erro', erro: r.erro })).toEqual(
        { tipo: 'conta-indisponivel' },
      );
    },
  );

  it('★ a bulk whose connection drops (AmazonNetworkError) or whose 2xx is off its schema (AmazonSchemaError) ⇒ falha, fase escrita, the bulk sent ONCE — never a 500', async () => {
    const cortado = cenario({ bulk: [{ rede: true }] });
    const r = await cortado.rodar({ modo: 'impressao', tentativa: null });
    expect(r).toMatchObject({ tipo: 'falha', fase: 'escrita' });
    if (r.tipo !== 'falha') throw new Error('esperava falha');
    expect(r.erro).toBeInstanceOf(AmazonNetworkError);
    expect(posts(cortado)).toEqual([POST_MINT, POST_BULK]);
    // A cut bulk may have landed: wait, then reprint.
    expect(desfechoImpressaoAgendamentoAmazon('agendar', { tipo: 'erro', erro: r.erro })).toEqual({
      tipo: 'amazon-indisponivel',
    });

    const esquema = cenario({ bulk: [{ status: 200, corpo: { scheduledPackages: 'x' } }] });
    const s = await esquema.rodar({ modo: 'impressao', tentativa: null });
    expect(s).toMatchObject({ tipo: 'falha', fase: 'escrita' });
    if (s.tipo !== 'falha') throw new Error('esperava falha');
    expect(s.erro).toBeInstanceOf(AmazonSchemaError);
    expect(posts(esquema)).toEqual([POST_MINT, POST_BULK]);
    expect(desfechoImpressaoAgendamentoAmazon('agendar', { tipo: 'erro', erro: s.erro })).toEqual({
      tipo: 'indisponivel',
    });
  });

  it('★ the token MINT refused (400) ⇒ falha, fase escrita, NO bulk sent — and the print never reads it as Amazon refusing the order (NEAR-MISS: the same 400 on the bulk is recusada)', async () => {
    const mint = cenario({ mint: [erro(400, 'InvalidRequest')] });
    const r = await mint.rodar({ modo: 'impressao', tentativa: null });
    expect(r).toMatchObject({ tipo: 'falha', fase: 'escrita', decisao: { acao: 'agendar' } });
    if (r.tipo !== 'falha') throw new Error('esperava falha');
    expect(r.erro).toBeInstanceOf(AmazonHttpError);
    expect(posts(mint)).toEqual([POST_MINT]);
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(desfechoImpressaoAgendamentoAmazon(acao, { tipo: 'erro', erro: r.erro })).toEqual({
        tipo: 'indisponivel',
      });
    }

    const bulk = cenario({ bulk: [erro(400, 'InvalidRequest')] });
    const w = await bulk.rodar({ modo: 'impressao', tentativa: null });
    expect(w).toMatchObject({ tipo: 'falha', fase: 'escrita' });
    if (w.tipo !== 'falha') throw new Error('esperava falha');
    expect(posts(bulk)).toEqual([POST_MINT, POST_BULK]);
    expect(desfechoImpressaoAgendamentoAmazon('agendar', { tipo: 'erro', erro: w.erro })).toEqual({
      tipo: 'recusada',
      motivo: 'agendamento-recusado',
    });
  });

  it('★ the run hands the engine the conta the caller PROVED: a context loaded for ANOTHER conta is a TypeError before any request', async () => {
    const c = cenario();
    await expect(c.rodar({ contaId: 'outra-conta' })).rejects.toBeInstanceOf(TypeError);
    expect(c.chamadas).toEqual([]);
  });

  it('a second 401/403 on the bulk (the refresh spent) ⇒ falha, fase escrita, AmazonAuthError, after one refresh and a NEW mint', async () => {
    const c = cenario({
      mint: [
        { status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } },
        { status: 200, corpo: { restrictedDataToken: `${RDT}-2`, expiresIn: 3600 } },
      ],
      bulk: [erro(401, 'Unauthorized'), erro(403, 'Unauthorized')],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ tipo: 'falha', fase: 'escrita' });
    if (r.tipo !== 'falha') throw new Error('esperava falha');
    expect(r.erro).toBeInstanceOf(AmazonAuthError);
    expect(c.chamadas).toEqual([
      `GET ${GET_ORDER}`,
      POST_MINT,
      POST_BULK,
      'LWA',
      POST_MINT,
      POST_BULK,
    ]);
    expect(c.tokens[2]).toBe(RDT);
    expect(c.tokens[4]).toBe(`${RDT}-2`);
  });

  it('★ a TypeError thrown inside the write RETHROWS (rule 6): it is not a failure the run answers', async () => {
    const c = cenario();
    h.falha = new TypeError('defeito');
    await expect(c.rodar()).rejects.toBeInstanceOf(TypeError);
  });
});
