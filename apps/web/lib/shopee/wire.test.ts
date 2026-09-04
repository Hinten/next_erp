import { describe, expect, it } from 'vitest';

import { oauthStartResponseSchema, shopeeContaStatusSchema, shopeeLojaSchema } from './wire';

/**
 * What these guard is the set of DECISIONS the schemas encode. Each one is a
 * place where a later "simplification" would take a working screen down against
 * a backend one deploy away from this browser, which is the failure the mirror
 * exists to make visible rather than silent.
 *
 * ⚠️ Every "tolerates X" case below is worthless on its own — `z.any()` passes
 * all of them. The controls are the NEAR-MISS assertions (a value one character
 * away from the tolerated one that must still be rejected) and the anti-vacuity
 * block at the end. If a genuinely wrong body stops being rejected, this file
 * has stopped testing anything.
 */

/** A connected conta exactly as `GET /conta` projects it. */
const CONTA = {
  connected: true,
  shopId: 123_456_789_012_345,
  mainAccountId: null,
  authTime: 1_756_000_000_000,
  expireTime: 1_787_536_000_000,
  diasParaExpirar: 365,
  loja: { shopName: 'Loja Teste', region: 'BR', status: 'NORMAL' },
  credencial: { expiraEm: 1_756_014_400_000, expirada: false, renovacaoFalhou: false },
};

describe('numbers: tolerant where the value passes THROUGH us, strict where we compute it', () => {
  it('⭐ accepts a QUOTED shopId — it reaches the wire through the SOFT parseRead', () => {
    // `shop_id` is denormalised onto the integração document and read back with
    // `parseRead`, which logs and returns the RAW document on a mismatch (rule
    // 8 read-tolerance). A legacy quoted id therefore reaches this browser
    // unchanged, and #1087 is what a strict `z.number()` costs when it does:
    // the whole body fails before any field is read.
    const r = shopeeContaStatusSchema.parse({ ...CONTA, shopId: '123456789012345' });

    expect(r.shopId).toBe(123_456_789_012_345);
  });

  it('the quoted and unquoted forms of the SAME id parse to the same value', () => {
    // The equal pair. Two spellings of one id must not produce two contas.
    const quoted = shopeeContaStatusSchema.parse({ ...CONTA, shopId: '123456789012345' });
    const bare = shopeeContaStatusSchema.parse({ ...CONTA, shopId: 123_456_789_012_345 });

    expect(quoted.shopId).toBe(bare.shopId);
  });

  it('accepts quoted mainAccountId / authTime / expireTime for the same reason', () => {
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      shopId: null,
      mainAccountId: '99',
      authTime: '1756000000000',
      expireTime: '1787536000000',
    });

    expect([r.mainAccountId, r.authTime, r.expireTime]).toEqual([
      99, 1_756_000_000_000, 1_787_536_000_000,
    ]);
  });

  it('⚠️ NEAR MISS — REJECTS a quoted diasParaExpirar, which this backend computed', () => {
    // The other half of the rule, and the reason the tolerance is not blanket.
    // `diasParaExpirar` is `Math.floor` arithmetic done in `apps/shopee`; a
    // string there is OUR serialisation bug and has to be loud. Deleting this
    // case would let a single `wireInt()` sweep pass unnoticed.
    const r = shopeeContaStatusSchema.safeParse({ ...CONTA, diasParaExpirar: '12' });

    expect(r.success).toBe(false);
  });

  it('⚠️ NEAR MISS — REJECTS a quoted credencial.expiraEm, ours as well', () => {
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      credencial: { expiraEm: '1756014400000', expirada: false, renovacaoFalhou: false },
    });

    expect(r.success).toBe(false);
  });

  it('⚠️ REJECTS a shopId that is not a number in any spelling', () => {
    // `wireInt()` reads exactly one decimal literal and hands anything else to
    // `z.number()` verbatim — it is not `z.coerce.number()`, which would read
    // `''` as 0 and invent a shop.
    for (const shopId of ['', 'abc', '0x1F', '1e3', {}, true]) {
      expect(shopeeContaStatusSchema.safeParse({ ...CONTA, shopId }).success).toBe(false);
    }
  });
});

describe('credencial.renovacaoFalhou — the field a NEWER browser reads off an OLDER backend', () => {
  it('⭐ defaults to false when the backend answering this browser predates the field', () => {
    // Rule 2's maintenance note, exercised: `apps/web` and `apps/shopee` deploy
    // separately, so a browser carrying this build routinely talks to a backend
    // that never heard of `renovacaoFalhou`. Required, it would blank the whole
    // conta screen for the length of that skew; defaulted, it reads as "no
    // failure known" and the panel shows the healthy copy until the backend
    // catches up.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      credencial: { expiraEm: 1_756_014_400_000, expirada: true },
    });

    expect(r.credencial?.renovacaoFalhou).toBe(false);
  });

  it('⚠️ NEAR MISS — a backend that DOES send `true` keeps it', () => {
    // The control on the default. A `.catch(false)`, or a default applied over a
    // present value, would pass the case above and silently paint every dead
    // grant as healthy — which is the whole state this field exists to surface.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      credencial: { expiraEm: 1_756_014_400_000, expirada: true, renovacaoFalhou: true },
    });

    expect(r.credencial?.renovacaoFalhou).toBe(true);
  });

  it('⚠️ REJECTS a non-boolean — the default covers ABSENT, never malformed', () => {
    // `.default()` fires on `undefined` only. A `'true'` here is our own
    // serialisation bug on the backend side and must be loud (rule 3), not
    // quietly folded to `false` — which would read as a healthy conta.
    for (const renovacaoFalhou of ['true', 1, null]) {
      const r = shopeeContaStatusSchema.safeParse({
        ...CONTA,
        credencial: { expiraEm: 1_756_014_400_000, expirada: true, renovacaoFalhou },
      });

      expect(r.success).toBe(false);
    }
  });
});

describe('loja.status — a widened enum degrades the BADGE, not the read', () => {
  it('⭐ maps an unknown lifecycle member to null and keeps the rest of the loja', () => {
    // Shopee documents three values today. A fourth must cost one badge, never
    // the conta panel — the `pagamento.ts` `.catch(null)` idiom.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      loja: { shopName: 'Loja Teste', region: 'BR', status: 'SUSPENDED' },
    });

    expect(r.loja?.status).toBeNull();
    expect(r.loja?.shopName).toBe('Loja Teste');
  });

  it('the three known members survive the catch', () => {
    // The control: a `.catch(null)` that swallowed everything would pass the
    // case above just as happily.
    for (const status of ['BANNED', 'FROZEN', 'NORMAL'] as const) {
      expect(shopeeLojaSchema.parse({ shopName: null, region: null, status }).status).toBe(status);
    }
  });

  it('⚠️ NEAR MISS — a malformed SIBLING still rejects the whole loja', () => {
    // The catch is scoped to `status` alone. Without this, widening it to the
    // object (or to `z.any()`) would leave every case above green.
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      loja: { shopName: 42, region: 'BR', status: 'NORMAL' },
    });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('loja.shopName');
  });

  it('an ABSENT status key also degrades to null — a consequence of the catch, written down', () => {
    // Not a separate decision: `.catch` catches the missing-key failure too. It
    // is pinned so nobody discovers it by surprise, and it is the tolerant
    // direction anyway (rule 2's maintenance note).
    expect(shopeeLojaSchema.parse({ shopName: null, region: null }).status).toBeNull();
  });
});

describe('unknown keys pass — the browser is routinely older or newer than the backend', () => {
  it('keeps parsing when the backend grows a field this build never heard of', () => {
    // Nothing here is `.strict()`. A strict object would turn every forward
    // deploy of `apps/shopee` into an outage on this screen.
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      campoNovoDoFuturo: { qualquer: 'coisa' },
    });

    expect(r.success).toBe(true);
  });

  it('strips the unknown key rather than carrying it into the type', () => {
    const r = shopeeContaStatusSchema.parse({ ...CONTA, campoNovoDoFuturo: 1 });

    expect('campoNovoDoFuturo' in r).toBe(false);
  });
});

describe('the disconnected answer is a STATE, not a failure', () => {
  it('parses `CONTA_DESCONECTADA` — every key null except connected', () => {
    // The most common body this route serves. If it did not parse, a conta that
    // was never connected would render as an error.
    const r = shopeeContaStatusSchema.parse({
      connected: false,
      shopId: null,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: null,
    });

    expect(r.connected).toBe(false);
    expect(r.credencial).toBeNull();
  });

  it('parses the REVOKED shape — disconnected, but both clocks still echoed', () => {
    const r = shopeeContaStatusSchema.parse({
      connected: false,
      shopId: 123,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: { expiraEm: 10, expirada: true, renovacaoFalhou: true },
    });

    expect(r.shopId).toBe(123);
    expect(r.credencial?.expirada).toBe(true);
  });
});

describe('oauthStartResponseSchema', () => {
  it('accepts a real consent URL', () => {
    const url =
      'https://partner.test-stable.shopeemobile.com/api/v2/shop/auth_partner?partner_id=1';

    expect(oauthStartResponseSchema.parse({ authorizeUrl: url }).authorizeUrl).toBe(url);
  });

  it('⭐ REJECTS an empty authorizeUrl — `location.assign("")` silently RELOADS', () => {
    // The near miss that matters here: `''` is a string, so a bare `z.string()`
    // would accept it and the operator would click "Conectar conta" and land
    // back on the same page with no error anywhere.
    expect(oauthStartResponseSchema.safeParse({ authorizeUrl: '' }).success).toBe(false);
  });
});

describe('⚠️ ANTI-VACUITY — a wrong body is still rejected', () => {
  // Without these, every "tolerates X" case above passes just as happily
  // against `z.any()`, and this file would be pinning nothing at all.
  it('rejects a MISSING connected — the field the panel switches on', () => {
    // `{}` cast to `ShopeeContaStatus` reads `connected === undefined`, which is
    // falsy: the screen would tell the operator to reconnect a live account.
    const { connected: _drop, ...sem } = CONTA;
    const r = shopeeContaStatusSchema.safeParse(sem);

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('connected');
  });

  it('rejects `connected: "sim"` — a boolean is not a truthy string', () => {
    expect(shopeeContaStatusSchema.safeParse({ ...CONTA, connected: 'sim' }).success).toBe(false);
  });

  it('rejects an ABSENT credencial — nullable is not optional', () => {
    // Rule 2: nothing here is optional today, because no return path omits it.
    // A defaulted `credencial` would make "no credential stored" and "the
    // backend forgot to send it" the same picture.
    const { credencial: _drop, ...sem } = CONTA;

    expect(shopeeContaStatusSchema.safeParse(sem).success).toBe(false);
  });

  it('rejects an ABSENT loja for the same reason', () => {
    const { loja: _drop, ...sem } = CONTA;

    expect(shopeeContaStatusSchema.safeParse(sem).success).toBe(false);
  });

  it('rejects null where the whole object is required', () => {
    expect(shopeeContaStatusSchema.safeParse(null).success).toBe(false);
  });

  it('names the offending field PATHS, which is what the operator error carries', () => {
    // `call()` builds its message out of these paths, and paths only — never
    // values. A response body is a live credential often enough that the rule
    // holds unconditionally (#1015).
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      connected: 'sim',
      diasParaExpirar: '12',
    });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('connected');
    expect(campos).toContain('diasParaExpirar');
  });

  it('rejects a missing authorizeUrl', () => {
    expect(oauthStartResponseSchema.safeParse({}).success).toBe(false);
  });
});
