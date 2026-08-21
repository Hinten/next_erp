'use client';

import { Divider, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import type { StockPushRow } from '@/lib/marketplace/estoque/types';
import { ListingDetails } from './ListingDetails';
import { ListingForm } from './ListingForm';
import type { ListingSaveFn } from './ListingForm';
import { ListingStatusStrip } from './ListingStatusStrip';

/**
 * ONE Mercado Livre anúncio: its live status, the last stock-push outcome, the
 * read-only publication facts, and the editable listing form.
 *
 * Purely presentational — every piece of state and every handler belongs to
 * `MercadoLivreEditor`, which owns them because they are either cross-account
 * (the dirty/loading sets and the flush registry feed the produto page's save
 * and leave-guard) or single-flight locks that a second, off-screen listing must
 * not be able to fire in parallel.
 */
export interface AnuncioBlockProps {
  produtoId: string;
  /** The `produtoMercadoLivre` doc id — this listing's identity everywhere. */
  linkDocId: string;
  /** The ML account this listing belongs to. */
  integracaoId: string;
  link: ProdutoMercadoLivreLink;
  db: Firestore;
  produtoNome: string;
  produtoEhUsado: boolean;
  produtoCondicao: number | null;
  /** `null` while the produto doc is still loading — NOT 0. */
  produtoFotoCount: number | null;
  canWrite: boolean;
  /** Whether the ML HTTP client exists (no authenticated user ⇒ null). */
  hasClient: boolean;
  disabled?: boolean;
  /** Anything this listing's controls must wait for. */
  loading: boolean;
  /** Separates this listing from the one above it in the same account. */
  showDivider?: boolean;
  /** Errors keyed by control — ML's rejection, its moderação, our 422. */
  serverErrors: Record<string, string[]>;
  /** The last stock-push outcome for THIS listing, if any. */
  stockResult?: StockPushRow;
  /** Resolved this session, for a User-Products listing. */
  urlResolvida: string | null;
  rechecking: boolean;
  /** True while ANY listing's re-check is in flight — the action is single-flight. */
  recheckBusy: boolean;
  abrindo: boolean;
  onReverificar: () => void;
  /** Undefined with no client: reading a public URL still needs one. */
  onAbrirAnuncio?: () => void;
  onDirtyChange: (linkDocId: string, dirty: boolean) => void;
  onLoadingChange: (linkDocId: string, loading: boolean) => void;
  registerFlush: (linkDocId: string, save: ListingSaveFn | null) => void;
}

export function AnuncioBlock({
  produtoId,
  linkDocId,
  integracaoId,
  link,
  db,
  produtoNome,
  produtoEhUsado,
  produtoCondicao,
  produtoFotoCount,
  canWrite,
  hasClient,
  disabled,
  loading,
  showDivider,
  serverErrors,
  stockResult,
  urlResolvida,
  rechecking,
  recheckBusy,
  abrindo,
  onReverificar,
  onAbrirAnuncio,
  onDirtyChange,
  onLoadingChange,
  registerFlush,
}: AnuncioBlockProps) {
  return (
    <Stack gap="sm" data-testid={`ml-anuncio-${linkDocId}`}>
      {showDivider && <Divider />}
      <ListingStatusStrip
        link={link}
        canWrite={hasClient && canWrite}
        disabled={Boolean(disabled) || recheckBusy || loading}
        rechecking={rechecking}
        onReverificar={onReverificar}
        urlResolvida={urlResolvida}
        abrindo={abrindo}
        onAbrirAnuncio={onAbrirAnuncio}
      />
      {stockResult && (
        <Text
          size="xs"
          c={
            stockResult.outcome === 'enviado'
              ? 'green'
              : stockResult.outcome === 'falha'
                ? 'red'
                : 'dimmed'
          }
          data-testid={`ml-envio-estoque-${linkDocId}`}
        >
          {stockResult.mensagem}
        </Text>
      )}
      {/* The read-only publication facts come BEFORE the editable form: they are
          what the operator opens the tab to check (is it live? at what price?
          what did ML reject?), and they were previously buried under a long
          form. */}
      <ListingDetails link={link} produtoFotoCount={produtoFotoCount} />
      <ListingForm
        produtoId={produtoId}
        linkDocId={linkDocId}
        integracaoId={integracaoId}
        produtoNome={produtoNome}
        produtoEhUsado={produtoEhUsado}
        produtoCondicao={produtoCondicao}
        link={link}
        db={db}
        canWrite={canWrite}
        disabled={disabled}
        serverErrors={serverErrors}
        onDirtyChange={onDirtyChange}
        onLoadingChange={onLoadingChange}
        registerFlush={registerFlush}
      />
    </Stack>
  );
}
