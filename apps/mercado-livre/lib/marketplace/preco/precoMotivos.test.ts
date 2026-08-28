/**
 * The vocabulary module's own specs. `precoManual.test.ts` keeps its existing
 * `mensagemDe` cases untouched — that they still pass through the re-export is
 * the proof the move was behaviour-preserving — so this file covers what the
 * move newly makes assertable: that the table is COMPLETE against the codes the
 * price stack actually emits.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MENSAGEM_POR_MOTIVO, mensagemDe } from './precoMotivos';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('mensagemDe', () => {
  it('names the cause AND the remedy, not just the cause', () => {
    // The reason the table exists at all: a bare code is not actionable.
    expect(mensagemDe('PRECO_NAO_MODIFICAVEL')).toContain('Desative a automação');
    expect(mensagemDe('PRECO_ANTIGO_MAIOR')).toContain('Permitir baixar preços');
    expect(mensagemDe('PRECO_NAO_ENCONTRADO')).toContain('Preencha o preço');
  });

  it('names the status back for the open-ended STATUS_ prefix', () => {
    // `podeEnviarPreco` emits `STATUS_<x>` for anything outside its accept set,
    // so the table cannot enumerate them.
    expect(mensagemDe('STATUS_payment_required')).toContain('payment_required');
  });

  it('falls back rather than throwing on a code it has never seen', () => {
    expect(mensagemDe('QUALQUER_COISA')).toBe('Não enviado.');
  });

  it('⚠️ the fallback is not a silent catch-all for a KNOWN code', () => {
    // The control for the case above. Without it, deleting the whole table
    // would still pass every "does not throw" assertion.
    expect(mensagemDe('SEM_LINK')).not.toBe('Não enviado.');
  });
});

describe('the table covers the codes the price stack emits', () => {
  /**
   * Read the codes out of the emitters rather than restating them: a hand-kept
   * list drifts the day someone adds a skip reason, which is exactly when the
   * operator gets an unexplained code.
   *
   * ⚠️ Matches ANY single-quoted UPPER_SNAKE literal, not `code:`/`motivo:`
   * properties. The narrow version found nothing at all in `precoReconciliacao.ts`
   * — which emits `return 'NAO_ENUMERADO_*'` — and in `precoSync.ts`, which
   * passes `'RECONCILIACAO_INCOMPLETA'` positionally, so both files' cases
   * passed over an empty set. Measured against all four emitters, the ONLY
   * non-motivo literals this shape picks up are the `MERCADO_LIVRE_*` env names.
   */
  function codigosEmitidos(arquivo: string): string[] {
    const src = readFileSync(resolve(HERE, arquivo), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');
    return [...src.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)]
      .map((m) => m[1]!)
      .filter((c) => !c.startsWith('MERCADO_LIVRE_'));
  }

  /** Emitter file → the minimum number of codes it is known to emit. */
  const emissores: ReadonlyArray<readonly [string, number]> = [
    ['precoPlan.ts', 7],
    ['precoDraftSend.ts', 7],
    ['precoReconciliacao.ts', 4],
    ['precoSync.ts', 1],
  ];

  // ⚠️ A FLOOR per file, not one total. The first version of this suite asserted
  // only that the extractor found codes overall, and `precoReconciliacao.ts`
  // contributed zero while its own case reported "nothing missing" — a green
  // check over an empty set. A per-file minimum is what makes each case mean
  // something.
  it.each(emissores)('%s still yields at least %i codes for the check below', (arquivo, minimo) => {
    expect(codigosEmitidos(arquivo).length).toBeGreaterThanOrEqual(minimo);
  });

  it.each(emissores)('every UPPER_SNAKE code emitted by %s has a message', (arquivo) => {
    const semMensagem = [...new Set(codigosEmitidos(arquivo))]
      // `STATUS_<x>` is served by the prefix arm, not by an entry.
      .filter((c) => !c.startsWith('STATUS_'))
      .filter((c) => MENSAGEM_POR_MOTIVO[c] === undefined);

    expect(semMensagem).toEqual([]);
  });
});
