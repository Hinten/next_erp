'use client';

import { Suspense } from 'react';

import { IntFreteListPage } from '../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../_components/slices';
import { MelhorEnvioCallbackToast } from './_components/MelhorEnvioCallbackToast';

export default function MelhorEnviosPage() {
  return (
    <>
      {/* The OAuth callback redirects HERE for the failures that happen before a
          trustworthy int_frete id exists (config / missing_params / bad_state).
          It lives in this wrapper rather than in IntFreteListPage, which fob /
          motoboy / retirada share and which has no OAuth flow. Behind Suspense
          because the hook reads useSearchParams. */}
      <Suspense fallback={null}>
        <MelhorEnvioCallbackToast />
      </Suspense>

      <IntFreteListPage slice={LOGISTICA_SLICES['melhor-envios']} />
    </>
  );
}
