'use client';

import { redirect, useParams } from 'next/navigation';

// A WhatsApp conversa is just a `chat` conversa — redirect into the unified
// inbox, preserving the id so deep links keep working.
export default function WhatsAppConversaRedirect() {
  const { id } = useParams<{ id: string }>();
  redirect(`/chat/${id}`);
}
