'use client';

/**
 * The page-level host of the `/pedidos` etiqueta row action (#1523, R-f).
 *
 * ⚠️ Why it exists: `EtiquetaRowAction` lives inside the FreteCell HoverCard,
 * and the HoverCard UNMOUNTS its dropdown as soon as the mouse leaves it — a
 * mouse move onto a modal is enough (the ML e2e answers its confirm by KEYBOARD
 * for exactly this reason). A dialog rendered by the row would vanish with it
 * and leave the label flow awaiting a promise nobody can settle, and the row's
 * own in-flight flag would reset on the next hover, re-enabling the buttons
 * mid-flow. Shopee's pickup question is a MOUSE picker on the MAIN path (SPX is
 * a pickup channel), so this is not cosmetic.
 *
 * So the host, mounted ONCE by `PedidosListView` outside every HoverCard, owns
 * three things and nothing else:
 *   - `confirm` — the awaitable confirm dialog (the posted-risk and
 *     direction-mismatch questions);
 *   - `escolherEnvio` — the Shopee pickup/drop-off question;
 *   - the in-flight map keyed by `pedidoId` — `emAndamento(pedidoId)` answers
 *     which action is running, and `executar` refuses a second run for a
 *     pedido that already has one.
 *
 * Rejected (R-f): Mantine `keepMounted` on the HoverCard — it would mount every
 * row's `EtiquetaRowAction`, each with its own `int_frete` query.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useEscolherEnvio } from '@/components/etiqueta/EscolherEnvioDialog';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';

import { useConfirmDialog, type ConfirmDialogOptions } from './ConfirmDialog';

/** Which etiqueta action a row is running. */
export type EtiquetaAcaoChave =
  | 'imprimir'
  | 'rastrear'
  | 'fetch-zpl2'
  | 'fetch-pdf'
  | 'generico-zpl2'
  | 'generico-pdf';

export interface EtiquetaAcaoContextValue {
  /** The awaitable confirm dialog; `true` = the operator confirmed. */
  confirm(opts: ConfirmDialogOptions): Promise<boolean>;
  /** The Shopee pickup/drop-off question (`EtiquetaProviderUi.escolherEnvio`). */
  escolherEnvio: EtiquetaProviderUi['escolherEnvio'];
  /** The action running for this pedido, or `null`. */
  emAndamento(pedidoId: string): EtiquetaAcaoChave | null;
  /**
   * Run `fn` as the pedido's `chave` action. A pedido that already has an
   * action in flight is REFUSED (nothing runs) — so a re-hovered row cannot
   * start a second label flow while the first one is still asking or waiting.
   * The flag clears when `fn` settles, whether it resolves or throws; a throw
   * propagates.
   */
  executar(pedidoId: string, chave: EtiquetaAcaoChave, fn: () => Promise<void>): Promise<void>;
}

export const EtiquetaAcaoContext = createContext<EtiquetaAcaoContextValue | null>(null);

/** The page host's value, or `null` outside one. */
export function useEtiquetaAcao(): EtiquetaAcaoContextValue | null {
  return useContext(EtiquetaAcaoContext);
}

/**
 * The host's state and its two dialog elements, as a hook. `EtiquetaAcaoHost`
 * provides it page-wide; a row rendered WITHOUT a host (an isolated test, a
 * future second mount point) builds its own instance and renders the elements
 * itself — the hooks stay unconditional either way.
 */
export function useEtiquetaAcaoValor(): { valor: EtiquetaAcaoContextValue; elementos: ReactNode } {
  const { confirm, element: confirmElement } = useConfirmDialog();
  const { escolherEnvio, element: escolherEnvioElement } = useEscolherEnvio();
  // The ref is the GUARD (read synchronously, so two clicks in the same tick
  // cannot both pass); the state is the RENDER copy.
  const emVooRef = useRef(new Map<string, EtiquetaAcaoChave>());
  const [emVoo, setEmVoo] = useState<ReadonlyMap<string, EtiquetaAcaoChave>>(() => new Map());

  const executar = useCallback(
    async (pedidoId: string, chave: EtiquetaAcaoChave, fn: () => Promise<void>) => {
      if (emVooRef.current.has(pedidoId)) return;
      emVooRef.current.set(pedidoId, chave);
      setEmVoo(new Map(emVooRef.current));
      try {
        await fn();
      } finally {
        emVooRef.current.delete(pedidoId);
        setEmVoo(new Map(emVooRef.current));
      }
    },
    [],
  );

  const valor = useMemo<EtiquetaAcaoContextValue>(
    () => ({
      confirm,
      escolherEnvio,
      emAndamento: (pedidoId) => emVoo.get(pedidoId) ?? null,
      executar,
    }),
    [confirm, escolherEnvio, emVoo, executar],
  );

  return {
    valor,
    elementos: (
      <>
        {confirmElement}
        {escolherEnvioElement}
      </>
    ),
  };
}

/** Mount once per page, outside every HoverCard. */
export function EtiquetaAcaoHost({ children }: { children: ReactNode }) {
  const { valor, elementos } = useEtiquetaAcaoValor();
  return (
    <EtiquetaAcaoContext.Provider value={valor}>
      {children}
      {elementos}
    </EtiquetaAcaoContext.Provider>
  );
}
