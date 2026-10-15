/**
 * Pure dispatcher for the #488 "criar troca" pre-save decision flow — the
 * dialog chain the saída create runs when `itensDevolvidos` is non-empty.
 * UI-agnostic on purpose (an injected `confirm`/`warn` pair instead of React)
 * so the branching is unit-testable; the view wires `useConfirmDialog` +
 * a Mantine toast into it.
 *
 * Legacy-faithful with three sanctioned deviations:
 *  - dialog 3 (emitir NF-e) is skipped when the devolução operação can't emit
 *    (legacy showed it even when useless) — a warning explains why;
 *  - dialog 3 is also skipped while an item lacks its reference to the origin
 *    NF-e's line (VC02-14, #1683): SEFAZ would refuse that emission with 321,
 *    so the warning sends the operator to the devolução's Fiscal tab instead;
 *  - declining dialog 1 falls through to the PLAIN create (no devolução),
 *    with the troca incidentes still firing afterwards.
 */

export interface DevolucaoDialogAnswers {
  /** False only when dialog 1 (duplicate devolução) was declined. */
  prosseguir: boolean;
  /** Create the entrada devolução atomically with the saída. */
  criarDevolucao: boolean;
  /** Emit the devolução NF-e after the commit. */
  emitirNfe: boolean;
}

export interface DevolucaoConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type DevolucaoConfirmFn = (opts: DevolucaoConfirmOptions) => Promise<boolean>;

/** The slice of `DevolucaoSavePrepared` the dialog chain consumes. */
export interface DevolucaoDialogsInput {
  temOutraDevolucao: boolean;
  operacao: { nome: string | null; fiscalCapable: boolean };
  /** Items the devolução would carry without a complete origin reference (#1683). */
  referenciasPendentes: number;
}

export async function runDevolucaoDialogs(
  prepared: DevolucaoDialogsInput,
  confirm: DevolucaoConfirmFn,
  warn: (msg: string) => void,
): Promise<DevolucaoDialogAnswers> {
  if (prepared.temOutraDevolucao) {
    const prosseguir = await confirm({
      title: 'Devolução duplicada',
      message: 'Já existe uma devolução para um dos pedidos selecionados. Deseja prosseguir?',
    });
    if (!prosseguir) return { prosseguir: false, criarDevolucao: false, emitirNfe: false };
  }

  const criarDevolucao = await confirm({
    title: 'Criar devolução',
    message: 'Deseja criar uma devolução para os itens devolvidos?',
  });
  if (!criarDevolucao) return { prosseguir: true, criarDevolucao: false, emitirNfe: false };

  if (!prepared.operacao.fiscalCapable) {
    warn(
      `A operação "${prepared.operacao.nome ?? 'sem operação'}" não permite emissão de NF-e ` +
        'de devolução (não fiscal ou finNFe ≠ 4) — a devolução será criada sem NF-e.',
    );
    return { prosseguir: true, criarDevolucao: true, emitirNfe: false };
  }

  if (prepared.referenciasPendentes > 0) {
    const n = prepared.referenciasPendentes;
    warn(
      `${n} ${n === 1 ? 'item da devolução está' : 'itens da devolução estão'} sem a referência ` +
        'ao item da NF-e de origem — a devolução será criada sem NF-e. Complete na aba Fiscal ' +
        'da devolução ("Preencher a partir das NF-e de origem") e emita por lá.',
    );
    return { prosseguir: true, criarDevolucao: true, emitirNfe: false };
  }

  const emitirNfe = await confirm({
    title: 'Emitir NF-e',
    message: 'Deseja emitir uma NF-e para a devolução?',
  });
  return { prosseguir: true, criarDevolucao: true, emitirNfe };
}
