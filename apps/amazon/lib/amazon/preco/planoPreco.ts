/**
 * The price plan of the Amazon price push (step 13, PR 13-c), pure: EVERY
 * decision of the flow's `apps/amazon` side that compares two prices lives
 * here. A module that needs one (a run's page, so far) calls these functions
 * and compares no price itself, so the fold that decides "the same price" has
 * exactly one calling file in this app (the fold inventory pins it). The
 * faixa's own `minimo ≤ base ≤ maximo` ordering is the faixa's, in
 * `@delfrance/schemas`.
 *
 * ## The fold: the same centavo
 *
 * Two prices are THE SAME when they round to the same centavo, through
 * `mesmoPrecoEmReais` (`@delfrance/schemas`), applied verbatim: `10.004` ≡
 * `10`, while `49.99` and `49.991` both differ from `50`. An unknown price
 * (`null`) equals nothing.
 *
 *  - {@link mesmaOfertaAmazon}: Amazon's offer equals a faixa only when the
 *    read is `lida` and all THREE prices are the same; an absent floor or
 *    ceiling never equals a sent one, and an offer that is `ausente`,
 *    `ambigua` or `ilegivel` equals nothing.
 *  - {@link mesmaFaixaPrecoAmazon}: two faixas, price by price.
 *  - {@link direcaoPrecoAmazon}: `our_price` alone, in centavos
 *    (`centavosDeReais`): `sobe`, `desce`, `igual` (the same centavo), or
 *    `desconhecida` when the reference price is unknown. The floor and the
 *    ceiling never make a move a decrease.
 *
 * ## The decrease guard
 *
 * Lowering `our_price` needs CONSENT, and consent has a depth:
 *
 *  - a decrease from a known price, without consent ⇒
 *    `reducao-sem-consentimento`;
 *  - an offer that may exist but could not be read safely (`ilegivel`,
 *    `ambigua`, or `ausente` on a listing Amazon shows as BUYABLE, where an
 *    absent offer cannot be told from an unread one) ⇒ the move is unknown,
 *    so it needs consent too: `preco-atual-ilegivel`;
 *  - an offer that is `ausente` on a listing that is not buyable has nothing
 *    to lower: no consent;
 *  - a run's send never sets `our_price` below the faixa its page saw
 *    (`pisoConsentimento`, the FLOOR), consent or not, for a decrease, an
 *    unknown move or a send onto a listing with no offer: below it ⇒
 *    `reducao-apos-pagina`; a floor that is `desconhecido` (the part is gone)
 *    refuses each of those. A manual push has no floor (`null`). An increase
 *    from a known price is never bounded.
 *
 * {@link consentimentoValidoPrecoAmazon}: a task's consent lasts
 * {@link JANELA_CONSENTIMENTO_PRECO_AMAZON_MS} from the request.
 *
 * ## The plan of one send ({@link planejarPrecoAmazon})
 *
 * The move is judged from the `our_price` Amazon may hold: its live read, or,
 * while OUR own patch (an `incerto` one included) is younger than
 * {@link JANELA_VISIBILIDADE_PRECO_AMAZON_MS} (Amazon documents up to 15
 * minutes before a backend update shows), the HIGHER of the live price and
 * that patch's. So a patch that may still be landing can only make the
 * decrease guard stricter.
 *
 * `igual` when Amazon already holds the faixa, unless its read is not yet
 * trusted (either rule only ADDS a send, and the send it adds still meets the
 * guard):
 *
 *  - `envio-recente` — the link's last outcome is our patch of ANOTHER faixa,
 *    younger than that lag: the decrease guard judges the send;
 *  - `feed-recente` — the conta's last price feed ended less than that lag
 *    ago (`feedRecenteEmMs`; `null` turns the rule off, as a run's page and a
 *    feed's build pass it): what the feed set is not known per SKU, so the
 *    floor applies; consent does not (the read shows the faixa).
 *
 * Otherwise the decrease guard decides between `escrever` and its refusals.
 *
 * ## The check after a send ({@link planejarVerificacaoPrecoAmazon})
 *
 * In this order: the ERP's faixa no longer the one sent ⇒ `erp-mudou` (nothing
 * is sent that nobody pushed); a NEW blocking price issue (not among the codes
 * read before the send) ⇒ `recusado`; Amazon holding the offer sent ⇒
 * `aceito`, or `aceito-com-avisos` while a BLOCKING price issue read before
 * the send remains (a price `WARNING` blocks nothing); a price issue a person
 * must confirm ⇒ `recusado` (never sent again); else ⇒ `reenviar`.
 *
 * ## A feed member at send time ({@link decidirMembroLotePrecoAmazon})
 *
 * The decrease is judged against the offer Amazon is KNOWN to hold: the
 * page's read when no later send exists (raised, as the page's own plan was,
 * to our patch still inside the lag at that read); a later send Amazon
 * ACCEPTED; for a later send that may not have applied (`incerto`, `recusado`), the HIGHER of
 * the page's `our_price` and that send's (so such an entry only makes the
 * guard stricter); unknown for a later entry with no offer (a feed's) or an
 * unreadable page offer under anything but an accepted send. A member is
 * never dropped for being equal.
 *
 * ## The mass-decrease measure and the sample
 *
 * {@link quedaExcessivaPrecoAmazon}: `our_price` falling by MORE than
 * `QUEDA_MAXIMA_PRECO_AMAZON` of its live value. {@link amostraReducoesPrecoAmazon}:
 * the largest decreases, in centavos, as `sku:antes>depois`.
 *
 * Every instant is MILLISECONDS since epoch; a price or an instant a caller
 * hands in outside its domain is a wiring bug, thrown as a `RangeError` naming
 * the field, never the value.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { centavosDeReais } from '@delfrance/core/money';
import {
  AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX,
  type EnvioPrecoAmazon,
  type FaixaPrecoAmazon,
  type ItemDivergenciaPrecoAmazon,
  MAX_AMOSTRA_PRECO_AMAZON,
  QUEDA_MAXIMA_PRECO_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  type TipoOfertaPrecoAmazon,
  VIA_ENVIO_ESTOQUE_AMAZON,
  mesmoPrecoEmReais,
} from '@delfrance/schemas';

import {
  CLASSE_ISSUE_PRECO_AMAZON,
  classeDaIssuePrecoAmazon,
  codigoDaIssueAmazon,
  listaDeIssuesAmazon,
} from './issuesPreco';

/** Amazon's documented lag before a backend update shows (15 min). */
export const JANELA_VISIBILIDADE_PRECO_AMAZON_MS = 900_000;

/** How long a task's consent to lower prices lasts after its request (60 min). */
export const JANELA_CONSENTIMENTO_PRECO_AMAZON_MS = 3_600_000;

/** How far ahead of the task's clock a request may be stamped and still count (clock skew). */
export const TOLERANCIA_RELOGIO_CONSENTIMENTO_PRECO_AMAZON_MS = 300_000;

/** The longest sample entry a run stores (the run schema's bound). */
export const MAX_CARACTERES_AMOSTRA_PRECO_AMAZON = 200;

/* ---------------------------------- tokens ---------------------------------- */

/** The move of `our_price` (module header). */
export type DirecaoPrecoAmazon = 'sobe' | 'desce' | 'igual' | 'desconhecida';

export const DIRECAO_PRECO_AMAZON = {
  sobe: 'sobe',
  desce: 'desce',
  igual: 'igual',
  desconhecida: 'desconhecida',
} as const satisfies Record<string, DirecaoPrecoAmazon>;

/** What the plan of one send decides (module header). */
export type DecisaoPlanoPrecoAmazon =
  | 'igual'
  | 'reducao-sem-consentimento'
  | 'reducao-apos-pagina'
  | 'preco-atual-ilegivel'
  | 'escrever';

export const DECISAO_PLANO_PRECO_AMAZON = {
  igual: 'igual',
  reducaoSemConsentimento: 'reducao-sem-consentimento',
  reducaoAposPagina: 'reducao-apos-pagina',
  precoAtualIlegivel: 'preco-atual-ilegivel',
  escrever: 'escrever',
} as const satisfies Record<string, DecisaoPlanoPrecoAmazon>;

/** The decrease guard's refusals. */
export type RecusaReducaoPrecoAmazon = Exclude<DecisaoPlanoPrecoAmazon, 'igual' | 'escrever'>;

/** Why a plan writes (module header): the live read differs, or it is not yet trusted. */
export type RegraEscritaPrecoAmazon = 'diferente' | 'envio-recente' | 'feed-recente';

export const REGRA_ESCRITA_PRECO_AMAZON = {
  diferente: 'diferente',
  envioRecente: 'envio-recente',
  feedRecente: 'feed-recente',
} as const satisfies Record<string, RegraEscritaPrecoAmazon>;

/** What the check after a send decides (module header). */
export type DecisaoVerificacaoPrecoAmazon =
  | 'erp-mudou'
  | 'recusado'
  | 'aceito'
  | 'aceito-com-avisos'
  | 'reenviar';

export const DECISAO_VERIFICACAO_PRECO_AMAZON = {
  erpMudou: 'erp-mudou',
  recusado: 'recusado',
  aceito: 'aceito',
  aceitoComAvisos: 'aceito-com-avisos',
  reenviar: 'reenviar',
} as const satisfies Record<string, DecisaoVerificacaoPrecoAmazon>;

/* ---------------------------------- inputs ---------------------------------- */

/**
 * Amazon's offer as a read saw it: the package reader's answer or a part's
 * stored copy. Only `lida` carries prices; a `lida` without a usable
 * `our_price` is read as `ilegivel`.
 */
export interface OfertaVistaPrecoAmazon {
  readonly tipo: TipoOfertaPrecoAmazon;
  readonly base?: number | null;
  readonly minimo?: number | null;
  readonly maximo?: number | null;
}

/** A price a read may hold: finite and above zero. */
function precoConhecido(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0;
}

/** A price a caller hands in, or a `RangeError` naming the field. */
function exigirPreco(valor: number, campo: string): number {
  if (!precoConhecido(valor)) {
    throw new RangeError(`planoPreco.ts: ${campo} deve ser um preço finito maior que zero`);
  }
  return valor;
}

/** A faixa a caller hands in: three prices. */
function exigirFaixa(faixa: FaixaPrecoAmazon, campo: string): FaixaPrecoAmazon {
  exigirPreco(faixa.base, `${campo}.base`);
  exigirPreco(faixa.minimo, `${campo}.minimo`);
  exigirPreco(faixa.maximo, `${campo}.maximo`);
  return faixa;
}

/** A ms instant, or a `RangeError` naming the field. */
function exigirMs(valor: number, campo: string): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`planoPreco.ts: ${campo} deve ser um inteiro seguro não negativo`);
  }
  return valor;
}

/** The prices of a `lida` read with a usable `our_price`, else `null`. */
function precosLidos(oferta: OfertaVistaPrecoAmazon): {
  readonly base: number;
  readonly minimo: number | null;
  readonly maximo: number | null;
} | null {
  if (oferta.tipo !== TIPO_OFERTA_PRECO_AMAZON.lida || !precoConhecido(oferta.base)) return null;
  return {
    base: oferta.base,
    minimo: precoConhecido(oferta.minimo) ? oferta.minimo : null,
    maximo: precoConhecido(oferta.maximo) ? oferta.maximo : null,
  };
}

/* ---------------------------------- the fold --------------------------------- */

/** THE three comparisons: each price of `lidos` the same centavo as the faixa's. */
function mesmosTresPrecos(
  faixa: FaixaPrecoAmazon,
  lidos: { readonly base: number; readonly minimo: number | null; readonly maximo: number | null },
): boolean {
  return (
    mesmoPrecoEmReais(lidos.base, faixa.base) &&
    mesmoPrecoEmReais(lidos.minimo, faixa.minimo) &&
    mesmoPrecoEmReais(lidos.maximo, faixa.maximo)
  );
}

/** Whether Amazon's offer IS the faixa (module header, "The fold"). */
export function mesmaOfertaAmazon(
  faixa: FaixaPrecoAmazon,
  oferta: OfertaVistaPrecoAmazon,
): boolean {
  exigirFaixa(faixa, 'faixa');
  const lidos = precosLidos(oferta);
  return lidos !== null && mesmosTresPrecos(faixa, lidos);
}

/** Whether two faixas are the same, price by price (module header, "The fold"). */
export function mesmaFaixaPrecoAmazon(a: FaixaPrecoAmazon, b: FaixaPrecoAmazon): boolean {
  exigirFaixa(a, 'a');
  return mesmosTresPrecos(a, exigirFaixa(b, 'b'));
}

/**
 * The move of `our_price` from `referencia` to `novo`, in centavos (module
 * header): `desconhecida` when the reference is unknown.
 */
export function direcaoPrecoAmazon(novo: number, referencia: number | null): DirecaoPrecoAmazon {
  exigirPreco(novo, 'novo');
  if (!precoConhecido(referencia)) return DIRECAO_PRECO_AMAZON.desconhecida;
  const n = centavosDeReais(novo);
  const r = centavosDeReais(referencia);
  if (n > r) return DIRECAO_PRECO_AMAZON.sobe;
  return n < r ? DIRECAO_PRECO_AMAZON.desce : DIRECAO_PRECO_AMAZON.igual;
}

/**
 * Whether `novo` falls by MORE than `QUEDA_MAXIMA_PRECO_AMAZON` of `atual`
 * (module header), in centavos: `100 → 49.99` does, `100 → 50` does not. An
 * unknown `atual` is no fall.
 */
export function quedaExcessivaPrecoAmazon(novo: number, atual: number | null): boolean {
  exigirPreco(novo, 'novo');
  if (!precoConhecido(atual)) return false;
  return centavosDeReais(novo) < centavosDeReais(atual) * (1 - QUEDA_MAXIMA_PRECO_AMAZON);
}

/* ---------------------------- the decrease guard ---------------------------- */

/** The `our_price` Amazon is taken to hold: a price, none at all, or unknown. */
type ReferenciaPreco =
  | { readonly tipo: 'preco'; readonly base: number }
  | { readonly tipo: 'sem-oferta' }
  | { readonly tipo: 'desconhecida' };

const SEM_OFERTA: ReferenciaPreco = { tipo: 'sem-oferta' };
const DESCONHECIDA: ReferenciaPreco = { tipo: 'desconhecida' };

/** The floor of a run's send: a price, `desconhecido` (refuse every decrease), or none. */
export type PisoConsentimentoPrecoAmazon = number | 'desconhecido' | null;

/** The floor is the part's page-time price, or that part is gone. */
export const PISO_DESCONHECIDO_PRECO_AMAZON = 'desconhecido';

/** Whether `novo` sits below the floor (module header, "The decrease guard"). */
function abaixoDoPiso(novo: number, piso: PisoConsentimentoPrecoAmazon): boolean {
  if (piso === null) return false;
  if (piso === PISO_DESCONHECIDO_PRECO_AMAZON) return true;
  return centavosDeReais(novo) < centavosDeReais(piso);
}

/** The decrease guard (module header): a refusal, or `null` to send. */
function guardaDaReducao(
  referencia: ReferenciaPreco,
  novo: number,
  consentido: boolean,
  piso: PisoConsentimentoPrecoAmazon,
): RecusaReducaoPrecoAmazon | null {
  if (referencia.tipo === 'sem-oferta') {
    return abaixoDoPiso(novo, piso) ? DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina : null;
  }
  if (referencia.tipo === 'desconhecida') {
    if (!consentido) return DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel;
    return abaixoDoPiso(novo, piso) ? DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina : null;
  }
  if (direcaoPrecoAmazon(novo, referencia.base) !== DIRECAO_PRECO_AMAZON.desce) return null;
  if (!consentido) return DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento;
  return abaixoDoPiso(novo, piso) ? DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina : null;
}

/** The `our_price` a read says Amazon holds (module header, "The decrease guard"). */
function referenciaDaLeitura(oferta: OfertaVistaPrecoAmazon, buyable: boolean): ReferenciaPreco {
  const lidos = precosLidos(oferta);
  if (lidos !== null) return { tipo: 'preco', base: lidos.base };
  return oferta.tipo === TIPO_OFERTA_PRECO_AMAZON.ausente && !buyable ? SEM_OFERTA : DESCONHECIDA;
}

/** The higher `our_price` of two known ones, in centavos (the first on a tie). */
function maisAlta(
  a: Extract<ReferenciaPreco, { tipo: 'preco' }>,
  b: Extract<ReferenciaPreco, { tipo: 'preco' }>,
): Extract<ReferenciaPreco, { tipo: 'preco' }> {
  return direcaoPrecoAmazon(b.base, a.base) === DIRECAO_PRECO_AMAZON.sobe ? b : a;
}

/**
 * Whether a task's consent still holds (module header): at most
 * {@link JANELA_CONSENTIMENTO_PRECO_AMAZON_MS} after the request, and a request
 * stamped no more than {@link TOLERANCIA_RELOGIO_CONSENTIMENTO_PRECO_AMAZON_MS}
 * ahead of the task's clock.
 */
export function consentimentoValidoPrecoAmazon(solicitadoEmMs: number, agoraMs: number): boolean {
  exigirMs(solicitadoEmMs, 'solicitadoEmMs');
  exigirMs(agoraMs, 'agoraMs');
  return (
    agoraMs - solicitadoEmMs <= JANELA_CONSENTIMENTO_PRECO_AMAZON_MS &&
    solicitadoEmMs - agoraMs <= TOLERANCIA_RELOGIO_CONSENTIMENTO_PRECO_AMAZON_MS
  );
}

/* ----------------------------------- plan ----------------------------------- */

/** The options of {@link planejarPrecoAmazon}. */
export interface OpcoesPlanoPrecoAmazon {
  /** The BR listing is BUYABLE: an `ausente` offer is then read as unknown. */
  readonly buyable: boolean;
  /** The request's consent to lower `our_price`. */
  readonly baixarPreco: boolean;
  /** The consent is still inside its window ({@link consentimentoValidoPrecoAmazon}). */
  readonly consentimentoValido: boolean;
  /** The floor (module header, "The decrease guard"). */
  readonly pisoConsentimento: PisoConsentimentoPrecoAmazon;
  /** The link's latest stored price outcome, or `null`. */
  readonly envioRecente: EnvioPrecoAmazon | null;
  /** ms — the conta's last price feed end; `null` turns the feed-recent rule off. */
  readonly feedRecenteEmMs: number | null;
  /** ms — the instant of the live read. */
  readonly agoraMs: number;
}

/** The plan of one send (module header). */
export interface PlanoPrecoAmazon {
  readonly decisao: DecisaoPlanoPrecoAmazon;
  /** Why it writes; `null` when it does not. */
  readonly regra: RegraEscritaPrecoAmazon | null;
  /** `our_price`, from {@link PlanoPrecoAmazon.referencia} to the faixa. */
  readonly direcao: DirecaoPrecoAmazon;
  /**
   * The `our_price` the move was judged from (module header, "The plan of one
   * send"): the live price, or the higher of it and our recent patch's; `null`
   * when unknown or when the listing has no offer.
   */
  readonly referencia: number | null;
  /** The read as judged: `ausente` on a BUYABLE listing is `ilegivel`. */
  readonly oferta: TipoOfertaPrecoAmazon;
}

/** Our own patch's offer while it may still be landing (younger than the lag), else `null`. */
function patchRecente(envio: EnvioPrecoAmazon | null, agoraMs: number): FaixaPrecoAmazon | null {
  if (envio === null || envio.via !== VIA_ENVIO_ESTOQUE_AMAZON.patch || envio.oferta === null) {
    return null;
  }
  return agoraMs - envio.emMs < JANELA_VISIBILIDADE_PRECO_AMAZON_MS ? envio.oferta : null;
}

/** The recent-send rule (module header): our own patch of ANOTHER faixa, inside the lag. */
function envioRecenteDiverge(
  envio: EnvioPrecoAmazon | null,
  faixa: FaixaPrecoAmazon,
  agoraMs: number,
): boolean {
  const recente = patchRecente(envio, agoraMs);
  return recente !== null && !mesmosTresPrecos(faixa, recente);
}

/**
 * The `our_price` a send is judged from (module header, "The plan of one
 * send"): the live read's, raised to our recent patch's while that patch may
 * still be landing. An unknown read stays unknown; a listing with no offer
 * takes the patch's.
 */
function referenciaDaTarefa(
  leitura: ReferenciaPreco,
  envio: EnvioPrecoAmazon | null,
  agoraMs: number,
): ReferenciaPreco {
  const recente = patchRecente(envio, agoraMs);
  if (recente === null || leitura.tipo === 'desconhecida') return leitura;
  const doPatch = { tipo: 'preco', base: recente.base } as const;
  return leitura.tipo === 'sem-oferta' ? doPatch : maisAlta(leitura, doPatch);
}

/**
 * The plan of ONE send (module header): whether the faixa is written, judged
 * against Amazon's live offer.
 *
 * @throws {RangeError} a faixa price, the floor or an instant outside its domain.
 */
export function planejarPrecoAmazon(
  faixa: FaixaPrecoAmazon,
  oferta: OfertaVistaPrecoAmazon,
  opcoes: OpcoesPlanoPrecoAmazon,
): PlanoPrecoAmazon {
  exigirFaixa(faixa, 'faixa');
  exigirMs(opcoes.agoraMs, 'agoraMs');
  if (opcoes.feedRecenteEmMs !== null) exigirMs(opcoes.feedRecenteEmMs, 'feedRecenteEmMs');
  const piso = opcoes.pisoConsentimento;
  if (piso !== null && piso !== PISO_DESCONHECIDO_PRECO_AMAZON) {
    exigirPreco(piso, 'pisoConsentimento');
  }

  const leitura = referenciaDaLeitura(oferta, opcoes.buyable);
  // An offer the guard cannot read is `ilegivel` from here on (an ambiguous one stays so).
  const tipo =
    leitura.tipo === 'desconhecida' && oferta.tipo !== TIPO_OFERTA_PRECO_AMAZON.ambigua
      ? TIPO_OFERTA_PRECO_AMAZON.ilegivel
      : oferta.tipo;
  const referencia = referenciaDaTarefa(leitura, opcoes.envioRecente, opcoes.agoraMs);
  const base = referencia.tipo === 'preco' ? referencia.base : null;
  const direcao = direcaoPrecoAmazon(faixa.base, base);
  const plano = (decisao: DecisaoPlanoPrecoAmazon, regra: RegraEscritaPrecoAmazon | null) => ({
    decisao,
    regra,
    direcao,
    referencia: base,
    oferta: tipo,
  });
  const consentido = opcoes.baixarPreco && opcoes.consentimentoValido;
  /** A send the decrease guard judges: `escrever` under `regra`, or the guard's refusal. */
  const julgado = (regra: RegraEscritaPrecoAmazon) => {
    const recusa = guardaDaReducao(referencia, faixa.base, consentido, piso);
    return recusa === null
      ? plano(DECISAO_PLANO_PRECO_AMAZON.escrever, regra)
      : plano(recusa, null);
  };

  if (mesmaOfertaAmazon(faixa, oferta)) {
    if (envioRecenteDiverge(opcoes.envioRecente, faixa, opcoes.agoraMs)) {
      return julgado(REGRA_ESCRITA_PRECO_AMAZON.envioRecente);
    }
    const feed = opcoes.feedRecenteEmMs;
    if (feed !== null && opcoes.agoraMs - feed < JANELA_VISIBILIDADE_PRECO_AMAZON_MS) {
      return abaixoDoPiso(faixa.base, piso)
        ? plano(DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina, null)
        : plano(DECISAO_PLANO_PRECO_AMAZON.escrever, REGRA_ESCRITA_PRECO_AMAZON.feedRecente);
    }
    return plano(DECISAO_PLANO_PRECO_AMAZON.igual, null);
  }
  return julgado(REGRA_ESCRITA_PRECO_AMAZON.diferente);
}

/* ------------------------------- the check ---------------------------------- */

/**
 * Whether the ERP's faixa is no longer the offer a send stored (module header,
 * "The check after a send"): a check then sends nothing.
 */
export function erpMudouPrecoAmazon(
  faixaAtual: FaixaPrecoAmazon,
  ofertaGuardada: FaixaPrecoAmazon,
): boolean {
  return !mesmaFaixaPrecoAmazon(ofertaGuardada, faixaAtual);
}

/**
 * The check of ONE accepted send, minutes later (module header).
 *
 * @param faixaAtual the faixa the ERP computes NOW.
 * @param ofertaGuardada the offer the send stored (its outcome's `oferta`).
 * @param oferta Amazon's offer as read now.
 * @param issues the listing's issues as read now.
 * @param codigosAntes the price-issue codes read before the send.
 */
export function planejarVerificacaoPrecoAmazon(
  faixaAtual: FaixaPrecoAmazon,
  ofertaGuardada: FaixaPrecoAmazon,
  oferta: OfertaVistaPrecoAmazon,
  issues: unknown,
  codigosAntes: readonly string[],
): DecisaoVerificacaoPrecoAmazon {
  if (erpMudouPrecoAmazon(faixaAtual, ofertaGuardada)) {
    return DECISAO_VERIFICACAO_PRECO_AMAZON.erpMudou;
  }
  let bloqueanteAntes = false;
  let requerPessoa = false;
  for (const issue of listaDeIssuesAmazon(issues)) {
    const classe = classeDaIssuePrecoAmazon(issue);
    if (classe === null || classe === CLASSE_ISSUE_PRECO_AMAZON.aviso) continue;
    if (classe === CLASSE_ISSUE_PRECO_AMAZON.requerPessoa) requerPessoa = true;
    const codigo = codigoDaIssueAmazon(issue);
    if (codigo === null || !codigosAntes.includes(codigo)) {
      return DECISAO_VERIFICACAO_PRECO_AMAZON.recusado;
    }
    bloqueanteAntes = true;
  }
  if (mesmaOfertaAmazon(ofertaGuardada, oferta)) {
    return bloqueanteAntes
      ? DECISAO_VERIFICACAO_PRECO_AMAZON.aceitoComAvisos
      : DECISAO_VERIFICACAO_PRECO_AMAZON.aceito;
  }
  return requerPessoa
    ? DECISAO_VERIFICACAO_PRECO_AMAZON.recusado
    : DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar;
}

/* --------------------------- a feed member at send --------------------------- */

/** What a feed's build does with one member (module header). */
export type DecisaoMembroLotePrecoAmazon =
  | {
      readonly enviar: true;
      readonly direcao: DirecaoPrecoAmazon;
      /** The `our_price` the decrease was judged against; `null` when none or unknown. */
      readonly referencia: number | null;
      /** The faixa now is the very offer the page read (it is still sent). */
      readonly igualAPagina: boolean;
    }
  | {
      readonly enviar: false;
      readonly motivo: RecusaReducaoPrecoAmazon;
      readonly direcao: DirecaoPrecoAmazon;
      readonly referencia: number | null;
    };

/** Whether a stored outcome says Amazon applied its offer. */
function aceito(envio: EnvioPrecoAmazon): boolean {
  return (
    envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito ||
    envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos
  );
}

/** The reference of a member (module header, "A feed member at send time"). */
function referenciaDoMembro(
  membro: Pick<ItemDivergenciaPrecoAmazon, 'oferta' | 'lidoEmMs'>,
  envio: EnvioPrecoAmazon | null,
): ReferenciaPreco {
  // The page already read an absent offer on a BUYABLE listing as `ilegivel`.
  const daPagina = referenciaDaLeitura(membro.oferta, false);
  // A send no later than the read: our patch still inside the lag THEN may not
  // show in it, so the page judged from the higher of the two, and so does this.
  if (envio === null || envio.emMs <= membro.lidoEmMs) {
    return referenciaDaTarefa(daPagina, envio, membro.lidoEmMs);
  }
  if (envio.oferta === null) return DESCONHECIDA;
  const doEnvio = { tipo: 'preco', base: envio.oferta.base } as const;
  if (aceito(envio)) return doEnvio;
  if (daPagina.tipo === 'desconhecida') return DESCONHECIDA;
  if (daPagina.tipo === 'sem-oferta') return doEnvio;
  return maisAlta(daPagina, doEnvio);
}

/**
 * What a feed's build does with ONE member of a run's part (module header):
 * sent, or dropped by the decrease guard, the run's consent `baixarPreco` and
 * the floor at the faixa the page saw.
 *
 * @param membro the member as its part stores it.
 * @param faixaAgora the faixa the ERP computes NOW.
 * @param envioGuardado the link's price outcome as re-read now, or `null`.
 */
export function decidirMembroLotePrecoAmazon(
  membro: Pick<ItemDivergenciaPrecoAmazon, 'oferta' | 'faixa' | 'lidoEmMs'>,
  faixaAgora: FaixaPrecoAmazon,
  envioGuardado: EnvioPrecoAmazon | null,
  baixarPreco: boolean,
): DecisaoMembroLotePrecoAmazon {
  exigirFaixa(faixaAgora, 'faixaAgora');
  exigirFaixa(membro.faixa, 'membro.faixa');
  exigirMs(membro.lidoEmMs, 'membro.lidoEmMs');
  const referencia = referenciaDoMembro(membro, envioGuardado);
  const base = referencia.tipo === 'preco' ? referencia.base : null;
  const direcao = direcaoPrecoAmazon(faixaAgora.base, base);
  const recusa = guardaDaReducao(referencia, faixaAgora.base, baixarPreco, membro.faixa.base);
  if (recusa !== null) return { enviar: false, motivo: recusa, direcao, referencia: base };
  return {
    enviar: true,
    direcao,
    referencia: base,
    igualAPagina: mesmaOfertaAmazon(faixaAgora, membro.oferta),
  };
}

/* ---------------------------------- sample ---------------------------------- */

/** One decrease of `our_price`, for a sample. */
export interface ReducaoPrecoAmazon {
  readonly sku: string;
  /** The `our_price` Amazon holds. */
  readonly antes: number;
  /** The `our_price` sent. */
  readonly depois: number;
}

/** One sample entry, `sku:antes>depois`, read back; `null` when it is not one. */
function lerEntrada(entrada: string): ReducaoPrecoAmazon | null {
  if (
    entrada.length > MAX_CARACTERES_AMOSTRA_PRECO_AMAZON ||
    !AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX.test(entrada)
  ) {
    return null;
  }
  const corte = entrada.lastIndexOf(':');
  const [antes, depois, ...resto] = entrada.slice(corte + 1).split('>');
  const r = { sku: entrada.slice(0, corte), antes: Number(antes), depois: Number(depois) };
  return resto.length === 0 && precoConhecido(r.antes) && precoConhecido(r.depois) ? r : null;
}

/**
 * The run's sample (module header): the `MAX_AMOSTRA_PRECO_AMAZON` largest
 * `our_price` decreases, in centavos (a tie by the entry's text), out of `novas` and
 * the entries of `anteriores`, each `sku:antes>depois`. A move that is not a
 * decrease, or an entry the run cannot store, is left out.
 */
export function amostraReducoesPrecoAmazon(
  novas: readonly ReducaoPrecoAmazon[],
  anteriores: readonly string[] = [],
): string[] {
  const porEntrada = new Map<string, number>();
  const candidatas = [
    ...novas.map((r) => `${r.sku}:${String(r.antes)}>${String(r.depois)}`),
    ...anteriores,
  ];
  for (const entrada of candidatas) {
    const r = lerEntrada(entrada);
    if (r === null || direcaoPrecoAmazon(r.depois, r.antes) !== DIRECAO_PRECO_AMAZON.desce)
      continue;
    porEntrada.set(entrada, centavosDeReais(r.antes) - centavosDeReais(r.depois));
  }
  return [...porEntrada]
    .sort(([ea, qa], [eb, qb]) => qb - qa || (ea < eb ? -1 : ea > eb ? 1 : 0))
    .slice(0, MAX_AMOSTRA_PRECO_AMAZON)
    .map(([entrada]) => entrada);
}
