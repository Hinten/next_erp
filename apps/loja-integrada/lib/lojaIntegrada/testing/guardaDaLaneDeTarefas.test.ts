/**
 * The D17 refusals of the emulator lane (`ci-loja-integrada.yml`), proved
 * OFFLINE — in `CI test`, where every unit test of this app runs unfiltered.
 * The setup that runs them (`vitest.tasks.setup.ts`) throws on import under
 * `CI` without an emulator host, so it can be read here but never imported;
 * the last block pins that it calls each refusal and throws on its answer.
 *
 * Since master plan step 7 the lane's job env sets the write valve to
 * `dry-run`, so the refusals cover the write side too: no write valve exactly
 * `on` and no non-blank canary list, in the shell or in the artifact's env
 * files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CANARIO_ENV_LI, CHAMADAS_ENV_LI, VALVULA_ENV_LI } from '../core/valvulas';
import {
  CHAVE_DE_CHAMADAS_DA_LANE,
  DIRETORIO_DO_ARTEFATO_LI,
  type LeitorDoArtefato,
  PREFIXO_DAS_VALVULAS_DA_LANE,
  PREFIXO_DOS_CANARIOS_DA_LANE,
  chamadasLigadasNoAmbiente,
  envsDoArtefatoQueLigamEscritas,
  envsDoArtefatoQueNomeiamAChave,
  escritasLigadasNoAmbiente,
} from './guardaDaLaneDeTarefas';

const RAIZ_APP = fileURLToPath(new URL('../../..', import.meta.url));
const RAIZ_REPO = fileURLToPath(new URL('../../../../..', import.meta.url));

/** An in-memory artifact: file name → text. */
function artefato(arquivos: Record<string, string> | null): LeitorDoArtefato {
  return {
    existe: () => arquivos !== null,
    listar: () => Object.keys(arquivos ?? {}),
    ler: (caminho) => {
      const nome = caminho.split(/[\\/]/).pop() ?? '';
      const texto = arquivos?.[nome];
      if (texto === undefined) throw new Error(`teste: ${nome} não existe`);
      return texto;
    },
  };
}

describe('the names, spelled out — and equal to the loader’s', () => {
  it('the read switch is the loader’s own variable', () => {
    expect(CHAVE_DE_CHAMADAS_DA_LANE).toBe(CHAMADAS_ENV_LI);
  });

  it('every write valve and every canary list falls under the guard’s prefix — none escapes it', () => {
    const valvulas = Object.values(VALVULA_ENV_LI);
    const canarios = Object.values(CANARIO_ENV_LI);
    // ÂNCORA: the loader has the flows the guard means.
    expect(valvulas).toContain('LOJA_INTEGRADA_MODO_RASTREIO');
    expect(canarios).toContain('LOJA_INTEGRADA_CANARIO_RASTREIO');
    for (const v of valvulas) expect(v.startsWith(PREFIXO_DAS_VALVULAS_DA_LANE), v).toBe(true);
    for (const c of canarios) expect(c.startsWith(PREFIXO_DOS_CANARIOS_DA_LANE), c).toBe(true);
  });

  it('the artifact is the `source` of the emulator config', () => {
    const config = JSON.parse(
      readFileSync(join(RAIZ_REPO, 'firebase.loja-integrada.tasks.json'), 'utf8'),
    ) as { functions: { source: string }[] };
    expect(join(RAIZ_REPO, config.functions[0]?.source ?? '')).toBe(DIRETORIO_DO_ARTEFATO_LI);
  });
});

describe('the shell', () => {
  it('the read switch: only the exact `on` is refused — the loader’s own rule', () => {
    expect(chamadasLigadasNoAmbiente({ LOJA_INTEGRADA_CHAMADAS: 'on' })).toBe(true);
    for (const valor of ['off', 'ON', ' on', 'on ', 'true', '', undefined]) {
      expect(chamadasLigadasNoAmbiente({ LOJA_INTEGRADA_CHAMADAS: valor }), String(valor)).toBe(
        false,
      );
    }
  });

  it('a write valve exactly `on` is refused — for EVERY flow, not only rastreio', () => {
    expect(escritasLigadasNoAmbiente({ LOJA_INTEGRADA_MODO_RASTREIO: 'on' })).toEqual([
      'LOJA_INTEGRADA_MODO_RASTREIO',
    ]);
    expect(
      escritasLigadasNoAmbiente({
        LOJA_INTEGRADA_MODO_ESTOQUE: 'on',
        LOJA_INTEGRADA_MODO_RASTREIO: 'on',
      }),
    ).toEqual(['LOJA_INTEGRADA_MODO_ESTOQUE', 'LOJA_INTEGRADA_MODO_RASTREIO']);
  });

  it('⚠️ NEAR-MISS: `dry-run`, `off`, blank and every value the loader reads as off are ACCEPTED — the lane runs at dry-run', () => {
    for (const valor of ['dry-run', 'off', '', 'ON', ' on', 'true', undefined]) {
      expect(
        escritasLigadasNoAmbiente({ LOJA_INTEGRADA_MODO_RASTREIO: valor }),
        String(valor),
      ).toEqual([]);
    }
  });

  it('a canary list that is not blank is refused, whatever it lists', () => {
    for (const valor of ['*', 'conta-li-1:165', ' *', 'lixo']) {
      expect(escritasLigadasNoAmbiente({ LOJA_INTEGRADA_CANARIO_RASTREIO: valor }), valor).toEqual([
        'LOJA_INTEGRADA_CANARIO_RASTREIO',
      ]);
    }
    expect(escritasLigadasNoAmbiente({ LOJA_INTEGRADA_CANARIO_ESTOQUE: '*' })).toEqual([
      'LOJA_INTEGRADA_CANARIO_ESTOQUE',
    ]);
  });

  it('⚠️ NEAR-MISS: an unset, empty or whitespace-only canary is accepted (the loader reads no target)', () => {
    for (const valor of ['', '   ', undefined]) {
      expect(
        escritasLigadasNoAmbiente({ LOJA_INTEGRADA_CANARIO_RASTREIO: valor }),
        String(valor),
      ).toEqual([]);
    }
  });

  it('a variable outside the two prefixes is none of this guard’s business', () => {
    expect(
      escritasLigadasNoAmbiente({
        LOJA_INTEGRADA_CHAMADAS: 'off',
        LOJA_INTEGRADA_TASKS_DISABLED: '1',
        OUTRO_MODO_RASTREIO: 'on',
      }),
    ).toEqual([]);
  });
});

describe('the artifact’s env files', () => {
  it('no artifact yet ⇒ nothing to police', () => {
    expect(envsDoArtefatoQueNomeiamAChave(DIRETORIO_DO_ARTEFATO_LI, artefato(null))).toEqual([]);
    expect(envsDoArtefatoQueLigamEscritas(DIRETORIO_DO_ARTEFATO_LI, artefato(null))).toEqual([]);
  });

  it('a file that merely NAMES the read switch is refused, whatever it sets — even commented out', () => {
    const leitor = artefato({
      '.env': 'LOJA_INTEGRADA_CHAMADAS=off\n',
      '.env.demo-erp': '# LOJA_INTEGRADA_CHAMADAS=on\n',
      '.env.local': 'OUTRA=1\n',
    });
    expect(envsDoArtefatoQueNomeiamAChave(DIRETORIO_DO_ARTEFATO_LI, leitor)).toEqual([
      '.env',
      '.env.demo-erp',
    ]);
  });

  it.each([
    ['plain', 'LOJA_INTEGRADA_MODO_RASTREIO=on'],
    ['double-quoted', 'LOJA_INTEGRADA_MODO_RASTREIO="on"'],
    ['single-quoted', "LOJA_INTEGRADA_MODO_RASTREIO='on'"],
    ['exported', 'export LOJA_INTEGRADA_MODO_RASTREIO=on'],
    ['spaced', '  LOJA_INTEGRADA_MODO_RASTREIO = on  '],
    ['with a trailing comment', 'LOJA_INTEGRADA_MODO_RASTREIO=on # canário'],
    ['CRLF', 'OUTRA=1\r\nLOJA_INTEGRADA_MODO_ESTOQUE=on\r\n'],
    ['a non-blank canary', 'LOJA_INTEGRADA_CANARIO_RASTREIO=*'],
    ['a quoted canary', 'LOJA_INTEGRADA_CANARIO_RASTREIO="conta-li-1:165"'],
    ['a line it cannot read', 'LOJA_INTEGRADA_CANARIO_RASTREIO'],
  ])('a file that turns a write on (%s) is refused', (_c, texto) => {
    expect(
      envsDoArtefatoQueLigamEscritas(DIRETORIO_DO_ARTEFATO_LI, artefato({ '.env': texto })),
    ).toEqual(['.env']);
  });

  it.each([
    ['dry-run', 'LOJA_INTEGRADA_MODO_RASTREIO=dry-run'],
    ['off', 'LOJA_INTEGRADA_MODO_RASTREIO=off'],
    ['blank', 'LOJA_INTEGRADA_MODO_RASTREIO='],
    ['a blank canary', 'LOJA_INTEGRADA_CANARIO_RASTREIO='],
    ['a blank quoted canary', 'LOJA_INTEGRADA_CANARIO_RASTREIO=""'],
    ['a blank canary with a comment', 'LOJA_INTEGRADA_CANARIO_RASTREIO= # nenhum'],
    ['a commented-out valve', '# LOJA_INTEGRADA_MODO_RASTREIO=on'],
    ['another variable', 'LOJA_INTEGRADA_POLL_LOOKBACK_H=72'],
  ])('⚠️ NEAR-MISS: a file that leaves every write off (%s) is accepted', (_c, texto) => {
    expect(
      envsDoArtefatoQueLigamEscritas(DIRETORIO_DO_ARTEFATO_LI, artefato({ '.env': texto })),
    ).toEqual([]);
  });

  it('only the ANCHORED names are read — the shapes `copyDeployEnv` produces and firebase-tools loads', () => {
    const leitor = artefato({
      '.env.deploy.x.y': 'LOJA_INTEGRADA_MODO_RASTREIO=on',
      env: 'LOJA_INTEGRADA_MODO_RASTREIO=on',
      'index.js': 'LOJA_INTEGRADA_MODO_RASTREIO=on',
      '.env.Demo': 'LOJA_INTEGRADA_MODO_RASTREIO=on',
      '.env.demo-erp': 'LOJA_INTEGRADA_MODO_RASTREIO=on',
    });
    expect(envsDoArtefatoQueLigamEscritas(DIRETORIO_DO_ARTEFATO_LI, leitor)).toEqual([
      '.env.demo-erp',
    ]);
  });
});

/** The source with comments removed — a refusal mentioned in a comment is not a refusal. */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the setup runs every refusal, and throws on each answer', () => {
  // The setup only ever runs inside the lane, so a refusal deleted from it
  // fails nothing anywhere — this reads it.
  const setup = semComentarios(readFileSync(join(RAIZ_APP, 'vitest.tasks.setup.ts'), 'utf8'));

  it('imports the refusals from this module', () => {
    expect(setup).toMatch(/from ['"]\.\/lib\/lojaIntegrada\/testing\/guardaDaLaneDeTarefas['"]/);
  });

  it('throws on the read switch, and on a write valve or canary, in the shell', () => {
    expect(setup).toMatch(
      /if \(chamadasLigadasNoAmbiente\(process\.env\)\) \{\s*throw new Error\(/,
    );
    expect(setup).toMatch(
      /const (\w+) = escritasLigadasNoAmbiente\(process\.env\);\s*if \(\1\.length > 0\) \{\s*throw new Error\(/,
    );
  });

  it('throws on an artifact env file that names the switch, or turns a write on', () => {
    expect(setup).toMatch(
      /const (\w+) = envsDoArtefatoQueNomeiamAChave\(\);\s*if \(\1\.length > 0\) \{\s*throw new Error\(/,
    );
    expect(setup).toMatch(
      /const (\w+) = envsDoArtefatoQueLigamEscritas\(\);\s*if \(\1\.length > 0\) \{\s*throw new Error\(/,
    );
  });

  it('still replaces the global fetch in the vitest process', () => {
    expect(setup).toMatch(/globalThis\.fetch = \(async \(/);
  });
});
