/**
 * The pure half of `scripts/publicar-anuncio.ts` (#1519, step 11) — argument
 * parsing, the **allow-list** summary of a publish PLAN, its renderers, the
 * `--live` result summary and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning, same shape as
 * `produtos/importarAnuncioCli.ts`, `pedidos/importarPedidoCli.ts` and the
 * three other CLI halves. The script keeps the I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads `process.env`, opens a client, touches Firestore or reads a clock:
 * every instant and every count it renders arrives inside the plan it was
 * handed. Its only value imports are four pure modules of this app (the item
 * mapper's attribute helper, the two publish error classes, the shared CLI
 * error describer and the three routes' own doc-id predicate); everything from
 * the IO modules is `import type`, which is erased.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * No builder below copies an input object. Every field of
 * {@link ResumoPublicacaoShopee} — and every step of {@link ResumoPassoShopee},
 * through an EXHAUSTIVE switch that stops compiling the day `PassoPublicacao`
 * gains a member — is named and constructed one at a time, so a field that is
 * not listed cannot appear in the output. That includes a field a future schema
 * change adds to the produto, to the built `add_item` body or to a Shopee
 * refusal. A denylist has the opposite property: it protects the fields
 * somebody remembered.
 *
 * ⚠️ {@link ResultadoPublicacao} makes the point sharper than step 9's did: it
 * carries the WHOLE `plano`, so `JSON.stringify(resultado)` would print the
 * listing description, every `image_id` and every attribute value. The live
 * rendering is built by NAME into {@link ResumoResultadoPublicacao} for exactly
 * that reason, and a test pins it.
 *
 * Five fields deserve their own sentence, and each is a decision:
 *
 *  - **`description` is NEVER printed** — only
 *    {@link ResumoPublicacaoShopee.descricaoChars}, the character count of the
 *    text this publish WOULD send. It is operator-authored prose that can carry
 *    a phone number, an address or a shop's private terms, and a terminal
 *    transcript gets pasted into issues exactly like a log stream does.
 *  - **`tax_info` VALUES ARE printed**, keys and values both — the one
 *    deliberate divergence from `produtos/importarAnuncioCli.ts:387-388`, whose
 *    docblock says "never a value" and means it. The two rules sit one folder
 *    apart on purpose: step 9 prints a block that arrived from SOMEONE ELSE'S
 *    shop, while the block here is the one OUR fiscal configuration is about to
 *    send, an NCM/CFOP/CSOSN is a public catalogue code rather than a seller's
 *    datum, and "Shopee refused the fiscal block" is unanswerable without
 *    seeing which value went out. Whether step 9's rule should move is a
 *    follow-up on THAT file, not a change made from this one.
 *  - **Pictures are printed as COUNTS**, never as ids and never as URLs. The
 *    `arquivos` url never reaches the plan at all (`fotosPublicacao.ts` reads it
 *    inside its own resolver and logs the HOST alone), and a per-picture FAILURE
 *    is printed as `arquivoId` + its closed `motivo` vocabulary and never as the
 *    failure's `mensagem`, which is prose another module composed.
 *  - **`item_name` IS printed.** It is the listing title this publish creates,
 *    it is the produto's own name, and showing it is the one thing this
 *    rehearsal exists for.
 *  - **No `original_value_name` is printed, custom or not.** The allow-list only
 *    forbids the non-custom ones (a custom value's name is the operator's own
 *    text); printing neither is the narrower promise and costs nothing, because
 *    the per-attribute VALUE COUNT already answers "did it arrive".
 *
 * ## ⚠️ What a dry run can and cannot know
 *
 * Everything here is read off the PLAN, which is pure data. Two consequences a
 * reader must keep in mind, both of them `planoPublicacao.ts`'s own:
 *
 *  1. The plan's model leg is PROVISIONAL on the update path — it was
 *     reconciled against `viva: null`, because `get_model_list` is not read
 *     while preparing. So a dry run over an existing listing prints the leg the
 *     publisher would DECIDE from a fresh reading, not the leg it will
 *     necessarily run.
 *  2. A dry run has already PAID for its pictures. `resolverFotosDaPublicacao`
 *     uploads, because `montarAnuncio` needs real `image_id`s to build a body at
 *     all. That cost is paid once — every id lands in `arquivos.externalIds`.
 *
 * Ver apps/shopee/scripts/README.md.
 */
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  type ShopeeCategoria,
  type ShopeeItemStatusWritable,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';

import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import type { VerdictoFolha } from '../taxonomia/categorias';
import type { AtributosProjetados } from '../taxonomia/dto';
import { naoDocId } from './corpoPublicacao';
import {
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  type ProblemaPublicacao,
} from './errosPublicacao';
import type { MotivoFotoPublicacao } from './fotosPublicacao';
import type { MotivoCanalPulado } from './logisticaPublicacao';
import { atributosParaPublicar } from './montagemAnuncio';
import type { OrdemDeRelistagem, PassoPublicacao, PlanoPublicacao } from './planoPublicacao';
import type { ResultadoPublicacao } from './publicarAnuncio';
import type { MotivoTaxInfoOmitido } from './taxInfoPublicacao';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv` itself,
 * so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_PUBLICAR_ANUNCIO = `
Publica UM produto do ERP como anúncio na Shopee, pelo caminho real do step 11.

  pnpm --filter @delfrance/shopee-app publicar:anuncio \\
    --integracao <integracaoId> --produto <produtoId> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --produto <id>      o produto PAI do ERP (nunca uma variação)

Opções
  --link <docId>      o vínculo prodshopee a usar, quando o produto tem mais de um
  --categoria <id>    category_id folha, só dígitos. Só é usado quando o vínculo
                      NÃO tem categoria; nunca sobrescreve a armazenada.
  --status UNLIST     publica pausado. O padrão é NORMAL (à venda).
  --dry-run           lê, resolve as fotos e PLANEJA, sem escrever. É o PADRÃO.
  --live              PUBLICA DE VERDADE na Shopee e grava os vínculos.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

O dry-run continua CHAMANDO a Shopee (get_item_limit, a árvore de categorias,
get_channel_list e o upload das fotos) e lendo o Firestore — ele não ESCREVE no
Firestore nem cria anúncio, e isso é estrutural: prepararPublicacao e
planejarPublicacao não têm escritor nenhum no corpo. As fotos, essas SOBEM: o
corpo do add_item precisa de image_id de verdade, e cada id fica no cache
arquivos.externalIds, então o custo é pago UMA vez.
Um plano BLOQUEADO (sem peso, sem foto, atributo obrigatório vazio) é uma
RESPOSTA no DRY-RUN: ele é impresso na seção "problemas" e o comando sai com 0.
Em --live a mesma recusa não é capturada — ela sai com 1, como qualquer outro
erro.
⚠️ Produto que é FILHO ou KIT é recusado ANTES de existir plano, dentro do
prepararPublicacao: essa recusa LANÇA nos dois modos e sai com 1.
Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsPublicarAnuncio {
  readonly integracaoId: string;
  /** The PARENT produto's doc id. A variação is refused by the publisher itself. */
  readonly produtoId: string;
  /** `null` ⇒ let the resolver pick this conta's single link. */
  readonly linkDocId: string | null;
  /** `null` ⇒ send no `categoryId`; the stored one decides. */
  readonly categoryId: number | null;
  readonly status: ShopeeItemStatusWritable;
  /** `false` — the DRY-RUN default. `--live` is the only way to publish. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoPublicarAnuncio =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'publicar'; readonly args: ArgsPublicarAnuncio };

/** `--categoria` took something that is not a bare run of digits. */
export const MSG_CATEGORIA_NAO_NUMERICA =
  '--categoria exige o category_id só em dígitos (ex.: 100017): sem espaços, sinal, ponto ou vírgula.';

/**
 * `--status` took a value outside the two Shopee WRITES.
 *
 * ⚠️ Composed from `SHOPEE_ITEM_STATUS_WRITABLE`, never from two literals: an
 * item can BE `BANNED` or `SELLER_DELETE` and no write may ever say so, and the
 * day the wire gains a third writable status this sentence and the parser widen
 * together.
 */
export const MSG_STATUS_INVALIDO = `--status aceita apenas ${Object.values(
  SHOPEE_ITEM_STATUS_WRITABLE,
).join(' e ')}.`;

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A doc id: trimmed, then checked with {@link naoDocId} — `./corpoPublicacao`'s
 * export, the SAME predicate the three step-11 routes read their bodies with.
 * It takes `unknown`, so an argv value, always a string, is assignable as-is.
 *
 * ⚠️ ONE spelling, and the reason is measured rather than stylistic. This file
 * used to carry a local copy of the rule, and it had already drifted at birth:
 * it refused `''` and the separator but NOT the two relative names, so
 * `--produto ..` passed argument validation and reached `produtos/../prodshopee`.
 * `.doc('..')` does not throw locally — it resolves — so the operator got a
 * server-side `INVALID_ARGUMENT` instead of the sentence below, which is the one
 * thing this check exists to produce.
 */
function docIdDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const valor = valorDe(nome, inline, proximo);
  if (naoDocId(valor)) {
    throw new ArgumentoInvalidoError(
      `--${nome} ${valor} não é um id de documento: "/", "." e ".." endereçam outro caminho.`,
    );
  }
  return valor;
}

/**
 * The raw token, deliberately NOT trimmed.
 *
 * ⚠️ `--categoria " 100017"` is refused rather than cleaned up, the same rule
 * `importarAnuncioCli.ts` applies to `--item`: the value becomes the leaf
 * category the listing is created under, and a reader that silently repairs its
 * input cannot tell a typo from an id.
 */
function valorBrutoDe(
  nome: string,
  inline: string | undefined,
  proximo: string | undefined,
): string {
  const bruto = inline ?? proximo;
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

const SO_DIGITOS = /^[0-9]+$/;

function categoryIdDe(bruto: string): number {
  if (!SO_DIGITOS.test(bruto)) throw new ArgumentoInvalidoError(MSG_CATEGORIA_NAO_NUMERICA);
  const valor = Number(bruto);
  // `0` passes the digit test and is not a category; and a run of digits can
  // exceed what a JS number represents exactly, which would publish under a
  // DIFFERENT category without a word.
  if (!Number.isSafeInteger(valor) || valor <= 0) {
    throw new ArgumentoInvalidoError(
      `--categoria ${bruto} não é um category_id utilizável (inteiro positivo dentro do seguro).`,
    );
  }
  return valor;
}

/**
 * The requested `item_status`.
 *
 * ⚠️ No case fold and no alias: `'unlist'` is NOT `'UNLIST'` on this wire, and
 * lowercasing it here would send a value Shopee refuses while the operator was
 * told the command was fine. The accepted set is read off
 * `SHOPEE_ITEM_STATUS_WRITABLE` so no literal lives here at all.
 */
function statusDe(bruto: string): ShopeeItemStatusWritable {
  const aceito = Object.values(SHOPEE_ITEM_STATUS_WRITABLE).find((v) => v === bruto);
  if (aceito === undefined) throw new ArgumentoInvalidoError(MSG_STATUS_INVALIDO);
  return aceito;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags. The script's side
 * of that bargain is to return before its first dynamic import.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the readers
 * of the command line would expect the other — and here the wrong half creates a
 * real listing on a real marketplace.
 */
export function lerArgsPublicar(argv: readonly string[]): ComandoPublicarAnuncio {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let produtoId: string | undefined;
  let linkDocId: string | undefined;
  let categoriaBruta: string | undefined;
  let statusBruto: string | undefined;
  let projectId: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--integracao':
        integracaoId = docIdDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--produto':
        produtoId = docIdDe('produto', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--link':
        linkDocId = docIdDe('link', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--categoria':
        categoriaBruta = valorBrutoDe('categoria', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--status':
        statusBruto = valorBrutoDe('status', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = true;
        break;
      case '--dry-run':
        dryRunExplicito = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }
  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (produtoId == null) throw new ArgumentoInvalidoError('--produto <produtoId> é obrigatório.');

  return {
    kind: 'publicar',
    args: {
      integracaoId,
      produtoId,
      linkDocId: linkDocId ?? null,
      categoryId: categoriaBruta === undefined ? null : categoryIdDe(categoriaBruta),
      status:
        statusBruto === undefined ? SHOPEE_ITEM_STATUS_WRITABLE.normal : statusDe(statusBruto),
      live,
      json,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          the rendering context                              */
/* -------------------------------------------------------------------------- */

/**
 * What the renderer needs and the PLAN does not state.
 *
 * ⚠️ A NARROW structural type, not `ContextoPublicacao` itself: everything but
 * {@link ContextoDoEnsaio.categoria} is a field of the prepared graph, so the
 * script hands in `{ ...contexto, categoria }` and this half stays free of the
 * IO types — the photo resolver above all, which a fixture would otherwise have
 * to fake to render a line of text.
 *
 * `categoria` is the only genuinely new input: the resolved category CHAIN
 * cannot be derived from the plan, because the taxonomy index lives on
 * `deps.categorias` and the composition root is the only thing holding it.
 */
export interface ContextoDoEnsaio {
  /** The conta's BARE doc id. */
  readonly integracaoId: string;
  /** `get_channel_list`, for each sent row's `fee_type`. */
  readonly canais: readonly ShopeeLogisticsChannel[];
  readonly atributos: AtributosProjetados;
  /** The stored link, for the attribute rows the item mapper read. */
  readonly link: { readonly attributes: readonly unknown[] | null } | null;
  readonly veredictoFolha: VerdictoFolha;
  /**
   * The ROOT-FIRST, inclusive chain of the RESOLVED category, exactly as
   * `produtos/categoriaShopee.ts`'s `caminhoDaCategoriaDoAnuncio` answers it.
   * `[]` for an id the tree does not carry — never a throw.
   */
  readonly categoria: readonly ShopeeCategoria[];
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/** One `logistic_info` row as it will be SENT. */
export interface ResumoLogisticaShopee {
  readonly logisticId: number;
  /** From `get_channel_list`; `null` when the channel is not in the live list. */
  readonly feeType: string | null;
  readonly enabled: boolean;
  readonly isFree: boolean | null;
}

/** One channel WE did not send, and why. */
export interface ResumoCanalPuladoShopee {
  readonly logisticId: number;
  readonly motivo: MotivoCanalPulado;
}

/** One `attribute_list` row: the id, how many values ride it, whether it is required. */
export interface ResumoAtributoShopee {
  readonly attributeId: number;
  /** ⚠️ A COUNT. No `original_value_name` is printed, custom or not. */
  readonly valores: number;
  readonly mandatory: boolean;
}

export interface ResumoOpcaoShopee {
  readonly optionId: number;
  readonly nome: string;
  readonly temFoto: boolean;
  /** A live model sits here and no child of this publish claims it. */
  readonly ocupadaPorModeloSemFilho: boolean;
}

export interface ResumoTierShopee {
  readonly grupoId: string;
  readonly variationId: number;
  readonly variationGroupId: number | null;
  readonly nome: string | null;
  readonly opcoes: readonly ResumoOpcaoShopee[];
}

/** One model of the plan's leg. `modelId: null` reads `novo` on the line. */
export interface ResumoModeloShopee {
  readonly tierIndex: readonly number[];
  readonly modelSku: string | null;
  readonly originalPrice: number | null;
  /** The sum of the `seller_stock` rows; `null` for a row that carries none. */
  readonly sellerStock: number | null;
  readonly modelId: number | null;
}

/**
 * The fiscal block, keys AND values.
 *
 * ⚠️ The values ARE printed. See the module header: the divergence from step
 * 9's keys-only rule is deliberate and argued there.
 */
export interface ResumoTaxInfoShopee {
  readonly enviado: boolean;
  readonly omitido: MotivoTaxInfoOmitido | null;
  readonly campos: readonly { readonly chave: string; readonly valor: string }[];
}

/** One picture this publish could not resolve. ⚠️ The `mensagem` is NOT carried. */
export interface ResumoFalhaDeFotoShopee {
  readonly arquivoId: string;
  readonly motivo: MotivoFotoPublicacao;
}

/**
 * One planned step.
 *
 * ⚠️ Rebuilt field by field from {@link PassoPublicacao} through an EXHAUSTIVE
 * switch — never spread. `PassoPublicacao` is `planoPublicacao.ts`'s type, and
 * the day a step gains a prose field, copying the union would print it. The
 * switch fails TYPECHECK instead (`switch-exhaustiveness-check` is an error
 * here), which is the only form of this promise a reader can trust.
 */
export interface ResumoPassoShopee {
  readonly tipo: PassoPublicacao['tipo'];
  readonly enviadas: number | null;
  readonly reutilizadas: number | null;
  readonly tiers: number | null;
  readonly modelos: number | null;
  readonly ms: number | null;
  readonly statusInicial: ShopeeItemStatusWritable | null;
  readonly ordem: readonly OrdemDeRelistagem[] | null;
}

/** ONE publish plan, reduced to what a rehearsal needs and nothing authored. */
export interface ResumoPublicacaoShopee {
  readonly produtoId: string;
  readonly linkDocId: string | null;
  /** `null` = a first publish; the line reads `novo`. */
  readonly itemId: number | null;
  readonly sequencia: 'create' | 'update';
  /** What the OPERATOR asked for. */
  readonly statusPedido: ShopeeItemStatusWritable;
  /** What `add_item` SENDS — `UNLIST` for a create with children. */
  readonly statusInicial: ShopeeItemStatusWritable;
  readonly categoryId: number;
  /** The chain's NAMES, root-first — public taxonomy, never seller data. */
  readonly categoriaCaminho: readonly string[];
  readonly veredictoFolha: VerdictoFolha;
  readonly itemName: string;
  readonly itemNameChars: number;
  /** REDACTED: the character count of the description that would be sent. */
  readonly descricaoChars: number;
  readonly condition: string | null;
  readonly weight: number;
  readonly dimension: {
    readonly alturaCm: number;
    readonly larguraCm: number;
    readonly comprimentoCm: number;
  } | null;
  readonly brand: { readonly brandId: number; readonly originalBrandName: string } | null;
  readonly itemSku: string | null;
  readonly gtinCode: string | null;
  readonly preOrder: { readonly isPreOrder: boolean; readonly daysToShip: number | null } | null;
  /** A COUNT, never the ids and never a URL. */
  readonly imagens: number;
  readonly atributos: readonly ResumoAtributoShopee[];
  /** The NAMES of the mandatory attributes with no value — the refusal's own list. */
  readonly atributosFaltando: readonly string[];
  readonly taxInfo: ResumoTaxInfoShopee;
  readonly logistica: readonly ResumoLogisticaShopee[];
  readonly canaisPulados: readonly ResumoCanalPuladoShopee[];
  readonly tiers: readonly ResumoTierShopee[];
  readonly modelos: {
    readonly acao: 'init' | 'update' | 'nenhuma';
    readonly mudouProfundidade: boolean;
    readonly novos: readonly ResumoModeloShopee[];
    readonly relistados: readonly ResumoModeloShopee[];
    readonly atualizarSku: number;
    readonly semFilho: readonly ResumoModeloShopee[];
    readonly desaparecidos: number;
  };
  readonly fotos: {
    readonly consideradas: number;
    readonly reutilizadas: number;
    readonly enviadas: number;
    readonly descartadasPeloLimite: number;
    readonly falhas: readonly ResumoFalhaDeFotoShopee[];
  };
  readonly relistagem: readonly OrdemDeRelistagem[] | null;
  readonly passos: readonly ResumoPassoShopee[];
  /**
   * Every refusal, in the order checked. NON-EMPTY = nothing would be sent, and
   * the dry run still exits 0 — a problema is an ANSWER.
   *
   * ⚠️ Carried whole, and it is the ONE thing here that is: `mensagem` is a
   * MECHANISM sentence by `errosPublicacao.ts`'s own contract (no payload, no
   * listing title, no fiscal value), capped at 500 characters by both
   * constructors, and it is the only place the prose lives.
   */
  readonly problemas: readonly ProblemaPublicacao[];
}

/* ------------------------------ small readers ------------------------------ */

function txt(v: string | null): string {
  return v ?? '—';
}

function num(v: number | null): string {
  return v == null ? '—' : String(v);
}

function lista(v: readonly string[]): string {
  return v.length === 0 ? '(nenhum)' : v.join(', ');
}

function sim(v: boolean): string {
  return v ? 'sim' : 'não';
}

/**
 * A category node's display name, falling back to the untranslated one and then
 * to the id.
 *
 * ⚠️ Display only, and that is why it is not shared with
 * `produtos/planoImportacao.ts`'s own pick: that one builds a categoria
 * DOCUMENT's `nome`, a stored value other readers key on. This one feeds a
 * terminal line and nothing else.
 */
function nomeDaCategoria(no: ShopeeCategoria): string {
  const nome = (no.display_category_name ?? no.original_category_name ?? '').trim();
  return nome.length === 0 ? `#${String(no.category_id)}` : nome;
}

function somaDeEstoque(rows: readonly { readonly stock: number }[]): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) total += row.stock;
  return total;
}

/**
 * One planned step, rebuilt by NAME.
 *
 * ⚠️ EXHAUSTIVE on purpose — see {@link ResumoPassoShopee}.
 */
function resumoDoPasso(passo: PassoPublicacao): ResumoPassoShopee {
  const vazio = {
    enviadas: null,
    reutilizadas: null,
    tiers: null,
    modelos: null,
    ms: null,
    statusInicial: null,
    ordem: null,
  } as const;
  switch (passo.tipo) {
    case 'fotos':
      return {
        ...vazio,
        tipo: passo.tipo,
        enviadas: passo.enviadas,
        reutilizadas: passo.reutilizadas,
      };
    case 'add_item':
      return { ...vazio, tipo: passo.tipo, statusInicial: passo.statusInicial };
    case 'update_item':
      return { ...vazio, tipo: passo.tipo };
    case 'esperar':
      return { ...vazio, tipo: passo.tipo, ms: passo.ms };
    case 'init_tier_variation':
      return { ...vazio, tipo: passo.tipo, tiers: passo.tiers, modelos: passo.modelos };
    case 'update_tier_variation':
      return { ...vazio, tipo: passo.tipo, modelos: passo.modelos };
    case 'add_model':
      return { ...vazio, tipo: passo.tipo, modelos: passo.modelos };
    case 'update_model':
      return { ...vazio, tipo: passo.tipo, modelos: passo.modelos };
    case 'get_model_list':
      return { ...vazio, tipo: passo.tipo };
    case 'relistagem':
      return { ...vazio, tipo: passo.tipo, ordem: passo.ordem };
    case 'leitura-de-volta':
      return { ...vazio, tipo: passo.tipo };
  }
}

/**
 * The fiscal block, keys AND values — or the motivo it was omitted for.
 *
 * ⚠️ The key list and the motivo are rendered whichever way this went, so
 * "omitted, and why" and "sent, and what" read as the same section with one
 * difference. `Object.entries` over the BUILT body, so a key
 * `taxInfoPublicacao.ts` stops sending disappears from here by itself.
 */
function resumoDoTaxInfo(plano: PlanoPublicacao): ResumoTaxInfoShopee {
  const bloco = plano.item.criar.tax_info;
  const campos: { readonly chave: string; readonly valor: string }[] = [];
  if (bloco !== undefined) {
    for (const [chave, valor] of Object.entries(bloco).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (typeof valor === 'string') campos.push({ chave, valor });
    }
  }
  return { enviado: bloco !== undefined, omitido: plano.taxInfoOmitido, campos };
}

/**
 * The whole plan, reduced to the allow-list in the module header.
 *
 * `contexto` is read for exactly four things — the resolved category chain, each
 * sent channel's `fee_type`, each attribute's `mandatory` flag and the missing
 * mandatory NAMES — and for nothing else: the plan is the authority on every
 * decision, and reading the graph twice is how a rehearsal starts disagreeing
 * with the publisher it rehearses.
 *
 * ⚠️ The missing-attribute NAMES come from `montagemAnuncio`'s own exported
 * `atributosParaPublicar`, called with the same two arguments the item mapper
 * called it with. Re-deriving the rule here would be a second copy of it, and
 * the copies drift toward plausible.
 */
export function resumoDaPublicacao(
  plano: PlanoPublicacao,
  contexto: ContextoDoEnsaio,
): ResumoPublicacaoShopee {
  const criar = plano.item.criar;
  const feePorCanal = new Map(
    contexto.canais.map((c) => [c.logistics_channel_id, c.fee_type] as const),
  );
  const mandatoryPorId = new Map(
    contexto.atributos.atributos.map((a) => [a.attributeId, a.mandatory] as const),
  );
  const atributos = atributosParaPublicar(contexto.link?.attributes ?? null, contexto.atributos);
  const modelo = (m: {
    readonly tier_index: readonly number[];
    readonly original_price: number;
    readonly seller_stock: readonly { readonly stock: number }[];
    readonly model_sku?: string;
  }): ResumoModeloShopee => ({
    tierIndex: m.tier_index,
    modelSku: m.model_sku ?? null,
    originalPrice: m.original_price,
    sellerStock: somaDeEstoque(m.seller_stock),
    modelId: null,
  });

  return {
    produtoId: plano.produtoId,
    linkDocId: plano.linkDocId,
    itemId: plano.itemId,
    sequencia: plano.ehAtualizacao ? 'update' : 'create',
    statusPedido: plano.statusPedido,
    statusInicial: plano.statusInicial,
    categoryId: criar.category_id,
    categoriaCaminho: contexto.categoria.map(nomeDaCategoria),
    veredictoFolha: contexto.veredictoFolha,
    itemName: criar.item_name,
    itemNameChars: criar.item_name.length,
    // ⚠️ The LENGTH and nothing else. The text is right there in `criar.description`.
    descricaoChars: criar.description.length,
    condition: criar.condition ?? null,
    weight: criar.weight,
    dimension:
      criar.dimension === undefined
        ? null
        : {
            alturaCm: criar.dimension.package_height,
            larguraCm: criar.dimension.package_width,
            comprimentoCm: criar.dimension.package_length,
          },
    brand:
      criar.brand === undefined
        ? null
        : { brandId: criar.brand.brand_id, originalBrandName: criar.brand.original_brand_name },
    itemSku: criar.item_sku ?? null,
    gtinCode: criar.gtin_code ?? null,
    preOrder:
      criar.pre_order === undefined
        ? null
        : {
            isPreOrder: criar.pre_order.is_pre_order,
            daysToShip: criar.pre_order.days_to_ship ?? null,
          },
    // A COUNT, never the ids: Shopee renders `image_id_list` positionally and
    // the position is all a rehearsal can act on.
    imagens: criar.image.image_id_list.length,
    atributos: (criar.attribute_list ?? []).map((a) => ({
      attributeId: a.attribute_id,
      valores: a.attribute_value_list?.length ?? 0,
      mandatory: mandatoryPorId.get(a.attribute_id) ?? false,
    })),
    atributosFaltando: atributos.faltando,
    taxInfo: resumoDoTaxInfo(plano),
    logistica: plano.logistica.logistic_info.map((row) => ({
      logisticId: row.logistic_id,
      feeType: feePorCanal.get(row.logistic_id) ?? null,
      enabled: row.enabled,
      isFree: row.is_free ?? null,
    })),
    canaisPulados: plano.logistica.pulados.map((p) => ({
      logisticId: p.logisticId,
      motivo: p.motivo,
    })),
    tiers: plano.tiers.map((t) => ({
      grupoId: t.grupoId,
      variationId: t.variation_id,
      variationGroupId: t.variation_group_id,
      nome: t.variation_name,
      opcoes: t.opcoes.map((o) => ({
        optionId: o.variation_option_id,
        nome: o.variation_option_name,
        temFoto: o.image_id !== null,
        ocupadaPorModeloSemFilho: o.ocupadaPorModeloSemFilho,
      })),
    })),
    modelos: {
      acao: plano.modelos.acao,
      mudouProfundidade: plano.modelos.mudouProfundidade,
      novos: plano.modelos.novos.map(modelo),
      relistados: plano.modelos.modelList.map((m) => ({
        tierIndex: m.tier_index,
        modelSku: null,
        originalPrice: null,
        sellerStock: null,
        modelId: m.model_id,
      })),
      atualizarSku: plano.modelos.atualizarSku.length,
      semFilho: plano.modelos.modelosSemFilho.map((m) => ({
        tierIndex: m.tier_index,
        modelSku: m.model_sku,
        originalPrice: null,
        sellerStock: null,
        modelId: m.model_id,
      })),
      desaparecidos: plano.modelos.desaparecidos.length,
    },
    fotos: {
      consideradas: plano.fotos.resumo.consideradas,
      reutilizadas: plano.fotos.resumo.reutilizadas,
      enviadas: plano.fotos.resumo.enviadas,
      descartadasPeloLimite: plano.fotos.resumo.descartadasPeloLimite,
      // ⚠️ `arquivoId` + the closed `motivo` vocabulary. NEVER `mensagem`: it is
      // prose `fotosPublicacao.ts` composed, and a url-shaped string inside it
      // would reach this transcript.
      falhas: plano.falhasDeFoto.map((f) => ({ arquivoId: f.arquivoId, motivo: f.motivo })),
    },
    relistagem: plano.relistagem,
    passos: plano.passos.map(resumoDoPasso),
    problemas: plano.problemas,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function renderPassos(passos: readonly ResumoPassoShopee[]): string[] {
  return passos.map((p, i) => {
    const partes: string[] = [];
    if (p.statusInicial !== null) partes.push(`item_status=${p.statusInicial}`);
    if (p.enviadas !== null) partes.push(`enviadas=${String(p.enviadas)}`);
    if (p.reutilizadas !== null) partes.push(`reutilizadas=${String(p.reutilizadas)}`);
    if (p.tiers !== null) partes.push(`tiers=${String(p.tiers)}`);
    if (p.modelos !== null) partes.push(`modelos=${String(p.modelos)}`);
    if (p.ms !== null) partes.push(`ms=${String(p.ms)}`);
    if (p.ordem !== null) partes.push(`ordem=${p.ordem.join(' → ')}`);
    return `  ${String(i + 1).padStart(2)}. ${p.tipo.padEnd(22)} ${partes.join('  ')}`.trimEnd();
  });
}

/** The human rendering of one publish plan — design-P2 §10.3's printout. */
export function renderResumoPublicacao(r: ResumoPublicacaoShopee): string[] {
  const linhas: string[] = [];
  linhas.push(`## O que uma publicação faria (produto ${r.produtoId}, sequência ${r.sequencia})`);
  linhas.push(
    `  item_id ................. ${r.itemId === null ? 'novo' : String(r.itemId)}   vínculo=${txt(r.linkDocId)}`,
  );
  linhas.push(
    `  status .................. pedido=${r.statusPedido}  add_item envia=${r.statusInicial}`,
  );
  linhas.push(
    `  categoria ............... ${String(r.categoryId)} (${r.veredictoFolha})  ${
      r.categoriaCaminho.length === 0 ? '(fora da árvore)' : r.categoriaCaminho.join(' > ')
    }`,
  );
  linhas.push(`  item_name ............... "${r.itemName}" (${String(r.itemNameChars)} ch)`);
  linhas.push(`  descrição ............... «REDIGIDA — ${String(r.descricaoChars)} caractere(s)»`);
  linhas.push(`  condition ............... ${txt(r.condition)}`);
  linhas.push(`  weight .................. ${String(r.weight)} kg`);
  linhas.push(
    `  dimension ............... ${
      r.dimension === null
        ? '—'
        : `${String(r.dimension.alturaCm)}×${String(r.dimension.larguraCm)}×${String(r.dimension.comprimentoCm)} cm (A×L×C)`
    }`,
  );
  linhas.push(
    `  brand ................... ${
      r.brand === null ? '— (omitido)' : `${String(r.brand.brandId)} "${r.brand.originalBrandName}"`
    }`,
  );
  linhas.push(`  item_sku / gtin_code .... ${txt(r.itemSku)} / ${txt(r.gtinCode)}`);
  linhas.push(
    `  pre_order ............... ${
      r.preOrder === null
        ? '—'
        : `${sim(r.preOrder.isPreOrder)}  days_to_ship=${num(r.preOrder.daysToShip)}`
    }`,
  );
  linhas.push(
    `  imagens ................. ${String(r.imagens)} image_id no corpo (as URLs e os ids são omitidos de propósito)`,
  );

  linhas.push('');
  linhas.push(`### attribute_list (${String(r.atributos.length)})`);
  if (r.atributos.length === 0) {
    linhas.push('  (nenhum)');
  } else {
    for (const a of r.atributos) {
      linhas.push(
        `  attribute_id ${String(a.attributeId).padEnd(12)} valores=${String(a.valores).padEnd(4)} obrigatório=${sim(a.mandatory)}`,
      );
    }
  }
  linhas.push(`  obrigatórios SEM valor .. ${lista(r.atributosFaltando)}`);
  linhas.push('  (os nomes dos VALORES são omitidos de propósito — só a contagem)');

  linhas.push('');
  linhas.push('### tax_info');
  linhas.push(
    `  bloco ................... ${r.taxInfo.enviado ? 'ENVIADO inteiro' : `omitido (${txt(r.taxInfo.omitido)})`}`,
  );
  linhas.push(`  chaves .................. ${lista(r.taxInfo.campos.map((c) => c.chave))}`);
  if (r.taxInfo.campos.length > 0) {
    for (const c of r.taxInfo.campos) {
      linhas.push(`  ${c.chave.padEnd(22)} ${c.valor}`);
    }
    // ⚠️ Values ON PURPOSE, unlike `importar:anuncio`. See the module header.
    linhas.push('  (os VALORES fiscais são impressos de propósito — são códigos de catálogo)');
  }

  linhas.push('');
  linhas.push(`### logistic_info (${String(r.logistica.length)} a enviar)`);
  if (r.logistica.length === 0) {
    linhas.push('  (nenhum — a publicação está bloqueada por logistica-sem-canal)');
  } else {
    for (const l of r.logistica) {
      linhas.push(
        `  canal ${String(l.logisticId).padEnd(10)} fee_type=${txt(l.feeType).padEnd(20)} enabled=${sim(l.enabled)}  is_free=${l.isFree == null ? '—' : sim(l.isFree)}`,
      );
    }
  }
  if (r.canaisPulados.length > 0) {
    linhas.push(`  pulados (${String(r.canaisPulados.length)}):`);
    for (const p of r.canaisPulados) {
      linhas.push(`    canal ${String(p.logisticId).padEnd(10)} ${p.motivo}`);
    }
  }

  linhas.push('');
  linhas.push(`### tiers (${String(r.tiers.length)})`);
  if (r.tiers.length === 0) {
    linhas.push('  (nenhum — item sem variações)');
  } else {
    for (const t of r.tiers) {
      linhas.push(
        `  grupo ${t.grupoId.padEnd(16)} variation_id=${String(t.variationId).padEnd(8)} group=${num(t.variationGroupId)}  nome=${txt(t.nome)}`,
      );
      for (const o of t.opcoes) {
        linhas.push(
          `    option ${String(o.optionId).padEnd(10)} "${o.nome}"  foto=${sim(o.temFoto)}${
            o.ocupadaPorModeloSemFilho ? '  (ocupada por modelo sem filho)' : ''
          }`,
        );
      }
    }
  }

  linhas.push('');
  linhas.push(
    `### modelos (acao=${r.modelos.acao}, profundidade mudou=${sim(r.modelos.mudouProfundidade)})`,
  );
  if (r.modelos.novos.length === 0) {
    linhas.push('  novos ................... (nenhum)');
  } else {
    linhas.push('  tier_index     model_sku            preço      estoque   model_id');
    for (const m of r.modelos.novos) {
      linhas.push(
        `  ${`[${m.tierIndex.join(',')}]`.padEnd(14)} ${txt(m.modelSku).padEnd(20)} ${num(m.originalPrice).padEnd(10)} ${num(m.sellerStock).padEnd(9)} ${m.modelId === null ? 'novo' : String(m.modelId)}`,
      );
    }
  }
  linhas.push(
    `  re-listados ............. ${String(r.modelos.relistados.length)} (update_tier_variation substitui a lista INTEIRA)`,
  );
  linhas.push(`  model_sku a atualizar ... ${String(r.modelos.atualizarSku)}`);
  linhas.push(
    `  modelos sem filho ....... ${
      r.modelos.semFilho.length === 0
        ? '(nenhum)'
        : r.modelos.semFilho.map((m) => `${num(m.modelId)}[${m.tierIndex.join(',')}]`).join(', ')
    }`,
  );
  linhas.push(`  vínculos desaparecidos .. ${String(r.modelos.desaparecidos)}`);

  linhas.push('');
  linhas.push('### fotos e sequência');
  linhas.push(
    `  fotos ................... ${String(r.fotos.consideradas)} consideradas · ${String(r.fotos.reutilizadas)} reaproveitadas · ${String(r.fotos.enviadas)} enviadas · ${String(r.fotos.descartadasPeloLimite)} fora do limite`,
  );
  if (r.fotos.falhas.length > 0) {
    for (const f of r.fotos.falhas) {
      linhas.push(`    falha: arquivo ${f.arquivoId} — ${f.motivo}`);
    }
    linhas.push('  (a URL e a mensagem de cada falha são omitidas de propósito)');
  }
  linhas.push(
    `  relistagem .............. ${r.relistagem === null ? 'não planejada' : r.relistagem.join(' → ')}`,
  );

  linhas.push('');
  linhas.push(`### passos que o --live executaria (${String(r.passos.length)})`);
  for (const linha of renderPassos(r.passos)) linhas.push(linha);

  linhas.push('');
  if (r.problemas.length === 0) {
    linhas.push('### problemas: NENHUM — este produto é publicável');
  } else {
    linhas.push(`### problemas (${String(r.problemas.length)}) — NADA seria enviado`);
    for (const p of r.problemas) {
      linhas.push(`  ${txt(p.campo).padEnd(18)} ${p.motivo.padEnd(28)} ${p.mensagem}`);
    }
  }

  return linhas;
}

/** `renderizarPlano` — the plan, straight to the lines a terminal shows. */
export function renderizarPlano(plano: PlanoPublicacao, contexto: ContextoDoEnsaio): string[] {
  return renderResumoPublicacao(resumoDaPublicacao(plano, contexto));
}

/* ----------------------------- the live result ----------------------------- */

/**
 * What `--live` reported.
 *
 * ⚠️ Built by NAME, and here that is load-bearing rather than tidy:
 * {@link ResultadoPublicacao} carries the whole `plano`, so serialising it would
 * print the listing description, every `image_id` and every attribute value. A
 * test pins it.
 */
export interface ResumoResultadoPublicacao {
  readonly produtoId: string;
  readonly itemId: number;
  readonly linkDocId: string;
  readonly sequencia: 'create' | 'update';
  readonly estadoAnuncio: string | null;
  readonly itemStatus: string | null;
  readonly deboost: boolean;
  readonly leituraDeVolta: boolean;
  readonly relistagem: OrdemDeRelistagem | null;
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  readonly avisoResolvido: boolean;
  readonly chamadasShopee: number;
  readonly modelos: {
    readonly acao: 'init' | 'update' | 'nenhuma';
    readonly total: number;
    readonly criados: number;
    readonly repontados: number;
    readonly atualizados: number;
    readonly marcados: number;
    readonly ignorados: number;
    readonly semFilho: readonly { readonly modelId: number; readonly modelSku: string | null }[];
    readonly desaparecidos: number;
    readonly avisos: number;
  };
  readonly fotos: {
    readonly consideradas: number;
    readonly reutilizadas: number;
    readonly enviadas: number;
    readonly descartadasPeloLimite: number;
    readonly falhas: readonly ResumoFalhaDeFotoShopee[];
  };
  /**
   * The FIRST non-noise envelope `warning`, verbatim.
   *
   * ⚠️ The one piece of provider prose this rendering carries, and it is here
   * because it has nowhere else to go: the publisher deliberately keeps it OUT
   * of its log line (a log carries ids, counts, enum tokens and booleans), so
   * the operator's only channel for it is this field.
   */
  readonly avisoShopee: string | null;
}

/** `--json --live`: the SAME allow-list, as an object. One builder, no second copy. */
export function resumoDoResultado(res: ResultadoPublicacao): ResumoResultadoPublicacao {
  return {
    produtoId: res.produtoId,
    itemId: res.itemId,
    linkDocId: res.linkDocId,
    sequencia: res.ehAtualizacao ? 'update' : 'create',
    estadoAnuncio: res.estadoAnuncio,
    itemStatus: res.itemStatus,
    deboost: res.deboost,
    leituraDeVolta: res.leituraDeVolta,
    relistagem: res.relistagem,
    taxInfoOmitido: res.taxInfoOmitido,
    avisoResolvido: res.avisoResolvido,
    chamadasShopee: res.chamadasShopee,
    modelos: {
      acao: res.modelos.acao,
      total: res.modelos.total,
      criados: res.modelos.criados,
      repontados: res.modelos.repontados,
      atualizados: res.modelos.atualizados,
      marcados: res.modelos.marcados,
      ignorados: res.modelos.ignorados,
      semFilho: res.modelos.semFilho.map((m) => ({ modelId: m.model_id, modelSku: m.model_sku })),
      desaparecidos: res.modelos.desaparecidos.length,
      // A COUNT: the operator already has the FIRST warning verbatim below, and
      // a list of provider sentences in a transcript is exactly what this app
      // keeps out of its logs.
      avisos: res.modelos.avisos.length,
    },
    fotos: {
      consideradas: res.fotos.consideradas,
      reutilizadas: res.fotos.reutilizadas,
      enviadas: res.fotos.enviadas,
      descartadasPeloLimite: res.fotos.descartadasPeloLimite,
      falhas: res.falhasDeFoto.map((f) => ({ arquivoId: f.arquivoId, motivo: f.motivo })),
    },
    avisoShopee: res.avisoShopee,
  };
}

export function renderResumoResultado(r: ResumoResultadoPublicacao): string[] {
  const linhas: string[] = ['## O que a publicação gravou na Shopee e no ERP'];
  linhas.push(`  produtoId ............... ${r.produtoId}`);
  linhas.push(
    `  item_id ................. ${String(r.itemId)}   vínculo=${r.linkDocId}   sequência=${r.sequencia}`,
  );
  linhas.push(
    `  leitura de volta ........ ${
      r.leituraDeVolta
        ? `estadoAnuncio=${txt(r.estadoAnuncio)}  item_status=${txt(r.itemStatus)}  deboost=${sim(r.deboost)}`
        : 'DEGRADOU — a segunda escrita de vínculo NÃO aconteceu'
    }`,
  );
  linhas.push(
    `  relistagem .............. ${r.relistagem === null ? 'não planejada' : `porta ${r.relistagem}`}`,
  );
  linhas.push(
    `  tax_info ................ ${r.taxInfoOmitido === null ? 'enviado' : `omitido (${r.taxInfoOmitido})`}`,
  );
  linhas.push(
    `  aviso de violação ....... ${r.avisoResolvido ? 'RESOLVIDO por esta publicação' : 'sem transição'}`,
  );
  linhas.push(`  chamadas à Shopee ....... ${String(r.chamadasShopee)}`);

  linhas.push('');
  linhas.push(`### modelos (acao=${r.modelos.acao})`);
  linhas.push(
    `  total / criados ......... ${String(r.modelos.total)} / ${String(r.modelos.criados)}`,
  );
  linhas.push(
    `  re-apontados / sku ...... ${String(r.modelos.repontados)} / ${String(r.modelos.atualizados)}`,
  );
  linhas.push(
    `  marcados / ignorados .... ${String(r.modelos.marcados)} / ${String(r.modelos.ignorados)}`,
  );
  linhas.push(
    `  sem filho ............... ${
      r.modelos.semFilho.length === 0
        ? '(nenhum)'
        : r.modelos.semFilho.map((m) => `${String(m.modelId)} ${txt(m.modelSku)}`).join(', ')
    }`,
  );
  linhas.push(`  vínculos desaparecidos .. ${String(r.modelos.desaparecidos)}`);

  linhas.push('');
  linhas.push('### fotos');
  linhas.push(
    `  ${String(r.fotos.consideradas)} consideradas · ${String(r.fotos.reutilizadas)} reaproveitadas · ${String(r.fotos.enviadas)} enviadas · ${String(r.fotos.descartadasPeloLimite)} fora do limite`,
  );
  for (const f of r.fotos.falhas) {
    linhas.push(`  falha: arquivo ${f.arquivoId} — ${f.motivo}`);
  }

  if (r.avisoShopee !== null || r.modelos.avisos > 0) {
    linhas.push('');
    linhas.push(
      `### avisos da Shopee (${String(r.modelos.avisos)} no leg de modelos): ${txt(r.avisoShopee)}`,
    );
  }
  return linhas;
}

/** `--live`: what the publisher reported, straight to the terminal lines. */
export function renderizarResultado(res: ResultadoPublicacao): string[] {
  return renderResumoResultado(resumoDoResultado(res));
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/** The line a pre-write refusal gets: it precedes EVERY write, on both surfaces. */
const LINHA_NADA_ENVIADO =
  '  Nada foi enviado à Shopee e nenhum vínculo foi gravado: a recusa é anterior ' +
  'à primeira escrita.';

/**
 * A produto the publisher REFUSES — an answer, never a failure.
 *
 * ⚠️ **This describer is only ever reached through the ERROR path, so it exits
 * 1 — in BOTH modes.** The refusals it renders are the ones
 * `prepararPublicacao` THROWS before a plan exists (`produto-e-filho`,
 * `produto-e-kit`) and, under `--live`, the applier's own pre-write throw. The
 * exit-0 answer is a different object: a blocked PLAN, whose refusals ride
 * {@link ResumoPublicacaoShopee.problemas} and are printed by
 * {@link renderResumoPublicacao}. Same vocabulary, two surfaces, two exit codes
 * — and the difference is whether a plan was reached, not how bad the refusal
 * is.
 *
 * ⚠️ Every `mensagem` is a MECHANISM sentence by `errosPublicacao.ts`'s own
 * contract (no payload, no listing title, no fiscal value) and is capped at 500
 * characters by both constructors, which is what makes it printable here.
 */
export function descreverBloqueioPublicacao(err: ShopeePublishBlockedError): string[] {
  const linhas = [
    `bloqueado: ${err.motivo}`,
    `  produto ................. ${err.produtoId}`,
    `  item_id ................. ${err.itemId === null ? 'novo (primeira publicação)' : String(err.itemId)}`,
    `  problemas (${String(err.problemas.length)}):`,
  ];
  for (const p of err.problemas) {
    linhas.push(`    ${txt(p.campo).padEnd(18)} ${p.motivo.padEnd(28)} ${p.mensagem}`);
  }
  linhas.push(LINHA_NADA_ENVIADO);
  return linhas;
}

/**
 * A Shopee refusal AFTER the first write — the other half of the pair, and the
 * reason its closing line is not {@link LINHA_NADA_ENVIADO}.
 *
 * `etapa` is not a reason: it is the answer to "what exists on the channel now".
 * A rejection at `init_tier_variation` leaves an `UNLIST` item with no models;
 * one at `add_item` leaves nothing.
 */
export function descreverRecusaPublicacao(err: ShopeePublishRejectedError): string[] {
  const linhas = [
    `recusado pela Shopee em ${err.etapa} (${err.shopeeCode})`,
    `  produto ................. ${err.produtoId}`,
    `  item_id ................. ${err.itemId === null ? 'nenhum (o add_item foi recusado)' : String(err.itemId)}`,
    `  problemas (${String(err.problemas.length)}):`,
  ];
  for (const p of err.problemas) {
    linhas.push(`    ${txt(p.campo).padEnd(18)} ${p.motivo.padEnd(28)} ${p.mensagem}`);
  }
  linhas.push(
    '  ⚠️ Escritas ANTERIORES podem ter acontecido. Releia com --dry-run antes de repetir.',
  );
  return linhas;
}

/**
 * One failure, described by CLASS plus Shopee's `code`/`path` — never a payload.
 *
 * ⚠️ The Shopee half is `pedidos/importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented — the CLIs of this app face the same error
 * taxonomy and a second copy of that table is how one of them starts printing a
 * payload. Only the ARGUMENT arm and the two publish arms are this module's,
 * because the usage text and those two classes are this module's.
 */
export function descreverErroPublicacao(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_PUBLICAR_ANUNCIO];
  }
  if (err instanceof ShopeePublishBlockedError) {
    return [`❌ ShopeePublishBlockedError (${err.motivo})`, ...descreverBloqueioPublicacao(err)];
  }
  if (err instanceof ShopeePublishRejectedError) {
    return [`❌ ShopeePublishRejectedError (${err.etapa})`, ...descreverRecusaPublicacao(err)];
  }
  return descreverErro(err);
}
