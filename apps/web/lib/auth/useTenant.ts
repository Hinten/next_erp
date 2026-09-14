import { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { getFirebaseAuth } from '../firebase/client';
export interface TenantClaims {
  grupoEconomico: string | null;
  permissions: string | null;
}
export function useTenant(): { claims: TenantClaims | null; loading: boolean } {
  const [claims, setClaims] = useState<TenantClaims | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let generation = 0;
    const unsubscribe = onIdTokenChanged(getFirebaseAuth(), (user) => {
      const current = ++generation;
      if (!user) {
        setClaims(null);
        setLoading(false);
        return;
      }
      void user
        .getIdTokenResult()
        .then((result) => {
          if (current !== generation) return;
          setClaims({
            grupoEconomico:
              typeof result.claims.grupoEconomico === 'string'
                ? result.claims.grupoEconomico
                : null,
            permissions:
              typeof result.claims.permissions === 'string' ? result.claims.permissions : null,
          });
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!(err instanceof FirebaseError)) throw err;
          if (current === generation) {
            setClaims(null);
            setLoading(false);
          }
        });
    });
    return () => {
      generation++;
      unsubscribe();
    };
  }, []);
  return { claims, loading };
}
