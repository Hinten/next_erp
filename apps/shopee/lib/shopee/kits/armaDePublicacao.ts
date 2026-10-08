/**
 * **The publish dispatcher** (step 19, #1527 — reconcile §2.5.1, L9, L10): which
 * applier ONE publish of ONE produto on ONE conta reaches.
 *
 * Pure. It reads NOTHING: the entry point (`anuncios/publicarShopee.ts`) reads
 * the produto and the conta's `prodshopee` links ONCE and hands them here, so
 * the route, the `--live` CLI and the dry run all address the listing this one
 * function names — never a listing some later resolver re-picks.
 *
 * ## The links, partitioned
 *
 * - **N** — live native kits: `ehKitNativoAtivo` (`@delfrance/schemas`, the ONE
 *   predicate: `kitNativo === true`, not `removido`, not superseded, an
 *   addressable `item_id`).
 * - **X** — every other native-kit link (`kitNativo === true`): removed or
 *   superseded. (A native link with no addressable `item_id` lands here too; L9
 *   leaves none behind, and it is never published to.)
 * - **O** — live ORDINARY listings: `kitNativo !== true`, not `removido`, not
 *   superseded.
 * - **RO** — removed ordinary listings that were NOT superseded.
 * - **SO** — superseded ordinary listings, removed or not (L10-R5): a converted
 *   listing Lucas later deleted is removed AND superseded, and it stays SO, so
 *   publish skips it like every superseded link. O, RO and SO partition the
 *   ordinary links.
 *
 * ## The rules, first match wins
 *
 * - **(−1)** `paiId !== null` ⇒ `produto-e-filho` (step 11's sentence): a
 *   família-de-um MEMBER and a family child carry the mirrored `ehKitVirtual`, so
 *   without this rule they would reach rule (5).
 * - **(1) `converterEmKit`** (L8): `ehKit !== true` ⇒ `converter-sem-kit`. A named
 *   link: in O ⇒ `kit-converter` on it; in SO ⇒ `vinculo-substituido`; anything
 *   else ⇒ `converter-sem-anuncio-comum`. Unnamed: O non-empty ⇒ `kit-converter`
 *   on step 11's lexically-first pick over O (two live ordinary listings are NOT
 *   refused, L10(3)); else exactly one N ⇒ `ja-e-kit-nativo` (the re-run of a
 *   finished conversion); 2+ N ⇒ `vinculos-ambiguos`; else
 *   `converter-sem-anuncio-comum`. A live native kit BESIDE the ordinary listing
 *   is not refused: it is the resume of an interrupted conversion, and the
 *   applier's ensure step decides.
 * - **(2) a named `linkDocId`**: absent from the conta ⇒ the item arm on that id
 *   (its 404, as on main). A native link in N ⇒ `kit-recriar` with `recriar`,
 *   else `kit-atualizar`; in X ⇒ `kit-recriar` with `recriar` (on a superseded
 *   kit that is the retry of a delete that did not take), else
 *   `vinculo-substituido` (superseded) or the kit `listagem-removida`. An
 *   ordinary link: SO ⇒ `vinculo-substituido`; else the item arm on it (a
 *   removed one answers step 11's `listagem-removida`, as on main).
 * - **(3)** exactly one N ⇒ `kit-atualizar` on it; 2+ N ⇒ `vinculos-ambiguos`
 *   naming them (native ambiguity refuses, L10(3)).
 * - **(4)** O non-empty ⇒ the item arm on **step 11's pick, in step 11's
 *   ORDER** (L10(3)): `escolherLink` over the NON-superseded ordinary links
 *   (O ∪ RO) — for a produto with no native-kit link and no superseded link
 *   (every non-kit produto) exactly the rows and the id step 11's publish
 *   resolver (`resolverLinkPorProduto`) picks over the same conta read, so a
 *   removed listing that sorts first still answers `listagem-removida`.
 *   ⚠️ That conta read is not main's: it folds both stored conta encodings
 *   (`lerVinculosDaConta`), so a link in the legacy bare encoding is a candidate
 *   here where main never saw it (OP-27). The ORDER is unchanged; the candidate
 *   SET grew.
 * - **(5) no live link**: `ehKitVirtual === true` with `ehKit !== true` ⇒
 *   `kit-virtual-sem-kit`; `ehKitVirtualEfetivo` ⇒ `kit-criar` (a FIRST create;
 *   every removed/superseded link is left as it is, L0); else X ⇒ the kit
 *   `listagem-removida` naming the newest removed one; RO ⇒ the item arm on
 *   `escolherLink(RO)` (⇒ `listagem-removida`, as on main); SO ⇒
 *   `vinculo-substituido`; nothing at all ⇒ the item arm with `linkDocId: null`
 *   (a first ordinary publish).
 *
 * After the arm: `--principal`, `--recriar` or `--converter-em-kit` sent to the
 * ITEM arm ⇒ `opcao-de-kit-em-anuncio-comum` (`principal` on `kit-atualizar` is
 * allowed — compared, never applied, L1).
 *
 * ⚠️ The item arm ALWAYS carries the link id explicitly while the conta has a
 * link: step 11's own resolver stays lexical over EVERY link of the conta (a
 * removed native kit and a superseded listing included), so handing it `null`
 * would let it re-pick a listing this function skipped (M141, M186).
 *
 * ⚠️ Every refusal is spelled through `MOTIVO_PUBLICACAO_BLOQUEADA` and never as
 * a quoted slug: `anuncios/errosPublicacao.test.ts` (O7) reads this file as the
 * producer of the five dispatcher-only members.
 */
import {
  ESTADO_ANUNCIO_SHOPEE,
  ehKitNativoAtivo,
  ehKitVirtualEfetivo,
  ehVinculoSubstituido,
} from '@delfrance/schemas';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  limitarMensagemProblema,
  type MotivoPublicacaoBloqueada,
  type ProblemaDeBloqueio,
} from '../anuncios/errosPublicacao';
import { problemaProdutoEFilho } from '../anuncios/publicarAnuncio';
import { escolherLink } from '../produtos/resolveProduto';
import {
  problemaKitRemovido,
  problemaVinculoSubstituido,
  problemaVinculosAmbiguos,
} from './planoKit';
import type { ArmaDePublicacao, VinculoDaConta } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** What the dispatcher reads off the produto — nothing else. */
export interface ProdutoDoDespacho {
  readonly id: string;
  readonly paiId: string | null;
  readonly ehKit?: unknown;
  readonly ehKitVirtual?: unknown;
}

/** The operator's request, as the body reader (or the CLI) resolved it. */
export interface CorpoDoDespacho {
  readonly linkDocId: string | null;
  readonly recriar: boolean;
  readonly converterEmKit: boolean;
  readonly principal: string | null;
}

/** The dispatcher's answer: the arm, or why no arm applies (zero Shopee calls). */
export type ResultadoDoDespacho =
  | { readonly ok: true; readonly arma: ArmaDePublicacao }
  | { readonly ok: false; readonly problemas: readonly ProblemaDeBloqueio[] };

/* -------------------------------------------------------------------------- */
/*                         The five dispatcher refusals                        */
/* -------------------------------------------------------------------------- */

function bloqueio(
  campo: string | null,
  motivo: MotivoPublicacaoBloqueada,
  mensagem: string,
): ProblemaDeBloqueio {
  return { campo, motivo, mensagem: limitarMensagemProblema(mensagem) };
}

function problemaKitVirtualSemKit(produtoId: string): ProblemaDeBloqueio {
  return bloqueio(
    'ehKitVirtual',
    MOTIVO_PUBLICACAO_BLOQUEADA.kitVirtualSemKit,
    `o produto ${produtoId} está marcado como kit virtual, mas «É kit» está desligado — ligue ` +
      '«É kit» e informe os componentes, ou desligue «É kit virtual»',
  );
}

function problemaConverterSemAnuncioComum(): ProblemaDeBloqueio {
  return bloqueio(
    'linkDocId',
    MOTIVO_PUBLICACAO_BLOQUEADA.converterSemAnuncioComum,
    'não há anúncio comum ativo deste produto nesta conta para converter em kit nativo',
  );
}

function problemaConverterSemKit(produtoId: string): ProblemaDeBloqueio {
  return bloqueio(
    'ehKit',
    MOTIVO_PUBLICACAO_BLOQUEADA.converterSemKit,
    `o produto ${produtoId} não está marcado como kit («É kit») — só um kit com componentes ` +
      'pode ser convertido em kit nativo',
  );
}

function problemaJaEKitNativo(linkDocId: string): ProblemaDeBloqueio {
  return bloqueio(
    'kitNativo',
    MOTIVO_PUBLICACAO_BLOQUEADA.jaEKitNativo,
    `o produto já é kit nativo nesta conta (vínculo ${linkDocId}) e não tem anúncio comum ativo ` +
      'para converter — publique sem --converter-em-kit',
  );
}

function problemaOpcaoDeKitEmAnuncioComum(
  campo: 'principal' | 'recriar' | 'converterEmKit',
): ProblemaDeBloqueio {
  return bloqueio(
    campo,
    MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
    '--principal, --recriar e --converter-em-kit só valem para kit nativo',
  );
}

/* -------------------------------------------------------------------------- */
/*                              Small readers                                 */
/* -------------------------------------------------------------------------- */

function itemIdDe(raw: Record<string, unknown>): number | null {
  const v = raw.item_id;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

function ehRemovido(raw: Record<string, unknown>): boolean {
  return raw.estadoAnuncio === ESTADO_ANUNCIO_SHOPEE.removido;
}

/** UTF-16 code-unit order — `escolherLink`'s own order, never `localeCompare`. */
function compararId(a: VinculoDaConta, b: VinculoDaConta): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** A stored millisecond stamp, or `-Infinity` (an unreadable one sorts OLDEST). */
function modificadoEm(raw: Record<string, unknown>): number {
  const v = raw.ultimaModificacao;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

interface Particao {
  readonly n: readonly VinculoDaConta[];
  readonly x: readonly VinculoDaConta[];
  readonly o: readonly VinculoDaConta[];
  readonly ro: readonly VinculoDaConta[];
  readonly so: readonly VinculoDaConta[];
}

type Classe = keyof Particao;

/** Which of N / X / O / RO / SO one link belongs to — see the module header. */
function classeDe(v: VinculoDaConta): Classe {
  if (v.raw.kitNativo === true) return ehKitNativoAtivo(v.raw) ? 'n' : 'x';
  if (ehVinculoSubstituido(v.raw)) return 'so';
  return ehRemovido(v.raw) ? 'ro' : 'o';
}

function particionar(vinculos: readonly VinculoDaConta[]): Particao {
  const ordenados = [...vinculos].sort(compararId);
  return {
    n: ordenados.filter((v) => classeDe(v) === 'n'),
    x: ordenados.filter((v) => classeDe(v) === 'x'),
    o: ordenados.filter((v) => classeDe(v) === 'o'),
    ro: ordenados.filter((v) => classeDe(v) === 'ro'),
    so: ordenados.filter((v) => classeDe(v) === 'so'),
  };
}

/**
 * STEP 11's pick — `escolherLink` itself (`produtos/resolveProduto.ts`), never a
 * second copy of "lexically first" — over the rows the seam names.
 */
function escolhaDoPasso11(produtoId: string, linhas: readonly VinculoDaConta[]): VinculoDaConta {
  const escolhido = escolherLink(
    linhas.map((v) => ({ id: v.id, raw: v.raw, produtoId })),
    { produtoId, subcolecao: 'prodshopee', origem: 'despacho-de-publicacao' },
  );
  if (escolhido === null) {
    throw new Error('[shopee/kits] escolhaDoPasso11 chamada sem nenhum vínculo');
  }
  return { id: escolhido.id, raw: escolhido.raw };
}

function aRecusa(problema: ProblemaDeBloqueio): ResultadoDoDespacho {
  return { ok: false, problemas: [problema] };
}

function aArma(arma: ArmaDePublicacao): ResultadoDoDespacho {
  return { ok: true, arma };
}

function substituido(v: VinculoDaConta): ProblemaDeBloqueio {
  const novo = v.raw.substituidoPorLinkDocId;
  return problemaVinculoSubstituido({
    linkDocId: v.id,
    itemId: itemIdDe(v.raw),
    novoLinkDocId: typeof novo === 'string' && novo !== '' ? novo : null,
  });
}

function ambiguos(n: readonly VinculoDaConta[]): ProblemaDeBloqueio {
  return problemaVinculosAmbiguos(n.map((v) => ({ linkDocId: v.id, itemId: itemIdDe(v.raw) })));
}

/** A native link that is not live: its own refusal when no `--recriar` was sent. */
function nativoMorto(v: VinculoDaConta): ProblemaDeBloqueio {
  if (ehVinculoSubstituido(v.raw)) return substituido(v);
  return problemaKitRemovido({ itemId: itemIdDe(v.raw), linkDocId: v.id });
}

/**
 * Rule (5)'s X: the kit `listagem-removida` naming the newest REMOVED native link
 * (by `ultimaModificacao`, ties by id) — the one a `--recriar` would replace. A
 * superseded native kit that is NOT removed still sells, so "foi excluído" would
 * be false about it: when no X is removed, the newest X answers with its own
 * refusal instead.
 */
function xMaisNovo(x: readonly VinculoDaConta[]): ProblemaDeBloqueio {
  const porNovidade = (a: VinculoDaConta, b: VinculoDaConta): number =>
    modificadoEm(b.raw) - modificadoEm(a.raw) || compararId(a, b);
  const removidos = x.filter((v) => ehRemovido(v.raw)).sort(porNovidade);
  const alvo = removidos[0] ?? [...x].sort(porNovidade)[0];
  if (alvo === undefined) throw new Error('[shopee/kits] xMaisNovo chamada sem vínculo nativo');
  return nativoMorto(alvo);
}

/* -------------------------------------------------------------------------- */
/*                                The dispatcher                               */
/* -------------------------------------------------------------------------- */

function escolherArma(
  produto: ProdutoDoDespacho,
  vinculos: readonly VinculoDaConta[],
  corpo: CorpoDoDespacho,
): ResultadoDoDespacho {
  const p = particionar(vinculos);

  /* ---- (1) converterEmKit ------------------------------------------------- */
  if (corpo.converterEmKit) {
    if (produto.ehKit !== true) return aRecusa(problemaConverterSemKit(produto.id));
    if (corpo.linkDocId !== null) {
      const v = vinculos.find((l) => l.id === corpo.linkDocId);
      if (v === undefined) return aRecusa(problemaConverterSemAnuncioComum());
      switch (classeDe(v)) {
        case 'o':
          return aArma({ arma: 'kit-converter', antecessorLinkDocId: v.id });
        case 'so':
          return aRecusa(substituido(v));
        case 'n':
        case 'x':
        case 'ro':
          return aRecusa(problemaConverterSemAnuncioComum());
      }
    }
    if (p.o.length > 0) {
      return aArma({
        arma: 'kit-converter',
        antecessorLinkDocId: escolhaDoPasso11(produto.id, p.o).id,
      });
    }
    const [unico, ...outros] = p.n;
    if (unico !== undefined && outros.length === 0) return aRecusa(problemaJaEKitNativo(unico.id));
    if (unico !== undefined) return aRecusa(ambiguos(p.n));
    return aRecusa(problemaConverterSemAnuncioComum());
  }

  /* ---- (2) a named link --------------------------------------------------- */
  if (corpo.linkDocId !== null) {
    const v = vinculos.find((l) => l.id === corpo.linkDocId);
    // Not this conta's (or no such link): the item arm answers its 404, as on main.
    if (v === undefined) return aArma({ arma: 'item', linkDocId: corpo.linkDocId });
    switch (classeDe(v)) {
      case 'n':
        return aArma(
          corpo.recriar
            ? { arma: 'kit-recriar', linkDocId: v.id }
            : { arma: 'kit-atualizar', linkDocId: v.id },
        );
      case 'x':
        return corpo.recriar
          ? aArma({ arma: 'kit-recriar', linkDocId: v.id })
          : aRecusa(nativoMorto(v));
      case 'so':
        return aRecusa(substituido(v));
      case 'o':
      case 'ro':
        return aArma({ arma: 'item', linkDocId: v.id });
    }
  }

  /* ---- (3) the live native kits ------------------------------------------- */
  const [nativo, ...maisNativos] = p.n;
  if (nativo !== undefined) {
    if (maisNativos.length > 0) return aRecusa(ambiguos(p.n));
    return aArma({ arma: 'kit-atualizar', linkDocId: nativo.id });
  }

  /* ---- (4) a live ordinary listing: step 11's pick, unchanged ------------- */
  if (p.o.length > 0) {
    return aArma({ arma: 'item', linkDocId: escolhaDoPasso11(produto.id, [...p.o, ...p.ro]).id });
  }

  /* ---- (5) no live link ---------------------------------------------------- */
  if (produto.ehKitVirtual === true && produto.ehKit !== true) {
    return aRecusa(problemaKitVirtualSemKit(produto.id));
  }
  if (ehKitVirtualEfetivo(produto)) return aArma({ arma: 'kit-criar' });
  if (p.x.length > 0) return aRecusa(xMaisNovo(p.x));
  if (p.ro.length > 0) {
    return aArma({ arma: 'item', linkDocId: escolhaDoPasso11(produto.id, p.ro).id });
  }
  const [superado] = p.so;
  if (superado !== undefined) return aRecusa(substituido(superado));
  return aArma({ arma: 'item', linkDocId: null });
}

/**
 * Pick the arm of ONE publish (reconcile §2.5.1) — see the module header for
 * the rules, in order.
 *
 * @param a.vinculos the conta's `prodshopee` documents of THIS produto, read once
 *   by the entry point (`lerVinculosDaConta`), both stored conta encodings
 *   folded.
 * @throws Error when the body reader's own contract is broken (`recriar` with
 *   no `linkDocId`, or both kit actions at once — the route answers both 400
 *   before an arm is chosen): a caller defect, never an operator's refusal.
 */
export function escolherArmaDePublicacao(a: {
  readonly produto: ProdutoDoDespacho;
  readonly vinculos: readonly VinculoDaConta[];
  readonly corpo: CorpoDoDespacho;
}): ResultadoDoDespacho {
  const { produto, vinculos, corpo } = a;
  if (corpo.recriar && corpo.converterEmKit) {
    throw new Error(
      '[shopee/kits] recriar e converterEmKit no mesmo pedido (o corpo responde 400)',
    );
  }
  if (corpo.recriar && corpo.linkDocId === null) {
    throw new Error('[shopee/kits] recriar sem linkDocId (o corpo responde 400)');
  }

  /* ---- (−1) a variation child never publishes, kit flag or not ------------ */
  if (produto.paiId !== null) return aRecusa(problemaProdutoEFilho(produto.id, produto.paiId));

  const resultado = escolherArma(produto, vinculos, corpo);
  if (!resultado.ok || resultado.arma.arma !== 'item') return resultado;

  // A kit option on step 11's arm: refused rather than silently ignored. The
  // field named is the first one sent, in the sentence's own order.
  if (corpo.principal !== null) return aRecusa(problemaOpcaoDeKitEmAnuncioComum('principal'));
  if (corpo.recriar) return aRecusa(problemaOpcaoDeKitEmAnuncioComum('recriar'));
  if (corpo.converterEmKit) return aRecusa(problemaOpcaoDeKitEmAnuncioComum('converterEmKit'));
  return resultado;
}
