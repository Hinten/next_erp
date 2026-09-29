/**
 * The NF-e upload HANDLER (#1522, step 14): one Cloud Tasks delivery of the
 * NF-e queue → the common prefix both phases share → the upload ladder (phase
 * `envio`) or the recheck (phase `reverificacao`, `reverificacaoNfe.ts`) → ONE
 * completion log line. Plus the in-process DRY RUN the CLI prints.
 *
 * The shape is step 12's `estoque/enviarEstoque.ts` (the handler logs its own one
 * line) and step 13's `precos/atualizarPrecos.ts` (the burst pause, the daily
 * park, the ceiling on both, the clock as a parameter).
 *
 * ## The common prefix (P1–P8), in THIS order
 *
 * 1. the NF-e document, RAW (a legacy doc may not match the strict schema) —
 *    missing ⇒ `nfe-nao-encontrada`;
 * 2. the shared LEVEL predicate (`decideNfeUploadDispatch(undefined, raw)`) —
 *    the doc may have been cancelled since the enqueue;
 * 3. the pedido, RAW, and the ownership PROOF (`avaliarPedidoParaNfeShopee`);
 * 4. the sale-only gate (`finalidadeDoProc`): a legible non-sale note is
 *    discarded, an illegible one is `xml-invalido`;
 * 5. the key Shopee will parse (`chaveDaNfeParaCanal`) and the UTF-8 size against
 *    the PACKAGE's byte ceiling — `xml-invalido` / `xml-grande-demais` raise the
 *    aviso and stamp the frete with ZERO Shopee calls;
 * 6. the conta (`readConta` + `avaliarContaParaNfeShopee`) BEFORE any client is
 *    built, so a switched-off conta never costs a token read;
 * 7. the SHOP client — the conta's typed failures are log-only outcomes;
 * 8. ONE `get_order_detail` ({@link lerPedidoNaShopee}) and the order gate
 *    (`portaoDoPedido`) — a cancelled order resolves the pedido's aviso.
 *
 * ⚠️ The pedido is read BEFORE the XML is judged (reconcile R-n): the aviso of a
 * broken XML needs the conta and the display number, and this order is what
 * lets a broken XML reach an aviso AND a stamp without a single Shopee call.
 *
 * ## The upload (phase `envio`)
 *
 * The pre-read decides whether to upload at all — Shopee holding OUR key is a
 * re-drive of a landed upload (`ja-enviado`), another key is never overwritten
 * (`outra-nfe-anexada`) unless it belongs to a CANCELLED sibling NF-e of the same
 * pedido (a substitution), and only `sem-nota` uploads. After a 200 the order is
 * read BACK once (a failure of that read is logged and swallowed: the upload
 * landed), and the recheck is ALWAYS enqueued. A refusal is narrowed by CLASS —
 * the rate limit FIRST (it extends the API class), then the lapsed grant, then
 * the refusal table (`classificarNfe.ts`), and an answer we cannot read (schema,
 * HTTP, network) lets the read-back decide. A stamp is never spent on the
 * ABSENCE of an answer (reconcile R-f(1), R-g).
 *
 * ## Effects come from the sets, and only from them
 *
 * Every arm DECIDES a motivo; {@link aplicar} is the one place the three sets of
 * `errosNfe.ts` are consulted — the aviso, then the stamp, then the resolve.
 *
 * ## Attempts, pauses and waits
 *
 * - A rate limit is a delayed SELF re-enqueue that spends no queue attempt —
 *   burst after its `Retry-After` (or the channel's pause), daily at the next
 *   00:00 UTC+8 — plus the injected jitter; both count in `pausas`, bounded by
 *   `NFE_SHOPEE_MAX_PAUSAS`.
 * - Shopee's "not valid yet" (case 5) is a delayed self re-enqueue along
 *   `ATRASOS_SERPRO_REENVIO_S`; its LENGTH is the ceiling, then `nfe-invalida`.
 * - A transient Shopee failure RETHROWS to the queue's ladder, except on the
 *   LAST attempt, where it finalizes (`canal-indisponivel` + one recheck for the
 *   upload, `reverificacao-indisponivel` for a recheck). Anything else — a
 *   Firestore failure, a bug — rethrows on EVERY attempt.
 *
 * ## Rule 7, write by write (this module writes nothing directly)
 *
 * - aviso raise — tier 0 (deterministic id) + tier 1 inside `escreverAviso`;
 * - aviso resolve — tier 1 inside `resolverAviso` (absent/resolved ⇒ no write);
 * - frete stamp — class C, every guard re-derived from the stamp's own
 *   transactional read (`carimboFreteNfe.ts`);
 * - the re-enqueues — no document at all; a duplicate task converges through the
 *   pre-read (Shopee then holds OUR key ⇒ `ja-enviado`).
 *
 * ## Units and the clock
 *
 * `deps.nowMs` is the dispatcher's ONE clock read, in MILLISECONDS; it crosses
 * into microseconds ONCE per execution, through the aviso module's seam, for the
 * stamp (the aviso writer derives the same instant from the same `nowMs`). This
 * module reads no clock.
 *
 * ## ⚠️ PII
 *
 * The context holds the order number and our key; the XML is in memory. None of
 * them — nor the upload filename, nor Shopee's raw sentence or pending reason —
 * reaches a log line, a payload or a returned field. The log carries document
 * ids, counters, slugs, Shopee's error CODE when it is a token, and — only for
 * the members of `MOTIVOS_COM_EXCERTO` — the SANITIZED excerpt.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeClient,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import { coerceToMillis } from '@delfrance/core/datetime';
import { camposInvalidos, resumirCampos } from '@delfrance/core/wire';
import { ESTADO_NFE, decideNfeUploadDispatch } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { type AvisoDeps, agoraUsDe } from '../avisos/autorizacao';
import { readConta } from '../core/contaCache';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import { ratePauseMin } from '../estoque/constantesEstoque';
import { PARQUE_JITTER_MAX_S } from '../precos/constantesPreco';
import {
  RESOLUCAO_AVISO_NFE_SHOPEE,
  avisarNfeShopee,
  resolverAvisoNfeShopee,
  type ResolucaoAvisoNfeShopee,
} from './avisoNfe';
import { carimbarFreteNfeShopee, type MotivoCarimbo } from './carimboFreteNfe';
import { classificarRecusaDeNfe } from './classificarNfe';
import {
  ATRASOS_REVERIFICACAO_S,
  ATRASOS_SERPRO_REENVIO_S,
  NFE_SHOPEE_MAX_PAUSAS,
  NFE_SHOPEE_MAX_TENTATIVAS,
  SHOPEE_NFE_DETALHE_CAMPOS,
  SHOPEE_NFE_UPLOAD_QUEUE,
  atrasoSerproS,
} from './constantesNfe';
import {
  DESFECHO_NFE_SHOPEE,
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_COM_EXCERTO,
  MOTIVOS_QUE_AVISAM,
  MOTIVOS_QUE_CARIMBAM,
  ShopeeNfeUploadTasksDisabledError,
  type DesfechoNfeShopee,
  type MotivoNfeShopee,
} from './errosNfe';
import {
  chaveCanonica,
  finalidadeDoProc,
  lerNotaNaShopee,
  portaoDoPedido,
  type NotaNaShopee,
  type StatusNotaShopee,
} from './notaNaShopee';
import {
  avaliarContaParaNfeShopee,
  avaliarPedidoParaNfeShopee,
  chaveDaNfeParaCanal,
} from './pedidoNfe';
import { resumirTextoDaShopee } from './redacaoNfe';
import { reverificarNfeShopee } from './reverificacaoNfe';
import {
  FASE_NFE_SHOPEE,
  tarefaNfeShopeeSchema,
  type AgendadorNfeShopee,
  type ContextoNfeShopee,
  type FaseNfeShopee,
  type TarefaNfeShopee,
} from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*                                   the seam                                  */
/* -------------------------------------------------------------------------- */

/** Everything one execution needs (orchestrator amendment W3-1). */
export interface DepsNfeShopee {
  readonly db: Firestore;
  /** The NF-e queue — the recheck, the pauses, the SERPRO waits. */
  readonly scheduler: AgendadorNfeShopee;
  /** The dispatcher's ONE clock read, in MILLISECONDS. This module reads none. */
  readonly nowMs: number;
  /**
   * `(by) => FieldValue.increment(by)` — the aviso writer needs the sentinel, and
   * this folder may not make the runtime import that produces it.
   */
  readonly increment: AvisoDeps['increment'];
  /**
   * Jitter, in whole SECONDS in `[0, maxS]`, added to every pause's delay so a
   * fleet paused on the same limit does not resume on the same second. The
   * randomness belongs to the dispatcher; a test passes a constant.
   */
  jitterSec(maxS: number): number;
  /**
   * The conta's SHOP client. Default: `loadShopeeContext(...).createShopClient()`
   * — called only after the conta gate passed.
   */
  readonly resolveClient?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
}

/** What one execution ended in. */
export interface ResultadoNfeShopee {
  readonly desfecho: DesfechoNfeShopee;
  /** `null` only when a 200's read-back could not be read (the upload landed). */
  readonly motivo: MotivoNfeShopee | null;
  /** `null` only for a payload that did not parse. */
  readonly fase: FaseNfeShopee | null;
  /** The upload replaced a CANCELLED sibling NF-e's key on the order. */
  readonly substituicao: boolean;
  /** The frete stamp's answer, when the motivo stamps. */
  readonly carimbo: MotivoCarimbo | null;
  readonly avisado: boolean;
  /** THIS execution closed the pedido's open aviso. */
  readonly resolvido: boolean;
}

/**
 * What the upload WOULD do — the dry run's answer (`simularEnvioNfeShopee`).
 * Nothing in it was written, uploaded or enqueued.
 *
 * ⚠️ Never a key, an order number, the XML or Shopee's raw text: the note Shopee
 * holds is reported as a VERDICT, and the only Shopee text is the sanitized
 * excerpt of the two motivos that carry one.
 */
export interface SimulacaoNfeShopee {
  /** The outcome the upload would reach; `enviado` with `enviaria` = it would upload now. */
  readonly desfecho: DesfechoNfeShopee;
  readonly motivo: MotivoNfeShopee | null;
  readonly enviaria: boolean;
  readonly substituicao: boolean;
  /** What the sets say this outcome would do. */
  readonly avisaria: boolean;
  readonly carimbaria: boolean;
  readonly resolveria: boolean;
  readonly reverificaria: boolean;
  /** The pre-read's verdict on the note Shopee holds, when it was reached. */
  readonly notaNaShopee: NotaNaShopee['veredito'] | null;
  readonly statusDaNota: StatusNotaShopee | null;
  /** UTF-8 bytes of our proc, when it was read. */
  readonly bytesDoXml: number | null;
  /** Seconds of SERPRO wait still due since the authorization, when the NF-e was read. */
  readonly atrasoSerproS: number | null;
  /** Shopee's error code, only when it is a token. */
  readonly codigo: string | null;
  /** The sanitized excerpt — only for the members of `MOTIVOS_COM_EXCERTO`. */
  readonly excerto: string | null;
}

/* -------------------------------------------------------------------------- */
/*                              the order read (P8)                            */
/* -------------------------------------------------------------------------- */

/** Shopee's codes for "this shop has no such order", module prefix stripped. */
const CODIGOS_PEDIDO_INEXISTENTE: ReadonlySet<string> = new Set<string>([
  'order_not_found',
  'error_not_found',
]);

/** The app's egress IP is not on Shopee's allow-list. */
const CODIGO_IP_NAO_DECLARADO = 'source_ip_undeclared';

/** A Shopee error code as a LOG token — never free text. */
const CODIGO_TOKEN = /^[a-z][a-z0-9_.]*$/i;

/**
 * The code as this module compares it: trimmed, ONE module segment stripped,
 * trimmed again. PAIR: `order.order_not_found\t` ≡ `order_not_found`. NEAR-MISS:
 * `order_not_found_x` stays distinct.
 */
function codigoSemPrefixo(code: string): string {
  const aparado = code.trim();
  return (shopeeCodeSemPrefixoDeModulo(aparado) ?? aparado).trim();
}

/** Shopee's code for a log line — the trimmed token, or `null` when it is not one. */
function codigoSeguro(code: string): string | null {
  const aparado = code.trim();
  return CODIGO_TOKEN.test(aparado) ? aparado : null;
}

/**
 * What one order read found, every GET failure the table below knows mapped.
 * Module-local on purpose (the `pedidoNfe.ts` precedent): the seam gains no name.
 */
type LeituraDoPedidoNaShopee =
  | { readonly tipo: 'linha'; readonly linha: ShopeeOrderDetailRow }
  | { readonly tipo: 'inexistente'; readonly codigo: string | null }
  | { readonly tipo: 'ip-nao-declarado'; readonly codigo: string | null }
  | { readonly tipo: 'reauth'; readonly codigo: string | null }
  | { readonly tipo: 'limite'; readonly erro: ShopeeRateLimitError };

/**
 * The ONE `get_order_detail` of the folder — pre-read, read-back and recheck
 * read the order through it, with `SHOPEE_NFE_DETALHE_CAMPOS` (a REPLACING list:
 * no buyer datum on this wire). Reconcile R-f(3): a GET error never goes through
 * the upload's refusal table.
 *
 * - the rate limit ⇒ `limite` (the caller's pause arms);
 * - the lapsed grant ⇒ `reauth`;
 * - `order_not_found` / `error_not_found` (prefix stripped, trimmed), or an
 *   answer without our row ⇒ `inexistente` — reconciled by `order_sn`, never by
 *   position;
 * - `source_ip_undeclared` ⇒ `ip-nao-declarado`;
 * - anything else THROWS, to the caller's transient ladder.
 */
export async function lerPedidoNaShopee(
  client: ShopeeClient,
  orderSn: string,
): Promise<LeituraDoPedidoNaShopee> {
  let linhas: readonly ShopeeOrderDetailRow[];
  try {
    const detalhe = await client.getOrderDetail({
      orderSnList: [orderSn],
      responseOptionalFields: SHOPEE_NFE_DETALHE_CAMPOS,
    });
    linhas = detalhe.order_list;
  } catch (err) {
    // ⚠️ The two SUBCLASSES first: both extend the API class.
    if (err instanceof ShopeeRateLimitError) return { tipo: 'limite', erro: err };
    if (err instanceof ShopeeReauthRequiredError) {
      return { tipo: 'reauth', codigo: codigoSeguro(err.code) };
    }
    if (err instanceof ShopeeApiError) {
      const nu = codigoSemPrefixo(err.code);
      if (CODIGOS_PEDIDO_INEXISTENTE.has(nu)) {
        return { tipo: 'inexistente', codigo: codigoSeguro(err.code) };
      }
      if (nu === CODIGO_IP_NAO_DECLARADO) {
        return { tipo: 'ip-nao-declarado', codigo: codigoSeguro(err.code) };
      }
    }
    throw err;
  }
  const linha = linhas.find((r) => r.order_sn === orderSn);
  return linha === undefined ? { tipo: 'inexistente', codigo: null } : { tipo: 'linha', linha };
}

/* -------------------------------------------------------------------------- */
/*                         the READ side — names no writer                     */
/* -------------------------------------------------------------------------- */

/** Who an effect is about — known once the pedido proved its conta (P3). */
interface AlvoNfe {
  readonly integracaoId: string;
  readonly pedidoId: string;
  readonly numero: string;
}

/**
 * What an arm DECIDED, before any effect. The effects themselves are the sets'
 * answer for `motivo` (plus the explicit resolve and recheck below).
 */
interface Decisao {
  readonly desfecho: DesfechoNfeShopee;
  readonly motivo: MotivoNfeShopee | null;
  /** Shopee's text, sanitized — kept only for the members of `MOTIVOS_COM_EXCERTO`. */
  readonly excerto: string | null;
  /** Shopee's error code, when it is a token (log only). */
  readonly codigo: string | null;
  /** Close the pedido's aviso with this resolution. */
  readonly resolucao: ResolucaoAvisoNfeShopee | null;
  /** Enqueue ONE recheck (`ATRASOS_REVERIFICACAO_S[0]`). */
  readonly reverificar: boolean;
}

function decidir(
  desfecho: DesfechoNfeShopee,
  motivo: MotivoNfeShopee | null,
  extra: Partial<Omit<Decisao, 'desfecho' | 'motivo'>> = {},
): Decisao {
  return {
    desfecho,
    motivo,
    excerto: extra.excerto ?? null,
    codigo: extra.codigo ?? null,
    resolucao: extra.resolucao ?? null,
    reverificar: extra.reverificar ?? false,
  };
}

/**
 * A STOP's outcome label: `recusado` when the operator is told (the aviso set),
 * `descartado` otherwise. The label follows the set; it never decides it.
 */
function paradaPor(
  motivo: MotivoNfeShopee,
  extra: Partial<Omit<Decisao, 'desfecho' | 'motivo'>> = {},
): Decisao {
  return decidir(
    MOTIVOS_QUE_AVISAM.has(motivo) ? DESFECHO_NFE_SHOPEE.recusado : DESFECHO_NFE_SHOPEE.descartado,
    motivo,
    extra,
  );
}

/** Why the prefix (or a read) stopped. */
type Parada =
  | { readonly tipo: 'decisao'; readonly decisao: Decisao }
  | { readonly tipo: 'limite'; readonly erro: ShopeeRateLimitError }
  | { readonly tipo: 'transitorio'; readonly erro: Error };

type Prefixo =
  | { readonly segue: false; readonly alvo: AlvoNfe | null; readonly parada: Parada }
  | {
      readonly segue: true;
      readonly ctx: ContextoNfeShopee;
      readonly linha: ShopeeOrderDetailRow;
      /** Our proc, exactly as read at P1 — the bytes the upload sends. */
      readonly xml: string;
    };

/** What the prefix observed on the way — the dry run prints it. */
interface Observacao {
  bytesDoXml: number | null;
  atrasoSerproS: number | null;
}

function pararCom(alvo: AlvoNfe | null, decisao: Decisao): Prefixo {
  return { segue: false, alvo, parada: { tipo: 'decisao', decisao } };
}

/** The conta's typed failures (P7, and the token read inside P8) → a log-only motivo. */
function motivoDaContaQuebrada(err: unknown): MotivoNfeShopee | null {
  if (err instanceof ShopeeContaNotConfiguredError) return MOTIVO_NFE_SHOPEE.contaNaoConfigurada;
  if (err instanceof ShopeeContaSemShopIdError) return MOTIVO_NFE_SHOPEE.semShopId;
  if (err instanceof ShopeeSemCredencialError || err instanceof ShopeeCredencialInvalidaError) {
    return MOTIVO_NFE_SHOPEE.contaNaoConfigurada;
  }
  if (err instanceof ShopeeConfigError) return MOTIVO_NFE_SHOPEE.configuracaoDoApp;
  return null;
}

/**
 * A GET failure the queue's ladder owns: no answer at all (network), a non-Shopee
 * body (HTTP), an unreadable one (schema), or Shopee's own server hiccup.
 */
function ehFalhaTransitoriaDeLeitura(err: unknown): err is Error {
  if (err instanceof ShopeeNetworkError) return true;
  if (err instanceof ShopeeHttpError) return true;
  if (err instanceof ShopeeSchemaError) return true;
  return err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.transient;
}

/** One order read, every outcome mapped to a row or a stop. Other failures throw. */
async function lerOuParar(
  client: ShopeeClient,
  alvo: AlvoNfe,
): Promise<{ readonly linha: ShopeeOrderDetailRow } | { readonly parada: Parada }> {
  let leitura: LeituraDoPedidoNaShopee;
  try {
    leitura = await lerPedidoNaShopee(client, alvo.numero);
  } catch (err) {
    const motivoConta = motivoDaContaQuebrada(err);
    if (motivoConta !== null) {
      return { parada: { tipo: 'decisao', decisao: paradaPor(motivoConta) } };
    }
    if (ehFalhaTransitoriaDeLeitura(err)) return { parada: { tipo: 'transitorio', erro: err } };
    throw err;
  }
  switch (leitura.tipo) {
    case 'linha':
      return { linha: leitura.linha };
    case 'limite':
      return { parada: { tipo: 'limite', erro: leitura.erro } };
    case 'reauth':
      return {
        parada: {
          tipo: 'decisao',
          decisao: paradaPor(MOTIVO_NFE_SHOPEE.reauth, { codigo: leitura.codigo }),
        },
      };
    case 'ip-nao-declarado':
      return {
        parada: {
          tipo: 'decisao',
          decisao: paradaPor(MOTIVO_NFE_SHOPEE.ipNaoDeclarado, { codigo: leitura.codigo }),
        },
      };
    case 'inexistente':
      return {
        parada: {
          tipo: 'decisao',
          decisao: paradaPor(MOTIVO_NFE_SHOPEE.pedidoInexistenteNoCanal, {
            codigo: leitura.codigo,
          }),
        },
      };
  }
}

/** The default client: the conta context, built only after the conta gate. */
async function clientePadrao(db: Firestore, integracaoId: string): Promise<ShopeeClient> {
  const contexto = await loadShopeeContext(db, integracaoId);
  return contexto.createShopClient();
}

/** UTF-8 bytes — the unit the package's ceiling is measured in. */
function bytesUtf8(texto: string): number {
  return new TextEncoder().encode(texto).byteLength;
}

/**
 * The common prefix P1–P8 (module docblock). Reads only: the NF-e, the pedido,
 * the conta, and ONE order read at Shopee. Every stop is a DECISION the caller
 * applies (or, in the dry run, reports).
 */
async function prefixoComum(
  deps: Pick<DepsNfeShopee, 'db' | 'nowMs' | 'resolveClient'>,
  tarefa: TarefaNfeShopee,
  obs: Observacao,
): Promise<Prefixo> {
  const { db } = deps;
  const { pedidoId, nfeId } = tarefa;

  // ---- P1: the NF-e, raw. ----
  const nfeSnap = await nfev4Collection.docRef(db, { pedidoId }, nfeId).get();
  if (!nfeSnap.exists) return pararCom(null, paradaPor(MOTIVO_NFE_SHOPEE.nfeNaoEncontrada));
  const nfe = (nfeSnap.data() ?? {}) as Record<string, unknown>;
  obs.atrasoSerproS = atrasoSerproS(coerceToMillis(nfe.data_autorizacao), deps.nowMs);

  // ---- P2: the shared LEVEL predicate. ----
  const pronta = decideNfeUploadDispatch(undefined, nfe);
  if (pronta.action === 'skip') return pararCom(null, paradaPor(pronta.reason));

  // ---- P3: the pedido, raw, and the ownership proof — BEFORE the XML (R-n). ----
  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedido = pedidoSnap.exists ? ((pedidoSnap.data() ?? {}) as Record<string, unknown>) : null;
  const dono = avaliarPedidoParaNfeShopee(pedidoId, pedido);
  if (dono.acao === 'ignorar') return pararCom(null, paradaPor(dono.motivo));
  const alvo: AlvoNfe = { integracaoId: dono.contaId, pedidoId, numero: dono.orderSn };

  // ---- P4: the sale-only gate. ----
  const xml = typeof nfe.xml_nfe_proc === 'string' ? nfe.xml_nfe_proc : '';
  obs.bytesDoXml = bytesUtf8(xml);
  const finalidade = finalidadeDoProc(xml);
  if (finalidade === 'outra') return pararCom(alvo, paradaPor(MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda));
  if (finalidade === 'ilegivel') return pararCom(alvo, paradaPor(MOTIVO_NFE_SHOPEE.xmlInvalido));

  // ---- P5: the key Shopee will parse, and the PACKAGE's byte ceiling. ----
  const chave = chaveDaNfeParaCanal(nfe);
  if (!('chave' in chave)) return pararCom(alvo, paradaPor(chave.motivo));
  if (obs.bytesDoXml > SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES) {
    return pararCom(alvo, paradaPor(MOTIVO_NFE_SHOPEE.xmlGrandeDemais));
  }

  // ---- P6: the conta — BEFORE any client is built. ----
  const conta = avaliarContaParaNfeShopee(await readConta(db, alvo.integracaoId));
  if (!conta.ok) return pararCom(alvo, paradaPor(conta.motivo));

  // ---- P7: the SHOP client. ----
  let client: ShopeeClient;
  try {
    client = await (deps.resolveClient ?? clientePadrao)(db, alvo.integracaoId);
  } catch (err) {
    const motivo = motivoDaContaQuebrada(err);
    if (motivo === null) throw err;
    return pararCom(alvo, paradaPor(motivo));
  }

  // ---- P8: ONE order read, then the order gate. ----
  const lido = await lerOuParar(client, alvo);
  if ('parada' in lido) return { segue: false, alvo, parada: lido.parada };
  const portao = portaoDoPedido(lido.linha);
  if (!portao.segue) {
    return pararCom(
      alvo,
      paradaPor(portao.motivo, {
        resolucao:
          portao.motivo === MOTIVO_NFE_SHOPEE.pedidoCancelado
            ? RESOLUCAO_AVISO_NFE_SHOPEE.pedidoCancelado
            : null,
      }),
    );
  }

  const ctx: ContextoNfeShopee = {
    pedidoId,
    nfeId,
    integracaoId: alvo.integracaoId,
    numero: alvo.numero,
    nossaChave: chave.chave,
    client,
  };
  return { segue: true, ctx, linha: lido.linha, xml };
}

/**
 * Shopee holds OUR key. `antes` = before any upload of THIS execution (the
 * pre-read, or the read-back of an "already attached" refusal); `depois` = right
 * after a 200 (or an answer we could not read that the read-back confirmed).
 *
 * - `valid` ⇒ resolve (`ja-enviado` before, `enviado` after);
 * - `pending` + a reason ⇒ `sefaz-pendente` (the excerpt rides along);
 * - anything else ⇒ one recheck (`validacao-pendente` / `status-desconhecido`).
 *
 * After an upload the recheck is ALWAYS enqueued, whatever the reading.
 */
function decisaoDaNossa(
  nota: Extract<NotaNaShopee, { readonly veredito: 'nossa' }>,
  momento: 'antes' | 'depois',
): Decisao {
  const base = momento === 'antes' ? DESFECHO_NFE_SHOPEE.jaEnviado : DESFECHO_NFE_SHOPEE.enviado;
  const depois = momento === 'depois';
  if (nota.status === 'valida') {
    return decidir(base, MOTIVO_NFE_SHOPEE.nfeValidada, {
      resolucao: RESOLUCAO_AVISO_NFE_SHOPEE.nfeValidada,
      reverificar: depois,
    });
  }
  if (nota.status === 'pendente' && nota.motivoPendente !== null) {
    return decidir(depois ? base : DESFECHO_NFE_SHOPEE.recusado, MOTIVO_NFE_SHOPEE.sefazPendente, {
      excerto: nota.motivoPendente,
      reverificar: depois,
    });
  }
  return decidir(
    base,
    nota.status === 'pendente'
      ? MOTIVO_NFE_SHOPEE.validacaoPendente
      : MOTIVO_NFE_SHOPEE.statusDesconhecido,
    { reverificar: true },
  );
}

/** Another note on the order — never overwritten: legible or not, the operator is told. */
function decisaoDaOutra(
  nota: Extract<NotaNaShopee, { readonly veredito: 'outra' }>,
  desfecho: DesfechoNfeShopee,
): Decisao {
  return decidir(
    desfecho,
    nota.legivel ? MOTIVO_NFE_SHOPEE.outraNfeAnexada : MOTIVO_NFE_SHOPEE.chaveIlegivel,
  );
}

/**
 * The key a CANCELLED sibling NF-e carries: the key inside its proc (through
 * the same reader as ours), or — only when no proc string is stored at all —
 * its stored `chave`, canonical.
 *
 * Both writers of the corpus keep the proc on a cancel (`apps/nfe`'s cancel is a
 * merge of the estado and the protocol fields; the legacy app's `copyWith`),
 * but an NF-e can reach `aprovada` WITHOUT its proc (the digest-mismatch audit
 * path) and still be cancelled — which leaves the stored key as the only
 * witness.
 */
function chaveDoIrmaoCancelado(raw: Record<string, unknown>): string | null {
  if (typeof raw.xml_nfe_proc === 'string') {
    const doProc = chaveDaNfeParaCanal(raw);
    return 'chave' in doProc ? doProc.chave : null;
  }
  return typeof raw.chave === 'string' ? chaveCanonica(raw.chave) : null;
}

/**
 * The substitution rule (reconcile R-d(5)): the key Shopee holds belongs to a
 * CANCELLED NF-e of this same pedido — the re-emission after a cancel, which
 * must replace it. ONE unfiltered read of the pedido's slot documents (a handful
 * at most; no index involved).
 */
async function ehSubstituicao(
  db: Firestore,
  pedidoId: string,
  chaveNaShopee: string,
): Promise<boolean> {
  const irmaos = await nfev4Collection.ref(db, { pedidoId }).get();
  return irmaos.docs.some((doc) => {
    const raw = (doc.data() ?? {}) as Record<string, unknown>;
    return raw.estado === ESTADO_NFE.cancelada && chaveDoIrmaoCancelado(raw) === chaveNaShopee;
  });
}

/** The pre-read's verdict: upload (maybe as a substitution), or stop. */
type DecisaoDaPreLeitura =
  | { readonly enviar: true; readonly substituicao: boolean }
  | { readonly enviar: false; readonly decisao: Decisao };

async function decidirPreLeitura(
  db: Firestore,
  ctx: ContextoNfeShopee,
  nota: NotaNaShopee,
): Promise<DecisaoDaPreLeitura> {
  switch (nota.veredito) {
    case 'nao-br':
      return { enviar: false, decisao: paradaPor(MOTIVO_NFE_SHOPEE.pedidoNaoBr) };
    case 'nossa':
      return { enviar: false, decisao: decisaoDaNossa(nota, 'antes') };
    case 'outra':
      if (nota.chave !== null && (await ehSubstituicao(db, ctx.pedidoId, nota.chave))) {
        return { enviar: true, substituicao: true };
      }
      return { enviar: false, decisao: decisaoDaOutra(nota, DESFECHO_NFE_SHOPEE.recusado) };
    case 'sem-nota':
      // A `valid` status with no key ("does not require an invoice", unverified
      // on the wire) is never a reason to skip: send, and let Shopee classify.
      return { enviar: true, substituicao: false };
  }
}

/**
 * What a 200 means once read back (`null` = the read-back failed). The recheck
 * is ALWAYS enqueued.
 */
function decisaoAposEnvio(nota: NotaNaShopee | null): Decisao {
  if (nota === null) return decidir(DESFECHO_NFE_SHOPEE.enviado, null, { reverificar: true });
  switch (nota.veredito) {
    case 'nossa':
      return decisaoDaNossa(nota, 'depois');
    case 'sem-nota':
      return decidir(DESFECHO_NFE_SHOPEE.enviado, MOTIVO_NFE_SHOPEE.naoRefletidaAinda, {
        reverificar: true,
      });
    case 'outra':
      return { ...decisaoDaOutra(nota, DESFECHO_NFE_SHOPEE.enviado), reverificar: true };
    case 'nao-br':
      return decidir(DESFECHO_NFE_SHOPEE.enviado, MOTIVO_NFE_SHOPEE.pedidoNaoBr, {
        reverificar: true,
      });
  }
}

/* -------------------------------------------------------------------------- */
/*                         the dry run — writes nothing                        */
/* -------------------------------------------------------------------------- */

/**
 * The upload's DRY RUN (the CLI's `--dry-run`): the same prefix — the Firestore
 * reads and the ONE Shopee pre-read — and the pre-read's verdict, and nothing
 * else. It uploads nothing, enqueues nothing and writes nothing: it is handed no
 * scheduler and no increment sentinel, and it calls only the READ side of this
 * module (a test pins the source). A transient failure of the pre-read THROWS,
 * exactly as it would reach the queue.
 *
 * The phase in the payload is ignored: this simulates the UPLOAD.
 */
export async function simularEnvioNfeShopee(
  deps: Pick<DepsNfeShopee, 'db' | 'nowMs' | 'resolveClient'>,
  payload: unknown,
): Promise<SimulacaoNfeShopee> {
  const tarefa = tarefaNfeShopeeSchema.parse(payload);
  const obs: Observacao = { bytesDoXml: null, atrasoSerproS: null };

  const vazia = {
    enviaria: false,
    substituicao: false,
    reverificaria: false,
    notaNaShopee: null,
    statusDaNota: null,
  };
  const relatar = (d: Decisao, extra: Partial<SimulacaoNfeShopee> = {}): SimulacaoNfeShopee => ({
    ...vazia,
    desfecho: d.desfecho,
    motivo: d.motivo,
    avisaria: d.motivo !== null && MOTIVOS_QUE_AVISAM.has(d.motivo),
    carimbaria: d.motivo !== null && MOTIVOS_QUE_CARIMBAM.has(d.motivo),
    resolveria: d.resolucao !== null,
    reverificaria: d.reverificar,
    bytesDoXml: obs.bytesDoXml,
    atrasoSerproS: obs.atrasoSerproS,
    codigo: d.codigo,
    excerto: d.motivo !== null && MOTIVOS_COM_EXCERTO.has(d.motivo) ? d.excerto : null,
    ...extra,
  });

  const prefixo = await prefixoComum(deps, tarefa, obs);
  if (!prefixo.segue) {
    const { parada } = prefixo;
    if (parada.tipo === 'transitorio') throw parada.erro;
    if (parada.tipo === 'limite') {
      return relatar(
        decidir(
          DESFECHO_NFE_SHOPEE.pausado,
          parada.erro.kind === SHOPEE_ERROR_KIND.daily
            ? MOTIVO_NFE_SHOPEE.cotaDiaria
            : MOTIVO_NFE_SHOPEE.limiteDeTaxa,
          { codigo: codigoSeguro(parada.erro.code) },
        ),
      );
    }
    return relatar(parada.decisao);
  }

  const nota = lerNotaNaShopee(prefixo.linha, prefixo.ctx.nossaChave);
  const sobreANota = {
    notaNaShopee: nota.veredito,
    statusDaNota: nota.veredito === 'nossa' || nota.veredito === 'sem-nota' ? nota.status : null,
  };
  const pre = await decidirPreLeitura(deps.db, prefixo.ctx, nota);
  if (!pre.enviar) return relatar(pre.decisao, sobreANota);
  return relatar(decidir(DESFECHO_NFE_SHOPEE.enviado, null, { reverificar: true }), {
    ...sobreANota,
    enviaria: true,
    substituicao: pre.substituicao,
  });
}

/* -------------------------------------------------------------------------- */
/*                                the WRITE side                               */
/* -------------------------------------------------------------------------- */

const TAG_LOG = '[shopee/nfe] envio de NF-e';

/** What one execution ended in, plus what only the log line carries. */
interface Saida {
  readonly resultado: ResultadoNfeShopee;
  readonly codigo: string | null;
  readonly excerto: string | null;
}

/** Motivos whose line is an `error`: a data inconsistency, or a producer bug. */
const MOTIVOS_DE_LOG_ERRO: ReadonlySet<MotivoNfeShopee> = new Set<MotivoNfeShopee>([
  MOTIVO_NFE_SHOPEE.pedidoInexistenteNoCanal,
  MOTIVO_NFE_SHOPEE.payloadInvalido,
]);

/** Outcomes whose line is a `warn`. */
const DESFECHOS_DE_ALERTA: ReadonlySet<DesfechoNfeShopee> = new Set<DesfechoNfeShopee>([
  DESFECHO_NFE_SHOPEE.recusado,
  DESFECHO_NFE_SHOPEE.erroFinal,
]);

/** Log-only motivos that still deserve a `warn`: someone set something wrong. */
const MOTIVOS_DE_ALERTA: ReadonlySet<MotivoNfeShopee> = new Set<MotivoNfeShopee>([
  MOTIVO_NFE_SHOPEE.emissaoBloqueada,
  MOTIVO_NFE_SHOPEE.configuracaoDoApp,
  MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
  MOTIVO_NFE_SHOPEE.statusDesconhecido,
]);

/**
 * The ONE completion line. Ids, counters, slugs; Shopee's code only as a token;
 * the excerpt only for `MOTIVOS_COM_EXCERTO`, already sanitized. Never the order
 * number, the key, the XML, the filename or Shopee's raw text.
 */
function linhaDeLog(
  tarefa: TarefaNfeShopee,
  retryCount: number,
  s: Saida,
): Record<string, unknown> {
  const { resultado } = s;
  const comExcerto =
    resultado.motivo !== null && MOTIVOS_COM_EXCERTO.has(resultado.motivo) && s.excerto !== null;
  return {
    queue: SHOPEE_NFE_UPLOAD_QUEUE,
    pedidoId: tarefa.pedidoId,
    nfeId: tarefa.nfeId,
    fase: resultado.fase,
    desfecho: resultado.desfecho,
    motivo: resultado.motivo,
    retryCount,
    adiamentosSerpro: tarefa.adiamentosSerpro,
    pausas: tarefa.pausas,
    reverificacoes: tarefa.reverificacoes,
    substituicao: resultado.substituicao,
    carimbo: resultado.carimbo,
    ...(s.codigo !== null ? { codigo: s.codigo } : {}),
    ...(comExcerto ? { excerto: resumirTextoDaShopee(s.excerto) } : {}),
  };
}

function registrar(tarefa: TarefaNfeShopee, retryCount: number, s: Saida): void {
  const linha = linhaDeLog(tarefa, retryCount, s);
  const { motivo, desfecho } = s.resultado;
  if (motivo !== null && MOTIVOS_DE_LOG_ERRO.has(motivo)) {
    console.error(TAG_LOG, linha);
  } else if (
    DESFECHOS_DE_ALERTA.has(desfecho) ||
    (motivo !== null && MOTIVOS_DE_ALERTA.has(motivo))
  ) {
    console.warn(TAG_LOG, linha);
  } else {
    // eslint-disable-next-line no-console -- expected on every healthy task; a warn nobody can act on is what hides the real ones
    console.info(TAG_LOG, linha);
  }
}

/**
 * Process ONE delivery of the NF-e queue. `retryCount` is the queue's 0-based
 * attempt index. Never throws on an invalid payload (the line names field paths
 * only); rethrows what the queue must retry (module docblock).
 *
 * ⚠️ It writes its OWN completion line — the task function that calls it must
 * not log a second one.
 */
export async function processarNfeShopee(
  deps: DepsNfeShopee,
  payload: unknown,
  retryCount: number,
): Promise<ResultadoNfeShopee> {
  const parsed = tarefaNfeShopeeSchema.safeParse(payload);
  if (!parsed.success) {
    console.error(TAG_LOG, {
      queue: SHOPEE_NFE_UPLOAD_QUEUE,
      desfecho: DESFECHO_NFE_SHOPEE.descartado,
      motivo: MOTIVO_NFE_SHOPEE.payloadInvalido,
      retryCount,
      // Field PATHS only, never a value from the body (#1015).
      campos: resumirCampos(camposInvalidos(parsed.error.issues)),
    });
    return {
      desfecho: DESFECHO_NFE_SHOPEE.descartado,
      motivo: MOTIVO_NFE_SHOPEE.payloadInvalido,
      fase: null,
      substituicao: false,
      carimbo: null,
      avisado: false,
      resolvido: false,
    };
  }
  const tarefa = parsed.data;
  const saida = await executar(deps, tarefa, retryCount);
  registrar(tarefa, retryCount, saida);
  return saida.resultado;
}

/** One execution — see the module docblock. */
async function executar(
  deps: DepsNfeShopee,
  tarefa: TarefaNfeShopee,
  retryCount: number,
): Promise<Saida> {
  const { db, nowMs } = deps;
  // ⚠️ The ONE ms → µs crossing of this execution, for the stamp; the aviso
  // writer derives the same instant from the same `nowMs`.
  const nowUs = agoraUsDe({ nowMs });
  const ultimaTentativa = retryCount >= NFE_SHOPEE_MAX_TENTATIVAS - 1;
  let substituicao = false;

  const saidaDe = (
    d: Decisao,
    efeitos: { avisado: boolean; carimbo: MotivoCarimbo | null; resolvido: boolean },
  ): Saida => ({
    resultado: {
      desfecho: d.desfecho,
      motivo: d.motivo,
      fase: tarefa.fase,
      substituicao,
      ...efeitos,
    },
    codigo: d.codigo,
    excerto: d.motivo !== null && MOTIVOS_COM_EXCERTO.has(d.motivo) ? d.excerto : null,
  });

  /** ONE recheck, at the ladder's first rung. The closed valve is a warn, never a failure. */
  const agendarReverificacao = async (): Promise<void> => {
    try {
      await deps.scheduler.enqueue(
        { ...tarefa, fase: FASE_NFE_SHOPEE.reverificacao },
        { scheduleDelaySeconds: ATRASOS_REVERIFICACAO_S[0] },
      );
    } catch (err) {
      if (!(err instanceof ShopeeNfeUploadTasksDisabledError)) throw err;
      console.warn(TAG_LOG, {
        evento: 'reverificacao-nao-agendada',
        queue: SHOPEE_NFE_UPLOAD_QUEUE,
        pedidoId: tarefa.pedidoId,
        nfeId: tarefa.nfeId,
      });
    }
  };

  /**
   * THE place the sets are consulted: the aviso FIRST, then the stamp (a stamp
   * failure propagates — the aviso already stands), then the resolve, then the
   * recheck.
   */
  const aplicar = async (d: Decisao, alvo: AlvoNfe | null): Promise<Saida> => {
    const avisa = d.motivo !== null && MOTIVOS_QUE_AVISAM.has(d.motivo);
    const carimba = d.motivo !== null && MOTIVOS_QUE_CARIMBAM.has(d.motivo);
    if (alvo === null) {
      // Only P1–P3 stop without a conta, and none of their motivos has an effect.
      if (avisa || carimba || d.resolucao !== null || d.reverificar) {
        throw new RangeError(
          `processarNfeShopee: o motivo ${String(d.motivo)} pede um efeito antes de o pedido provar a sua conta.`,
        );
      }
      return saidaDe(d, { avisado: false, carimbo: null, resolvido: false });
    }
    if (avisa && d.motivo !== null) {
      await avisarNfeShopee(
        db,
        {
          integracaoId: alvo.integracaoId,
          pedidoId: alvo.pedidoId,
          numero: alvo.numero,
          motivo: d.motivo,
          excerto: MOTIVOS_COM_EXCERTO.has(d.motivo) ? d.excerto : null,
        },
        { increment: deps.increment, nowMs },
      );
    }
    const carimbo = carimba ? await carimbarFreteNfeShopee(db, alvo.pedidoId, nowUs) : null;
    const resolvido =
      d.resolucao === null
        ? false
        : await resolverAvisoNfeShopee(db, alvo.integracaoId, alvo.pedidoId, d.resolucao, {
            nowMs,
          });
    if (d.reverificar) await agendarReverificacao();
    return saidaDe(d, { avisado: avisa, carimbo, resolvido });
  };

  /** A delayed SELF re-enqueue (no attempt spent); `false` when the valve is closed. */
  const reenfileirar = async (proxima: TarefaNfeShopee, atrasoS: number): Promise<boolean> => {
    try {
      await deps.scheduler.enqueue(proxima, { scheduleDelaySeconds: atrasoS });
      return true;
    } catch (err) {
      if (err instanceof ShopeeNfeUploadTasksDisabledError) return false;
      throw err;
    }
  };

  /** A rate limit: burst after its wait, daily at the reset — both count in `pausas`. */
  const pausar = async (err: ShopeeRateLimitError, alvo: AlvoNfe): Promise<Saida> => {
    const codigo = codigoSeguro(err.code);
    if (tarefa.pausas >= NFE_SHOPEE_MAX_PAUSAS) {
      return aplicar(
        decidir(DESFECHO_NFE_SHOPEE.erroFinal, MOTIVO_NFE_SHOPEE.pausaReenqueuesEsgotados, {
          codigo,
        }),
        alvo,
      );
    }
    const diario = err.kind === SHOPEE_ERROR_KIND.daily;
    const esperaS = diario
      ? Math.max(0, Math.ceil((proximaViradaDaCotaMs(nowMs) - nowMs) / MS_POR_SEGUNDO))
      : Math.max(1, Math.ceil(err.retryAfterSeconds ?? ratePauseMin() * SEGUNDOS_POR_MINUTO));
    const agendado = await reenfileirar(
      { ...tarefa, pausas: tarefa.pausas + 1 },
      esperaS + deps.jitterSec(PARQUE_JITTER_MAX_S),
    );
    if (!agendado) {
      return aplicar(
        decidir(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.tasksDesabilitadas, { codigo }),
        alvo,
      );
    }
    return saidaDe(
      decidir(
        DESFECHO_NFE_SHOPEE.pausado,
        diario ? MOTIVO_NFE_SHOPEE.cotaDiaria : MOTIVO_NFE_SHOPEE.limiteDeTaxa,
        { codigo },
      ),
      { avisado: false, carimbo: null, resolvido: false },
    );
  };

  /**
   * A transient Shopee failure: RETHROW to the queue's ladder — except on the
   * LAST attempt, where the upload finalizes (`canal-indisponivel` + ONE recheck,
   * which heals a 200 lost on this very attempt) and a recheck gives up.
   */
  const transitorio = async (err: Error, alvo: AlvoNfe): Promise<Saida> => {
    if (!ultimaTentativa) throw err;
    const codigo = err instanceof ShopeeApiError ? codigoSeguro(err.code) : null;
    if (tarefa.fase === FASE_NFE_SHOPEE.envio) {
      return aplicar(
        decidir(DESFECHO_NFE_SHOPEE.erroFinal, MOTIVO_NFE_SHOPEE.canalIndisponivel, {
          codigo,
          reverificar: true,
        }),
        alvo,
      );
    }
    return aplicar(
      decidir(DESFECHO_NFE_SHOPEE.erroFinal, MOTIVO_NFE_SHOPEE.reverificacaoIndisponivel, {
        codigo,
      }),
      alvo,
    );
  };

  /** Apply a stop — a decision, a pause or a transient. */
  const tratarParada = async (parada: Parada, alvo: AlvoNfe | null): Promise<Saida> => {
    if (parada.tipo === 'decisao') return aplicar(parada.decisao, alvo);
    // A pause or a transient only ever follows a Shopee call, which only ever
    // follows the ownership proof.
    if (alvo === null) throw parada.erro;
    if (parada.tipo === 'limite') return pausar(parada.erro, alvo);
    return transitorio(parada.erro, alvo);
  };

  /** Shopee's "not valid yet" (case 5): wait along the ladder, then `nfe-invalida`. */
  const adiarPorSerpro = async (alvo: AlvoNfe, codigo: string | null): Promise<Saida> => {
    const n = tarefa.adiamentosSerpro;
    const atraso = n < ATRASOS_SERPRO_REENVIO_S.length ? ATRASOS_SERPRO_REENVIO_S[n] : undefined;
    if (atraso === undefined) {
      return aplicar(paradaPor(MOTIVO_NFE_SHOPEE.nfeInvalida, { codigo }), alvo);
    }
    if (!(await reenfileirar({ ...tarefa, adiamentosSerpro: n + 1 }, atraso))) {
      return aplicar(
        decidir(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.tasksDesabilitadas, { codigo }),
        alvo,
      );
    }
    return saidaDe(
      decidir(DESFECHO_NFE_SHOPEE.adiado, MOTIVO_NFE_SHOPEE.aguardandoSerpro, { codigo }),
      {
        avisado: false,
        carimbo: null,
        resolvido: false,
      },
    );
  };

  /**
   * The read-back after an "already attached" refusal or an answer we could not
   * read — it DECIDES (reconcile R-f(1)). Its own failures go through the same
   * stops as the pre-read's.
   */
  const releituraQueDecide = async (
    ctx: ContextoNfeShopee,
    alvo: AlvoNfe,
    aoFaltar: () => Promise<Saida>,
    aoSerNossa: (nota: Extract<NotaNaShopee, { readonly veredito: 'nossa' }>) => Decisao,
  ): Promise<Saida> => {
    const lido = await lerOuParar(ctx.client, alvo);
    if ('parada' in lido) return tratarParada(lido.parada, alvo);
    const nota = lerNotaNaShopee(lido.linha, ctx.nossaChave);
    switch (nota.veredito) {
      case 'nossa':
        return aplicar(aoSerNossa(nota), alvo);
      case 'outra':
        return aplicar(decisaoDaOutra(nota, DESFECHO_NFE_SHOPEE.recusado), alvo);
      case 'sem-nota':
        return aoFaltar();
      case 'nao-br':
        return aplicar(paradaPor(MOTIVO_NFE_SHOPEE.pedidoNaoBr), alvo);
    }
  };

  /** Everything the upload call can throw — narrowed by CLASS, the rate limit FIRST. */
  const tratarFalhaDoEnvio = async (
    err: ShopeeError,
    ctx: ContextoNfeShopee,
    alvo: AlvoNfe,
    linha: ShopeeOrderDetailRow,
  ): Promise<Saida> => {
    // ⚠️ The two subclasses BEFORE the API class they extend (mutant 32).
    if (err instanceof ShopeeRateLimitError) return pausar(err, alvo);
    if (err instanceof ShopeeReauthRequiredError) {
      return aplicar(paradaPor(MOTIVO_NFE_SHOPEE.reauth, { codigo: codigoSeguro(err.code) }), alvo);
    }
    if (err instanceof ShopeeApiError) {
      const codigo = codigoSeguro(err.code);
      const classe = classificarRecusaDeNfe(err, { statusDoPedido: linha.order_status });
      switch (classe.classe) {
        case 'recusar':
          return aplicar(
            paradaPor(classe.motivo, {
              codigo,
              excerto: resumirTextoDaShopee(err.providerMessage),
            }),
            alvo,
          );
        case 'ignorar':
          return aplicar(paradaPor(classe.motivo, { codigo }), alvo);
        case 'aguardar-serpro':
          return adiarPorSerpro(alvo, codigo);
        case 'transitorio':
          return transitorio(err, alvo);
        case 'ja-anexada':
          return releituraQueDecide(
            ctx,
            alvo,
            // Case 7 (the key sits on ANOTHER order) is a proven refusal; the
            // same-order resend text without our key is not proof of anything.
            () =>
              classe.motivo === 'chave-duplicada'
                ? aplicar(paradaPor(MOTIVO_NFE_SHOPEE.chaveEmOutroPedido, { codigo }), alvo)
                : transitorio(err, alvo),
            (nota) => ({ ...decisaoDaNossa(nota, 'antes'), codigo }),
          );
      }
    }
    if (
      err instanceof ShopeeSchemaError ||
      err instanceof ShopeeHttpError ||
      err instanceof ShopeeNetworkError
    ) {
      // An answer we cannot read: the upload may have landed. The read-back
      // decides, and its ABSENCE of our key is never a stamp (R-f(1)).
      return releituraQueDecide(
        ctx,
        alvo,
        () => transitorio(err, alvo),
        (nota) => decisaoDaNossa(nota, 'depois'),
      );
    }
    throw err;
  };

  /**
   * The read-back right after a 200. The upload LANDED, so a Shopee failure of
   * this read is logged and swallowed — the recheck will look again.
   */
  const releituraTolerante = async (ctx: ContextoNfeShopee): Promise<NotaNaShopee | null> => {
    let leitura: LeituraDoPedidoNaShopee;
    try {
      leitura = await lerPedidoNaShopee(ctx.client, ctx.numero);
    } catch (err) {
      if (
        !(
          err instanceof ShopeeApiError ||
          err instanceof ShopeeNetworkError ||
          err instanceof ShopeeHttpError ||
          err instanceof ShopeeSchemaError
        )
      ) {
        throw err;
      }
      console.warn(TAG_LOG, {
        evento: 'releitura-falhou',
        queue: SHOPEE_NFE_UPLOAD_QUEUE,
        pedidoId: tarefa.pedidoId,
        nfeId: tarefa.nfeId,
        classe: err.name,
        ...(err instanceof ShopeeApiError ? { codigo: codigoSeguro(err.code) } : {}),
      });
      return null;
    }
    if (leitura.tipo === 'linha') return lerNotaNaShopee(leitura.linha, ctx.nossaChave);
    console.warn(TAG_LOG, {
      evento: 'releitura-sem-linha',
      queue: SHOPEE_NFE_UPLOAD_QUEUE,
      pedidoId: tarefa.pedidoId,
      nfeId: tarefa.nfeId,
      leitura: leitura.tipo,
    });
    return null;
  };

  /* ------------------------------- the flow -------------------------------- */

  const obs: Observacao = { bytesDoXml: null, atrasoSerproS: null };
  const prefixo = await prefixoComum(deps, tarefa, obs);
  if (!prefixo.segue) return tratarParada(prefixo.parada, prefixo.alvo);
  const { ctx, linha, xml } = prefixo;
  const alvo: AlvoNfe = {
    integracaoId: ctx.integracaoId,
    pedidoId: ctx.pedidoId,
    numero: ctx.numero,
  };

  // ---- the recheck: judged by its own module over the row P8 already read. ----
  if (tarefa.fase === FASE_NFE_SHOPEE.reverificacao) {
    const r = await reverificarNfeShopee(ctx, deps, tarefa, linha);
    const nota = lerNotaNaShopee(linha, ctx.nossaChave);
    return {
      resultado: r,
      codigo: null,
      excerto:
        r.motivo !== null && MOTIVOS_COM_EXCERTO.has(r.motivo) && nota.veredito === 'nossa'
          ? nota.motivoPendente
          : null,
    };
  }

  // ---- the upload: the pre-read decides whether to upload at all. ----
  const pre = await decidirPreLeitura(db, ctx, lerNotaNaShopee(linha, ctx.nossaChave));
  if (!pre.enviar) return aplicar(pre.decisao, alvo);
  substituicao = pre.substituicao;

  try {
    await ctx.client.uploadInvoiceDoc({ orderSn: ctx.numero, xml });
  } catch (err) {
    // Every answer the upload can produce descends from the package's base
    // class; anything else is a bug of ours and must never be classified.
    if (err instanceof ShopeeError) return tratarFalhaDoEnvio(err, ctx, alvo, linha);
    throw err;
  }
  return aplicar(decisaoAposEnvio(await releituraTolerante(ctx)), alvo);
}

/* -------------------------------------------------------------------------- */
/*                                   helpers                                   */
/* -------------------------------------------------------------------------- */

const MS_POR_SEGUNDO = 1_000;
const SEGUNDOS_POR_MINUTO = 60;
