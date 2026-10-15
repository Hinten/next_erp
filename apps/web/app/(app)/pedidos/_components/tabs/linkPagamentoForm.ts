import { z } from 'zod';
import { somarDiasCivis } from '@delfrance/core/datetime';
import {
  centavosDeReais,
  cotaExataReais,
  formatReais,
  ratearReais,
  roundReais,
} from '@delfrance/core/money';
import {
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK_LABELS,
  TIPO_PAGAMENTO_MP,
  nomePagadorSchema,
  tipoPagamentoMpSchema,
  valorLinkPagamentoSchema,
  type CriarLinksPagamentoBody,
  type TipoPagamentoMp,
} from '@delfrance/schemas';

/*
 * Pure form model of the pedido editor's "Link Pgto" tab (#367): the draft the
 * operator types, its validation, and the `criar` request body it becomes.
 *
 * UI-agnostic on purpose (the `incidenteForm.ts` / `devolucaoForm.ts` pattern), so
 * `linkPagamentoForm.test.ts` pins every rule without React. The CONTRACT itself —
 * limits, value and name rules, the body shape — is NOT re-stated here: each rule
 * reads the shared `@delfrance/schemas` definition the route validates with
 * (`valorLinkPagamentoSchema`, `nomePagadorSchema`, `LIMITES_LINK_PAGAMENTO`,
 * `criarLinksPagamentoBodySchema`), so the form can never accept a draft the route
 * refuses, nor refuse one it accepts.
 */

/**
 * The shared-link mode stays OFF until the live probe confirms that one Mercado
 * Pago preference accepts repeated payments (probe P2). The route refuses
 * `modo: 'compartilhado'` behind its own env flag too; this constant only hides
 * the option. A follow-up PR flips it after the probe. (Annotated `boolean` so
 * flipping the value changes no types.)
 */
export const LINK_COMPARTILHADO_HABILITADO: boolean = false;

/**
 * The three ways the operator can ask for links. Only the form knows `umLink` /
 * `vaquinha` apart — both become `modo: 'individual'` on the wire.
 *  - `umLink`        — ONE link, an optional first name, optional payer prefill.
 *  - `vaquinha`      — N per-person links, each with a first name and a value.
 *  - `compartilhado` — ONE link paid N times, each payment the same amount.
 */
export const modoFormLinkSchema = z.enum(['umLink', 'vaquinha', 'compartilhado']);
export type ModoFormLink = z.infer<typeof modoFormLinkSchema>;

/** Named members of {@link modoFormLinkSchema}. */
export const MODO_FORM_LINK = {
  umLink: 'umLink',
  vaquinha: 'vaquinha',
  compartilhado: 'compartilhado',
} as const satisfies Record<string, ModoFormLink>;

/** Every excludable Mercado Pago payment type, in the order the form lists them. */
export const TIPOS_PAGAMENTO_LINK: ReadonlyArray<TipoPagamentoMp> = tipoPagamentoMpSchema.options;

/** One row of a vaquinha. `chave` is the React key — UI only, never sent. */
export interface PessoaLinkForm {
  chave: string;
  nome: string;
  valor: number | null;
}

/** The whole draft. Money in reais (2 decimals), dates as civil `YYYY-MM-DD`. */
export interface LinkFormState {
  modo: ModoFormLink;
  /** `metodo_pgto` doc id of the Mercado Pago account. */
  metodoId: string | null;
  /** `umLink`: the amount. */
  valor: number | null;
  /** `umLink`: optional first name of the payer. */
  nomePagador: string;
  /** `umLink`: prefill the pedido's cliente in the checkout. */
  preencherPagador: boolean;
  /** `vaquinha`: one row per payer. */
  pessoas: PessoaLinkForm[];
  /** `compartilhado`: the total the N payments add up to. */
  valorTotalCompartilhado: number | null;
  /** `compartilhado`: how many payments the link accepts. */
  quantidade: number | null;
  /** Last day the links can be paid; the server makes it 23:59:59 in São Paulo. */
  expiraEm: string;
  /** Payment types turned OFF (the wire's `tiposExcluidos`). */
  tiposExcluidos: TipoPagamentoMp[];
  /** Max installments on a credit card; `null` = Mercado Pago's default. */
  parcelasMaximas: number | null;
}

/** A blank vaquinha row. */
export function novaPessoa(chave: string): PessoaLinkForm {
  return { chave, nome: '', valor: null };
}

/**
 * The draft a fresh tab starts from: one link, every payment type on, Mercado
 * Pago's default installments, and a deadline {@link LIMITES_LINK_PAGAMENTO}
 * `.expiracaoDiasPadrao` civil days after `hoje`. `metodoIdUnico` pre-selects the
 * account when exactly one qualifies; `temCliente` turns the payer prefill on by
 * default (it is meaningless for a pedido with no cliente). A vaquinha starts
 * with two rows — one row is just "Um link".
 */
export function valoresIniciaisLinkForm(
  hoje: string,
  metodoIdUnico: string | null,
  temCliente = false,
): LinkFormState {
  return {
    modo: MODO_FORM_LINK.umLink,
    metodoId: metodoIdUnico,
    valor: null,
    nomePagador: '',
    preencherPagador: temCliente,
    pessoas: [novaPessoa('pessoa-inicial-1'), novaPessoa('pessoa-inicial-2')],
    valorTotalCompartilhado: null,
    quantidade: null,
    expiraEm: somarDiasCivis(hoje, LIMITES_LINK_PAGAMENTO.expiracaoDiasPadrao) ?? hoje,
    tiposExcluidos: [],
    parcelasMaximas: null,
  };
}

/** How many links the draft asks for — and so how many ids the caller must mint. */
export function quantidadeDeLinks(state: LinkFormState): number {
  return state.modo === MODO_FORM_LINK.vaquinha ? state.pessoas.length : 1;
}

/* -------------------------------------------------------------------------- */
/*                                   Money                                     */
/* -------------------------------------------------------------------------- */

/**
 * Split `alvoCentavos` into `n` values (reais) that add up to it EXACTLY — the
 * "Dividir igualmente" button. Largest remainder via `ratearReais`, so the odd
 * cents go to the FIRST rows (`10000, 3` → `33.34, 33.33, 33.33`); never
 * `total / n` rounded per row, which leaves the last cent unpayable and the
 * pedido stuck short of `pago`.
 *
 * `[]` for `n < 1` or a target that is not a whole, non-negative number of
 * cents. `n` above 50 is a caller bug (`ratearReais` throws); the form caps a
 * vaquinha at {@link LIMITES_LINK_PAGAMENTO}`.linksPorLoteMax`.
 */
export function dividirIgualmente(alvoCentavos: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) return [];
  if (!Number.isSafeInteger(alvoCentavos) || alvoCentavos < 0) return [];
  return ratearReais(alvoCentavos / 100, n);
}

/**
 * The payment counts `n` (2..{@link LIMITES_LINK_PAGAMENTO}`.quantidadeMaximaMax`)
 * for which `alvoCentavos` splits into `n` EQUAL payments of at least the minimum
 * a link may charge — the only counts a shared link may use (`cotaExataReais`:
 * rounding the share up would overpay the pedido, and an overpayment blocks the
 * NF-e, cStat 866).
 */
export function divisoesExatas(alvoCentavos: number): number[] {
  if (!Number.isSafeInteger(alvoCentavos) || alvoCentavos <= 0) return [];
  const total = alvoCentavos / 100;
  const contagens: number[] = [];
  for (let n = 2; n <= LIMITES_LINK_PAGAMENTO.quantidadeMaximaMax; n += 1) {
    const cota = cotaExataReais(total, n);
    if (cota !== null && valorLinkPagamentoSchema.safeParse(cota).success) contagens.push(n);
  }
  return contagens;
}

/** Whether `valor` is a number `ratearReais` / `cotaExataReais` can take. */
function valorDivisivel(valor: number | null): valor is number {
  return valor !== null && Number.isFinite(valor) && valor >= 0;
}

/** Whether `n` is a shared-link payment count the route accepts. */
function quantidadeValida(n: number | null): n is number {
  return (
    n !== null && Number.isInteger(n) && n >= 2 && n <= LIMITES_LINK_PAGAMENTO.quantidadeMaximaMax
  );
}

/**
 * Each payment of a shared link, or `null` when the total does not split exactly
 * into `quantidade` payments (or either input is not usable yet).
 */
export function cotaDoCompartilhado(state: LinkFormState): number | null {
  const total = state.valorTotalCompartilhado;
  if (!valorDivisivel(total) || roundReais(total) !== total) return null;
  if (!quantidadeValida(state.quantidade)) return null;
  return cotaExataReais(total, state.quantidade);
}

/**
 * The values the draft would charge, in integer CENTS, summed — `null` while
 * any of them is still blank or not a number. Always compared in cents: a sum
 * of reais floats is not exact (`0.1 + 0.2 !== 0.3`).
 */
export function somaDoFormularioCentavos(state: LinkFormState): number | null {
  const valores = valoresDoFormulario(state);
  if (valores.some((v) => v === null || !Number.isFinite(v))) return null;
  return valores.reduce<number>((soma, v) => soma + centavosDeReais(v ?? 0), 0);
}

/** The amounts the draft asks for, one per link (a shared link counts its whole total). */
function valoresDoFormulario(state: LinkFormState): Array<number | null> {
  switch (state.modo) {
    case MODO_FORM_LINK.umLink:
      return [state.valor];
    case MODO_FORM_LINK.vaquinha:
      return state.pessoas.map((p) => p.valor);
    case MODO_FORM_LINK.compartilhado:
      return [state.valorTotalCompartilhado];
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Validation                                  */
/* -------------------------------------------------------------------------- */

/** What {@link validarLinkForm} needs besides the draft. */
export interface ContextoValidacaoLink {
  /**
   * What new links may still charge, in CENTS — `disponivelParaNovosLinksCentavos`
   * from `@delfrance/schemas`, the SAME figure the route's exposure guard refuses
   * above: the pedido's `restante` minus the money sitting in open links minus the
   * pending payments on links that are no longer open.
   */
  restanteSemLinkCentavos: number;
  /**
   * Links the pedido already holds — EVERY stored one, cancelled, expired and
   * legacy included, exactly as the route counts them against
   * {@link LIMITES_LINK_PAGAMENTO}`.linksPorPedidoMax`.
   */
  linksExistentes: number;
  /** Today's civil date in São Paulo (`YYYY-MM-DD`). */
  hoje: string;
  /** {@link LINK_COMPARTILHADO_HABILITADO} — a parameter so both arms are testable. */
  compartilhadoHabilitado: boolean;
}

/** Errors of one vaquinha row. */
export interface ErrosPessoaLink {
  nome?: string;
  valor?: string;
}

/**
 * Per-field errors, pt-BR, ready to render. A key is present ONLY when its field
 * is wrong, so {@link linkFormValido} is "no keys".
 */
export interface ErrosLinkForm {
  modo?: string;
  metodoId?: string;
  valor?: string;
  nomePagador?: string;
  /** List-level vaquinha error (no rows, too many rows). */
  pessoas?: string;
  /** Row-level vaquinha errors, keyed by the row's index. */
  pessoa?: Record<number, ErrosPessoaLink>;
  valorTotalCompartilhado?: string;
  quantidade?: string;
  /** The batch charges more than new links may. */
  soma?: string;
  /** The batch would take the pedido past `linksPorPedidoMax` links. */
  limiteLinks?: string;
  tiposExcluidos?: string;
  parcelasMaximas?: string;
  expiraEm?: string;
}

export function linkFormValido(erros: ErrosLinkForm): boolean {
  return Object.keys(erros).length === 0;
}

/**
 * `erros` without the sum error — for an EXACT replay of a request that got no
 * answer (same fingerprint, same ids). That request may already have created the
 * links, and then the sum check fails against its own open links while the route
 * would simply answer `reaproveitado`; if it did not, the route re-checks the
 * exposure inside its transaction and refuses. Every other error still applies.
 */
export function errosSemSoma(erros: ErrosLinkForm): ErrosLinkForm {
  const resto: ErrosLinkForm = { ...erros };
  delete resto.soma;
  return resto;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA` (display only; no zone involved). */
export function formatarDataCivil(civil: string): string {
  const [ano = '', mes = '', dia = ''] = civil.split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Short alias for the messages below (template literals cannot be wrapped). */
const LIMITES = LIMITES_LINK_PAGAMENTO;

/** The least one link may charge, as the operator reads it (`R$ 1,00`). */
const VALOR_MINIMO = formatReais(LIMITES.valorMinimo);

/** The error of one link's amount, judged by the route's own schema, or `null`. */
function erroDeValor(valor: number | null): string | null {
  if (valor === null) return 'Informe o valor.';
  if (valorLinkPagamentoSchema.safeParse(valor).success) return null;
  if (Number.isFinite(valor) && valor >= LIMITES.valorMinimo) {
    return 'Use no máximo 2 casas decimais.';
  }
  return `O valor mínimo de um link é ${VALOR_MINIMO}.`;
}

const ERRO_NOME = `Só o primeiro nome: letras, até ${LIMITES.nomePagadorMax} caracteres.`;

/** The error of an OPTIONAL payer label (`umLink`), or `null`. */
function erroDeNomeOpcional(nome: string): string | null {
  if (nome.trim() === '') return null;
  return nomePagadorSchema.safeParse(nome).success ? null : ERRO_NOME;
}

/** The error of a REQUIRED payer label (a vaquinha row), or `null`. */
function erroDeNomeObrigatorio(nome: string): string | null {
  if (nome.trim() === '') return 'Informe o primeiro nome.';
  return nomePagadorSchema.safeParse(nome).success ? null : ERRO_NOME;
}

/** The expiry error, or `null`. Civil `YYYY-MM-DD` strings compare lexicographically. */
function erroDeExpiracao(expiraEm: string, hoje: string): string | null {
  const limite = somarDiasCivis(hoje, LIMITES_LINK_PAGAMENTO.expiracaoDiasMax);
  const valida = somarDiasCivis(expiraEm, 0) !== null;
  if (valida && expiraEm >= hoje && (limite === null || expiraEm <= limite)) return null;
  return limite === null
    ? 'Escolha uma data a partir de hoje.'
    : `Escolha uma data entre hoje e ${formatarDataCivil(limite)}.`;
}

/**
 * Validate the draft against `ctx`. Every rule a route would answer 400 / 409
 * for is checked here first, with the SAME schema or limit, so the operator
 * sees a field error instead of a toast:
 *
 *  - an account is required;
 *  - every value passes `valorLinkPagamentoSchema` (≥ R$ 1,00, ≤ 2 decimals);
 *  - a vaquinha has 1..`linksPorLoteMax` rows, each with a valid first name
 *    (`nomePagadorSchema`) and no name repeated (case-insensitive — the "quem já
 *    pagou" message could not tell two "Maria"s apart); the `umLink` name is
 *    optional but must be valid when given;
 *  - the whole batch, in CENTS, fits in `restanteSemLinkCentavos` — a HARD error:
 *    any overshoot overpays the pedido, which blocks its NF-e (cStat 866);
 *  - the stored links plus the batch stay within `linksPorPedidoMax` (the route's
 *    `limiteLinks`: `linksExistentes + quantidadeDeLinks ≤ max`, equality allowed);
 *  - at least one payment type stays on; installments are 1..`parcelasMax` or
 *    empty; the expiry lies between today and today + `expiracaoDiasMax`;
 *  - a shared link needs `compartilhadoHabilitado`, a count of
 *    2..`quantidadeMaximaMax`, and a total that splits EXACTLY into that many
 *    payments of at least the minimum (`cotaExataReais`).
 */
export function validarLinkForm(state: LinkFormState, ctx: ContextoValidacaoLink): ErrosLinkForm {
  const erros: ErrosLinkForm = {};

  if (state.metodoId === null || state.metodoId.trim() === '') {
    erros.metodoId = 'Escolha a conta do Mercado Pago.';
  }

  switch (state.modo) {
    case MODO_FORM_LINK.umLink: {
      const valor = erroDeValor(state.valor);
      if (valor !== null) erros.valor = valor;
      const nome = erroDeNomeOpcional(state.nomePagador);
      if (nome !== null) erros.nomePagador = nome;
      break;
    }
    case MODO_FORM_LINK.vaquinha: {
      if (state.pessoas.length === 0) {
        erros.pessoas = 'Adicione pelo menos uma pessoa.';
      } else if (state.pessoas.length > LIMITES.linksPorLoteMax) {
        erros.pessoas = `No máximo ${LIMITES.linksPorLoteMax} pessoas por vez.`;
      }
      const porPessoa: Record<number, ErrosPessoaLink> = {};
      const nomesVistos = new Set<string>();
      state.pessoas.forEach((pessoa, indice) => {
        const erro: ErrosPessoaLink = {};
        const nome = erroDeNomeObrigatorio(pessoa.nome);
        if (nome !== null) {
          erro.nome = nome;
        } else {
          const chave = pessoa.nome.trim().toLocaleLowerCase('pt-BR');
          if (nomesVistos.has(chave)) erro.nome = 'Nome repetido — diferencie (ex.: Maria S.).';
          nomesVistos.add(chave);
        }
        const valor = erroDeValor(pessoa.valor);
        if (valor !== null) erro.valor = valor;
        if (erro.nome !== undefined || erro.valor !== undefined) porPessoa[indice] = erro;
      });
      if (Object.keys(porPessoa).length > 0) erros.pessoa = porPessoa;
      break;
    }
    case MODO_FORM_LINK.compartilhado: {
      if (!ctx.compartilhadoHabilitado) {
        erros.modo = MOTIVO_RECUSA_LINK_LABELS.compartilhadoDesabilitado;
      }
      const total = state.valorTotalCompartilhado;
      if (!valorDivisivel(total)) {
        erros.valorTotalCompartilhado = 'Informe o valor total.';
      } else if (roundReais(total) !== total) {
        // `cotaExataReais` would split the ROUNDED total, so N × cota would no
        // longer be the amount the operator typed.
        erros.valorTotalCompartilhado = 'Use no máximo 2 casas decimais.';
      }
      if (!quantidadeValida(state.quantidade)) {
        erros.quantidade = `Informe de 2 a ${LIMITES.quantidadeMaximaMax} pagamentos.`;
      } else if (valorDivisivel(total) && roundReais(total) === total) {
        const partes = state.quantidade;
        const cota = cotaExataReais(total, partes);
        if (cota === null) {
          erros.quantidade = `${formatReais(total)} não se divide em ${partes} pagamentos iguais.`;
        } else if (!valorLinkPagamentoSchema.safeParse(cota).success) {
          erros.quantidade = `Cada pagamento precisa ser de pelo menos ${VALOR_MINIMO}.`;
        }
      }
      break;
    }
  }

  const soma = somaDoFormularioCentavos(state);
  if (soma !== null && soma > ctx.restanteSemLinkCentavos) {
    erros.soma =
      `Os links somam mais do que o restante disponível (${formatReais(soma / 100)} de ` +
      `${formatReais(Math.max(0, ctx.restanteSemLinkCentavos) / 100)}).`;
  }

  const totalDeLinks = ctx.linksExistentes + quantidadeDeLinks(state);
  if (totalDeLinks > LIMITES.linksPorPedidoMax) {
    erros.limiteLinks =
      `O pedido ficaria com ${totalDeLinks} links — o limite é ${LIMITES.linksPorPedidoMax} ` +
      'por pedido (links cancelados e expirados também contam).';
  }

  if (new Set(state.tiposExcluidos).size >= TIPOS_PAGAMENTO_LINK.length) {
    erros.tiposExcluidos = 'Deixe pelo menos uma forma de pagamento.';
  }

  const parcelas = state.parcelasMaximas;
  if (
    parcelas !== null &&
    (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > LIMITES.parcelasMax)
  ) {
    erros.parcelasMaximas = `Entre 1 e ${LIMITES.parcelasMax} parcelas, ou vazio.`;
  }

  const expiracao = erroDeExpiracao(state.expiraEm, ctx.hoje);
  if (expiracao !== null) erros.expiraEm = expiracao;

  return erros;
}

/* -------------------------------------------------------------------------- */
/*                                Request body                                 */
/* -------------------------------------------------------------------------- */

/** What {@link montarCorpoCriar} needs besides the draft. */
export interface ContextoCorpoCriar {
  pedidoId: string;
  /** The pedido total the operator SAW; the route answers 409 when it moved. */
  valorCobradoEsperado: number;
  /** One client-minted id per link ({@link quantidadeDeLinks}), in row order. */
  linkIds: ReadonlyArray<string>;
}

/** A value {@link validarLinkForm} already vouched for; a `null` here is a caller bug. */
function exigirValor(valor: number | null, campo: string): number {
  if (valor === null) throw new Error(`montarCorpoCriar: "${campo}" vazio — valide antes.`);
  return valor;
}

/**
 * The `criar` body for a VALIDATED draft ({@link validarLinkForm} returned no
 * errors — calling this on an invalid one throws on the first missing piece).
 *
 *  - `umLink`        → `modo: 'individual'`, one link; the name trimmed or `null`;
 *    the payer prefill only here (the route refuses it anywhere else).
 *  - `vaquinha`      → `modo: 'individual'`, one link per row, names trimmed.
 *  - `compartilhado` → `modo: 'compartilhado'`, ONE link whose `valor` is each
 *    payment's exact share, and `quantidadeMaxima: N`.
 *
 * `tiposExcluidos` is sent in canonical order; installments are dropped (`null`)
 * when credit card is excluded — they only apply to it.
 */
export function montarCorpoCriar(
  state: LinkFormState,
  ctx: ContextoCorpoCriar,
): CriarLinksPagamentoBody {
  const esperados = quantidadeDeLinks(state);
  if (ctx.linkIds.length !== esperados) {
    throw new Error(
      `montarCorpoCriar: ${ctx.linkIds.length} id(s) para ${esperados} link(s) — valide antes.`,
    );
  }
  if (state.metodoId === null) throw new Error('montarCorpoCriar: conta vazia — valide antes.');

  const tiposExcluidos = TIPOS_PAGAMENTO_LINK.filter((t) => state.tiposExcluidos.includes(t));
  const comum = {
    pedidoId: ctx.pedidoId,
    metodoId: state.metodoId,
    valorCobradoEsperado: ctx.valorCobradoEsperado,
    expiraEm: state.expiraEm,
    tiposExcluidos,
    parcelasMaximas: tiposExcluidos.includes(TIPO_PAGAMENTO_MP.cartaoCredito)
      ? null
      : state.parcelasMaximas,
  };

  switch (state.modo) {
    case MODO_FORM_LINK.umLink: {
      const nome = state.nomePagador.trim();
      return {
        ...comum,
        modo: MODO_LINK_PAGAMENTO.individual,
        quantidadeMaxima: null,
        preencherPagador: state.preencherPagador,
        links: [
          {
            linkId: ctx.linkIds[0] ?? '',
            nomePagador: nome === '' ? null : nome,
            valor: exigirValor(state.valor, 'valor'),
          },
        ],
      };
    }
    case MODO_FORM_LINK.vaquinha:
      return {
        ...comum,
        modo: MODO_LINK_PAGAMENTO.individual,
        quantidadeMaxima: null,
        preencherPagador: false,
        links: state.pessoas.map((pessoa, indice) => ({
          linkId: ctx.linkIds[indice] ?? '',
          nomePagador: pessoa.nome.trim(),
          valor: exigirValor(pessoa.valor, `pessoa ${indice + 1}`),
        })),
      };
    case MODO_FORM_LINK.compartilhado: {
      const cota = cotaDoCompartilhado(state);
      if (cota === null) throw new Error('montarCorpoCriar: total não divisível — valide antes.');
      return {
        ...comum,
        modo: MODO_LINK_PAGAMENTO.compartilhado,
        quantidadeMaxima: state.quantidade,
        preencherPagador: false,
        links: [{ linkId: ctx.linkIds[0] ?? '', nomePagador: null, valor: cota }],
      };
    }
  }
}

/**
 * A fingerprint of everything in the draft that reaches the request body — the
 * key under which the tab keeps its client-minted link ids. The ids are reused
 * ONLY for a retry of the very same request after a network failure (no answer,
 * so the server may or may not have created the links: the same ids let it
 * recognise the replay); any edit changes the fingerprint and mints new ones.
 *
 * Row keys are left out (UI only) and names are trimmed, exactly as the body is
 * built, so two drafts with the same fingerprint produce the same body.
 */
export function impressaoDigital(state: LinkFormState): string {
  const comum = {
    modo: state.modo,
    metodoId: state.metodoId,
    expiraEm: state.expiraEm,
    tiposExcluidos: TIPOS_PAGAMENTO_LINK.filter((t) => state.tiposExcluidos.includes(t)),
    parcelasMaximas: state.parcelasMaximas,
  };
  switch (state.modo) {
    case MODO_FORM_LINK.umLink:
      return JSON.stringify({
        ...comum,
        valor: state.valor,
        nomePagador: state.nomePagador.trim(),
        preencherPagador: state.preencherPagador,
      });
    case MODO_FORM_LINK.vaquinha:
      return JSON.stringify({
        ...comum,
        pessoas: state.pessoas.map((p) => [p.nome.trim(), p.valor]),
      });
    case MODO_FORM_LINK.compartilhado:
      return JSON.stringify({
        ...comum,
        valorTotalCompartilhado: state.valorTotalCompartilhado,
        quantidade: state.quantidade,
      });
  }
}
