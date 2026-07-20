'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Center, Loader } from '@mantine/core';

/**
 * The list/detail routes point here; the ObjectView editor at `[id]/editar` is
 * the actual screen. This route survives only as a redirect so deep links and
 * old bookmarks (`/listas-de-precos/<id>`) keep working (same pattern as
 * `produtos/[id]/page.tsx`). A loader fills the brief hydration window before
 * the redirect fires.
 */
export default function ListaDePrecosDetailRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/listas-de-precos/${params.id}/editar`);
  }, [params.id, router]);

  return (
    <Center mih={200}>
      <Loader />
    </Center>
  );
}
