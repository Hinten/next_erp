import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

const addSpy = vi.spyOn(window, 'addEventListener');
const removeSpy = vi.spyOn(window, 'removeEventListener');

afterEach(() => {
  addSpy.mockClear();
  removeSpy.mockClear();
});

describe('useUnsavedChangesGuard', () => {
  it('does not install a listener when not dirty', () => {
    renderHook(() => useUnsavedChangesGuard(false));
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('installs and removes the listener when dirty toggles', () => {
    const { rerender, unmount } = renderHook(({ d }: { d: boolean }) => useUnsavedChangesGuard(d), {
      initialProps: { d: true },
    });
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    const handler = addSpy.mock.calls.find((c) => c[0] === 'beforeunload')![1] as EventListener;
    const event = new Event('beforeunload') as BeforeUnloadEvent;
    Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
    handler(event);
    expect(event.returnValue).toBeTruthy();

    rerender({ d: false });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    unmount();
  });
});
