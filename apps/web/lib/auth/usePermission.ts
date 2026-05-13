'use client';

import { useTenant } from './useTenant';

export function usePermission(requiredBit: bigint): { allowed: boolean; loading: boolean } {
  const { claims, loading } = useTenant();
  if (loading || !claims?.permissions) {
    return { allowed: false, loading };
  }
  try {
    const granted = BigInt(claims.permissions);
    return { allowed: (granted & requiredBit) === requiredBit, loading: false };
  } catch {
    return { allowed: false, loading: false };
  }
}
