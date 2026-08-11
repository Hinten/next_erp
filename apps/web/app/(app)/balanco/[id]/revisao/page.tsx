'use client';

import { useParams } from 'next/navigation';

import { BalancoRevisaoScreen } from '../../_components/BalancoRevisaoScreen';

export default function BalancoRevisaoPage() {
  const { id } = useParams<{ id: string }>();
  return <BalancoRevisaoScreen balancoId={id} />;
}
