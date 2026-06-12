'use client';

import { IntFreteEditPage } from '../../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../../_components/slices';

export default function MelhorEnviosEditPage() {
  return <IntFreteEditPage slice={LOGISTICA_SLICES['melhor-envios']} />;
}
