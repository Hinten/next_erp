import { describe, expect, it } from 'vitest';

import { buildDetXml, buildProd, NFeDetError } from '../../src/generator/det';
import type { GeneratorItem } from '../../src/generator/types';

/**
 * `NVE`, `indEscala`, `CNPJFab`, `cBenef` and `EXTIPI` are the `<prod>` children
 * the legacy Flutter emitter carried (`pedido_nfe_base.dart:938-947`) and the
 * TypeScript port never wired: they were stripped by `impostoSchema` at resolve
 * and absent from `GeneratorItem` at emit, so they could not reach the XML on
 * ANY cascade tier.
 */
const ITEM: GeneratorItem = {
  nItem: 1,
  cProd: 'BIKE-001',
  cEAN: 'SEM GTIN',
  xProd: 'Bicicleta Aro 29',
  NCM: '87120000',
  CFOP: '5102',
  uCom: 'UN',
  qCom: 1,
  vUnCom: 1500,
  vProd: 1500,
  cEANTrib: 'SEM GTIN',
  uTrib: 'UN',
  qTrib: 1,
  vUnTrib: 1500,
  impostoXml: '<imposto/>',
};

describe('buildProd — NVE', () => {
  it('emits the codes as a list', () => {
    expect(buildProd({ ...ITEM, NVE: ['AB1234', 'CD5678'] }).NVE).toEqual(['AB1234', 'CD5678']);
  });

  it('omits the element when absent or empty', () => {
    expect(buildProd(ITEM).NVE).toBeUndefined();
    expect(buildProd({ ...ITEM, NVE: [] }).NVE).toBeUndefined();
  });

  it('copies the array rather than aliasing the caller’s', () => {
    const NVE = ['AB1234'];
    const prod = buildProd({ ...ITEM, NVE });
    expect(prod.NVE).not.toBe(NVE);
  });

  // Validated HERE rather than in `impostoSchema`: a parse failure there makes
  // the resolver fall through to a LOWER tax tier silently — a wrong NF-e —
  // while a throw here is loud and names the value.
  it('rejects a code that is not 2 uppercase letters + 4 digits', () => {
    for (const bad of ['ab1234', 'A1234', 'AB123', 'AB12345', 'ABC123', '']) {
      expect(() => buildProd({ ...ITEM, NVE: [bad] })).toThrow(NFeDetError);
    }
    expect(() => buildProd({ ...ITEM, NVE: ['zz9999'] })).toThrow(/AB1234/);
  });

  it('rejects more than the 8 the XSD allows', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `AB000${i}`);
    expect(() => buildProd({ ...ITEM, NVE: nine })).toThrow(/at most 8/);
    expect(() => buildProd({ ...ITEM, NVE: nine.slice(0, 8) })).not.toThrow();
  });
});

describe('buildProd — indEscala / CNPJFab and the CEST-required group', () => {
  const CEST = '2806300';

  it('emits S/N from the stored boolean', () => {
    expect(buildProd({ ...ITEM, CEST, indEscala: true }).indEscala).toBe('S');
    expect(buildProd({ ...ITEM, CEST, indEscala: false }).indEscala).toBe('N');
  });

  it('omits the element when not informed', () => {
    expect(buildProd({ ...ITEM, CEST }).indEscala).toBeUndefined();
  });

  // ⚠️ The XSD trap. `CEST`, `indEscala` and `CNPJFab` share an
  // `<xs:sequence minOccurs="0">` in which `CEST` is REQUIRED
  // (leiauteNFe_v4.00.xsd:936-962), so `<indEscala>` with no `<CEST>` is
  // schema-invalid — rejection 215, discovered only after signing. The group is
  // optional as a whole, so dropping it is the one valid choice.
  it('DROPS indEscala and CNPJFab when the item carries no CEST', () => {
    const prod = buildProd({ ...ITEM, indEscala: false, CNPJFab: '12345678000199' });
    expect(prod.CEST).toBeUndefined();
    expect(prod.indEscala).toBeUndefined();
    expect(prod.CNPJFab).toBeUndefined();
  });

  it('emits CNPJFab only alongside escala NÃO relevante', () => {
    // "obrigatório para produto em escala NÃO relevante" (XSD annotation), so
    // it has no meaning next to an 'S'. Flutter gated it on `indEscala != null`
    // and emitted it either way; this follows the XSD instead.
    const CNPJFab = '12345678000199';
    expect(buildProd({ ...ITEM, CEST, indEscala: false, CNPJFab }).CNPJFab).toBe(CNPJFab);
    expect(buildProd({ ...ITEM, CEST, indEscala: true, CNPJFab }).CNPJFab).toBeUndefined();
  });
});

describe('buildProd — cBenef / EXTIPI', () => {
  it('emits them when set and omits them when blank', () => {
    const prod = buildProd({ ...ITEM, cBenef: 'SEM CBENEF', EXTIPI: '01' });
    expect(prod.cBenef).toBe('SEM CBENEF');
    expect(prod.EXTIPI).toBe('01');
    expect(buildProd({ ...ITEM, cBenef: '', EXTIPI: '' }).cBenef).toBeUndefined();
  });

  // Unlike indEscala/CNPJFab these are siblings OUTSIDE the CEST group, so they
  // stand on their own.
  it('does not depend on CEST', () => {
    expect(buildProd({ ...ITEM, cBenef: 'SEM CBENEF' }).cBenef).toBe('SEM CBENEF');
  });
});

describe('buildDetXml — the fields actually reach the signed XML', () => {
  it('serialises all five in XSD element order', () => {
    const xml = buildDetXml({
      ...ITEM,
      CEST: '2806300',
      NVE: ['AB1234', 'CD5678'],
      indEscala: false,
      CNPJFab: '12345678000199',
      cBenef: 'SEM CBENEF',
      EXTIPI: '01',
    });
    // Both NVE codes are repeated elements, not a joined string.
    expect(xml).toContain('<NVE>AB1234</NVE>');
    expect(xml).toContain('<NVE>CD5678</NVE>');
    expect(xml).toContain('<indEscala>N</indEscala>');
    expect(xml).toContain('<CNPJFab>12345678000199</CNPJFab>');
    expect(xml).toContain('<cBenef>SEM CBENEF</cBenef>');
    expect(xml).toContain('<EXTIPI>01</EXTIPI>');

    // XSD sequence: NCM → NVE → CEST → indEscala → CNPJFab → cBenef → … → CFOP.
    // The order is what the schema validates, so assert positions, not presence.
    const at = (tag: string) => xml.indexOf(`<${tag}>`);
    expect(at('NCM')).toBeLessThan(at('NVE'));
    expect(at('NVE')).toBeLessThan(at('CEST'));
    expect(at('CEST')).toBeLessThan(at('indEscala'));
    expect(at('indEscala')).toBeLessThan(at('CNPJFab'));
    expect(at('CNPJFab')).toBeLessThan(at('cBenef'));
    expect(at('cBenef')).toBeLessThan(at('CFOP'));
  });

  it('emits none of them for an item that carries none (unchanged output)', () => {
    const xml = buildDetXml(ITEM);
    for (const tag of ['NVE', 'indEscala', 'CNPJFab', 'cBenef', 'EXTIPI']) {
      expect(xml).not.toContain(`<${tag}>`);
    }
  });
});
