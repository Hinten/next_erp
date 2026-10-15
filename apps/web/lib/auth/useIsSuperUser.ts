'use client';

import { useMemo } from 'react';
import { isSuperUserBits } from '@delfrance/schemas';
import { useTenant } from './useTenant';

export function useIsSuperUser(): boolean {
  const { claims } = useTenant();
  const permissions = claims?.permissions;
  return useMemo(() => {
    if (!permissions) return false;
    try {
      return isSuperUserBits(BigInt(permissions));
    } catch (err) {
      if (err instanceof SyntaxError) {
        return false;
      }
      throw err;
    }
  }, [permissions]);
}
