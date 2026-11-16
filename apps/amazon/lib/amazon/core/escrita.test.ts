/**
 * The write engine (step 14, PR 14-b), end to end against the REAL package
 * write client with an injected `fetch` — no network (D11): the valve gates,
 * the one diff line, the one write through the caller's own deps, and the
 * forced-refresh-once rule on a write. Step 15 (PR 15-b): the scheduling flow,
 * the restricted-client factory and the one client builder. Step 12a (PR 12-b):
 * the batch entry — the batch valve, every member under the valve, the canary
 * list's per-SKU answer, the whole-document dry-run, the one submission, the
 * refusal to build — and a price provider driving it with no stock module.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  type CredencialSpApi,
  type DocumentoListingsFeed,
  type EntradaDocumentoListingsFeed,
  type MensagemListingsFeed,
  type OpcoesClienteSpApi,
  type SpApiEscritaClient,
  criarDocumentoFeedAmazon,
  criarFeedAmazon,
  enviarNotaFiscal,
  montarDocumentoListingsFeed,
} from '@delfrance/integrations-amazon-sp-api';
import { MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { agendarNaAmazon } from '../agendamento/easyShipAmazon';
import {
  type AbortoLoteAmazon,
  type ContextoLoteAmazon,
  MOTIVO_ABORTO_LOTE,
  type MontagemLoteAmazon,
  type ProvedorLoteAmazon,
} from '../feeds/provedorLote';
import { type TarefaEnviarFeedAmazon, tarefaEnviarFeedAmazonSchema } from '../feeds/tarefaLote';
import { conteudoDaNfeAmazon } from '../nfe/conteudoNfe';
import { AGORA_MS, REF_VERSIONADA, linhasDeChamada, loggerEspiao } from '../testing/fixtures';
import {
  EVENTO_DA_ESCRITA_AMAZON,
  EVENTO_DO_LOTE_AMAZON,
  type EntradaLoteEscritaAmazon,
  type PlanoEscritaAmazon,
  type PlanoLoteAmazon,
  executarEscritaAmazon,
  executarLoteEscritaAmazon,
} from './escrita';
import {
  CANARIO_ENV_AMAZON,
  FLUXO_AMAZON,
  type FluxoComLoteAmazon,
  VALVULA_ENV_AMAZON,
  type ValvulaAmazon,
  lerValvula,
} from './valvulas';

/**
 * Every write client the engine builds, recorded (its options, the observer
 * included) and then built for real: the constructor is named only by the
 * engine's one builder, so this counts the builder's calls. Every feed document
 * the package builds is recorded too (step 12a): the engine never builds one,
 * and a caller builds none for a batch with no message.
 */
const construcoes = vi.hoisted(() => [] as unknown[]);
const documentosMontados = vi.hoisted(() => [] as unknown[]);
vi.mock('@delfrance/integrations-amazon-sp-api', async (original) => {
  const real = await original<typeof import('@delfrance/integrations-amazon-sp-api')>();
  return {
    ...real,
    criarClienteEscritaSpApi: (opts: OpcoesClienteSpApi) => {
      construcoes.push(opts);
      return real.criarClienteEscritaSpApi(opts);
    },
    montarDocumentoListingsFeed: (entrada: EntradaDocumentoListingsFeed): DocumentoListingsFeed => {
      documentosMontados.push(entrada);
      return real.montarDocumentoListingsFeed(entrada);
    },
  };
});

beforeEach(() => {
  construcoes.length = 0;
  documentosMontados.length = 0;
});

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const SENTINELA = 'SENTINELA-DO-CORPO-0123';
const XML = `<nfeProc><NFe>${SENTINELA}</NFe></nfeProc>`;

/** The NF-e valve as one environment states it. */
function valvula(modo: string | undefined, canario: string | undefined = `${CONTA}:${ORDER}`) {
  return lerValvula(FLUXO_AMAZON.nfe, {
    [VALVULA_ENV_AMAZON.nfe]: modo,
    [CANARIO_ENV_AMAZON.nfe]: canario,
  });
}

interface Pedido {
  readonly url: string;
  readonly metodo: string;
  readonly corpo: string | null;
  readonly cabecalhos: Headers;
}

/** A `fetch` that records each request (its body and headers included) and answers from a script. */
function fetchRoteirizado(...respostas: (() => Response)[]) {
  const pedidos: Pedido[] = [];
  const fila = [...respostas];
  const fetch = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    pedidos.push({
      url,
      metodo: init.method ?? 'GET',
      corpo: typeof init.body === 'string' ? init.body : null,
      cabecalhos: new Headers(init.headers),
    });
    const proxima = fila.shift();
    if (proxima === undefined) return Promise.reject(new Error('fetch não esperado'));
    return Promise.resolve(proxima());
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, pedidos, chamadas: fetch };
}

const json = (status: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

/** A context: the conta id and a recording credential getter. */
function contexto(integracaoId = CONTA) {
  const obterAcesso = vi.fn(
    (_opts?: { readonly forcarRenovacao?: boolean }): Promise<CredencialSpApi> =>
      Promise.resolve({ accessToken: 'tok|TESTE-acesso-escrita-naoreal', ref: REF_VERSIONADA }),
  );
  return { integracaoId, obterAcesso };
}

interface Plano extends PlanoEscritaAmazon {
  readonly nota: string;
}

/** One engine run of the NF-e submit shape; every seam a spy. */
function montar(
  o: {
    modo?: string;
    canario?: string;
    escrever?: boolean;
    respostas?: (() => Response)[];
    contaId?: string;
  } = {},
) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...(o.respostas ?? []));
  const ctx = contexto();
  const lerAtual = vi.fn(() => Promise.resolve('sem-nota'));
  const planejar = vi.fn(
    (atual: string): Plano => ({
      escrever: o.escrever ?? true,
      diff: { acao: o.escrever === false ? 'aceita' : 'enviaria', statusAmazon: atual },
      nota: XML,
    }),
  );
  const escrever = vi.fn((cliente: SpApiEscritaClient, plano: Plano) =>
    enviarNotaFiscal(cliente, { orderId: ORDER, ...conteudoDaNfeAmazon(plano.nota) }),
  );
  const run = () =>
    executarEscritaAmazon({
      valvula: valvula(o.modo, o.canario),
      contaId: o.contaId ?? CONTA,
      alvo: ORDER,
      contexto: ctx,
      deps: {
        logger,
        fetch: f.fetch,
        agora: () => AGORA_MS,
        gerarCorrelationId: () => 'corr-teste',
      },
      registro: { fluxo: 'nfe', tentativa: 0, idTarefa: 'tarefa-1' },
      lerAtual,
      planejar,
      escrever,
    });
  return { run, linhas, f, ctx, lerAtual, planejar, escrever };
}

describe('executarEscritaAmazon — the valve', () => {
  it.each([undefined, '', 'off', 'ON', ' on', 'true'])(
    '★ mutation 18: valve %j (off) ⇒ nothing read, nothing planned, nothing written, no line',
    async (modo) => {
      const m = montar({ modo });
      await expect(m.run()).resolves.toEqual({ tipo: 'desligado' });
      expect(m.lerAtual).not.toHaveBeenCalled();
      expect(m.planejar).not.toHaveBeenCalled();
      expect(m.escrever).not.toHaveBeenCalled();
      expect(m.f.chamadas).not.toHaveBeenCalled();
      expect(m.ctx.obterAcesso).not.toHaveBeenCalled();
      expect(m.linhas).toEqual([]);
    },
  );

  it('★ mutation 19: dry-run ⇒ read and planned, escrever NEVER called, exactly ONE diff line', async () => {
    const m = montar({ modo: 'dry-run' });
    const r = await m.run();
    expect(r).toMatchObject({ tipo: 'simulado', motivo: 'valvula', atual: 'sem-nota' });
    expect(m.lerAtual).toHaveBeenCalledTimes(1);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]).toEqual({
      nivel: 'info',
      mensagem: '[amazon] nfe: dry-run (valvula)',
      meta: {
        acao: 'enviaria',
        statusAmazon: 'sem-nota',
        modo: 'dry-run',
        motivoDryRun: 'valvula',
        escreveria: true,
        evento: 'nfe',
        conta: CONTA,
        fluxo: 'nfe',
        tentativa: 0,
        idTarefa: 'tarefa-1',
      },
    });
  });

  it('dry-run of a plan that would not write still logs its one line (escreveria false)', async () => {
    const m = montar({ modo: 'dry-run', escrever: false });
    await m.run();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({ acao: 'aceita', escreveria: false });
  });

  it('★ on OUTSIDE the canary ⇒ dry-run (fora-do-canario): no write, one line', async () => {
    const m = montar({ modo: 'on', canario: `${CONTA}:171-0000000-0000001` });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'fora-do-canario' });
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas.map((l) => l.meta?.motivoDryRun)).toEqual(['fora-do-canario']);
  });

  it('on with no canary list ⇒ dry-run (sem-canario)', async () => {
    const m = montar({ modo: 'on', canario: '' });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'sem-canario' });
    expect(m.escrever).not.toHaveBeenCalled();
  });

  it('a diff campo can never relabel the line: the engine’s own campos and the envelope win', async () => {
    const { logger, linhas } = loggerEspiao();
    await executarEscritaAmazon({
      valvula: valvula('dry-run'),
      contaId: CONTA,
      alvo: ORDER,
      contexto: contexto(),
      deps: { logger, agora: () => AGORA_MS },
      registro: { fluxo: 'outro' },
      lerAtual: () => Promise.resolve(null),
      planejar: () => ({
        escrever: true,
        diff: { modo: 'on', evento: 'chamada', conta: 'x', fluxo: 'y', escreveria: false },
      }),
      escrever: () => Promise.resolve(null),
    });
    expect(linhas[0]?.meta).toMatchObject({
      modo: 'dry-run',
      evento: EVENTO_DA_ESCRITA_AMAZON.nfe,
      conta: CONTA,
      fluxo: 'nfe',
      escreveria: true,
    });
  });
});

describe('executarEscritaAmazon — the one write', () => {
  it('★ on + canary ⇒ escrever called exactly ONCE, through a client built with the injected fetch', async () => {
    const m = montar({ modo: 'on', respostas: [json(200, {})] });
    const r = await m.run();
    expect(r).toEqual({
      tipo: 'escrito',
      atual: 'sem-nota',
      plano: expect.objectContaining({ escrever: true }) as unknown,
      resposta: { tipo: 'aceito-para-processamento' },
    });
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos).toHaveLength(1);
    expect(m.f.pedidos[0]?.metodo).toBe('POST');
    expect(m.f.pedidos[0]?.url).toContain('/delivery/2022-07-01/invoice?orderId=');
    // The body is the package's five keys; the engine added nothing.
    const corpo = JSON.parse(m.f.pedidos[0]?.corpo ?? '{}') as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(
      ['contentMD5Value', 'invoiceContent', 'invoiceType', 'marketplaceId', 'programType'].sort(),
    );
    // The credential getter is the context's, re-read per request (no forced refresh).
    expect(m.ctx.obterAcesso.mock.calls).toEqual([[]]);
    // The caller's clock reached the client: `x-amz-date` is AGORA_MS's, never
    // the wall clock's (2027-01-15T15:00:00Z in ISO-8601 basic).
    expect(m.f.pedidos[0]?.cabecalhos.get('x-amz-date')).toBe('20270115T150000Z');
  });

  it('★ the write’s call line: one, labelled by the context’s conta and the registro, never carrying the body', async () => {
    const m = montar({ modo: 'on', respostas: [json(200, {})] });
    await m.run();
    const chamadas = linhasDeChamada(m.linhas);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      evento: 'chamada',
      conta: CONTA,
      fluxo: 'nfe',
      tentativa: 0,
      idTarefa: 'tarefa-1',
      operacao: 'submitInvoice',
      metodo: 'POST',
      status: 200,
      correlationId: 'corr-teste',
    });
    // A real write logs its call line and NOTHING else — never a dry-run line.
    expect(m.linhas.map((l) => l.meta?.evento)).toEqual(['chamada']);
    expect(m.linhas.some((l) => l.meta?.modo === 'dry-run')).toBe(false);
    const tudo = JSON.stringify(m.linhas);
    expect(tudo).not.toContain(SENTINELA);
    expect(tudo).not.toContain(conteudoDaNfeAmazon(XML).invoiceContent);
    expect(tudo).not.toContain(conteudoDaNfeAmazon(XML).contentMD5Value);
    expect(tudo).not.toContain('tok|TESTE-acesso-escrita-naoreal');
  });

  it('on + canary and a plan that writes nothing ⇒ sem-escrita: no client call, no line', async () => {
    const m = montar({ modo: 'on', escrever: false });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'sem-escrita', atual: 'sem-nota' });
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toEqual([]);
  });

  it('on with canary * writes too', async () => {
    const m = montar({ modo: 'on', canario: '*', respostas: [json(200, {})] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(1);
  });

  it('★ a 401 on the write ⇒ ONE forced refresh and ONE retry', async () => {
    const m = montar({ modo: 'on', respostas: [json(401, {}), json(200, {})] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(m.f.pedidos).toHaveLength(2);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      1,
    );
  });

  it('★ a SECOND 401 propagates: no third call, one refresh', async () => {
    const m = montar({ modo: 'on', respostas: [json(401, {}), json(403, {}), json(200, {})] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonAuthError);
    expect(m.f.pedidos).toHaveLength(2);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      1,
    );
  });

  it('★ mutation 20: a 5xx (the write MAY have landed) propagates after ONE call — never repeated', async () => {
    const m = montar({ modo: 'on', respostas: [json(503, {}), json(200, {})] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonHttpError);
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos).toHaveLength(1);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      0,
    );
  });

  it('a failing current-state read propagates, and nothing is planned or written', async () => {
    const m = montar({ modo: 'on' });
    const falha = new Error('leitura');
    m.lerAtual.mockRejectedValueOnce(falha);
    await expect(m.run()).rejects.toBe(falha);
    expect(m.planejar).not.toHaveBeenCalled();
    expect(m.escrever).not.toHaveBeenCalled();
  });

  it('a target of another conta than the context’s is a programming error, before any read', async () => {
    const m = montar({ modo: 'on', contaId: 'outra-conta' });
    await expect(m.run()).rejects.toBeInstanceOf(TypeError);
    expect(m.lerAtual).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------------ */
/*              step 15 (PR 15-b): the scheduling flow and its clients             */
/* ------------------------------------------------------------------------------ */

const ACESSO_LWA = 'tok|TESTE-acesso-escrita-naoreal';
const RDT_1 = 'Atz.TESTE-rdt-um-sintetico-naoreal';
const RDT_2 = 'Atz.TESTE-rdt-dois-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';

/** The mint's 200, the model's shape. */
const rdt = (token: string) => json(200, { restrictedDataToken: token, expiresIn: 3600 });

/** The bulk's 200 for our order (no URL: the URL is not this suite's subject). */
const bulkOk = json(200, {
  scheduledPackages: [
    {
      scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-TESTE-1' },
      packageStatus: 'ReadyForPickup',
    },
  ],
});

/** The scheduling valve as one environment states it. */
function valvulaAgendamento(
  modo: string | undefined,
  canario: string | undefined = `${CONTA}:${ORDER}`,
) {
  return lerValvula(FLUXO_AMAZON.agendamento, {
    [VALVULA_ENV_AMAZON.agendamento]: modo,
    [CANARIO_ENV_AMAZON.agendamento]: canario,
  });
}

type Restrito = Parameters<typeof agendarNaAmazon>[1];

/** One engine run of the scheduling shape: the REAL mint and bulk through `agendarNaAmazon`. */
function montarAgendamento(o: { modo?: string; respostas?: (() => Response)[] } = {}) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...(o.respostas ?? []));
  const ctx = contexto();
  const lerAtual = vi.fn(() => Promise.resolve('agendar'));
  const escrever = vi.fn(
    (cliente: SpApiEscritaClient, _plano: PlanoEscritaAmazon, restrito: Restrito) =>
      agendarNaAmazon(cliente, restrito, ORDER),
  );
  const run = () =>
    executarEscritaAmazon({
      valvula: valvulaAgendamento(o.modo),
      contaId: CONTA,
      alvo: ORDER,
      contexto: ctx,
      deps: {
        logger,
        fetch: f.fetch,
        agora: () => AGORA_MS,
        gerarCorrelationId: () => 'corr-teste',
      },
      registro: { fluxo: 'agendamento', tentativa: 0, idTarefa: 'tarefa-agendamento-1' },
      lerAtual,
      planejar: (atual: string): PlanoEscritaAmazon => ({
        escrever: true,
        diff: { acao: atual, escreveria: true },
      }),
      escrever,
    });
  return { run, linhas, f, ctx, lerAtual, escrever };
}

const forcadas = (ctx: ReturnType<typeof contexto>) =>
  ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true);

const caminhos = (f: ReturnType<typeof fetchRoteirizado>) =>
  f.pedidos.map((p) => new URL(p.url).pathname);

describe('executarEscritaAmazon — the scheduling flow (step 15, PR 15-b)', () => {
  it('★ the flow has its own event row: agendamento (and, since step 12a, estoque)', () => {
    expect(EVENTO_DA_ESCRITA_AMAZON).toEqual({
      nfe: 'nfe',
      agendamento: 'agendamento',
      estoque: 'estoque',
    });
  });

  it('★ agendamento under off never calls lerAtual, and nothing reaches the network', async () => {
    const m = montarAgendamento({ modo: 'off' });
    await expect(m.run()).resolves.toEqual({ tipo: 'desligado' });
    expect(m.lerAtual).not.toHaveBeenCalled();
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toEqual([]);
  });

  it('★ agendamento under dry-run writes ONE line, evento agendamento, and never calls escrever', async () => {
    const m = montarAgendamento({ modo: 'dry-run' });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'valvula' });
    expect(m.lerAtual).toHaveBeenCalledTimes(1);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({
      evento: 'agendamento',
      fluxo: 'agendamento',
      conta: CONTA,
      modo: 'dry-run',
      escreveria: true,
    });
  });

  it('★ on + canary: escrever gets a restricted factory — the mint carries the LWA token, the bulk the RDT and never the LWA token', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(typeof m.escrever.mock.calls[0]?.[2]).toBe('function');
    expect(m.f.pedidos.map((p) => p.metodo)).toEqual(['POST', 'POST']);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK]);
    const [mint, bulk] = m.f.pedidos;
    expect(mint?.cabecalhos.get('x-amz-access-token')).toBe(ACESSO_LWA);
    expect(bulk?.cabecalhos.get('x-amz-access-token')).toBe(RDT_1);
    for (const [, valor] of bulk?.cabecalhos ?? []) expect(valor).not.toContain(ACESSO_LWA);
    // The bulk body is the package's three keys; the engine added nothing.
    expect(Object.keys(JSON.parse(bulk?.corpo ?? '{}') as object).sort()).toEqual(
      ['labelFormat', 'marketplaceId', 'orderScheduleDetailsList'].sort(),
    );
    // One getter read for the LWA request (the mint), one for the factory's
    // ref; the restricted client never reads it (it sends the token handed in).
    expect(m.ctx.obterAcesso.mock.calls).toEqual([[], []]);
  });

  it('★ the call lines: the mint says lwa-acesso, the bulk rdt — both labelled with the LWA ref’s version; no line holds either token', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] });
    await m.run();
    const chamadas = linhasDeChamada(m.linhas);
    expect(chamadas.map((l) => [l.operacao, l.credencial])).toEqual([
      ['createRestrictedDataToken', 'lwa-acesso'],
      ['createScheduledPackageBulk', 'rdt'],
    ]);
    for (const l of chamadas) {
      expect(l).toMatchObject({
        conta: CONTA,
        fluxo: 'agendamento',
        tentativa: 0,
        idTarefa: 'tarefa-agendamento-1',
        versaoCredencial: Number(REF_VERSIONADA.split('.')[1]),
      });
    }
    const tudo = JSON.stringify(m.linhas);
    expect(tudo).not.toContain(RDT_1);
    expect(tudo).not.toContain(ACESSO_LWA);
  });

  it('★ mutation 11: a 401 on the BULK ⇒ ONE forced refresh, and the retry MINTS A NEW token (two mints, two bulks)', async () => {
    const m = montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), bulkOk],
    });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK, CAMINHO_MINT, CAMINHO_BULK]);
    expect(m.f.pedidos[1]?.cabecalhos.get('x-amz-access-token')).toBe(RDT_1);
    expect(m.f.pedidos[3]?.cabecalhos.get('x-amz-access-token')).toBe(RDT_2);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('NEAR-MISS: a 401/403 on the SECOND bulk propagates — no third mint, one refresh', async () => {
    const m = montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), json(403, {}), rdt(RDT_1), bulkOk],
    });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonAuthError);
    expect(m.f.pedidos).toHaveLength(4);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('a 401 on the MINT refreshes once too: then one mint and one bulk', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [json(401, {}), rdt(RDT_1), bulkOk] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_MINT, CAMINHO_BULK]);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('a 5xx on the bulk propagates after ONE bulk — never repeated, never refreshed', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), json(503, {}), bulkOk] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonHttpError);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK]);
    expect(forcadas(m.ctx)).toHaveLength(0);
  });
});

describe('the one client builder (step 15, PR 15-b)', () => {
  it('★ mutation 10: a scheduling run builds TWO clients through the builder, each with its OWN observer; an NF-e run builds ONE', async () => {
    await montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] }).run();
    expect(construcoes).toHaveLength(2);
    const [lwa, restrito] = construcoes as OpcoesClienteSpApi[];
    expect(typeof lwa?.onChamada).toBe('function');
    expect(typeof restrito?.onChamada).toBe('function');
    expect(lwa?.onChamada).not.toBe(restrito?.onChamada);
    // The SAME deps reach both.
    expect(restrito?.fetch).toBe(lwa?.fetch);
    expect(restrito?.userAgent).toBe(lwa?.userAgent);
    expect(restrito?.agora).toBe(lwa?.agora);
    expect(restrito?.gerarCorrelationId).toBe(lwa?.gerarCorrelationId);

    construcoes.length = 0;
    await montar({ modo: 'on', respostas: [json(200, {})] }).run();
    expect(construcoes).toHaveLength(1);
  });

  it('a retried escrever builds a fresh restricted client: a run refreshed once builds THREE (the LWA client once per run)', async () => {
    await montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), bulkOk],
    }).run();
    expect(construcoes).toHaveLength(3);
  });

  it('dry-run and off build no client at all', async () => {
    await montarAgendamento({ modo: 'dry-run' }).run();
    await montarAgendamento({ modo: 'off' }).run();
    expect(construcoes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------ */
/*                       step 12a (PR 12-b): the batch entry                       */
/* ------------------------------------------------------------------------------ */

/** The seller a feed document's header declares: synthetic. */
const VENDEDOR = 'VENDEDOR-TESTE-SINTETICO';
const CAMINHO_DOCUMENTO_FEED = '/feeds/2021-06-30/documents';
const CAMINHO_FEED = '/feeds/2021-06-30/feeds';
/** A SKU the valve refuses as a target: a control character (U+0007). */
const SKU_INVALIDO = 'SKU-C\u0007';

/** `createFeedDocument`'s answer (the URL is synthetic and never fetched here). */
const documentoCriado = json(200, {
  feedDocumentId: 'amzn1.tortuga.4.na.TESTE-documento',
  url: 'https://upload-teste.invalid/documento',
});
/** `createFeed`'s answer. */
const feedCriado = json(202, { feedId: '50001' });

/** A batch fluxo's valve as one environment states it. */
function valvulaLote<F extends FluxoComLoteAmazon>(
  fluxo: F,
  modo: string | undefined,
  canario: string | undefined = '*',
): ValvulaAmazon<F> {
  return lerValvula(fluxo, {
    [VALVULA_ENV_AMAZON[fluxo]]: modo,
    [CANARIO_ENV_AMAZON[fluxo]]: canario,
  });
}

/** A plan as this suite's caller builds one: the document, plus the snapshot it was taken at. */
interface PlanoTeste extends PlanoLoteAmazon {
  readonly snapshotEmMs: number;
}

/**
 * This suite's caller: it turns a provider's `montar` answer into the engine's
 * plan. A refusal passes through untouched; a batch with no message becomes an
 * EMPTY plan without building a document (the package refuses a document with
 * no message, so building one would throw before the engine could answer);
 * anything else becomes the package's document.
 */
function planoDoLote(m: MontagemLoteAmazon): PlanoTeste | AbortoLoteAmazon {
  if ('abortado' in m) return m;
  if (m.mensagens.length === 0) {
    return { bytes: new Uint8Array(0), mensagens: 0, diff: m.diff, snapshotEmMs: m.snapshotEmMs };
  }
  const documento = montarDocumentoListingsFeed({ sellerId: VENDEDOR, mensagens: m.mensagens });
  return {
    bytes: documento.bytes,
    mensagens: documento.mensagens,
    diff: m.diff,
    snapshotEmMs: m.snapshotEmMs,
  };
}

/** One stock message: the fulfillment-availability merge. */
const mensagemEstoque = (sku: string): MensagemListingsFeed => ({
  sku,
  patches: [
    {
      op: 'merge',
      path: '/attributes/fulfillment_availability',
      value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }],
    },
  ],
});

/** The submission a caller would make: the document, then the feed (the upload is outside the client). */
async function submeter(cliente: SpApiEscritaClient): Promise<string> {
  const documento = await criarDocumentoFeedAmazon(cliente);
  const feed = await criarFeedAmazon(cliente, {
    inputFeedDocumentId: documento.dados.feedDocumentId,
  });
  return feed.dados.feedId;
}

/** One batch run of stock; every seam a spy. */
function montarLote(
  o: {
    modo?: string;
    canario?: string;
    membros?: readonly string[];
    respostas?: (() => Response)[];
    contaId?: string;
    montagem?: (on: readonly string[]) => MontagemLoteAmazon;
  } = {},
) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...(o.respostas ?? []));
  const ctx = contexto();
  const membros = o.membros ?? ['SKU-A', 'SKU-B', 'SKU-C'];
  const montagem =
    o.montagem ??
    ((on: readonly string[]): MontagemLoteAmazon => ({
      mensagens: on.map(mensagemEstoque),
      snapshotEmMs: AGORA_MS,
      diff: { acao: 'enviaria', skusMudados: on.length },
    }));
  const montar = vi.fn((on: readonly string[]) => Promise.resolve(planoDoLote(montagem(on))));
  const escrever = vi.fn((cliente: SpApiEscritaClient, _plano: PlanoTeste) => submeter(cliente));
  const entrada: EntradaLoteEscritaAmazon<PlanoTeste, AbortoLoteAmazon, string> = {
    valvula: valvulaLote(FLUXO_AMAZON.estoque, o.modo, o.canario),
    contaId: o.contaId ?? CONTA,
    contexto: ctx,
    deps: {
      logger,
      fetch: f.fetch,
      agora: () => AGORA_MS,
      gerarCorrelationId: () => 'corr-teste',
    },
    registro: { fluxo: 'estoque', tentativa: 0, idTarefa: 'tarefa-lote-1' },
    membros,
    montar,
    escrever,
  };
  const run = () => executarLoteEscritaAmazon(entrada);
  return { run, linhas, f, ctx, montar, escrever };
}

describe('executarLoteEscritaAmazon — the batch under the valve (step 12a, PR 12-b)', () => {
  it.each([undefined, '', 'off', 'ON', ' on', 'feed'])(
    '★ valve %j (off) ⇒ neither montar nor escrever, no client, no line',
    async (modo) => {
      const m = montarLote({ modo });
      await expect(m.run()).resolves.toEqual({ tipo: 'desligado' });
      expect(m.montar).not.toHaveBeenCalled();
      expect(m.escrever).not.toHaveBeenCalled();
      expect(m.f.chamadas).not.toHaveBeenCalled();
      expect(m.ctx.obterAcesso).not.toHaveBeenCalled();
      expect(construcoes).toHaveLength(0);
      expect(m.linhas).toEqual([]);
    },
  );

  it('★ mutation 2: dry-run ⇒ montar with EVERY member, escrever NEVER, exactly ONE line', async () => {
    const m = montarLote({ modo: 'dry-run' });
    const r = await m.run();
    expect(r).toMatchObject({
      tipo: 'simulado',
      motivo: 'valvula',
      contagem: { total: 3, on: 0, fora: { valvula: 3 } },
    });
    expect(m.montar.mock.calls).toEqual([[['SKU-A', 'SKU-B', 'SKU-C']]]);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(construcoes).toHaveLength(0);
    const bytes = r.tipo === 'simulado' ? r.plano.bytes.byteLength : -1;
    expect(bytes).toBeGreaterThan(0);
    expect(m.linhas).toEqual([
      {
        nivel: 'info',
        mensagem: '[amazon] estoque: feed dry-run (valvula)',
        meta: {
          acao: 'enviaria',
          skusMudados: 3,
          fase: 'feed',
          modo: 'dry-run',
          motivoDryRun: 'valvula',
          mensagens: 3,
          bytes,
          membros: 3,
          membrosOn: 0,
          foraDoLote: 'valvula:3',
          evento: 'estoque',
          conta: CONTA,
          fluxo: 'estoque',
          tentativa: 0,
          idTarefa: 'tarefa-lote-1',
        },
      },
    ]);
  });

  it('a diff campo can never relabel the batch line: the engine’s own campos and the envelope win', async () => {
    const m = montarLote({
      modo: 'dry-run',
      montagem: (on) => ({
        mensagens: on.map(mensagemEstoque),
        snapshotEmMs: AGORA_MS,
        diff: {
          fase: 'resultado',
          modo: 'on',
          motivoDryRun: 'nenhum',
          mensagens: 999,
          bytes: 1,
          membros: 0,
          membrosOn: 999,
          foraDoLote: 'nada',
          evento: 'chamada',
          conta: 'x',
          fluxo: 'y',
        },
      }),
    });
    await m.run();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({
      fase: 'feed',
      modo: 'dry-run',
      motivoDryRun: 'valvula',
      mensagens: 3,
      membros: 3,
      membrosOn: 0,
      foraDoLote: 'valvula:3',
      evento: EVENTO_DO_LOTE_AMAZON.estoque,
      conta: CONTA,
      fluxo: 'estoque',
    });
    expect(m.linhas[0]?.meta?.bytes).toBeGreaterThan(1);
  });

  it('★ mutation 2 (NEAR-MISS): dry-run under a canary LIST still builds the WHOLE document, never the canary members only', async () => {
    const m = montarLote({ modo: 'dry-run', canario: `${CONTA}:SKU-A` });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'valvula' });
    expect(m.montar.mock.calls).toEqual([[['SKU-A', 'SKU-B', 'SKU-C']]]);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
  });

  it('on with no canary list ⇒ dry-run (sem-canario): the whole document — an invalid SKU included, and counted — one line, nothing posted', async () => {
    const m = montarLote({ modo: 'on', canario: '', membros: ['SKU-A', SKU_INVALIDO, 'SKU-B'] });
    await expect(m.run()).resolves.toMatchObject({
      tipo: 'simulado',
      motivo: 'sem-canario',
      contagem: { total: 3, on: 0, fora: { 'sem-canario': 2, 'alvo-invalido': 1 } },
    });
    // The dry-run shows the whole document, every member as given.
    expect(m.montar.mock.calls).toEqual([[['SKU-A', SKU_INVALIDO, 'SKU-B']]]);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.linhas.map((l) => [l.meta?.evento, l.meta?.motivoDryRun])).toEqual([
      ['estoque', 'sem-canario'],
    ]);
    // Two motivos in one campo: sorted, never in member order.
    expect(m.linhas[0]?.meta?.foraDoLote).toBe('alvo-invalido:1,sem-canario:2');
  });

  it('★ mutations 1 and 3: on under a canary LIST ⇒ so-patches with EXACTLY the canary hits; nothing built, nothing written', async () => {
    const m = montarLote({ modo: 'on', canario: `${CONTA}:SKU-A,${CONTA}:SKU-B` });
    await expect(m.run()).resolves.toEqual({
      tipo: 'so-patches',
      membros: ['SKU-A', 'SKU-B'],
      contagem: { total: 3, on: 2, fora: { 'fora-do-canario': 1 } },
    });
    expect(m.montar).not.toHaveBeenCalled();
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(construcoes).toHaveLength(0);
    expect(documentosMontados).toHaveLength(0);
    expect(m.linhas).toEqual([]);
  });

  it('★ so-patches with no member on the list answers an EMPTY list (never every member)', async () => {
    const m = montarLote({ modo: 'on', canario: `${CONTA}:SKU-Z` });
    await expect(m.run()).resolves.toMatchObject({
      tipo: 'so-patches',
      membros: [],
      contagem: { total: 3, on: 0, fora: { 'fora-do-canario': 3 } },
    });
  });
});

describe('executarLoteEscritaAmazon — the one submission (step 12a, PR 12-b)', () => {
  it('★ feed (on + *) ⇒ montar with the ON members only: an invalid SKU never reaches it and is counted; ONE escrever, through the injected fetch', async () => {
    const m = montarLote({
      modo: 'on',
      membros: ['SKU-A', SKU_INVALIDO, 'SKU-B'],
      respostas: [documentoCriado, feedCriado],
    });
    const r = await m.run();
    expect(r).toMatchObject({
      tipo: 'escrito',
      resposta: '50001',
      plano: { mensagens: 2 },
      contagem: { total: 3, on: 2, fora: { 'alvo-invalido': 1 } },
    });
    expect(m.montar.mock.calls).toEqual([[['SKU-A', 'SKU-B']]]);
    expect(m.escrever).toHaveBeenCalledTimes(1);
    // The engine hands `escrever` exactly the plan `montar` answered.
    expect(m.escrever.mock.calls[0]?.[1]).toBe(r.tipo === 'escrito' ? r.plano : null);
    expect(m.f.pedidos.map((p) => [p.metodo, new URL(p.url).pathname])).toEqual([
      ['POST', CAMINHO_DOCUMENTO_FEED],
      ['POST', CAMINHO_FEED],
    ]);
    // One LWA client, built once per run; no forced refresh.
    expect(construcoes).toHaveLength(1);
    expect(m.ctx.obterAcesso.mock.calls).toEqual([[], []]);
    // The document is the caller's: built once, from the ON members.
    expect(documentosMontados).toEqual([
      { sellerId: VENDEDOR, mensagens: [mensagemEstoque('SKU-A'), mensagemEstoque('SKU-B')] },
    ]);
    // A real submission logs its call lines and NOTHING else.
    expect(m.linhas.map((l) => l.meta?.evento)).toEqual(['chamada', 'chamada']);
    expect(linhasDeChamada(m.linhas).map((l) => [l.conta, l.fluxo, l.operacao])).toEqual([
      [CONTA, 'estoque', 'createFeedDocument'],
      [CONTA, 'estoque', 'createFeed'],
    ]);
  });

  it('★ montar answering ZERO messages under feed ⇒ sem-escrita: no escrever, no client, no document built', async () => {
    const m = montarLote({
      modo: 'on',
      montagem: () => ({ mensagens: [], snapshotEmMs: AGORA_MS, diff: { acao: 'igual' } }),
    });
    await expect(m.run()).resolves.toMatchObject({
      tipo: 'sem-escrita',
      plano: { mensagens: 0 },
      contagem: { total: 3, on: 3, fora: {} },
    });
    expect(m.montar).toHaveBeenCalledTimes(1);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(construcoes).toHaveLength(0);
    expect(documentosMontados).toHaveLength(0);
    expect(m.linhas).toEqual([]);
  });

  it('★ montar answering ZERO messages under dry-run ⇒ ONE line that says 0 messages and 0 bytes; no document built', async () => {
    const m = montarLote({
      modo: 'dry-run',
      montagem: () => ({ mensagens: [], snapshotEmMs: AGORA_MS, diff: { acao: 'igual' } }),
    });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', plano: { mensagens: 0 } });
    expect(documentosMontados).toHaveLength(0);
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({
      evento: 'estoque',
      fase: 'feed',
      acao: 'igual',
      mensagens: 0,
      bytes: 0,
      membros: 3,
    });
  });

  it.each(['on', 'dry-run'])(
    '★ montar refusing to build (snapshot-lento) under %s ⇒ abortado, the refusal whole: escrever never called, no line',
    async (modo) => {
      const m = montarLote({
        modo,
        montagem: () => ({
          abortado: MOTIVO_ABORTO_LOTE.snapshotLento,
          aviso: MOTIVO_CONTA_AMAZON.contaSemOperacao,
        }),
      });
      await expect(m.run()).resolves.toMatchObject({
        tipo: 'abortado',
        motivo: 'snapshot-lento',
        aborto: { abortado: 'snapshot-lento', aviso: MOTIVO_CONTA_AMAZON.contaSemOperacao },
        contagem: { total: 3 },
      });
      expect(m.montar).toHaveBeenCalledTimes(1);
      expect(m.escrever).not.toHaveBeenCalled();
      expect(m.f.chamadas).not.toHaveBeenCalled();
      expect(construcoes).toHaveLength(0);
      expect(m.linhas).toEqual([]);
    },
  );

  it('★ a 401 inside escrever ⇒ ONE forced refresh and the WHOLE escrever once more (a new document, a new submission)', async () => {
    const m = montarLote({
      modo: 'on',
      respostas: [documentoCriado, json(401, {}), documentoCriado, feedCriado],
    });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito', resposta: '50001' });
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(m.montar).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos.map((p) => new URL(p.url).pathname)).toEqual([
      CAMINHO_DOCUMENTO_FEED,
      CAMINHO_FEED,
      CAMINHO_DOCUMENTO_FEED,
      CAMINHO_FEED,
    ]);
    expect(forcadas(m.ctx)).toHaveLength(1);
    // The LWA client is built once per run, the refresh included.
    expect(construcoes).toHaveLength(1);
  });

  it('NEAR-MISS: a 401/403 that persists after the refresh propagates untouched — no third escrever', async () => {
    const m = montarLote({
      modo: 'on',
      respostas: [documentoCriado, json(401, {}), documentoCriado, json(403, {}), feedCriado],
    });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonAuthError);
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(m.f.pedidos).toHaveLength(4);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('★ a 500 on the submission (it MAY have landed) propagates untouched after ONE escrever — never repeated, never refreshed', async () => {
    const m = montarLote({ modo: 'on', respostas: [documentoCriado, json(500, {}), feedCriado] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonHttpError);
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos).toHaveLength(2);
    expect(forcadas(m.ctx)).toHaveLength(0);
  });

  it.each(['off', 'dry-run', 'on'])(
    '★ a batch of another conta than the context’s is a programming error (TypeError) under %s, checked FIRST, before anything is built',
    async (modo) => {
      const m = montarLote({ modo, contaId: 'outra-conta' });
      await expect(m.run()).rejects.toBeInstanceOf(TypeError);
      expect(m.montar).not.toHaveBeenCalled();
      expect(m.escrever).not.toHaveBeenCalled();
      expect(m.linhas).toEqual([]);
    },
  );

  it('★ the event maps: the batch entry has its OWN, total over the batch fluxos', () => {
    expect(EVENTO_DO_LOTE_AMAZON).toEqual({ estoque: 'estoque', preco: 'preco' });
    expect(EVENTO_DA_ESCRITA_AMAZON).toEqual({
      nfe: 'nfe',
      agendamento: 'agendamento',
      estoque: 'estoque',
    });
    // The batch entry's valve is typed by the batch fluxos, never by the first
    // entry's event map (which has no `preco` row).
    expectTypeOf<
      EntradaLoteEscritaAmazon<PlanoLoteAmazon, AbortoLoteAmazon, unknown>['valvula']
    >().toEqualTypeOf<ValvulaAmazon<FluxoComLoteAmazon>>();
    expectTypeOf<ValvulaAmazon<'preco'>>().toMatchTypeOf<
      EntradaLoteEscritaAmazon<PlanoLoteAmazon, AbortoLoteAmazon, unknown>['valvula']
    >();
  });
});

/** What this suite's price provider hands its `montar`. */
interface DadosPreco {
  readonly precos: ReadonlyMap<string, number>;
}

/** One price message: the purchasable-offer replace. */
const mensagemPreco = (sku: string, valor: number): MensagemListingsFeed => ({
  sku,
  patches: [
    {
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [{ currency: 'BRL', our_price: [{ schedule: [{ value_with_tax: valor }] }] }],
    },
  ],
});

/**
 * A PRICE provider, fluxo-neutral by construction: it imports no stock module,
 * and drives the batch entry through the seam exactly as any fluxo would.
 */
const provedorPreco: ProvedorLoteAmazon<typeof FLUXO_AMAZON.preco, DadosPreco> = {
  fluxo: FLUXO_AMAZON.preco,
  membros: () =>
    Promise.resolve({
      skus: ['PRECO-1', 'PRECO-2'],
      dados: {
        precos: new Map([
          ['PRECO-1', 19.9],
          ['PRECO-2', 29.9],
        ]),
      },
    }),
  montar: (ctx, _entrada, membrosOn, dados) =>
    Promise.resolve({
      mensagens: membrosOn.map((sku) => mensagemPreco(sku, dados.precos.get(sku) ?? 0)),
      snapshotEmMs: ctx.agora(),
      diff: { acao: 'enviaria', precosMudados: membrosOn.length },
    }),
  gravarResultado: () => Promise.resolve(),
  recuperar: () => Promise.resolve({ nada: true }),
  repassarParaPatches: (_ctx, _entrada, skus) => Promise.resolve({ tarefas: skus.length }),
  motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
};

/** The price batch's payload, through the strict jobs-queue schema. */
const entradaPreco = tarefaEnviarFeedAmazonSchema.parse({
  v: 1,
  tipo: 'feed-enviar',
  fluxo: FLUXO_AMAZON.preco,
  contaId: CONTA,
  execucaoId: 'execucao-preco-1',
  origem: 'operador',
  lote: { tipo: 'blocos', partes: 1, esperaAteMs: AGORA_MS + 60 * 60_000 },
}) as TarefaEnviarFeedAmazon & { readonly fluxo: typeof FLUXO_AMAZON.preco };

/** One price batch run, the provider's members and build bound the way a caller binds them. */
async function montarLotePreco(modo: string, respostas: (() => Response)[] = []) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...respostas);
  const ctx = contexto();
  const ctxLote = { agora: () => AGORA_MS, sellerId: VENDEDOR } as unknown as ContextoLoteAmazon;
  const valvula: ValvulaAmazon<'preco'> = valvulaLote(FLUXO_AMAZON.preco, modo);
  const membros = await provedorPreco.membros(ctxLote, entradaPreco);
  if ('abortado' in membros) throw new TypeError('o provedor de teste não aborta');
  const r = await executarLoteEscritaAmazon({
    valvula,
    contaId: CONTA,
    contexto: ctx,
    deps: { logger, fetch: f.fetch, agora: () => AGORA_MS, gerarCorrelationId: () => 'corr-teste' },
    registro: { fluxo: 'preco', tentativa: 0, idTarefa: 'tarefa-preco-1' },
    membros: membros.skus,
    montar: async (on) =>
      planoDoLote(await provedorPreco.montar(ctxLote, entradaPreco, on, membros.dados)),
    escrever: (cliente) => submeter(cliente),
  });
  return { r, linhas, f };
}

describe('the batch entry is fluxo-neutral: a price provider drives it with no stock module (step 12a, PR 12-b)', () => {
  it('★ mutation 13: a ValvulaAmazon<preco> type-checks, and its dry-run line says evento preco', async () => {
    const { r, linhas, f } = await montarLotePreco('dry-run');
    expect(r).toMatchObject({ tipo: 'simulado', plano: { mensagens: 2 } });
    expect(f.chamadas).not.toHaveBeenCalled();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.mensagem).toBe('[amazon] preco: feed dry-run (valvula)');
    expect(linhas[0]?.meta).toMatchObject({
      evento: 'preco',
      fluxo: 'preco',
      fase: 'feed',
      acao: 'enviaria',
      precosMudados: 2,
      mensagens: 2,
      membros: 2,
    });
  });

  it('★ under on + * the price batch is submitted once, labelled preco', async () => {
    const { r, linhas, f } = await montarLotePreco('on', [documentoCriado, feedCriado]);
    expect(r).toMatchObject({ tipo: 'escrito', resposta: '50001', plano: { mensagens: 2 } });
    expect(f.pedidos.map((p) => new URL(p.url).pathname)).toEqual([
      CAMINHO_DOCUMENTO_FEED,
      CAMINHO_FEED,
    ]);
    expect(linhasDeChamada(linhas).map((l) => l.fluxo)).toEqual(['preco', 'preco']);
    expect(documentosMontados).toHaveLength(1);
  });
});
