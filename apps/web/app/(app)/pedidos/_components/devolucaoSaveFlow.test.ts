/**
 * Unit tests for the #488 pre-save dialog chain (`runDevolucaoDialogs`).
 * Pure function — fake `confirm`/`warn` fns, no DOM, no Firestore.
 */
import { describe, expect, it, vi } from 'vitest';

import { runDevolucaoDialogs, type DevolucaoDialogsInput } from './devolucaoSaveFlow';

function input(
  over: Partial<DevolucaoDialogsInput['operacao']> & { temOutraDevolucao?: boolean } = {},
): DevolucaoDialogsInput {
  return {
    temOutraDevolucao: over.temOutraDevolucao ?? false,
    operacao: {
      nome: 'nome' in over ? (over.nome ?? null) : 'Devolução de venda',
      fiscalCapable: over.fiscalCapable ?? true,
    },
  };
}

/** A confirm fake answering in call order; records the dialog titles. */
function confirmStub(answers: boolean[]) {
  const fn = vi.fn(
    async (_opts: { title: string; message: string }) => answers[fn.mock.calls.length - 1] ?? false,
  );
  const titles = () => fn.mock.calls.map(([opts]) => opts.title);
  return { fn, titles };
}

describe('runDevolucaoDialogs', () => {
  it('accepted chain (with duplicate warning) answers all true', async () => {
    const { fn, titles } = confirmStub([true, true, true]);
    const warn = vi.fn();

    const answers = await runDevolucaoDialogs(input({ temOutraDevolucao: true }), fn, warn);

    expect(answers).toEqual({ prosseguir: true, criarDevolucao: true, emitirNfe: true });
    expect(titles()).toEqual(['Devolução duplicada', 'Criar devolução', 'Emitir NF-e']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips dialog 1 when temOutraDevolucao=false', async () => {
    const { fn, titles } = confirmStub([true, true]);

    const answers = await runDevolucaoDialogs(input(), fn, vi.fn());

    expect(answers).toEqual({ prosseguir: true, criarDevolucao: true, emitirNfe: true });
    expect(titles()).toEqual(['Criar devolução', 'Emitir NF-e']);
  });

  it('dialog 1 = Não short-circuits to the plain create (confirm called exactly once)', async () => {
    const { fn, titles } = confirmStub([false]);
    const warn = vi.fn();

    const answers = await runDevolucaoDialogs(input({ temOutraDevolucao: true }), fn, warn);

    expect(answers).toEqual({ prosseguir: false, criarDevolucao: false, emitirNfe: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(['Devolução duplicada']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('dialog 2 = Não creates no devolução and never reaches dialog 3', async () => {
    const { fn, titles } = confirmStub([false]);
    const warn = vi.fn();

    const answers = await runDevolucaoDialogs(input(), fn, warn);

    expect(answers).toEqual({ prosseguir: true, criarDevolucao: false, emitirNfe: false });
    expect(titles()).toEqual(['Criar devolução']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('misconfigured operação: no dialog 3, warn called once, emitirNfe=false', async () => {
    const { fn, titles } = confirmStub([true]);
    const warn = vi.fn();

    const answers = await runDevolucaoDialogs(input({ fiscalCapable: false }), fn, warn);

    expect(answers).toEqual({ prosseguir: true, criarDevolucao: true, emitirNfe: false });
    expect(titles()).toEqual(['Criar devolução']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Devolução de venda"'));
  });

  it('misconfigured operação without nome names it "sem operação"', async () => {
    const { fn } = confirmStub([true]);
    const warn = vi.fn();

    await runDevolucaoDialogs(input({ fiscalCapable: false, nome: null }), fn, warn);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"sem operação"'));
  });

  it('declined dialog 3 keeps the devolução but not the NF-e', async () => {
    const { fn, titles } = confirmStub([true, false]);

    const answers = await runDevolucaoDialogs(input(), fn, vi.fn());

    expect(answers).toEqual({ prosseguir: true, criarDevolucao: true, emitirNfe: false });
    expect(titles()).toEqual(['Criar devolução', 'Emitir NF-e']);
  });
});
