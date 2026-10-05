import { describe, expect, it } from 'vitest';
import { RETURN_SN_SHOPEE_MAX, ehReturnSnShopee } from './devolucaoShopee';

/**
 * `ehReturnSnShopee` decides which strings are ONE return id — an equivalence
 * fold in all but name, since the push parser, the routes and the web mount all
 * key on it. So both halves are pinned: what it accepts AND the near-misses it
 * must refuse (root `CLAUDE.md`: a test that the fold applies cannot show where
 * it stops).
 */

/** The step-17 fixture ids — synthetic, never a real return. */
const RETURN_SN_DIGITOS = '2609100000000001';
const RETURN_SN_ALFANUMERICO = '260910ABCDE0001';

describe('ehReturnSnShopee — what it accepts', () => {
  it('accepts the ALPHANUMERIC shape Shopee documents, not only digits', () => {
    // The returns pages' own samples carry letters (`2411280EDT4JRV5`). A
    // digits-only guard would refuse every real return while a digits-only
    // fixture kept everything green — this is the case that catches it.
    expect(ehReturnSnShopee(RETURN_SN_ALFANUMERICO)).toBe(true);
    expect(ehReturnSnShopee(RETURN_SN_DIGITOS)).toBe(true);
  });

  it('accepts lower-case letters — the allow-list is [A-Za-z0-9], not a case fold', () => {
    expect(ehReturnSnShopee('260910abcde0001')).toBe(true);
  });

  it('accepts one character and exactly RETURN_SN_SHOPEE_MAX characters', () => {
    expect(RETURN_SN_SHOPEE_MAX).toBe(64);
    expect(ehReturnSnShopee('A')).toBe(true);
    expect(ehReturnSnShopee('A'.repeat(RETURN_SN_SHOPEE_MAX))).toBe(true);
  });
});

describe('ehReturnSnShopee — the near-misses it must refuse', () => {
  it('refuses one character past the bound', () => {
    expect(ehReturnSnShopee('A'.repeat(RETURN_SN_SHOPEE_MAX + 1))).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(ehReturnSnShopee('')).toBe(false);
  });

  it('never trims: leading, trailing and newline padding are refused, not repaired', () => {
    // A trailing `\n` is the one a `$` anchor with a multiline reading would let
    // through; JS anchors at the end of INPUT, and this pins that it stays so.
    for (const comPreenchimento of [
      ` ${RETURN_SN_ALFANUMERICO}`,
      `${RETURN_SN_ALFANUMERICO} `,
      `${RETURN_SN_ALFANUMERICO}\n`,
      `\t${RETURN_SN_DIGITOS}`,
    ]) {
      expect(ehReturnSnShopee(comPreenchimento), JSON.stringify(comPreenchimento)).toBe(false);
    }
  });

  it('refuses every character a doc id, an aviso key or a URL would have to fold', () => {
    // `/` forks a Firestore path, `.`/`:`/`#` are folded by `chaveDeAviso`, `_`
    // is what that fold PRODUCES (so `a:b` and `a_b` would become one aviso), and
    // `-` is the returns pages' success-error alias — none is ever an id.
    for (const c of ['/', '.', ':', '#', '_', '-', ' ', '%', '?', '&', '+']) {
      expect(ehReturnSnShopee(`260910${c}0001`), c).toBe(false);
    }
  });

  it('refuses non-ASCII look-alikes — an accented letter and full-width digits', () => {
    expect(ehReturnSnShopee('260910ÁBCDE0001')).toBe(false);
    expect(ehReturnSnShopee('２６０９１０')).toBe(false);
  });

  it('refuses a NUMBER, even one that stringifies to a valid id', () => {
    // The wire carries return_sn as a string; a number here means someone parsed
    // it — a step the alphanumeric ids cannot survive at all — so a `String(v)`
    // before the test would bless a value that already lost its shape.
    expect(ehReturnSnShopee(2609100000000001)).toBe(false);
    expect(ehReturnSnShopee(null)).toBe(false);
    expect(ehReturnSnShopee(undefined)).toBe(false);
    expect(ehReturnSnShopee({ toString: () => RETURN_SN_DIGITOS })).toBe(false);
  });
});
