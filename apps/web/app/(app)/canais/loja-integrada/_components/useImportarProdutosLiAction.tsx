'use client';

/**
 * "Importar produtos da loja" (master plan step 9) as a TableView action over
 * the selected Loja Integrada contas — the Shopee import's shape
 * (`canais/shopee/_components/useImportarTodosShopeeAction.tsx`): the hook
 * returns the `ActionConfig` plus the state its dialog and the rail render, and
 * the page mounts the dialog (`DialogoImportacaoLi.tsx`) as a sibling of
 * `<TableView>`.
 *
 * One job per conta, each on its own: the shared fan-out
 * (`lib/marketplace/contaJobs`) starts them all, a conta whose start fails costs
 * the others nothing, and a throwable this channel's describer does not own is
 * rethrown only after the contas that did start are committed (root `CLAUDE.md`
 * rule 6).
 *
 * ⚠️ A busy start ATTACHES instead of failing. The backend runs one import per
 * conta and its 409 names the running job; `useAcoesImportacaoLi().iniciar`
 * turns exactly that answer into the running `jobId` (`reatado: true`), so the
 * rail follows it — a card the operator can watch and cancel, never an error.
 * The id lands in `reatados`, and its card says the options picked now were NOT
 * applied.
 *
 * ## Hidden cards
 *
 * The cards the operator dismissed live HERE, not in the rail's panel: the rail
 * unmounts and remounts the panel each time it is collapsed or expanded, which
 * would bring every dismissed card back. Dismissing a job card hides that JOB
 * (by id) for the session and forgets the start that named it; a start that
 * names the job again — a busy start's 409 attaching to it — shows it again
 * (`ImportacoesLiPanel.tsx`).
 */
import { useCallback, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { Integracao } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import {
  type EntradaOpcoesImportacaoLi,
  useBackendLojaIntegrada,
} from '@/lib/loja-integrada/client';
import { mensagemBackendIndisponivel } from '@/lib/loja-integrada/erros';
import {
  describeImportacaoLiStartError,
  useAcoesImportacaoLi,
} from '@/lib/loja-integrada/importacao';
import {
  type ContaJobOutcome,
  type ContaRef,
  type JobErrorDescription,
  contaRefFromRow,
} from '@/lib/marketplace/contaJobs/types';
import { useContaJobFan } from '@/lib/marketplace/contaJobs/useContaJobFan';

/** The action's id in the TableView rail. */
export const ID_ACAO_IMPORTAR_PRODUTOS_LI = 'loja-integrada-importar-produtos';

/**
 * What one conta's start came to: a job to follow — fresh, or the running one
 * a busy start attached to (`reatado`: the options were NOT applied) — or the
 * failure's copy, the same as its card in the rail.
 */
export type DesfechoInicioLi =
  | {
      readonly kind: 'started';
      readonly conta: ContaRef;
      readonly jobId: string;
      readonly reatado: boolean;
    }
  | {
      readonly kind: 'error';
      readonly conta: ContaRef;
      readonly color: JobErrorDescription['color'];
      readonly message: string;
    };

/** The job cards hidden this session, and the dismiss that hides one. */
export interface DispensasDeJobLi {
  /** The jobIds whose card the operator dismissed. */
  readonly dispensados: ReadonlySet<string>;
  /**
   * Hide a job's card: the job's id joins `dispensados`, and a STARTED ledger
   * entry naming that job is dismissed with it. A failure in the ledger is the
   * card BESIDE the job's, and is dismissed on its own.
   */
  readonly dispensarJob: (contaId: string, jobId: string) => void;
}

/** The dismissals over a ledger, kept by whoever outlives the panel (module header). */
export function useDispensasDeJobLi(
  entries: readonly ContaJobOutcome[],
  dismiss: (contaId: string) => void,
): DispensasDeJobLi {
  const [dispensados, setDispensados] = useState<ReadonlySet<string>>(new Set());
  const dispensarJob = useCallback(
    (contaId: string, jobId: string) => {
      const entrada = entries.find((e) => e.conta.id === contaId);
      if (entrada?.kind === 'started' && entrada.jobId === jobId) dismiss(contaId);
      setDispensados((cur) => new Set(cur).add(jobId));
    },
    [entries, dismiss],
  );
  return { dispensados, dispensarJob };
}

export interface ImportarProdutosLiActionState extends DispensasDeJobLi {
  readonly opened: boolean;
  /** The contas captured when the action fired — the dialog lists them. */
  readonly contas: readonly ContaRef[];
  /** A start is in flight — the dialog's confirm stays disabled. */
  readonly busy: boolean;
  /** One entry per conta touched this session (the fan-out's ledger). */
  readonly entries: readonly ContaJobOutcome[];
  /** Jobs this session ATTACHED to through a busy start's 409 — their cards say so. */
  readonly reatados: ReadonlySet<string>;
  readonly close: () => void;
  /** The dialog's confirm: starts for the contas the action captured, then closes the dialog. */
  readonly start: (opcoes: EntradaOpcoesImportacaoLi) => Promise<void>;
  /**
   * A start for any contas, through the same ledger, attach and rethrow — what
   * the result view's "Importar selecionados" calls with `alvo: selecionados`.
   * The dialog is left as it is. Resolves with each conta's outcome (input
   * order), so the caller can tell a fresh start from an attach or a failure;
   * with no client it starts nothing, says so, and resolves `[]`.
   */
  readonly iniciar: (
    contas: readonly ContaRef[],
    opcoes: EntradaOpcoesImportacaoLi,
  ) => Promise<readonly DesfechoInicioLi[]>;
  readonly dismiss: (contaId: string) => void;
}

interface DialogState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
}

const FECHADO: DialogState = { opened: false, contas: [] };

const SEM_SESSAO = 'Faça login novamente para usar as ações da Loja Integrada.';

export function useImportarProdutosLiAction(): {
  readonly action: ActionConfig<Integracao>;
  readonly state: ImportarProdutosLiActionState;
} {
  const { indisponivel } = useBackendLojaIntegrada();
  const acoes = useAcoesImportacaoLi();
  const fan = useContaJobFan(describeImportacaoLiStartError);
  const [dialog, setDialog] = useState<DialogState>(FECHADO);
  const [reatados, setReatados] = useState<ReadonlySet<string>>(new Set());
  const dispensas = useDispensasDeJobLi(fan.entries, fan.dismiss);

  const semCliente = useCallback(() => {
    notifications.show({
      color: 'red',
      message: indisponivel === null ? SEM_SESSAO : mensagemBackendIndisponivel(indisponivel),
    });
  }, [indisponivel]);

  const action = useMemo<ActionConfig<Integracao>>(
    () => ({
      id: ID_ACAO_IMPORTAR_PRODUTOS_LI,
      label: 'Importar produtos da loja',
      requiresSelection: true,
      // No `maxSelection`: each conta's job reads its own store, under its own
      // store's quota, and gets its own card. The reads queue they share is sized
      // for several imports at once (`importacao/orcamento.ts` in
      // `apps/loja-integrada`).
      //
      // No `confirm` (the options dialog IS the confirmation), no
      // `refreshOnComplete` (a start writes no integração doc, and a refresh would
      // clear the selection the panel reads).
      run: (rows) => {
        if (!acoes) {
          semCliente();
          return;
        }
        setDialog({ opened: true, contas: rows.map(contaRefFromRow) });
      },
    }),
    [acoes, semCliente],
  );

  const close = useCallback(() => {
    setDialog((cur) => ({ ...cur, opened: false }));
  }, []);

  const iniciar = useCallback<ImportarProdutosLiActionState['iniciar']>(
    async (contas, opcoes) => {
      if (!acoes) {
        semCliente();
        return [];
      }
      const reatadasDaVez = new Set<string>();
      const desfechos = await fan.run(contas, async (contaId) => {
        const inicio = await acoes.iniciar(contaId, opcoes);
        if (inicio.reatado) {
          reatadasDaVez.add(contaId);
          setReatados((cur) => new Set(cur).add(inicio.jobId));
        }
        return { jobId: inicio.jobId };
      });
      return desfechos.map(
        (d): DesfechoInicioLi =>
          d.kind === 'started' ? { ...d, reatado: reatadasDaVez.has(d.conta.id) } : d,
      );
    },
    [acoes, fan, semCliente],
  );

  const start = useCallback(
    async (opcoes: EntradaOpcoesImportacaoLi) => {
      await iniciar(dialog.contas, opcoes);
      setDialog(FECHADO);
    },
    [dialog.contas, iniciar],
  );

  return {
    action,
    state: {
      opened: dialog.opened,
      contas: dialog.contas,
      busy: fan.busy,
      entries: fan.entries,
      reatados,
      close,
      start,
      iniciar,
      dismiss: fan.dismiss,
      dispensados: dispensas.dispensados,
      dispensarJob: dispensas.dispensarJob,
    },
  };
}
