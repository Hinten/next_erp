import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { searchParamsRef } = vi.hoisted(() => ({
  searchParamsRef: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/clientes',
  useSearchParams: () => searchParamsRef.current,
}));

import { readSearchTerm, useSearchTermParam, writeSearchTerm } from './useSearchTermParam';

afterEach(() => {
  sessionStorage.clear();
  searchParamsRef.current = new URLSearchParams();
  window.history.replaceState(null, '', '/clientes');
  vi.restoreAllMocks();
});

describe('useSearchTermParam', () => {
  it('opens empty when nothing was searched', () => {
    const { result } = renderHook(() => useSearchTermParam());
    expect(result.current[0]).toBe('');
  });

  it('reads the term from the URL', () => {
    searchParamsRef.current = new URLSearchParams('q=rua+das+flores');
    const { result } = renderHook(() => useSearchTermParam());
    expect(result.current[0]).toBe('rua das flores');
  });

  it('restores the last term when the URL is bare', () => {
    // Returning from a cliente lands on the BARE list path, which is the whole
    // reason this is not plain `useState`.
    writeSearchTerm('/clientes', 'q', 'rua das flores');
    const { result } = renderHook(() => useSearchTermParam());
    expect(result.current[0]).toBe('rua das flores');
  });

  it('puts a restored term into the URL so the address bar agrees with the input', () => {
    writeSearchTerm('/clientes', 'q', 'rua das flores');
    renderHook(() => useSearchTermParam());
    expect(window.location.search).toBe('?q=rua+das+flores');
  });

  it('lets the URL win over the memory', () => {
    writeSearchTerm('/clientes', 'q', 'remembered');
    searchParamsRef.current = new URLSearchParams('q=from-the-link');
    const { result } = renderHook(() => useSearchTermParam());
    expect(result.current[0]).toBe('from-the-link');
  });

  it('mirrors a committed term into the URL and the memory', () => {
    const { result } = renderHook(() => useSearchTermParam());
    act(() => result.current[1]('centro'));
    expect(result.current[0]).toBe('centro');
    expect(window.location.search).toBe('?q=centro');
    expect(readSearchTerm('/clientes', 'q')).toBe('centro');
  });

  it('keeps foreign query params when it writes', () => {
    window.history.replaceState(null, '', '/clientes?nome=contains%3Aana');
    const { result } = renderHook(() => useSearchTermParam());
    act(() => result.current[1]('centro'));
    expect(window.location.search).toBe('?nome=contains%3Aana&q=centro');
  });

  it('forgets the term when it is cleared, so clearing sticks', () => {
    writeSearchTerm('/clientes', 'q', 'centro');
    const { result } = renderHook(() => useSearchTermParam());
    act(() => result.current[1](''));
    expect(readSearchTerm('/clientes', 'q')).toBe('');
    expect(window.location.search).toBe('');
    // Asserted on the raw entry, not just through `readSearchTerm`: storing an
    // empty string reads back identically, so a version that never removed the
    // key would pass every observable check above while leaving one dead entry
    // per screen behind for the life of the tab.
    expect(sessionStorage.getItem('delfrance:list-search:/clientes:q')).toBeNull();
  });

  it('degrades to no memory when sessionStorage throws', () => {
    // Private mode. This runs during a render, so it must not take the page down.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => renderHook(() => useSearchTermParam())).not.toThrow();
  });

  it('rethrows a non-DOMException from storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new TypeError('something else entirely');
    });
    expect(() => readSearchTerm('/clientes', 'q')).toThrow(TypeError);
  });

  it('keys the memory per screen', () => {
    writeSearchTerm('/clientes', 'q', 'centro');
    expect(readSearchTerm('/produtos', 'q')).toBe('');
  });
});
