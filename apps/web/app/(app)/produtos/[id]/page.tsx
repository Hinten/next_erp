'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * The intermediate product detail view was removed — the ObjectView editor is
 * the product screen now. This route survives only as a redirect so deep links
 * and old bookmarks (`/produtos/<id>`) keep working.
 */
export default function ProdutoDetailRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/produtos/${params.id}/editar`);
  }, [params.id, router]);

  return null;
}
