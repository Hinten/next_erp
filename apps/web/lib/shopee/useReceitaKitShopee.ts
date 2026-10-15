'use client';

/**
 * The produto's KIT RECIPE as the Shopee tab previews it (step 21-3, #1529) —
 * each sellable unit with its components and the four local structural
 * warnings, read only while the operator looks at it (the kit block expanded,
 * or a recriar / converter confirmation open).
 *
 * ## The units are the children, exactly as publish reads them
 *
 * A native kit's MODELS are the produto's variation children — each with its
 * OWN `componentesKit` — and a kit without variations is ONE unit: the member
 * the produto save creates (`filhoUnicoId`), whose recipe the save mirrors from
 * the produto's. The publish reads the same thing: `prepararKit` lists the
 * children (`paiId ==`) and nothing else, and a kit with NO child at all is
 * refused before any Shopee call (`kit-sem-unidade-vendavel`). So the preview
 * passes the children it reads — zero of them included, which is what makes the
 * schemas adapter say that refusal BEFORE the operator clicks.
 *
 * ⚠️ The SAVED recipe, never the form's: a recriar sends nothing of the form,
 * and the server reads the stored documents. An unsaved edit in the Kit tab is
 * not what Shopee would get, so the preview does not show it as if it were.
 *
 * ## The reads (root `CLAUDE.md` rule 1: no new query shape)
 *
 *  - the children through `useSnapshot(produtos where paiId == <produto>)` —
 *    the shape the edit page holds live for the whole session and
 *    `KitVariacoesManager` reads `componentesKit` from, so the SDK serves it from
 *    that watch target;
 *  - the component NAMES, one-shot by id (`getDocsByIds`, a doc-id `in` per 30),
 *    under TanStack `['shopee-receita-kit-nomes', ids]` — a name is a label, so
 *    a failed read shows the ids and never blocks the preview.
 *
 * ## The rules (#1369: never a web copy)
 *
 * Each recipe is parsed by `componentesKitSchema` — the parse the publish's
 * context applies — and the warnings are `problemasDeEstruturaDaReceitaErp`
 * (`@delfrance/schemas`), the composition over the publish's own structural
 * check. WARNINGS ONLY: the publish re-decides each one against the real Shopee
 * addresses, so no caller may disable a button on them.
 */

import { useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import { skipToken, useQuery } from '@tanstack/react-query';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  componentesKitSchema,
  problemasDeEstruturaDaReceitaErp,
  type ComponentesKit,
} from '@delfrance/schemas';

import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** One component of one unit, as the recipe parse reads it (`quantidade` defaults to 1). */
export interface ComponenteDaReceitaKitShopee {
  readonly produtoId: string;
  readonly quantidade: number;
}

/** One sellable unit of the kit — one kit MODEL on Shopee. */
export interface UnidadeDaReceitaKitShopee {
  /** The variation child's id. */
  readonly filhoId: string;
  /** The child's `nome`, or `null` when it has none. */
  readonly nome: string | null;
  readonly componentes: readonly ComponenteDaReceitaKitShopee[];
}

/** One local structural warning of the recipe — `problemasDeEstruturaDaReceitaErp`'s row. */
export type ProblemaDaReceitaKitShopee = ReturnType<
  typeof problemasDeEstruturaDaReceitaErp
>[number];

export type ReceitaKitShopee =
  /** Not asked for: nothing was read. */
  | { readonly estado: 'desligada' }
  | { readonly estado: 'carregando' }
  | { readonly estado: 'erro'; readonly mensagem: string }
  | {
      readonly estado: 'pronta';
      /** In display order: `ordem` (absent last), then id. */
      readonly unidades: readonly UnidadeDaReceitaKitShopee[];
      /** Every DISTINCT component across the units, first-seen — the principal's candidates. */
      readonly componentes: readonly string[];
      /** Component id → its `nome`, as far as the name read got (empty while it runs or after it fails). */
      readonly nomes: ReadonlyMap<string, string>;
      readonly problemas: readonly ProblemaDaReceitaKitShopee[];
    };

/** A stored recipe through the schema the publish parses it with; anything unreadable is "no recipe". */
function receitaLida(bruto: unknown): ComponentesKit | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const lido = componentesKitSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/** `ordem` when it is a finite number; a child without one lists last. */
function ordemDe(dados: { readonly ordem?: unknown }): number {
  const v = dados.ordem;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
}

function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function useReceitaKitShopee(a: {
  readonly db: Firestore;
  /** The kit produto — the root whose children are the units. */
  readonly produtoId: string;
  /** Read only while the preview is on screen (the kit block open, or a kit modal). */
  readonly enabled: boolean;
}): ReceitaKitShopee {
  const { db, produtoId, enabled } = a;
  const filhosQuery = useMemo(
    () =>
      enabled ? buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]) : null,
    [db, produtoId, enabled],
  );
  const filhosSnap = useSnapshot(filhosQuery);

  const lido = useMemo(() => {
    const filhos = filhosSnap.data;
    if (filhos === undefined) return null;
    const ordenados = [...filhos].sort(
      (x, y) => ordemDe(x.data) - ordemDe(y.data) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    const receitas = ordenados.map((f) => ({
      filhoId: f.id,
      nome: textoOuNull(f.data.nome),
      componentesKit: receitaLida(f.data.componentesKit),
    }));
    const componentes: string[] = [];
    for (const r of receitas) {
      for (const id of Object.keys(r.componentesKit ?? {})) {
        if (!componentes.includes(id)) componentes.push(id);
      }
    }
    const unidades: UnidadeDaReceitaKitShopee[] = receitas.map((r) => ({
      filhoId: r.filhoId,
      nome: r.nome,
      componentes: Object.entries(r.componentesKit ?? {}).map(([id, k]) => ({
        produtoId: id,
        quantidade: k.quantidade,
      })),
    }));
    return {
      unidades,
      componentes,
      problemas: problemasDeEstruturaDaReceitaErp(
        receitas.map((r) => ({ filhoId: r.filhoId, componentesKit: r.componentesKit })),
      ),
    };
  }, [filhosSnap.data]);

  // Sorted, so one recipe in two surfaces (the block and the modal) shares ONE read.
  const ids = useMemo(() => [...(lido?.componentes ?? [])].sort(), [lido]);
  const nomesQuery = useQuery({
    queryKey: ['shopee-receita-kit-nomes', ids],
    queryFn:
      enabled && ids.length > 0
        ? async () => {
            const docs = await getDocsByIds(db, produtoCollection, ids);
            const nomes = new Map<string, string>();
            for (const [id, doc] of docs) {
              const nome = textoOuNull(doc.nome);
              if (nome !== null) nomes.set(id, nome);
            }
            return nomes;
          }
        : skipToken,
  });

  if (!enabled) return { estado: 'desligada' };
  if (filhosSnap.error) return { estado: 'erro', mensagem: filhosSnap.error.message };
  if (lido === null) return { estado: 'carregando' };
  return {
    estado: 'pronta',
    unidades: lido.unidades,
    componentes: lido.componentes,
    nomes: nomesQuery.data ?? new Map<string, string>(),
    problemas: lido.problemas,
  };
}
