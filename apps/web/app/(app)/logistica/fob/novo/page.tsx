'use client';

import { IntFreteCreatePage } from '../../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../../_components/slices';

export default function NovoFobPage() {
  return <IntFreteCreatePage slice={LOGISTICA_SLICES.fob} />;
}
