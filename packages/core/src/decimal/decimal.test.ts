import { describe, expect, it } from 'vitest';

import { formatarCentesimos, localizarDecimal, parseCentesimos, parseDecimalPtBr } from './index';

describe('localizarDecimal', () => {
  it('turns a dot decimal into the pt-BR form', () => {
    expect(localizarDecimal('10.5')).toBe('10,5');
    expect(localizarDecimal('10.50')).toBe('10,50');
    expect(localizarDecimal('0.01')).toBe('0,01');
  });

  it('leaves an already-localized value alone', () => {
    expect(localizarDecimal('10,5')).toBe('10,5');
  });

  it('leaves a whole number alone', () => {
    expect(localizarDecimal('50')).toBe('50');
  });

  it('leaves an ambiguous thousands form alone', () => {
    // Both separators present: this module refuses to resolve which is which.
    expect(localizarDecimal('1.234,5')).toBe('1.234,5');
  });

  it('leaves three fractional digits alone', () => {
    // `1.234` reads equally well as a thousands group, and no garment
    // measurement carries that precision.
    expect(localizarDecimal('1.234')).toBe('1.234');
  });

  it('does not touch prose that merely contains a dot', () => {
    // The operator types into this field too — `'aprox, 50'` would be worse
    // than the dot it replaced.
    expect(localizarDecimal('aprox. 50')).toBe('aprox. 50');
    expect(localizarDecimal('10.5 cm')).toBe('10.5 cm');
  });

  it('keeps a sign', () => {
    expect(localizarDecimal('-2.5')).toBe('-2,5');
  });
});

describe('parseDecimalPtBr', () => {
  it('reads either separator', () => {
    expect(parseDecimalPtBr('10,5')).toBe(10.5);
    expect(parseDecimalPtBr('10.5')).toBe(10.5);
  });

  it('reads a whole number', () => {
    expect(parseDecimalPtBr('50')).toBe(50);
  });

  it('collapses trailing-zero spellings onto the same number', () => {
    // What makes `10,5` and `10.50` collide in the duplicate check.
    expect(parseDecimalPtBr('10,50')).toBe(parseDecimalPtBr('10.5'));
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDecimalPtBr(' 10,5 ')).toBe(10.5);
  });

  it('refuses an ambiguous thousands form', () => {
    expect(parseDecimalPtBr('1.234,5')).toBeNull();
  });

  it('refuses anything that is not a bare decimal', () => {
    expect(parseDecimalPtBr('10,5 cm')).toBeNull();
    expect(parseDecimalPtBr('')).toBeNull();
    expect(parseDecimalPtBr('M')).toBeNull();
  });
});

describe('parseCentesimos', () => {
  it('reads either separator into integer hundredths', () => {
    expect(parseCentesimos('10,5')).toBe(1050);
    expect(parseCentesimos('10.5')).toBe(1050);
    expect(parseCentesimos('10,51')).toBe(1051);
    expect(parseCentesimos('50')).toBe(5000);
  });

  it('keeps a sign', () => {
    expect(parseCentesimos('-2,5')).toBe(-250);
  });

  it('refuses more precision than it can represent', () => {
    // Rounding `10,125` to `10,13` in order to COMPARE it would edit a
    // measurement; such a cell is simply left for ML to judge.
    expect(parseCentesimos('10,125')).toBeNull();
  });

  it('refuses anything that is not a bare decimal', () => {
    expect(parseCentesimos('1.234,5')).toBeNull();
    expect(parseCentesimos('10,5 cm')).toBeNull();
    expect(parseCentesimos('')).toBeNull();
    expect(parseCentesimos('M')).toBeNull();
  });
});

describe('formatarCentesimos', () => {
  it('writes the fewest decimals that say it', () => {
    expect(formatarCentesimos(5000)).toBe('50');
    expect(formatarCentesimos(5050)).toBe('50,5');
    expect(formatarCentesimos(5001)).toBe('50,01');
    expect(formatarCentesimos(5010)).toBe('50,1');
  });

  it('keeps a sign', () => {
    expect(formatarCentesimos(-1)).toBe('-0,01');
  });

  it('survives repeated hundredth steps that binary floats would not', () => {
    // The duplicate offset walks `+1` hundredth at a time. In floats,
    // `50 + 0.01 + 0.01 + 0.01` is 50.029999999999994 and a Set keyed on it
    // misses `50.03` — which is why nothing here ever leaves the integers.
    let c = parseCentesimos('50')!;
    for (let i = 0; i < 3; i += 1) c += 1;
    expect(formatarCentesimos(c)).toBe('50,03');
  });

  it('round-trips through parseCentesimos', () => {
    for (const texto of ['0', '1', '50,01', '99,99', '123,4']) {
      expect(formatarCentesimos(parseCentesimos(texto)!)).toBe(texto);
    }
  });
});
