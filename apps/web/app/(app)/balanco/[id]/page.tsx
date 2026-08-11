'use client';

import { useParams } from 'next/navigation';

import { BalancoContagemScreen } from '../_components/BalancoContagemScreen';

export default function BalancoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  return <BalancoContagemScreen balancoId={id} />;
}
