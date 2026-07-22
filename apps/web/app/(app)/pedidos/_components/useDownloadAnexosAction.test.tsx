import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useDownloadAnexosAction } from './useDownloadAnexosAction';

describe('useDownloadAnexosAction', () => {
  it('exposes a selection-required Download Anexos action', () => {
    const { result } = renderHook(() => useDownloadAnexosAction());
    expect(result.current.action.id).toBe('download-anexos');
    expect(result.current.action.label).toBe('Download Anexos');
    expect(result.current.action.requiresSelection).toBe(true);
    expect(typeof result.current.action.run).toBe('function');
  });
});
