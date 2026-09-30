import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import { saveBlob } from '@/lib/download/saveBlob';
import type { TamanhoFolha } from '@/lib/print-agent/printJob';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  type ShopeeClient,
  type ShopeeEtiquetaPedido,
  type ShopeeEtiquetaResposta,
} from '@/lib/shopee/client';
import type { EscolhaDeEnvio, Progresso } from '@/lib/shopee/wire';

import type {
  CheckoutEtiquetaProvider,
  EtiquetaOutcome,
  EtiquetaProviderDeps,
  EtiquetaProviderInput,
  EtiquetaProviderUi,
} from '../types';

/**
 * Shopee etiqueta provider (#1523, step 15) — a bounded, RESUMABLE loop over
 * ONE route, `POST /api/marketplace/shopee/etiqueta` on `apps/shopee`.
 *
 * The route is stateless: every call re-derives the phase from Shopee (the
 * arrange, the courier's tracking number, the document task) and answers the
 * label (200), a wait or a question (202), or a refusal (409/403). So this
 * provider holds no flow state beyond ONE click: it loops on the 202s, answers
 * each question through `ui.escolherEnvio`, and gives up with a deterministic
 * "clique de novo" sentence. Re-clicking IS the resume path, and it is safe
 * only because the SERVER never ships a package twice (`package_already_shipped`
 * reads as arranged) — the whole bound below rests on that.
 *
 * ## The bounds (`SHOPEE_ETIQUETA_LIMITES`, reconcile R-b)
 *
 * - `totalMs` — MACHINE time per click: the calls and the sleeps. ⚠️ The
 *   operator's dialog time is EXCLUDED (W9): a pickup question someone is
 *   reading must never be what runs the click out of time.
 * - `pisoPorChamadaMs` — the least a call needs: the server's 30 s budget plus
 *   one download. Before each call `restante = totalMs − gasto`; a call whose
 *   `restante` is below the floor is NOT started — the click gives up with the
 *   resumable sentence — unless it carries the operator's answer (`envio`),
 *   which is never thrown away for want of time.
 * - `porChamadaMs` — the ceiling of one call's `AbortSignal`, below App
 *   Hosting's 180 s. The signal actually fires at
 *   `min(porChamadaMs, max(restante, pisoPorChamadaMs))`, so a call cannot run
 *   past `totalMs` — except the answer's call, which still gets the floor.
 * - `esperaMinMs`/`esperaMaxMs` — the server's `tentarEmMs` is clamped: a `0`
 *   would hot-loop (W10), a huge value would outlive the click. A wait after
 *   which no call could start is not slept at all: the click gives up at once,
 *   and without the phase toast a give-up would contradict.
 * - `maxPerguntas` — per PACKAGE: a backend that keeps asking about the same
 *   package becomes an error, not a hang. Per package, not per click: a split
 *   order asks each package once, and more packages than the cap is a
 *   legitimate order, not a backend that ignored an answer.
 *
 * ⚠️ The honest bound: no call starts after `totalMs`; a click holds the
 * station at most `totalMs` of machine time, plus at most ONE call of
 * `pisoPorChamadaMs` when that call carries the operator's answer — ≤ 165 s
 * with the values below. The checkout awaits this provider before it resets
 * the screen, so that is also how long the provider holds a station. NOT in
 * it: the operator's dialogs and the print agent's hand-off (`printJob`,
 * unbounded until #1678), once per file.
 *
 * Why an early abort is safe: the route is resumable, and a re-click
 * re-derives the phase from Shopee and never ships a package twice.
 *
 * Unlike `reprintCheckout.ts`'s unbounded registry stage, bounding HERE is
 * safe: the side effect (`ship_order`) is idempotent BY THE SERVER's
 * construction and a re-download is the same document (guide 644: "no limit
 * to the number of times it can be printed"), so "timeout, then re-click"
 * converges instead of buying a second label.
 *
 * ## What it never does
 *
 * - It never reads `frete.externalId` (W18): step 5 writes `null` there on
 *   every multi-package order by design, so Mercado Livre's guard would refuse
 *   every split order. The server resolves the packages.
 * - It never re-sends an answer (W11): `envio` rides exactly the ONE call after
 *   the question; a later re-ask is answered again.
 * - It never re-drives the NF-e: a `nfe-pendente` 409 is terminal, and its
 *   sentence already says what the SERVER did about it.
 * - It never hands the print agent a type the agent cannot route: the agent
 *   compares `contentType` with `==` and answers 200 for a type it cannot
 *   print, printing nothing (§8 of the web design). Such a file is DOWNLOADED.
 *
 * ⚠️ `reimpressao: 'mesmo-documento'` — the registry skips the posted-risk
 * confirm for this provider (R-f): its rationale is a duplicate PAID label,
 * which a Shopee reprint cannot produce, and without the skip the confirm
 * would fire on every reprint (`aguardandoPostagem` is what step 7 maps right
 * after our own `ship_order`) and on step 14's `error` stamp.
 */

/* --------------------------------- the bounds -------------------------------- */

/** The loop's bounds (reconcile R-b) — see the module docblock. */
export const SHOPEE_ETIQUETA_LIMITES = {
  /** Machine time per click (calls + sleeps; dialogs EXCLUDED). Probe P4/P6 may raise it. */
  totalMs: 120_000,
  /** The ceiling of one call's `AbortSignal` (it fires sooner when the click's budget is shorter). */
  porChamadaMs: 75_000,
  /**
   * The least a call is started with: the server's 30 s budget plus one
   * download. Below it the click gives up — unless the call carries an answer.
   */
  pisoPorChamadaMs: 45_000,
  /** The floor of the server's `tentarEmMs` (a `0` would hot-loop). */
  esperaMinMs: 2_000,
  /** The ceiling of the server's `tentarEmMs` (a huge one would outlive the click). */
  esperaMaxMs: 15_000,
  /** Questions per PACKAGE per click (a split order asks each package once). */
  maxPerguntas: 8,
} as const;

type LimitesDaEtiqueta = { readonly [K in keyof typeof SHOPEE_ETIQUETA_LIMITES]: number };

/**
 * The sheet a Shopee PDF prints on. LEGACY PARITY and UNVERIFIED (Lucas,
 * 2026-09-30, reconcile Appendix A C2): the legacy sent the NORMAL PDF to the A4
 * printer. It is ONE constant, flipped to `'etq'` once the first real BR label
 * shows a 10×15 page.
 */
export const TAMANHO_DO_PDF_SHOPEE: TamanhoFolha = 'a4';

/* ------------------------------ the print agent ------------------------------ */

/** The three types the print agent routes on (`printJob.dart:254/268/282`). */
export type MimeDoAgente = 'application/pdf' | 'application/zip' | 'text/plain';

/**
 * The essences this provider hands the agent. A `Map`, never an object
 * literal: a lookup of `'constructor'` on a plain object answers a function.
 */
const MIME_DO_AGENTE: ReadonlyMap<string, MimeDoAgente> = new Map<string, MimeDoAgente>([
  ['application/pdf', 'application/pdf'],
  ['application/zip', 'application/zip'],
  ['application/x-zip-compressed', 'application/zip'],
  ['text/plain', 'text/plain'],
]);

/** A header's MIME essence — lower-cased, parameters dropped. */
function essencia(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The type the print agent gets for a label's `Content-Type`, or `null` when
 * the agent cannot print it (the caller DOWNLOADS the file instead).
 *
 * ⚠️ The ESSENCE, always: the agent compares with `==`, so
 * `text/plain; charset=utf-8` — which a proxy or CDN may append to the route's
 * bare `text/plain` — matches nothing there and fails SILENTLY (W13). Only
 * pdf, zip (`x-zip-compressed` included) and plain text pass; anything else,
 * `application/octet-stream` included, is `null`.
 */
export function mimeParaAgente(contentType: string | null): MimeDoAgente | null {
  if (contentType === null) return null;
  return MIME_DO_AGENTE.get(essencia(contentType)) ?? null;
}

/**
 * The sheet for an agent type (legacy parity, `.old/lib/canaisDeVenda/shopee/
 * shipping.dart:533-536`): the THERMAL zip and a bare ZPL go to the label
 * printer; a PDF to {@link TAMANHO_DO_PDF_SHOPEE} (W14).
 */
export function tamanhoParaAgente(mime: MimeDoAgente): TamanhoFolha {
  switch (mime) {
    case 'application/zip':
    case 'text/plain':
      return 'etq';
    case 'application/pdf':
      return TAMANHO_DO_PDF_SHOPEE;
  }
}

/**
 * The yellow notice when the file Shopee returned is not the format the
 * operator asked for (R-u) — the server picks the document type, and falls back
 * to Shopee's suggestion when the requested one is not selectable; the Seller
 * Centre's own print setting can also override it. The label still prints.
 * `null` = no notice (the same format, or a type the agent cannot print, which
 * is announced on its own).
 */
export function avisoDeFormato(formato: 'pdf' | 'zpl2', mime: string): string | null {
  const tipo = mimeParaAgente(mime);
  if (tipo === null) return null;
  if (formato === 'zpl2' && tipo === 'application/pdf') {
    return (
      'A Shopee devolveu a etiqueta em PDF, não em ZPL2 — o tipo térmico não está disponível ' +
      'para este envio, ou a Central do Vendedor está configurada para PDF. A etiqueta foi ' +
      'enviada assim mesmo.'
    );
  }
  if (formato === 'pdf' && tipo !== 'application/pdf') {
    return (
      `A Shopee devolveu a etiqueta ${tipo === 'application/zip' ? 'em ZIP' : 'em ZPL'} ` +
      '(térmica), não em PDF — a Central do Vendedor está configurada para a impressão ' +
      'térmica. A etiqueta foi enviada assim mesmo.'
    );
  }
  return null;
}

/* -------------------------------- the sentences ------------------------------ */

const TITULO = 'Etiqueta Shopee';

const MENSAGEM_SEM_CLIENTE =
  'Cliente da Shopee indisponível. Faça login novamente e tente de novo.';

/**
 * The give-up sentence (R-b) — DETERMINISTIC, chosen from the last 202's
 * counts, never parsed out of a sentence: `organizados === total && total > 0`
 * means the arrange is done and will not happen again (W12).
 */
function mensagemDeTempo(progresso: Progresso | null): string {
  if (progresso !== null && progresso.total > 0 && progresso.organizados === progresso.total) {
    return (
      'O envio JÁ ESTÁ ORGANIZADO na Shopee e não será organizado de novo — a etiqueta ainda ' +
      'não ficou pronta. Clique em Imprimir de novo em alguns minutos.'
    );
  }
  return (
    'A Shopee ainda não respondeu. Clique em Imprimir de novo em alguns minutos — o envio ' +
    'nunca é organizado duas vezes.'
  );
}

/**
 * A transport failure that is NOT our own deadline. No automatic retry: the
 * re-click IS the retry, and it is safe (module docblock).
 */
function mensagemDeRede(detalhe: string): string {
  return (
    `Falha de comunicação com a Shopee: ${detalhe}. O envio pode já ter sido organizado — ` +
    'clique em Imprimir de novo para continuar; a Shopee nunca organiza o mesmo pacote duas vezes.'
  );
}

/**
 * The operator cancelled the pickup/drop-off question. A yellow notice, not a
 * silent skip: the checkout resets right after, and without it an accidental
 * Cancelar leaves a saved checkout with no label and no hint where to reprint.
 */
const MENSAGEM_ENVIO_CANCELADO =
  'Etiqueta não impressa: a escolha de como enviar foi cancelada. Para imprimir, use a ' +
  'etiqueta na linha do pedido (Pedidos) ou "Outros Checkouts".';

/**
 * The backend kept asking about ONE package: `maxPerguntas` ran out for it, or
 * it ignored the answer it was sent.
 */
const MENSAGEM_PERGUNTAS_DEMAIS =
  'A Shopee continuou perguntando como enviar este pedido depois de respondida — organize o ' +
  'envio na Central do Vendedor e clique em Imprimir de novo.';

/** A per-package call answered "download per package" again: not the loop the backend asked for. */
const MENSAGEM_POR_PACOTE_ANINHADO =
  'A integração com a Shopee pediu de novo para baixar os pacotes separadamente. Atualize a ' +
  'página e, se continuar, avise o suporte.';

/** An unknown `fase` from a newer backend: a generic wait sentence, never a blank toast. */
const MENSAGEM_FASE_DESCONHECIDA = 'Aguardando a Shopee…';

/**
 * The phases this build knows — the server's sentence is shown for these.
 * `fase` is a FREE string on the wire (a newer backend may add one), and an
 * unknown one gets {@link MENSAGEM_FASE_DESCONHECIDA} instead.
 */
const FASES_CONHECIDAS: ReadonlySet<string> = new Set([
  'programando',
  'aguardando-rastreio',
  'gerando-documento',
  'baixando',
  'renovando-credencial',
  'limite-de-requisicoes',
]);

/* -------------------------------- the loop ----------------------------------- */

type Arquivo = Extract<ShopeeEtiquetaResposta, { tipo: 'arquivo' }>;

/** How one run of the loop (the whole order, or one package) ended. */
type Rodada =
  | { tipo: 'arquivo'; arquivo: Arquivo }
  | { tipo: 'por-pacote'; pacotes: readonly string[]; mensagem: string }
  | { tipo: 'fim'; outcome: EtiquetaOutcome };

/** What one click carries across its runs — the budget is shared by every package. */
interface Sessao {
  /** Machine milliseconds spent: the calls and the sleeps, never a dialog. */
  gasto: number;
  /** Questions asked, per PACKAGE (the server's `pacote`) — `maxPerguntas` caps each. */
  readonly perguntas: Map<string, number>;
  ultimaFase: string | null;
  /** The last 202's counts — what picks the give-up sentence. */
  progresso: Progresso | null;
}

interface Contexto {
  readonly client: ShopeeClient;
  readonly pedidoId: string;
  /** The pedido's número for the question's title; `null` when it has none. */
  readonly pedidoRotulo: string | null;
  readonly formato: 'pdf' | 'zpl2';
  readonly ui: EtiquetaProviderUi;
  readonly sleep: (ms: number) => Promise<void>;
  readonly agora: () => number;
  readonly limites: LimitesDaEtiqueta;
  readonly sessao: Sessao;
}

/**
 * The pedido the question is about, for its title (Q2-F3): two questions can
 * stand in line on one screen, and an unnamed one gets answered for the wrong
 * pedido. The número itself; `null` when absent or blank (the dialog then
 * shows no pedido rather than an empty one).
 */
function rotuloDoPedido(numero: string | null | undefined): string | null {
  return numero !== null && numero !== undefined && numero.trim() !== '' ? numero : null;
}

const erro = (message: string): EtiquetaOutcome => ({ status: 'error', message });
const fim = (outcome: EtiquetaOutcome): Rodada => ({ tipo: 'fim', outcome });

function assertNever(value: never): never {
  throw new Error(`Resposta de etiqueta da Shopee não tratada: ${JSON.stringify(value)}`);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An abort-shaped rejection — what a body read rejects with once its signal
 * aborted (the signal's reason, an `AbortError` `DOMException`, since the
 * provider aborts without one). By NAME, never `instanceof DOMException`: under
 * jsdom that class is another realm's (the freight client's precedent).
 */
function ehInterrupcao(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

/**
 * When one call's `AbortSignal` fires, given the click's `restante` machine
 * budget: never past `porChamadaMs`, never past the click's budget — but never
 * under the floor either, which only the answer's call can be started below
 * (module docblock, "The bounds").
 */
function prazoDaChamada(restante: number, limites: LimitesDaEtiqueta): number {
  return Math.min(limites.porChamadaMs, Math.max(restante, limites.pisoPorChamadaMs));
}

/**
 * ONE call, under its own deadline (`prazoMs`, from {@link prazoDaChamada}).
 * The call's time is added to the machine budget however it ends.
 *
 * ⚠️ Our deadline is decided by `sinal.aborted`, never by the error class: an
 * abort while the request is in flight arrives as a `ShopeeClientNetworkError`
 * (its `cause` is the abort), one during the body read as the raw abort itself.
 * Both are the same fact — the call outlived its deadline — and both give up
 * with the resumable sentence.
 */
async function chamar(
  ctx: Contexto,
  pedido: ShopeeEtiquetaPedido,
  prazoMs: number,
): Promise<{ ok: true; r: ShopeeEtiquetaResposta } | { ok: false; outcome: EtiquetaOutcome }> {
  const controle = new AbortController();
  const prazo = setTimeout(() => {
    controle.abort();
  }, prazoMs);
  const inicio = ctx.agora();
  try {
    return { ok: true, r: await ctx.client.etiqueta(pedido, { signal: controle.signal }) };
  } catch (err) {
    const sinal = controle.signal;
    if (sinal.aborted && (err instanceof ShopeeClientNetworkError || ehInterrupcao(err))) {
      return { ok: false, outcome: erro(mensagemDeTempo(ctx.sessao.progresso)) };
    }
    // A refusal (409), a permission gap (403), a 2xx that was not a label:
    // the message IS the backend's own pt-BR sentence (a 409's `mensagem`).
    if (err instanceof ShopeeClientHttpError) return { ok: false, outcome: erro(err.message) };
    if (err instanceof ShopeeClientNetworkError) {
      return { ok: false, outcome: erro(mensagemDeRede(err.message)) };
    }
    throw err;
  } finally {
    clearTimeout(prazo);
    ctx.sessao.gasto += ctx.agora() - inicio;
  }
}

/** The server's wait, clamped to `[esperaMinMs, esperaMaxMs]` (W10). */
function esperaDe(tentarEmMs: number, limites: LimitesDaEtiqueta): number {
  return Math.min(limites.esperaMaxMs, Math.max(limites.esperaMinMs, tentarEmMs));
}

/**
 * Loop the route for the whole order (`pacote` undefined) or ONE package of a
 * split order, until it answers the file, asks for a per-package download, or
 * ends the click.
 */
async function rodar(ctx: Contexto, pacote: string | undefined): Promise<Rodada> {
  const { limites, sessao, ui } = ctx;
  let envio: EscolhaDeEnvio | undefined;

  for (;;) {
    // ⚠️ The budget contract (module docblock, "The bounds"): a call is started
    // only with at least the floor left — except the one carrying the answer
    // the operator just gave, which the check before the dialog already let in
    // (dialog time does not count) and which is never thrown away for want of
    // time. Giving up early is safe: a re-click re-derives the phase.
    const restante = limites.totalMs - sessao.gasto;
    if (envio === undefined && restante < limites.pisoPorChamadaMs) {
      return fim(erro(mensagemDeTempo(sessao.progresso)));
    }
    // ⚠️ An answer rides exactly ONE call (W11); a later re-ask is answered again.
    const enviado = envio;
    envio = undefined;
    const chamada = await chamar(
      ctx,
      {
        pedidoId: ctx.pedidoId,
        formato: ctx.formato,
        ...(pacote === undefined ? {} : { pacote }),
        ...(enviado === undefined ? {} : { envio: enviado }),
      },
      prazoDaChamada(restante, limites),
    );
    if (!chamada.ok) return fim(chamada.outcome);
    const r = chamada.r;
    if (r.tipo === 'arquivo') return { tipo: 'arquivo', arquivo: r };

    sessao.progresso = r.progresso;
    switch (r.acao) {
      case 'aguardar': {
        const espera = esperaDe(r.tentarEmMs, limites);
        // ⚠️ BEFORE the phase toast: after this wait the next call (which
        // carries no answer) needs the floor, so a wait that leaves less is not
        // slept — and a toast announcing a phase the click is about to abandon
        // would contradict the give-up right behind it.
        if (limites.totalMs - (sessao.gasto + espera) < limites.pisoPorChamadaMs) {
          return fim(erro(mensagemDeTempo(sessao.progresso)));
        }
        // One toast per PHASE, not per poll.
        if (r.fase !== sessao.ultimaFase) {
          sessao.ultimaFase = r.fase;
          ui.notify({
            title: TITULO,
            message: FASES_CONHECIDAS.has(r.fase) ? r.mensagem : MENSAGEM_FASE_DESCONHECIDA,
            color: 'blue',
          });
        }
        await ctx.sleep(espera);
        sessao.gasto += espera;
        continue;
      }
      case 'escolher-envio': {
        // The call that CARRIED the answer asked the same package again, and
        // not because the answer went stale: the backend ignored it. A re-ask on
        // a LATER call is legitimate (a lagging read, an answer whose call ran
        // out of budget before the ship) and is simply asked again.
        if (enviado !== undefined && enviado.pacote === r.pacote && !r.escolhaInvalida) {
          return fim(erro(MENSAGEM_PERGUNTAS_DEMAIS));
        }
        // Counted per PACKAGE: a split order legitimately asks each of its
        // packages once, so a per-click count would call a long order a backend
        // that "kept asking".
        const perguntas = (sessao.perguntas.get(r.pacote) ?? 0) + 1;
        sessao.perguntas.set(r.pacote, perguntas);
        if (perguntas > limites.maxPerguntas) return fim(erro(MENSAGEM_PERGUNTAS_DEMAIS));
        // No call starts after `totalMs` — the answer's call included.
        if (sessao.gasto >= limites.totalMs) return fim(erro(mensagemDeTempo(sessao.progresso)));

        const escolha = await ui.escolherEnvio({
          pedidoRotulo: ctx.pedidoRotulo,
          pacoteRotulo: r.pacoteRotulo,
          mensagem: r.mensagem,
          enderecos: r.enderecos,
          permiteDropoff: r.permiteDropoff,
          escolhaInvalida: r.escolhaInvalida,
        });
        if (escolha === null) {
          ui.notify({ title: TITULO, message: MENSAGEM_ENVIO_CANCELADO, color: 'yellow' });
          return fim({ status: 'skipped' });
        }
        // Rebuilt BY NAME with the QUESTION's package: the answer is for that one.
        envio =
          escolha.modo === 'dropoff'
            ? { pacote: r.pacote, modo: 'dropoff' }
            : {
                pacote: r.pacote,
                modo: 'pickup',
                enderecoId: escolha.enderecoId,
                horarioId: escolha.horarioId,
              };
        continue;
      }
      case 'baixar-por-pacote':
        return { tipo: 'por-pacote', pacotes: r.pacotes, mensagem: r.mensagem };
      default:
        return assertNever(r);
    }
  }
}

/**
 * Hand the file to the print agent — or, for a type the agent cannot route,
 * DOWNLOAD it and say so. A print (agent up) and a download (agent down) both
 * deliver the label; the download says what to do with it.
 */
async function entregar(
  arquivo: Arquivo,
  formato: 'pdf' | 'zpl2',
  deps: EtiquetaProviderDeps,
  ui: EtiquetaProviderUi,
  salvarArquivo: typeof saveBlob,
): Promise<void> {
  const mime = mimeParaAgente(arquivo.contentType);
  if (mime === null) {
    salvarArquivo(arquivo.blob, arquivo.filename);
    ui.notify({
      title: TITULO,
      message:
        `Formato de etiqueta não reconhecido (${essencia(arquivo.contentType).slice(0, 80)}) — ` +
        `o arquivo foi baixado como "${arquivo.filename}" e não foi enviado à impressora.`,
      color: 'yellow',
    });
    return;
  }

  const aviso = avisoDeFormato(formato, mime);
  if (aviso !== null) ui.notify({ title: TITULO, message: aviso, color: 'yellow' });

  const entrega = await deps.printJob(arquivo.blob, {
    fileName: arquivo.filename,
    contentType: mime,
    tamanho: tamanhoParaAgente(mime),
  });
  if (entrega === 'downloaded') {
    ui.notify({
      title: TITULO,
      message:
        mime === 'application/zip'
          ? `Agente de impressão indisponível. A etiqueta foi baixada como "${arquivo.filename}" — abra o ZIP e envie o .txt à Zebra; o PDF dentro dele é a declaração de conteúdo.`
          : mime === 'text/plain'
            ? `Agente de impressão indisponível. O arquivo ZPL foi baixado como "${arquivo.filename}" e precisa ser enviado à Zebra manualmente — não abra no Bloco de Notas, ele imprime o código em vez da etiqueta.`
            : `Agente de impressão indisponível. A etiqueta foi baixada como "${arquivo.filename}" e precisa ser impressa manualmente.`,
      color: 'yellow',
    });
  }
}

/**
 * Provider factory with the loop's seams — the clock, the bounds and the
 * download — for the unit tests. Call sites use {@link shopeeProvider}.
 */
export function createShopeeProvider(
  opts: {
    agora?: () => number;
    limites?: Partial<LimitesDaEtiqueta>;
    salvarArquivo?: typeof saveBlob;
  } = {},
): CheckoutEtiquetaProvider {
  const limites: LimitesDaEtiqueta = { ...SHOPEE_ETIQUETA_LIMITES, ...opts.limites };
  const agora = opts.agora ?? (() => Date.now());
  const salvarArquivo = opts.salvarArquivo ?? saveBlob;

  return {
    tipos: [INTEGRACAO_FRETE.shopee],
    reimpressao: 'mesmo-documento',

    async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
      // ⚠️ `frete` is never read (W18) and `intFrete` neither: the server
      // resolves the conta and the packages from the pedido itself.
      const { pedidoId, formato, deps, ui } = input;
      if (deps.shopeeClient === null) return erro(MENSAGEM_SEM_CLIENTE);

      const ctx: Contexto = {
        client: deps.shopeeClient,
        pedidoId,
        pedidoRotulo: rotuloDoPedido(input.pedido.numero),
        formato,
        ui,
        sleep: deps.sleep ?? realSleep,
        agora,
        limites,
        sessao: { gasto: 0, perguntas: new Map(), ultimaFase: null, progresso: null },
      };

      const pedido = await rodar(ctx, undefined);
      if (pedido.tipo === 'fim') return pedido.outcome;
      if (pedido.tipo === 'arquivo') {
        await entregar(pedido.arquivo, formato, deps, ui, salvarArquivo);
        return { status: 'printed' };
      }

      // Different couriers: one call — and one file — per package, against the
      // SAME budget. A failure names its label; the earlier ones printed, and a
      // re-click reprints them all (a reprint is the same document).
      //
      // ⚠️ Known limit (Q1-1): a re-click restarts at the FIRST listed package,
      // so an order with MANY packages may run out of budget before its tail,
      // reprinting the same first labels on every click (never a second ship).
      // Rare at this seller's volume; documented, not fixed.
      ui.notify({ title: TITULO, message: pedido.mensagem, color: 'blue' });
      const total = pedido.pacotes.length;
      for (const [i, pacote] of pedido.pacotes.entries()) {
        // "Etiqueta i de n" — `i` counts the DOWNLOADS this 202 listed. Never
        // "pacote i": the server numbers a package by its position in the FULL
        // order (its filename's `-p<i>de<n>`), which counts packages this list
        // leaves out (cancelled, not eligible), so the two would disagree.
        const prefixo = `Etiqueta ${String(i + 1)} de ${String(total)}: `;
        const sufixo =
          i > 0
            ? ' As anteriores foram enviadas; clique em Imprimir de novo para reimprimir todas.'
            : '';
        const r = await rodar(ctx, pacote);
        if (r.tipo === 'por-pacote') {
          return erro(`${prefixo}${MENSAGEM_POR_PACOTE_ANINHADO}${sufixo}`);
        }
        if (r.tipo === 'fim') {
          return r.outcome.status === 'error'
            ? erro(`${prefixo}${r.outcome.message}${sufixo}`)
            : r.outcome;
        }
        await entregar(r.arquivo, formato, deps, ui, salvarArquivo);
      }
      return { status: 'printed' };
    },
  };
}

export const shopeeProvider: CheckoutEtiquetaProvider = createShopeeProvider();
