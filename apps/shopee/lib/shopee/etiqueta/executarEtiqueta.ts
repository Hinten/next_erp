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
 * an address or a byte — one line counts the bytes of an unknown file.
 */
import {
  SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS,
  SHOPEE_SHIPPING_DOCUMENT_STATUS,
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
} from './constantesEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  classificarErroDeEtiqueta,
  classificarFalhaDeLinha,
  type MotivoEtiquetaShopee,
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
import { programarPacoteShopee } from './programarPacote';
import {
  MENSAGEM_BAIXAR_POR_PACOTE,
  MENSAGEM_DA_FASE,
  MENSAGEM_ESCOLHA_INVALIDA,
  MENSAGEM_ESCOLHER_ENVIO,
  type EtiquetaPendente,
  type Progresso,
} from './respostaEtiqueta';

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
  | { tipo: 'recusa'; motivo: MotivoEtiquetaShopee; tentarApos?: number }
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

/**
 * "Send no `shipping_document_type`" — Shopee's own default. A NON-null value
 * on purpose: `tipoDocumento: null` is "not read yet" to the decision.
 */
const TIPO_OMITIDO = '';

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
  private precisaLerTudo = true;
  private primeiraLeitura = true;
  private rederivou = false;
  private arquivoVazioVisto = false;

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
        passo = await this.lerPacotes([...this.aReler], 'aguardando-rastreio');
        if (!passo.fim) this.aReler.clear();
      } else {
        const acao = decidirProximaAcao(
          this.ordem,
          [...this.pacotes.values()],
          { pacote: this.e.pacote },
          this.deps.agora(),
        );
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
    return v === null ? null : this.tratarVeredito(v, fase, afetados);
  }

  /** A failed batch ROW — the same table; `null` (nothing to rethrow) is an unknown refusal. */
  private async tratarFalhaDeLinha(
    op: OperacaoEtiqueta,
    falha: { readonly code: string; readonly mensagem: string | null },
    fase: FaseEtiqueta,
    afetados: readonly string[],
  ): Promise<Passo> {
    const v = classificarFalhaDeLinha(op, falha, this.deps.agora());
    if (v === null) return fim(recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida));
    return this.tratarVeredito(v, fase, afetados);
  }

  /** A verdict of any operation but the arrange (which `programar` maps itself). */
  private async tratarVeredito(
    v: VereditoDeErro,
    fase: FaseEtiqueta,
    afetados: readonly string[],
  ): Promise<Passo> {
    switch (v.tipo) {
      case 'nfe-pendente':
        return fim({ tipo: 'nfe-pendente' });
      case 'recusa':
        return fim(recusa(v.motivo, v.tentarApos));
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
        return fim(
          afetados.length > 1
            ? this.porPacote(afetados)
            : recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida),
        );
      case 'tipo-invalido':
        return this.rebaixarTipo(afetados);
      case 'reenviar-sem-pacote':
      case 'reescolher-envio':
        return fim(recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida));
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
   */
  private async lerTudo(): Promise<Passo> {
    const isento = this.primeiraLeitura;
    this.primeiraLeitura = false;
    if (!isento) {
      const parar = this.semTempo('programando');
      if (parar !== null) return parar;
    }

    let linha: ShopeeOrderDetailRow | null;
    try {
      const detalhe = await this.deps.client.getOrderDetail({
        orderSnList: [this.e.orderSn],
        responseOptionalFields: SHOPEE_ETIQUETA_DETALHE_CAMPOS,
      });
      // By `order_sn`, never by position.
      linha = detalhe.order_list.find((r) => r.order_sn === this.e.orderSn) ?? null;
    } catch (err: unknown) {
      const passo = await this.tratarErro('detalhe-pedido', err, 'programando', []);
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

    const passo = await this.lerPacotes(this.ordem.pacotes, 'programando', isento);
    if (!passo.fim) this.precisaLerTudo = false;
    return passo;
  }

  /** `get_package_detail` for these packages, 50 at a time, folded in. */
  private async lerPacotes(
    numeros: readonly string[],
    fase: FaseEtiqueta,
    isento = false,
  ): Promise<Passo> {
    for (const lote of emLotes(numeros)) {
      if (!isento) {
        const parar = this.semTempo(fase);
        if (parar !== null) return parar;
      }
      let linhas: readonly (ShopeePackageDetailRow | null)[];
      try {
        linhas = (await this.deps.client.getPackageDetail({ packageNumbers: lote })).package_list;
      } catch (err: unknown) {
        const passo = await this.tratarErro('detalhe-pacote', err, fase, lote);
        if (passo === null) throw err;
        return passo;
      }
      const pedidos = new Set(lote);
      for (const row of linhas) {
        if (row === null || row.order_sn !== this.e.orderSn) continue;
        const numero = row.package_number.trim();
        if (pedidos.has(numero)) this.dobrarPacote(numero, row);
      }
    }
    return SEGUIR;
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
      { orderSn: this.e.orderSn, packageNumber: acao.pacote, comPacote: acao.comPacote },
      this.e.envio,
      this.deps.agora(),
    );
    switch (r.tipo) {
      case 'programado':
      case 'ja-programado': {
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
        return fim(recusa(r.motivo, r.tentarApos));
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
          const v = classificarFalhaDeLinha('resultado-documento', falha, this.deps.agora());
          if (v === null) return fim(recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida));
          // `shipping_document_should_print_first`: nothing was created yet.
          if (v.tipo === 'fase-desatualizada') {
            this.atualizar(numero, { documento: 'inexistente' });
            continue;
          }
          return this.tratarVeredito(v, 'gerando-documento', [numero]);
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
      for (const numero of lote) {
        if (this.pacotes.get(numero)?.documento === 'falhou') {
          this.atualizar(numero, { recriadoNestaChamada: true });
        }
      }
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
      // Lengths and Shopee's header only — never a byte.
      console.warn('[shopee etiqueta] arquivo de formato desconhecido', {
        bytes: arquivo.bytes.byteLength,
        contentType: arquivo.contentType,
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
