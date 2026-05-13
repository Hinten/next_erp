'use client';

import { useMemo } from 'react';
import { isSuperUserBits } from '@delfrance/schemas';
import { useTenant } from './useTenant';

export function useIsSuperUser(): boolean {
  const { claims } = useTenant();
  return useMemo(() => {
    if (!claims?.permissions) return false;
    try {
      return isSuperUserBits(BigInt(claims.permissions));
    } catch (err) {
      if (err instanceof SyntaxError) {
        return false;
      }
      throw err;
    }
  }, [claims?.permissions]);
}
