'use client';

import { IntFreteListPage } from '../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../_components/slices';

export default function MotoboyPage() {
  return <IntFreteListPage slice={LOGISTICA_SLICES.motoboy} />;
}
