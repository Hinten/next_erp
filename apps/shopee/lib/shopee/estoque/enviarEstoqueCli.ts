/**
 * The pure half of `scripts/enviar-estoque.ts` (#1520, step 12) — argument
 * parsing, the DRY-RUN plan, its renderers, the `--live` envelope renderer and
 * the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning, same shape as
 * `anuncios/publicarAnuncioCli.ts`, `pedidos/importarPedidoCli.ts` and the four
 * other CLI halves. The script keeps the I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads `process.env`, opens a client, touches Firestore or reads a clock —
 * every instant it renders already arrived rendered (`pausadoAte` is an ISO
 * string by the time the envelope carries it). That is also this folder's own
 * discipline: the clock is a parameter under `lib/shopee/estoque/`, and the
 * script supplies it.
 *
 * ## The two modes, and why the dry run cannot send by accident
 *
 * **`--dry-run` (the DEFAULT)** reads the families, computes the quantities and
 * runs the PLANNER, then reads each planned listing's promotion so the `piso`
 * column is real. It is structurally incapable of sending: the planner path
 * reaches no sender at all — `montarTarefasDeEstoqueShopee` returns data, and
 * the only thing in this channel that calls `update_stock` is
 * `processShopeeStockSendTask`, which lives behind `enviarEstoqueManualShopee`.
 *
 * **`--live`** calls `enviarEstoqueManualShopee` exactly as the route does —
 * one logical instant, an injected elapsed clock, one shop-signed client — and
 * renders the envelope it answers.
 *
 * ⚠️ **A dry run is NOT a cheaper `--live`.** The planner's rungs run in both
 * modes, but the reserved floor, the category band, the per-model `failure_list`
 * and every conta-level refusal only exist once Shopee has been asked. A clean
 * plan is "nothing we can see refuses this", never "this will land".
 *
 * ## What it prints, and what it must never print
 *
 * Every builder below is an ALLOW-LIST: no input object is ever copied, each
 * field is named and constructed one at a time, so a field a future schema
 * change adds to the envelope, to a link document or to a promotion body cannot
 * appear in the output. A denylist has the opposite property — it protects the
 * fields somebody remembered.
 *
 * Never printed, deliberately: a token, the partner id or key, a raw promotion
 * body, any buyer datum, and the listing's `item_name`. The produto's own NAME
 * is printed, for the same reason step 11 prints the title it is about to
 * create: it is the one thing that lets a human tell `prod-a` from `prod-b`.
 * Shopee's refusal `codigo` is printed and its prose is not — the code is a
 * catalogue value that can be looked up in the provider's own documentation,
 * while the sentence beside it is always `MENSAGEM_POR_MOTIVO`'s, i.e. ours.
 *
 * ## ⚠️ The band column is structurally present and empty today
 *
 * The v1 task payload carries no band, so the sender resolves none and nothing
 * on the dry-run path resolves one either — {@link OpcoesDoPlano.bandaPorItem}
 * exists so the column is computed by the REAL predicates
 * ({@link aplicarPiso}, {@link pisoAcimaDaBanda}) the day a band is resolved,
 * rather than by a second copy of their arithmetic written later under
 * pressure. Until then every row reads `—` and `clampeado` can only answer
 * `piso` or `nenhum`.
 *
 * Ver apps/shopee/scripts/README.md.
 */
import { componentesKitEntries, kitEstoqueDisponivel } from '@delfrance/schemas';
import { disponivelByProdutoIdFrom } from '@delfrance/data/admin/estoque';

import { naoDocId } from '../anuncios/corpoPublicacao';
import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import {
  SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
  STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
  STOCK_TASK_ENCODED_BODY_WARN_BYTES,
  stockTaskEncodedBodyBytes,
} from './constantesEstoque';
import type {
  EnvioEstoqueListing,
  EnvioEstoqueResponse,
  EnvioEstoqueSemEnvio,
} from './enviarEstoqueManual';
import {
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  ShopeeEnvioEstoqueGuardError,
  ehRecusa,
  type MotivoEstoqueShopee,
} from './errosEstoque';
import type {
  LinhaDeFamiliaShopee,
  LinkShopeeCru,
  MembroDaFamilia,
  ResultadoDoPlanoShopee,
  TarefaDeEstoqueShopee,
} from './planoEstoque';
import { aplicarPiso, pisoAcimaDaBanda } from './reservaPromocao';

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
 *
 * ⚠️ It names no shop, no partner id and no credential. The store this run
 * signs for is read from the integração document at runtime and printed by the
 * script's preamble.
 */
export const USO_ENVIAR_ESTOQUE = `
Envia o estoque ATUAL de produtos escolhidos a mão para os anúncios da Shopee.

  pnpm --filter @delfrance/shopee-app enviar:estoque \\
    --integracao <integracaoId> --produto <produtoId> [--produto <produtoId> ...]

Obrigatórios
  --integracao <id>    documento da integração Shopee (ex.: int-1)
  --produto <id>       o produto ÂNCORA da família (nunca uma variação). REPITA
                       a flag para cada produto: não existe lista separada por
                       vírgula, porque a vírgula é um caractere legal num id de
                       documento.

Opções
  --reenviar-com-erro  ignora a impressão digital da última recusa — e SÓ ela.
                       Anúncio removido, banido, em revisão, kit nativo da
                       Shopee ou sem item_id continuam recusando.
  --dry-run            lê, planeja e imprime, sem enviar nada. É o PADRÃO.
  --live               ENVIA DE VERDADE o estoque e grava os vínculos.
  --project <id>       sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json               imprime o mesmo resumo redigido em JSON no stdout
                       (o cabeçalho vai para o stderr).
  --help, -h           mostra esta ajuda e sai com 0, sem abrir o Firestore
                       nem chamar a Shopee.

No máximo ${String(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS)} produtos por execução, contados DEPOIS de tirar os repetidos.

O dry-run lê o Firestore e CHAMA a Shopee para a coluna "piso" (get_item_promotion,
uma leitura) — ele não escreve no Firestore e não chega ao remetente: o caminho do
planejador não tem nenhum.
O envio manual IGNORA a chave SHOPEE_STOCK_SYNC_ENABLED, de propósito: o botão
precisa funcionar antes de a varredura automática ser ligada.
Uma recusa POR ANÚNCIO é uma RESPOSTA, não uma falha da execução: mesmo com todos
os anúncios recusados o comando sai com 0, igual à rota. Só um erro que derruba a
execução inteira sai com 1.
Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsEnviarEstoque {
  readonly integracaoId: string;
  /** DEDUPED, in the order the flags were given. Never empty. */
  readonly produtoIds: readonly string[];
  /** Bypasses the per-link skip set and NOTHING else. */
  readonly reenviarComErro: boolean;
  /** `false` — the DRY-RUN default. `--live` is the only way to send. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoEnviarEstoque =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'enviar'; readonly args: ArgsEnviarEstoque };

/** `--produto` was never given. */
export const MSG_PRODUTO_OBRIGATORIO =
  '--produto <produtoId> é obrigatório (repita a flag para enviar vários).';

/** More produtos than one run may carry, counted AFTER deduplication. */
export const MSG_EXCEDE_LIMITE = `--produto foi passado mais de ${String(
  SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
)} vezes (sem contar repetidos). Divida em execuções menores.`;

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A doc id: trimmed, then checked with {@link naoDocId} — `../anuncios/
 * corpoPublicacao`'s export, the SAME predicate every step-11/12 route reads its
 * body with.
 *
 * ⚠️ ONE spelling, and the reason is measured rather than stylistic (step 11's
 * own lesson): a local copy of the rule had already drifted at birth — it
 * refused `''` and the separator but NOT the two relative names, so `--produto
 * ..` passed argument validation and reached `produtos/../prodshopee`.
 * `.doc('..')` does not throw locally, it RESOLVES, so the operator got a
 * server-side `INVALID_ARGUMENT` instead of the sentence below.
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
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags. The script's side
 * of that bargain is to return before its first dynamic import.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the readers
 * of the command line would expect the other — and here the wrong half writes a
 * quantity to a real marketplace.
 *
 * ⚠️ `--produto` is REPEATABLE and there is no comma-separated form, because a
 * comma is a legal character in a Firestore document id: splitting on one would
 * turn a single unusual id into two ids that address nothing, and the run would
 * report two produtos "não encontrados" for a produto that exists.
 */
export function lerArgsEnviarEstoque(argv: readonly string[]): ComandoEnviarEstoque {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let projectId: string | undefined;
  const produtoIds: string[] = [];
  const vistos = new Set<string>();
  let reenviarComErro = false;
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
      case '--produto': {
        const produtoId = docIdDe('produto', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        // DEDUPED here, in flag order: the envelope's accounting invariant is a
        // set equality against this list, and the route dedupes the same way.
        if (!vistos.has(produtoId)) {
          vistos.add(produtoId);
          produtoIds.push(produtoId);
        }
        break;
      }
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--reenviar-com-erro':
        reenviarComErro = true;
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
  if (produtoIds.length === 0) throw new ArgumentoInvalidoError(MSG_PRODUTO_OBRIGATORIO);
  // ⚠️ REFUSED here with the CLI's own argument error, never truncated and never
  // left to the module: above the cap `enviarEstoqueManualShopee` raises a
  // config-class error, which the route maps to a 500 — "server misconfig" is
  // the wrong answer for a human who typed one flag too many.
  if (produtoIds.length > SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS) {
    throw new ArgumentoInvalidoError(MSG_EXCEDE_LIMITE);
  }

  return {
    kind: 'enviar',
    args: {
      integracaoId,
      produtoIds,
      reenviarComErro,
      live,
      json,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the dry run                                 */
/* -------------------------------------------------------------------------- */

/** Which constraint moved a model's quantity, if any. */
export type ClampeDoPlano = 'piso' | 'banda' | 'nenhum';

export const CLAMPE_DO_PLANO = {
  piso: 'piso',
  banda: 'banda',
  nenhum: 'nenhum',
} as const satisfies Record<string, ClampeDoPlano>;

/** One model line of the plan. */
export interface LinhaDeModeloDoPlano {
  /** ⚠️ `0` is the no-model listing and is a real value, never "absent". */
  readonly modelId: number;
  /** The CHILD produto owning this model's stock — the anchor at `modelId: 0`. */
  readonly produtoId: string;
  /** What the planner computed: floored, UNCLAMPED by the band. */
  readonly quantidade: number;
  /** What the sender would actually write, after the reserved floor. */
  readonly envia: number;
  /** The promotion's reserved floor, or `null` when no promotion holds it. */
  readonly piso: number | null;
  /** The category band's ceiling. See the module header: always `null` today. */
  readonly bandaMax: number | null;
  readonly clampeado: ClampeDoPlano;
}

/** One constraining component of a kit, as the kit arithmetic sees it. */
export interface ComponenteDoPlano {
  readonly componenteId: string;
  /**
   * The component's availability at this depósito, or `null` when the join did
   * not bring it back. ⚠️ `null` is NOT zero stock: the kit arithmetic scores an
   * unresolved component as 0 (#238), which is exactly the case a human reading
   * this fold is here to catch.
   */
  readonly disponivel: number | null;
  /** Whether this component constrains the kit — `limitarEstoque` and a positive quantity. */
  readonly limita: boolean;
  /** How many units of this component one kit consumes. */
  readonly porKit: number;
}

/** The component fold behind ONE kit member's quantity. */
export interface DobraDeKitDoPlano {
  readonly produtoId: string;
  readonly componentes: readonly ComponenteDoPlano[];
  /** `kitEstoqueDisponivel`'s answer: `null` when no component constrains. */
  readonly min: number | null;
}

/** One planned `update_stock` call. */
export interface ListagemDoPlano {
  /** The family ANCHOR — the produto that owns the `prodshopee` link. */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly anuncioId: string;
  readonly linkDocId: string;
  /** The stored `estadoAnuncio`, or `null` when the link carries none. */
  readonly estadoAnuncio: string | null;
  /** A NATIVE Shopee kit — the one listing shape this channel never sends. */
  readonly kitNativo: boolean;
  readonly parte: number;
  readonly totalDePartes: number;
  readonly modelos: readonly LinhaDeModeloDoPlano[];
  /** One fold per kit member whose quantity this call carries. */
  readonly kits: readonly DobraDeKitDoPlano[];
  /** The encoded task body, the size the queue would have to accept. */
  readonly bytes: number;
}

/** One line for something the plan will NOT send. */
export interface PuloDoPlano {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly anuncioId: string | null;
  readonly modelId: number | null;
  readonly modelosAfetados: number | null;
  readonly motivo: MotivoEstoqueShopee;
  /** RENDERED pt-BR, by lookup. Never a slug, never re-worded here. */
  readonly mensagem: string;
  /** ⚠️ Through {@link ehRecusa} only — a clamp is an ANNOTATION, not a refusal. */
  readonly recusa: boolean;
}

/** One row of the by-motivo totals. */
export interface TotalPorMotivo {
  readonly motivo: MotivoEstoqueShopee;
  readonly mensagem: string;
  readonly recusa: boolean;
  readonly total: number;
}

export interface PlanoDeEnvioEstoque {
  readonly integracaoId: string;
  /** The DEDUPED request size. */
  readonly solicitados: number;
  /** Families discovery actually returned. */
  readonly familias: number;
  readonly listagens: readonly ListagemDoPlano[];
  readonly pulos: readonly PuloDoPlano[];
  readonly totaisPorMotivo: readonly TotalPorMotivo[];
  readonly modelos: number;
  readonly orcamentoBytes: number;
  readonly avisoBytes: number;
}

/** One requested produto, with whatever discovery and the planner answered for it. */
export interface EntradaDoPlano {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  /** `null` when discovery returned no family for this requested anchor. */
  readonly row: LinhaDeFamiliaShopee | null;
  /** `null` exactly when {@link row} is. */
  readonly plano: ResultadoDoPlanoShopee | null;
}

export interface OpcoesDoPlano {
  readonly integracaoId: string;
  /** `item_id` → (`model_id` → the promotion's reserved floor). */
  readonly pisoPorItem: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /** `item_id` → the category band's ceiling. See the module header. */
  readonly bandaPorItem?: ReadonlyMap<number, number | null>;
}

/** A non-empty string off an unvalidated link row, or null. */
function texto(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

function linkDoDocId(
  row: LinhaDeFamiliaShopee,
  linkDocId: string,
): Readonly<LinkShopeeCru> | undefined {
  return row.links.find((l) => texto(l.linkDocId) === linkDocId);
}

/**
 * The component fold behind one kit member's quantity — the shared arithmetic,
 * never a second copy of it.
 *
 * ⚠️ "Constraining" means exactly what `kitEstoqueDisponivel` means by it
 * (`limitarEstoque !== false` and a finite positive `quantidade`), and `min` IS
 * that function's answer. Re-deriving either here is how the printed fold and
 * the sent quantity start disagreeing — which is the one thing a human reads
 * this block to check.
 */
export function dobraDeKit(membro: MembroDaFamilia): DobraDeKitDoPlano | null {
  if (!(membro.ehKit || membro.ehKitVirtual)) return null;
  const disponiveis = disponivelByProdutoIdFrom(membro.componentEstoques);
  const componentes = componentesKitEntries(membro.componentesKit).map(
    ([componenteId, kit]): ComponenteDoPlano => {
      const bruto = disponiveis[componenteId];
      return {
        componenteId,
        disponivel: typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null,
        limita:
          kit.limitarEstoque !== false && Number.isFinite(kit.quantidade) && kit.quantidade > 0,
        porKit: kit.quantidade,
      };
    },
  );
  return {
    produtoId: membro.produtoId,
    componentes,
    min: kitEstoqueDisponivel(membro.componentesKit, disponiveis),
  };
}

function modelosDaTarefa(
  tarefa: TarefaDeEstoqueShopee,
  opcoes: OpcoesDoPlano,
): LinhaDeModeloDoPlano[] {
  const pisos = opcoes.pisoPorItem.get(tarefa.itemId);
  const bandaMax = opcoes.bandaPorItem?.get(tarefa.itemId) ?? null;
  return tarefa.modelos.map((m): LinhaDeModeloDoPlano => {
    // ⚠️ `?? null`, never `||`: a floor of 0 is a real answer and is falsy.
    const piso = pisos?.get(m.modelId) ?? null;
    const aplicado = aplicarPiso(m.quantidade, piso);
    return {
      modelId: m.modelId,
      produtoId: m.produtoId,
      quantidade: m.quantidade,
      envia: aplicado.valor,
      piso,
      bandaMax,
      clampeado: pisoAcimaDaBanda(piso, bandaMax)
        ? CLAMPE_DO_PLANO.banda
        : aplicado.clampado
          ? CLAMPE_DO_PLANO.piso
          : CLAMPE_DO_PLANO.nenhum,
    };
  });
}

/**
 * Build the whole dry-run plan from data the script gathered. PURE.
 *
 * ⚠️ It decides nothing the planner already decided: every `motivo` and every
 * `mensagem` below is the one `montarTarefasDeEstoqueShopee` produced, and the
 * only line this function raises on its own is `produto-nao-encontrado`, for a
 * requested anchor discovery did not return — rendered through the same lookup
 * table, so there is still exactly one copy of the wording.
 */
export function montarPlanoDeEnvio(
  entradas: readonly EntradaDoPlano[],
  opcoes: OpcoesDoPlano,
): PlanoDeEnvioEstoque {
  const listagens: ListagemDoPlano[] = [];
  const pulos: PuloDoPlano[] = [];
  let familias = 0;

  for (const entrada of entradas) {
    if (entrada.row === null || entrada.plano === null) {
      const motivo = MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado;
      pulos.push({
        produtoId: entrada.produtoId,
        produtoNome: entrada.produtoNome,
        anuncioId: null,
        modelId: null,
        modelosAfetados: null,
        motivo,
        mensagem: MENSAGEM_POR_MOTIVO[motivo],
        recusa: ehRecusa(motivo),
      });
      continue;
    }
    familias += 1;

    for (const pulo of entrada.plano.pulos) {
      pulos.push({
        produtoId: pulo.produtoId,
        produtoNome: entrada.produtoNome,
        anuncioId: pulo.itemId === null ? null : String(pulo.itemId),
        modelId: pulo.modelId,
        modelosAfetados: pulo.modelosAfetados,
        motivo: pulo.motivo,
        mensagem: pulo.mensagem,
        recusa: ehRecusa(pulo.motivo),
      });
    }

    const membros: readonly MembroDaFamilia[] = [entrada.row.anchor, ...entrada.row.children];
    for (const tarefa of entrada.plano.tarefas) {
      const link = linkDoDocId(entrada.row, tarefa.linkDocId);
      const modelos = modelosDaTarefa(tarefa, opcoes);
      const naTarefa = new Set(modelos.map((m) => m.produtoId));
      const kits: DobraDeKitDoPlano[] = [];
      for (const membro of membros) {
        if (!naTarefa.has(membro.produtoId)) continue;
        const dobra = dobraDeKit(membro);
        if (dobra !== null) kits.push(dobra);
      }
      listagens.push({
        produtoId: tarefa.produtoId,
        produtoNome: entrada.produtoNome,
        anuncioId: String(tarefa.itemId),
        linkDocId: tarefa.linkDocId,
        estadoAnuncio: link === undefined ? null : texto(link.estadoAnuncio),
        kitNativo: link?.kitNativo === true,
        parte: tarefa.parte,
        totalDePartes: tarefa.totalDePartes,
        modelos,
        kits,
        bytes: stockTaskEncodedBodyBytes(tarefa),
      });
    }
  }

  const porMotivo = new Map<MotivoEstoqueShopee, number>();
  for (const p of pulos) porMotivo.set(p.motivo, (porMotivo.get(p.motivo) ?? 0) + 1);
  const totaisPorMotivo = [...porMotivo.entries()]
    .map(
      ([motivo, total]): TotalPorMotivo => ({
        motivo,
        mensagem: MENSAGEM_POR_MOTIVO[motivo],
        recusa: ehRecusa(motivo),
        total,
      }),
    )
    .sort((a, b) => b.total - a.total || a.motivo.localeCompare(b.motivo));

  return {
    integracaoId: opcoes.integracaoId,
    solicitados: entradas.length,
    familias,
    listagens,
    pulos,
    totaisPorMotivo,
    modelos: listagens.reduce((soma, l) => soma + l.modelos.length, 0),
    orcamentoBytes: STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
    avisoBytes: STOCK_TASK_ENCODED_BODY_WARN_BYTES,
  };
}

/* -------------------------------------------------------------------------- */
/*                                the renderers                                */
/* -------------------------------------------------------------------------- */

const TRACO = '—';

function num(v: number | null): string {
  return v === null ? TRACO : String(v);
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

function rotulo(nome: string, valor: string): string {
  return `  ${nome.padEnd(20, '.')} ${valor}`;
}

/** The dry-run report. Every value is read off the plan — nothing is recomputed. */
export function renderizarPlanoDeEnvio(plano: PlanoDeEnvioEstoque): string[] {
  const linhas: string[] = [
    rotulo('integração ', plano.integracaoId),
    rotulo('solicitados ', String(plano.solicitados)),
    rotulo('famílias lidas ', String(plano.familias)),
    rotulo('anúncios no plano ', String(plano.listagens.length)),
    rotulo('modelos no plano ', String(plano.modelos)),
    rotulo(
      'orçamento da task ',
      `${String(plano.orcamentoBytes)} bytes (aviso a partir de ${String(plano.avisoBytes)})`,
    ),
    '',
  ];

  if (plano.listagens.length === 0) {
    linhas.push('### anúncios: NENHUM — nada seria enviado');
  }
  plano.listagens.forEach((l, i) => {
    linhas.push(`### anúncio ${String(i + 1)}/${String(plano.listagens.length)} — ${l.produtoId}`);
    linhas.push(rotulo('produto ', `${l.produtoId} (${l.produtoNome ?? 'sem nome'})`));
    linhas.push(rotulo('anúncio ', l.anuncioId));
    linhas.push(rotulo('vínculo ', l.linkDocId));
    linhas.push(rotulo('estado ', l.estadoAnuncio ?? TRACO));
    linhas.push(rotulo('kit nativo ', simNao(l.kitNativo)));
    linhas.push(rotulo('parte ', `${String(l.parte)}/${String(l.totalDePartes)}`));
    linhas.push(
      rotulo(
        'tamanho ',
        `${String(l.bytes)} bytes${l.bytes > plano.avisoBytes ? ' ⚠️ acima do aviso' : ''}`,
      ),
    );
    linhas.push(`  modelos (${String(l.modelos.length)}):`);
    linhas.push(
      `    ${'model_id'.padEnd(14)}${'produto'.padEnd(24)}${'qtd'.padEnd(8)}${'envia'.padEnd(8)}${'piso'.padEnd(8)}${'banda'.padEnd(8)}clampeado`,
    );
    for (const m of l.modelos) {
      linhas.push(
        `    ${String(m.modelId).padEnd(14)}${m.produtoId.padEnd(24)}${String(m.quantidade).padEnd(8)}${String(
          m.envia,
        ).padEnd(8)}${num(m.piso).padEnd(8)}${num(m.bandaMax).padEnd(8)}${m.clampeado}`,
      );
    }
    for (const kit of l.kits) {
      linhas.push(`  kit ${kit.produtoId} — a conta que produz a quantidade:`);
      for (const c of kit.componentes) {
        linhas.push(
          `    ${c.componenteId.padEnd(24)}disponivel=${num(c.disponivel).padEnd(8)}por kit=${String(
            c.porKit,
          ).padEnd(6)}limita: ${simNao(c.limita)}`,
        );
      }
      linhas.push(`    min = ${num(kit.min)}`);
    }
    linhas.push('');
  });

  linhas.push(
    plano.pulos.length === 0
      ? '### pulos: NENHUM'
      : `### pulos (${String(plano.pulos.length)}) — não seriam enviados`,
  );
  for (const p of plano.pulos) {
    const alvo = p.modelId === null ? '' : ` model=${String(p.modelId)}`;
    const quantos = p.modelosAfetados === null ? '' : ` modelos=${String(p.modelosAfetados)}`;
    linhas.push(
      `  ${p.produtoId.padEnd(24)}${(p.anuncioId ?? TRACO).padEnd(14)}${p.motivo.padEnd(28)}${p.mensagem}${alvo}${quantos}`,
    );
  }

  if (plano.totaisPorMotivo.length > 0) {
    linhas.push('');
    linhas.push('### totais por motivo');
    for (const t of plano.totaisPorMotivo) {
      linhas.push(
        `  ${t.motivo.padEnd(28)}${String(t.total).padEnd(6)}${t.recusa ? 'recusa' : 'aviso '}  ${t.mensagem}`,
      );
    }
  }
  return linhas;
}

/** The `--json` document for a dry run. An ALLOW-LIST, built by name. */
export function resumoDoPlano(plano: PlanoDeEnvioEstoque): Record<string, unknown> {
  return {
    integracaoId: plano.integracaoId,
    solicitados: plano.solicitados,
    familias: plano.familias,
    modelos: plano.modelos,
    orcamentoBytes: plano.orcamentoBytes,
    avisoBytes: plano.avisoBytes,
    listagens: plano.listagens.map((l) => ({
      produtoId: l.produtoId,
      produtoNome: l.produtoNome,
      anuncioId: l.anuncioId,
      linkDocId: l.linkDocId,
      estadoAnuncio: l.estadoAnuncio,
      kitNativo: l.kitNativo,
      parte: l.parte,
      totalDePartes: l.totalDePartes,
      bytes: l.bytes,
      modelos: l.modelos.map((m) => ({
        modelId: m.modelId,
        produtoId: m.produtoId,
        quantidade: m.quantidade,
        envia: m.envia,
        piso: m.piso,
        bandaMax: m.bandaMax,
        clampeado: m.clampeado,
      })),
      kits: l.kits.map((k) => ({
        produtoId: k.produtoId,
        min: k.min,
        componentes: k.componentes.map((c) => ({
          componenteId: c.componenteId,
          disponivel: c.disponivel,
          limita: c.limita,
          porKit: c.porKit,
        })),
      })),
    })),
    pulos: plano.pulos.map((p) => ({
      produtoId: p.produtoId,
      produtoNome: p.produtoNome,
      anuncioId: p.anuncioId,
      modelId: p.modelId,
      modelosAfetados: p.modelosAfetados,
      motivo: p.motivo,
      mensagem: p.mensagem,
      recusa: p.recusa,
    })),
    totaisPorMotivo: plano.totaisPorMotivo.map((t) => ({
      motivo: t.motivo,
      mensagem: t.mensagem,
      recusa: t.recusa,
      total: t.total,
    })),
  };
}

/**
 * ⚠️ The produto's NAME is a column here, exactly as in
 * {@link linhasDeSemEnvio} below and in the dry-run plan. Both file headers
 * argue it is printed deliberately — "the one thing that lets a human tell one
 * row from another" — and without it the `--live` report was the one of the
 * four surfaces that identified a SENT row by opaque doc id alone.
 */
function linhaDeListagem(l: EnvioEstoqueListing): string {
  return (
    `  ${l.produtoId.padEnd(24)}${(l.produtoNome ?? 'sem nome').padEnd(28)}` +
    `${(l.anuncioId ?? TRACO).padEnd(14)}${l.outcome.padEnd(14)}` +
    `qtd=${num(l.quantidade).padEnd(8)}modelos=${String(l.variacoes.length).padEnd(5)}` +
    `recusados=${String(l.modelosRecusados).padEnd(5)}clampados=${String(l.clampados)}`
  );
}

function linhasDeSemEnvio(p: EnvioEstoqueSemEnvio): string {
  return `  ${p.produtoId.padEnd(24)}${(p.produtoNome ?? 'sem nome').padEnd(28)}${p.motivo.padEnd(28)}${p.mensagem}`;
}

/**
 * The `--live` report.
 *
 * ⚠️ It re-words nothing. `mensagem` arrived rendered on every row and
 * `MENSAGEM_POR_MOTIVO` is total over the vocabulary, so a second wording here
 * would be a copy free to drift from the one the web dialog shows.
 *
 * ⚠️ A CLEAN send carrying a clamp is `outcome: 'enviado'` with
 * `motivo: 'clampado-na-reserva'`. Reading `motivo !== null` as "it failed"
 * reports every clamped send as a failure — the counts below come from the
 * envelope's own `resumo`, which is built from the outcomes.
 */
export function renderizarResultadoEnvio(resposta: EnvioEstoqueResponse): string[] {
  const linhas: string[] = [
    rotulo('integração ', resposta.integracaoId),
    rotulo('conta ', resposta.contaNome ?? TRACO),
    rotulo('solicitados ', String(resposta.solicitados)),
    rotulo('famílias ', String(resposta.familias)),
    rotulo('enviados ', String(resposta.resumo.enviados)),
    rotulo('pulados ', String(resposta.resumo.pulados)),
    rotulo('falhas ', String(resposta.resumo.falhas)),
    rotulo('não tentados ', String(resposta.resumo.naoTentados)),
    rotulo('pausado até ', resposta.pausadoAte ?? TRACO),
    '',
    `### anúncios (${String(resposta.listings.length)})`,
  ];
  for (const l of resposta.listings) {
    linhas.push(linhaDeListagem(l));
    linhas.push(`      ${l.motivo ?? 'limpo'} — ${l.mensagem}`);
    for (const m of l.variacoes) {
      linhas.push(
        `      model ${String(m.modelId).padEnd(14)}${m.produtoId.padEnd(24)}` +
          `pedida=${String(m.quantidadeSolicitada).padEnd(8)}enviada=${num(m.quantidadeEnviada).padEnd(8)}` +
          `${m.resultado.padEnd(14)}${m.clampado ? `clampado piso=${num(m.piso)} ` : ''}${m.codigo ?? ''}`,
      );
    }
  }
  linhas.push('');
  linhas.push(
    resposta.produtosSemEnvio.length === 0
      ? '### produtos sem envio: NENHUM'
      : `### produtos sem envio (${String(resposta.produtosSemEnvio.length)})`,
  );
  for (const p of resposta.produtosSemEnvio) linhas.push(linhasDeSemEnvio(p));
  return linhas;
}

/** The `--json` document for `--live`. An ALLOW-LIST, built by name at BOTH levels. */
export function resumoDoEnvio(resposta: EnvioEstoqueResponse): Record<string, unknown> {
  return {
    canal: resposta.canal,
    integracaoId: resposta.integracaoId,
    contaNome: resposta.contaNome,
    solicitados: resposta.solicitados,
    familias: resposta.familias,
    resumo: {
      enviados: resposta.resumo.enviados,
      pulados: resposta.resumo.pulados,
      falhas: resposta.resumo.falhas,
      naoTentados: resposta.resumo.naoTentados,
    },
    listings: resposta.listings.map((l) => ({
      produtoId: l.produtoId,
      produtoNome: l.produtoNome,
      anuncioId: l.anuncioId,
      linkDocId: l.linkDocId,
      outcome: l.outcome,
      motivo: l.motivo,
      mensagem: l.mensagem,
      quantidade: l.quantidade,
      modelosRecusados: l.modelosRecusados,
      clampados: l.clampados,
      variacoes: l.variacoes.map((m) => ({
        modelId: m.modelId,
        produtoId: m.produtoId,
        varLinkDocId: m.varLinkDocId,
        quantidadeSolicitada: m.quantidadeSolicitada,
        quantidadeEnviada: m.quantidadeEnviada,
        resultado: m.resultado,
        motivo: m.motivo,
        codigo: m.codigo,
        mensagem: m.mensagem,
        clampado: m.clampado,
        piso: m.piso,
      })),
    })),
    produtosSemEnvio: resposta.produtosSemEnvio.map((p) => ({
      produtoId: p.produtoId,
      produtoNome: p.produtoNome,
      motivo: p.motivo,
      mensagem: p.mensagem,
    })),
    pausadoAte: resposta.pausadoAte,
  };
}

/** How many models this envelope says Shopee refused inside accepted calls. */
export function modelosRecusadosDoEnvio(resposta: EnvioEstoqueResponse): number {
  return resposta.listings.reduce(
    (soma, l) => soma + l.variacoes.filter((m) => m.resultado === RESULTADO_MODELO.recusado).length,
    0,
  );
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it — never a
 * payload.
 *
 * ⚠️ The Shopee half is `pedidos/importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented: the CLIs of this app face the same error
 * taxonomy and a second copy of that table is how one of them starts printing a
 * body. Only the ARGUMENT arm and the guard arm are this module's, because the
 * usage text and that class are this module's.
 *
 * ⚠️ `extra` is deliberately NOT printed. It is an untyped bag on the guard
 * class and today holds only `pausadoAte`; the sentence the guard carries
 * already says the conta is paused, and a future key would travel here with
 * nobody having decided it was printable.
 */
export function descreverErroEnvio(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_ENVIAR_ESTOQUE];
  }
  if (err instanceof ShopeeEnvioEstoqueGuardError) {
    return [
      `❌ ShopeeEnvioEstoqueGuardError (${err.code})`,
      `   ${err.message}`,
      '   Nada foi enviado: a recusa é anterior a qualquer chamada à Shopee.',
    ];
  }
  return descreverErro(err);
}

/**
 * Whether a failure is one this surface raises BEFORE any Shopee call.
 *
 * ⚠️ It exists so the script's top-level `catch` and {@link descreverErroEnvio}
 * cannot drift: that function already prints *"Nada foi enviado: a recusa é
 * anterior a qualquer chamada à Shopee"* for the guard class, and the script
 * used to follow it, two lines later, with *"Nada garante que nada foi escrito"*
 * — two sentences contradicting each other about the same failure. One
 * predicate, both readers.
 *
 * The two members: an {@link ArgumentoInvalidoError} (the args never reached
 * Firestore) and a `ShopeeEnvioEstoqueGuardError` (the depósito guard, raised
 * above `createShopClient`, and the route's pause pre-check). Everything else —
 * including every Shopee class — may have landed a write.
 */
export function ehRecusaAntesDaShopee(err: unknown): boolean {
  return err instanceof ArgumentoInvalidoError || err instanceof ShopeeEnvioEstoqueGuardError;
}
