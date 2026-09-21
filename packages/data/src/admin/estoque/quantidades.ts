/**
 * **THE quantity core** — how many units of one produto a marketplace listing
 * should advertise, at one depósito, now and at a window start.
 *
 * Every arithmetic decision the Mercado Livre stock sweep made since #678 lives
 * here, unchanged: the kit fold (`min(component ÷ quantidade)`, #238's
 * missing-component-counts-0 divergence), the floor/clamp pair, the #1087 rule
 * that a VIRTUAL kit takes the ordinary kit branch, the #932 keying split
 * between a member's own estoque row and a component's, and ADR 0014's
 * omission-is-the-mechanism contract for the window-start reconstruction.
 *
 * ---- Why it is HERE. It was ML's alone until Shopee needed the same answer for
 * `update_stock` and for `init_tier_variation`'s `seller_stock`. `apps/shopee`
 * has no dependency edge to `apps/mercado-livre` and none is possible, so a rule
 * two surfaces need either moves here or gets written twice — and a second copy
 * of a decision this expensive drifts toward plausible while reading correct
 * (root `CLAUDE.md`, #1369). Four live kit formulas were already counted in this
 * repo; a fifth, inside a second copy of the send policy, is exactly the shape
 * that guide names. The precedent is `admin/imposto/`, promoted in step 11 for a
 * strictly weaker reason.
 *
 * ---- What that costs, and the rule it buys. Every tunable ML used to read from
 * the ambient environment inside these functions is now a REQUIRED field of
 * {@link OpcoesDeQuantidade}. Nothing in this file reads the environment
 * (a raw-text scan of this directory for an environment read matches `env.ts`
 * alone): a channel's env names, defaults and PINNED values are that channel's
 * business, and the moment this core resolved one of them itself the promotion
 * would be a Mercado Livre module living at a neutral path. Each binding is one
 * small function beside its own sender — `opcoesML` in `bulkEstoquePlan.ts`,
 * `opcoesShopee` in `apps/shopee/lib/shopee/estoque/quantidadeEstoque.ts`.
 *
 * ---- ⚠️ READ **ADR 0014** (`apps/docs`, "Kit stock propagation and the tiered
 * stock sweep") before changing any of it. Two lines in particular look like
 * simplifications and are not:
 *  - the high-stock skip compares `min(anterior, atual)`, never `atual` alone —
 *    gating on the current value would skip 110 → 95, the movement that walks a
 *    listing into the danger zone (that one lives in `./politica`);
 *  - {@link quantidadesAnterioresCore} OMITS a member it cannot reconstruct
 *    rather than falling back to the current row. **The omission IS the
 *    mechanism**: a missing entry is read as *unknown* and SENDS, while a
 *    fallback would read as "unchanged" and silently skip a real movement.
 *
 * Timestamp units: produto/estoque timestamps and the ledger's `timestamp` are
 * MS since epoch throughout; nothing here touches µs.
 */
import {
  type ComponentesKit,
  componentesKitEntries,
  estoqueDisponivel,
  kitEstoqueDisponivel,
} from '@delfrance/schemas';

import type { MovimentoDaJanela, MovimentosDaJanela } from './ledger';
import { chaveMovimento } from './ledger';
import { ESTOQUE_MIN } from './politica';

/* --------------------------------- the rows -------------------------------- */

/**
 * One raw estoque row as a channel's discovery query projects it — unvalidated,
 * read defensively like a `doc.data()` record. Component rows
 * ({@link MembroDaFamilia.componentEstoques}) carry the `parentId` produto-id
 * denorm their join keys on; a member's OWN row omits it (the owner is the
 * member itself).
 *
 * ⚠️ "Omits it" is a fact about the PROJECTION, not a hint to compensate for.
 * Any consumer that needs the owner of an own row must take it from
 * `member.produtoId`; reading `row.parentId` there always yields `undefined`
 * and silently degrades to "no data" (#932). The stored document does carry the
 * field — a kit's own estoque doc is written with it for structural uniformity
 * (ADR 0014 §2) — but nothing projects it, and nothing reads it: a kit can never
 * be a component of another kit (#239), so the one query that matches on
 * `parentId` can never reach a kit's own row.
 */
export interface RawEstoqueRow {
  /** Exact estoque document id projected by the sweep; legacy rows may be auto-id. */
  estoqueDocId?: unknown;
  parentId?: unknown;
  quantidade?: unknown;
  quantidadeReservada?: unknown;
  ultimaModificacao?: unknown;
  [key: string]: unknown;
}

/**
 * One family member (a family anchor, or a variation child) with everything the
 * sweep-time quantity computation needs — and nothing else.
 *
 * ⚠️ Declared STRUCTURALLY on purpose: each channel's own row type carries far
 * more (its links, its marketplace ids, its status pair) and must satisfy this
 * one WITHOUT being edited. Mercado Livre's `FamilyMember` / `FamilyChild` and
 * Shopee's `MembroDaFamilia` / `FilhoDaFamilia` all widen it. Add a field here
 * only when every channel can supply it; extra keys on the caller's type are
 * fine and are ignored.
 */
export interface MembroDaFamilia {
  produtoId: string;
  ehKit: boolean;
  ehKitVirtual: boolean;
  publicado: boolean;
  /** Stays RAW — the kit-min helper tolerates junk from a soft-parsed doc. */
  componentesKit: ComponentesKit | null;
  /** Produto `timestamp` (ms since epoch), or null when the projection has none. */
  timestampMs: number | null;
  /** The member's own estoque at the swept depósito; null when absent. */
  estoque: RawEstoqueRow | null;
  /** Component estoques at the same depósito, keyed by their `parentId` denorm. */
  componentEstoques: RawEstoqueRow[];
}

/**
 * One discovered family: an anchor plus its variation children.
 *
 * `children` is `readonly` so a channel's richer child array (ML's
 * `FamilyChild[]`, Shopee's `FilhoDaFamilia[]`) is assignable without a cast.
 */
export interface LinhaDeFamilia {
  anchor: MembroDaFamilia;
  children: readonly MembroDaFamilia[];
}

/* ------------------------------- the options ------------------------------- */

/**
 * Every tunable the quantity fold depends on, supplied by the CALLER.
 *
 * ⚠️ All three are REQUIRED, and that is the promotion's whole point (C-v). ML
 * read each of them from its own environment inside the arithmetic; Shopee
 * pins one of them and derives another per listing. An optional field with a
 * default here would put one channel's answer in the other channel's path —
 * silently, because both would still typecheck and both would still be green.
 */
export interface OpcoesDeQuantidade {
  /**
   * ADD the produto's own stock to a CONSTRAINED kit min. Ships OFF on every
   * channel today (component-min only, per Lucas). ⚠️ It applies only when the
   * min is non-null: an unconstrained kit already falls back to its own stock,
   * and adding it again would double the number.
   */
  readonly incluirEstoqueProprioDoKit: boolean;
  /**
   * Answer `null` — "do not publish a quantity for this produto at all" — for a
   * virtual kit.
   *
   * ⚠️ Channel-dependent, and NOT a preference. On Mercado Livre it is #1087's
   * escape hatch, shipping OFF (a virtual kit is an ordinary kit on that wire).
   * On Shopee it is PINNED `false`, because "no quantity" is inexpressible
   * there: `seller_stock` is required per model on `init_tier_variation` /
   * `add_model`, and a native Shopee kit is excluded earlier, by a different
   * field.
   */
  readonly pularKitVirtual: boolean;
  /**
   * Upper clamp of the published quantity. `Number.POSITIVE_INFINITY` means no
   * ceiling — use it, never `0`, when a channel has none or has not read one:
   * a `0` ceiling silently zeroes every listing it touches, and zero is a legal
   * quantity on every wire here, so nothing downstream would flag it.
   */
  readonly estoqueMax: number;
}

/* ----------------------------- quantity compute ---------------------------- */

export interface QuantidadeParaEnvioArgs {
  ehKit: boolean;
  ehKitVirtual: boolean;
  componentesKit: ComponentesKit | null | undefined;
  /** The produto's own `disponivel` (quantidade − reservada) at the depósito. */
  ownDisponivel: number;
  /** Component produto id → its `disponivel` at the same depósito. */
  disponivelByProdutoId: Record<string, number | null | undefined>;
}

/**
 * The quantity to publish for one produto at one depósito. Kits wrap
 * `kitEstoqueDisponivel` (component-min, unrounded, missing component = 0 per
 * #238); a `null` min (no component constrains) falls back to the produto's own
 * stock. The opt-in own-stock hook ADDS `ownDisponivel` to a constrained kit
 * min. Result is floored, then clamped `ESTOQUE_MIN..o.estoqueMax`.
 *
 * PURE: no clock, no network, no environment read. Every tunable arrives in `o`.
 *
 * ⚠️ **A VIRTUAL kit takes the ordinary kit branch (#1087).** The old
 * `if (ehKitVirtual) return null` was Mercado Livre legacy parity resting on a
 * premise this repo had already refuted: it assumed the marketplace derives the
 * quantity from the components, which ML does only for its own Virtual Kits — a
 * User-Products feature this port never creates. So the listing kept advertising
 * its publish-time quantity for ever, and oversold.
 *
 * ⚠️ **The OR is load-bearing on its own**, independently of the `null`. Keying
 * the kit branch on `args.ehKit` alone while still sending virtual kits computes
 * no min at all and falls back to `ownDisponivel` — a WRONG number rather than a
 * refusal, and nothing reports it. Pinned by the near-miss test.
 *
 * `null` survives only as {@link OpcoesDeQuantidade.pularKitVirtual}'s answer,
 * meaning "do not push a stock update for this produto".
 */
export function quantidadeParaEnvioCore(
  args: QuantidadeParaEnvioArgs,
  o: OpcoesDeQuantidade,
): number | null {
  if (args.ehKitVirtual && o.pularKitVirtual) return null;

  let disponivel: number;
  if (args.ehKit || args.ehKitVirtual) {
    const kitMin = kitEstoqueDisponivel(args.componentesKit, args.disponivelByProdutoId);
    if (kitMin == null) {
      disponivel = args.ownDisponivel; // unconstrained kit → own stock stands alone
    } else {
      disponivel = kitMin + (o.incluirEstoqueProprioDoKit ? args.ownDisponivel : 0);
    }
  } else {
    disponivel = args.ownDisponivel;
  }

  return Math.min(Math.max(Math.floor(disponivel), ESTOQUE_MIN), o.estoqueMax);
}

/* ------------------------- quantities at sweep time ------------------------ */

/**
 * Component `disponivel` map from the joined estoque rows, keyed by the
 * `parentId` produto-id denorm. Junk rows (no string parentId) are skipped;
 * non-finite quantities read as 0 (legacy tolerance).
 */
export function disponivelByProdutoIdFrom(rows: RawEstoqueRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.parentId !== 'string' || row.parentId === '') continue;
    out[row.parentId] = estoqueDisponivel({
      quantidade: finiteNumber(row.quantidade) ?? 0,
      quantidadeReservada: finiteNumber(row.quantidadeReservada) ?? 0,
    });
  }
  return out;
}

/**
 * One member's send quantity from its OWN joined rows — no I/O, computed at
 * sweep time (the task then carries this verbatim to the send handler). Missing
 * own estoque reads as 0; a missing component estoque counts as 0 through the
 * kit min (#238); a virtual kit takes the ordinary kit branch and answers `null`
 * only while `o.pularKitVirtual` is on.
 *
 * ⚠️ It threads `o` through UNCHANGED, and every caller inside one sweep must
 * pass the SAME object. Resolving the options separately per call site is how
 * {@link quantidadesDaFamiliaCore} and a channel's task builder end up
 * disagreeing about the same tick — which, before the promotion, is exactly what
 * a single lazy env reader existed to prevent.
 */
export function quantidadeDoMembroCore(
  member: MembroDaFamilia,
  o: OpcoesDeQuantidade,
): number | null {
  const ownDisponivel =
    member.estoque == null
      ? 0
      : estoqueDisponivel({
          quantidade: finiteNumber(member.estoque.quantidade) ?? 0,
          quantidadeReservada: finiteNumber(member.estoque.quantidadeReservada) ?? 0,
        });
  return quantidadeParaEnvioCore(
    {
      ehKit: member.ehKit,
      ehKitVirtual: member.ehKitVirtual,
      componentesKit: member.componentesKit,
      ownDisponivel,
      disponivelByProdutoId: disponivelByProdutoIdFrom(member.componentEstoques),
    },
    o,
  );
}

/**
 * The constraining components this kit declares that the join did **not** bring
 * back — i.e. the ones whose stock we cannot see. Empty for a non-kit, for a kit
 * with no constraining component, and for a kit whose components all resolved.
 *
 * "Constraining" has to mean exactly what `kitEstoqueDisponivel` means by it, or
 * the guard and the arithmetic drift apart: `limitarEstoque !== false` and a
 * finite `quantidade > 0`, over `componentesKitEntries`' shape filter.
 *
 * The usual cause is a stale `componentesKitKeys` denorm: the join is keyed on
 * that array, so a component missing from it is never fetched and
 * `kitEstoqueDisponivel` scores it 0 (#238) — the kit floors to 0 without
 * anything having gone wrong with its actual stock. A component that genuinely
 * has no estoque doc at this depósito lands here too, and is treated the same,
 * because from here the two are indistinguishable.
 *
 * ⚠️ **`ehKit || ehKitVirtual`, matching {@link quantidadeParaEnvioCore}
 * (#1087).** This predicate has to admit exactly the members whose quantity that
 * function derives from components, or the two drift and the guard stops
 * covering the arithmetic it guards. Excluding virtual kits here — which is what
 * it used to do — left {@link kitNaoVerificavel} permanently false for them, so a
 * virtual kit with a stale denorm published 0 with no alarm naming the
 * components AND, worse, was never omitted from
 * {@link quantidadesAnterioresCore}: the reconstruction rebuilt the same 0 from
 * the same broken component set, read "unchanged", and skipped the send that
 * would have corrected the marketplace.
 */
export function componentesNaoResolvidos(member: MembroDaFamilia): string[] {
  if (!(member.ehKit || member.ehKitVirtual)) return [];
  const disponiveis = disponivelByProdutoIdFrom(member.componentEstoques);
  return componentesKitEntries(member.componentesKit)
    .filter(([, kit]) => kit.limitarEstoque !== false)
    .filter(([, kit]) => Number.isFinite(kit.quantidade) && kit.quantidade > 0)
    .filter(([produtoId]) => typeof disponiveis[produtoId] !== 'number')
    .map(([produtoId]) => produtoId);
}

/**
 * True when a kit's published quantity **cannot be verified**: it declares
 * constraining components and not one of them resolved.
 *
 * ⚠️ This does NOT suppress the send — it forces it. See
 * {@link quantidadesAnterioresCore}, which omits such a member so
 * `deveEnviarFamiliaCore` fails open, and the alarm each channel's task builder
 * raises. The full reasoning lives in ADR 0014, but the short version belongs
 * here because this is where it would be inverted:
 *
 * **An unverifiable kit publishes 0, and that is the safe direction.** Mercado
 * Livre auto-reactivates a listing paused as `out_of_stock` the moment a
 * positive quantity arrives, so a zeroed listing heals itself. Leaving the
 * marketplace holding whatever it already has does not: if that number is
 * positive, the listing keeps selling stock the ERP cannot account for, and an
 * oversell cannot be un-sold.
 *
 * ⚠️ #806 S12 proposed the opposite — skip rather than send 0 — and that was
 * **deliberately inverted**, not left undone. Do not "restore" it from the issue
 * text.
 */
export function kitNaoVerificavel(member: MembroDaFamilia): boolean {
  const declarados = componentesKitEntries(member.componentesKit).filter(
    ([, kit]) =>
      kit.limitarEstoque !== false && Number.isFinite(kit.quantidade) && kit.quantidade > 0,
  );
  if (declarados.length === 0) return false;
  return componentesNaoResolvidos(member).length === declarados.length;
}

/**
 * Every family member's send quantity (anchor + children), keyed by produto
 * id. Members whose quantity is `null` are OMITTED — a task builder treats a
 * missing entry as "never send". The only producer of a `null` is a virtual kit
 * while `o.pularKitVirtual` is on, so with it off nothing is omitted.
 */
export function quantidadesDaFamiliaCore(
  row: LinhaDeFamilia,
  o: OpcoesDeQuantidade,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const member of [row.anchor, ...row.children]) {
    const quantidade = quantidadeDoMembroCore(member, o);
    if (quantidade != null) out.set(member.produtoId, quantidade);
  }
  return out;
}

/**
 * The window's net movement for the pair one estoque row belongs to.
 *
 * ⚠️ The owning produto is passed **in**, never read off the row — that is #932.
 * A discovery query does not project `parentId` on a member's OWN estoque row,
 * and it has no reason to: a `subcollection('estoques')` probe is already bound
 * to the produto being processed, so the owner IS `member.produtoId`. Reading
 * the denorm here instead made every own row unkeyable, and an unkeyable row
 * reads as "did not move" — a silent skip that dropped every ordinary produto's
 * stock change on every tier. Component rows DO carry the denorm, because their
 * join matches on it.
 */
function movimentoDaLinha(
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): MovimentoDaJanela | null {
  // No join key ⇒ nothing in the ledger can be attributed to this row. Reads as
  // "did not move", the same as a pair with no rows in the window.
  if (typeof produtoId !== 'string' || produtoId === '') return null;
  return movimentos.get(chaveMovimento(produtoId, depositoId)) ?? null;
}

/**
 * Rebuild ONE member's estoque row as it stood at the window start, by undoing
 * the window's net movement. `null` when the pair never moved — the caller reads
 * that as "unchanged", which is exactly right.
 *
 * ⚠️ Only call this once {@link movimentoDesconhecido} has cleared the row. A
 * pair with an unreadable row has meaningless sums, and subtracting them would
 * manufacture a *confident* wrong `anterior` — the one outcome the fail-open
 * contract exists to prevent.
 */
function desfazerMovimento(
  row: RawEstoqueRow,
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): RawEstoqueRow | null {
  const mov = movimentoDaLinha(produtoId, depositoId, movimentos);
  if (mov == null) return null;
  return {
    ...row,
    quantidade: (finiteNumber(row.quantidade) ?? 0) - mov.dq,
    quantidadeReservada: (finiteNumber(row.quantidadeReservada) ?? 0) - mov.dr,
  };
}

/** True when this row's pair moved by an amount the ledger cannot report. */
function movimentoDesconhecido(
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): boolean {
  return movimentoDaLinha(produtoId, depositoId, movimentos)?.desconhecido === true;
}

/**
 * Every family member's send quantity **as it stood at the window start** —
 * `atual − Σmovimento`, run back through the SAME kit math so a kit's floor is
 * recomputed rather than approximated.
 *
 * This is what lets a sweep answer "did the published number actually change"
 * without any per-family query: the ledger pre-pass pays once per tick, and this
 * is pure arithmetic on top of it.
 *
 * ⚠️ A member is **omitted** — not approximated — when any estoque its quantity
 * depends on (its own, or a kit component's) moved by an unreadable amount.
 * `deveEnviarFamiliaCore` reads a missing entry as *unknown* and sends. This is
 * the fail-open path, and it only works because the member is left out entirely:
 * a fallback to the current row would read as "unchanged" and skip.
 *
 * ⚠️ The two row classes are keyed DIFFERENTLY and must stay that way (#932): a
 * member's OWN row by `member.produtoId` (the subcollection probe is bound to
 * that produto, so the projection has no `parentId` to give), a component row by
 * its `parentId` denorm (its collection-group join matches on exactly that).
 */
export function quantidadesAnterioresCore(
  row: LinhaDeFamilia,
  depositoId: string,
  movimentos: MovimentosDaJanela,
  o: OpcoesDeQuantidade,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const member of [row.anchor, ...row.children]) {
    // ⚠️ THE OMISSION IS THE MECHANISM, for both arms below. A member left out
    // of this map is read by `deveEnviarFamiliaCore` as *unknown* and SENDS.
    // Falling back to the current row instead would make `anterior === atual`
    // and skip — which is a silent drop, not a safe default.
    const desconhecido =
      (member.estoque != null && movimentoDesconhecido(member.produtoId, depositoId, movimentos)) ||
      member.componentEstoques.some((e) =>
        movimentoDesconhecido(e.parentId, depositoId, movimentos),
      );
    // A kit whose components did not resolve is unverifiable, and the ledger
    // cannot tell us so: the reconstruction would rebuild `anterior` from the
    // SAME broken component set, land on the same 0, and conclude "unchanged"
    // about a listing whose published number may be badly wrong. Omitting it
    // forces the send, and what gets sent is 0 — the safe direction, because the
    // marketplace auto-reactivates on qty > 0 while an oversell cannot be
    // undone. This is #806 S12, resolved in the opposite direction to the one it
    // proposed; see {@link kitNaoVerificavel} and ADR 0014 before changing it.
    if (desconhecido || kitNaoVerificavel(member)) continue;
    const anterior: MembroDaFamilia = {
      ...member,
      estoque:
        member.estoque == null
          ? null
          : (desfazerMovimento(member.estoque, member.produtoId, depositoId, movimentos) ??
            member.estoque),
      componentEstoques: member.componentEstoques.map(
        (e) => desfazerMovimento(e, e.parentId, depositoId, movimentos) ?? e,
      ),
    };
    const quantidade = quantidadeDoMembroCore(anterior, o);
    if (quantidade != null) out.set(member.produtoId, quantidade);
  }
  return out;
}

/* --------------------------------- helpers --------------------------------- */

/**
 * Narrow a raw doc field to a finite number (tolerates legacy/missing data).
 *
 * Deliberately NOT exported: it is a one-line tolerance, not a decision, and
 * each channel's I/O layer already carries its own copy for its own raw reads.
 * Exporting it would invite a channel to route a marketplace's wire number
 * through the quantity core's helper and quietly acquire this fold's scope.
 */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
