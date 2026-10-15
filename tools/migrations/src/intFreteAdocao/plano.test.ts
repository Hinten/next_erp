import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { adocaoIntFrete } from './plano';

/**
 * The shared pass's own pins. Its BEHAVIOUR is pinned per channel, through each binding: Shopee's
 * `2026-10-shopee-int-frete/transform.test.ts` (unedited since the extraction) and Loja
 * Integrada's `2026-10-li-int-frete/transform.test.ts`.
 */

const PASTA = new URL('./', import.meta.url);

/** Every source file of this folder — listed, never named, so a new file is scanned too. */
function fontesDaPasta(): string[] {
  return readdirSync(PASTA)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

describe('the shared pass reads no clock', () => {
  it('lists the files it scans — the plan and the I/O at least, so the scan is never vacuous', () => {
    expect(fontesDaPasta()).toEqual(expect.arrayContaining(['executar.ts', 'plano.ts']));
  });

  it('no source file of intFreteAdocao/ spells a clock read', () => {
    // The channel folders' transform.ts / backfill.ts are thin bindings now: a scan of them alone
    // would pass whatever this folder did.
    for (const arquivo of fontesDaPasta()) {
      const fonte = readFileSync(new URL(arquivo, PASTA), 'utf8');
      expect(fonte, arquivo).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    }
  });
});

describe('adocaoIntFrete — what it binds', () => {
  it('names the runbook it is bound with in the STOP message', () => {
    const adocao = adocaoIntFrete(intFreteContaSync(VINCULO_INT_FRETE_CONTA.lojaIntegrada), {
      runbook: 'li-int-frete.README.md',
    });
    const msg = adocao.mensagemDeParada({
      duplicados: ['int-1'],
      naoCanonicos: [],
      compartilhados: [],
    });
    expect(msg).toContain('Veja li-int-frete.README.md.');
    expect(msg).not.toContain('shopee');
  });

  it('keeps the binding object itself, so the apply leg reconciles through it', () => {
    const sync = intFreteContaSync(VINCULO_INT_FRETE_CONTA.shopee);
    expect(adocaoIntFrete(sync, { runbook: 'x.md' }).sync).toBe(sync);
  });

  it('refuses a row with no prefixoDocId: the pass rests on the deterministic-id fallback', () => {
    // A row without one creates at a random id, so every applied `criar` would read as a
    // divergence and the non-canonical-ref verdict would have no deterministic doc to reason
    // about. Every production row carries one since #1921 (Mercado Livre included), so the
    // refused row is the Shopee row with its prefix taken away.
    const { prefixoDocId: _semPrefixo, ...semPrefixo } = VINCULO_INT_FRETE_CONTA.shopee;
    expect(() => adocaoIntFrete(intFreteContaSync(semPrefixo), { runbook: 'x.md' })).toThrow(
      /prefixoDocId/,
    );
  });
});
