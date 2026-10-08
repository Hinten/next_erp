import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CREDENCIAL_LOJA_INTEGRADA_DOC_ID,
  credenciaisLojaIntegradaMeta,
  credenciaisLojaIntegradaSchema,
} from './credenciaisLojaIntegrada';
import * as barrel from './index';
import { ALL_DOMAINS } from './registry';

/* -------------------------------------------------------------------------- */
/*                         CredenciaisLojaIntegrada                           */
/* -------------------------------------------------------------------------- */

const PATH = 'integracao/{integracaoId}/credenciaisLojaIntegrada';

/** A first save: the route writes neither `webhookPedido` nor `reconexaoPendente`. */
const PRIMEIRO_SAVE = {
  personalToken: 'token-de-teste-nao-real',
  tokenFingerprint: '0123456789abcdef',
  tokenExpiraEmMs: 1_790_000_000_000,
  tokenAtualizadoEmMs: 1_780_000_000_000,
};

const WEBHOOK = {
  notifyUrl: 'https://exemplo.invalid/api/webhooks/loja-integrada/x',
  token: 'a'.repeat(43),
};

const RECONEXAO = {
  desdeMs: 1_785_000_000_000,
  status: 401,
  refCredencial: '0123456789abcdef.1780000000000',
};

function aceita(doc: unknown): boolean {
  return credenciaisLojaIntegradaSchema.safeParse(doc).success;
}

describe('credenciaisLojaIntegradaSchema', () => {
  it('parses a first-save doc, filling both optional blocks with null — never undefined', () => {
    const parsed = credenciaisLojaIntegradaSchema.parse(PRIMEIRO_SAVE);
    expect(parsed).toEqual({ ...PRIMEIRO_SAVE, webhookPedido: null, reconexaoPendente: null });
  });

  it('is STRICT: an unknown key fails, at the top and inside both blocks', () => {
    expect(aceita({ ...PRIMEIRO_SAVE, token_id: 'x' })).toBe(false);
    expect(aceita({ ...PRIMEIRO_SAVE, webhookPedido: { ...WEBHOOK, extra: 1 } })).toBe(false);
    expect(aceita({ ...PRIMEIRO_SAVE, reconexaoPendente: { ...RECONEXAO, extra: 1 } })).toBe(false);
  });

  it('requires every token field', () => {
    for (const campo of Object.keys(PRIMEIRO_SAVE)) {
      const sem: Record<string, unknown> = { ...PRIMEIRO_SAVE };
      delete sem[campo];
      expect(aceita(sem), campo).toBe(false);
    }
    expect(aceita({ ...PRIMEIRO_SAVE, personalToken: '' })).toBe(false);
  });

  it('stores the token exactly as given — this schema never trims', () => {
    // The route trims the ends ONCE; a second, silent trim here would make the
    // stored token differ from the one that was validated.
    const parsed = credenciaisLojaIntegradaSchema.parse({
      ...PRIMEIRO_SAVE,
      personalToken: ' com espaco ',
    });
    expect(parsed.personalToken).toBe(' com espaco ');
  });

  it('accepts exactly 16 lowercase hex characters as the fingerprint', () => {
    expect(aceita({ ...PRIMEIRO_SAVE, tokenFingerprint: 'fedcba9876543210' })).toBe(true);
    for (const quase of [
      '0123456789abcde', // 15
      '0123456789abcdef0', // 17
      '0123456789ABCDEF', // uppercase
      '0123456789abcdeg', // not hex
    ]) {
      expect(aceita({ ...PRIMEIRO_SAVE, tokenFingerprint: quase }), quase).toBe(false);
    }
  });

  it('keeps both stamps in MILLISECONDS — and documents that a µs value is coerced, not refused', () => {
    // ⚠️ `millisSinceEpoch()` repairs a µs write silently. That is why the
    // store's tests pin each RAW stored value to the injected ms clock instead
    // of trusting this parse to catch a unit mistake.
    const parsed = credenciaisLojaIntegradaSchema.parse({
      ...PRIMEIRO_SAVE,
      tokenExpiraEmMs: PRIMEIRO_SAVE.tokenExpiraEmMs * 1000,
    });
    expect(parsed.tokenExpiraEmMs).toBe(PRIMEIRO_SAVE.tokenExpiraEmMs);
    expect(credenciaisLojaIntegradaSchema.parse(PRIMEIRO_SAVE).tokenAtualizadoEmMs).toBe(
      1_780_000_000_000,
    );
  });

  describe('webhookPedido', () => {
    it('accepts an https notify URL, refuses http', () => {
      expect(aceita({ ...PRIMEIRO_SAVE, webhookPedido: WEBHOOK })).toBe(true);
      expect(
        aceita({
          ...PRIMEIRO_SAVE,
          webhookPedido: { ...WEBHOOK, notifyUrl: 'http://exemplo.invalid/x' },
        }),
      ).toBe(false);
    });

    it('accepts a 43-character token (32 bytes in base64url), refuses 42', () => {
      expect(
        aceita({ ...PRIMEIRO_SAVE, webhookPedido: { ...WEBHOOK, token: 'b'.repeat(43) } }),
      ).toBe(true);
      expect(
        aceita({ ...PRIMEIRO_SAVE, webhookPedido: { ...WEBHOOK, token: 'b'.repeat(42) } }),
      ).toBe(false);
    });
  });

  describe('reconexaoPendente', () => {
    it('accepts HTTP 401 and 403, refuses 400 and the string forms', () => {
      for (const status of [401, 403]) {
        expect(
          aceita({ ...PRIMEIRO_SAVE, reconexaoPendente: { ...RECONEXAO, status } }),
          String(status),
        ).toBe(true);
      }
      for (const status of [400, 404, 500, '401']) {
        expect(
          aceita({ ...PRIMEIRO_SAVE, reconexaoPendente: { ...RECONEXAO, status } }),
          String(status),
        ).toBe(false);
      }
    });

    it('accepts a 64-character ref, refuses 65 and the empty ref', () => {
      // 64 is the package's `MAX_REF_CREDENCIAL`: a longer ref is refused on
      // every request, so a stored one could never be matched.
      expect(
        aceita({
          ...PRIMEIRO_SAVE,
          reconexaoPendente: { ...RECONEXAO, refCredencial: 'r'.repeat(64) },
        }),
      ).toBe(true);
      for (const ref of ['r'.repeat(65), '']) {
        expect(
          aceita({ ...PRIMEIRO_SAVE, reconexaoPendente: { ...RECONEXAO, refCredencial: ref } }),
          `length ${String(ref.length)}`,
        ).toBe(false);
      }
    });

    it('keeps `desdeMs` in milliseconds', () => {
      const parsed = credenciaisLojaIntegradaSchema.parse({
        ...PRIMEIRO_SAVE,
        reconexaoPendente: RECONEXAO,
      });
      expect(parsed.reconexaoPendente).toEqual(RECONEXAO);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                   Meta                                     */
/* -------------------------------------------------------------------------- */

describe('credenciaisLojaIntegradaMeta', () => {
  it('targets the subcollection, with the fixed doc id', () => {
    expect(credenciaisLojaIntegradaMeta.collectionPath).toBe(PATH);
    expect(CREDENCIAL_LOJA_INTEGRADA_DOC_ID).toBe('current');
  });

  it('is admin-only / default-deny: zero perms (mirrors credenciaisWhatsapp)', () => {
    expect(credenciaisLojaIntegradaMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('is NOT registered in ALL_DOMAINS (server-only secret store)', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).not.toContain(PATH);
  });

  it('is exported from the barrel as parts only — never as a combined `{ schema, meta }`', () => {
    // A combined export missing from ALL_DOMAINS fails `registry.test.ts`, and
    // the obvious "fix" — registering it — makes the generator grant clients
    // access to a live token. So no barrel value may carry this path.
    const combinados = Object.entries(barrel)
      .filter(([, valor]) => {
        if (typeof valor !== 'object' || valor === null) return false;
        const candidato = valor as { schema?: unknown; meta?: unknown };
        return (
          candidato.schema instanceof z.ZodType &&
          typeof candidato.meta === 'object' &&
          candidato.meta !== null &&
          (candidato.meta as { collectionPath?: unknown }).collectionPath === PATH
        );
      })
      .map(([nome]) => nome);
    expect(combinados).toEqual([]);
    expect(barrel.credenciaisLojaIntegradaSchema).toBe(credenciaisLojaIntegradaSchema);
    expect(barrel.credenciaisLojaIntegradaMeta).toBe(credenciaisLojaIntegradaMeta);
    expect(barrel.CREDENCIAL_LOJA_INTEGRADA_DOC_ID).toBe('current');
  });
});
