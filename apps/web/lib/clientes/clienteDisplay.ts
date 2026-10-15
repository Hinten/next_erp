/** Shared by the null-ref column filter and customer display states. */
export const ANONIMO_LABEL = 'Anônimo';

export type ClienteDisplay =
  | { status: 'loading' }
  | { status: 'anonymous' | 'unrecognized' | 'missing' | 'error' | 'found'; label: string };

/**
 * Shared customer display states for pedido cells and the origin picker.
 * Anônimo matches the null-ref filter; missing and failed reads never do.
 */
export function resolveClienteDisplay({
  hasReference,
  recognized,
  data,
  isLoading,
  isError,
}: {
  hasReference: boolean;
  recognized: boolean;
  data: { nome?: string | null } | null | undefined;
  isLoading: boolean;
  isError: boolean;
}): ClienteDisplay {
  if (!hasReference) return { status: 'anonymous', label: ANONIMO_LABEL };
  if (!recognized) return { status: 'unrecognized', label: 'Cliente não reconhecido' };
  if (isError) return { status: 'error', label: 'Cliente indisponível' };
  // A disabled query waiting for the row batch also has no answer yet.
  if (isLoading || data === undefined) return { status: 'loading' };
  if (data === null) return { status: 'missing', label: 'Cadastro não encontrado' };
  return {
    status: 'found',
    label: typeof data.nome === 'string' && data.nome.trim() !== '' ? data.nome : '(sem nome)',
  };
}
