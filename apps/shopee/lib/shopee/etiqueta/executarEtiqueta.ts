/**
 * The label RUNNER (#1523, step 15): one call of the label route (or the
 * `baixar:etiqueta` CLI) — read what Shopee holds, decide, act ONCE, fold what
 * came back, decide again — until the label bytes, a question, a refusal or
 * the budget.
 *
 * It holds no state between calls and writes nothing anywhere (R-o): every
 * call re-derives the phase from `get_order_detail` + `get_package_detail`, so
 * re-clicking the button IS the resume path. The client, the clock and the
 * sleep come in through {@link DepsExecucaoEtiqueta}; there is no Firestore,
 * no `process.env` and no `Date.now()` here.
 *
 * ## The loop
 *
 * 1. Iteration 1 reads `get_order_detail` with EXACTLY
 *    `SHOPEE_ETIQUETA_DETALHE_CAMPOS` (no buyer, recipient or invoice field —
 *    S20) and `get_package_detail` for every package, chunked at 50.
 * 2. `decidirProximaAcao` (pure) names ONE action; this module runs it and
 *    folds the answer into the observations; repeat.
 *
 * ⚠️ **An incomplete read never decides** (review 1, M1). A package read is
 * COMPLETE only when every lot of 50 was folded in: a lot that a wait
 * interrupted (a network drop, a burst limit, Shopee's hiccup) is read again
 * on the next iteration — never decided on as "no detail row", which the
 * decision reads as `status-desconhecido` and the operator as a terminal 409.
 * The same holds for the re-read after an arrange: only the lots actually
 * read are cleared. A read Shopee answers with "the packages changed"
 * (`package_number_not_found` and its siblings) re-derives EVERYTHING once; a
 * second one in the call is `pacotes-mudaram`. Out of budget, a hole answers
 * 202 `aguardar` — never a refusal.
 *
 * ## ⚠️ The budget: no action is STARTED past it
 *
 * `orcamentoMs ?? ORCAMENTO_ETIQUETA_MS` from the call's first clock read.
 * Each action is one HTTP call with no fetch timeout, so a call ends at about
 * the budget plus one action. A wait that would reach the deadline is not
 * slept: the call answers 202 with `tentarEmMs` = that wait, and the web
 * sleeps it instead. The first read always runs — a call that read nothing
 * could say nothing.
 *
 * ## ⚠️ `ship_order` — at most once per package per call
 *
 * - `!podeProgramar` answers `sem-permissao` BEFORE `get_shipping_parameter`
 *   (S38); a reprint of an arranged package never needs the permission (S37).
 * - After a successful ship the package is ARRANGED for the rest of the call
 *   whatever a re-read says (`is_shipment_arranged` may not be observable yet,
 *   register 208), so the decision can never ask to ship it again.
 * - Every non-success of the arrange ENDS the call (a question, a wait, an
 *   unknown outcome, a refusal): nothing loops back into `ship_order`. An
 *   unknown outcome (`verificar`) answers 202 `programando`; the next call
 *   re-reads `is_shipment_arranged` (S30).
 * - `somenteLeitura` (the CLI dry run) stops at the first write-ish action —
 *   `programar`, `criar-documento`, `baixar` — and answers `simulado`: ZERO
 *   `shipOrder` / `createShippingDocument` / `downloadShippingDocument` (S46).
 * - A ship WITHOUT `package_number` arranges the whole ORDER, so once one has
 *   succeeded the call remembers it, and a stale split read's later
 *   `not_need` is taken as arranged without a second order-level ship (R2-2;
 *   `programarPacote.ts`).
 *
 * ⚠️ **Across calls the guarantee rests on Shopee** (review 1, R1-F3). The
 * stickiness above is per CALL. A re-call right after a ship whose read still
 * lags (`LOGISTICS_READY` with `is_shipment_arranged` false — register 208)
 * decides `programar` again: it may ask `escolher-envio` for a package that is
 * already arranged, or — one address, one slot — re-ship it once. Shopee's
 * `package_already_shipped` absorbs that second ship as `ja-programado`
 * (register 207; probe P2 measures the read-after-ship lag). Accepted: the
 * only stateless alternative is a guess.
 *
 * ## The document
 *
 * The type (R-u): `TIPO_DOCUMENTO_DO_FORMATO[formato]` when Shopee lists it as
 * selectable for the package; else Shopee's `suggest`; else the type is
 * OMITTED (Shopee's default). ⚠️ "Omitted" is a decision and is stored as one
 * ({@link TIPO_OMITIDO}), because `tipoDocumento: null` means "not read yet"
 * to the decision, which would re-ask until the budget ran out.
 *
 * The tracking number travels to `create_shipping_document` whenever the
 * package has a usable one — and while `IMPRIMIR_SEM_RASTREIO` is off the
 * decision never creates without one. `"-"` and `""` are no tracking number:
 * every tracking value is read through step 7's `textoShopeeUtilizavel`.
 *
 * The bytes are judged by their signature (`classificarArquivoDeEnvio`): an
 * unknown one is `formato-desconhecido` (the route's 502), never served.
 *
 * ## Errors
 *
 * Every Shopee failure goes through `classificarErroDeEtiqueta` (a batch ROW's
 * through `classificarFalhaDeLinha`, the same table); `null` ⇒ the error is
 * RETHROWN untouched and the route's `shopeeErrorResponse` answers it. An empty
 * download (`ShopeeArquivoVazioError`) is waited out ONCE per call; the second
 * one is rethrown (the route's 502).
 *
 * ⚠️ Batch rows are matched by `(order_sn, package_number)`, never by
 * position. A row with no package number is that package's only on a
 * single-package order; on a split order a FAILED one is a failure of the
 * whole batch (its verdict answers), and the package is never guessed.
 *
 * ⚠️ Nothing here logs an order number, a package number, a tracking number,
 * an address or a byte. Two lines exist, both for the rehearsal's one
 * question — what the table does not know yet (review 1, R3-F1/F2): the
 * unknown file (its length, the media-type ESSENCE of Shopee's header — never
 * a `name=` parameter — and the status), and `status-desconhecido` (the unknown
 * fulfilment TOKENS, each through {@link tokenParaLog}). An unknown REFUSAL is
 * not logged here: it rides the result (`shopeeCode`, `operacao`) to the
 * surface that logs it.
 */
import {
  SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS,
  SHOPEE_SHIPPING_DOCUMENT_STATUS,
  ShopeeApiError,
  ShopeeArquivoVazioError,
  classificarArquivoDeEnvio,
  falhaDaLinha,
  type ShopeeAlvoDePacote,
  type ShopeeArquivoBaixado,
  type ShopeeClient,
  type ShopeeLinhaDeLote,
  type ShopeeLoteLogistico,
  type ShopeeOrderDetailRow,
  type ShopeePackageDetailRow,
  type ShopeeParametroDeDocumento,
  type ShopeeResultadoDeDocumento,
} from '@delfrance/integrations-shopee';

import { codigoCanonicoShopee } from '../core/recusaShopee';
import { codigoSeguro } from '../nfe/redacaoNfe';
import { textoShopeeUtilizavel } from '../pedidos/orderMapping';
import {
  ESPERA_POS_PROGRAMAR_MS,
  INTERVALO_DOCUMENTO_MS,
  INTERVALO_RASTREIO_MS,
  ORCAMENTO_ETIQUETA_MS,
  RASTREIO_DO_PACOTE_VALE,
  SHOPEE_ETIQUETA_DETALHE_CAMPOS,
  TENTAR_EM_SHOPEE_MS,
  TIPO_DOCUMENTO_DO_FORMATO,
  TIPO_OMITIDO,
} from './constantesEtiqueta';
import {
  classificarErroDeEtiqueta,
  classificarFalhaDeLinha,
  type OperacaoEtiqueta,
  type VereditoDeErro,
} from './errosEtiqueta';
import {
  decidirProximaAcao,
  fasePacote,
  progressoDe,
  type AcaoEtiqueta,
  type FaseEtiqueta,
  type FasePacote,
  type ObservacaoOrdemEtiqueta,
  type ObservacaoPacoteEtiqueta,
} from './faseEtiqueta';
import type { EscolhaDeEnvio } from './modoDeEnvio';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';
import {
  MENSAGEM_BAIXAR_POR_PACOTE,
  MENSAGEM_DA_FASE,
  MENSAGEM_ESCOLHA_INVALIDA,
  MENSAGEM_ESCOLHER_ENVIO,
  type EtiquetaPendente,
  type Progresso,
} from './pendenteEtiqueta';
import { programarPacoteShopee } from './programarPacote';

/* -------------------------------- the seam --------------------------------- */

export interface DepsExecucaoEtiqueta {
  readonly client: ShopeeClient;
  /** Milliseconds since epoch. The ONLY clock the runner reads. */
  readonly agora: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  /** Default {@link ORCAMENTO_ETIQUETA_MS}; the CLI's `--live` passes 5 min. */
  readonly orcamentoMs?: number;
  /** The CLI dry run: every read, and NO ship / create / download. */
  readonly somenteLeitura?: boolean;
  /** `hasPerm(perms, PERM.frete.write)` — only an ARRANGE needs it (R-h). */
  readonly podeProgramar: boolean;
}

export interface EntradaEtiqueta {
  readonly orderSn: string;
  readonly formato: 'pdf' | 'zpl2';
  /** One package of a split order (after `baixar-por-pacote`), or `null` for the whole order. */
  readonly pacote: string | null;
  /** The operator's answer to an `escolher-envio` question, or `null`. */
  readonly envio: EscolhaDeEnvio | null;
}

export type ResultadoEtiqueta =
  | {
      tipo: 'bytes';
      bytes: Uint8Array;
      formato: 'pdf' | 'zip' | 'zpl';
      contentType: 'application/pdf' | 'application/zip' | 'text/plain';
      extensao: 'pdf' | 'zip' | 'txt';
      /** The package's 1-based POSITION on a per-package download of a split order, else `null`. */
      indice: number | null;
      /** How many packages the order has. */
      total: number;
    }
  | { tipo: 'pendente'; corpo: EtiquetaPendente }
  | {
      tipo: 'recusa';
      motivo: MotivoEtiquetaShopee;
      tentarApos?: number;
      /**
       * `recusa-desconhecida` only: Shopee's code, canonical, through the ONE
       * gate (`codigoSeguro` — a token of ≤ 64 characters with fewer than 7
       * digits, so no order or package number passes). Absent when there is no
       * code or it is not token-shaped.
       */
      shopeeCode?: string;
      /** `recusa-desconhecida` only: the operation Shopee refused. */
      operacao?: OperacaoEtiqueta;
    }
  | { tipo: 'nfe-pendente' }
  | { tipo: 'sem-permissao' }
  | { tipo: 'formato-desconhecido' }
  | {
      tipo: 'simulado';
      acao: AcaoEtiqueta;
      /** Per package of the order, by POSITION (never by number). */
      fases: readonly FasePacote[];
      progresso: Progresso;
    };

/**
 * One label call (see the module docblock).
 */
export async function executarEtiquetaShopee(
  deps: DepsExecucaoEtiqueta,
  e: EntradaEtiqueta,
): Promise<ResultadoEtiqueta> {
  return new ChamadaDeEtiqueta(deps, e).executar();
}

/* ------------------------------ private helpers ----------------------------- */

/** `invoice_pending.status` that holds the ship (FAQ 727), trimmed + lower-cased. */
const NF_PENDENTE = 'pending';

/** `fulfillment_flag` of an order Shopee fulfils itself, trimmed + lower-cased. */
const FULFILLMENT_SHOPEE = 'fulfilled_by_shopee';

/** How a step ended: carry on deciding, or answer the call. */
type Passo =
  | { readonly fim: false }
  | { readonly fim: true; readonly resultado: ResultadoEtiqueta };

const SEGUIR: Passo = { fim: false };

function fim(resultado: ResultadoEtiqueta): Passo {
  return { fim: true, resultado };
}

function recusa(motivo: MotivoEtiquetaShopee, tentarApos?: number): ResultadoEtiqueta {
  return tentarApos === undefined
    ? { tipo: 'recusa', motivo }
    : { tipo: 'recusa', motivo, tentarApos };
}

/**
 * A refusal nobody taught us (R3-F1): the operation, and Shopee's code when a
 * safe one exists — the one datum that says which row the table is missing.
 */
function recusaDesconhecida(
  operacao: OperacaoEtiqueta,
  shopeeCode: string | null | undefined,
): ResultadoEtiqueta {
  const motivo = MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida;
  return shopeeCode === null || shopeeCode === undefined
    ? { tipo: 'recusa', motivo, operacao }
    : { tipo: 'recusa', motivo, shopeeCode, operacao };
}

/**
 * Shopee's code as it may leave this module: the canonical fold (trim, ONE
 * module segment, trim — `core/recusaShopee.ts`), then the ONE gate
 * (`nfe/redacaoNfe.ts`'s `codigoSeguro`). `null` ⇒ no code, or not a token.
 */
function codigoParaOperador(code: string): string | null {
  return codigoSeguro(codigoCanonicoShopee(code));
}

/** The code of a THROWN failure, when it has an envelope code at all. */
function codigoDoErro(err: unknown): string | null {
  return err instanceof ShopeeApiError ? codigoParaOperador(err.code) : null;
}

/** An upper-case `LOGISTICS_*`-shaped fulfilment token. */
const TOKEN_DE_STATUS = /^[A-Z][A-Z0-9_]{1,40}$/;
/** The `codigoSeguro` rule: seven digits make an identifier, never a token. */
const MAX_DIGITOS_DO_TOKEN = 6;
const TOKEN_ILEGIVEL = '<token-ilegivel>';
/** A listed package Shopee gave no detail row for — no token to show. */
const SEM_LINHA = '<sem-linha>';

/**
 * A fulfilment token as the `status-desconhecido` log line may carry it: the
 * token when it is {@link TOKEN_DE_STATUS}-shaped with at most six digits,
 * else a placeholder. ⚠️ The shape alone admits `OFG000000000001` — a PACKAGE
 * number is capitals and digits too — so the digit cap is what keeps one out
 * of the log whatever Shopee puts in the field.
 */
function tokenParaLog(token: string | null): string {
  if (token === null || !TOKEN_DE_STATUS.test(token)) return TOKEN_ILEGIVEL;
  return (token.match(/[0-9]/g) ?? []).length <= MAX_DIGITOS_DO_TOKEN ? token : TOKEN_ILEGIVEL;
}

/** The longest media type the unknown-file line carries (the transport's own cap). */
const MAX_TIPO_LOGADO = 100;

/**
 * The media-type ESSENCE of Shopee's `Content-Type` (R3-F2): what precedes the
 * first `;`, trimmed and capped. A parameter — `name="<order_sn>.pdf"` — never
 * reaches the log.
 */
function essenciaDoTipo(contentType: string | null): string | null {
  if (contentType === null) return null;
  const essencia = (contentType.split(';')[0] ?? '').trim().slice(0, MAX_TIPO_LOGADO);
  return essencia === '' ? null : essencia;
}

/** 1…50 at a time, in order — the four batch pages' bound. */
function emLotes<T>(itens: readonly T[]): readonly (readonly T[])[] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS) {
    lotes.push(itens.slice(i, i + SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS));
  }
  return lotes;
}

/** A free string trimmed, or `null` when blank/absent. */
function aparado(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** The fields every batch row shares. */
interface LinhaDeLote {
  readonly order_sn: string;
  readonly package_number: string | null;
  readonly fail_error: string | null;
  readonly fail_message: string | null;
}

/** A batch answer matched to the packages it was asked about. */
interface Conciliacao<Row> {
  /** The rows that name one asked package (or the single package of an unsplit order). */
  readonly porPacote: ReadonlyMap<string, Row>;
  /** A FAILED row with no package number on a split order — the whole batch's. */
  readonly falhaDoLote: { readonly code: string; readonly mensagem: string | null } | null;
}

/* --------------------------------- the call --------------------------------- */

class ChamadaDeEtiqueta {
  private readonly prazo: number;
  private ordem: ObservacaoOrdemEtiqueta = { status: null, fbs: false, pacotes: [] };
  private readonly pacotes = new Map<string, ObservacaoPacoteEtiqueta>();
  /** `suggest_shipping_document_type`, per package — the fallback of a refused type. */
  private readonly sugeridos = new Map<string, string | null>();
  /** Packages whose document type already fell back once in this call. */
  private readonly tiposRebaixados = new Set<string>();
  /** ARRANGED in this call (our ship, or `package_already_shipped`) — sticky. */
  private readonly programados = new Set<string>();
  /** Packages to re-read before the next decision (after an arrange). */
  private readonly aReler = new Set<string>();
  /** The order and EVERY package must be read (again) before the next decision. */
  private precisaLerTudo = true;
  private primeiraLeitura = true;
  private rederivou = false;
  private arquivoVazioVisto = false;
  /** A ship WITHOUT `package_number` succeeded in this call: the ORDER is arranged (R2-2). */
  private ordemProgramadaSemPacote = false;

  constructor(
    private readonly deps: DepsExecucaoEtiqueta,
    private readonly e: EntradaEtiqueta,
  ) {
    this.prazo = deps.agora() + (deps.orcamentoMs ?? ORCAMENTO_ETIQUETA_MS);
  }

  async executar(): Promise<ResultadoEtiqueta> {
    for (;;) {
      let passo: Passo;
      if (this.precisaLerTudo) {
        passo = await this.lerTudo();
      } else if (this.aReler.size > 0) {
        const leitura = await this.lerPacotes([...this.aReler], 'aguardando-rastreio');
        // Only what was READ leaves the set: a lot a wait interrupted is read
        // again on the next iteration (M1).
        for (const numero of leitura.lidos) this.aReler.delete(numero);
        passo = leitura.passo;
      } else {
        const acao = decidirProximaAcao(this.ordem, [...this.pacotes.values()], {
          pacote: this.e.pacote,
        });
        passo = await this.executarAcao(acao);
      }
      if (passo.fim) return passo.resultado;
    }
  }

  /* ------------------------------ the answers ------------------------------ */

  /** The packages the progress counts: the working set, minus the cancelled ones. */
  private progresso(): Progresso {
    const numeros = this.e.pacote !== null ? [this.e.pacote] : this.ordem.pacotes;
    const vistos = numeros
      .map((n) => this.pacotes.get(n))
      .filter((p): p is ObservacaoPacoteEtiqueta => p !== undefined)
      .filter((p) => fasePacote(p) !== 'inelegivel');
    return progressoDe(vistos);
  }

  private aguardar(fase: FaseEtiqueta, tentarEmMs: number): ResultadoEtiqueta {
    return {
      tipo: 'pendente',
      corpo: {
        acao: 'aguardar',
        fase,
        tentarEmMs: Math.max(0, tentarEmMs),
        mensagem: MENSAGEM_DA_FASE[fase],
        progresso: this.progresso(),
      },
    };
  }

  private porPacote(pacotes: readonly string[]): ResultadoEtiqueta {
    return {
      tipo: 'pendente',
      corpo: {
        acao: 'baixar-por-pacote',
        fase: 'baixando',
        pacotes,
        mensagem: MENSAGEM_BAIXAR_POR_PACOTE,
        progresso: this.progresso(),
      },
    };
  }

  private simulado(acao: AcaoEtiqueta): Passo {
    return fim({
      tipo: 'simulado',
      acao,
      fases: this.ordem.pacotes.map((n) => {
        const obs = this.pacotes.get(n);
        return obs === undefined ? 'desconhecido' : fasePacote(obs);
      }),
      progresso: this.progresso(),
    });
  }

  /** The package's 1-based position in the order, when the order is split. */
  private posicao(numero: string): number | null {
    const total = this.ordem.pacotes.length;
    const i = this.ordem.pacotes.indexOf(numero);
    return total > 1 && i >= 0 ? i + 1 : null;
  }

  /* ------------------------------ the budget ------------------------------- */

  /** `null` ⇒ go; otherwise the answer for an action that may not start. */
  private semTempo(fase: FaseEtiqueta): Passo | null {
    return this.deps.agora() >= this.prazo ? fim(this.aguardar(fase, 0)) : null;
  }

  /** Sleep `ms` only when the call is still inside its budget afterwards. */
  private async esperar(ms: number, fase: FaseEtiqueta): Promise<Passo> {
    if (this.deps.agora() + ms >= this.prazo) return fim(this.aguardar(fase, ms));
    await this.deps.dormir(ms);
    return SEGUIR;
  }

  /* ------------------------------- the errors ------------------------------ */

  /**
   * A THROWN failure of one operation: the empty-file count, then the
   * classifier. `null` ⇒ the caller rethrows `err` untouched (a second empty
   * file, or a failure the table does not own).
   */
  private async tratarErro(
    op: OperacaoEtiqueta,
    err: unknown,
    fase: FaseEtiqueta,
    afetados: readonly string[],
  ): Promise<Passo | null> {
    if (err instanceof ShopeeArquivoVazioError) {
      // ONE wait per call; the second empty file goes to the route's 502.
      if (this.arquivoVazioVisto) return null;
      this.arquivoVazioVisto = true;
    }
    const v = classificarErroDeEtiqueta(op, err, this.deps.agora());
    return v === null ? null : this.tratarVeredito(v, op, codigoDoErro(err), fase, afetados);
  }

  /** A failed batch ROW — the same table; `null` (nothing to rethrow) is an unknown refusal. */
  private async tratarFalhaDeLinha(
    op: OperacaoEtiqueta,
    falha: { readonly code: string; readonly mensagem: string | null },
    fase: FaseEtiqueta,
    afetados: readonly string[],
  ): Promise<Passo> {
    const codigo = codigoParaOperador(falha.code);
    const v = classificarFalhaDeLinha(op, falha, this.deps.agora());
    if (v === null) return fim(recusaDesconhecida(op, codigo));
    return this.tratarVeredito(v, op, codigo, fase, afetados);
  }

  /**
   * A verdict of any operation but the arrange (which `programar` maps
   * itself). `codigo` is Shopee's code, already through the gate, for the
   * arms that answer an unknown refusal the classifier did not name.
   */
  private async tratarVeredito(
    v: VereditoDeErro,
    op: OperacaoEtiqueta,
    codigo: string | null,
    fase: FaseEtiqueta,
    afetados: readonly string[],
  ): Promise<Passo> {
    switch (v.tipo) {
      case 'nfe-pendente':
        return fim({ tipo: 'nfe-pendente' });
      case 'recusa':
        return fim(
          v.motivo === MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida
            ? recusaDesconhecida(op, v.shopeeCode)
            : recusa(v.motivo, v.tentarApos),
        );
      case 'aguardar':
        return this.esperar(v.tentarEmMs, v.fase);
      case 'verificar':
        // Only the arrange answers it, and the arrange never gets here.
        return fim(this.aguardar('programando', ESPERA_POS_PROGRAMAR_MS));
      case 'ja-programado':
      case 'pacotes-mudaram':
      case 'fase-desatualizada':
        return this.rederivar(v.tipo === 'pacotes-mudaram', fase);
      case 'baixar-separado':
        return fim(afetados.length > 1 ? this.porPacote(afetados) : recusaDesconhecida(op, codigo));
      case 'tipo-invalido':
        return this.rebaixarTipo(afetados);
      case 'reenviar-sem-pacote':
      case 'reescolher-envio':
        return fim(recusaDesconhecida(op, codigo));
    }
  }

  /**
   * Shopee says the call ran ahead of it (the package list changed, a
   * document step out of order): re-read EVERYTHING once — arranged packages
   * stay arranged. The second time in one call is the operator's click.
   */
  private rederivar(pacotesMudaram: boolean, fase: FaseEtiqueta): Passo {
    if (this.rederivou) {
      return fim(
        pacotesMudaram
          ? recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram)
          : this.aguardar(fase, TENTAR_EM_SHOPEE_MS),
      );
    }
    this.rederivou = true;
    this.pacotes.clear();
    this.sugeridos.clear();
    // The full re-read covers every pending one (arranged packages stay
    // arranged through `programados`).
    this.aReler.clear();
    this.precisaLerTudo = true;
    return SEGUIR;
  }

  /**
   * The document type was refused: fall back ONCE per package — to Shopee's
   * `suggest`, else to no type at all (Shopee's default) — and create again.
   */
  private rebaixarTipo(afetados: readonly string[]): Passo {
    for (const numero of afetados) {
      const obs = this.pacotes.get(numero);
      if (obs === undefined) continue;
      if (this.tiposRebaixados.has(numero)) {
        return fim(recusa(MOTIVO_ETIQUETA_SHOPEE.tipoInvalido));
      }
      const sugerido = this.sugeridos.get(numero) ?? null;
      const proximo =
        sugerido !== null && sugerido !== obs.tipoDocumento
          ? sugerido
          : obs.tipoDocumento !== TIPO_OMITIDO
            ? TIPO_OMITIDO
            : null;
      if (proximo === null) return fim(recusa(MOTIVO_ETIQUETA_SHOPEE.tipoInvalido));
      this.tiposRebaixados.add(numero);
      this.pacotes.set(numero, {
        ...obs,
        tipoDocumento: proximo,
        documento: 'inexistente',
        recriadoNestaChamada: false,
      });
    }
    return SEGUIR;
  }

  /* ------------------------------- the reads ------------------------------- */

  /**
   * The order, then every package of it. The call's FIRST read is exempt from
   * the budget (a call that read nothing could answer nothing); every later
   * one — a re-derive, a retry after a wait — is an action like any other.
   *
   * ⚠️ The read counts as done only when EVERY lot was folded in (M1). The
   * flag drops BEFORE the reads, so a `rederivar` reached from inside them —
   * which raises it again — is never overwritten; a hole raises it too.
   *
   * ⚠️ Every stop in here reports `consultando` (review 2, F5): this read opens
   * a reprint and a document poll as much as an arrange, and `programando`
   * would read to the operator as a second arrange.
   */
  private async lerTudo(): Promise<Passo> {
    const isento = this.primeiraLeitura;
    this.primeiraLeitura = false;
    if (!isento) {
      const parar = this.semTempo('consultando');
      if (parar !== null) return parar;
    }
    this.precisaLerTudo = false;

    let linha: ShopeeOrderDetailRow | null;
    try {
      const detalhe = await this.deps.client.getOrderDetail({
        orderSnList: [this.e.orderSn],
        responseOptionalFields: SHOPEE_ETIQUETA_DETALHE_CAMPOS,
      });
      // By `order_sn`, never by position.
      linha = detalhe.order_list.find((r) => r.order_sn === this.e.orderSn) ?? null;
    } catch (err: unknown) {
      // Nothing was read: whatever the verdict, the next iteration reads again.
      this.precisaLerTudo = true;
      const passo = await this.tratarErro('detalhe-pedido', err, 'consultando', []);
      if (passo === null) throw err;
      return passo;
    }

    const numeros = (linha?.package_list ?? [])
      .map((p) => textoShopeeUtilizavel(p.package_number))
      .filter((n): n is string => n !== null);
    this.ordem = {
      status: linha?.order_status ?? null,
      fbs: linha?.fulfillment_flag?.trim().toLowerCase() === FULFILLMENT_SHOPEE,
      pacotes: [...new Set(numeros)],
    };

    const leitura = await this.lerPacotes(this.ordem.pacotes, 'consultando', isento);
    if (leitura.lidos.length < this.ordem.pacotes.length) this.precisaLerTudo = true;
    return leitura.passo;
  }

  /**
   * `get_package_detail` for these packages, 50 at a time, folded in. Answers
   * how the step ended AND which packages were read: a lot that failed — and
   * every lot after it — is not in `lidos`, so the caller reads it again
   * instead of deciding on its absence (M1).
   */
  private async lerPacotes(
    numeros: readonly string[],
    fase: FaseEtiqueta,
    isento = false,
  ): Promise<{ readonly passo: Passo; readonly lidos: readonly string[] }> {
    const lidos: string[] = [];
    for (const lote of emLotes(numeros)) {
      if (!isento) {
        const parar = this.semTempo(fase);
        if (parar !== null) return { passo: parar, lidos };
      }
      let linhas: readonly (ShopeePackageDetailRow | null)[];
      try {
        linhas = (await this.deps.client.getPackageDetail({ packageNumbers: lote })).package_list;
      } catch (err: unknown) {
        const passo = await this.tratarErro('detalhe-pacote', err, fase, lote);
        if (passo === null) throw err;
        return { passo, lidos };
      }
      const pedidos = new Set(lote);
      for (const row of linhas) {
        if (row === null || row.order_sn !== this.e.orderSn) continue;
        const numero = row.package_number.trim();
        if (pedidos.has(numero)) this.dobrarPacote(numero, row);
      }
      // Read — a package Shopee gave no row for is an ANSWER (the decision's
      // `status-desconhecido`), not a hole.
      lidos.push(...lote);
    }
    return { passo: SEGUIR, lidos };
  }

  /**
   * One `get_package_detail` row → the package's observation. What only THIS
   * call learned is kept: an arrange stays arranged, and a tracking number
   * read from `get_tracking_number` survives a re-read that shows none yet.
   */
  private dobrarPacote(numero: string, row: ShopeePackageDetailRow): void {
    const anterior = this.pacotes.get(numero);
    const rastreioDaLinha = RASTREIO_DO_PACOTE_VALE
      ? textoShopeeUtilizavel(row.tracking_number)
      : null;
    this.pacotes.set(numero, {
      numero,
      canalId: row.logistics_channel_id,
      fulfillment: row.fulfillment_status,
      arranjado: this.programados.has(numero) ? true : row.is_shipment_arranged,
      termosPendentes: row.pending_terms ?? [],
      nfePendente: row.invoice_pending?.status?.trim().toLowerCase() === NF_PENDENTE,
      rastreio: rastreioDaLinha ?? anterior?.rastreio ?? null,
      tipoDocumento: anterior?.tipoDocumento ?? null,
      documento: anterior?.documento ?? 'desconhecido',
      recriadoNestaChamada: anterior?.recriadoNestaChamada ?? false,
    });
  }

  private atualizar(numero: string, patch: Partial<ObservacaoPacoteEtiqueta>): void {
    const obs = this.pacotes.get(numero);
    if (obs !== undefined) this.pacotes.set(numero, { ...obs, ...patch });
  }

  /**
   * Match batch rows to the packages asked about — by `(order_sn,
   * package_number)`, never by position (W2's rule for a null package number).
   */
  private conciliar<Row extends LinhaDeLote>(
    lote: ShopeeLoteLogistico<Row>,
    pedidos: readonly string[],
  ): Conciliacao<Row> {
    const porPacote = new Map<string, Row>();
    let falhaDoLote: Conciliacao<Row>['falhaDoLote'] = null;
    const unico = this.ordem.pacotes.length === 1 ? (this.ordem.pacotes[0] ?? null) : null;
    for (const row of lote.linhas) {
      if (row.order_sn !== this.e.orderSn) continue;
      const numero = aparado(row.package_number) ?? unico;
      if (numero !== null) {
        if (pedidos.includes(numero) && !porPacote.has(numero)) porPacote.set(numero, row);
        continue;
      }
      // A split order and a row that names no package: never guess which.
      const falha = falhaDaLinha(row);
      if (falha !== null && falhaDoLote === null) falhaDoLote = falha;
    }
    return { porPacote, falhaDoLote };
  }

  /* ------------------------------ the actions ------------------------------ */

  private async executarAcao(acao: AcaoEtiqueta): Promise<Passo> {
    switch (acao.tipo) {
      case 'recusa':
        if (acao.motivo === MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido)
          this.logarStatusDesconhecido();
        return fim(recusa(acao.motivo));
      case 'nfe-pendente':
        return fim({ tipo: 'nfe-pendente' });
      case 'programar':
        return this.programar(acao);
      case 'buscar-rastreio':
        return this.buscarRastreio(acao.pacotes);
      case 'ler-parametros-documento':
        return this.lerParametrosDocumento(acao.pacotes);
      case 'ler-resultado':
        return this.lerResultado(acao.pacotes);
      case 'criar-documento':
        return this.criarDocumento(acao);
      case 'aguardar-documento':
        return this.aguardarDocumento();
      case 'baixar':
        return this.baixar(acao);
      case 'por-pacote':
        return fim(this.porPacote(acao.pacotes));
    }
  }

  /**
   * ONE line for a `status-desconhecido` refusal (R3-F1): the fulfilment
   * TOKENS of the working set's unknown packages, each through
   * {@link tokenParaLog} — the token the table must learn. Never a number: a
   * package appears only as its token, or as {@link SEM_LINHA}.
   */
  private logarStatusDesconhecido(): void {
    const numeros = this.e.pacote !== null ? [this.e.pacote] : this.ordem.pacotes;
    const tokens = new Set<string>();
    for (const numero of numeros) {
      const obs = this.pacotes.get(numero);
      if (obs === undefined) tokens.add(SEM_LINHA);
      else if (fasePacote(obs) === 'desconhecido') tokens.add(tokenParaLog(obs.fulfillment));
    }
    console.warn('[shopee etiqueta] status desconhecido', { tokens: [...tokens] });
  }

  /** ARRANGE one package — every non-success ends the call (module docblock). */
  private async programar(acao: Extract<AcaoEtiqueta, { tipo: 'programar' }>): Promise<Passo> {
    if (this.deps.somenteLeitura === true) return this.simulado(acao);
    // S38: refused BEFORE `get_shipping_parameter`.
    if (!this.deps.podeProgramar) return fim({ tipo: 'sem-permissao' });
    // Defensive: an arrange of this call is sticky, so the decision cannot
    // name it again — and if it ever did, nothing re-ships in-call.
    if (this.programados.has(acao.pacote)) {
      return fim(this.aguardar('programando', ESPERA_POS_PROGRAMAR_MS));
    }
    const parar = this.semTempo('programando');
    if (parar !== null) return parar;

    const r = await programarPacoteShopee(
      this.deps.client,
      {
        orderSn: this.e.orderSn,
        packageNumber: acao.pacote,
        comPacote: acao.comPacote,
        ordemProgramadaSemPacote: this.ordemProgramadaSemPacote,
      },
      this.e.envio,
      this.deps.agora(),
    );
    switch (r.tipo) {
      case 'programado':
      case 'ja-programado': {
        // A ship with no package number arranged the whole ORDER (R2-2).
        if (r.tipo === 'programado' && r.semPacote) this.ordemProgramadaSemPacote = true;
        this.programados.add(acao.pacote);
        this.atualizar(acao.pacote, { arranjado: true });
        this.aReler.add(acao.pacote);
        // Our own ship may not be observable yet (register 208): pause, then
        // re-read the package for its tracking number.
        return r.tipo === 'programado'
          ? this.esperar(ESPERA_POS_PROGRAMAR_MS, 'aguardando-rastreio')
          : SEGUIR;
      }
      case 'nfe-pendente':
        return fim({ tipo: 'nfe-pendente' });
      case 'verificar':
        return fim(this.aguardar('programando', ESPERA_POS_PROGRAMAR_MS));
      case 'pergunta': {
        const total = this.ordem.pacotes.length;
        const i = this.posicao(acao.pacote);
        return fim({
          tipo: 'pendente',
          corpo: {
            acao: 'escolher-envio',
            fase: 'programando',
            pacote: acao.pacote,
            pacoteRotulo: i === null ? null : `Pacote ${String(i)} de ${String(total)}`,
            mensagem: r.escolhaInvalida ? MENSAGEM_ESCOLHA_INVALIDA : MENSAGEM_ESCOLHER_ENVIO,
            enderecos: r.enderecos,
            permiteDropoff: r.permiteDropoff,
            escolhaInvalida: r.escolhaInvalida,
            progresso: this.progresso(),
          },
        });
      }
      case 'aguardar':
        return fim(this.aguardar(r.fase, r.tentarEmMs));
      case 'recusa':
        return fim(
          r.motivo === MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida
            ? recusaDesconhecida(r.operacao ?? 'programar', r.shopeeCode)
            : recusa(r.motivo, r.tentarApos),
        );
    }
  }

  /** `get_tracking_number`, one package at a time; still none ⇒ the poll interval. */
  private async buscarRastreio(pacotes: readonly string[]): Promise<Passo> {
    for (const numero of pacotes) {
      const parar = this.semTempo('aguardando-rastreio');
      if (parar !== null) return parar;
      try {
        const r = await this.deps.client.getTrackingNumber({
          orderSn: this.e.orderSn,
          packageNumber: numero,
        });
        // Round-trip check 7: `"-"` / `""` is NO tracking number.
        const rastreio = textoShopeeUtilizavel(r.tracking_number);
        if (rastreio !== null) this.atualizar(numero, { rastreio });
      } catch (err: unknown) {
        const passo = await this.tratarErro('rastreio', err, 'aguardando-rastreio', [numero]);
        if (passo === null) throw err;
        return passo;
      }
    }
    const faltam = pacotes.some(
      (n) => textoShopeeUtilizavel(this.pacotes.get(n)?.rastreio) === null,
    );
    return faltam ? this.esperar(INTERVALO_RASTREIO_MS, 'aguardando-rastreio') : SEGUIR;
  }

  /** Which document type each package gets (R-u) — always a DECISION, never "unread". */
  private async lerParametrosDocumento(pacotes: readonly string[]): Promise<Passo> {
    const pedido = TIPO_DOCUMENTO_DO_FORMATO[this.e.formato];
    for (const lote of emLotes(pacotes)) {
      const parar = this.semTempo('gerando-documento');
      if (parar !== null) return parar;
      let resposta: ShopeeLoteLogistico<ShopeeParametroDeDocumento>;
      try {
        resposta = await this.deps.client.getShippingDocumentParameter({
          pacotes: lote.map((n) => this.alvo(n)),
        });
      } catch (err: unknown) {
        const passo = await this.tratarErro('parametro-documento', err, 'gerando-documento', lote);
        if (passo === null) throw err;
        return passo;
      }
      const { porPacote, falhaDoLote } = this.conciliar(resposta, lote);
      if (falhaDoLote !== null) {
        return this.tratarFalhaDeLinha(
          'parametro-documento',
          falhaDoLote,
          'gerando-documento',
          lote,
        );
      }
      for (const numero of lote) {
        const row = porPacote.get(numero);
        const falha = row === undefined ? null : falhaDaLinha(row);
        if (falha !== null) {
          return this.tratarFalhaDeLinha('parametro-documento', falha, 'gerando-documento', [
            numero,
          ]);
        }
        const sugerido = aparado(row?.suggest_shipping_document_type);
        const selecionaveis = (row?.selectable_shipping_document_type ?? []).map((t) => t.trim());
        this.sugeridos.set(numero, sugerido);
        // No row at all is no information: Shopee's default, which is a decision.
        const tipo = selecionaveis.includes(pedido) ? pedido : (sugerido ?? TIPO_OMITIDO);
        this.atualizar(numero, { tipoDocumento: tipo });
      }
    }
    return SEGUIR;
  }

  /** Where each package's label task stands. */
  private async lerResultado(pacotes: readonly string[]): Promise<Passo> {
    for (const lote of emLotes(pacotes)) {
      const parar = this.semTempo('gerando-documento');
      if (parar !== null) return parar;
      let resposta: ShopeeLoteLogistico<ShopeeResultadoDeDocumento>;
      try {
        resposta = await this.deps.client.getShippingDocumentResult({
          documentos: lote.map((n) => this.alvoComTipo(n)),
        });
      } catch (err: unknown) {
        const passo = await this.tratarErro('resultado-documento', err, 'gerando-documento', lote);
        if (passo === null) throw err;
        return passo;
      }
      const { porPacote, falhaDoLote } = this.conciliar(resposta, lote);
      if (falhaDoLote !== null) {
        return this.tratarFalhaDeLinha(
          'resultado-documento',
          falhaDoLote,
          'gerando-documento',
          lote,
        );
      }
      for (const numero of lote) {
        const row = porPacote.get(numero);
        if (row === undefined) {
          // No row: not proven to exist, not proven absent — read it again later.
          this.atualizar(numero, { documento: 'processando' });
          continue;
        }
        const status = aparado(row.status);
        // The TASK failed: re-created once, then `documento-falhou` (the
        // decision's rule 10) — whatever `fail_error` rides beside it.
        if (status === SHOPEE_SHIPPING_DOCUMENT_STATUS.falhou) {
          this.atualizar(numero, { documento: 'falhou' });
          continue;
        }
        const falha = falhaDaLinha(row);
        if (falha !== null) {
          const op = 'resultado-documento';
          const codigo = codigoParaOperador(falha.code);
          const v = classificarFalhaDeLinha(op, falha, this.deps.agora());
          if (v === null) return fim(recusaDesconhecida(op, codigo));
          // `shipping_document_should_print_first`: nothing was created yet.
          if (v.tipo === 'fase-desatualizada') {
            this.atualizar(numero, { documento: 'inexistente' });
            continue;
          }
          return this.tratarVeredito(v, op, codigo, 'gerando-documento', [numero]);
        }
        // READY; else PROCESSING, or a status nobody documented: NOT ready.
        this.atualizar(numero, {
          documento: status === SHOPEE_SHIPPING_DOCUMENT_STATUS.pronto ? 'pronto' : 'processando',
        });
      }
    }
    return SEGUIR;
  }

  /** Start the label task — with the tracking number whenever the package has one. */
  private async criarDocumento(
    acao: Extract<AcaoEtiqueta, { tipo: 'criar-documento' }>,
  ): Promise<Passo> {
    if (this.deps.somenteLeitura === true) return this.simulado(acao);
    for (const lote of emLotes(acao.pacotes)) {
      const parar = this.semTempo('gerando-documento');
      if (parar !== null) return parar;
      let resposta: ShopeeLoteLogistico<ShopeeLinhaDeLote>;
      try {
        resposta = await this.deps.client.createShippingDocument({
          documentos: lote.map((n) => {
            const rastreio = textoShopeeUtilizavel(this.pacotes.get(n)?.rastreio);
            return {
              ...this.alvoComTipo(n),
              ...(rastreio === null ? {} : { trackingNumber: rastreio }),
            };
          }),
        });
      } catch (err: unknown) {
        const passo = await this.tratarErro('criar-documento', err, 'gerando-documento', lote);
        if (passo === null) throw err;
        return passo;
      }
      // ⚠️ Stamped only AFTER Shopee answered the create. A transient throw above is waited
      // out inside the budget and the decision runs again: a stamp placed before the call
      // would let rule 10 answer a terminal `documento-falhou` for a re-create that never
      // reached Shopee (the write-side twin of "an incomplete read never decides").
      for (const numero of lote) {
        if (this.pacotes.get(numero)?.documento === 'falhou') {
          this.atualizar(numero, { recriadoNestaChamada: true });
        }
      }
      const { porPacote, falhaDoLote } = this.conciliar(resposta, lote);
      if (falhaDoLote !== null) {
        return this.tratarFalhaDeLinha('criar-documento', falhaDoLote, 'gerando-documento', lote);
      }
      let primeiraFalha: { numero: string; code: string; mensagem: string | null } | null = null;
      for (const numero of lote) {
        const row = porPacote.get(numero);
        const falha = row === undefined ? null : falhaDaLinha(row);
        if (falha !== null) {
          primeiraFalha ??= { numero, ...falha };
          continue;
        }
        // Accepted ⇒ processing; no row ⇒ unknown, the result read decides.
        this.atualizar(numero, { documento: row === undefined ? 'desconhecido' : 'processando' });
      }
      if (primeiraFalha !== null) {
        return this.tratarFalhaDeLinha('criar-documento', primeiraFalha, 'gerando-documento', [
          primeiraFalha.numero,
        ]);
      }
    }
    return SEGUIR;
  }

  /** Every task still processing: one poll interval, then read the result again. */
  private async aguardarDocumento(): Promise<Passo> {
    const passo = await this.esperar(INTERVALO_DOCUMENTO_MS, 'gerando-documento');
    if (passo.fim) return passo;
    for (const [numero, obs] of this.pacotes) {
      if (obs.documento === 'processando') this.atualizar(numero, { documento: 'desconhecido' });
    }
    return SEGUIR;
  }

  /** The ONE file — judged by its signature, never by a header. */
  private async baixar(acao: Extract<AcaoEtiqueta, { tipo: 'baixar' }>): Promise<Passo> {
    if (this.deps.somenteLeitura === true) return this.simulado(acao);
    // One download names at most 50 packages; more cannot be ONE file.
    if (acao.pacotes.length > SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS) {
      return fim(this.porPacote(acao.pacotes));
    }
    const parar = this.semTempo('baixando');
    if (parar !== null) return parar;
    let arquivo: ShopeeArquivoBaixado;
    try {
      arquivo = await this.deps.client.downloadShippingDocument({
        ...(acao.tipoDocumento === null || acao.tipoDocumento === TIPO_OMITIDO
          ? {}
          : { shippingDocumentType: acao.tipoDocumento }),
        documentos: acao.pacotes.map((n) => this.alvo(n)),
      });
    } catch (err: unknown) {
      const passo = await this.tratarErro('baixar', err, 'baixando', acao.pacotes);
      if (passo === null) throw err;
      return passo;
    }
    const formato = classificarArquivoDeEnvio(arquivo.bytes);
    if (formato.formato === 'desconhecido') {
      // The length and the header's media-type ESSENCE only — never a byte,
      // never a header parameter (R3-F2).
      console.warn('[shopee etiqueta] arquivo de formato desconhecido', {
        bytes: arquivo.bytes.byteLength,
        contentType: essenciaDoTipo(arquivo.contentType),
        httpStatus: arquivo.httpStatus,
      });
      return fim({ tipo: 'formato-desconhecido' });
    }
    return fim({
      tipo: 'bytes',
      bytes: arquivo.bytes,
      formato: formato.formato,
      contentType: formato.contentType,
      extensao: formato.extensao,
      indice: this.e.pacote === null ? null : this.posicao(this.e.pacote),
      total: this.ordem.pacotes.length,
    });
  }

  /* ------------------------------- the targets ----------------------------- */

  /** Every operation but the ship always names the package (R-l). */
  private alvo(numero: string): ShopeeAlvoDePacote {
    return { orderSn: this.e.orderSn, packageNumber: numero };
  }

  private alvoComTipo(numero: string): ShopeeAlvoDePacote & { shippingDocumentType?: string } {
    const tipo = this.pacotes.get(numero)?.tipoDocumento ?? null;
    return tipo === null || tipo === TIPO_OMITIDO
      ? this.alvo(numero)
      : { ...this.alvo(numero), shippingDocumentType: tipo };
  }
}
