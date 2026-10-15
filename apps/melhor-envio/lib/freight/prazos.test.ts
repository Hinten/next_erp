import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { DURACAO_MAXIMA_COMPRAR_MS } from '@delfrance/integrations-freight-br';

/**
 * #1679: a whole `comprar` run must fit inside this backend's request ceiling.
 *
 * A run that could outlive it is cut by the PLATFORM's 504 — with the outcome
 * unknown and nothing in our code to say which step it reached. With every
 * Melhor Envio call bounded (`PRAZO_ME_MS`), the worst run is a number, and this
 * pins it below the ceiling with a margin for the Firestore reads/writes and a
 * cold start around it.
 *
 * ⚠️ The INVERSE of `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`,
 * which needs the LARGEST ceiling (a client deadline must outlast it). Here the
 * conservative reading is the SMALLEST pinned value: lowering `timeoutSeconds`
 * below the run (e.g. the 180 s ML/Shopee pin) must turn this red.
 */
const TETO_APP_HOSTING_PADRAO_S = 300;
const MARGEM_MS = 30_000;
const APP_DIR = path.resolve(__dirname, '../..');
const TIMEOUT_SECONDS_LINHA = /^\s*timeoutSeconds\s*:\s*(\d+)\s*(?:#.*)?$/;

/**
 * Every `timeoutSeconds` pinned in these YAML texts, plus every line that
 * mentions the key but cannot be read as one — the same fail-closed reader as
 * the repo guard, so `timeoutSeconds: "900"` or a flow mapping is reported
 * instead of silently falling back to the default.
 */
function pinsDeTimeout(textos: string[]): { pinados: number[]; ilegiveis: string[] } {
  const pinados: number[] = [];
  const ilegiveis: string[] = [];
  for (const texto of textos) {
    for (const linha of texto.split(/\r?\n/)) {
      if (!/timeoutSeconds/.test(linha.replace(/#.*$/, ''))) continue;
      const m = TIMEOUT_SECONDS_LINHA.exec(linha);
      if (m === null) ilegiveis.push(linha.trim());
      else pinados.push(Number(m[1]));
    }
  }
  return { pinados, ilegiveis };
}

function configDoBackend(): { arquivos: string[]; pinados: number[]; ilegiveis: string[] } {
  const arquivos = readdirSync(APP_DIR).filter((f) => /^apphosting.*\.yaml$/.test(f));
  return {
    arquivos,
    ...pinsDeTimeout(arquivos.map((f) => readFileSync(path.join(APP_DIR, f), 'utf8'))),
  };
}

describe('the comprar run fits inside the backend ceiling (#1679)', () => {
  it('reads the backend config (anti-vacuity)', () => {
    const { arquivos, ilegiveis } = configDoBackend();
    expect(arquivos).toContain('apphosting.yaml');
    // Fail CLOSED: a pin the parser cannot read must not silently fall back to 300 s.
    expect(ilegiveis).toEqual([]);
  });

  it('DURACAO_MAXIMA_COMPRAR_MS + margin ≤ the smallest ceiling', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(DURACAO_MAXIMA_COMPRAR_MS).toBeGreaterThan(0);
    expect(DURACAO_MAXIMA_COMPRAR_MS + MARGEM_MS).toBeLessThanOrEqual(tetoS * 1000);
  });

  // No pin exists in this app's yaml today, so the parsing branch above never
  // runs on the real files — pin the parser on synthetic text instead.
  it('the reader parses a pin, ignores a comment, and fails closed on an unreadable one', () => {
    expect(pinsDeTimeout(['runConfig:\n  cpu: 1\n  timeoutSeconds: 180 # ML/Shopee\n'])).toEqual({
      pinados: [180],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['# timeoutSeconds is not set on purpose\n'])).toEqual({
      pinados: [],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['runConfig:\n  timeoutSeconds: "300"\n']).ilegiveis).toEqual([
      'timeoutSeconds: "300"',
    ]);
    // The 180 s pin is exactly what this test exists to reject.
    expect(DURACAO_MAXIMA_COMPRAR_MS + MARGEM_MS).toBeGreaterThan(180 * 1000);
  });
});
