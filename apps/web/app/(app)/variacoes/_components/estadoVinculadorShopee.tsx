'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ValidationIssue } from '@delfrance/ui';
import { validarVinculosShopee, type SeedVinculadorShopee } from './vinculadorShopee';

/**
 * How the Shopee tab hands the page's `validate` the form's SEED — what
 * `linksVariacoesShopee` and `variacoes` were last reset to — which `validate`
 * needs to tell an entry this save edited from one it carries back untouched.
 * The Loja Integrada tab's sibling (`estadoVinculadorLi.tsx`), for the same reason:
 * `grupoFields` stays a module-level constant (`ObjectView` memoizes its field
 * overrides by identity), so the seed cannot reach `validate` through it.
 *
 * The edit page creates one {@link EstadoVinculadorShopee}, composes its `validar`
 * into `validate`, and wraps `ObjectView` in {@link EstadoVinculadorShopeeProvider};
 * the tab publishes the seed from an effect ({@link usePublicarSeedVinculadorShopee})
 * that re-runs on every reset of the form. The tab is a `persistentSections` entry,
 * so that effect runs even when the tab was never opened.
 *
 * ⚠️ Until a seed is published, `validar` counts every entry as edited — fail
 * closed: a stored defect can then block a save, never slip through one.
 */
export interface EstadoVinculadorShopee {
  /** Publish the form's seed (the tab, from an effect). */
  readonly publicar: (seed: SeedVinculadorShopee) => void;
  /** The last seed published, or `null`. */
  readonly seed: () => SeedVinculadorShopee | null;
  /** The Shopee half of the page's `ObjectView.validate`, with a stable identity. */
  readonly validar: (values: Record<string, unknown>) => readonly ValidationIssue[];
}

/** One state per page mount; stable for its whole life. */
export function useEstadoVinculadorShopee(): EstadoVinculadorShopee {
  const publicada = useRef<SeedVinculadorShopee | null>(null);
  return useMemo(
    () => ({
      publicar: (seed) => {
        publicada.current = seed;
      },
      seed: () => publicada.current,
      validar: (values) => validarVinculosShopee(values, publicada.current),
    }),
    [],
  );
}

const ContextoVinculadorShopee = createContext<EstadoVinculadorShopee | null>(null);

export function EstadoVinculadorShopeeProvider({
  value,
  children,
}: {
  value: EstadoVinculadorShopee;
  children: ReactNode;
}) {
  return (
    <ContextoVinculadorShopee.Provider value={value}>{children}</ContextoVinculadorShopee.Provider>
  );
}

/**
 * Publish the form's seed to the page's state, on mount and whenever either seed
 * value changes (a reset hands the form new default objects). A no-op without a
 * provider — a tab rendered on its own validates nothing.
 */
export function usePublicarSeedVinculadorShopee(links: unknown, variacoes: unknown): void {
  const estado = useContext(ContextoVinculadorShopee);
  useEffect(() => {
    estado?.publicar({ links, variacoes });
  }, [estado, links, variacoes]);
}
