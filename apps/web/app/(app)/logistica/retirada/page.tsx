'use client';

import { IntFreteListPage } from '../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../_components/slices';

export default function RetiradaPage() {
  return <IntFreteListPage slice={LOGISTICA_SLICES.retirada} />;
}
