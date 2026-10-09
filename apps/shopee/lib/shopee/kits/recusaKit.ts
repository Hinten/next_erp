/**
 * The kit REFUSAL classifier (step 19, #1527): which of Shopee's measured or
 * documented native-kit refusals a `ShopeeApiError` is, what it tells the
 * operator, and whether a failed `add_kit_item` may have created a kit anyway.
 *
 * ## Why a classifier of its own, and why it reads the SENTENCE
 *
 * `product.error_busi` carries BOTH a permanent refusal ("Invalid product
 * setting", measured on `update_stock` against a kit) and a transient one (the
 * "Error 1040: Too many connections" database answer, measured on
 * `add_kit_item`), with the same code and the same `kind: 'other'`. And the
 * measured "generate kit image toggle closed" is `product.error_server`, which
 * the package's `KIND_BY_CODE` reads as `transient` — rightly for every other
 * page, so the table there stays untouched (D1 §3.1: five domain ladders read
 * that `kind`). So the code alone decides nothing, and the sentence alone is not
 * enough either: each row matches ONLY under its own canonical code, and the
 * same sentence under another code is not that refusal.
 *
 * It compares through the app's two shared folds (`core/recusaShopee.ts`), never
 * a third copy: the code after {@link codigoCanonicoShopee} and the sentence
 * after {@link fraseCanonicaShopee}. ⚠️ It reads `providerMessage`, NEVER
 * `err.message`: that one is OUR formatted sentence (`Shopee <path> respondeu
 * <code> …`), and a needle matched on it proves nothing about what Shopee said.
 *
 * ## Where it runs
 *
 * Every kit-arm WRITE consults {@link problemasDaRecusaKit} BEFORE step 11's
 * `problemasDeErroShopee`, whose `kind !== 'other'` gate would drop the
 * transient-coded toggle refusal on the floor; `null` means "not a kit refusal
 * this table knows" and the caller falls through. Step 13's kit price arm reads
 * {@link classificarRecusaKit} first for the same reason, so a measured transient
 * is never stamped as a permanent unknown refusal.
 *
 * ## ⚠️ No motivo is spelled as a quoted string in this module
 *
 * Each row reads `MOTIVO_PROBLEMA_PUBLICACAO.<key>` and {@link MotivoRecusaKit} is
 * DERIVED from the table. `anuncios/errosPublicacao.test.ts` (O7) counts any
 * quoted spelling of a vocabulary member as its producer, so a type union of
 * quoted members here would keep a member "produced" after its row was deleted.
 * The seven kit members accept only the constant spelling there; keep it so.
 *
 * Pure and total: no clock, no I/O, no environment, no `next/server` — the
 * Functions bundle may reach it through the step-13 price arm.
 */
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
} from '@delfrance/integrations-shopee';

import {
  MOTIVO_PROBLEMA_PUBLICACAO,
  type MotivoProblemaPublicacao,
  type ProblemaPublicacao,
  limitarMensagemProblema,
} from '../anuncios/errosPublicacao';
import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';

/** One row of {@link TABELA_RECUSA_KIT}. */
interface LinhaRecusaKit {
  /**
   * For the test that walks the table — never rendered anywhere. ⚠️ Never a
   * motivo's own spelling: O7 would count the label as that motivo's producer.
   */
  readonly rotulo: string;
  /** The code AFTER {@link codigoCanonicoShopee}, compared exactly. */
  readonly codigo: string;
  /**
   * The needle AFTER {@link fraseCanonicaShopee}, matched as a substring of the
   * folded `providerMessage`; `null` ⇒ the row matches by its code alone.
   */
  readonly agulha: string | null;
  readonly motivo: MotivoProblemaPublicacao;
}

/**
 * D1 §3.2's table plus one row measured by probe #2 (P2-a), in D1's order
 * except that the TRANSIENT #2 sits first (review of PR #1866).
 *
 * ⚠️ The FIRST row that matches decides ({@link classificarRecusaKit}), so the
 * order matters whenever one sentence carries two needles of the same code;
 * across codes the codes already partition the rows. Every transient row
 * therefore sits BEFORE every permanent row of its code: a sentence carrying
 * both "Invalid product setting" and "Too many connections" reads transient,
 * the safe direction for a create (`incerto`, re-read before any resend) — read
 * the other way, a write that may have happened would be reported `nao-criado`.
 * A test walks every transient × permanent pair of one code.
 *
 * The needles are written in Shopee's own casing and folded ONCE through the
 * same fold as the haystack, so a needle can never be compared in a form the
 * haystack is not. No needle contains another (a test pins it), so no needle row
 * hides another; and each code-alone row (#5, #7) is the only row of its code,
 * so none hides a needle row either. Together that makes every row reachable by
 * its own needle (or code) alone, which the per-row walk in the tests pins.
 */
export const TABELA_RECUSA_KIT = [
  {
    // #2 — PROBE (`add_kit_item`): the database's "Too many connections".
    // TRANSIENT, so FIRST: no permanent `error_busi` needle may shadow it.
    rotulo: 'banco-da-shopee',
    codigo: 'error_busi',
    agulha: fraseCanonicaShopee('Too many connections'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee,
  },
  {
    // #1 — PROBE q2 (`update_stock` on a kit; the same text in failure_list).
    rotulo: 'operacao-em-kit',
    codigo: 'error_busi',
    agulha: fraseCanonicaShopee('Invalid product setting'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.operacaoInvalidaParaKit,
  },
  {
    // #3 — PROBE q5 (`generate_kit_image`): a feature switched off, never a retry.
    rotulo: 'imagem-desligada',
    codigo: 'error_server',
    agulha: fraseCanonicaShopee('generate kit image toggle closed'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.imagemDeKitDesligada,
  },
  {
    // #4 — PROBE: a literal dot for a code (a non-kit id; an update with no id).
    rotulo: 'ponto',
    codigo: '.',
    agulha: fraseCanonicaShopee('product is not found'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente,
  },
  {
    // #5 — DOCUMENTED on the item writes; VSKU = kit. By code alone.
    rotulo: 'vsku',
    codigo: 'error_busi_cannot_edit_vsku',
    agulha: null,
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee,
  },
  {
    // #6 — DOCUMENTED (the 2242 error example).
    rotulo: 'quantidade-de-componentes',
    codigo: 'error_busi',
    agulha: fraseCanonicaShopee('The amount of component in this Kit Variation'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.faixaDeComponentes,
  },
  {
    // #7 — DOCUMENTED (the 2247 error example). By code alone.
    rotulo: 'preco',
    codigo: 'error_price_out_of_range',
    agulha: null,
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.precoForaDaFaixa,
  },
  {
    // #8 — DOCUMENTED on all five kit pages; unmeasured.
    rotulo: 'consulta-sem-resultado',
    codigo: 'error_param',
    agulha: fraseCanonicaShopee('The information you queried is not found'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente,
  },
  {
    // P2-a — PROBE #2: a second main component anywhere in the kit. Shopee's
    // spelling, byte for byte. The package guards make it unreachable; without
    // the row a guard drift would answer "o kit pode ter sido criado". Appended
    // after D1's rows; being permanent, it sits after the transient #2.
    rotulo: 'dois-principais',
    codigo: 'error_busi',
    agulha: fraseCanonicaShopee('mupltiple main sku'),
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitPrincipalDuplicado,
  },
] as const satisfies readonly LinhaRecusaKit[];

/** The kit motivos — derived from {@link TABELA_RECUSA_KIT}, never re-typed. */
export type MotivoRecusaKit = (typeof TABELA_RECUSA_KIT)[number]['motivo'];

/**
 * The motivos that may have left the write APPLIED: Shopee answered with
 * instability, not with a verdict about the request.
 */
export const MOTIVO_RECUSA_KIT_TRANSITORIO: ReadonlySet<MotivoRecusaKit> = new Set<MotivoRecusaKit>(
  [MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee],
);

/**
 * The operator's sentence per motivo — pt-BR, a MECHANISM and a remedy, never
 * Shopee's prose (the short quoted needle is the one exception, so the operator
 * can recognise the refusal in Seller Centre).
 */
const MENSAGEM_DA_RECUSA_KIT = {
  [MOTIVO_PROBLEMA_PUBLICACAO.operacaoInvalidaParaKit]:
    "a Shopee recusou esta operação em um kit ('Invalid product setting')",
  [MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee]:
    "a Shopee respondeu com instabilidade ('Too many connections'); a operação pode ter sido feita — rode exatamente o mesmo comando de novo daqui a 4 minutos",
  [MOTIVO_PROBLEMA_PUBLICACAO.imagemDeKitDesligada]:
    'a geração de imagem de kit está desligada nesta loja',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente]: 'a Shopee não encontrou este kit',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee]:
    "a Shopee não permite criar ou editar kits por API nesta loja/aplicativo ('Can not use OpenAPI to edit/create VSKU') — peça a liberação ao seu gerente Shopee",
  [MOTIVO_PROBLEMA_PUBLICACAO.faixaDeComponentes]:
    'a Shopee recusou a quantidade de componentes de uma variação do kit',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitPrincipalDuplicado]:
    "a Shopee recusou dois componentes principais no mesmo kit ('mupltiple main sku')",
  [MOTIVO_PROBLEMA_PUBLICACAO.precoForaDaFaixa]:
    'a Shopee recusou o preço de uma variação do kit: está fora da faixa de preço da categoria',
} as const satisfies Record<MotivoRecusaKit, string>;

/**
 * The REQUEST field each motivo points at, in step 11's vocabulary
 * (`problemasPublicacao.ts`): `shop` for the store-level VSKU refusal (its
 * `loja` row), `original_price` for the price band, `item_id` for a kit Shopee
 * does not know. `null` when no field of the request is at fault.
 */
const CAMPO_DA_RECUSA_KIT = {
  [MOTIVO_PROBLEMA_PUBLICACAO.operacaoInvalidaParaKit]: null,
  [MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee]: null,
  [MOTIVO_PROBLEMA_PUBLICACAO.imagemDeKitDesligada]: 'image',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente]: 'item_id',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee]: 'shop',
  [MOTIVO_PROBLEMA_PUBLICACAO.faixaDeComponentes]: 'component_list',
  [MOTIVO_PROBLEMA_PUBLICACAO.kitPrincipalDuplicado]: 'main_component',
  [MOTIVO_PROBLEMA_PUBLICACAO.precoForaDaFaixa]: 'original_price',
} as const satisfies Record<MotivoRecusaKit, string | null>;

/**
 * Which kit refusal `err` is, or `null` — "not one this table knows". The
 * first row of {@link TABELA_RECUSA_KIT} that matches wins, which is why its
 * transient rows sit first.
 *
 * ⚠️ No `kind` gate: the toggle refusal is `kind: 'transient'` and must still be
 * read. A rate limit or a dead grant is a `ShopeeApiError` too, but its codes are
 * on no row, so it answers `null` and keeps its own handling.
 */
export function classificarRecusaKit(err: ShopeeApiError): MotivoRecusaKit | null {
  const codigo = codigoCanonicoShopee(err.code);
  const frase = fraseCanonicaShopee(err.providerMessage);
  for (const linha of TABELA_RECUSA_KIT) {
    if (linha.codigo !== codigo) continue;
    if (linha.agulha === null || frase.includes(linha.agulha)) return linha.motivo;
  }
  return null;
}

/**
 * Whether a FAILED `add_kit_item` may have created a kit (the step-15
 * `ship_order` posture: re-read, never re-send in-call).
 *
 * - `nao-criado`: our own guard refused before the call (`ShopeeConfigError`), a
 *   rate limit or a dead grant (refused before the handler), or a KNOWN,
 *   non-transient kit refusal.
 * - `incerto`: everything else — a transient motivo, an unknown refusal
 *   (`null`), a network failure (a body cut mid-stream included), a non-envelope
 *   HTTP answer, a 2xx whose body did not parse, or anything not ours. The run
 *   writes nothing and tells the operator to run the same command again, whose
 *   SKU scan finds the kit if it exists.
 *
 * ⚠️ The two subclasses are tested BEFORE the base class they extend.
 */
export function desfechoDeCriacaoDeKit(err: unknown): 'nao-criado' | 'incerto' {
  if (err instanceof ShopeeConfigError) return 'nao-criado';
  if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
    return 'nao-criado';
  }
  if (err instanceof ShopeeApiError) {
    const motivo = classificarRecusaKit(err);
    if (motivo !== null && !MOTIVO_RECUSA_KIT_TRANSITORIO.has(motivo)) return 'nao-criado';
  }
  return 'incerto';
}

/**
 * The `problemas[]` of one kit-arm refusal — ONE entry carrying the motivo, its
 * field and the operator's sentence — or `null` when `err` is not a kit refusal
 * this table knows, so the caller falls through to step 11's classifier.
 */
export function problemasDaRecusaKit(err: unknown): readonly ProblemaPublicacao[] | null {
  if (!(err instanceof ShopeeApiError)) return null;
  const motivo = classificarRecusaKit(err);
  if (motivo === null) return null;
  return [
    {
      campo: CAMPO_DA_RECUSA_KIT[motivo],
      motivo,
      mensagem: limitarMensagemProblema(MENSAGEM_DA_RECUSA_KIT[motivo]),
    },
  ];
}
