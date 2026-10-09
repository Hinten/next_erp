/**
 * The vocabulary module's own specs. `precoManual.test.ts` keeps its existing
 * `mensagemDe` cases untouched — that they still pass through the re-export is
 * the proof the move was behaviour-preserving — so this file covers what the
 * move newly makes assertable: that the table is COMPLETE against the codes the
 * price stack actually emits — including the four `NAO_ENUMERADO_*` codes, whose
 * emitter has lived in `anuncios/linksNaoEnumerados.ts` since #1200.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
   * properties. The narrow version found nothing at all in the reconciliation
   * walk — which emitted `return 'NAO_ENUMERADO_*'` then and spells them as
   * `CODIGO_NAO_ENUMERADO` property VALUES now (`anuncios/linksNaoEnumerados.ts`)
   * — and in `precoSync.ts`, which passes `'RECONCILIACAO_INCOMPLETA'`
   * positionally, so both files' cases passed over an empty set. Measured
   * against all four emitters, the ONLY non-motivo literals this shape picks up
   * are the `MERCADO_LIVRE_*` env names.
   */
  function codigosEmitidos(arquivo: string): string[] {
    const src = readFileSync(arquivo, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');
    return (
      [...src.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)]
        .map((m) => m[1]!)
        // Three prefixes are never motivos, measured across every file below:
        // `MERCADO_LIVRE_*` env names, `ML_*` route-level error codes
        // (`ML_CONTA_SEM_TABELA_NORMAL` is a 4xx code, not a skip reason), and
        // `STATUS_<x>`, which `mensagemDe`'s prefix arm serves without an entry.
        // With those three out, the scan below yields motivos and nothing else.
        .filter(
          (c) =>
            !c.startsWith('MERCADO_LIVRE_') && !c.startsWith('ML_') && !c.startsWith('STATUS_'),
        )
    );
  }

  /**
   * ⚠️ ROOTS, walked recursively — NOT a list of files.
   *
   * Two rounds of this check under-covered because the file list was
   * hand-maintained. First `precoReconciliacao.ts` and `precoSync.ts` yielded
   * zero because the regex only matched `code:`/`motivo:` properties. Then
   * `precoManual.ts` — which owns EIGHT of the table's entries — was simply
   * absent from the list, so deleting `ERRO_CANAL` left both suites green.
   * Enumerating files is the defect; a new emitter must be picked up without
   * anyone remembering to add it.
   *
   * The route directory is here because `atualizar-precos/route.ts` emits
   * `SEM_TABELA_NORMAL`, which no file under `preco/` does.
   *
   * ⚠️ The one FILE root is `anuncios/linksNaoEnumerados.ts`, and it is a file
   * rather than its directory on purpose. Since #1200 the four `NAO_ENUMERADO_*`
   * codes are emitted there (the walk moved out of `precoReconciliacao.ts` to be
   * shared with the monthly stock audit), so without it they would leave the
   * scan while every case here stayed green — the exact shape of both rounds
   * above. Walking all of `anuncios/` instead would sweep in the publish stack's
   * own UPPER_SNAKE literals, which are not price motivos. A file root that no
   * longer exists THROWS (ENOENT) rather than scanning nothing, so a rename or
   * move of that module reds this suite until the root follows it.
   */
  const RAIZES = [
    resolve(HERE),
    resolve(HERE, '../../../app/api/marketplace/mercado-livre/atualizar-precos'),
    resolve(HERE, '../anuncios/linksNaoEnumerados.ts'),
  ];

  function arquivosEmissores(): string[] {
    const out: string[] = [];
    const ehEmissor = (nome: string): boolean =>
      nome.endsWith('.ts') && !nome.endsWith('.test.ts') && nome !== 'precoMotivos.ts';
    const walk = (dir: string): void => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, entrada.name);
        if (entrada.isDirectory()) walk(p);
        else if (ehEmissor(entrada.name)) out.push(p);
      }
    };
    for (const raiz of RAIZES) {
      // `statSync` throws ENOENT on a missing root — loud, by design (above).
      if (statSync(raiz).isDirectory()) walk(raiz);
      else if (ehEmissor(basename(raiz))) out.push(raiz);
      else throw new Error(`precoMotivos.test: a raiz ${raiz} não é um emissor .ts`);
    }
    return out;
  }

  const porArquivo = arquivosEmissores()
    .map((f) => ({ arquivo: basename(f), codigos: [...new Set(codigosEmitidos(f))] }))
    .filter((e) => e.codigos.length > 0);

  // Two floors, because a scan that silently finds nothing reports "nothing
  // missing". They are on the DISCOVERY, not on any one file — the per-file
  // floors this replaces were themselves only as good as the list they ran over.
  it('the scan still discovers emitter files', () => {
    expect(porArquivo.length).toBeGreaterThanOrEqual(5);
  });

  it('the scan still discovers codes', () => {
    const todos = new Set(porArquivo.flatMap((e) => e.codigos));
    expect(todos.size).toBeGreaterThanOrEqual(20);
  });

  it('the shared link walk is scanned — all four NAO_ENUMERADO_* codes are discovered (#1200)', () => {
    // The two floors above cannot see this root go missing: four codes out of
    // twenty-odd, and the file count has slack. Pin the root by what it yields.
    const walk = porArquivo.find((e) => e.arquivo === 'linksNaoEnumerados.ts');
    expect(walk?.codigos.slice().sort()).toEqual([
      'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
      'NAO_ENUMERADO_LINK_EM_VARIACAO',
      'NAO_ENUMERADO_PAI_ID_INVALIDO',
      'NAO_ENUMERADO_PRODUTO_AUSENTE',
    ]);
  });

  it('every code emitted anywhere in the price stack has a message', () => {
    const semMensagem = porArquivo.flatMap((e) =>
      e.codigos
        .filter((c) => MENSAGEM_POR_MOTIVO[c] === undefined)
        .map((c) => `${c} (${e.arquivo})`),
    );

    expect(semMensagem).toEqual([]);
  });
});
