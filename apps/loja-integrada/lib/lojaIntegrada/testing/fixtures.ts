/**
 * Shared fixtures for the `lib/lojaIntegrada` suites, **for tests only** — the
 * same rule as `fakeDb.ts`: nothing outside a `*.test.ts` imports this.
 *
 * Every token here is an obviously fake sentinel. A suite asserting token
 * hygiene searches responses, errors and log arguments for these strings.
 */
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { fingerprintDoToken } from '../core/credencial';
import type { DocData, FakeDb } from './fakeDb';

/** A sentinel token: long, visible ASCII, impossible to mistake for a real one. */
export const TOKEN_A = 'li-token-sentinela-AAAA-0123456789';
export const TOKEN_B = 'li-token-sentinela-BBBB-9876543210';

/** 2027-01-15T15:00:00Z — noon in São Paulo. */
export const AGORA_MS = Date.UTC(2027, 0, 15, 15, 0, 0);
export const DIA_MS = 24 * 60 * 60 * 1000;

export function caminhoConta(integracaoId: string): string {
  return `integracao/${integracaoId}`;
}

export function caminhoCredencial(integracaoId: string): string {
  return `integracao/${integracaoId}/credenciaisLojaIntegrada/current`;
}

export function caminhoAviso(chave: string): string {
  return `avisos/${chave}`;
}

/** A Loja Integrada conta document, as the browser writes one. */
export function seedConta(
  db: FakeDb,
  integracaoId: string,
  over: Partial<{ nome: string; ativo: boolean; tipo: number }> = {},
): void {
  db.seed(caminhoConta(integracaoId), {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${integracaoId}`,
    ativo: true,
    ...over,
  });
}

/** A complete, valid credential document. */
export function credencialDoc(over: Partial<DocData> = {}): DocData {
  const personalToken = typeof over.personalToken === 'string' ? over.personalToken : TOKEN_A;
  return {
    personalToken,
    tokenFingerprint: fingerprintDoToken(personalToken),
    tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
    tokenAtualizadoEmMs: AGORA_MS - DIA_MS,
    webhookPedido: null,
    reconexaoPendente: null,
    ...over,
  };
}

export function seedCredencial(db: FakeDb, integracaoId: string, over: Partial<DocData> = {}) {
  return db.seed(caminhoCredencial(integracaoId), credencialDoc(over));
}

/** Capture `logger.warn` calls, to assert what a log line may carry. */
export function loggerEspiao(): {
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  chamadas: unknown[][];
} {
  const chamadas: unknown[][] = [];
  return {
    logger: {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        chamadas.push(meta === undefined ? [msg] : [msg, meta]);
      },
    },
    chamadas,
  };
}
