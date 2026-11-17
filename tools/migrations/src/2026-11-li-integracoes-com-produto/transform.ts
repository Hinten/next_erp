import {
  INTEGRACAO_TIPO,
  anuncioShopeeVivo,
  contaDoLinkLi,
  contaDoLinkMercadoLivre,
  contaDoLinkShopee,
  contaIdFromRef,
  linkHasLiveListing,
  variacaoLinkHasListing,
  vinculoLiConta,
} from '@delfrance/schemas';

/**
 * Pure decisions for the Loja Integrada anchor census: which produtos holding a
 * `produtolojaintegrada` link are missing that link's conta from
 * `produtos.integracoesComProduto`. No Firestore here; the I/O is `migrate.ts`.
 * Runbook: `tools/migrations/li-integracoes-com-produto.README.md`.
 *
 * ## Why the anchor can be missing a conta
 *
 * The array is the pre-filter every marketplace stock and price sweep opens with
 * (`paiId == null AND integracoesComProduto array-contains <conta>`), so a conta
 * missing from it is a produto that conta's sweeps never visit: a silent stock
 * and price outage. The link triggers keep it in step with the link docs, but a
 * Firestore import fires no triggers for any channel, so after the production
 * data moves nothing derives it on arrival. This census finds the gaps; the
 * `--apply` leg adds the Loja Integrada ones.
 *
 * ## The rule, and where each half comes from
 *
 * A conta belongs on the produto **whose own subcollection holds the link**. It
 * never hops to a parent or a child, which is every link trigger's rule.
 *
 * - **Loja Integrada (gated, applied).** A link counts when `vinculoLiConta`
 *   says so, and its conta is `contaDoLinkLi`, both from `@delfrance/schemas`:
 *   the SAME two readers the anchor trigger plans with and the shared survivor
 *   read (`sobrevivemVinculosDoProdutoLi`) re-checks inside the core's guarded
 *   add. One copy of each rule, so a gap this file reports is a gap that add
 *   confirms, and a re-run converges.
 * - **Mercado Livre and Shopee (report only).** `linkHasLiveListing` /
 *   `variacaoLinkHasListing` with `contaDoLinkMercadoLivre`, and
 *   `anuncioShopeeVivo` with `contaDoLinkShopee`, all imported. Their own window
 *   scripts repair them: a Mercado Livre add here could be undone by the Mercado
 *   Livre reconcile's remove, and the two scripts would flip the array back and
 *   forth. A variation link reads its OWN `contaOuterRef` only; one without it is
 *   `ml-variacao-sem-conta`, the Mercado Livre reconcile's backfill to fix.
 * - Amazon, Magalu and Facebook links are not read at all.
 *
 * ## The conta filter
 *
 * A gap (`*-ausente`), and so an add, names a conta only when the link's conta
 * reads as an existing `integracao` doc of THAT channel's `tipo` (strict `===` on
 * the stored number). Every other reading is its own ungated class, so nothing is
 * dropped without a row: a counting link whose ref reads as no conta at all is
 * `*-conta-ilegivel`, one whose conta doc is gone is `*-conta-inexistente`, one
 * naming another channel's conta is `*-conta-de-outro-tipo`. Those rows still
 * carry the conta id the link names, when one reads. ⚠️ The tipo check is
 * load-bearing: an id of another tipo added here because a Loja Integrada link
 * names it would be removed by that channel's own reconcile.
 *
 * ## No fold on the stored side
 *
 * Membership is `Array.isArray(stored) && stored.includes(contaId)`: the exact
 * `array-contains` the sweeps run. So `' C1'` and `'integracao/C1'` in the array
 * do NOT hold `C1`, and the produto is reported `li-ausente`. The path-shaped
 * entry is ALSO reported (`entrada-em-forma-de-caminho`): inert for every sweep,
 * and left in place, because this census never removes an id.
 *
 * ## The gate
 *
 * `li-ausente + li-campo-invalido = 0`, printed beside the counts that prove it
 * was evaluated (`contas-li`, `vinculos-que-contam`). Zero of either is a
 * REFUSAL ({@link MotivoDeRecusa}), never a `0 0`: on the wrong project, the wrong
 * database or an incomplete import every count reads zero, and a gate that opens
 * valves must not read that as a pass. Every other class prints a count and gates
 * nothing.
 *
 * ## Two report-only classes about the order import
 *
 * The walk already holds every link, so these cost no read:
 * - `li-id-texto`: a link that counts while its `id` is stored as TEXT
 *   (`typeof id === 'string' && vinculoLiConta(link)`). It keeps its conta in the
 *   anchor, but the order import looks links up by the NUMBER `id`, and its text
 *   matches nothing there.
 * - `li-dono-duplicado`: two existing produtos holding a link with the same
 *   `(contaDoLinkLi, stored number id)`, the order import's own type-strict key.
 *   That import answers "ambiguous" for the store product and binds no line. It
 *   reads no `removido`, so a trashed link is an owner here too; an owner whose
 *   produto doc is gone counts for nothing, as it does there. A text `id` is never
 *   part of this key: that link is `li-id-texto`. One row per store product, at its
 *   first owner's path, so one produto can carry several.
 */

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                    */
/* -------------------------------------------------------------------------- */

/** One `integracao` doc, read masked to `tipo`. */
export interface ContaLida {
  readonly id: string;
  readonly tipo: unknown;
}

/** One link doc: its full document path and its (masked) stored fields. */
export interface VinculoLido {
  readonly caminho: string;
  readonly dados: Record<string, unknown>;
}

/** One produto point read, masked to `integracoesComProduto` + `paiId`. */
export interface ProdutoLido {
  readonly existe: boolean;
  /** The stored field as read: `undefined` when absent. */
  readonly integracoesComProduto: unknown;
  readonly paiId: unknown;
}

/** A produto's OWN Mercado Livre and Shopee link docs (never `variashopee`). */
export interface VinculosDeOutrosCanais {
  readonly produtoMercadoLivre: readonly VinculoLido[];
  readonly variacaoMercadoLivre: readonly VinculoLido[];
  readonly prodshopee: readonly VinculoLido[];
}

export interface EntradaDoCenso {
  readonly contas: readonly ContaLida[];
  /** Every `produtolojaintegrada` doc the walk returned. */
  readonly vinculosLi: readonly VinculoLido[];
  /** Produto id → its point read, for every id {@link produtosDosVinculosLi} named. */
  readonly produtos: ReadonlyMap<string, ProdutoLido>;
  /** Produto id → its other-channel links, for every produto that exists. */
  readonly outrosCanais: ReadonlyMap<string, VinculosDeOutrosCanais>;
}

/* -------------------------------------------------------------------------- */
/*                                  Outputs                                    */
/* -------------------------------------------------------------------------- */

/** Every finding the census can report. */
export const CLASSE = {
  liAusente: 'li-ausente',
  liCampoInvalido: 'li-campo-invalido',
  liContaInexistente: 'li-conta-inexistente',
  liContaDeOutroTipo: 'li-conta-de-outro-tipo',
  liContaIlegivel: 'li-conta-ilegivel',
  liProdutoAusente: 'li-produto-ausente',
  liCaminhoInesperado: 'li-caminho-inesperado',
  liRaizSemVinculo: 'li-raiz-sem-vinculo',
  liIdTexto: 'li-id-texto',
  liDonoDuplicado: 'li-dono-duplicado',
  entradaEmFormaDeCaminho: 'entrada-em-forma-de-caminho',
  mlAusente: 'ml-ausente',
  mlVariacaoAusente: 'ml-variacao-ausente',
  mlVariacaoSemConta: 'ml-variacao-sem-conta',
  mlContaIlegivel: 'ml-conta-ilegivel',
  mlContaInexistente: 'ml-conta-inexistente',
  mlContaDeOutroTipo: 'ml-conta-de-outro-tipo',
  shopeeAusente: 'shopee-ausente',
  shopeeContaIlegivel: 'shopee-conta-ilegivel',
  shopeeContaInexistente: 'shopee-conta-inexistente',
  shopeeContaDeOutroTipo: 'shopee-conta-de-outro-tipo',
} as const;
export type Classe = (typeof CLASSE)[keyof typeof CLASSE];

/** Which channel a finding is about; `ancora` is the array itself. */
export type Canal = 'li' | 'ml' | 'shopee' | 'ancora';

export interface Achado {
  readonly classe: Classe;
  readonly canal: Canal;
  /** A produto path (`produtos/<id>`) or a link doc path. */
  readonly caminho: string;
  /** The JSONL row's `field`. */
  readonly campo: string;
  /** The conta id the finding is about, or `null` when no conta reads. */
  readonly contaId: string | null;
  /** The JSONL row's value: stored fields only, never a name. */
  readonly valor: unknown;
}

/** One guarded add the `--apply` leg runs: a Loja Integrada conta onto a produto. */
export interface Adicao {
  readonly produtoId: string;
  readonly contaId: string;
}

/** Why the census refuses to report a gate at all. */
export type MotivoDeRecusa = 'sem-contas-li' | 'sem-vinculos-que-contam';

export interface Gate {
  readonly ausente: number;
  readonly campoInvalido: number;
  /** Existing `integracao` docs of the Loja Integrada tipo. */
  readonly contasLi: number;
  /**
   * Counting links of a Loja Integrada conta, at a well-formed path, under a produto that
   * exists: the links the gate actually judged against an array.
   */
  readonly vinculosQueContam: number;
  /** Existing produtos holding at least one `produtolojaintegrada` doc. */
  readonly produtos: number;
  /** Shown as a WARNING beside the gate: a bulk count here is links of a re-created conta. */
  readonly contaInexistente: number;
  readonly recusa: MotivoDeRecusa | null;
}

export interface ResultadoDoCenso {
  /** Sorted by path, then conta, then class: two runs over the same data are identical. */
  readonly achados: readonly Achado[];
  /** The `li-ausente` pairs, sorted by produto then conta. Loja Integrada contas only. */
  readonly plano: readonly Adicao[];
  readonly gate: Gate;
  /** Every Loja Integrada conta, sorted, with its {@link Gate.vinculosQueContam} share. */
  readonly vinculosPorConta: ReadonlyArray<readonly [string, number]>;
}

/* -------------------------------------------------------------------------- */
/*                                  Readers                                    */
/* -------------------------------------------------------------------------- */

/** The produto collection and the Loja Integrada link leaf. */
const PRODUTOS = 'produtos';
const GRUPO_LI = 'produtolojaintegrada';

/**
 * The produto a Loja Integrada link doc belongs to, from its path, or `null`.
 *
 * Exactly `produtos/<id>/produtolojaintegrada/<doc>`, the only place a link
 * lives. A nested path (the leaf under some other subcollection) or a foreign
 * root is `li-caminho-inesperado`, never guessed at.
 */
export function produtoDoCaminhoLi(caminho: string): string | null {
  const segs = caminho.split('/');
  if (segs.length !== 4) return null;
  const [raiz, produtoId, folha, docId] = segs;
  if (raiz !== PRODUTOS || folha !== GRUPO_LI) return null;
  if (!produtoId || !docId) return null;
  return produtoId;
}

/** Every produto id the walked links name, unique and sorted: what read 3 point-reads. */
export function produtosDosVinculosLi(vinculos: readonly VinculoLido[]): string[] {
  const ids = new Set<string>();
  for (const v of vinculos) {
    const id = produtoDoCaminhoLi(v.caminho);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort(comparar);
}

/** Conta id → stored `tipo`. */
export function mapaDeContas(contas: readonly ContaLida[]): Map<string, unknown> {
  return new Map(contas.map((c) => [c.id, c.tipo] as const));
}

/** The Loja Integrada contas, sorted. Empty ⇒ the census refuses (`sem-contas-li`). */
export function contasLojaIntegrada(contas: readonly ContaLida[]): string[] {
  return contas
    .filter((c) => c.tipo === INTEGRACAO_TIPO.lojaIntegrada)
    .map((c) => c.id)
    .sort(comparar);
}

/** Only a non-empty string names a parent; anything else is "no parent". */
function raizDe(paiId: unknown, produtoId: string): string | null {
  return typeof paiId === 'string' && paiId !== '' && paiId !== produtoId ? paiId : null;
}

/** A stored number id the order import could look up: a positive safe integer. */
function idNumericoDoVinculo(id: unknown): number | null {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Codepoint order, never locale order: the output must not depend on the machine. */
function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Does the stored array hold this conta id, exactly as `array-contains` would? */
function arrayContem(armazenado: unknown, contaId: string): boolean {
  return Array.isArray(armazenado) && armazenado.includes(contaId);
}

/** Absent, `null` or an array: the shapes an `arrayUnion` adds to without overwriting. */
function campoAceitaUniao(armazenado: unknown): boolean {
  return armazenado === undefined || armazenado === null || Array.isArray(armazenado);
}

/* -------------------------------------------------------------------------- */
/*                                The census                                   */
/* -------------------------------------------------------------------------- */

/** How a counting link's conta reads against the conta map, for one channel's tipo. */
type VereditoDaConta =
  | { readonly tipo: 'valida'; readonly contaId: string }
  | { readonly tipo: 'ilegivel' }
  | { readonly tipo: 'inexistente'; readonly contaId: string }
  | { readonly tipo: 'outro-tipo'; readonly contaId: string; readonly tipoDaConta: unknown };

function julgarConta(
  contaId: string | null,
  contas: ReadonlyMap<string, unknown>,
  tipoDoCanal: number,
): VereditoDaConta {
  if (contaId === null) return { tipo: 'ilegivel' };
  if (!contas.has(contaId)) return { tipo: 'inexistente', contaId };
  const tipoDaConta = contas.get(contaId);
  if (tipoDaConta !== tipoDoCanal) return { tipo: 'outro-tipo', contaId, tipoDaConta };
  return { tipo: 'valida', contaId };
}

/**
 * Collects findings, one per (class, path, conta, discriminator), and sorts them once at the end.
 *
 * The discriminator separates two findings that share a class, a path and a conta but are about
 * different things: two `li-dono-duplicado` groups whose first owner is the same produto sit at
 * that produto's path, and only the store id tells them apart. Without it the second group would
 * be dropped with no row and no count. It is also the last sort key, so their order never depends
 * on the order the links were walked in.
 */
class Coletor {
  private readonly porChave = new Map<string, { achado: Achado; discriminador: string }>();

  add(achado: Achado, discriminador = ''): void {
    const chave = [achado.classe, achado.caminho, achado.contaId ?? '', discriminador].join(
      '\u0000',
    );
    if (!this.porChave.has(chave)) this.porChave.set(chave, { achado, discriminador });
  }

  ordenados(): Achado[] {
    return [...this.porChave.values()]
      .sort(
        (a, b) =>
          comparar(a.achado.caminho, b.achado.caminho) ||
          comparar(a.achado.contaId ?? '', b.achado.contaId ?? '') ||
          comparar(a.achado.classe, b.achado.classe) ||
          comparar(a.discriminador, b.discriminador),
      )
      .map((e) => e.achado);
  }
}

/** A store id as a discriminator: zero-padded, so codepoint order is numeric order. */
function discriminadorDoId(id: number): string {
  return String(id).padStart(String(Number.MAX_SAFE_INTEGER).length, '0');
}

/** The stored link fields a finding's value carries. */
function valorDoVinculoLi(dados: Record<string, unknown>): Record<string, unknown> {
  return {
    contaLojaIntegrada: dados.contaLojaIntegrada ?? null,
    id: dados.id ?? null,
    removido: dados.removido ?? null,
  };
}

/** The refusal for a corpus that cannot be judged, or `null`. */
export function motivoDeRecusa(contasLi: number, vinculosQueContam: number): MotivoDeRecusa | null {
  if (contasLi === 0) return 'sem-contas-li';
  if (vinculosQueContam === 0) return 'sem-vinculos-que-contam';
  return null;
}

/** The first refusal, decidable from the contas alone, before the walk is paid for. */
export function recusaSemContasLi(contas: readonly ContaLida[]): MotivoDeRecusa | null {
  return contasLojaIntegrada(contas).length === 0 ? 'sem-contas-li' : null;
}

/** Does the gate pass? Only with `0 0`, and only when it was evaluated at all. */
export function gatePassa(gate: Gate): boolean {
  return gate.recusa === null && gate.ausente === 0 && gate.campoInvalido === 0;
}

/** The census over one corpus. Pure and total. */
export function censar(entrada: EntradaDoCenso): ResultadoDoCenso {
  const contas = mapaDeContas(entrada.contas);
  const contasLi = contasLojaIntegrada(entrada.contas);
  const achados = new Coletor();

  /** produto id → Loja Integrada conta ids it holds a counting link of. */
  const contasLiDoProduto = new Map<string, Set<string>>();
  const vinculosPorConta = new Map<string, number>(contasLi.map((c) => [c, 0] as const));
  /** (conta, number id) → produtos owning a link with that key. */
  const donos = new Map<string, { contaId: string; id: number; produtos: Set<string> }>();
  let vinculosQueContam = 0;
  let contaInexistente = 0;

  /* -- 1. Every walked link ------------------------------------------------- */
  for (const v of entrada.vinculosLi) {
    const produtoId = produtoDoCaminhoLi(v.caminho);
    if (produtoId === null) {
      achados.add({
        classe: CLASSE.liCaminhoInesperado,
        canal: 'li',
        caminho: v.caminho,
        campo: 'caminho',
        contaId: contaDoLinkLi(v.dados),
        valor: valorDoVinculoLi(v.dados),
      });
      continue;
    }
    if (entrada.produtos.get(produtoId)?.existe !== true) {
      achados.add({
        classe: CLASSE.liProdutoAusente,
        canal: 'li',
        caminho: v.caminho,
        campo: 'produto',
        contaId: contaDoLinkLi(v.dados),
        valor: valorDoVinculoLi(v.dados),
      });
      continue;
    }

    const conta = julgarConta(contaDoLinkLi(v.dados), contas, INTEGRACAO_TIPO.lojaIntegrada);

    // The order import's key reads no `removido`, so every link is a candidate owner.
    const idNumerico = idNumericoDoVinculo(v.dados.id);
    if (conta.tipo === 'valida' && idNumerico !== null) {
      const chave = `${conta.contaId}\u0000${idNumerico}`;
      let dono = donos.get(chave);
      if (!dono) {
        dono = { contaId: conta.contaId, id: idNumerico, produtos: new Set() };
        donos.set(chave, dono);
      }
      dono.produtos.add(produtoId);
    }

    if (!vinculoLiConta(v.dados)) continue;

    if (typeof v.dados.id === 'string') {
      achados.add({
        classe: CLASSE.liIdTexto,
        canal: 'li',
        caminho: v.caminho,
        campo: 'id',
        contaId: conta.tipo === 'ilegivel' ? null : conta.contaId,
        valor: valorDoVinculoLi(v.dados),
      });
    }

    switch (conta.tipo) {
      case 'ilegivel':
        achados.add({
          classe: CLASSE.liContaIlegivel,
          canal: 'li',
          caminho: v.caminho,
          campo: 'contaLojaIntegrada',
          contaId: null,
          valor: valorDoVinculoLi(v.dados),
        });
        break;
      case 'inexistente':
        contaInexistente += 1;
        achados.add({
          classe: CLASSE.liContaInexistente,
          canal: 'li',
          caminho: v.caminho,
          campo: 'contaLojaIntegrada',
          contaId: conta.contaId,
          valor: valorDoVinculoLi(v.dados),
        });
        break;
      case 'outro-tipo':
        achados.add({
          classe: CLASSE.liContaDeOutroTipo,
          canal: 'li',
          caminho: v.caminho,
          campo: 'contaLojaIntegrada',
          contaId: conta.contaId,
          valor: { ...valorDoVinculoLi(v.dados), tipoDaConta: conta.tipoDaConta ?? null },
        });
        break;
      case 'valida': {
        vinculosQueContam += 1;
        vinculosPorConta.set(conta.contaId, (vinculosPorConta.get(conta.contaId) ?? 0) + 1);
        let doProduto = contasLiDoProduto.get(produtoId);
        if (!doProduto) contasLiDoProduto.set(produtoId, (doProduto = new Set()));
        doProduto.add(conta.contaId);
        break;
      }
    }
  }

  /* -- 2. Produtos with more than one owner of one store product ------------ */
  for (const dono of donos.values()) {
    if (dono.produtos.size < 2) continue;
    const produtos = [...dono.produtos].sort(comparar);
    // One row per store product: two groups can share their first owner, and so this path.
    achados.add(
      {
        classe: CLASSE.liDonoDuplicado,
        canal: 'li',
        caminho: `${PRODUTOS}/${produtos[0]!}`,
        campo: 'id',
        contaId: dono.contaId,
        valor: { id: dono.id, produtos },
      },
      discriminadorDoId(dono.id),
    );
  }

  /* -- 3. Every existing produto holding a Loja Integrada link -------------- */
  const plano: Adicao[] = [];
  let ausente = 0;
  let campoInvalido = 0;
  const produtosLi = [...entrada.produtos.entries()]
    .filter(([, p]) => p.existe)
    .map(([id]) => id)
    .sort(comparar);

  for (const produtoId of produtosLi) {
    const produto = entrada.produtos.get(produtoId)!;
    const caminho = `${PRODUTOS}/${produtoId}`;
    const armazenado = produto.integracoesComProduto;
    const valorArmazenado = armazenado ?? null;

    // 3a. The gated half: each Loja Integrada conta this produto's own links count for.
    const raiz = raizDe(produto.paiId, produtoId);
    for (const contaId of [...(contasLiDoProduto.get(produtoId) ?? [])].sort(comparar)) {
      if (!campoAceitaUniao(armazenado)) {
        campoInvalido += 1;
        achados.add({
          classe: CLASSE.liCampoInvalido,
          canal: 'li',
          caminho,
          campo: 'integracoesComProduto',
          contaId,
          valor: valorArmazenado,
        });
      } else if (!arrayContem(armazenado, contaId)) {
        ausente += 1;
        plano.push({ produtoId, contaId });
        achados.add({
          classe: CLASSE.liAusente,
          canal: 'li',
          caminho,
          campo: 'integracoesComProduto',
          contaId,
          valor: valorArmazenado,
        });
      }

      // A root-anchored sweep visits a family through its root only.
      if (
        raiz !== null &&
        !(entrada.produtos.get(raiz)?.existe === true && contasLiDoProduto.get(raiz)?.has(contaId))
      ) {
        achados.add({
          classe: CLASSE.liRaizSemVinculo,
          canal: 'li',
          caminho,
          campo: 'paiId',
          contaId,
          valor: { raiz },
        });
      }
    }

    // 3b. Path-shaped entries: inert for every sweep, reported, never touched.
    if (Array.isArray(armazenado)) {
      for (const elemento of armazenado) {
        const contaDaEntrada = contaIdFromRef(elemento);
        if (contaDaEntrada === null) continue;
        achados.add({
          classe: CLASSE.entradaEmFormaDeCaminho,
          canal: 'ancora',
          caminho,
          campo: 'integracoesComProduto',
          contaId: contaDaEntrada,
          valor: elemento,
        });
      }
    }

    // 3c. The other channels, report only.
    const outros = entrada.outrosCanais.get(produtoId);
    if (outros) avaliarOutrosCanais(outros, caminho, armazenado, contas, achados);
  }

  const recusa = motivoDeRecusa(contasLi.length, vinculosQueContam);
  return {
    achados: achados.ordenados(),
    plano: plano.sort(
      (a, b) => comparar(a.produtoId, b.produtoId) || comparar(a.contaId, b.contaId),
    ),
    gate: {
      ausente,
      campoInvalido,
      contasLi: contasLi.length,
      vinculosQueContam,
      produtos: produtosLi.length,
      contaInexistente,
      recusa,
    },
    vinculosPorConta: [...vinculosPorConta.entries()].sort((a, b) => comparar(a[0], b[0])),
  };
}

/** One other-channel link kind: how it counts, where its conta lives, and its classes. */
interface RegraDeOutroCanal {
  readonly canal: Canal;
  readonly tipo: number;
  /** The channel's conta reader, from `@delfrance/schemas`. */
  readonly lerConta: (link: Record<string, unknown>) => string | null;
  /** The field that reader reads, for the finding's row. */
  readonly campoDaConta: string;
  /** The channel's counts predicate, from `@delfrance/schemas`. */
  readonly conta: (link: Record<string, unknown>) => boolean;
  readonly ausente: Classe;
  readonly ilegivel: Classe;
  readonly inexistente: Classe;
  readonly outroTipo: Classe;
}

const REGRAS: ReadonlyArray<readonly [keyof VinculosDeOutrosCanais, RegraDeOutroCanal]> = [
  [
    'produtoMercadoLivre',
    {
      canal: 'ml',
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      lerConta: contaDoLinkMercadoLivre,
      campoDaConta: 'contaOuterRef',
      conta: linkHasLiveListing,
      ausente: CLASSE.mlAusente,
      ilegivel: CLASSE.mlContaIlegivel,
      inexistente: CLASSE.mlContaInexistente,
      outroTipo: CLASSE.mlContaDeOutroTipo,
    },
  ],
  [
    'variacaoMercadoLivre',
    {
      canal: 'ml',
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      lerConta: contaDoLinkMercadoLivre,
      campoDaConta: 'contaOuterRef',
      conta: variacaoLinkHasListing,
      ausente: CLASSE.mlVariacaoAusente,
      ilegivel: CLASSE.mlVariacaoSemConta,
      inexistente: CLASSE.mlContaInexistente,
      outroTipo: CLASSE.mlContaDeOutroTipo,
    },
  ],
  [
    'prodshopee',
    {
      canal: 'shopee',
      tipo: INTEGRACAO_TIPO.shopee,
      lerConta: contaDoLinkShopee,
      campoDaConta: 'contaProdutoShopeeOuterRef',
      conta: anuncioShopeeVivo,
      ausente: CLASSE.shopeeAusente,
      ilegivel: CLASSE.shopeeContaIlegivel,
      inexistente: CLASSE.shopeeContaInexistente,
      outroTipo: CLASSE.shopeeContaDeOutroTipo,
    },
  ],
];

function avaliarOutrosCanais(
  outros: VinculosDeOutrosCanais,
  caminho: string,
  armazenado: unknown,
  contas: ReadonlyMap<string, unknown>,
  achados: Coletor,
): void {
  for (const [subcolecao, regra] of REGRAS) {
    for (const v of outros[subcolecao]) {
      if (!regra.conta(v.dados)) continue;
      const conta = julgarConta(regra.lerConta(v.dados), contas, regra.tipo);
      const valor = { [regra.campoDaConta]: v.dados[regra.campoDaConta] ?? null };
      switch (conta.tipo) {
        case 'ilegivel':
          achados.add({
            classe: regra.ilegivel,
            canal: regra.canal,
            caminho: v.caminho,
            campo: regra.campoDaConta,
            contaId: null,
            valor,
          });
          break;
        case 'inexistente':
          achados.add({
            classe: regra.inexistente,
            canal: regra.canal,
            caminho: v.caminho,
            campo: regra.campoDaConta,
            contaId: conta.contaId,
            valor,
          });
          break;
        case 'outro-tipo':
          achados.add({
            classe: regra.outroTipo,
            canal: regra.canal,
            caminho: v.caminho,
            campo: regra.campoDaConta,
            contaId: conta.contaId,
            valor: { ...valor, tipoDaConta: conta.tipoDaConta ?? null },
          });
          break;
        case 'valida':
          if (!arrayContem(armazenado, conta.contaId)) {
            achados.add({
              classe: regra.ausente,
              canal: regra.canal,
              caminho,
              campo: 'integracoesComProduto',
              contaId: conta.contaId,
              valor: armazenado ?? null,
            });
          }
          break;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Summary                                    */
/* -------------------------------------------------------------------------- */

/**
 * The gate line of a refusal: `NAO-AVALIADO`, never `0 0`. `vinculosQueContam` is `null` when
 * the refusal came before the walk.
 */
export function linhaDeRecusa(
  motivo: MotivoDeRecusa,
  contasLi: number,
  vinculosQueContam: number | null,
): string {
  const vinculos = vinculosQueContam === null ? '' : ` vinculos-que-contam=${vinculosQueContam}`;
  return `GATE li: NAO-AVALIADO ${motivo} contas-li=${contasLi}${vinculos}`;
}

/** The one gate line the runbook reads. A refusal never prints `0 0`. */
export function linhaDoGate(gate: Gate): string {
  if (gate.recusa !== null) {
    return linhaDeRecusa(gate.recusa, gate.contasLi, gate.vinculosQueContam);
  }
  return (
    `GATE li: ausente=${gate.ausente} campo-invalido=${gate.campoInvalido} ` +
    `contas-li=${gate.contasLi} vinculos-que-contam=${gate.vinculosQueContam} ` +
    `produtos=${gate.produtos} => ${gatePassa(gate) ? 'PASSA' : 'BLOQUEIA'}`
  );
}

/** Counts per (channel, conta, class), sorted: the summary table's rows. */
export function contagemPorConta(
  achados: readonly Achado[],
): Array<{ canal: Canal; contaId: string | null; classe: Classe; n: number }> {
  const porChave = new Map<
    string,
    { canal: Canal; contaId: string | null; classe: Classe; n: number }
  >();
  for (const a of achados) {
    const chave = `${a.canal}\u0000${a.contaId ?? ''}\u0000${a.classe}`;
    const linha = porChave.get(chave);
    if (linha) linha.n += 1;
    else porChave.set(chave, { canal: a.canal, contaId: a.contaId, classe: a.classe, n: 1 });
  }
  return [...porChave.values()].sort(
    (a, b) =>
      comparar(a.canal, b.canal) ||
      comparar(a.contaId ?? '', b.contaId ?? '') ||
      comparar(a.classe, b.classe),
  );
}
