import { describe, expect, it } from 'vitest';

import { MirrorConfigError, assertDistinctProjects } from './admin';

describe('assertDistinctProjects', () => {
  it('accepts a legacy source writing into a different project', () => {
    expect(() => assertDistinctProjects('legacy-prod', 'new-prod')).not.toThrow();
  });

  it('refuses to mirror a project into itself', () => {
    expect(() => assertDistinctProjects('new-prod', 'new-prod')).toThrow(MirrorConfigError);
  });

  it('refuses when the source project is unknown instead of passing vacuously', () => {
    expect(() => assertDistinctProjects(undefined, 'new-prod')).toThrow(MirrorConfigError);
    expect(() => assertDistinctProjects('', 'new-prod')).toThrow(MirrorConfigError);
  });
});
