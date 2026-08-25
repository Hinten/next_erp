/**
 * Codec for the two colour INTEGERS this repo stores, and the conversion
 * between them.
 *
 * Two fields, two domains, and they are NOT interchangeable:
 *
 * | Field | Domain | Written by |
 * |---|---|---|
 * | `integracao.cor` | 24-bit **RGB** (`0xRRGGBB`) | this app's channel forms |
 * | `integracao.cor` | 32-bit **ARGB** (`0xAARRGGBB`, alpha `0xFF`) | the legacy Flutter picker — the migrated corpus |
 * | `conversa.cor_etiqueta` | 32-bit **ARGB** always | legacy chat + this repo's importers |
 *
 * So a reader of `cor` must accept EITHER encoding ({@link corToRgb}), and a
 * writer moving a `cor` into `cor_etiqueta` must convert
 * ({@link corToEtiquetaArgb}) rather than copy — the etiqueta filter matches
 * its seven palette constants with an exact `==`, so a 24-bit value lands in a
 * field where nothing can ever select it.
 *
 * This lives in `@delfrance/core` rather than next to either consumer because
 * the two sides are in different deployables: `apps/web` renders the colours,
 * while `apps/mercado-livre` and `apps/whatsapp` are what write `cor_etiqueta`.
 * Splitting the codec is what let the domains drift apart in the first place.
 */

/**
 * Normalize a stored `integracao.cor` to a plain 24-bit RGB integer, or `null`
 * when there is no colour.
 *
 * `>>> 0` first: a Dart `Color.value` fits in a SIGNED int on the wire, so a
 * value with alpha `0xFF` can arrive negative. Anything still above `0xFFFFFF`
 * after that carries an alpha byte, which is masked off — the legacy picker only
 * ever wrote fully-opaque colours, so there is no transparency to lose.
 *
 * ⚠️ `0` is BLACK here, not "unset" — unlike `conversa.cor_etiqueta`, where
 * `hasEtiqueta` reads it as no-label. The legacy picker could not produce a bare
 * `0` (its black is `0xFF000000`), which leaves this app's own colour input as
 * the only writer of one, and there it means the operator picked `#000000`.
 * `null` is the unset value.
 */
export function corToRgb(cor: number | null | undefined): number | null {
  if (typeof cor !== 'number' || !Number.isFinite(cor)) return null;
  const v = Math.trunc(cor) >>> 0;
  return v > 0xffffff ? v & 0xffffff : v;
}

/** Stored `cor` → `#rrggbb`, or `null` when unset. */
export function corToHex(cor: number | null | undefined): string | null {
  const rgb = corToRgb(cor);
  return rgb === null ? null : `#${rgb.toString(16).padStart(6, '0')}`;
}

/**
 * `#rrggbb` (or the `#rgb` shorthand) → the 24-bit RGB int this app stores.
 * Anything else → `null`. The write half of {@link corToHex}.
 */
export function hexToCor(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return null;
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return Number.parseInt(full, 16);
}

/**
 * An integração's `cor` in the domain `conversa.cor_etiqueta` uses: a 32-bit
 * **ARGB** `Color.value` with a fully-opaque alpha. `null` when the conta has no
 * colour (callers that store `0` for "no etiqueta" keep their own `?? 0`).
 *
 * ⚠️ This conversion is not cosmetic. The chat etiqueta filter matches with an
 * exact equality (`conversaConstraints`: `where('cor_etiqueta','==',…)`) against
 * the seven `ETIQUETA_CORES` constants, every one of which carries the `0xff`
 * alpha byte. A raw 24-bit `0xf44336` copied straight across can never equal
 * `0xfff44336`, so the conversa becomes selectable by NO etiqueta at all — while
 * still painting the right colour, because the tile hardcodes its own alpha.
 * That combination is why the mismatch is invisible until someone tries to
 * filter.
 *
 * `>>> 0` because `|` coerces to int32: without it the result is negative and
 * would not equal the unsigned palette constant either.
 */
export function corToEtiquetaArgb(cor: number | null | undefined): number | null {
  const rgb = corToRgb(cor);
  return rgb === null ? null : (0xff000000 | rgb) >>> 0;
}
