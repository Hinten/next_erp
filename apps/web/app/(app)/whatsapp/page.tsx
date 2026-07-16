'use client';

import { redirect } from 'next/navigation';

// The WhatsApp inbox is now the unified `/chat` inbox (origem filter lives in
// the inbox filters). Kept as a redirect so old links / bookmarks still work.
export default function WhatsAppInboxRedirect() {
  redirect('/chat');
}
