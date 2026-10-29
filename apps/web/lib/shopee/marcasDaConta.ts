import type { DocumentReference, Firestore } from 'firebase/firestore';
import { z } from 'zod';
import {
  MOTIVO_RECUSA_MARCA_SHOPEE,
  linhaDeMarcaParaGravarShopee,
  marcaDtoSchema,
  marcasDaContaShopee,
  motivoRecusaMarcaShopee,
  type LeituraMarcasShopee,
  type MarcaDaContaShopee,
  type MarcaDto,
} from '@delfrance/schemas';
import type {
  TransactionDocumentGuard,
  TransactionWrite,
  TransactionWriteContext,
} from '@delfrance/ui';

import { marcaShopeeCollection } from '@/lib/data/marcaShopeeCollection';

/**
 * The Marcas section of `/canais/shopee/[id]` (#1911, D10, P9) — the pure half:
 * the STAGED DELTA the section edits, and the guarded writes the conta's save
 * makes from it to `integracao/{integracaoId}/brandshopee`.
 *
 * ## The form value is the delta, never the list
 *
 * The section edits ONE transient field of the conta's `ObjectView`,
 * {@link CAMPO_MARCAS_SHOPEE}: `null` while nothing is staged, else
 * `{adicionar, remover}` ({@link AlteracoesMarcasShopee}). Undoing every staged
 * change gives `null` back, so the form is pristine again. An untouched section
 * writes nothing and needs no baseline. The list itself is read live
 * (`./marcas.ts`) and never copied into the form.
 *
 * ## The writes, and what happens when one loses (root `CLAUDE.md` rule 7)
 *
 * {@link escritasMarcasDaContaShopee} turns the delta into sibling writes of the
 * conta's save, so they commit together with the conta in the save's ONE
 * atomic commit (`saveRecord`, `@delfrance/ui`, already inventoried), or not at
 * all. That commit re-reads every guarded document and compares it with the
 * guard's baseline first:
 *
 * - **Registering a brand** — a `set` at the deterministic id
 *   `docIdDaMarcaShopee(brandId)` (`linhaDeMarcaParaGravarShopee`, the one row
 *   shape), with baseline `null` ("absent"). Tier 0 by construction — two
 *   registrations of one brand land on one document — and tier 3 on top: a
 *   document already there (another operator registered the brand meanwhile,
 *   or any doc sits at that path) raises ObjectView's conflict instead of being
 *   overwritten. The ONE exception is a baseline the session holds that is a
 *   row of THIS brand, so that accepting the conflict modal's "Salvar mesmo
 *   assim" commits instead of looping. ⚠️ That modal is the only source of such
 *   a baseline because the Marcas section never seeds the path of a STAGED
 *   registration (`MarcasShopeeManager`'s seeding effect): a row another
 *   operator registered there meanwhile would otherwise guard the `set` with
 *   the very row it overwrites — a silent lost update (pinned by the page
 *   test "…and the SAME race with their row already on this screen is still
 *   the conflict, never an overwrite").
 *   ⚠️ A same-brand row the section seeded and that was then deleted elsewhere
 *   is NOT such a baseline, and nothing here would tell it apart: held, it
 *   equals what a re-add writes, `saveRecord` skips a sibling whose baseline
 *   equals its data WITHOUT re-reading it, and the re-add was dropped in
 *   silence (#1911 batch-B review R1-rule7#1). It is guarded only because the
 *   section CLEARS that path's baseline to "absent" when server truth stops
 *   listing it ({@link ajustesDasBaselinesMarcasShopee}) — so the re-add's
 *   `set` is guarded by `null`, and lands, or conflicts if a doc is back.
 * - **Removing a brand** — one `delete` PER document of the brand (the legacy
 *   app let several auto-id docs name one brand; deleting only one would bring
 *   the brand back on the next read), each guarded by the baseline the section
 *   seeded for that path from server truth. A doc changed or deleted meanwhile
 *   raises the conflict, and NOTHING is written. A brand re-registered meanwhile
 *   at another id survives — the safe direction. A path with no baseline yet
 *   makes the save refuse ("Aguarde o carregamento…"): never an unguarded
 *   delete. ⚠️ A path whose baseline is "absent" (`null`) is SKIPPED by
 *   `saveRecord` — there is nothing to delete — so a doc re-created at a path
 *   this session saw deleted must get its baseline back before a removal can
 *   reach it; the section re-seeds it from the server snapshot that shows it
 *   again ({@link ajustesDasBaselinesMarcasShopee}).
 *
 * On a commit, and on "Recarregar do servidor", each guarded document drops ITS
 * entry from the delta ({@link desfazerAdicaoMarcaShopee},
 * {@link desfazerRemocaoMarcaShopee}): committed, or overtaken by the server's
 * version for the operator to decide again.
 *
 * Pure: no clock, no network. The writes are built here and performed by
 * `saveRecord`.
 */

/** The page model's transient key holding the staged delta. */
export const CAMPO_MARCAS_SHOPEE = 'marcasShopee';

/**
 * One brand staged for removal: its id and EVERY document of it, as
 * `marcasDaContaShopee` listed them when the operator clicked Remover.
 */
export const remocaoMarcaShopeeSchema = z.object({
  brandId: z.number().int().positive(),
  docIds: z.array(z.string().min(1)).min(1),
});
export type RemocaoMarcaShopee = z.infer<typeof remocaoMarcaShopeeSchema>;

/**
 * Shown while the Marcas section waits for its first SERVER snapshot (a cached
 * list, or one with pending writes): its buttons stay disabled until then — a
 * change staged from a list server truth has not confirmed would have nothing
 * to be guarded by. The wording of the draft editor's own wait (P10), plus the
 * reason the buttons are greyed.
 */
export const FRASE_MARCAS_CARREGANDO_SHOPEE =
  'Carregando a versão do servidor… as marcas poderão ser alteradas quando ela chegar.';

/**
 * Why the registration refuses `dto`, in words — `null` when it does not.
 *
 * The rule AND its reason are `motivoRecusaMarcaShopee`'s (`@delfrance/schemas`
 * — the one `linhaDeMarcaParaGravarShopee` applies, so the wording cannot
 * disagree with the write; #1369). This only words each reason: the `switch`
 * is exhaustive, so a reason the rule gains fails the build here instead of
 * being worded as one it is not.
 */
export function recusaDoCadastroMarcaShopee(dto: MarcaDto): string | null {
  const motivo = motivoRecusaMarcaShopee(dto);
  if (motivo === null) return null;
  switch (motivo) {
    case MOTIVO_RECUSA_MARCA_SHOPEE.idInvalido:
      return 'id inválido — não pode ser cadastrada';
    case MOTIVO_RECUSA_MARCA_SHOPEE.semNome:
      return 'sem nome na Shopee — não pode ser cadastrada';
    default: {
      // Exhaustive: a third reason is a compile error here, never a row
      // labelled with a cause it does not have.
      const nunca: never = motivo;
      throw new TypeError(`motivo de recusa desconhecido: ${String(nunca)}`);
    }
  }
}

/** A `taxonomia/marcas` row this module can register (`linhaDeMarcaParaGravarShopee`). */
const adicaoMarcaShopeeSchema = marcaDtoSchema.superRefine((dto, ctx) => {
  const recusa = recusaDoCadastroMarcaShopee(dto);
  if (recusa !== null)
    ctx.addIssue({ code: 'custom', message: `Marca id ${String(dto.brandId)}: ${recusa}.` });
});

/**
 * The staged delta — the form value of {@link CAMPO_MARCAS_SHOPEE}. Valid BY
 * CONSTRUCTION when built through this module's helpers; any other value is
 * refused (a `ZodError`, which the save shows as "Dados inválidos"), never
 * silently dropped:
 * - every add is registrable, and each brand is added at most once;
 * - each brand is removed at most once, and no document is in two removals;
 * - no brand is both added and removed.
 */
export const alteracoesMarcasShopeeSchema = z
  .object({
    adicionar: z.array(adicaoMarcaShopeeSchema),
    remover: z.array(remocaoMarcaShopeeSchema),
  })
  .superRefine((valor, ctx) => {
    const adicionadas = new Set<number>();
    for (const dto of valor.adicionar) {
      if (adicionadas.has(dto.brandId))
        ctx.addIssue({ code: 'custom', message: 'A mesma marca foi adicionada duas vezes.' });
      adicionadas.add(dto.brandId);
    }
    const removidas = new Set<number>();
    const docs = new Set<string>();
    for (const r of valor.remover) {
      if (removidas.has(r.brandId))
        ctx.addIssue({
          code: 'custom',
          message: 'A mesma marca foi marcada para remoção duas vezes.',
        });
      removidas.add(r.brandId);
      for (const docId of r.docIds) {
        if (docs.has(docId))
          ctx.addIssue({
            code: 'custom',
            message: 'O mesmo registro de marca está em duas remoções.',
          });
        docs.add(docId);
      }
      if (adicionadas.has(r.brandId))
        ctx.addIssue({
          code: 'custom',
          message: 'Uma marca não pode ser adicionada e removida no mesmo salvamento.',
        });
    }
  });
export type AlteracoesMarcasShopee = z.infer<typeof alteracoesMarcasShopeeSchema>;

/** Nothing staged is `null`, never an empty delta — the form is then pristine. */
function normalizada(a: AlteracoesMarcasShopee): AlteracoesMarcasShopee | null {
  return a.adicionar.length === 0 && a.remover.length === 0 ? null : a;
}

/**
 * The staged delta of a form value: `null` when nothing is staged (`null`,
 * `undefined`, or both lists empty). Throws `ZodError` for a value that is not
 * a delta ({@link alteracoesMarcasShopeeSchema}).
 */
export function lerAlteracoesMarcasShopee(valor: unknown): AlteracoesMarcasShopee | null {
  if (valor === null || valor === undefined) return null;
  return normalizada(alteracoesMarcasShopeeSchema.parse(valor));
}

const VAZIA: AlteracoesMarcasShopee = { adicionar: [], remover: [] };

/**
 * Stage brands of a `taxonomia/marcas` page for registration. A row that cannot
 * be registered (`linhaDeMarcaParaGravarShopee` says `null` — its rule, not
 * restated here) and a brand already staged are skipped; a brand staged for
 * REMOVAL gets that removal undone instead (it is registered already).
 */
export function adicionarMarcasShopee(
  valor: unknown,
  marcas: readonly MarcaDto[],
): AlteracoesMarcasShopee | null {
  const atual = lerAlteracoesMarcasShopee(valor) ?? VAZIA;
  const adicionar = [...atual.adicionar];
  let remover = [...atual.remover];
  for (const dto of marcas) {
    if (linhaDeMarcaParaGravarShopee(dto) === null) continue;
    if (remover.some((r) => r.brandId === dto.brandId)) {
      remover = remover.filter((r) => r.brandId !== dto.brandId);
      continue;
    }
    if (adicionar.some((a) => a.brandId === dto.brandId)) continue;
    adicionar.push({
      brandId: dto.brandId,
      originalBrandName: dto.originalBrandName,
      displayBrandName: dto.displayBrandName,
    });
  }
  return normalizada({ adicionar, remover });
}

/** Undo the staged registration of `brandId` (absent ⇒ unchanged). */
export function desfazerAdicaoMarcaShopee(
  valor: unknown,
  brandId: number,
): AlteracoesMarcasShopee | null {
  const atual = lerAlteracoesMarcasShopee(valor);
  if (atual === null) return null;
  return normalizada({
    adicionar: atual.adicionar.filter((a) => a.brandId !== brandId),
    remover: atual.remover,
  });
}

/**
 * Stage the removal of a listed brand — EVERY one of its documents
 * (`marca.docIds`). Re-staging a brand replaces its entry; a staged
 * registration of the same brand is dropped (the delta never holds both).
 */
export function removerMarcaShopee(
  valor: unknown,
  marca: MarcaDaContaShopee,
): AlteracoesMarcasShopee | null {
  const atual = lerAlteracoesMarcasShopee(valor) ?? VAZIA;
  return normalizada({
    adicionar: atual.adicionar.filter((a) => a.brandId !== marca.brandId),
    remover: [
      ...atual.remover.filter((r) => r.brandId !== marca.brandId),
      { brandId: marca.brandId, docIds: [...marca.docIds] },
    ],
  });
}

/** Undo the staged removal of `brandId` (absent ⇒ unchanged). */
export function desfazerRemocaoMarcaShopee(
  valor: unknown,
  brandId: number,
): AlteracoesMarcasShopee | null {
  const atual = lerAlteracoesMarcasShopee(valor);
  if (atual === null) return null;
  return normalizada({
    adicionar: atual.adicionar,
    remover: atual.remover.filter((r) => r.brandId !== brandId),
  });
}

/**
 * The baseline a registration's `set` is guarded by: `null` ("absent"), unless
 * the session already holds, for that path, a row of THIS SAME brand — what the
 * conflict modal's "Salvar mesmo assim" leaves after a concurrent registration
 * of the brand, so accepting it commits (the section seeds no baseline for a
 * staged registration's path — see the module docblock). Any other document at
 * the path (an unreadable row, "Sem marca", another brand's row) keeps `null`,
 * so the save raises the conflict every time and never overwrites it.
 */
function baselineDoCadastro(
  guardada: Readonly<Record<string, unknown>> | null | undefined,
  docId: string,
  brandId: number,
): Record<string, unknown> | null {
  if (guardada === null || guardada === undefined) return null;
  const mesmaMarca = marcasDaContaShopee([{ id: docId, data: guardada }]).marcas.some(
    (m) => m.brandId === brandId,
  );
  return mesmaMarca ? { ...guardada } : null;
}

/** The ref of one `brandshopee` document — the ONE spelling, for the writes and for the baselines' keys. */
function refDoRegistro(
  db: Firestore,
  integracaoId: string,
  docId: string,
): DocumentReference<unknown> {
  return marcaShopeeCollection.docRef(db, { integracaoId }, docId) as DocumentReference<unknown>;
}

/** The full path of one `brandshopee` document: the key its save baseline is held under. */
export function caminhoDoRegistroMarcaShopee(
  db: Firestore,
  integracaoId: string,
  docId: string,
): string {
  return refDoRegistro(db, integracaoId, docId).path;
}

/**
 * A save baseline as ObjectView's registry holds it: a row, `null` ("absent"),
 * or `undefined` (none yet) — the registry's own type, read off its exported
 * seam rather than restated.
 */
type BaselineGuardada = ReturnType<TransactionWriteContext['getBaseline']>;

/** One move of a `brandshopee` save baseline, made on a SERVER-truth emission. */
export interface AjusteDeBaselineMarcaShopee {
  readonly path: string;
  /** `semear` — the path's first baseline; `rebase` — a held one replaced. */
  readonly tipo: 'semear' | 'rebase';
  /** The listed row, or `null`: server truth no longer lists the document. */
  readonly data: Exclude<BaselineGuardada, undefined>;
}

/**
 * What one SERVER-truth emission of the shortlist (`fromCache === false`, no
 * pending writes) does to the save baselines the Marcas section holds — pure,
 * so every branch is pinned without a page (root `CLAUDE.md` rule 7).
 *
 * A held ROW is never moved by a later emission: a row another operator changed
 * since it was seeded is the save's conflict, never silently the new truth.
 * What an emission does move is a path's EXISTENCE, because `saveRecord` skips
 * a sibling write whose baseline already equals what it would leave — without
 * re-reading it — and a stale existence is exactly that:
 * - **listed, no baseline** ⇒ `semear` its row — the first snapshot to show it;
 * - **listed, held "absent"** (a delete this session committed, or a path
 *   cleared below, and the doc is back) ⇒ `rebase` to its row: held absent, a
 *   removal of it would be skipped as "already gone" while it exists;
 * - **NOT listed, held as a row** ⇒ `rebase` to `null`: held as a row of the
 *   same brand, a re-add would equal it and be skipped while the doc is gone
 *   (R1-rule7#1) — while `null` makes the re-add's `set` land, or conflict if a
 *   doc is back by then.
 *
 * Two exceptions, each to keep a conflict that must fire:
 * - a path a STAGED REMOVAL names keeps its row: the doc's disappearance is that
 *   removal's conflict, and cleared, the removal's `delete` would be skipped —
 *   deleting the rest of the brand in silence;
 * - a path a STAGED REGISTRATION writes gets no row: a doc another operator put
 *   there would guard the registration's `set` with the very row it overwrites.
 *   Staged registrations are NOT exempt from the clearing: `null` on a `set`
 *   fails closed (a doc present at save raises `@exists`).
 *
 * ⚠️ `rebase` is the registry's only way to move a held baseline. It is
 * documented for an accepted conflict version or a commit; these moves are
 * neither — they never adopt a changed row, only record whether the document
 * EXISTS as server truth now says. A truncated read (`LIMITE_MARCAS_SHOPEE`)
 * can leave out a doc that exists: clearing it is then the fail-closed
 * direction (`@exists` at save), never an overwrite.
 *
 * @param conhecidos every path the section may hold a baseline for — listed by
 *   an earlier emission or written by a staged registration — since the
 *   registry cannot be enumerated.
 */
export function ajustesDasBaselinesMarcasShopee(entrada: {
  readonly listados: readonly {
    readonly path: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[];
  readonly conhecidos: Iterable<string>;
  readonly guardada: (path: string) => BaselineGuardada;
  readonly caminhosAdicionados: ReadonlySet<string>;
  readonly caminhosRemovidos: ReadonlySet<string>;
}): AjusteDeBaselineMarcaShopee[] {
  const ajustes: AjusteDeBaselineMarcaShopee[] = [];
  const listados = new Set<string>();
  for (const doc of entrada.listados) {
    listados.add(doc.path);
    if (entrada.caminhosAdicionados.has(doc.path)) continue;
    const guardada = entrada.guardada(doc.path);
    if (guardada === undefined)
      ajustes.push({ path: doc.path, tipo: 'semear', data: { ...doc.data } });
    else if (guardada === null)
      ajustes.push({ path: doc.path, tipo: 'rebase', data: { ...doc.data } });
  }
  for (const path of new Set(entrada.conhecidos)) {
    if (listados.has(path) || entrada.caminhosRemovidos.has(path)) continue;
    const guardada = entrada.guardada(path);
    if (guardada !== undefined && guardada !== null)
      ajustes.push({ path, tipo: 'rebase', data: null });
  }
  return ajustes;
}

/** What sits at one `brandshopee` document id, as THE reader classified it. */
export type OcupanteDoRegistroMarcaShopee =
  | { readonly tipo: 'marca'; readonly brandId: number; readonly rotulo: string }
  | { readonly tipo: 'sem-marca' }
  | { readonly tipo: 'ilegivel' };

/**
 * EVERY document id of a reading, with what occupies it — the ids a new
 * registration could collide with. `rotulo` is the brand row's own label on
 * the section (passed in), so a refusal can name the row the operator sees.
 */
export function ocupantesDosRegistrosMarcasShopee(
  leitura: LeituraMarcasShopee,
  rotulo: (m: MarcaDaContaShopee) => string,
): Map<string, OcupanteDoRegistroMarcaShopee> {
  const ocupantes = new Map<string, OcupanteDoRegistroMarcaShopee>();
  for (const m of leitura.marcas) {
    const ocupante = { tipo: 'marca', brandId: m.brandId, rotulo: rotulo(m) } as const;
    for (const docId of m.docIds) ocupantes.set(docId, ocupante);
  }
  for (const docId of leitura.semMarca) ocupantes.set(docId, { tipo: 'sem-marca' });
  for (const docId of leitura.ilegiveis) ocupantes.set(docId, { tipo: 'ilegivel' });
  return ocupantes;
}

/**
 * The sibling writes a conta save makes from the staged delta in
 * `values[CAMPO_MARCAS_SHOPEE]` — none when nothing is staged. Removals first
 * (one `delete` per document), then registrations (one `set` per brand); every
 * write guarded, each projecting onto the delta by dropping its own entry.
 *
 * Throws `ZodError` when the value is not a delta (the save then shows "Dados
 * inválidos" and writes nothing).
 */
export function escritasMarcasDaContaShopee(
  db: Firestore,
  integracaoId: string,
  values: Readonly<Record<string, unknown>>,
  context: TransactionWriteContext,
): TransactionWrite[] {
  const alteracoes = lerAlteracoesMarcasShopee(values[CAMPO_MARCAS_SHOPEE]);
  if (alteracoes === null) return [];
  const escritas: TransactionWrite[] = [];

  for (const remocao of alteracoes.remover) {
    for (const docId of remocao.docIds) {
      const ref = refDoRegistro(db, integracaoId, docId);
      const guard: TransactionDocumentGuard = {
        baseline: context.getBaseline(ref.path),
        label: `Marca ${String(remocao.brandId)} (registro ${docId})`,
        formField: CAMPO_MARCAS_SHOPEE,
        toFormValue: (_atual, valor) => desfazerRemocaoMarcaShopee(valor, remocao.brandId),
      };
      escritas.push({ type: 'delete', ref, guard });
    }
  }

  for (const dto of alteracoes.adicionar) {
    const linha = linhaDeMarcaParaGravarShopee(dto);
    // The delta's schema refuses an add with no row, so this is an invariant
    // breach — never an add silently skipped while the form still shows it.
    if (linha === null) throw new TypeError(`marca não registrável: ${String(dto.brandId)}`);
    const ref = refDoRegistro(db, integracaoId, linha.docId);
    const guard: TransactionDocumentGuard = {
      baseline: baselineDoCadastro(context.getBaseline(ref.path), linha.docId, dto.brandId),
      label: `Marca «${dto.originalBrandName}» (id ${String(dto.brandId)})`,
      formField: CAMPO_MARCAS_SHOPEE,
      toFormValue: (_atual, valor) => desfazerAdicaoMarcaShopee(valor, dto.brandId),
    };
    escritas.push({
      type: 'set',
      ref,
      data: { ...linha.data },
      guard,
    });
  }

  return escritas;
}
