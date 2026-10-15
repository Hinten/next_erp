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
 * four things and nothing else:
 *   - `confirm` — the awaitable confirm dialog (the posted-risk and
 *     direction-mismatch questions);
 *   - `escolherEnvio` — the Shopee pickup/drop-off question;
 *   - the question QUEUE both of them go through (below);
 *   - the in-flight map keyed by `pedidoId` — `emAndamento(pedidoId)` answers
 *     which action is running, and `executar` refuses a second run for a
 *     pedido that already has one.
 *
 * ⚠️ The queue (#1523 review 2, Q2-F1): the in-flight guard is PER PEDIDO, so
 * pedido B's flow runs while A's is still asking — batch printing is the point.
 * But there is ONE dialog of each kind for the whole page, and each dialog
 * answers a still-open question as cancelled when a new one arrives. Without
 * the queue, B's question silently resolved A's as `null`: A ended `skipped`
 * (a silent outcome on the row), and the operator answered B's question
 * believing it was A's. So every question — confirm AND pickup, in ONE FIFO —
 * waits for the previous one's answer; only one is ever on screen, and its
 * title names its pedido (`pedidoRotulo`). A question still queued when the
 * page unmounts is answered as cancelled, like the open one, so no flow hangs.
 *
 * Rejected (R-f): Mantine `keepMounted` on the HoverCard — it would mount every
 * row's `EtiquetaRowAction`, each with its own `int_frete` query.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  /** The awaitable confirm dialog; `true` = the operator confirmed. Queued FIFO. */
  confirm(opts: ConfirmDialogOptions): Promise<boolean>;
  /** The Shopee pickup/drop-off question (`EtiquetaProviderUi.escolherEnvio`). Queued FIFO. */
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
  const { confirm: abrirConfirm, element: confirmElement } = useConfirmDialog();
  const { escolherEnvio: abrirEscolherEnvio, element: escolherEnvioElement } = useEscolherEnvio();
  // The ref is the GUARD (read synchronously, so two clicks in the same tick
  // cannot both pass); the state is the RENDER copy.
  const emVooRef = useRef(new Map<string, EtiquetaAcaoChave>());
  const [emVoo, setEmVoo] = useState<ReadonlyMap<string, EtiquetaAcaoChave>>(() => new Map());

  // The question FIFO (see the module doc): the tail of the chain, which never
  // rejects, so one failed question cannot wedge every later one.
  const filaRef = useRef<Promise<void>>(Promise.resolve());
  // Every question not yet answered (queued or open) → its "answer cancelled".
  const pendentesRef = useRef(new Set<() => void>());
  const montadoRef = useRef(false);
  useEffect(() => {
    montadoRef.current = true;
    const pendentes = pendentesRef.current;
    return () => {
      montadoRef.current = false;
      // ⚠️ The confirm dialog does not settle on unmount (the pickup one does),
      // so an open confirm would otherwise hold every question queued behind it.
      for (const cancelar of [...pendentes]) cancelar();
    };
  }, []);

  /**
   * Open `perguntar` once every earlier question has been answered. A question
   * asked after the host unmounted, or still unanswered when it does, answers
   * `cancelado` (and a queued one never opens) — the dialogs are gone.
   */
  const enfileirar = useCallback(<T,>(perguntar: () => Promise<T>, cancelado: T): Promise<T> => {
    if (!montadoRef.current) return Promise.resolve(cancelado);
    const vez = new Promise<T>((resolve, reject) => {
      let encerrada = false;
      const cancelar = () => {
        encerrada = true;
        pendentesRef.current.delete(cancelar);
        resolve(cancelado);
      };
      pendentesRef.current.add(cancelar);
      void filaRef.current
        .then(() => (encerrada ? cancelado : perguntar()))
        .then(resolve, reject)
        .finally(() => pendentesRef.current.delete(cancelar));
    });
    // The CALLER still sees a rejection; only the queue's tail ignores it.
    filaRef.current = vez.then(
      () => undefined,
      () => undefined,
    );
    return vez;
  }, []);

  const confirm = useCallback(
    (opts: ConfirmDialogOptions) => enfileirar(() => abrirConfirm(opts), false),
    [enfileirar, abrirConfirm],
  );
  const escolherEnvio = useCallback<EtiquetaProviderUi['escolherEnvio']>(
    (pergunta) => enfileirar(() => abrirEscolherEnvio(pergunta), null),
    [enfileirar, abrirEscolherEnvio],
  );

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
