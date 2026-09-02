'use client';

import { Alert, Button, Divider, Group, List, Stack, Text, Tooltip } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  type AcaoStatusAnuncio,
  ACAO_STATUS_ANUNCIO,
  type MedidasDoPacote,
  type ProdutoMercadoLivreLink,
  acaoStatusAnuncio,
} from '@delfrance/schemas';

import type { StockPushRow } from '@/lib/marketplace/estoque/types';
import { ListingDetails } from './ListingDetails';
import { TabelaMedidasResumo } from './TabelaMedidasResumo';
import { ListingForm } from './ListingForm';
import type { ListingSaveFn } from './ListingForm';
import { ListingStatusStrip, type MotivoReverificacao } from './ListingStatusStrip';
import { VariacoesAnuncioTable } from './VariacoesAnuncioTable';

/**
 * ONE Mercado Livre anúncio: its live status, the last stock-push outcome, the
 * read-only publication facts, and the editable listing form.
 *
 * Purely presentational — every piece of state and every handler belongs to
 * `MercadoLivreEditor`, which owns them because they are either cross-account
 * (the dirty/loading sets and the flush registry feed the produto page's save
 * and leave-guard) or single-flight locks that a second, off-screen listing must
 * not be able to fire in parallel.
 *
 * ⚠️ ONE documented exception: {@link VariacoesAnuncioTable} owns its own
 * subscription. Neither reason above reaches it — a read-only per-listing query
 * is not cross-account and is not a lock — and the editor could not hold it
 * anyway: it renders N listings, so subscribing per listing up there would mean
 * N hooks for a variable N. See that component's docblock.
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
  produtoMedidas: MedidasDoPacote | null;
  /** `extraData.marca` — same tier as `produtoCondicao`; null while it loads. */
  produtoMarca: string | null;
  /**
   * The produto's tabela de medidas — `null` when it names none, or while the
   * doc loads. Drives {@link TabelaMedidasResumo}, which is the only place on
   * this tab that says whether the tabela can bind here at all (#1087).
   */
  tabelaMedidas: { nome: string; chartsMap: Record<string, unknown> | null } | null;
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
  /** Re-read this listing from ML; the reason travels up to pick the toast. */
  onReverificar: (motivo: MotivoReverificacao) => void;
  /** Undefined with no client: reading a public URL still needs one. */
  onAbrirAnuncio?: () => void;
  onDirtyChange: (linkDocId: string, dirty: boolean) => void;
  onLoadingChange: (linkDocId: string, loading: boolean) => void;
  registerFlush: (linkDocId: string, save: ListingSaveFn | null) => void;
  /** Our own 422 pre-flight refusals for THIS listing's last publish. */
  issues: readonly string[];
  /** Why Publicar is disabled, in words — `null` when it is enabled. */
  publishReason: string | null;
  /**
   * A publish is in flight for THIS listing: `true` when it carries prices,
   * `false` when it does not, `null` when nothing is running here. Three states
   * because the two publish actions share one handler, and a plain boolean would
   * spin both buttons and leave the operator unable to tell which one is going.
   */
  publishing: boolean | null;
  onPublish: (withPrices: boolean) => void;
  /**
   * Ask to remove this listing. Undefined hides the control — the operator lacks
   * `PERM.produto.delete`, which is the bit Firestore rules require for a link
   * doc (the subcollection inherits the produto's permissions).
   */
  onExcluir?: () => void;
  excluindo: boolean;
  /**
   * Pause or reactivate this listing on Mercado Livre. Undefined hides the
   * control — no client, or the operator lacks `PERM.integracao.write`, the bit
   * the backend route enforces.
   *
   * ⚠️ WHICH action is offered is not this component's decision: it comes from
   * `acaoStatusAnuncio`, the same predicate the backend refuses by. A local rule
   * here would be the drift that offers a button the server rejects.
   */
  onDefinirStatus?: (acao: AcaoStatusAnuncio) => void;
  /** This listing's status change is in flight. */
  alterandoStatus: boolean;
  /** ANY listing's status change is in flight — the action is single-flight. */
  statusBusy: boolean;
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
  produtoMedidas,
  produtoMarca,
  tabelaMedidas,
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
  issues,
  publishReason,
  publishing,
  onPublish,
  onExcluir,
  excluindo,
  onDefinirStatus,
  alterandoStatus,
  statusBusy,
}: AnuncioBlockProps) {
  // A listing ML has never accepted. `''` counts as never published, matching
  // the backend's own `link.id !== ''` test: the schema permits it and the
  // migrated corpus contains it.
  const isFirstPublish = (link.id ?? '') === '';
  // ⚠️ Read from the LINK, so the control repaints from the live snapshot the
  // backend just wrote — the same feedback model "Reverificar" relies on.
  const acaoDeStatus = acaoStatusAnuncio(link as unknown as Record<string, unknown>);
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
      {/* Directly under the strip it explains: the family status above is a FOLD
          over these, so an operator who sees "pausado" can find WHICH variation
          ML paused without leaving the tab (#1142). Renders nothing for a legacy
          listing or one with no member links. */}
      <VariacoesAnuncioTable
        produtoId={produtoId}
        linkDocId={linkDocId}
        db={db}
        isUserProducts={link.isUserProductModel === true}
        linkStatus={link.status ?? null}
        linkSubStatus={link.sub_status ?? null}
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
      {/* Beside the read-only facts and ABOVE the form: it explains a publish
          that has not happened yet, so it belongs with what the operator
          checks rather than with what they edit. */}
      {tabelaMedidas != null && (
        <TabelaMedidasResumo
          integracaoId={integracaoId}
          categoryId={link.category_id ?? null}
          nomeDaTabela={tabelaMedidas.nome}
          chartsMap={tabelaMedidas.chartsMap}
          linkAttributes={link.attributes ?? []}
        />
      )}
      <ListingForm
        produtoId={produtoId}
        linkDocId={linkDocId}
        integracaoId={integracaoId}
        produtoNome={produtoNome}
        produtoEhUsado={produtoEhUsado}
        produtoCondicao={produtoCondicao}
        produtoMedidas={produtoMedidas}
        produtoMarca={produtoMarca}
        link={link}
        db={db}
        canWrite={canWrite}
        disabled={disabled}
        serverErrors={serverErrors}
        onDirtyChange={onDirtyChange}
        onLoadingChange={onLoadingChange}
        registerFlush={registerFlush}
      />
      {issues.length > 0 && (
        <Alert color="red" variant="light" title="Publicação bloqueada">
          <List size="sm">
            {issues.map((issue) => (
              <List.Item key={issue}>{issue}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Group align="flex-end" gap="sm">
        {/* ⚠️ The <span> is load-bearing: Mantine turns pointer events OFF on a
            disabled button, so a Tooltip wrapping it directly never fires.
            Wrapping an inline-block element instead is the idiom that works —
            see `PermGate`.
            ⚠️ A wrapper does not change the button's accessible name (`Publicar
            no Mercado Livre` / `Republicar`), which the vendas e2e locates by
            role+name. An `aria-label` here would silently break it. */}
        <Tooltip
          label={publishReason}
          disabled={publishReason == null}
          withArrow
          position="bottom"
          multiline
          w={260}
        >
          <span style={{ display: 'inline-block' }}>
            <Button
              type="button"
              variant={isFirstPublish ? 'filled' : 'light'}
              onClick={() => onPublish(false)}
              loading={publishing === false}
              disabled={publishReason != null}
            >
              {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
            </Button>
          </span>
        </Tooltip>
        {/* The paired action (#798). A publish never carries prices, so without
            this the operator has no way to say "and the price too" from the
            produto screen. Shares `publishReason` — it is the same publish with
            one extra call, so every guard that blocks one blocks the other by
            definition.

            ⚠️ The price half is still account-scoped: `enviarPrecos` takes
            `{integracaoId, produtoIds}` and the plan resolves one price per
            (produto, conta), so every listing of this account on this produto
            lands on the same value. Scoping it per listing would be a
            difference with no effect. */}
        <Tooltip
          label={publishReason}
          disabled={publishReason == null}
          withArrow
          position="bottom"
          multiline
          w={260}
        >
          <span style={{ display: 'inline-block' }}>
            <Button
              type="button"
              variant="light"
              onClick={() => onPublish(true)}
              loading={publishing === true}
              disabled={publishReason != null}
            >
              {isFirstPublish ? 'Publicar e atualizar preços' : 'Republicar e atualizar preços'}
            </Button>
          </span>
        </Tooltip>
        {/* Pause / reactivate — the only lifecycle control this app has over a
            LIVE listing. `acaoStatusAnuncio` decides which one is offered (and
            whether any is), and it is the SAME predicate the backend route
            refuses by, so the button can never promise what the server declines.

            ⚠️ It is deliberately NOT rendered for a cancelled listing: `closed`
            is terminal on ML, so both directions would only earn a 400. */}
        {onDefinirStatus && acaoDeStatus != null && (
          <Button
            type="button"
            variant="default"
            onClick={() => onDefinirStatus(acaoDeStatus)}
            loading={alterandoStatus}
            disabled={Boolean(disabled) || loading || (statusBusy && !alterandoStatus)}
          >
            {acaoDeStatus === ACAO_STATUS_ANUNCIO.pausar ? 'Pausar anúncio' : 'Reativar anúncio'}
          </Button>
        )}
        {/* Only for a listing Mercado Livre has never seen. Removing a PUBLISHED
            one would orphan a live anúncio: `itemsStatusSync` would stop
            resolving it, both sweeps would stop reaching it, and its child
            `variacaoMercadoLivre` docs would dangle. Deleting a produto in the
            ERP deliberately leaves the marketplace untouched (#476, closed by
            decision) — the operator's way to take a live listing off the air is
            "Pausar anúncio" above, never a delete. */}
        {isFirstPublish && onExcluir && (
          <Button
            type="button"
            variant="subtle"
            color="red"
            onClick={onExcluir}
            loading={excluindo}
            disabled={Boolean(disabled) || loading}
          >
            Excluir anúncio
          </Button>
        )}
        {publishReason != null && (
          // Repeated below the buttons, not only in the tooltip: the vendas e2e
          // asserts the categoria one as visible page text, and a tooltip is not
          // reachable without a hover.
          <Text size="xs" c="dimmed">
            {publishReason}
          </Text>
        )}
      </Group>
    </Stack>
  );
}
