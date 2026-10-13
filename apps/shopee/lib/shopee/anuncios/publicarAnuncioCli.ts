/**
 * The pure half of `scripts/publicar-anuncio.ts` (#1519, step 11) — argument
 * parsing, the **allow-list** summary of a publish PLAN, its renderers, the
 * `--live` result summary and the usage text. Since step 19 (#1527, PR 7) also
 * the three kit flags (`--principal`, `--recriar`, `--converter-em-kit`) and the
 * NATIVE-KIT summaries — the dry run's ({@link resumoDoEnsaioDeKit}) and the
 * live result's ({@link resumoDoResultadoKit}), whose `incerto` block prints the
 * exact command to re-run.
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
 * handed. Its only value imports are five pure modules of this app (the item
 * mapper's attribute helper, the two publish error classes, the shared CLI
 * error describer, the three routes' own doc-id predicate and — step 19 — the
 * kit result module's `incerto` sentence, `../kits/resultadoKit.ts`, which holds
 * types, one constant and one pure renderer); everything from the IO modules is
 * `import type`, which is erased.
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
 *  - **`size_chart_info` (step 18): the TEMPLATE id IS printed, the photo's
 *    `image_id` is NOT.** A template id is a shop's catalogue reference, like
 *    the brand id; the image chart is a picture, and pictures are counts here.
 *    The read-back's `size_chart` is a URL and only its presence is carried.
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
 *     It includes the tabela de medidas' FIRST photo when no template matched
 *     (step 18): `size_chart` is an `image_id` too.
 *
 * Ver apps/shopee/scripts/README.md.
 */
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  type ShopeeCategoria,
  type ShopeeItemStatusWritable,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';

import type { EnsaioDeKit } from '../kits/publicarKit';
import {
  MENSAGEM_KIT_INCERTO,
  type ArmaKit,
  type CodigoAvisoKit,
  type DesfechoKit,
  type ResultadoPublicacaoKit,
} from '../kits/resultadoKit';
import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import type { VerdictoFolha } from '../taxonomia/categorias';
import type { AtributosProjetados } from '../taxonomia/dto';
import { naoDocId } from './corpoPublicacao';
import {
  ETAPA_PUBLICACAO,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  cabecalhoDaRecusa,
  type ProblemaPublicacao,
} from './errosPublicacao';
import type { MotivoFotoPublicacao } from './fotosPublicacao';
import type { MotivoCanalPulado } from './logisticaPublicacao';
import { atributosParaPublicar } from './montagemAnuncio';
import type { OrdemDeRelistagem, PassoPublicacao, PlanoPublicacao } from './planoPublicacao';
import type { ResultadoPublicacao } from './publicarAnuncio';
import type {
  FotoTabelaMedidasOmitida,
  MotivoTabelaMedidasOmitida,
  TipoFonteTabelaDeMedidas,
} from './tabelaMedidasPublicacao';
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
Publica UM produto do ERP como anúncio na Shopee, pelo caminho real do step 11 —
ou, para um kit virtual, como KIT NATIVO da Shopee (step 19).

  pnpm --filter @delfrance/shopee-app publicar:anuncio \\
    --integracao <integracaoId> --produto <produtoId> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --produto <id>      o produto PAI do ERP (nunca uma variação)

Opções
  --link <docId>      o vínculo prodshopee a usar, quando o produto tem mais de um
  --categoria <id>    category_id folha, só dígitos. Só é usado quando o vínculo
                      NÃO tem categoria; nunca sobrescreve a armazenada. Num kit
                      nativo é ignorado: a categoria vem do componente principal.
  --status UNLIST     publica pausado. O padrão é NORMAL (à venda). Num kit
                      nativo vale na CRIAÇÃO (add_kit_item com «unlisted»)
                      e é ignorado numa republicação.
  --dry-run           lê, resolve as fotos e PLANEJA, sem escrever. É o PADRÃO.
  --live              PUBLICA DE VERDADE na Shopee e grava os vínculos.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

Kit nativo da Shopee (step 19)
  --principal <id>    o componente PRINCIPAL do kit (o id do produto componente
                      no ERP). Obrigatório ao CRIAR um kit cujos componentes vêm
                      de mais de um anúncio da Shopee: ela copia dele categoria,
                      atributos e marca, e não deixa trocar depois. Num kit que
                      já existe ele só é COMPARADO com o principal lido da Shopee.
  --recriar           cria um kit NOVO com a composição do ERP e só então exclui
                      o kit antigo. Exige --link <o vínculo do kit antigo>.
  --converter-em-kit  troca o anúncio COMUM deste produto por um kit nativo novo.
                      O anúncio comum fica INTOCADO na Shopee e continua recebendo
                      estoque e preço até ser excluído no Seller Centre (depois,
                      rode reverificar:anuncio com o --link dele).
  --recriar e --converter-em-kit não andam juntos.
  Sem nenhuma das duas, o ERP escolhe sozinho: cria o kit quando o produto é
  «É kit» + «É kit virtual» e não tem anúncio vivo nesta conta, e atualiza o kit
  nativo que já existe.
  ⚠️ NUNCA rode um comando de kit enquanto outra execução dele ainda estiver
  viva: o add_kit_item não é idempotente, e duas execuções ao mesmo tempo podem
  criar dois kits com o mesmo SKU. Se a resposta for INCERTO, espere e rode o
  comando exatamente como ele foi impresso.

O dry-run continua CHAMANDO a Shopee (get_item_limit, a árvore de categorias,
get_channel_list e o upload das fotos) e lendo o Firestore — ele não ESCREVE no
Firestore nem cria anúncio, e isso é estrutural: prepararPublicacao e
planejarPublicacao não têm escritor nenhum no corpo. As fotos, essas SOBEM: o
corpo do add_item precisa de image_id de verdade, e cada id fica no cache
arquivos.externalIds, então o custo é pago UMA vez.
Num kit nativo o dry-run lê o kit e os componentes, faz a busca de SKU
duplicado (só ao criar, recriar ou converter) e sobe as fotos só quando o kit
seria enviado; nunca chama add_kit_item, update_kit_item nem delete_item.
Um plano BLOQUEADO (sem peso, sem foto, atributo obrigatório vazio) é uma
RESPOSTA no DRY-RUN: ele é impresso na seção "problemas" e o comando sai com 0.
Em --live a mesma recusa não é capturada — ela sai com 1, como qualquer outro
erro.
⚠️ Antes de qualquer plano o ERP escolhe o caminho: anúncio comum ou kit nativo
(criar, atualizar, recriar, converter). Um produto FILHO, ou uma opção de kit
que não vale para este produto, é recusado ali, sem chamar a Shopee: essa
recusa LANÇA nos dois modos e sai com 1. Um kit INCERTO no --live também sai
com 1: nada foi gravado, e o comando a repetir é impresso.
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
  /**
   * `--principal <produtoId>` (step 19, L1): the kit's main component as an ERP
   * component produto id. The kit arms resolve it to ONE Shopee address; the
   * item arm refuses it (`opcao-de-kit-em-anuncio-comum`). `null` = not sent.
   */
  readonly principal: string | null;
  /** `--recriar` (L4(4)): ALWAYS with `--link` — the parser refuses it alone. */
  readonly recriar: boolean;
  /** `--converter-em-kit` (L8). Never together with `--recriar`. */
  readonly converterEmKit: boolean;
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

/**
 * `--recriar` and `--converter-em-kit` together — ONE kit action per run (R-a),
 * the CLI twin of the route's 400.
 */
export const MSG_CLI_RECRIAR_E_CONVERTER =
  '--recriar e --converter-em-kit não andam juntos: escolha UMA ação de kit por execução.';

/**
 * `--recriar` without `--link` (S1F-02). A recriar always NAMES the kit it
 * replaces, so re-running it is literally the same command — and a resume after
 * a crash can never be aimed at whichever kit the dispatcher would pick.
 */
export const MSG_CLI_RECRIAR_SEM_LINK =
  '--recriar exige --link <vínculo do kit antigo>: a recriação sempre nomeia o kit que ela ' +
  'substitui, para que repetir o comando seja repetir exatamente o mesmo comando.';

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
  let principal: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let json = false;
  let recriar = false;
  let converterEmKit = false;

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
      case '--principal':
        // A produto doc id, by the SAME rule as `--produto`: the kit arms read
        // `produtos/{principal}` to resolve it.
        principal = docIdDe('principal', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--recriar':
        recriar = true;
        break;
      case '--converter-em-kit':
        converterEmKit = true;
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
  // ⚠️ Both kit actions are refused HERE, before any read — the route's 400s
  // (`MSG_OPCOES_DE_KIT_EXCLUSIVAS` / `MSG_RECRIAR_SEM_LINK` in
  // `corpoPublicacao.ts`), spelled with this command's flags. A recriar that
  // reached the dispatcher without `--link` would target whichever kit it
  // picks, and re-running it would no longer be the same command (S1F-02).
  if (recriar && converterEmKit) throw new ArgumentoInvalidoError(MSG_CLI_RECRIAR_E_CONVERTER);
  if (recriar && linkDocId === undefined) {
    throw new ArgumentoInvalidoError(MSG_CLI_RECRIAR_SEM_LINK);
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
      principal: principal ?? null,
      recriar,
      converterEmKit,
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

/**
 * The size chart the plan would send (step 18), field by field.
 *
 * ⚠️ `enviado` is read off the BUILT `add_item` body — the same body the
 * publisher sends — never re-derived from the decision, so a key the mapper
 * stops sending disappears from here by itself. The photo's `image_id` is never
 * carried: `enviado: 'size_chart'` is all a rehearsal needs to know.
 */
export interface ResumoTabelaDeMedidasShopee {
  readonly fonte: TipoFonteTabelaDeMedidas;
  /** Which `size_chart_info` key the body carries, or `null` for none. */
  readonly enviado: 'size_chart_id' | 'size_chart' | null;
  /** The TEMPLATE id — printed; `null` unless `fonte === 'modelo'`. */
  readonly sizeChartId: number | null;
  readonly motivo: MotivoTabelaMedidasOmitida | null;
  readonly fotoOmitida: FotoTabelaMedidasOmitida | null;
  readonly tabMediId: string | null;
  readonly entradasNestaConta: number;
  readonly ilegiveis: number;
  readonly obrigatoria: boolean | null;
  readonly suportaModelo: boolean | null;
  readonly suportaFoto: boolean | null;
  readonly avisoObrigatoria: boolean;
  /**
   * The plan's size-chart REFUSAL — the photo did not upload, so `--live` would
   * answer 422 on `size_chart_info`. A MECHANISM sentence, like every problema.
   */
  readonly recusa: ProblemaPublicacao | null;
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
  readonly tabelaDeMedidas: ResumoTabelaDeMedidasShopee;
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
 * The size-chart decision, by NAME — plus which key the BUILT body carries.
 *
 * ⚠️ `size_chart`'s VALUE (an `image_id`) is read only to say the key is
 * there; it is never copied. Same rule as the pictures above.
 */
function resumoDaTabelaDeMedidas(plano: PlanoPublicacao): ResumoTabelaDeMedidasShopee {
  const decisao = plano.item.tabelaDeMedidas;
  const bloco = plano.item.criar.size_chart_info;
  let enviado: ResumoTabelaDeMedidasShopee['enviado'] = null;
  if (bloco !== undefined) {
    enviado = bloco.size_chart_id !== undefined ? 'size_chart_id' : 'size_chart';
  }
  return {
    fonte: decisao.fonte.tipo,
    enviado,
    sizeChartId: decisao.sizeChartId,
    motivo: decisao.motivo,
    fotoOmitida: decisao.fotoOmitida,
    tabMediId: decisao.tabMediId,
    entradasNestaConta: decisao.entradasNestaConta,
    ilegiveis: decisao.ilegiveis,
    obrigatoria: decisao.obrigatoria,
    suportaModelo: decisao.suportaModelo,
    suportaFoto: decisao.suportaFoto,
    avisoObrigatoria: decisao.avisoObrigatoria,
    recusa: plano.recusaTabelaDeMedidas,
  };
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
    tabelaDeMedidas: resumoDaTabelaDeMedidas(plano),
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
    // ⚠️ The size-chart refusal is a refusal like the others for the operator:
    // listed here, "NADA seria enviado" stays true and "publicável" never lies.
    problemas:
      plano.recusaTabelaDeMedidas === null
        ? plano.problemas
        : [...plano.problemas, plano.recusaTabelaDeMedidas],
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

/** A three-valued band flag: `—` is "not informed", never "no". */
function tri(v: boolean | null): string {
  return v === null ? '—' : sim(v);
}

/**
 * The `### size_chart_info` section (step 18): what goes out, from which source,
 * the category's band as ADVICE, and the warnings — never the photo's id.
 */
function renderTabelaDeMedidas(t: ResumoTabelaDeMedidasShopee): string[] {
  const linhas: string[] = ['### size_chart_info'];
  let envio: string;
  if (t.enviado === 'size_chart_id') {
    envio = `size_chart_id ${num(t.sizeChartId)} (o modelo escolhido em /medidas)`;
  } else if (t.enviado === 'size_chart') {
    envio = 'size_chart — a PRIMEIRA foto da tabela (o image_id é omitido de propósito)';
  } else if (t.recusa !== null) {
    envio = 'NADA — a foto da tabela não subiu e a publicação é RECUSADA';
  } else {
    envio = `— omitido (${txt(t.motivo)}${t.fotoOmitida === null ? '' : `; foto: ${t.fotoOmitida}`})`;
  }
  linhas.push(`  enviado ................. ${envio}`);
  linhas.push(
    `  fonte ................... ${t.fonte}${t.motivo === null ? '' : `  (sem modelo: ${t.motivo})`}`,
  );
  linhas.push(
    `  tabMedi ................. ${txt(t.tabMediId)}  ${String(t.entradasNestaConta)} entrada(s) nesta conta · ${String(t.ilegiveis)} ilegível(is)`,
  );
  linhas.push(
    `  size_chart_limit ........ ${
      t.obrigatoria === null && t.suportaModelo === null && t.suportaFoto === null
        ? '— (bloco ausente)'
        : `obrigatória=${tri(t.obrigatoria)}  modelo=${tri(t.suportaModelo)}  foto=${tri(t.suportaFoto)}`
    }  (conselho, nunca recusa)`,
  );
  if (t.avisoObrigatoria) {
    linhas.push(
      '  ⚠️ a categoria declara tabela OBRIGATÓRIA e nada será enviado — num CREATE a Shopee ' +
        'pode recusar; num UPDATE só passa se o anúncio já tiver tabela no Seller Centre',
    );
  }
  if (t.enviado === 'size_chart_id' && t.suportaModelo === false) {
    linhas.push(
      '  ⚠️ a categoria diz não aceitar modelo (support_template_size_chart=false) — o modelo ' +
        'escolhido vai mesmo assim e a Shopee decide',
    );
  }
  if (t.fotoOmitida === 'categoria-sem-foto') {
    linhas.push(
      '  ⚠️ a categoria não aceita foto de tabela (support_image_size_chart=false) — a primeira ' +
        'foto da tabela NÃO é enviada',
    );
  }
  if (t.recusa !== null) {
    linhas.push(`  ⛔ ${t.recusa.mensagem}`);
    linhas.push(
      '  (o --live responderia 422 em size_chart_info, antes de qualquer escrita no anúncio)',
    );
  }
  return linhas;
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
  for (const linha of renderTabelaDeMedidas(r.tabelaDeMedidas)) linhas.push(linha);

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
  /** What went out as `size_chart_info` and what the read-back echoed (step 18). */
  readonly tabelaDeMedidas: {
    readonly fonte: TipoFonteTabelaDeMedidas;
    readonly sizeChartId: number | null;
    readonly motivo: MotivoTabelaMedidasOmitida | null;
    readonly fotoOmitida: FotoTabelaMedidasOmitida | null;
    readonly avisoObrigatoria: boolean;
    readonly lidaDeVolta: number | null;
    readonly fotoLidaDeVolta: boolean | null;
  };
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
    tabelaDeMedidas: {
      fonte: res.tabelaDeMedidas.fonte,
      sizeChartId: res.tabelaDeMedidas.sizeChartId,
      motivo: res.tabelaDeMedidas.motivo,
      fotoOmitida: res.tabelaDeMedidas.fotoOmitida,
      avisoObrigatoria: res.tabelaDeMedidas.avisoObrigatoria,
      lidaDeVolta: res.tabelaDeMedidas.lidaDeVolta,
      fotoLidaDeVolta: res.tabelaDeMedidas.fotoLidaDeVolta,
    },
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

/**
 * The live summary's ONE size-chart line: what was sent, then what the
 * read-back echoed — `DIVERGE` when a sent template does not come back.
 *
 * ⚠️ That echo is the instrument for register 262 (is a JSON-number
 * `size_chart_id` accepted?); `—` means the read-back degraded, never "absent".
 */
function linhaDaTabelaDeMedidas(t: ResumoResultadoPublicacao['tabelaDeMedidas']): string {
  if (t.fonte === 'modelo') {
    const lido = t.lidaDeVolta === null ? '—' : String(t.lidaDeVolta);
    const diverge = t.lidaDeVolta !== null && t.lidaDeVolta !== t.sizeChartId ? '  DIVERGE' : '';
    return `enviado ${num(t.sizeChartId)} · lido de volta ${lido}${diverge}`;
  }
  if (t.fonte === 'foto') {
    const lida = t.fotoLidaDeVolta === null ? '—' : sim(t.fotoLidaDeVolta);
    return `enviada a primeira foto da tabela · foto lida de volta: ${lida}`;
  }
  return `omitido (${txt(t.motivo)}${t.fotoOmitida === null ? '' : `; foto: ${t.fotoOmitida}`})`;
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
  linhas.push(`  size_chart_info ......... ${linhaDaTabelaDeMedidas(r.tabelaDeMedidas)}`);
  if (r.tabelaDeMedidas.avisoObrigatoria) {
    linhas.push('  ⚠️ a categoria declara tabela OBRIGATÓRIA e nenhuma foi enviada');
  }
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
/*                     the native kit (step 19, #1527, PR 7)                   */
/* -------------------------------------------------------------------------- */

/**
 * What the kit summaries need beyond the run's own data.
 *
 * ⚠️ Only the OPERATOR's inputs — the `--integracao` id and the `--project`
 * override — plus the RESOLVED Shopee environment. No shop id, partner id or
 * token is an input of this module, so none can reach a printed command.
 */
export interface OpcoesDoKitCli {
  readonly integracaoId: string;
  /** `--project`, repeated in every command the summary prints; `null` when not passed. */
  readonly projectId: string | null;
  /**
   * `ctx.config.sandbox`: the SG sandbox prices in SGD inside a field this ERP
   * fills in BRL (R-g), and both kit summaries say so.
   */
  readonly sandbox: boolean;
}

/** The sandbox line — ONE spelling for both kit summaries. */
export const NOTA_SANDBOX_SG_KIT = 'sandbox SG: preço em SGD num campo BRL';

/** The invocation every printed command carries — the one the usage text documents. */
const PREFIXO_PNPM = 'pnpm --filter @delfrance/shopee-app';

/** `--project` rides every printed command, so a re-run targets the SAME project. */
function comProjeto(comando: string, projectId: string | null): string {
  return projectId === null ? comando : `${comando} --project ${projectId}`;
}

/** One component row, planned or sent: Shopee ids and a quantity — never a name. */
export interface ResumoComponenteKit {
  readonly itemId: number;
  /** `null` = a plain component: the wire omits it and Shopee reads back a hidden id. */
  readonly modelId: number | null;
  readonly quantidade: number;
  readonly principal: boolean;
}

/** One planned kit model: the ERP child it carries and that child's projection. */
export interface ResumoModeloKitPlanejado {
  readonly filhoId: string;
  readonly tierIndex: number;
  readonly componentes: readonly ResumoComponenteKit[];
  /** `false` ⇔ some component did not resolve — a refusal or a warning says which. */
  readonly projecaoCompleta: boolean;
}

/** One model of the `add_kit_item` body, rebuilt by NAME. */
export interface ResumoModeloKitEnviado {
  readonly tierIndex: number;
  readonly modelSku: string | null;
  readonly originalPrice: number;
  readonly componentes: readonly ResumoComponenteKit[];
}

/**
 * The `add_kit_item` body a create would send, by NAME — the same allow-list as
 * step 11's: the title printed, the description COUNTED, the pictures COUNTED.
 */
export interface ResumoCorpoKit {
  readonly itemName: string;
  readonly itemNameChars: number;
  readonly descricaoChars: number;
  readonly imagens: number;
  readonly itemSku: string | null;
  readonly weight: number;
  readonly dimension: {
    readonly alturaCm: number;
    readonly larguraCm: number;
    readonly comprimentoCm: number;
  } | null;
  /** The `logistic_id`s sent. */
  readonly canais: readonly number[];
  readonly tier: { readonly nome: string | null; readonly opcoes: readonly string[] };
  readonly modelos: readonly ResumoModeloKitEnviado[];
}

/** One kit warning. `mensagem` is a MECHANISM sentence with ids only (`AvisoKit`'s contract). */
export interface ResumoAvisoKit {
  readonly codigo: CodigoAvisoKit;
  readonly produtoId: string | null;
  readonly mensagem: string;
}

/** What a kit DRY RUN read and decided — nothing authored is carried, nothing was sent. */
export interface ResumoEnsaioDeKit {
  readonly arma: ArmaKit;
  readonly produtoId: string;
  /** atualizar/recriar: the target kit link; converter: the ordinary antecessor; criar: `null`. */
  readonly alvoLinkDocId: string | null;
  /** The target's LIVE `item_status`; `null` = not read (criar, converter, a removed target). */
  readonly statusDoAlvo: string | null;
  /** K's SKU as `item_sku` would carry it; `null` = empty or padded (phase A says why). */
  readonly sku: string | null;
  readonly familiaDeUm: boolean;
  readonly variacoes: number;
  /** The ONE variation axis' name (n ≥ 2); `null` for a família de um. */
  readonly eixo: string | null;
  readonly principal: { readonly itemId: number; readonly modelId: number | null } | null;
  readonly principalPedido: { readonly itemId: number; readonly modelId: number | null } | null;
  /** `get_kit_item_limit`: `null` = not read (no principal category known). */
  readonly limitesKit: 'servido' | 'indisponivel' | null;
  /** The L6 duplicate-SKU scan — create arms ONLY; `null` on `kit-atualizar` (L10(4)). */
  readonly busca: {
    readonly completo: boolean;
    readonly paginas: number;
    readonly chamadas: number;
    readonly achados: readonly {
      readonly itemId: number;
      readonly produtoId: string | null;
      readonly linkDocId: string | null;
    }[];
  } | null;
  readonly kitNovo:
    | { readonly acao: 'criar' }
    | { readonly acao: 'completar'; readonly linkDocId: string; readonly itemId: number }
    | { readonly acao: 'recusar' }
    | null;
  /** Non-null ONLY when a create would really call `add_kit_item`. */
  readonly corpo: ResumoCorpoKit | null;
  readonly modelos: readonly ResumoModeloKitPlanejado[];
  /** `kit-atualizar` only: the item-level content the `update_kit_item` would resend. */
  readonly conteudo: {
    readonly itemName: string | null;
    readonly descricaoChars: number | null;
    /** `null` = the photo pass was skipped — never "no picture". */
    readonly imagens: number | null;
    readonly weight: number | null;
    readonly canais: number;
  } | null;
  /** `null` = the photo pass did not run: a refused or a completing run uploads nothing. */
  readonly fotos: {
    readonly consideradas: number;
    readonly reutilizadas: number;
    readonly enviadas: number;
    readonly descartadasPeloLimite: number;
    readonly falhas: readonly ResumoFalhaDeFotoShopee[];
  } | null;
  readonly avisos: readonly ResumoAvisoKit[];
  /** NON-EMPTY = nothing would be sent; the dry run still exits 0. */
  readonly problemas: readonly ProblemaPublicacao[];
  readonly sandbox: boolean;
}

function componenteDoResumo(c: {
  readonly component_item_id: number;
  readonly component_model_id?: number;
  readonly quantity: number;
  readonly main_component?: boolean;
}): ResumoComponenteKit {
  return {
    itemId: c.component_item_id,
    modelId: c.component_model_id ?? null,
    quantidade: c.quantity,
    principal: c.main_component === true,
  };
}

function enderecoDoResumo(
  e: { readonly itemId: number; readonly modelId: number | null } | null,
): { readonly itemId: number; readonly modelId: number | null } | null {
  return e === null ? null : { itemId: e.itemId, modelId: e.modelId };
}

function avisoDoResumo(a: ResumoAvisoKit): ResumoAvisoKit {
  return { codigo: a.codigo, produtoId: a.produtoId, mensagem: a.mensagem };
}

/**
 * A kit dry run, reduced to the allow-list — the kit twin of
 * {@link resumoDaPublicacao}. Every field is named; nothing is spread, so the
 * description, the `image_id`s and the option images (none are sent, but a
 * future body might carry them) have no field to travel in.
 */
export function resumoDoEnsaioDeKit(
  ensaio: EnsaioDeKit,
  opcoes: Pick<OpcoesDoKitCli, 'sandbox'>,
): ResumoEnsaioDeKit {
  const { contexto, plano } = ensaio;
  const corpo = plano.corpo;
  const fotos = contexto.fotos;
  const conteudo = plano.conteudo;
  let kitNovo: ResumoEnsaioDeKit['kitNovo'] = null;
  if (plano.kitNovo !== null) {
    kitNovo =
      plano.kitNovo.acao === 'completar'
        ? { acao: 'completar', linkDocId: plano.kitNovo.linkDocId, itemId: plano.kitNovo.itemId }
        : { acao: plano.kitNovo.acao };
  }
  let corpoResumido: ResumoCorpoKit | null = null;
  if (corpo !== null) {
    const s = corpo.item_setting;
    const [tier] = s.tier_variation_list;
    corpoResumido = {
      itemName: s.item_name,
      itemNameChars: s.item_name.length,
      // ⚠️ The LENGTH and nothing else — the text is right there in `s.description`.
      descricaoChars: s.description.length,
      imagens: s.images.image_id_list.length,
      itemSku: s.item_sku ?? null,
      weight: s.weight,
      dimension:
        s.dimension === undefined
          ? null
          : {
              alturaCm: s.dimension.package_height,
              larguraCm: s.dimension.package_width,
              comprimentoCm: s.dimension.package_length,
            },
      canais: s.logistic_info.map((l) => l.logistic_id),
      // The option TEXTS (the ERP's own variante names, as step 11 prints its
      // tier options) — never an option image id.
      tier: { nome: tier.name ?? null, opcoes: tier.option_list.map((o) => o.option) },
      modelos: s.model_list.map((m) => ({
        tierIndex: m.tier_index[0],
        modelSku: m.model_sku ?? null,
        originalPrice: m.original_price,
        componentes: m.component_list.map(componenteDoResumo),
      })),
    };
  }
  return {
    arma: contexto.arma.arma,
    produtoId: contexto.produto.id,
    alvoLinkDocId: contexto.alvo?.linkDocId ?? null,
    statusDoAlvo: contexto.vivo?.status ?? null,
    sku: plano.sku,
    familiaDeUm: contexto.familiaDeUm,
    variacoes: contexto.filhos.length,
    eixo: contexto.grupo?.nome ?? null,
    principal: enderecoDoResumo(plano.principal),
    principalPedido: enderecoDoResumo(contexto.principalPedido),
    limitesKit: contexto.limites?.estado ?? null,
    busca:
      contexto.busca === null
        ? null
        : {
            completo: contexto.busca.completo,
            paginas: contexto.busca.paginas,
            chamadas: contexto.busca.chamadas,
            achados: contexto.busca.achados.map((a) => ({
              itemId: a.itemId,
              produtoId: a.vinculo?.produtoId ?? null,
              linkDocId: a.vinculo?.linkDocId ?? null,
            })),
          },
    kitNovo,
    corpo: corpoResumido,
    modelos: plano.modelos.map((m) => ({
      filhoId: m.filhoId,
      tierIndex: m.tierIndex,
      componentes: m.linhas.map(componenteDoResumo),
      projecaoCompleta: m.projecaoCompleta,
    })),
    conteudo:
      conteudo === undefined
        ? null
        : {
            itemName: conteudo.itemName,
            descricaoChars: conteudo.description === null ? null : conteudo.description.length,
            imagens: conteudo.imageIds === null ? null : conteudo.imageIds.length,
            weight: conteudo.weight,
            canais: conteudo.logisticInfo.length,
          },
    fotos:
      fotos === null
        ? null
        : {
            consideradas: fotos.resumo.consideradas,
            reutilizadas: fotos.resumo.reutilizadas,
            enviadas: fotos.resumo.enviadas,
            descartadasPeloLimite: fotos.resumo.descartadasPeloLimite,
            // `arquivoId` + the closed `motivo` — NEVER the failure's `mensagem`.
            falhas: fotos.item.falhas.map((f) => ({ arquivoId: f.arquivoId, motivo: f.motivo })),
          },
    avisos: plano.avisos.map(avisoDoResumo),
    problemas: plano.problemas,
    sandbox: opcoes.sandbox,
  };
}

function endereco(e: { readonly itemId: number; readonly modelId: number | null } | null): string {
  if (e === null) return '—';
  return e.modelId === null
    ? `item ${String(e.itemId)}`
    : `item ${String(e.itemId)} modelo ${String(e.modelId)}`;
}

function linhaDeComponentes(componentes: readonly ResumoComponenteKit[]): string {
  return componentes
    .map(
      (c) =>
        `${String(c.itemId)}${c.modelId === null ? '' : `/${String(c.modelId)}`} ×${String(c.quantidade)}${
          c.principal ? ' (principal)' : ''
        }`,
    )
    .join(', ');
}

function renderAvisosKit(avisos: readonly ResumoAvisoKit[]): string[] {
  const linhas = [`### avisos (${String(avisos.length)})`];
  if (avisos.length === 0) {
    linhas.push('  (nenhum)');
    return linhas;
  }
  for (const a of avisos) {
    linhas.push(`  ${a.codigo.padEnd(30)} ${txt(a.produtoId).padEnd(16)} ${a.mensagem}`);
  }
  return linhas;
}

/** A kit dry run, as terminal lines — what `--live` would do, and why it would not. */
export function renderResumoEnsaioDeKit(r: ResumoEnsaioDeKit): string[] {
  const linhas: string[] = [];
  linhas.push(`## O que um kit nativo faria (produto ${r.produtoId}, arma ${r.arma})`);
  linhas.push(
    `  vínculo alvo ............ ${txt(r.alvoLinkDocId)}${
      r.statusDoAlvo === null ? '' : `   item_status vivo=${r.statusDoAlvo}`
    }`,
  );
  linhas.push(`  item_sku ................ ${r.sku ?? '— (vazio ou com espaços nas pontas)'}`);
  linhas.push(
    `  variações ............... ${String(r.variacoes)}${
      r.familiaDeUm ? ' (família de um)' : r.eixo === null ? '' : ` no eixo "${r.eixo}"`
    }`,
  );
  linhas.push(
    `  componente principal .... ${endereco(r.principal)}${
      r.principalPedido === null ? '' : `   (--principal resolvido: ${endereco(r.principalPedido)})`
    }`,
  );
  linhas.push(
    `  limites de kit .......... ${
      r.limitesKit === null
        ? '— (nenhuma categoria de principal conhecida)'
        : r.limitesKit === 'servido'
          ? 'servidos pela Shopee'
          : 'indisponíveis neste host (sem faixa local)'
    }`,
  );
  if (r.busca === null) {
    linhas.push(
      '  busca de SKU duplicado .. não roda (só ao criar, recriar ou converter — L10(4))',
    );
  } else {
    const achados =
      r.busca.achados.length === 0
        ? 'nenhum kit com este SKU'
        : r.busca.achados
            .map(
              (a) =>
                `${String(a.itemId)}${
                  a.produtoId === null
                    ? ' (sem vínculo)'
                    : ` (vinculado ao produto ${a.produtoId}, vínculo ${txt(a.linkDocId)})`
                }`,
            )
            .join(', ');
    linhas.push(
      `  busca de SKU duplicado .. ${r.busca.completo ? 'completa' : 'INCOMPLETA'} — ${String(r.busca.paginas)} página(s), ${String(r.busca.chamadas)} chamada(s) — ${achados}`,
    );
  }
  if (r.kitNovo !== null) {
    linhas.push(
      `  kit novo ................ ${
        r.kitNovo.acao === 'criar'
          ? 'CRIAR (add_kit_item)'
          : r.kitNovo.acao === 'completar'
            ? `COMPLETAR o kit ${String(r.kitNovo.itemId)} já vinculado (vínculo ${r.kitNovo.linkDocId}) — nada é criado`
            : 'RECUSADO (veja os problemas)'
      }`,
    );
  }
  if (r.sandbox) linhas.push(`  ⚠️ ${NOTA_SANDBOX_SG_KIT}`);

  if (r.corpo !== null) {
    const c = r.corpo;
    linhas.push('');
    linhas.push('### add_kit_item (o que o --live enviaria)');
    linhas.push(`  item_name ............... "${c.itemName}" (${String(c.itemNameChars)} ch)`);
    linhas.push(
      `  descrição ............... «REDIGIDA — ${String(c.descricaoChars)} caractere(s)»`,
    );
    linhas.push(
      `  imagens ................. ${String(c.imagens)} image_id no corpo (os ids são omitidos de propósito)`,
    );
    linhas.push(`  item_sku ................ ${txt(c.itemSku)}`);
    linhas.push(`  weight .................. ${String(c.weight)} kg`);
    linhas.push(
      `  dimension ............... ${
        c.dimension === null
          ? '—'
          : `${String(c.dimension.alturaCm)}×${String(c.dimension.larguraCm)}×${String(c.dimension.comprimentoCm)} cm (A×L×C)`
      }`,
    );
    linhas.push(`  logistic_info ........... ${lista(c.canais.map(String))}`);
    linhas.push(
      `  tier .................... ${c.tier.nome === null ? '—' : `"${c.tier.nome}"`}: ${c.tier.opcoes.map((o) => `"${o}"`).join(', ')}`,
    );
    linhas.push('  tier_index  model_sku            preço      componentes (item/modelo ×qtd)');
    for (const m of c.modelos) {
      linhas.push(
        `  ${`[${String(m.tierIndex)}]`.padEnd(11)} ${txt(m.modelSku).padEnd(20)} ${String(m.originalPrice).padEnd(10)} ${linhaDeComponentes(m.componentes)}`,
      );
    }
  } else {
    linhas.push('');
    linhas.push(`### modelos planejados (${String(r.modelos.length)}) — filho → componentes`);
    for (const m of r.modelos) {
      linhas.push(
        `  [${String(m.tierIndex)}] ${m.filhoId.padEnd(20)} ${linhaDeComponentes(m.componentes)}${
          m.projecaoCompleta ? '' : '  (composição INCOMPLETA)'
        }`,
      );
    }
  }

  if (r.conteudo !== null) {
    const c = r.conteudo;
    linhas.push('');
    linhas.push('### update_kit_item (o conteúdo que o --live reenviaria)');
    linhas.push(`  item_name ............... ${c.itemName === null ? '—' : `"${c.itemName}"`}`);
    linhas.push(
      `  descrição ............... ${c.descricaoChars === null ? '—' : `«REDIGIDA — ${String(c.descricaoChars)} caractere(s)»`}`,
    );
    linhas.push(
      `  imagens ................. ${c.imagens === null ? '— (fotos não resolvidas)' : `${String(c.imagens)} image_id`}`,
    );
    linhas.push(
      `  weight .................. ${c.weight === null ? '—' : `${String(c.weight)} kg`}`,
    );
    linhas.push(`  logistic_info ........... ${String(c.canais)} canal(is)`);
    linhas.push('  (os modelos vão com a composição VIVA da Shopee — a do ERP nunca é reenviada)');
  }

  linhas.push('');
  linhas.push('### fotos');
  if (r.fotos === null) {
    linhas.push('  não resolvidas — nada seria enviado, então nenhuma foto subiu');
  } else {
    linhas.push(
      `  ${String(r.fotos.consideradas)} consideradas · ${String(r.fotos.reutilizadas)} reaproveitadas · ${String(r.fotos.enviadas)} enviadas · ${String(r.fotos.descartadasPeloLimite)} fora do limite`,
    );
    for (const f of r.fotos.falhas) linhas.push(`  falha: arquivo ${f.arquivoId} — ${f.motivo}`);
  }

  linhas.push('');
  for (const linha of renderAvisosKit(r.avisos)) linhas.push(linha);

  linhas.push('');
  if (r.problemas.length === 0) {
    linhas.push('### problemas: NENHUM — este kit é publicável');
  } else {
    linhas.push(`### problemas (${String(r.problemas.length)}) — NADA seria enviado`);
    for (const p of r.problemas) {
      linhas.push(`  ${txt(p.campo).padEnd(18)} ${p.motivo.padEnd(28)} ${p.mensagem}`);
    }
  }
  return linhas;
}

/** `renderizarEnsaioDeKit` — a kit dry run, straight to the lines a terminal shows. */
export function renderizarEnsaioDeKit(
  ensaio: EnsaioDeKit,
  opcoes: Pick<OpcoesDoKitCli, 'sandbox'>,
): string[] {
  return renderResumoEnsaioDeKit(resumoDoEnsaioDeKit(ensaio, opcoes));
}

/**
 * What a kit `--live` run reported, by NAME — {@link ResultadoPublicacaoKit}
 * plus the three things only THIS surface can add: the `incerto` sentence, the
 * EXACT command to re-run (the result's `comando` + this CLI's own flags), and
 * the `reverificar:anuncio` command for an old listing that is still live.
 */
export interface ResumoResultadoKit {
  readonly arma: ArmaKit;
  readonly desfecho: DesfechoKit;
  readonly produtoId: string;
  readonly itemId: number | null;
  readonly linkDocId: string | null;
  readonly estadoAnuncio: string | null;
  readonly itemStatus: string | null;
  readonly kitNativo: boolean | null;
  readonly modelos: {
    readonly vinculados: number;
    readonly anexados: number;
    readonly semFilho: number;
  };
  readonly antecessor: {
    readonly itemId: number;
    readonly linkDocId: string;
    readonly excluido: boolean;
    readonly substituido: boolean;
  } | null;
  readonly avisos: readonly ResumoAvisoKit[];
  readonly avisosResolvidos: number;
  readonly chamadasShopee: number;
  /**
   * Shopee's refusal on an `incerto` create. ⚠️ `fraseShopee` is provider prose,
   * carried for the same reason step 11's `avisoShopee` is: the operator's only
   * channel for it — the publisher's log line carries ids only.
   */
  readonly recusa: {
    readonly codigo: string;
    readonly fraseShopee: string | null;
    readonly motivo: string | null;
  } | null;
  /** `MENSAGEM_KIT_INCERTO` on `incerto`, else `null`. */
  readonly mensagemIncerto: string | null;
  /**
   * The EXACT command to re-run on `incerto` (S1F-03): the result's
   * `comandoDeRetomada` — which already names the arm's flags, the `--link` and
   * the `--principal` — prefixed with the pnpm invocation and followed by
   * `--project` (when passed) and `--live`. `null` otherwise.
   */
  readonly comandoDeRetomada: string | null;
  /**
   * After a converter, or a recriar whose `delete_item` did not take, the OLD
   * listing is still live on Shopee: delete it in Seller Centre, then this
   * command is how the ERP learns it is gone (L8). `null` otherwise.
   */
  readonly comandoReverificar: string | null;
  readonly sandbox: boolean;
}

/** `--json --live` for a kit: the SAME allow-list, as an object. One builder, no second copy. */
export function resumoDoResultadoKit(
  res: ResultadoPublicacaoKit,
  opcoes: OpcoesDoKitCli,
): ResumoResultadoKit {
  const incerto = res.desfecho === 'incerto';
  const antecessorVivo =
    res.antecessor !== null && res.antecessor.substituido && !res.antecessor.excluido;
  return {
    arma: res.arma,
    desfecho: res.desfecho,
    produtoId: res.produtoId,
    itemId: res.itemId,
    linkDocId: res.linkDocId,
    estadoAnuncio: res.estadoAnuncio,
    itemStatus: res.itemStatus,
    kitNativo: res.kitNativo,
    modelos: {
      vinculados: res.modelos.vinculados,
      anexados: res.modelos.anexados,
      semFilho: res.modelos.semFilho,
    },
    antecessor:
      res.antecessor === null
        ? null
        : {
            itemId: res.antecessor.itemId,
            linkDocId: res.antecessor.linkDocId,
            excluido: res.antecessor.excluido,
            substituido: res.antecessor.substituido,
          },
    avisos: res.avisos.map(avisoDoResumo),
    avisosResolvidos: res.avisosResolvidos,
    chamadasShopee: res.chamadasShopee,
    recusa:
      res.recusa === null
        ? null
        : {
            codigo: res.recusa.codigo,
            fraseShopee: res.recusa.fraseShopee,
            motivo: res.recusa.motivo,
          },
    mensagemIncerto: incerto ? MENSAGEM_KIT_INCERTO : null,
    comandoDeRetomada:
      incerto && res.comando !== null
        ? `${PREFIXO_PNPM} ${comProjeto(res.comando, opcoes.projectId)} --live`
        : null,
    comandoReverificar:
      antecessorVivo && res.antecessor !== null
        ? comProjeto(
            `${PREFIXO_PNPM} reverificar:anuncio --integracao ${opcoes.integracaoId} --produto ${res.produtoId} --link ${res.antecessor.linkDocId}`,
            opcoes.projectId,
          )
        : null,
    sandbox: opcoes.sandbox,
  };
}

/** The kit `--live` summary as terminal lines. */
export function renderResumoResultadoKit(r: ResumoResultadoKit): string[] {
  const linhas: string[] = [
    `## O que o kit nativo fez na Shopee e no ERP (arma ${r.arma}, desfecho ${r.desfecho})`,
  ];
  linhas.push(`  produtoId ............... ${r.produtoId}`);
  linhas.push(
    `  item_id ................. ${r.itemId === null ? '— (incerto)' : String(r.itemId)}   vínculo=${txt(r.linkDocId)}`,
  );
  linhas.push(
    `  leitura de volta ........ estadoAnuncio=${txt(r.estadoAnuncio)}  item_status=${txt(r.itemStatus)}  kitNativo=${
      r.kitNativo === null ? '—' : sim(r.kitNativo)
    }`,
  );
  linhas.push(
    `  modelos ................. ${String(r.modelos.vinculados)} vinculados · ${String(r.modelos.anexados)} anexados · ${String(r.modelos.semFilho)} sem filho`,
  );
  if (r.antecessor !== null) {
    const destino = r.antecessor.excluido
      ? 'EXCLUÍDO na Shopee'
      : r.antecessor.substituido
        ? 'SUBSTITUÍDO — continua vivo na Shopee'
        : 'INTOCADO';
    linhas.push(
      `  anúncio antigo .......... item ${String(r.antecessor.itemId)} (vínculo ${r.antecessor.linkDocId}): ${destino}`,
    );
  }
  linhas.push(`  aviso de composição ..... ${String(r.avisosResolvidos)} resolvido(s)`);
  linhas.push(`  chamadas à Shopee ....... ${String(r.chamadasShopee)}`);
  if (r.sandbox) linhas.push(`  ⚠️ ${NOTA_SANDBOX_SG_KIT}`);

  linhas.push('');
  for (const linha of renderAvisosKit(r.avisos)) linhas.push(linha);

  if (r.mensagemIncerto !== null) {
    linhas.push('');
    linhas.push('### ⚠️ INCERTO — nada foi gravado no ERP');
    if (r.recusa !== null) {
      linhas.push(
        `  resposta da Shopee ...... ${r.recusa.codigo}${r.recusa.motivo === null ? '' : ` (${r.recusa.motivo})`}${
          r.recusa.fraseShopee === null ? '' : ` — "${r.recusa.fraseShopee}"`
        }`,
      );
    }
    linhas.push(`  ${r.mensagemIncerto}`);
    if (r.comandoDeRetomada !== null) {
      linhas.push('  o comando, exatamente:');
      linhas.push(`    ${r.comandoDeRetomada}`);
    }
  }
  if (r.comandoReverificar !== null) {
    linhas.push('');
    linhas.push('### o anúncio antigo continua vivo na Shopee');
    linhas.push(
      '  ele continua vendendo e recebendo estoque e preço; exclua-o no Seller Centre e depois rode:',
    );
    linhas.push(`    ${r.comandoReverificar}`);
  }
  return linhas;
}

/** A kit `--live` run, straight to the terminal lines. */
export function renderizarResultadoKit(
  res: ResultadoPublicacaoKit,
  opcoes: OpcoesDoKitCli,
): string[] {
  return renderResumoResultadoKit(resumoDoResultadoKit(res, opcoes));
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * The closing a {@link ShopeePublishBlockedError} gets — ONE line per mode,
 * because the error cannot say which side of a write it was thrown from (R3-02).
 *
 * - **The dry run never writes before it refuses.** Its refusals are the
 *   dispatcher's, a kit create arm's phase A and `prepararPublicacao`'s, all
 *   thrown before the first Shopee write and before the pictures go up.
 * - **`--live` can refuse AFTER writes.** A kit arm first writes into the ERP
 *   what it read from Shopee: `republicarKit` the deleted target's `removido`,
 *   and an interrupted create's write-back #2 plus its `variashopee` rows;
 *   `garantirKitNovo` the `removido` of a deleted kit link of ours; `recriarKit`'s
 *   "nothing to recreate" refusal the aviso re-evaluation. Step 11's model leg
 *   (`modelosPublicacao.ts`) refuses on the UPDATE path after `update_item` and
 *   write-back #1 have landed.
 *
 * The class carries no "earlier writes" flag, and its `motivo` does not tell the
 * sites apart (a carried content miss such as `sem-peso` reaches a pre-write and
 * a post-write throw alike). So the describer states what each MODE guarantees
 * and leaves the mode to the operator who ran it. It used to close every refusal
 * with "Nada foi enviado à Shopee e nenhum vínculo foi gravado", which a `--live`
 * kit refusal made false.
 */
const LINHAS_DO_BLOQUEIO = [
  '  No --dry-run a recusa é anterior a qualquer escrita: nada foi enviado à Shopee e nenhum ' +
    'vínculo foi gravado.',
  '  ⚠️ No --live ela pode vir DEPOIS de escritas: um kit nativo grava antes no ERP o que leu ' +
    'da Shopee (o vínculo, as variações do kit, o aviso de composição), e a atualização de um ' +
    'anúncio comum pode já ter enviado o update_item. Releia com --dry-run antes de repetir.',
] as const;

/**
 * A produto the publisher REFUSES — an answer, never a failure.
 *
 * ⚠️ **This describer is only ever reached through the ERROR path, so it exits
 * 1 — in BOTH modes.** The refusals it renders are the ones THROWN before a
 * plan exists — since step 19 above all the dispatcher's
 * (`escolherArmaDePublicacao`: `produto-e-filho`, `vinculos-ambiguos`,
 * `vinculo-substituido`, `kit-virtual-sem-kit`, the converter refusals,
 * `opcao-de-kit-em-anuncio-comum`, all with ZERO Shopee calls), a kit create
 * arm's phase-A refusal (Firestore-only, before the first Shopee read) and
 * `prepararPublicacao`'s defensive `produto-e-kit` — and, under `--live`, the
 * appliers' own throws, which can FOLLOW writes ({@link LINHAS_DO_BLOQUEIO}).
 * The exit-0 answer is a different object: a blocked PLAN, whose refusals ride
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
  linhas.push(...LINHAS_DO_BLOQUEIO);
  return linhas;
}

/**
 * A Shopee refusal AFTER the first write — the other half of the pair, and the
 * reason its closing line is not {@link LINHAS_DO_BLOQUEIO}.
 *
 * `etapa` is not a reason: it is the answer to "what exists on the channel now".
 * A rejection at `init_tier_variation` leaves an `UNLIST` item with no models;
 * one at `add_item` leaves nothing.
 *
 * The headline is the class's own clause ({@link cabecalhoDaRecusa}): no empty
 * `()` when Shopee sent no code, and no "pela Shopee" for step 18's size-chart
 * photo that never reached Shopee.
 */
export function descreverRecusaPublicacao(err: ShopeePublishRejectedError): string[] {
  // Step 19: a kit create Shopee refused for good (`nao-criado`) is THIS class
  // at etapa `add_kit_item` — the kit was not created, so the line names that
  // call rather than step 11's `add_item`.
  const semItem =
    err.etapa === ETAPA_PUBLICACAO.addKitItem
      ? 'nenhum (o add_kit_item foi recusado: a Shopee não criou o kit)'
      : 'nenhum (o add_item foi recusado)';
  const linhas = [
    cabecalhoDaRecusa(err.etapa, err.shopeeCode, err.recusadaPelaShopee),
    `  produto ................. ${err.produtoId}`,
    `  item_id ................. ${err.itemId === null ? semItem : String(err.itemId)}`,
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
