import { describe, expect, it } from 'vitest';

import { assertSignedXmlNeverLost } from './xml-invariant';

const NFEV4 = 'pedidos/PED-1/nfev4/s1';

describe('assertSignedXmlNeverLost (#128 fake-Firestore guard)', () => {
  it('throws when a merge clears xml_assinado without a proc in the same payload', () => {
    expect(() => assertSignedXmlNeverLost(NFEV4, { xml_assinado: null }, true)).toThrow(
      /#128 invariant violated/,
    );
    expect(() =>
      assertSignedXmlNeverLost(NFEV4, { xml_assinado: null, xml_nfe_proc: null }, true),
    ).toThrow(/#128 invariant violated/);
    expect(() =>
      assertSignedXmlNeverLost(NFEV4, { xml_assinado: null, xml_nfe_proc: '' }, true),
    ).toThrow(/#128 invariant violated/);
  });

  it('accepts the legal pair: proc + cleared anchor in one merge', () => {
    expect(() =>
      assertSignedXmlNeverLost(NFEV4, { xml_assinado: null, xml_nfe_proc: '<nfeProc/>' }, true),
    ).not.toThrow();
  });

  it('accepts a full-doc write with xml_assinado null (numeração placeholder)', () => {
    expect(() =>
      assertSignedXmlNeverLost(NFEV4, { xml_assinado: null, xml_nfe_proc: null }, undefined),
    ).not.toThrow();
  });

  it('accepts merges that do not touch the anchor', () => {
    expect(() =>
      assertSignedXmlNeverLost(NFEV4, { estado: 'a', cStat: '100' }, true),
    ).not.toThrow();
  });

  it('rejects FieldValue-style sentinels on XML fields (deletion would break the schema)', () => {
    const sentinel = { _methodName: 'FieldValue.delete' };
    expect(() => assertSignedXmlNeverLost(NFEV4, { xml_assinado: sentinel }, true)).toThrow(
      /non-string value/,
    );
    expect(() => assertSignedXmlNeverLost(NFEV4, { xml_nfe_proc: sentinel }, false)).toThrow(
      /non-string value/,
    );
  });

  it('ignores non-nfev4 paths (audit log, config docs)', () => {
    expect(() =>
      assertSignedXmlNeverLost('filiais/F-1/enviNfe/auto-1', { xml_assinado: null }, true),
    ).not.toThrow();
  });
});
