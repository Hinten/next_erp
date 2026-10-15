import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('firebase/auth', () => ({
  onIdTokenChanged: m.subscribe.mockImplementation(() => m.unsubscribe),
}));
vi.mock('../firebase/client', () => ({ getFirebaseAuth: () => ({}) }));
import { useTenant } from './useTenant';
it('updates permissions when the same Firebase user receives a renewed token', async () => {
  const hook = renderHook(() => useTenant());
  const listener = m.subscribe.mock.calls.at(-1)![1] as (user: unknown) => void;
  const getIdTokenResult = vi.fn().mockResolvedValue({ claims: { permissions: '3' } });
  const user = { getIdTokenResult };
  act(() => listener(user));
  await waitFor(() => expect(hook.result.current.claims?.permissions).toBe('3'));
  getIdTokenResult.mockResolvedValue({ claims: { permissions: '0' } });
  act(() => listener(user));
  await waitFor(() => expect(hook.result.current.claims?.permissions).toBe('0'));
  act(() => listener(null));
  expect(hook.result.current.claims).toBeNull();
  hook.unmount();
  expect(m.unsubscribe).toHaveBeenCalled();
});
