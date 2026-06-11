'use client';

import { IntFreteEditPage } from '../../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../../_components/slices';

export default function MotoboyEditPage() {
  return <IntFreteEditPage slice={LOGISTICA_SLICES.motoboy} />;
}
