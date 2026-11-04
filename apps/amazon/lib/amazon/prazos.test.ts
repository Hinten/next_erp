import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { PRAZO_AMAZON_MS } from '@delfrance/integrations-amazon-sp-api';

import {
  PRAZO_ENFILEIRAMENTO_RECEPTOR_MS,
  PRAZO_PERSISTENCIA_RECEPTOR_MS,
} from './notificacoes/receptor';

/**
 * The OAuth routes must fit inside this backend's request ceiling.
 *
 * The callback makes exactly ONE Amazon call — the code exchange, bounded by
 * `PRAZO_AMAZON_MS.lwa` — plus a handful of Firestore reads and writes. A
 * request that could outlive the ceiling is cut by the PLATFORM's 504 with the
 * outcome unknown; for a single-use code that means "consent again". So the
 * call's budget plus a margin for the Firestore work and a cold start must sit
 * below the SMALLEST `timeoutSeconds` pinned in `apphosting*.yaml`, or below
 * App Hosting's default (300 s) when none is.
 *
 * ⚠️ The INVERSE of `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`
 * (which needs the LARGEST ceiling): lowering `timeoutSeconds` below the call
 * must turn this red. A copy of the Loja Integrada / Melhor Envio reader — apps
 * have no dependency edge to each other.
 */
const TETO_APP_HOSTING_PADRAO_S = 300;
const MARGEM_MS = 30_000;
const APP_DIR = path.resolve(__dirname, '../..');
const TIMEOUT_SECONDS_LINHA = /^\s*timeoutSeconds\s*:\s*(\d+)\s*(?:#.*)?$/;

/** The three routes, and how many code exchanges each may make: status / start / callback. */
const ROTAS: readonly (readonly [string, number])[] = [
  ['app/api/marketplace/amazon/conta/[id]/route.ts', 0],
  ['app/api/marketplace/amazon/conta/[id]/oauth/start/route.ts', 0],
  ['app/api/oauth/amazon/callback/route.ts', 0],
  // The callback's body lives in `conectar.ts`; the ONE exchange is counted there.
  ['lib/amazon/conta/conectar.ts', 1],
];

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

const contar = (texto: string, agulha: string) => texto.split(agulha).length - 1;
const ler = (rota: string) => readFileSync(path.join(APP_DIR, rota), 'utf8');

describe('the OAuth routes fit inside the backend ceiling', () => {
  it('reads the backend config (anti-vacuity), failing closed on an unreadable pin', () => {
    const { arquivos, ilegiveis } = configDoBackend();
    expect(arquivos).toContain('apphosting.yaml');
    expect(ilegiveis).toEqual([]);
  });

  it('PRAZO_AMAZON_MS.lwa + 30 s ≤ the smallest ceiling (300 s with no pin)', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(PRAZO_AMAZON_MS.lwa).toBeGreaterThan(0);
    expect(PRAZO_AMAZON_MS.lwa + MARGEM_MS).toBeLessThanOrEqual(tetoS * 1000);
  });

  it('status / start / callback make 0 / 0 / 1 code exchanges, and no route ever refreshes', () => {
    for (const [arquivo, trocas] of ROTAS) {
      const fonte = ler(arquivo);
      expect(contar(fonte, 'trocarCodigoAutorizacao('), arquivo).toBe(trocas);
      expect(contar(fonte, 'trocarRefreshToken('), arquivo).toBe(0);
    }
    // No route reaches Amazon any other way: no context, no client, no raw fetch.
    for (const [arquivo] of ROTAS.slice(0, 3)) {
      expect(ler(arquivo), arquivo).not.toMatch(/loadAmazonContext|criarClienteSpApi|fetch\(/);
    }
    // The status and start bodies never exchange either.
    for (const corpo of ['lib/amazon/conta/status.ts', 'lib/amazon/conta/iniciar.ts']) {
      expect(contar(ler(corpo), 'trocarCodigoAutorizacao('), corpo).toBe(0);
      expect(contar(ler(corpo), 'trocarRefreshToken('), corpo).toBe(0);
    }
  });

  it('the push receiver (route and body) makes ZERO Amazon calls of any kind', () => {
    for (const arquivo of [
      'app/api/webhooks/amazon/route.ts',
      'lib/amazon/notificacoes/receptor.ts',
      'lib/amazon/notificacoes/envelope.ts',
      'lib/amazon/notificacoes/corpo.ts',
    ]) {
      const fonte = ler(arquivo);
      expect(contar(fonte, 'trocarCodigoAutorizacao('), arquivo).toBe(0);
      expect(contar(fonte, 'trocarRefreshToken('), arquivo).toBe(0);
      expect(fonte, arquivo).not.toMatch(/loadAmazonContext|criarClienteSpApi|fetch\(/);
    }
  });

  it('the reader parses a pin, ignores a comment, and fails closed on an unreadable one', () => {
    expect(pinsDeTimeout(['runConfig:\n  timeoutSeconds: 60 # curto\n'])).toEqual({
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
    expect(PRAZO_AMAZON_MS.lwa + MARGEM_MS).toBeGreaterThan(30 * 1000);
  });
});

/**
 * The push receiver must answer inside the AWS API destination's 5-second
 * timeout on the WARM path (step-3 plan §3 decision 32): past it the pipe
 * counts a failure and retries, and after `maxReceiveCount` deliveries a
 * notification that was already durably persisted lands in the DLQ.
 *
 * enqueue deadline + persist deadline + 500 ms (auth, the bounded body, the
 * parse) + a 1-s margin must not exceed 5 000 ms. A cold start is outside this
 * budget on purpose (`minInstances: 0`, §3 decision 16).
 */
const TIMEOUT_API_DESTINATION_MS = 5000;
const ORCAMENTO_AUTENTICACAO_E_CORPO_MS = 500;
const MARGEM_RECEPTOR_MS = 1000;

describe('the push receiver fits the API destination’s 5-s timeout', () => {
  it('enqueue + persist deadlines + 500 ms + a 1-s margin ≤ 5 000 ms', () => {
    expect(PRAZO_ENFILEIRAMENTO_RECEPTOR_MS).toBeGreaterThan(0);
    expect(PRAZO_PERSISTENCIA_RECEPTOR_MS).toBeGreaterThan(0);
    expect(
      PRAZO_ENFILEIRAMENTO_RECEPTOR_MS +
        PRAZO_PERSISTENCIA_RECEPTOR_MS +
        ORCAMENTO_AUTENTICACAO_E_CORPO_MS +
        MARGEM_RECEPTOR_MS,
    ).toBeLessThanOrEqual(TIMEOUT_API_DESTINATION_MS);
  });

  it('the enqueue deadline is below the SDK’s own retry ladder (≥ 7 s on 503s), so the race can win', () => {
    expect(PRAZO_ENFILEIRAMENTO_RECEPTOR_MS).toBeLessThan(7000);
  });
});
