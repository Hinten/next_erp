'use client';
import { useParams } from 'next/navigation';
import { AccessEditor } from '@/components/AccessEditor';
export default function CargoPage() {
  const { id } = useParams<{ id: string }>();
  return <AccessEditor id={id} cargo />;
}
