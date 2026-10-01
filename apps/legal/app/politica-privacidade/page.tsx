import type { Metadata } from 'next';
import { connection } from 'next/server';
import { LegalDocument } from '@/components/LegalDocument';
import { readLegalConfig } from '@/lib/config';
import { privacyPolicy } from '@/lib/documents';

export const metadata: Metadata = { title: 'Política de Privacidade' };

export default async function PrivacyPage() {
  await connection();
  return <LegalDocument document={privacyPolicy} config={readLegalConfig()} />;
}
