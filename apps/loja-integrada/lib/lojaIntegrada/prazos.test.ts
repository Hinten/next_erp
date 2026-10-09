import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';

/**
 * The credential routes must fit inside this backend's request ceiling.
 *
 * Each of `PUT …/credencial` and `PUT …/credencial/validade` makes exactly ONE
 * Loja Integrada call — the validating GET, bounded by `PRAZO_LI_MS.leitura` —
 * plus a handful of Firestore reads and writes. A request that could outlive
 * the ceiling is cut by the PLATFORM's 504, with the outcome unknown and
 * nothing in our code to say whether the token was stored. So the call's
 * budget, plus a margin for the Firestore work and a cold start, must sit
 * below the SMALLEST `timeoutSeconds` pinned in `apphosting*.yaml`, or below
 * App Hosting's default when none is.
 *
 * ⚠️ The INVERSE of `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`,
 * which needs the LARGEST ceiling (a client deadline must outlast it). Here the
 * conservative reading is the smallest pinned value: lowering `timeoutSeconds`
 * below the call must turn this red. A copy of the
 * `apps/melhor-envio/lib/freight/prazos.test.ts` reader — apps have no
 * dependency edge to each other.
 */
const TETO_APP_HOSTING_PADRAO_S = 300;
const MARGEM_MS = 30_000;
const APP_DIR = path.resolve(__dirname, '../..');
const TIMEOUT_SECONDS_LINHA = /^\s*timeoutSeconds\s*:\s*(\d+)\s*(?:#.*)?$/;

/** The three conta routes, and how many validating calls each may make. */
const ROTAS: readonly (readonly [string, number])[] = [
  ['app/api/marketplace/loja-integrada/conta/[id]/route.ts', 0],
  ['app/api/marketplace/loja-integrada/conta/[id]/credencial/route.ts', 1],
  ['app/api/marketplace/loja-integrada/conta/[id]/credencial/validade/route.ts', 1],
];

/**
 * Every `timeoutSeconds` pinned in these YAML texts, plus every line that
 * mentions the key but cannot be read as one — fail closed, so
 * `timeoutSeconds: "900"` or a flow mapping is reported instead of silently
 * falling back to the default.
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

function contar(texto: string, agulha: string): number {
  return texto.split(agulha).length - 1;
}

describe('the credential routes fit inside the backend ceiling', () => {
  it('reads the backend config (anti-vacuity)', () => {
    const { arquivos, ilegiveis } = configDoBackend();
    expect(arquivos).toContain('apphosting.yaml');
    // Fail CLOSED: a pin the parser cannot read must not silently fall back to 300 s.
    expect(ilegiveis).toEqual([]);
  });

  it('PRAZO_LI_MS.leitura + margin ≤ the smallest ceiling', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(PRAZO_LI_MS.leitura).toBeGreaterThan(0);
    expect(PRAZO_LI_MS.leitura + MARGEM_MS).toBeLessThanOrEqual(tetoS * 1000);
  });

  it('each route makes at most the one validating call the budget above counts', () => {
    for (const [rota, chamadas] of ROTAS) {
      const fonte = readFileSync(path.join(APP_DIR, rota), 'utf8');
      expect(contar(fonte, 'validarPersonalToken('), rota).toBe(chamadas);
      // No other way out to Loja Integrada: no context client, no raw fetch.
      expect(fonte, rota).not.toMatch(/criarClienteLeituraLi|loadLojaIntegradaContext|fetch\(/);
    }
  });

  // No pin exists in this app's yaml today, so the parsing branch above never
  // runs on the real files — pin the parser on synthetic text instead.
  it('the reader parses a pin, ignores a comment, and fails closed on an unreadable one', () => {
    expect(pinsDeTimeout(['runConfig:\n  cpu: 1\n  timeoutSeconds: 60 # curto\n'])).toEqual({
      pinados: [60],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['# No `timeoutSeconds` — the default\n'])).toEqual({
      pinados: [],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['runConfig:\n  timeoutSeconds: "300"\n']).ilegiveis).toEqual([
      'timeoutSeconds: "300"',
    ]);
    // A pin this small is exactly what this test exists to reject.
    expect(PRAZO_LI_MS.leitura + MARGEM_MS).toBeGreaterThan(30 * 1000);
  });
});
