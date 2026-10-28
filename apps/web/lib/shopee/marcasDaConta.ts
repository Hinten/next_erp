import type { DocumentReference, Firestore } from 'firebase/firestore';
import { z } from 'zod';
import {
  linhaDeMarcaParaGravarShopee,
  marcaDtoSchema,
  marcasDaContaShopee,
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
 *   the conflict, never an overwrite"). A same-brand row the section seeded
 *   and that was then deleted elsewhere guards a re-add too: the save re-reads
 *   the path absent and raises one conflict, which "Recarregar do servidor"
 *   clears — the safe direction.
 * - **Removing a brand** — one `delete` PER document of the brand (the legacy
 *   app let several auto-id docs name one brand; deleting only one would bring
 *   the brand back on the next read), each guarded by the baseline the section
 *   seeded for that path from server truth. A doc changed or deleted meanwhile
 *   raises the conflict, and NOTHING is written. A brand re-registered meanwhile
 *   at another id survives — the safe direction. A path with no baseline yet
 *   makes the save refuse ("Aguarde o carregamento…"): never an unguarded
 *   delete.
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

/** A `taxonomia/marcas` row this module can register (`linhaDeMarcaParaGravarShopee`). */
const adicaoMarcaShopeeSchema = marcaDtoSchema.refine(
  (dto) => linhaDeMarcaParaGravarShopee(dto) !== null,
  'Marca que não pode ser cadastrada: o id 0 é «Sem marca», e o nome não pode ficar em branco.',
);

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
 * be registered (`linhaDeMarcaParaGravarShopee` says `null`: `brandId` 0 or a
 * blank name) and a brand already staged are skipped; a brand staged for
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
      const ref = marcaShopeeCollection.docRef(db, { integracaoId }, docId);
      const guard: TransactionDocumentGuard = {
        baseline: context.getBaseline(ref.path),
        label: `Marca ${String(remocao.brandId)} (registro ${docId})`,
        formField: CAMPO_MARCAS_SHOPEE,
        toFormValue: (_atual, valor) => desfazerRemocaoMarcaShopee(valor, remocao.brandId),
      };
      escritas.push({ type: 'delete', ref: ref as DocumentReference<unknown>, guard });
    }
  }

  for (const dto of alteracoes.adicionar) {
    const linha = linhaDeMarcaParaGravarShopee(dto);
    // The delta's schema refuses an add with no row, so this is an invariant
    // breach — never an add silently skipped while the form still shows it.
    if (linha === null) throw new TypeError(`marca não registrável: ${String(dto.brandId)}`);
    const ref = marcaShopeeCollection.docRef(db, { integracaoId }, linha.docId);
    const guard: TransactionDocumentGuard = {
      baseline: baselineDoCadastro(context.getBaseline(ref.path), linha.docId, dto.brandId),
      label: `Marca «${dto.originalBrandName}» (id ${String(dto.brandId)})`,
      formField: CAMPO_MARCAS_SHOPEE,
      toFormValue: (_atual, valor) => desfazerAdicaoMarcaShopee(valor, dto.brandId),
    };
    escritas.push({
      type: 'set',
      ref: ref as DocumentReference<unknown>,
      data: { ...linha.data },
      guard,
    });
  }

  return escritas;
}
