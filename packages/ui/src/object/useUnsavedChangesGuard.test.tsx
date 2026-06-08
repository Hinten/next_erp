import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

const addSpy = vi.spyOn(window, 'addEventListener');
const removeSpy = vi.spyOn(window, 'removeEventListener');
const docAddSpy = vi.spyOn(document, 'addEventListener');
const confirmSpy = vi.spyOn(window, 'confirm');

afterEach(() => {
  addSpy.mockClear();
  removeSpy.mockClear();
  docAddSpy.mockClear();
  confirmSpy.mockReset();
});

describe('useUnsavedChangesGuard', () => {
  it('installs no listeners when not dirty', () => {
    renderHook(() => useUnsavedChangesGuard(false));
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(addSpy).not.toHaveBeenCalledWith('popstate', expect.any(Function));
    expect(docAddSpy).not.toHaveBeenCalledWith('click', expect.any(Function), true);
  });

  it('installs beforeunload + popstate + click when dirty, removes on cleanup', () => {
    const { rerender, unmount } = renderHook(({ d }: { d: boolean }) => useUnsavedChangesGuard(d), {
      initialProps: { d: true },
    });
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    expect(docAddSpy).toHaveBeenCalledWith('click', expect.any(Function), true);

    rerender({ d: false });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));

    unmount();
  });

  it('beforeunload sets returnValue to trigger the native prompt', () => {
    renderHook(() => useUnsavedChangesGuard(true));
    const handler = addSpy.mock.calls.find((c) => c[0] === 'beforeunload')![1] as EventListener;
    const event = new Event('beforeunload') as BeforeUnloadEvent;
    Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
    handler(event);
    expect(event.returnValue).toBeTruthy();
  });

  it('intercepts an internal link click and blocks it when the user cancels', () => {
    confirmSpy.mockReturnValue(false);
    renderHook(() => useUnsavedChangesGuard(true));
    const onClick = docAddSpy.mock.calls.find(
      (c) => c[0] === 'click' && c[2] === true,
    )![1] as EventListener;

    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/outra-rota');
    document.body.appendChild(anchor);
    const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor });
    onClick(event);

    expect(confirmSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    document.body.removeChild(anchor);
  });

  it('lets an internal link click through when the user confirms', () => {
    confirmSpy.mockReturnValue(true);
    renderHook(() => useUnsavedChangesGuard(true));
    const onClick = docAddSpy.mock.calls.find(
      (c) => c[0] === 'click' && c[2] === true,
    )![1] as EventListener;

    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/outra-rota');
    document.body.appendChild(anchor);
    const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor });
    onClick(event);

    expect(confirmSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    document.body.removeChild(anchor);
  });

  it('confirms on popstate (back/forward)', () => {
    confirmSpy.mockReturnValue(false);
    renderHook(() => useUnsavedChangesGuard(true));
    const onPopState = addSpy.mock.calls.find((c) => c[0] === 'popstate')![1] as EventListener;
    onPopState(new PopStateEvent('popstate'));
    expect(confirmSpy).toHaveBeenCalled();
  });
});
