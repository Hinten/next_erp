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
 * five things and nothing else:
 *   - `confirm` — the awaitable confirm dialog (the posted-risk and
 *     direction-mismatch questions, and — with `ciencia: true` — the Loja
 *     Integrada paid re-check's "Estou ciente do risco" warning);
 *   - `escolherEnvio` — the Shopee pickup/drop-off question;
 *   - `escolherTransportadora` — the Loja Integrada "Escolher transportadora…"
 *     picker (master plan step 15), which names ONE pedido's label target;
 *   - the in-flight map keyed by `pedidoId` — `emAndamento(pedidoId)` answers
 *     which action is running, and `executar` refuses a second run for a
 *     pedido that already has one;
 *   - the ROUTED-FRETE map keyed by `pedidoId` — `registrarRota(pedidoId,
 *     registro)` keeps the route a routing call just wrote, and
 *     `rotaConhecida(pedidoId)` hands it to the row's next mount.
 * All three questions go through ONE queue (below).
 *
 * ⚠️ The queue (#1523 review 2, Q2-F1): the in-flight guard is PER PEDIDO, so
 * pedido B's flow runs while A's is still asking — batch printing is the point.
 * But there is ONE dialog of each kind for the whole page, and each dialog
 * answers a still-open question as cancelled when a new one arrives. Without
 * the queue, B's question silently resolved A's as `null`: A ended `skipped`
 * (a silent outcome on the row), and the operator answered B's question
 * believing it was A's. So every question — confirm, pickup AND carrier, in ONE
 * FIFO — waits for the previous one's answer; only one is ever on screen, and
 * its title names its pedido (`pedidoRotulo`). A question still queued when the
 * page unmounts is answered as cancelled, like the open one, so no flow hangs.
 *
 * ⚠️ Why the routed-frete map (B14): the routing route re-points the pedido
 * server-side and writes no `ultimaModificacao` — and with any filter or header
 * sort `/pedidos` reads through the one-shot transport — so the list row can
 * keep showing the pre-routing freight for the rest of the page's life. The
 * row's HoverCard remounts on every hover, so a route the row itself
 * remembered would be forgotten on the next mouse move. The host outlives
 * both; the row reads its freight through {@link freteComRotaConhecida}.
 *
 * ⚠️ A registration stands in for the list ONLY while the list copy is stale —
 * while it still holds the ref the route superseded (`refAnterior`). On the
 * live transport the list catches up, and later writes keep arriving (a label
 * bought right after routing writes `printLabelId`): a registration that won
 * for the rest of the page's life would hide them, and the row would offer
 * "Comprar etiqueta" again over a bought label. So it keeps the ROUTING FIELDS
 * only, laid over the LIVE list copy, and the list wins whole the moment its
 * ref moves on.
 *
 * Rejected (R-f): Mantine `keepMounted` on the HoverCard — it would mount every
 * row's `EtiquetaRowAction`, each with its own `int_frete` query. Rejected
 * (B14): a row-level refresh hook in `packages/ui`.
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
import type { FreteDoPedido, RespostaRotaEtiquetaLi } from '@delfrance/schemas';

import { useEscolherEnvio } from '@/components/etiqueta/EscolherEnvioDialog';
import {
  useEscolherTransportadora,
  type PerguntaDeTransportadora,
  type RespostaDeTransportadora,
} from '@/components/etiqueta/EscolherTransportadoraDialog';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';

import { useConfirmDialog, type ConfirmDialogOptions } from './ConfirmDialog';

/** Which etiqueta action a row is running. */
export type EtiquetaAcaoChave =
  | 'imprimir'
  | 'rastrear'
  | 'fetch-zpl2'
  | 'fetch-pdf'
  | 'generico-zpl2'
  | 'generico-pdf'
  /** The Loja Integrada routing call ("Definir transportadora" / "Escolher transportadora…"). */
  | 'rotear';

/** The routing fields a Loja Integrada routing call answered (`resposta.rota`). */
export type RotaDoPedidoLi = Extract<RespostaRotaEtiquetaLi, { tipo: 'roteado' }>['rota'];

/** What a routing call registered for one pedido. */
export interface RotaRegistrada {
  /**
   * The `integracaoFreteOuterRef` the row's freight held when it asked — the
   * value the route superseded. The registration stands in for the list ONLY
   * while the list copy still holds exactly this value.
   */
  readonly refAnterior: FreteDoPedido['integracaoFreteOuterRef'];
  /** The routing fields the route answered, as written or as found. */
  readonly rota: RotaDoPedidoLi;
}

/**
 * The freight a row shows: the LIST's copy, with a registered route's routing
 * fields laid over it while that copy is still the one the route superseded
 * (its `integracaoFreteOuterRef` exactly the registration's `refAnterior`).
 * Once the list's ref moves on — it caught up with the route, or anything
 * re-pointed the pedido since — the list copy wins WHOLE, so no later write is
 * ever hidden. An estado the route did not know (`null` on the wire) keeps the
 * list's.
 */
export function freteComRotaConhecida(
  freteDaLista: FreteDoPedido | null,
  registro: RotaRegistrada | null,
): FreteDoPedido | null {
  if (registro === null || freteDaLista === null) return freteDaLista;
  if (freteDaLista.integracaoFreteOuterRef !== registro.refAnterior) return freteDaLista;
  const { rota } = registro;
  return {
    ...freteDaLista,
    integracaoFreteOuterRef: rota.integracaoFreteOuterRef,
    externalOptionId: rota.externalOptionId,
    integracaoTargetOuterRef: rota.integracaoTargetOuterRef,
    estado: rota.estado ?? freteDaLista.estado,
  };
}

export interface EtiquetaAcaoContextValue {
  /**
   * The awaitable confirm dialog; `true` = the operator confirmed. Queued FIFO.
   * `ciencia: true` requires the "Estou ciente do risco" tick first.
   */
  confirm(opts: ConfirmDialogOptions): Promise<boolean>;
  /** The Shopee pickup/drop-off question (`EtiquetaProviderUi.escolherEnvio`). Queued FIFO. */
  escolherEnvio: EtiquetaProviderUi['escolherEnvio'];
  /**
   * The Loja Integrada carrier picker: the chosen `int_frete` doc id, or `null`
   * (cancelled). Queued FIFO with the other questions.
   */
  escolherTransportadora(p: PerguntaDeTransportadora): Promise<RespostaDeTransportadora>;
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
  /**
   * The route a routing call registered for this pedido, or `null` when none
   * did — the row reads `freteComRotaConhecida(pedido.freteInicial,
   * rotaConhecida(pedidoId))`.
   */
  rotaConhecida(pedidoId: string): RotaRegistrada | null;
  /**
   * Keep the route a routing call just wrote — the ref it superseded and the
   * routing fields it answered — for the rest of the page's life. The LATEST
   * registration for a pedido wins; it only ever stands in for a STALE list
   * copy ({@link freteComRotaConhecida}).
   */
  registrarRota(pedidoId: string, registro: RotaRegistrada): void;
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
  const {
    escolherTransportadora: abrirEscolherTransportadora,
    element: escolherTransportadoraElement,
  } = useEscolherTransportadora();
  // The ref is the GUARD (read synchronously, so two clicks in the same tick
  // cannot both pass); the state is the RENDER copy.
  const emVooRef = useRef(new Map<string, EtiquetaAcaoChave>());
  const [emVoo, setEmVoo] = useState<ReadonlyMap<string, EtiquetaAcaoChave>>(() => new Map());
  // The registered route per pedido (see the module doc). State, so a row that
  // is still mounted repaints the moment its route is registered.
  const [rotas, setRotas] = useState<ReadonlyMap<string, RotaRegistrada>>(() => new Map());

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
  const escolherTransportadora = useCallback(
    (pergunta: PerguntaDeTransportadora) =>
      enfileirar<RespostaDeTransportadora>(() => abrirEscolherTransportadora(pergunta), null),
    [enfileirar, abrirEscolherTransportadora],
  );
  const registrarRota = useCallback((pedidoId: string, registro: RotaRegistrada) => {
    setRotas((atual) => new Map(atual).set(pedidoId, registro));
  }, []);

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
      escolherTransportadora,
      emAndamento: (pedidoId) => emVoo.get(pedidoId) ?? null,
      executar,
      rotaConhecida: (pedidoId) => rotas.get(pedidoId) ?? null,
      registrarRota,
    }),
    [confirm, escolherEnvio, escolherTransportadora, emVoo, executar, rotas, registrarRota],
  );

  return {
    valor,
    elementos: (
      <>
        {confirmElement}
        {escolherEnvioElement}
        {escolherTransportadoraElement}
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
