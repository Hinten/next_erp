/**
 * The Easy Ship scheduling queue's body (step 15, PR 15-c), A0–A9, end to end
 * against the fake Firestore: the REAL context, the REAL write engine, the REAL
 * order read, decision, plan and answer reader, the REAL token mint and bulk
 * over a scripted `fetch` routed by path and method (getOrder, the LWA
 * exchange, the mint, the bulk), and the REAL scheduling producer over the
 * recording, name-keeping queue of `testing/produtorAgendamento.ts` (so every
 * re-enqueue is re-validated against the payload schema).
 *
 * After EVERY test: no network call left the scripted `fetch`, and no write of
 * any scenario touched a pedido — the task's only writes are avisos (plus the
 * context's own credential patch after a forced refresh).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  MOTIVO_PEDIDO_AMAZON,
  type MotivoPedidoAmazon,
} from '@delfrance/schemas';

import {
  chavePedidoPrecisaAtencao,
  semearResolucaoDoPedidoAmazon,
  sincronizarAvisosDoPedidoAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { ConfigAmazonAusenteError } from '../core/erros';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { FalhaTarefaAmazonError } from '../notificacoes/notificacao';
import { AmazonLeituraDefasadaError } from '../pedidos/erros';
import { MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON } from '../pedidos/importarPedido';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  erroLwa,
  type LinhaDeLog,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  type OpcoesPedidoTeste,
  linhaAmazon,
  pacoteAmazon,
  pedidoAmazon,
} from '../testing/pedidoWireAmazon';
import {
  type FilaAgendamentoDeTeste,
  filaAgendamentoDeTeste,
} from '../testing/produtorAgendamento';
import {
  type AgendadorAgendamentoAmazon,
  AmazonAgendamentoRegiaoDaFilaInvalidaError,
} from './agendadorAgendamento';
import {
  AmazonAgendamentoTransitorioError,
  type DepsProcessarAgendamentoAmazon,
  MOTIVOS_AVISO_AGENDAMENTO_AMAZON,
  type ResultadoTarefaAgendamentoAmazon,
  processarAgendamentoAmazon,
  registrarDespachoAgendamentoAmazon,
  severidadeDoDespachoAgendamentoAmazon,
} from './processarAgendamento';
import {
  ESPERA_ACEITE_AGENDAMENTO_AMAZON_S,
  ORIGEM_AGENDAMENTO_AMAZON,
  PAUSAS_AGENDAMENTO_AMAZON_S,
  TENTATIVAS_AGENDAMENTO_AMAZON,
  type TarefaAgendamentoAmazon,
  esperaAgendamentoAmazon,
  pausaAgendamentoAmazon,
  tarefaInicialAgendamentoAmazon,
} from './tarefaAgendamento';

const CONTA = 'conta-amz-agendamento';
const ORDER = ORDER_ID_TESTE;
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO_ID}`;
const RDT = 'Atz.TESTE-rdt-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';
const GET_ORDER = `GET /orders/2026-01-01/orders/${ORDER}`;
const POST_MINT = `POST ${CAMINHO_MINT}`;
const POST_BULK = `POST ${CAMINHO_BULK}`;
const ULTIMA = TENTATIVAS_AGENDAMENTO_AMAZON - 1;
const ID_TAREFA = 'tarefa-agendamento-teste-1';

/** Sentinels the log scan below hunts: Amazon-made ids, the label link, a label byte. */
const SENTINELA = {
  refPacote: 'PKG-SENTINELA-REF-0001',
  rastreioPedido: 'TRK-SENTINELA-PEDIDO-0001',
  pacoteBulk: 'PKG-SENTINELA-BULK-0001',
  rastreioBulk: 'TRK-SENTINELA-BULK-0001',
  slot: 'SLOT-SENTINELA-0001',
  url: 'https://example-bucket.s3.amazonaws.com/etiqueta.zip?X-Amz-Signature=0000sentinela',
} as const;

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** The connection drops instead of an answer (`fetch` rejects). */
  readonly rede?: true;
}

type Rota = 'getOrder' | 'mint' | 'bulk';

/** The DBA order getOrder sends: one package at `detalhe`, the order-level invoice status ACCEPTED. */
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
            pacotesBrutos: [
              pacoteAmazon(SENTINELA.refPacote, detalhe, {
                status: 'PENDING',
                rastreio: SENTINELA.rastreioPedido,
              }),
            ],
            ...opcoes,
          }),
        ),
      ) as unknown,
    },
  };
}

/** Amazon's 2xx for a scheduled order, with the label link and every Amazon-made id. */
const BULK_OK: Roteiro = {
  status: 200,
  corpo: {
    scheduledPackages: [
      {
        scheduledPackageId: { amazonOrderId: ORDER, packageId: SENTINELA.pacoteBulk },
        packageStatus: 'ReadyForPickup',
        trackingDetails: { trackingId: SENTINELA.rastreioBulk },
        packageTimeSlot: { slotId: SENTINELA.slot, handoverMethod: 'PICKUP' },
      },
    ],
    rejectedOrders: [],
    printableDocumentsUrl: SENTINELA.url,
  },
};

/** Amazon's 2xx rejecting OUR order with `codigo` (the label link still present). */
const rejeitado = (codigo: string): Roteiro => ({
  status: 200,
  corpo: {
    scheduledPackages: [],
    rejectedOrders: [{ amazonOrderId: ORDER, error: { code: codigo, message: 'texto da Amazon' } }],
    printableDocumentsUrl: SENTINELA.url,
  },
});

/** A top-level error list. */
const erro = (status: number, codigo: string): Roteiro => ({
  status,
  corpo: { errors: [{ code: codigo, message: 'texto da Amazon' }] },
});

/** A synthetic proc: `finNFe` and `tpAmb` (production); no real party. */
function proc(finNFe = '1'): string {
  return (
    '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF>' +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

const NFE_APROVADA = { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc() };
const NFE_VENDA_CANCELADA = { estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc() };

/** The pedido as the importer wrote it: proved, paid, DBA, its freight `amz` waiting to be scheduled. */
function pedidoRaw(
  extra: Record<string, unknown> = {},
  frete: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    ultimaModificacao: ATUALIZADO_US + 10,
    lastMarketplaceUpdate: ATUALIZADO_US,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'] },
    freteInicial: {
      externalOptionIntegracao: 'amz',
      modalidade: '1',
      estado: ESTADO_FRETE.aguardandoAgendamento,
      ultimaModificacao: ATUALIZADO_US,
      ...frete,
    },
    ...extra,
  };
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly rotas: Record<Rota, Roteiro[]>;
  /** The LWA exchange's answers, in order (the last one repeats). */
  readonly lwa: (() => Response)[];
  /** Every request that reached the scripted fetch: `<METHOD> <path>` (`LWA` for an exchange). */
  readonly chamadas: string[];
  /** The `x-amz-access-token` each SP-API request carried, in order. */
  readonly tokens: string[];
  /** The scheduling queue: the REAL producer over a recording, name-keeping queue. */
  readonly fila: FilaAgendamentoDeTeste;
  /** Spies on both producer entry points, across every producer the handler built. */
  readonly espioes: {
    readonly enfileirar: ReturnType<typeof vi.fn>;
    readonly enfileirarEntrada: ReturnType<typeof vi.fn>;
  };
  ambiente: Record<string, string | undefined>;
  tentativa: number;
  /** Runs once, right after getOrder is answered (before the plan). */
  depoisDoGetOrder: (() => void | Promise<void>) | null;
  deps(): DepsProcessarAgendamentoAmazon;
  rodar(tarefa?: unknown): Promise<ResultadoTarefaAgendamentoAmazon>;
}

/** Every scenario a test built, for the after-each write check. */
const cenarios: Cenario[] = [];

function cenario(rotas: Partial<Record<Rota, Roteiro[]>> = {}, pedido = pedidoRaw()): Cenario {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta agendamento', selling_partner_id: SPID_A });
  seedCredencial(fake, CONTA);
  fake.seed(CAMINHO, pedido);
  const log = loggerEspiao();
  const fila = filaAgendamentoDeTeste();
  const espioes = { enfileirar: vi.fn(), enfileirarEntrada: vi.fn() };
  const c: Cenario = {
    fake,
    log,
    rotas: {
      getOrder: rotas.getOrder ?? [ordem()],
      mint: rotas.mint ?? [{ status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } }],
      bulk: rotas.bulk ?? [BULK_OK],
    },
    lwa: [() => tokenDeAcesso()],
    chamadas: [],
    tokens: [],
    fila,
    espioes,
    ambiente: {
      ...AMBIENTE_LIGADO,
      AMAZON_MODO_AGENDAMENTO: 'on',
      AMAZON_CANARIO_AGENDAMENTO: '*',
    },
    tentativa: 0,
    depoisDoGetOrder: null,
    deps: () => ({
      ambiente: c.ambiente,
      agora: () => AGORA_MS,
      logger: log.logger,
      increment,
      agendamento: (): AgendadorAgendamentoAmazon => {
        const real = fila.produtor();
        return {
          enfileirar: (...a: Parameters<AgendadorAgendamentoAmazon['enfileirar']>) => {
            espioes.enfileirar(...a);
            return real.enfileirar(...a);
          },
          enfileirarEntrada: (
            ...a: Parameters<AgendadorAgendamentoAmazon['enfileirarEntrada']>
          ) => {
            espioes.enfileirarEntrada(...a);
            return real.enfileirarEntrada(...a);
          },
        };
      },
      registro: { tentativa: c.tentativa, idTarefa: ID_TAREFA },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          const resposta = c.lwa.length > 1 ? c.lwa.shift() : c.lwa[0];
          return (resposta ?? (() => tokenDeAcesso()))();
        }
        c.chamadas.push(`${metodo} ${url.pathname}`);
        c.tokens.push(new Headers(init?.headers).get('x-amz-access-token') ?? '');
        const rota: Rota | null =
          `${metodo} ${url.pathname}` === GET_ORDER
            ? 'getOrder'
            : url.pathname === CAMINHO_MINT && metodo === 'POST'
              ? 'mint'
              : url.pathname === CAMINHO_BULK && metodo === 'POST'
                ? 'bulk'
                : null;
        if (rota === null) throw new Error(`rota não roteirizada: ${url.pathname}`);
        const fila = c.rotas[rota];
        const r = fila.length > 1 ? fila.shift() : fila[0];
        if (r === undefined) throw new Error(`sem resposta para ${rota}`);
        if (r.rede === true) throw new TypeError('fetch failed');
        if (rota === 'getOrder' && c.depoisDoGetOrder !== null) {
          const gancho = c.depoisDoGetOrder;
          c.depoisDoGetOrder = null;
          await gancho();
        }
        return respostaJson(r.status ?? 200, r.corpo ?? {});
      },
      gerarCorrelationId: () => 'corr-agendamento-teste',
    }),
    rodar: (tarefa = inicial()) => processarAgendamentoAmazon(asDb(fake), tarefa, c.deps()),
  };
  cenarios.push(c);
  return c;
}

/** The first payload of a chain, from the acceptance unless said otherwise. */
function inicial(
  origem: TarefaAgendamentoAmazon['origem'] = ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe,
): TarefaAgendamentoAmazon {
  return tarefaInicialAgendamentoAmazon(PEDIDO_ID, CONTA, ORDER, origem);
}

/** A payload `n` rungs up a builder's ladder. */
function subir(
  passo: (t: TarefaAgendamentoAmazon) => TarefaAgendamentoAmazon | null,
  n: number,
): TarefaAgendamentoAmazon {
  let t = inicial();
  for (let i = 0; i < n; i += 1) {
    const proxima = passo(t);
    if (proxima === null) throw new Error('subir: passou do limite');
    t = proxima;
  }
  return t;
}

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
  // ★ (mutation 6) The task makes ZERO pedido writes on every path: avisos, and
  // the context's own credential patch after a forced refresh, are all it writes.
  for (const c of cenarios) {
    const outras = c.fake.escritas
      .map((w) => w.caminho)
      .filter((p) => !p.startsWith('avisos/') && p !== caminhoCredencial(CONTA));
    expect(outras).toEqual([]);
  }
  cenarios.length = 0;
});

const posts = (c: Cenario) => c.chamadas.filter((x) => x.startsWith('POST '));
const caminhoDo = (motivo: MotivoPedidoAmazon) =>
  caminhoAviso(chavePedidoPrecisaAtencao(CONTA, ORDER, motivo));
const aviso = (c: Cenario, motivo: MotivoPedidoAmazon) => c.fake.ler(caminhoDo(motivo));
const escritasDeAviso = (c: Cenario) =>
  c.fake.escritas.filter((w) => w.caminho.startsWith('avisos/'));

/** Open a per-pedido row as an EARLIER dispatch would have (an old clock). */
async function abrirAviso(c: Cenario, motivo: MotivoPedidoAmazon): Promise<void> {
  await sincronizarAvisosDoPedidoAmazon(
    asDb(c.fake),
    { increment, nowMs: AGORA_MS },
    {
      integracaoId: CONTA,
      orderId: ORDER,
      pedidoId: PEDIDO_ID,
      levantar: [motivo],
      resolver: [],
      relogio: { seconds: 1, nanoseconds: 0 },
    },
  );
  expect(aviso(c, motivo)?.resolvidoEm).toBeNull();
}

/* -------------------------------------------------------------------------- */

describe('A0–A2 — the payload, the proof and the valve, before any read', () => {
  it('A0: an invalid payload is DROPPED (payload-invalido, WARNING), nothing read, nothing called', async () => {
    const c = cenario();
    const r = await c.rodar({ pedidoId: 'x' });
    expect(r).toMatchObject({ acao: 'payload-invalido', pedidoId: null });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(c.log.linhas).toEqual([]);
  });

  it('★ (mutation 5) A1: a forged pedidoId (a valid payload whose ids do not hash to it) drops BEFORE any read and before the valve line', async () => {
    const c = cenario();
    const forjado = { ...inicial(), pedidoId: makePedidoIdAmazon('outra-conta', ORDER) };
    const r = await c.rodar(forjado);
    expect(r).toMatchObject({ acao: 'payload-invalido', motivo: null });
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(c.log.linhas).toEqual([]);
  });

  it('★ (mutations 5, 10) A2 off: ZERO Firestore operations, zero fetch, no aviso — the valve line, then the end agendamento-desligado', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_AGENDAMENTO: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'agendamento-desligado' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('INFO');
    expect(c.fake.operacoes).toBe(0);
    expect(c.fake.leituras).toEqual([]);
    expect(c.chamadas).toEqual([]);
    expect(c.log.linhas.map((l) => l.meta?.evento)).toEqual(['valvula']);
  });
});

describe('A3 — the stored pedido and its NF-e documents', () => {
  it('★ stored checkFinalizado passes (and schedules); stored postado stops at mercadoria-fora with ONE read and no call', async () => {
    const passa = cenario({}, pedidoRaw({}, { estado: ESTADO_FRETE.checkFinalizado }));
    await expect(passa.rodar()).resolves.toMatchObject({ acao: 'agendado' });
    expect(posts(passa)).toEqual([POST_MINT, POST_BULK]);

    const para = cenario({}, pedidoRaw({}, { estado: ESTADO_FRETE.postado }));
    const r = await para.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'mercadoria-fora' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('INFO');
    expect(para.fake.leituras).toEqual([CAMINHO]);
    // ONE read means one operation: the nfev4 listing never runs for a refused pedido.
    expect(para.fake.consultas).toEqual([]);
    expect(para.fake.operacoes).toBe(1);
    expect(para.chamadas).toEqual([]);
  });

  it('a pedido the stored gates do not prove is nao-amazon (WARNING); another integradora’s freight is outra-integradora (WARNING)', async () => {
    const ausente = cenario();
    ausente.fake.apagar(CAMINHO);
    const r = await ausente.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'nao-amazon' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');

    const outra = cenario({}, pedidoRaw({}, { externalOptionIntegracao: 'me' }));
    const o = await outra.rodar();
    expect(o).toMatchObject({ acao: 'descartado', motivo: 'outra-integradora' });
    expect(severidadeDoDespachoAgendamentoAmazon(o)).toBe('WARNING');
    expect([...ausente.chamadas, ...outra.chamadas]).toEqual([]);
  });

  it('★ (mutation 21) the NF-e gate: two aprovada sale notes ⇒ nfe-ambigua; one aprovada + one cancelled sale note ⇒ nfe-substituta; only a cancelled sale note ⇒ nfe-cancelada — each ZERO POSTs, a WARNING and no aviso', async () => {
    const ambigua = cenario();
    ambigua.fake.seed(`${CAMINHO}/nfev4/s1`, NFE_APROVADA);
    ambigua.fake.seed(`${CAMINHO}/nfev4/s2`, NFE_APROVADA);
    const r = await ambigua.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'nfe-ambigua', decisao: 'agendar' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(posts(ambigua)).toEqual([]);
    expect(ambigua.chamadas).toEqual([GET_ORDER]);
    expect(escritasDeAviso(ambigua)).toEqual([]);

    const substituta = cenario();
    substituta.fake.seed(`${CAMINHO}/nfev4/s1`, NFE_APROVADA);
    substituta.fake.seed(`${CAMINHO}/nfev4/s0`, NFE_VENDA_CANCELADA);
    const s = await substituta.rodar();
    expect(s).toMatchObject({ acao: 'descartado', motivo: 'nfe-substituta' });
    expect(severidadeDoDespachoAgendamentoAmazon(s)).toBe('WARNING');
    expect(posts(substituta)).toEqual([]);
    expect(escritasDeAviso(substituta)).toEqual([]);

    const cancelada = cenario();
    cancelada.fake.seed(`${CAMINHO}/nfev4/s0`, NFE_VENDA_CANCELADA);
    const k = await cancelada.rodar();
    expect(k).toMatchObject({ acao: 'descartado', motivo: 'nfe-cancelada' });
    expect(severidadeDoDespachoAgendamentoAmazon(k)).toBe('WARNING');
    expect(posts(cancelada)).toEqual([]);
    expect(escritasDeAviso(cancelada)).toEqual([]);
  });

  it('★ NEAR-MISSES: no nfev4 at all (a hand upload) schedules; a ja-agendado order with two notes still resolves', async () => {
    const manual = cenario();
    await expect(manual.rodar()).resolves.toMatchObject({ acao: 'agendado' });
    expect(posts(manual)).toEqual([POST_MINT, POST_BULK]);

    const agendada = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    agendada.fake.seed(`${CAMINHO}/nfev4/s1`, NFE_APROVADA);
    agendada.fake.seed(`${CAMINHO}/nfev4/s2`, NFE_APROVADA);
    await abrirAviso(agendada, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado);
    await expect(agendada.rodar()).resolves.toMatchObject({
      acao: 'ja-agendado',
      avisos: { levantados: 0, resolvidos: 1 },
    });
    expect(aviso(agendada, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm).not.toBeNull();
    expect(posts(agendada)).toEqual([]);
  });

  it('a Firestore error at A3 THROWS for the retry; on the LAST attempt a TRANSIENT one is the WARNING firestore-indisponivel (a non-transient still throws)', async () => {
    const primeira = cenario();
    primeira.fake.falharLeitura(CAMINHO, grpc(14, 'indisponível'));
    await expect(primeira.rodar()).rejects.toMatchObject({ code: 14 });

    const ultima = cenario();
    ultima.tentativa = ULTIMA;
    ultima.fake.falharLeitura(CAMINHO, grpc(14, 'indisponível'));
    const r = await ultima.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'firestore-indisponivel',
      erro: 'Firestore/14',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');

    const definitiva = cenario();
    definitiva.tentativa = ULTIMA;
    definitiva.fake.falharLeitura(CAMINHO, grpc(7, 'negado'));
    await expect(definitiva.rodar()).rejects.toMatchObject({ code: 7 });
    expect([...primeira.chamadas, ...ultima.chamadas, ...definitiva.chamadas]).toEqual([]);
  });
});

describe('A4 — the context', () => {
  it('★ (mutation 10) the read switch off: the WARNING chamadas-desligadas, ZERO calls, no aviso', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'chamadas-desligadas' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(c.chamadas).toEqual([]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('an inactive or parked conta: the WARNING conta-indisponivel, no call, no aviso', async () => {
    const inativa = cenario();
    seedConta(inativa.fake, CONTA, { selling_partner_id: SPID_A, ativo: false });
    await expect(inativa.rodar()).resolves.toMatchObject({
      motivo: 'conta-indisponivel',
      falha: 'conta-inativa',
    });

    const parada = cenario();
    parada.fake.seed(
      caminhoCredencial(CONTA),
      credencialDoc({
        reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
      }),
    );
    await expect(parada.rodar()).resolves.toMatchObject({
      motivo: 'conta-indisponivel',
      falha: 'conta-indisponivel',
    });
    expect([...inativa.chamadas, ...parada.chamadas]).toEqual([]);
    expect([...inativa.fake.escritas, ...parada.fake.escritas]).toEqual([]);
  });

  it('a Firestore error on the conta read THROWS for the retry; on the LAST attempt a TRANSIENT one is the WARNING firestore-indisponivel, the same as at A3', async () => {
    const primeira = cenario();
    primeira.fake.falharLeitura(caminhoConta(CONTA), grpc(14, 'indisponível'));
    await expect(primeira.rodar()).rejects.toMatchObject({ code: 14 });

    const ultima = cenario();
    ultima.tentativa = ULTIMA;
    ultima.fake.falharLeitura(caminhoConta(CONTA), grpc(14, 'indisponível'));
    const r = await ultima.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'firestore-indisponivel',
      erro: 'Firestore/14',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect([...primeira.chamadas, ...ultima.chamadas]).toEqual([]);
  });

  it('(rule 6) the LWA pair missing from the deploy RETHROWS as itself: a bug, no line, no call, no aviso', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_LWA_CLIENT_ID: undefined };
    await expect(c.rodar()).rejects.toBeInstanceOf(ConfigAmazonAusenteError);
    expect(c.chamadas).toEqual([]);
    expect(escritasDeAviso(c)).toEqual([]);
  });
});

describe('A5–A6 — the run and a plan that writes nothing', () => {
  it('★ dry-run: getOrder and ONE diff line (evento agendamento), ZERO POSTs, no aviso', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_AGENDAMENTO: 'dry-run' };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', dryRun: 'valvula', decisao: 'agendar' });
    expect(c.chamadas).toEqual([GET_ORDER]);
    const diffs = c.log.linhas.filter(
      (l) => l.meta?.evento === 'agendamento' && l.meta.modo === 'dry-run',
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.meta).toMatchObject({ acao: 'agendar', escreveria: true });
    expect(c.fake.escritas).toEqual([]);
    expect(c.fila.tentativas).toEqual([]);
  });

  it('on OUTSIDE the canary is a dry-run too: the diff line, zero POSTs', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_AGENDAMENTO: `${CONTA}:111-0000000-0000000` };
    await expect(c.rodar()).resolves.toMatchObject({
      acao: 'simulado',
      dryRun: 'fora-do-canario',
    });
    expect(posts(c)).toEqual([]);
  });

  it.each<[string, Record<string, string>, string]>([
    ['dry-run', { AMAZON_MODO_AGENDAMENTO: 'dry-run' }, 'valvula'],
    [
      'on outside the canary',
      { AMAZON_CANARIO_AGENDAMENTO: `${CONTA}:111-0000000-0000000` },
      'fora-do-canario',
    ],
  ])(
    '★ %s of a plan that does NOT schedule still ends as under on, with ZERO POSTs: a scheduled read resolves, an acceptance entry waits, an open request raises (NEAR-MISS: the plan that would schedule is the diff line alone)',
    async (_nome, valvula, dryRun) => {
      const montar = (rotas: Partial<Record<Rota, Roteiro[]>>) => {
        const c = cenario(rotas);
        c.ambiente = { ...c.ambiente, ...valvula };
        return c;
      };

      const agendada = montar({ getOrder: [ordem('PENDING_PICK_UP')] });
      await abrirAviso(agendada, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado);
      await expect(agendada.rodar()).resolves.toMatchObject({
        acao: 'ja-agendado',
        dryRun,
        avisos: { levantados: 0, resolvidos: 1 },
      });
      expect(aviso(agendada, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm).not.toBeNull();

      const espera = montar({
        getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' })],
      });
      await expect(espera.rodar()).resolves.toMatchObject({
        acao: 'aguardando',
        dryRun,
        reenfileiramento: 'espera',
      });
      expect(espera.fila.enfileiradas).toEqual([
        { tarefa: { ...inicial(), espera: 1 }, id: null, atrasoS: 120 },
      ]);

      const solicitacao = montar({
        getOrder: [
          ordem('PENDING_SCHEDULE', {
            linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
          }),
        ],
      });
      await expect(solicitacao.rodar()).resolves.toMatchObject({
        acao: 'avisado',
        motivo: 'cancelamento-solicitado',
        dryRun,
      });
      expect(aviso(solicitacao, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento)?.resolvidoEm).toBeNull();

      const agendavel = montar({});
      await expect(agendavel.rodar()).resolves.toMatchObject({ acao: 'simulado', dryRun });
      expect(escritasDeAviso(agendavel)).toEqual([]);
      expect(agendavel.fila.tentativas).toEqual([]);

      for (const c of [agendada, espera, solicitacao, agendavel]) expect(posts(c)).toEqual([]);
    },
  );

  it('★ on + canary + agendar: exactly two POSTs in order — the mint, then the bulk carrying x-amz-access-token = the RDT — and the two motivos resolved', async () => {
    const c = cenario();
    await abrirAviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes);
    const r = await c.rodar();
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK]);
    expect(c.tokens[2]).toBe(RDT);
    expect(c.tokens[1]).not.toBe(RDT);
    expect(r).toMatchObject({
      acao: 'agendado',
      decisao: 'agendar',
      pacotes: 1,
      statusPacote: 'ReadyForPickup',
      avisos: { levantados: 0, resolvidos: 1 },
    });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes)?.resolvidoEm).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain(RDT);
    expect(JSON.stringify(r)).not.toContain(SENTINELA.url);
  });

  it('★ ja-agendado (PENDING_PICK_UP): ZERO POSTs, and the open scheduling rows resolve', async () => {
    const c = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    await abrirAviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'ja-agendado', decisao: 'ja-agendado' });
    expect(posts(c)).toEqual([]);
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes)?.resolvidoEm).not.toBeNull();
  });

  it('★ aceite-pendente from the acceptance: an UNNAMED re-enqueue at 120 s with espera 1; at espera 3 the WARNING aceite-nao-espelhado and no re-enqueue', async () => {
    const processando = () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' });
    const c = cenario({ getOrder: [processando()] });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'aguardando',
      motivo: 'nfe-em-processamento',
      reenfileiramento: 'espera',
      proxima: { espera: 1, pausas: 0, atrasoS: ESPERA_ACEITE_AGENDAMENTO_AMAZON_S[0] },
    });
    expect(ESPERA_ACEITE_AGENDAMENTO_AMAZON_S[0]).toBe(120);
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: { ...inicial(), espera: 1 }, id: null, atrasoS: 120 },
    ]);
    expect(posts(c)).toEqual([]);

    const fim = cenario({ getOrder: [processando()] });
    const f = await fim.rodar(subir(esperaAgendamentoAmazon, 3));
    expect(f).toMatchObject({ acao: 'descartado', motivo: 'aceite-nao-espelhado' });
    expect(severidadeDoDespachoAgendamentoAmazon(f)).toBe('WARNING');
    expect(fim.fila.tentativas).toEqual([]);
    expect(fim.fake.escritas).toEqual([]);
  });

  it.each([
    [0, 120],
    [1, 600],
    [2, 1800],
  ])(
    '★ the espera ladder: a dispatch at espera %i waits %i s, its own rung — never the first one again, or the acceptance would be given up on far too early',
    async (espera, atrasoS) => {
      const c = cenario({
        getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' })],
      });
      const tarefa = subir(esperaAgendamentoAmazon, espera);
      await expect(c.rodar(tarefa)).resolves.toMatchObject({
        acao: 'aguardando',
        proxima: { espera: espera + 1, atrasoS },
      });
      expect(c.fila.enfileiradas).toEqual([
        { tarefa: { ...tarefa, espera: espera + 1 }, id: null, atrasoS },
      ]);
    },
  );

  it('★ (mutation 7) NEAR-MISS: aceite-pendente from an IMPORT never re-enqueues — it is logged (INFO) and ends', async () => {
    const c = cenario({ getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' })] });
    const r = await c.rodar(inicial(ORIGEM_AGENDAMENTO_AMAZON.importacao));
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'nfe-em-processamento' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('INFO');
    expect(c.fila.tentativas).toEqual([]);
  });

  it('★ an OPEN cancellation request raises the existing aceitar-cancelamento, with zero POSTs', async () => {
    const c = cenario({
      getOrder: [
        ordem('PENDING_SCHEDULE', {
          linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
        }),
      ],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'avisado',
      motivo: 'cancelamento-solicitado',
      avisos: { levantados: 1, resolvidos: 0 },
    });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento)).toMatchObject({
      severidade: 'critico',
      resolvidoEm: null,
    });
    expect(posts(c)).toEqual([]);
  });

  it('coleta-cancelada and nf-nao-requerida write no aviso (the importer owns the first; step 14 the second’s posture)', async () => {
    const coleta = cenario({ getOrder: [ordem('LABEL_CANCELLED')] });
    await expect(coleta.rodar()).resolves.toMatchObject({ motivo: 'coleta-cancelada' });
    const naoRequerida = cenario({
      getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'NOT_REQUIRED' })],
    });
    const r = await naoRequerida.rodar();
    expect(r).toMatchObject({ motivo: 'nf-nao-requerida' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect([...posts(coleta), ...posts(naoRequerida)]).toEqual([]);
    expect([...coleta.fake.escritas, ...naoRequerida.fake.escritas]).toEqual([]);
  });
});

describe('the re-enqueue failure policy (the espera and pausa rungs)', () => {
  const processando = () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' });

  it('★ (mutation 18) the espera re-enqueue: a TRANSIENT throws on attempt 0 (zero POSTs were made), the WARNING agendamento-nao-reenfileirado on the last attempt; the tasks valve is the WARNING on attempt 0', async () => {
    const zero = cenario({ getOrder: [processando()] });
    zero.fila.falha = () => falhaDoFunctions('unavailable', 503);
    await expect(zero.rodar()).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(posts(zero)).toEqual([]);

    const ultima = cenario({ getOrder: [processando()] });
    ultima.tentativa = ULTIMA;
    ultima.fila.falha = () => falhaDoFunctions('unavailable', 503);
    const r = await ultima.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'agendamento-nao-reenfileirado',
      erro: 'AmazonTarefasTransitoriasError',
      reenfileiramento: 'espera',
      proxima: null,
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');

    const valvula = cenario({ getOrder: [processando()] });
    valvula.fila.desligado = true;
    await expect(valvula.rodar()).resolves.toMatchObject({
      motivo: 'agendamento-nao-reenfileirado',
      erro: 'AmazonAgendamentoTarefasDesligadasError',
      reenfileiramento: 'espera',
    });
    expect([...ultima.fake.escritas, ...valvula.fake.escritas]).toEqual([]);
  });

  it('★ (mutation 18) the pausa re-enqueue after a bulk 429: the same three', async () => {
    const zero = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    zero.fila.falha = () => falhaDoFunctions('unavailable', 503);
    await expect(zero.rodar()).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);

    const ultima = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    ultima.tentativa = ULTIMA;
    ultima.fila.falha = () => falhaDoFunctions('unavailable', 503);
    await expect(ultima.rodar()).resolves.toMatchObject({
      motivo: 'agendamento-nao-reenfileirado',
      erro: 'AmazonTarefasTransitoriasError',
      reenfileiramento: 'pausa',
    });

    const valvula = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    valvula.fila.desligado = true;
    await expect(valvula.rodar()).resolves.toMatchObject({
      motivo: 'agendamento-nao-reenfileirado',
      erro: 'AmazonAgendamentoTarefasDesligadasError',
      reenfileiramento: 'pausa',
    });
    // Each made its ONE bulk: the 429 was not processed, and nothing repeats it in-attempt.
    for (const c of [zero, ultima, valvula]) expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
  });

  it.each<[string, () => unknown, string]>([
    [
      'a missing region',
      () => new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']),
      'MissingRegionError',
    ],
    [
      'a malformed region',
      () => new AmazonAgendamentoRegiaoDaFilaInvalidaError(),
      'AmazonAgendamentoRegiaoDaFilaInvalidaError',
    ],
    [
      'a raw SDK failure',
      () => falhaDoFunctions('permission-denied', 403),
      'FirebaseFunctionsError/functions/permission-denied',
    ],
  ])(
    '★ %s on a re-enqueue is deterministic (a retry only repeats it): the WARNING on attempt 0, on both rungs, naming the class',
    async (_nome, falha, classe) => {
      const rungs: [Partial<Record<Rota, Roteiro[]>>, string][] = [
        [{ getOrder: [processando()] }, 'espera'],
        [{ bulk: [erro(429, 'QuotaExceeded')] }, 'pausa'],
      ];
      for (const [rotas, rung] of rungs) {
        const c = cenario(rotas);
        c.fila.falha = falha;
        const r = await c.rodar();
        expect(r, rung).toMatchObject({
          acao: 'descartado',
          motivo: 'agendamento-nao-reenfileirado',
          erro: classe,
          reenfileiramento: rung,
          proxima: null,
        });
        expect(severidadeDoDespachoAgendamentoAmazon(r), rung).toBe('WARNING');
      }
    },
  );

  it('★ (mutation 4) the espera and pausa re-enqueues go through the producer’s UNNAMED enfileirar (no id) — never enfileirarEntrada', async () => {
    const espera = cenario({ getOrder: [processando()] });
    await espera.rodar();
    const pausa = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    await pausa.rodar();
    for (const c of [espera, pausa]) {
      expect(c.espioes.enfileirar).toHaveBeenCalledTimes(1);
      expect(c.espioes.enfileirarEntrada).not.toHaveBeenCalled();
      expect(c.fila.enfileiradas.map((x) => x.id)).toEqual([null]);
    }
  });

  it('an UNNAMED failure of the re-enqueue propagates (rule 6)', async () => {
    const c = cenario({ getOrder: [processando()] });
    c.fila.falha = () => new TypeError('defeito');
    await expect(c.rodar()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('A8 — each bulk outcome', () => {
  it('★ MissingPackageDimensions (per order) raises dimensoes-ausentes, critico', async () => {
    const c = cenario({ bulk: [rejeitado('MissingPackageDimensions')] });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'avisado',
      motivo: 'dimensoes-ausentes',
      codigoRejeicao: 'MissingPackageDimensions',
      avisos: { levantados: 1, resolvidos: 0 },
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes)).toMatchObject({
      severidade: 'critico',
      resolvidoEm: null,
    });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)).toBeUndefined();
  });

  it('★ a TOP-LEVEL 4xx naming MissingPackageDimensions raises dimensoes-ausentes too (one code, one motivo, per order or top-level)', async () => {
    const c = cenario({ bulk: [erro(400, 'MissingPackageDimensions')] });
    await expect(c.rodar()).resolves.toMatchObject({ motivo: 'dimensoes-ausentes' });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes)?.resolvidoEm).toBeNull();
  });

  it.each(['InvalidOrderState', 'TimeSlotNotAvailable'])(
    '★ %s in the body raises agendamento-recusado (the code in the line only)',
    async (codigo) => {
      const c = cenario({ bulk: [rejeitado(codigo)] });
      const r = await c.rodar();
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo: 'agendamento-recusado',
        codigoRejeicao: codigo,
      });
      expect(aviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)).toMatchObject({
        severidade: 'critico',
        resolvidoEm: null,
        params: { pedido: ORDER, motivo: 'agendamento-recusado' },
      });
    },
  );

  it.each(['InternalServerError', 'RetryableAfterGettingNewSlots', 'ScheduleWindowExpired'])(
    '★ (mutation 20) %s in the body THROWS on attempt 0 with NO aviso',
    async (codigo) => {
      const c = cenario({ bulk: [rejeitado(codigo)] });
      const falha = await c.rodar().then(
        () => null,
        (err: unknown) => err,
      );
      expect(falha).toBeInstanceOf(AmazonAgendamentoTransitorioError);
      expect((falha as AmazonAgendamentoTransitorioError).codigos).toEqual([codigo]);
      expect(String((falha as Error).message)).not.toContain('texto da Amazon');
      expect(c.fake.escritas).toEqual([]);
      expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
    },
  );

  it('★ (mutations 10, 22) on the LAST attempt the code decides: InternalServerError is a WARNING with no aviso; each SLOT code raises agendamento-recusado', async () => {
    const outage = cenario({ bulk: [rejeitado('InternalServerError')] });
    outage.tentativa = ULTIMA;
    const r = await outage.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'amazon-indisponivel' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(outage.fake.escritas).toEqual([]);

    for (const codigo of ['RetryableAfterGettingNewSlots', 'ScheduleWindowExpired']) {
      const slot = cenario({ bulk: [rejeitado(codigo)] });
      slot.tentativa = ULTIMA;
      await expect(slot.rodar(), codigo).resolves.toMatchObject({
        acao: 'avisado',
        motivo: 'agendamento-recusado',
      });
      expect(aviso(slot, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm, codigo).toBeNull();
    }
  });

  it('★ a TOP-LEVEL 400 with a slot code does the same: throws on attempt 0, raises on the last', async () => {
    const zero = cenario({ bulk: [erro(400, 'RetryableAfterGettingNewSlots')] });
    await expect(zero.rodar()).rejects.toBeInstanceOf(AmazonAgendamentoTransitorioError);
    expect(zero.fake.escritas).toEqual([]);

    const ultima = cenario({ bulk: [erro(400, 'RetryableAfterGettingNewSlots')] });
    ultima.tentativa = ULTIMA;
    await expect(ultima.rodar()).resolves.toMatchObject({ motivo: 'agendamento-recusado' });
  });

  it('★ a TOP-LEVEL answer holding BOTH the outage code and a slot code, on the LAST attempt: the slot code wins (Amazon answered for this order), so the refusal is raised', async () => {
    const c = cenario({
      bulk: [
        {
          status: 400,
          corpo: {
            errors: [
              { code: 'InternalServerError', message: 'texto da Amazon' },
              { code: 'ScheduleWindowExpired', message: 'texto da Amazon' },
            ],
          },
        },
      ],
    });
    c.tentativa = ULTIMA;
    await expect(c.rodar()).resolves.toMatchObject({
      acao: 'avisado',
      motivo: 'agendamento-recusado',
    });
  });

  it('★ NEAR-MISS: InvalidTimeSlotId (we never send a slot) raises agendamento-recusado on attempt 0, with no throw', async () => {
    const c = cenario({ bulk: [rejeitado('InvalidTimeSlotId')] });
    await expect(c.rodar()).resolves.toMatchObject({
      acao: 'avisado',
      motivo: 'agendamento-recusado',
      codigoRejeicao: 'InvalidTimeSlotId',
    });
  });

  it('★ a top-level 400 ScheduledPackageAlreadyExists reads as scheduled: it resolves, raises nothing', async () => {
    const c = cenario({ bulk: [erro(400, 'ScheduledPackageAlreadyExists')] });
    await abrirAviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado);
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'ja-agendado',
      avisos: { levantados: 0, resolvidos: 1 },
      codigos: ['ScheduledPackageAlreadyExists'],
    });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm).not.toBeNull();
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes)).toBeUndefined();
  });

  it('per order, ScheduledPackageAlreadyExists is ja-agendado too; an answer naming neither our schedule nor our rejection is the WARNING resposta-sem-pedido, no aviso', async () => {
    const ja = cenario({ bulk: [rejeitado('ScheduledPackageAlreadyExists')] });
    await expect(ja.rodar()).resolves.toMatchObject({ acao: 'ja-agendado' });

    const vazia = cenario({
      bulk: [{ status: 200, corpo: { printableDocumentsUrl: SENTINELA.url } }],
    });
    const r = await vazia.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'resposta-sem-pedido' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(vazia.fake.escritas).toEqual([]);
  });

  it('★ (mutation 23) a SECOND 401 on the BULK (the refresh spent) is the ERROR line sem-permissao: NO aviso, no throw (NEAR-MISS: a first 401 is refreshed and retried once, and schedules)', async () => {
    const c = cenario({
      mint: [
        { status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } },
        { status: 200, corpo: { restrictedDataToken: `${RDT}-2`, expiresIn: 3600 } },
      ],
      bulk: [erro(401, 'Unauthorized'), erro(403, 'Unauthorized')],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'sem-permissao' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('ERROR');
    expect(escritasDeAviso(c)).toEqual([]);
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, 'LWA', POST_MINT, POST_BULK]);

    const uma = cenario({
      mint: [
        { status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } },
        { status: 200, corpo: { restrictedDataToken: `${RDT}-2`, expiresIn: 3600 } },
      ],
      bulk: [erro(401, 'Unauthorized'), BULK_OK],
    });
    await expect(uma.rodar()).resolves.toMatchObject({ acao: 'agendado' });
    expect(posts(uma)).toEqual([POST_MINT, POST_BULK, POST_MINT, POST_BULK]);
  });

  it('★ a credential parked between A4 and the write client’s getter: A4’s WARNING, ZERO POSTs, no aviso', async () => {
    const c = cenario();
    c.depoisDoGetOrder = () => {
      c.fake.seed(
        caminhoCredencial(CONTA),
        credencialDoc({
          reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
        }),
      );
    };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'conta-indisponivel' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(posts(c)).toEqual([]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ (a) the token MINT refused (400) is never a scheduling refusal: the ERROR line escrita-falhou, no bulk, no aviso (NEAR-MISS: the same 400 on the bulk raises agendamento-recusado)', async () => {
    const mint = cenario({ mint: [erro(400, 'InvalidRequest')] });
    const r = await mint.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'escrita-falhou',
      falha: 'http-definitivo',
      decisao: 'agendar',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('ERROR');
    expect(posts(mint)).toEqual([POST_MINT]);
    expect(mint.fake.escritas).toEqual([]);

    const bulk = cenario({ bulk: [erro(400, 'InvalidRequest')] });
    await expect(bulk.rodar()).resolves.toMatchObject({ motivo: 'agendamento-recusado' });
  });

  it('★ (a) the token MINT refused 401 then 403 (the refresh spent) is the ERROR line sem-permissao — no bulk, NO aviso, no throw (an app-wide grant, never this order)', async () => {
    const c = cenario({ mint: [erro(401, 'Unauthorized'), erro(403, 'Unauthorized')] });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'sem-permissao',
      falha: 'auth-sp-api',
      decisao: 'agendar',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('ERROR');
    // The forced refresh ran once, then the mint was refused again: no bulk left.
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, 'LWA', POST_MINT]);
    expect(escritasDeAviso(c)).toEqual([]);
  });

  it('★ (a) a 429 on the token MINT is the unnamed pause too: no throw, no bulk, no aviso (no queue attempt spent on a call Amazon did not process)', async () => {
    const c = cenario({ mint: [erro(429, 'QuotaExceeded')] });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'pausado',
      falha: 'pausa',
      reenfileiramento: 'pausa',
      decisao: 'agendar',
      proxima: { espera: 0, pausas: 1, atrasoS: PAUSAS_AGENDAMENTO_AMAZON_S[0] },
    });
    expect(posts(c)).toEqual([POST_MINT]);
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: { ...inicial(), pausas: 1 }, id: null, atrasoS: 30 },
    ]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ (a, rule 6) an AmazonConfigError in the write phase (nothing was sent: a bug) rethrows sanitized: no bulk, no aviso, no line of its own', async () => {
    // The minted token equal to the order id: the client refuses to send a body holding its own token.
    const c = cenario({
      mint: [{ status: 200, corpo: { restrictedDataToken: ORDER, expiresIn: 3600 } }],
    });
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(c)).toEqual([POST_MINT]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ (a) a NON-bulk transient in the write phase (the MINT’s 503) THROWS sanitized on attempt 0 with no bulk sent; on the LAST attempt it is the WARNING amazon-indisponivel — no throw, no aviso', async () => {
    const zero = cenario({ mint: [erro(503, 'ServiceUnavailable')] });
    await expect(zero.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(zero)).toEqual([POST_MINT]);

    const ultima = cenario({ mint: [erro(503, 'ServiceUnavailable')] });
    ultima.tentativa = ULTIMA;
    const r = await ultima.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'amazon-indisponivel',
      falha: 'transitorio',
      decisao: 'agendar',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(posts(ultima)).toEqual([POST_MINT]);
    expect([...zero.fake.escritas, ...ultima.fake.escritas]).toEqual([]);
  });

  it('a bulk 3xx (never followed, so Amazon processed nothing) is the ERROR line escrita-falhou — never a scheduling refusal, no aviso (NEAR-MISS: a 4xx on the bulk IS one)', async () => {
    const c = cenario({ bulk: [{ status: 302, corpo: {} }] });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'escrita-falhou',
      falha: 'http-definitivo',
    });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('ERROR');
    expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
    expect(escritasDeAviso(c)).toEqual([]);

    const quatro = cenario({ bulk: [{ status: 400, corpo: {} }] });
    await expect(quatro.rodar()).resolves.toMatchObject({ motivo: 'agendamento-recusado' });
  });

  it('★ (a) an LWA exchange refused while the write client refreshes: the WARNING conta-indisponivel, no bulk, no aviso', async () => {
    const c = cenario();
    // getOrder used the stored token; the write client then finds it stale.
    c.depoisDoGetOrder = () => {
      c.fake.seed(caminhoCredencial(CONTA), credencialDoc({ expirationDate: AGORA_MS - 1 }));
    };
    c.lwa.splice(0, c.lwa.length, () => erroLwa(400, 'invalid_grant'));
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'conta-indisponivel',
      falha: 'auth-lwa',
    });
    expect(posts(c)).toEqual([]);
    expect(c.chamadas).toEqual([GET_ORDER, 'LWA']);
    expect(escritasDeAviso(c)).toEqual([]);
  });

  it('★ ★ (mutation 19) THE PHASE: every definite read-side token (a getOrder 404, 403 after the refresh, 400, 2xx off its schema, an illegible read, an LWA exchange refused before it) gives the ERROR line leitura-falhou — ZERO POSTs, NO aviso, no throw', async () => {
    const casos: [string, Partial<Record<Rota, Roteiro[]>>, string][] = [
      ['getOrder 404', { getOrder: [erro(404, 'NotFound')] }, 'nao-encontrado'],
      [
        'getOrder 403 twice',
        { getOrder: [erro(403, 'Unauthorized'), erro(403, 'Unauthorized')] },
        'auth-sp-api',
      ],
      ['getOrder 400', { getOrder: [erro(400, 'InvalidInput')] }, 'http-definitivo'],
      [
        'getOrder off its schema',
        { getOrder: [{ status: 200, corpo: { order: 'x' } }] },
        'esquema',
      ],
      [
        'getOrder of another order',
        { getOrder: [ordem('PENDING_SCHEDULE', { extra: { orderId: '171-0000000-0000001' } })] },
        'ilegivel',
      ],
    ];
    const verificar = (
      nome: string,
      c: Cenario,
      r: ResultadoTarefaAgendamentoAmazon,
      f: string,
    ) => {
      expect(r, nome).toMatchObject({ acao: 'descartado', motivo: 'leitura-falhou', falha: f });
      expect(severidadeDoDespachoAgendamentoAmazon(r), nome).toBe('ERROR');
      expect(posts(c), nome).toEqual([]);
      expect(escritasDeAviso(c), nome).toEqual([]);
    };
    for (const [nome, rotas, falha] of casos) {
      const c = cenario(rotas);
      verificar(nome, c, await c.rodar(), falha);
    }

    const lwa = cenario();
    lwa.fake.seed(caminhoCredencial(CONTA), credencialDoc({ expirationDate: AGORA_MS - 1 }));
    lwa.lwa.splice(0, lwa.lwa.length, () => erroLwa(400, 'invalid_grant'));
    verificar('LWA refused before getOrder', lwa, await lwa.rodar(), 'auth-lwa');
    expect(lwa.chamadas).toEqual(['LWA']);
  });

  it('★ NEAR-MISS of THE PHASE: the same 404 on the BULK raises agendamento-recusado', async () => {
    const c = cenario({ bulk: [erro(404, 'InvalidOrderState')] });
    await expect(c.rodar()).resolves.toMatchObject({
      acao: 'avisado',
      motivo: 'agendamento-recusado',
      codigos: ['InvalidOrderState'],
    });
  });

  it('★ (mutation 9) a 429 on the bulk is a delayed re-enqueue with pausas + 1 and no throw; a 429 on getOrder too', async () => {
    const bulk = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    const r = await bulk.rodar();
    expect(r).toMatchObject({
      acao: 'pausado',
      reenfileiramento: 'pausa',
      proxima: { espera: 0, pausas: 1, atrasoS: PAUSAS_AGENDAMENTO_AMAZON_S[0] },
    });
    expect(bulk.fila.enfileiradas).toEqual([
      { tarefa: { ...inicial(), pausas: 1 }, id: null, atrasoS: 30 },
    ]);
    expect(bulk.fake.escritas).toEqual([]);

    const leitura = cenario({ getOrder: [erro(429, 'QuotaExceeded')] });
    await expect(leitura.rodar()).resolves.toMatchObject({
      acao: 'pausado',
      falha: 'pausa',
      proxima: { pausas: 1 },
    });
    expect(posts(leitura)).toEqual([]);
  });

  it.each([
    [0, 30],
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
  ])(
    '★ the pause ladder: a 429 at pausas %i waits %i s, its own rung — never the first one again, which would keep calling a throttled API',
    async (pausas, atrasoS) => {
      const c = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
      const tarefa = subir(pausaAgendamentoAmazon, pausas);
      await expect(c.rodar(tarefa)).resolves.toMatchObject({
        acao: 'pausado',
        proxima: { pausas: pausas + 1, atrasoS },
      });
      expect(c.fila.enfileiradas).toEqual([
        { tarefa: { ...tarefa, pausas: pausas + 1 }, id: null, atrasoS },
      ]);
    },
  );

  it('a 429 at the pause bound is the WARNING taxa-limitada, no re-enqueue', async () => {
    const c = cenario({ bulk: [erro(429, 'QuotaExceeded')] });
    const r = await c.rodar(subir(pausaAgendamentoAmazon, PAUSAS_AGENDAMENTO_AMAZON_S.length));
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'taxa-limitada' });
    expect(severidadeDoDespachoAgendamentoAmazon(r)).toBe('WARNING');
    expect(c.fila.tentativas).toEqual([]);
  });

  it('★ (mutations 8, 10) a bulk 5xx THROWS sanitized on attempt 0 — the bulk sent ONCE — and is a WARNING with no throw and no aviso on the last attempt', async () => {
    const zero = cenario({ bulk: [erro(503, 'ServiceUnavailable')] });
    await expect(zero.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(zero)).toEqual([POST_MINT, POST_BULK]);

    const ultima = cenario({ bulk: [erro(503, 'ServiceUnavailable')] });
    ultima.tentativa = ULTIMA;
    const r = await ultima.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'amazon-indisponivel' });
    expect(posts(ultima)).toEqual([POST_MINT, POST_BULK]);
    expect([...zero.fake.escritas, ...ultima.fake.escritas]).toEqual([]);
  });

  it('NEAR-MISS of the last attempt: the attempt before it still THROWS for the retry', async () => {
    const c = cenario({ bulk: [erro(503, 'ServiceUnavailable')] });
    c.tentativa = ULTIMA - 1;
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
  });

  it('a cut bulk (the network) or the bulk’s 2xx off its schema MAY have landed: throws for the retry; the MINT’s 2xx off its schema is the ERROR line escrita-falhou', async () => {
    const cortado = cenario({ bulk: [{ rede: true }] });
    await expect(cortado.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    const esquema = cenario({ bulk: [{ status: 200, corpo: { scheduledPackages: 'x' } }] });
    await expect(esquema.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    const esquemaUltima = cenario({ bulk: [{ status: 200, corpo: { scheduledPackages: 'x' } }] });
    esquemaUltima.tentativa = ULTIMA;
    await expect(esquemaUltima.rodar()).resolves.toMatchObject({ motivo: 'amazon-indisponivel' });

    const mint = cenario({ mint: [{ status: 200, corpo: { restrictedDataToken: 42 } }] });
    await expect(mint.rodar()).resolves.toMatchObject({
      motivo: 'escrita-falhou',
      falha: 'esquema',
    });
    expect(posts(mint)).toEqual([POST_MINT]);
  });

  it('★ (mutation 10) a lagging read (AmazonLeituraDefasadaError): throws on attempt 0; on the last attempt the WARNING amazon-indisponivel, no aviso', async () => {
    const adiante = pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US + 1 });
    const zero = cenario({}, adiante);
    await expect(zero.rodar()).rejects.toBeInstanceOf(AmazonLeituraDefasadaError);
    expect(posts(zero)).toEqual([]);

    const ultima = cenario({}, adiante);
    ultima.tentativa = ULTIMA;
    const r = await ultima.rodar();
    expect(r).toMatchObject({
      acao: 'descartado',
      motivo: 'amazon-indisponivel',
      falha: 'transitorio',
      erro: 'AmazonLeituraDefasadaError',
    });
    expect(ultima.fake.escritas).toEqual([]);
  });

  it('★ the INTEGRATION: a 5xx bulk on attempt 0, then the retry’s getOrder reads PENDING_PICK_UP ⇒ ZERO further POSTs, and it resolves', async () => {
    const c = cenario({
      getOrder: [ordem(), ordem('PENDING_PICK_UP')],
      bulk: [erro(503, 'ServiceUnavailable')],
    });
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
    c.tentativa = 1;
    await expect(c.rodar()).resolves.toMatchObject({ acao: 'ja-agendado' });
    expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
  });

  it('★ ★ THE RACE (step-15 plan §2.1): A3 reads, a CANCELLED import commits and seeds the resolve, then the bulk’s InvalidOrderState raise — clocked by the OLDER A3 read — is ignorado and no row stays open (NEAR-MISS: without the seed, the same raise opens a critico row)', async () => {
    const c = cenario({ bulk: [rejeitado('InvalidOrderState')] });
    c.depoisDoGetOrder = async () => {
      const commit = c.fake.seed(CAMINHO, pedidoRaw({ estado: ESTADO_PEDIDO.cancelado }));
      await semearResolucaoDoPedidoAmazon(
        asDb(c.fake),
        { nowMs: AGORA_MS },
        {
          integracaoId: CONTA,
          orderId: ORDER,
          pedidoId: PEDIDO_ID,
          motivos: [...MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON],
          relogio: commit,
        },
      );
    };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'avisado', avisos: { levantados: 0 } });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm).not.toBeNull();

    const semSemente = cenario({ bulk: [rejeitado('InvalidOrderState')] });
    await expect(semSemente.rodar()).resolves.toMatchObject({ avisos: { levantados: 1 } });
    expect(aviso(semSemente, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)).toMatchObject({
      severidade: 'critico',
      resolvidoEm: null,
    });
  });

  it('★ ★ NEAR-MISS of THE RACE: an A3 read AFTER the import that resolved the row raises — the clock is the READ time, never the pedido’s update time, which would EQUAL that import’s clock and be dropped', async () => {
    const c = cenario({ bulk: [rejeitado('InvalidOrderState')] });
    const commit = c.fake.seed(CAMINHO, pedidoRaw());
    await semearResolucaoDoPedidoAmazon(
      asDb(c.fake),
      { nowMs: AGORA_MS },
      {
        integracaoId: CONTA,
        orderId: ORDER,
        pedidoId: PEDIDO_ID,
        motivos: [...MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON],
        relogio: commit,
      },
    );
    await expect(c.rodar()).resolves.toMatchObject({
      acao: 'avisado',
      avisos: { levantados: 1 },
    });
    expect(aviso(c, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado)?.resolvidoEm).toBeNull();
  });

  it('★ an aviso write that fails PROPAGATES, raise and resolve alike: the retry re-reads, and swallowing it would lose the only signal of a refused order', async () => {
    const raise = cenario({ bulk: [rejeitado('InvalidOrderState')] });
    raise.fake.falharEscrita(caminhoDo(MOTIVO_PEDIDO_AMAZON.agendamentoRecusado), grpc(14, 'x'));
    await expect(raise.rodar()).rejects.toMatchObject({ code: 14 });

    const resolve = cenario({ getOrder: [ordem('PENDING_PICK_UP')] });
    await abrirAviso(resolve, MOTIVO_PEDIDO_AMAZON.dimensoesAusentes);
    resolve.fake.falharEscrita(caminhoDo(MOTIVO_PEDIDO_AMAZON.dimensoesAusentes), grpc(14, 'x'));
    await expect(resolve.rodar()).rejects.toMatchObject({ code: 14 });
  });
});

describe('the dispatch line and the logs (step-15 plan §3 decision 26)', () => {
  /** Every line a scenario's spy recorded, plus the dispatch line, as text. */
  function linhasComDespacho(c: Cenario, r: ResultadoTarefaAgendamentoAmazon): LinhaDeLog[] {
    registrarDespachoAgendamentoAmazon(c.log.logger, r, {
      tentativa: c.tentativa,
      idTarefa: ID_TAREFA,
    });
    return c.log.linhas;
  }
  const texto = (l: LinhaDeLog) => `${l.mensagem} ${JSON.stringify(l.meta ?? {})}`;
  const IDS_FEITOS_PELA_AMAZON = [
    SENTINELA.refPacote,
    SENTINELA.rastreioPedido,
    SENTINELA.pacoteBulk,
    SENTINELA.rastreioBulk,
    SENTINELA.slot,
  ];

  it('★ (mutation 15) no line carries https://, X-Amz-, Atz., ^XA or a 64+ base64 run; no line but the observer’s call lines carries a tracking, package or slot id — and the bulk’s call line DOES (the positive control)', async () => {
    const agendou = cenario();
    const recusou = cenario({ bulk: [rejeitado('InvalidOrderState')] });
    const linhas = [
      ...linhasComDespacho(agendou, await agendou.rodar()),
      ...linhasComDespacho(recusou, await recusou.rodar()),
    ];
    // Anti-vacuity: both runs reached the bulk, and the dispatch lines are in the scan.
    expect([...posts(agendou), ...posts(recusou)]).toHaveLength(4);
    expect(linhas.filter((l) => l.meta?.fila === 'processAmazonEasyShipSchedule')).toHaveLength(2);
    for (const l of linhas) {
      // The pedido id is 64 hex by design (an id, not a payload): masked before the run scan.
      const t = texto(l).split(PEDIDO_ID).join('<pedidoId>');
      for (const proibido of ['https://', 'X-Amz-', 'Atz.', '^XA']) {
        expect(t.includes(proibido), `${proibido} em ${t}`).toBe(false);
      }
      expect(t, t).not.toMatch(/[A-Za-z0-9+/=]{64,}/);
    }
    for (const l of linhas.filter((x) => x.meta?.evento !== 'chamada')) {
      for (const id of IDS_FEITOS_PELA_AMAZON) expect(texto(l), id).not.toContain(id);
    }
    // The positive control: the observer's bulk call line keeps Amazon's package
    // id (step 2b's design), so the scoping above is not vacuous.
    const chamadasDoBulk = agendou.log.linhas.filter(
      (l) =>
        l.meta?.evento === 'chamada' && String(l.meta.caminho ?? '').includes('/packages/bulk'),
    );
    expect(chamadasDoBulk).toHaveLength(1);
    expect(texto(chamadasDoBulk[0] as LinhaDeLog)).toContain(SENTINELA.pacoteBulk);
  });

  it('★ the package status reaches the result and the line ONLY through the enumCamel grammar: an Amazon value outside it is <outro>, never echoed (NEAR-MISS: ReadyForPickup passes as itself)', async () => {
    const foraDaGramatica = 'TRK-SENTINELA-STATUS-0001';
    const c = cenario({
      bulk: [
        {
          status: 200,
          corpo: {
            scheduledPackages: [
              {
                scheduledPackageId: { amazonOrderId: ORDER, packageId: SENTINELA.pacoteBulk },
                packageStatus: foraDaGramatica,
              },
            ],
            rejectedOrders: [],
          },
        },
      ],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'agendado', pacotes: 1, statusPacote: '<outro>' });
    const despacho = linhasComDespacho(c, r).filter((l) => l.meta?.evento === 'agendamento');
    expect(despacho.at(-1)?.meta).toMatchObject({ statusPacote: '<outro>' });
    for (const l of despacho) expect(texto(l)).not.toContain(foraDaGramatica);

    const ok = cenario();
    await expect(ok.rodar()).resolves.toMatchObject({ statusPacote: 'ReadyForPickup' });
  });

  it('★ the line carries an HTTP failure’s codes ONLY through the closed set: an unknown code is <outro>, while the result keeps it raw (NEAR-MISS: a known code passes as itself)', async () => {
    const fora = cenario({ bulk: [erro(400, 'CodigoForaDoConjuntoQualquer')] });
    const r = await fora.rodar();
    expect(r.codigos).toEqual(['CodigoForaDoConjuntoQualquer']);
    const linhasFora = linhasComDespacho(fora, r);
    expect(linhasFora.at(-1)?.meta).toMatchObject({ codigos: '<outro>' });
    expect(linhasFora.at(-1)?.meta?.fila).toBe('processAmazonEasyShipSchedule');

    const dentro = cenario({ bulk: [erro(404, 'InvalidOrderState')] });
    const linhasDentro = linhasComDespacho(dentro, await dentro.rodar());
    expect(linhasDentro.at(-1)?.meta).toMatchObject({ codigos: 'InvalidOrderState' });
  });

  it('the run’s SP-API call lines are filed under THIS flow, attempt and task — never another flow’s', async () => {
    const c = cenario();
    c.tentativa = 2;
    await c.rodar();
    const chamadas = c.log.linhas.filter((l) => l.meta?.evento === 'chamada');
    // Anti-vacuity: getOrder, the mint and the bulk each wrote its line.
    expect(chamadas).toHaveLength(3);
    for (const l of chamadas) {
      expect(l.meta).toMatchObject({ fluxo: 'agendamento', tentativa: 2, idTarefa: ID_TAREFA });
    }
  });

  it('the dispatch line: ONE evento agendamento line naming the queue, the closed result and the envelope; its severity follows the result', async () => {
    const c = cenario({ bulk: [rejeitado('MissingPackageDimensions')] });
    const r = await c.rodar();
    const antes = c.log.linhas.length;
    registrarDespachoAgendamentoAmazon(c.log.logger, r, { tentativa: 2, idTarefa: ID_TAREFA });
    const nova = c.log.linhas.slice(antes);
    expect(nova).toHaveLength(1);
    expect(nova[0]).toMatchObject({
      nivel: 'warn',
      meta: {
        evento: 'agendamento',
        fila: 'processAmazonEasyShipSchedule',
        acao: 'avisado',
        motivo: 'dimensoes-ausentes',
        origem: 'aceite-nfe',
        espera: 0,
        pausas: 0,
        pedidoId: PEDIDO_ID,
        pedido: ORDER,
        decisao: 'agendar',
        codigoRejeicao: 'MissingPackageDimensions',
        avisosLevantados: 1,
        conta: CONTA,
        fluxo: 'agendamento',
        tentativa: 2,
        idTarefa: ID_TAREFA,
      },
    });
    expect(severidadeDoDespachoAgendamentoAmazon({ ...r, acao: 'agendado', motivo: null })).toBe(
      'INFO',
    );
  });
});

describe('one pair of scheduling motivos', () => {
  it('the motivos the task raises and resolves are EXACTLY the importer’s scheduling pair', () => {
    expect([...MOTIVOS_AVISO_AGENDAMENTO_AMAZON].sort()).toEqual(
      [...MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON].sort(),
    );
    expect(MOTIVOS_AVISO_AGENDAMENTO_AMAZON).toHaveLength(2);
  });
});
