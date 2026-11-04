import { describe, expect, it } from 'vitest';
import {
  CREDENCIAL_AMAZON_DOC_ID,
  MAX_REF_CREDENCIAL_AMAZON,
  credenciaisAmazonSchema,
  reconexaoPendenteAmazonSchema,
} from './credenciaisAmazon';
import * as barrel from './index';
import { credenciaisIntegracaoMeta, credenciaisIntegracaoSchema } from './integracao';
import { ALL_DOMAINS } from './registry';

/* -------------------------------------------------------------------------- */
/*                             CredenciaisAmazon                              */
/* -------------------------------------------------------------------------- */

/** The generic store's path — the Amazon document lives there, at `current`. */
const PATH = 'integracao/{integracaoId}/credenciais';

/** A consent as the callback writes it: every field, park cleared. */
const CONSENTIMENTO = {
  access_token: 'acesso-de-teste-nao-real',
  refresh_token: 'refresh-de-teste-nao-real',
  expirationDate: 1_790_003_600_000,
  autorizadoEmMs: 1_790_000_000_000,
  acessoRef: '0123456789abcdef.1790000000000',
  reconexaoPendente: null,
};

const RECONEXAO = {
  desdeMs: 1_795_000_000_000,
  status: 400,
  codigoLwa: 'invalid_grant',
  refCredencial: '0123456789abcdef.1790000000000',
};

function aceita(doc: unknown): boolean {
  return credenciaisAmazonSchema.safeParse(doc).success;
}

describe('credenciaisAmazonSchema', () => {
  it('parses a full consent doc unchanged', () => {
    expect(credenciaisAmazonSchema.parse(CONSENTIMENTO)).toEqual(CONSENTIMENTO);
    expect(
      credenciaisAmazonSchema.parse({ ...CONSENTIMENTO, reconexaoPendente: RECONEXAO })
        .reconexaoPendente,
    ).toEqual(RECONEXAO);
  });

  it('fills `acessoRef` and `reconexaoPendente` with null — never undefined', () => {
    const { acessoRef: _a, reconexaoPendente: _r, ...minimo } = CONSENTIMENTO;
    const parsed = credenciaisAmazonSchema.parse(minimo);
    expect(parsed.acessoRef).toBeNull();
    expect(parsed.reconexaoPendente).toBeNull();
  });

  it('is STRICT: an extra key is refused, at the top and inside the park', () => {
    // The generic store is `.passthrough()`; a hand-added key there rides along.
    // Here it must make the document read as CORRUPT.
    expect(credenciaisIntegracaoSchema.safeParse({ ...CONSENTIMENTO, extra: 1 }).success).toBe(
      true,
    );
    expect(aceita({ ...CONSENTIMENTO, extra: 1 })).toBe(false);
    // Near-miss: a stored fingerprint would be a guard input nobody may edit.
    expect(aceita({ ...CONSENTIMENTO, tokenFingerprint: '0123456789abcdef' })).toBe(false);
    expect(aceita({ ...CONSENTIMENTO, reconexaoPendente: { ...RECONEXAO, extra: 1 } })).toBe(false);
  });

  it('keeps ONE definition of the OAuth trio: it requires exactly what the generic store requires', () => {
    for (const campo of ['access_token', 'refresh_token', 'expirationDate', 'autorizadoEmMs']) {
      const sem: Record<string, unknown> = { ...CONSENTIMENTO };
      delete sem[campo];
      expect(aceita(sem), campo).toBe(false);
    }
    expect(aceita({ ...CONSENTIMENTO, access_token: '' })).toBe(false);
    expect(aceita({ ...CONSENTIMENTO, refresh_token: '' })).toBe(false);
    // The ONE-definition property itself: the extension reuses the generic
    // field schemas by reference. A re-declaration inside `.extend()` — even an
    // identical-looking one — builds a new schema object and fails here.
    for (const campo of ['access_token', 'refresh_token', 'expirationDate'] as const) {
      expect(credenciaisAmazonSchema.shape[campo], campo).toBe(
        credenciaisIntegracaoSchema.shape[campo],
      );
    }
  });

  it('accepts a 64-character ref, refuses 65 and the empty ref — on both refs', () => {
    expect(MAX_REF_CREDENCIAL_AMAZON).toBe(64);
    const r64 = 'r'.repeat(64);
    const r65 = 'r'.repeat(65);
    expect(aceita({ ...CONSENTIMENTO, acessoRef: r64 })).toBe(true);
    expect(aceita({ ...CONSENTIMENTO, acessoRef: r65 })).toBe(false);
    expect(aceita({ ...CONSENTIMENTO, acessoRef: '' })).toBe(false);
    const park = (refCredencial: string) => ({
      ...CONSENTIMENTO,
      reconexaoPendente: { ...RECONEXAO, refCredencial },
    });
    expect(aceita(park(r64))).toBe(true);
    expect(aceita(park(r65))).toBe(false);
    expect(aceita(park(''))).toBe(false);
  });

  it('pins the stored stamps in MILLISECONDS', () => {
    const parsed = credenciaisAmazonSchema.parse(CONSENTIMENTO);
    expect(parsed.expirationDate).toBe(1_790_003_600_000);
    expect(parsed.autorizadoEmMs).toBe(1_790_000_000_000);
  });

  it('documents the trap: a µs value is COERCED to ms, so it comes back CHANGED, not refused', () => {
    // ⚠️ `millisSinceEpoch()` repairs a µs write silently. A fixture written in
    // µs must not pass a round-trip unnoticed — the store's tests pin the RAW
    // stored value against the injected ms clock instead of trusting this parse.
    const emMicros = {
      ...CONSENTIMENTO,
      expirationDate: CONSENTIMENTO.expirationDate * 1000,
      autorizadoEmMs: CONSENTIMENTO.autorizadoEmMs * 1000,
    };
    const r = credenciaisAmazonSchema.safeParse(emMicros);
    expect(r.success).toBe(true);
    expect(r.success && r.data.autorizadoEmMs).toBe(CONSENTIMENTO.autorizadoEmMs);
    expect(r.success && r.data.autorizadoEmMs).not.toBe(emMicros.autorizadoEmMs);
    expect(r.success && r.data.expirationDate).not.toBe(emMicros.expirationDate);
  });

  describe('reconexaoPendente', () => {
    it('accepts a 4xx status, refuses anything outside it and the string form', () => {
      for (const status of [400, 401, 403, 499]) {
        expect(reconexaoPendenteAmazonSchema.safeParse({ ...RECONEXAO, status }).success).toBe(
          true,
        );
      }
      for (const status of [399, 500, 200, 401.5, '401']) {
        expect(
          reconexaoPendenteAmazonSchema.safeParse({ ...RECONEXAO, status }).success,
          String(status),
        ).toBe(false);
      }
    });

    it('takes the LWA code as text, or null when the refusal carried none', () => {
      expect(
        reconexaoPendenteAmazonSchema.safeParse({ ...RECONEXAO, codigoLwa: null }).success,
      ).toBe(true);
      expect(
        reconexaoPendenteAmazonSchema.safeParse({ ...RECONEXAO, codigoLwa: 'x'.repeat(32) })
          .success,
      ).toBe(true);
      expect(
        reconexaoPendenteAmazonSchema.safeParse({ ...RECONEXAO, codigoLwa: 'x'.repeat(33) })
          .success,
      ).toBe(false);
      // Required, not defaulted: a park always says whether there was a code.
      const { codigoLwa: _c, ...semCodigo } = RECONEXAO;
      expect(reconexaoPendenteAmazonSchema.safeParse(semCodigo).success).toBe(false);
    });

    it('keeps `desdeMs` in milliseconds', () => {
      expect(reconexaoPendenteAmazonSchema.parse(RECONEXAO).desdeMs).toBe(1_795_000_000_000);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                     Unregistered: no meta, no new path                     */
/* -------------------------------------------------------------------------- */

describe('the Amazon credential is a SHAPE, not a collection', () => {
  it('lives at the generic store, at the fixed doc id', () => {
    expect(credenciaisIntegracaoMeta.collectionPath).toBe(PATH);
    expect(CREDENCIAL_AMAZON_DOC_ID).toBe('current');
  });

  it('the generic store stays admin-only and outside ALL_DOMAINS', () => {
    expect(credenciaisIntegracaoMeta.permissions).toEqual({ read: 0n, write: 0n, delete: 0n });
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain(PATH);
  });

  it('is exported as parts only — never a combined `{ schema, meta }`, never a meta of its own', () => {
    const combinados = Object.entries(barrel)
      .filter(([, valor]) => {
        if (typeof valor !== 'object' || valor === null) return false;
        const candidato = valor as { schema?: unknown };
        return candidato.schema === credenciaisAmazonSchema;
      })
      .map(([nome]) => nome);
    expect(combinados).toEqual([]);
    expect(Object.keys(barrel).filter((k) => /^credenciaisAmazon(Meta)?$/.test(k))).toEqual([]);
    expect(barrel.credenciaisAmazonSchema).toBe(credenciaisAmazonSchema);
    expect(barrel.reconexaoPendenteAmazonSchema).toBe(reconexaoPendenteAmazonSchema);
    expect(barrel.CREDENCIAL_AMAZON_DOC_ID).toBe('current');
    expect(barrel.MAX_REF_CREDENCIAL_AMAZON).toBe(64);
  });
});
