'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ValidationIssue } from '@delfrance/ui';
import { validarVinculosLi, type SeedVinculadorLi } from './vinculadorLi';

/**
 * How the Loja Integrada tab hands the page's `validate` the form's SEED — what
 * `linksVariacoesli` and `variacoes` were last reset to — which `validate` needs
 * to tell an entry this save edited from one it carries back untouched.
 *
 * `grupoFields` stays a module-level constant (`ObjectView` memoizes its field
 * overrides by identity), so the seed cannot reach `validate` through it.
 * Instead each page creates one {@link EstadoVinculadorLi}, passes its
 * `validar` as `validate`, and wraps `ObjectView` in
 * {@link EstadoVinculadorLiProvider}; the tab publishes the seed from an effect
 * ({@link usePublicarSeedVinculadorLi}) that re-runs on every reset of the form.
 * The tab is a `persistentSections` entry, so that effect runs even when the tab
 * was never opened.
 *
 * ⚠️ Until a seed is published, `validar` counts every entry as edited — fail
 * closed: a stored defect can then block a save, never slip through one.
 */
export interface EstadoVinculadorLi {
  /** Publish the form's seed (the tab, from an effect). */
  readonly publicar: (seed: SeedVinculadorLi) => void;
  /** The last seed published, or `null`. */
  readonly seed: () => SeedVinculadorLi | null;
  /** The page's `ObjectView.validate`, with a stable identity. */
  readonly validar: (values: Record<string, unknown>) => readonly ValidationIssue[];
}

/** One state per page mount; stable for its whole life. */
export function useEstadoVinculadorLi(): EstadoVinculadorLi {
  const publicada = useRef<SeedVinculadorLi | null>(null);
  return useMemo(
    () => ({
      publicar: (seed) => {
        publicada.current = seed;
      },
      seed: () => publicada.current,
      validar: (values) => validarVinculosLi(values, publicada.current),
    }),
    [],
  );
}

const ContextoVinculadorLi = createContext<EstadoVinculadorLi | null>(null);

export function EstadoVinculadorLiProvider({
  value,
  children,
}: {
  value: EstadoVinculadorLi;
  children: ReactNode;
}) {
  return <ContextoVinculadorLi.Provider value={value}>{children}</ContextoVinculadorLi.Provider>;
}

/**
 * Publish the form's seed to the page's state, on mount and whenever either seed
 * value changes (a reset hands the form new default objects). A no-op without a
 * provider — a tab rendered on its own validates nothing.
 */
export function usePublicarSeedVinculadorLi(links: unknown, variacoes: unknown): void {
  const estado = useContext(ContextoVinculadorLi);
  useEffect(() => {
    estado?.publicar({ links, variacoes });
  }, [estado, links, variacoes]);
}
