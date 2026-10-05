import type { Metadata } from 'next';
import { connection } from 'next/server';
import { LegalDocument } from '@/components/LegalDocument';
import { readLegalConfig } from '@/lib/config';
import { termsOfUse } from '@/lib/documents';

export const metadata: Metadata = { title: 'Termos de Uso' };

export default async function TermsPage() {
  await connection();
  return <LegalDocument document={termsOfUse} config={readLegalConfig()} />;
}
