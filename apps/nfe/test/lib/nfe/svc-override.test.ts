/**
 * Contract tests for the homologação-only SVC authorizer override
 * (`NFE_SVC_AUTHORIZER_OVERRIDE`). The env is passed explicitly so the
 * tests never touch the real `process.env`.
 */
import { describe, expect, it } from 'vitest';

import { svcAuthorizerOverride } from '../../../lib/nfe/svc-override';

describe('svcAuthorizerOverride', () => {
  it('returns undefined when the variable is unset', () => {
    expect(svcAuthorizerOverride('homologacao', {})).toBeUndefined();
  });

  it('returns undefined when the variable is empty', () => {
    expect(svcAuthorizerOverride('homologacao', { NFE_SVC_AUTHORIZER_OVERRIDE: '' })).toBe(
      undefined,
    );
  });

  it('returns the authorizer in homologação', () => {
    expect(svcAuthorizerOverride('homologacao', { NFE_SVC_AUTHORIZER_OVERRIDE: 'svc-rs' })).toBe(
      'svc-rs',
    );
    expect(svcAuthorizerOverride('homologacao', { NFE_SVC_AUTHORIZER_OVERRIDE: 'svc-an' })).toBe(
      'svc-an',
    );
  });

  it('throws on a value that is not an SVC authorizer', () => {
    expect(() =>
      svcAuthorizerOverride('homologacao', { NFE_SVC_AUTHORIZER_OVERRIDE: 'svrs' }),
    ).toThrow(/must be 'svc-an' or 'svc-rs'/);
  });

  it('throws when set in produção — never misroute a real contingency', () => {
    expect(() =>
      svcAuthorizerOverride('producao', { NFE_SVC_AUTHORIZER_OVERRIDE: 'svc-rs' }),
    ).toThrow(/homologação-only/);
  });
});
