'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import type { StockPushIntegracao, StockPushRow } from '@/lib/marketplace/estoque/types';
import { DEFAULT_LISTING_TYPE, LISTING_TYPE_OPTIONS } from '@/lib/mercado-livre/listingFields';
import { mergeServerErrors, splitCausas } from '@/lib/mercado-livre/listingCausas';
import { isStockLatched } from '@/lib/mercado-livre/listingLinks';
import { moderacoesPorCampo } from '@/lib/mercado-livre/listingModeracoes';
import { mapPublishIssues } from '@/lib/mercado-livre/publishIssues';
import { publishDisabledReason } from '@/lib/mercado-livre/publishDisabled';
import { AnuncioBlock } from './AnuncioBlock';
import type { ListingSaveFn } from './ListingForm';

/**
 * One row of the `integracao` snapshot, narrowed to what this panel reads.
 *
 * Deliberately the stock push's own account shape rather than a local
 * re-declaration: `tipo` is the schema's narrow union, and widening it to
 * `number` here would only push the cast down into `onEnviarEstoque`.
 */
export type ContaResumo = StockPushIntegracao;

/** A `produtoMercadoLivre` doc with its Firestore id. */
export interface LinkDoc {
  id: string;
  data: ProdutoMercadoLivreLink;
}

/**
 * ONE Mercado Livre account's anúncios on this produto, plus the account-level
 * actions.
 *
 * Purely presentational, deliberately: every piece of state stays in
 * `MercadoLivreEditor`. Some of it must — `dirtyIds`, `loadingIds` and the flush
 * registry feed the produto page's save and its leave-guard, and the in-flight
 * locks (`publishing`, `savingConta`, `sendingStock`, `preparing`, `rechecking`)
 * are single-flight across every account, not just this one. The rest could move
 * down but does not, so this component stays a function of its props and the
 * editor's test can keep driving the whole tab from one render.
 */
export interface ContaPanelProps {
  produtoId: string;
  db: Firestore;
  conta: ContaResumo;
  /** This account's link docs, in snapshot order. */
  contaLinks: readonly LinkDoc[];
  produtoNome: string;
  produtoEhUsado: boolean;
  produtoCondicao: number | null;
  produtoFotoCount: number | null;
  /** The surrounding produto form holds unsaved edits. */
  produtoDirty: boolean;
  /** Data every account's decision depends on is still arriving. */
  carregandoGeral: boolean;
  canPublish: boolean;
  hasClient: boolean;
  disabled?: boolean;
  dirtyIds: ReadonlySet<string>;
  loadingIds: ReadonlySet<string>;
  /** Our own 422 pre-flight refusals for this account's last publish. */
  issues: readonly string[];
  stockResultByLink: Record<string, StockPushRow>;
  urlPorLink: Record<string, string>;
  /** The link doc whose re-check is in flight, across every account. */
  rechecking: string | null;
  abrindoAnuncio: string | null;
  publishing: { contaId: string; withPrices: boolean } | null;
  savingConta: string | null;
  sendingStock: string | null;
  preparing: string | null;
  listingTypeId: string;
  onListingTypeChange: (listingTypeId: string) => void;
  onPublish: (integracaoId: string, needsListingType: boolean, withPrices?: boolean) => void;
  onPreparar: (integracaoId: string) => void;
  onSalvarAnuncios: (contaId: string, linkIds: readonly string[]) => void;
  onEnviarEstoque: (conta: StockPushIntegracao, temLatch: boolean) => void;
  onReverificar: (integracaoId: string, linkDocId: string) => void;
  onAbrirAnuncio: (integracaoId: string, linkDocId: string) => void;
  onDirtyChange: (linkDocId: string, dirty: boolean) => void;
  onLoadingChange: (linkDocId: string, loading: boolean) => void;
  registerFlush: (linkDocId: string, save: ListingSaveFn | null) => void;
}

export function ContaPanel({
  produtoId,
  db,
  conta,
  contaLinks,
  produtoNome,
  produtoEhUsado,
  produtoCondicao,
  produtoFotoCount,
  produtoDirty,
  carregandoGeral,
  canPublish,
  hasClient,
  disabled,
  dirtyIds,
  loadingIds,
  issues,
  stockResultByLink,
  urlPorLink,
  rechecking,
  abrindoAnuncio,
  publishing,
  savingConta,
  sendingStock,
  preparing,
  listingTypeId,
  onListingTypeChange,
  onPublish,
  onPreparar,
  onSalvarAnuncios,
  onEnviarEstoque,
  onReverificar,
  onAbrirAnuncio,
  onDirtyChange,
  onLoadingChange,
  registerFlush,
}: ContaPanelProps) {
  // Publishing still targets the CONTA, not one listing — it reads the same
  // primary link it always did.
  const primary: ProdutoMercadoLivreLink | null = contaLinks[0]?.data ?? null;
  const isFirstPublish = primary?.id == null;
  // Only when there is no link doc AT ALL. Once one exists — even an
  // unpublished draft — its `listing_type_id` is a field of the listing form,
  // and offering a second "Tipo de anúncio" control in the same card would give
  // the operator two inputs for one value (and hand the e2e locator two elements
  // to choose between).
  const needsListingType = contaLinks.length === 0;
  // ⚠️ At least one PUBLISHED listing, not merely a link doc. A draft from
  // "Preparar anúncio" has `id == null`, and the stock push has nothing to send
  // for it — the backend answers `sem-id-externo` / "O anúncio ainda não foi
  // publicado no Mercado Livre". Offering the button there is a guaranteed no-op
  // dressed as an action. `some`, not `every`, so a conta holding one published
  // listing and one draft keeps the button.
  //
  // ⚠️ Empty string counts as NOT published, matching the backend exactly:
  // `bulkEstoquePlan` takes `link.id !== ''` as its test and answers
  // `sem-item-id` otherwise. The schema permits `''` — `id:
  // z.string().nullable().default(null)` carries no `.min(1)`, and the migrated
  // corpus contains links stored that way, so a `!= null` check leaves the same
  // dead button one value narrower.
  const hasPublished = contaLinks.some((l) => (l.data.id ?? '') !== '');
  // Our OWN pre-flight refusals (422), mapped onto controls by the module
  // written for it. Every issue still renders verbatim in the alert below — a
  // mapping miss loses nothing, it just highlights nothing (`publishIssues.ts`
  // docblock).
  const blockedTargets = mapPublishIssues([...issues]);
  const blockedPorCampo: Record<string, string[]> = {};
  for (const target of blockedTargets) {
    if (target.scope !== 'listing' || target.field == null) continue;
    (blockedPorCampo[target.field] ??= []).push(target.message);
  }
  const dirtyLinkIds = contaLinks.filter((l) => dirtyIds.has(l.id)).map((l) => l.id);
  const contaDirty = dirtyLinkIds.length > 0;
  // Filtered THROUGH the rendered links, like `contaDirty` above: a stale id
  // left by a link doc that has since disappeared is then never consulted, so it
  // cannot wedge the gate shut.
  const contaLoading = carregandoGeral || contaLinks.some((l) => loadingIds.has(l.id));
  const publishBlocked = produtoDirty || contaDirty;
  // Publish refuses a create with no category ("categoria do Mercado Livre não
  // definida"). Saying so here beats a round trip that comes back as a 422 the
  // operator has to read.
  const missingCategoria = primary != null && (primary.category_id ?? '') === '';
  // One place decides both whether Publicar is disabled and what the tooltip
  // says, so the two can never disagree — the previous shape had the conditions
  // inline and the explanations in three separate `<Text>` blocks that covered
  // only half of them.
  const publishReason = publishDisabledReason({
    loading: contaLoading,
    disabled: Boolean(disabled),
    canPublish,
    hasClient,
    publishingThisConta: publishing?.contaId === conta.id,
    publishingOtherConta: publishing != null && publishing.contaId !== conta.id,
    produtoDirty,
    contaDirty,
    missingCategoria,
  });

  return (
    <Card withBorder padding="md" data-testid={`ml-conta-${conta.id}`}>
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>{conta.nome}</Text>
          {contaLinks.length === 0 && (
            <Badge color="gray" variant="light">
              Não publicado
            </Badge>
          )}
        </Group>

        {contaLinks.map((l, index) => (
          <AnuncioBlock
            key={l.id}
            produtoId={produtoId}
            linkDocId={l.id}
            integracaoId={conta.id}
            link={l.data}
            db={db}
            produtoNome={produtoNome}
            produtoEhUsado={produtoEhUsado}
            produtoCondicao={produtoCondicao}
            produtoFotoCount={produtoFotoCount}
            canWrite={canPublish}
            hasClient={hasClient}
            disabled={disabled}
            loading={contaLoading}
            showDivider={index > 0}
            // THREE sources, one control vocabulary: Mercado Livre's own
            // rejection of a write of ours — read live off THIS link doc, so it
            // is already per-listing and survives a reload — ML's POLICY
            // moderation on the listing itself (#1087), from the same doc, and
            // our pre-flight refusal, which is per conta (a produto carries one
            // listing per account in practice, and those issues are about the
            // produto or the account either way).
            //
            // ⚠️ The moderation map is purely ADDITIVE: every moderação is also
            // listed in the strip, whether or not its section resolved to a
            // control here — `pictures` and `item` resolve to none at all. See
            // the ⚠️ in `listingCausas.ts` for what it cost the last time a
            // banner depended on this mapping.
            serverErrors={mergeServerErrors(
              splitCausas(l.data).porCampo,
              moderacoesPorCampo(l.data),
              blockedPorCampo,
            )}
            stockResult={stockResultByLink[l.id]}
            urlResolvida={urlPorLink[l.id] ?? null}
            rechecking={rechecking === l.id}
            recheckBusy={rechecking !== null}
            abrindo={abrindoAnuncio === l.id}
            onReverificar={() => onReverificar(conta.id, l.id)}
            // Reading a public URL is a read: gated on having a client at all,
            // never on the publish permission.
            onAbrirAnuncio={hasClient ? () => onAbrirAnuncio(conta.id, l.id) : undefined}
            onDirtyChange={onDirtyChange}
            onLoadingChange={onLoadingChange}
            registerFlush={registerFlush}
          />
        ))}

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
          {contaDirty && (
            // Beside Publicar on purpose: saving the anúncio and publishing it
            // are the two halves of one decision, and this button previously sat
            // at the far end of a long form where it read as unrelated to the
            // action group.
            //
            // ⚠️ Gated on `contaDirty` (derived from `dirtyIds`), NOT on the
            // form's RHF `isDirty` as the old button was. `dirtyIds` is fed by
            // `onDirtyChange(id, isDirty || attrDirty)`, so an ATTRIBUTE-only
            // edit now enables it — previously that edit left the only save
            // button greyed out and reachable solely through the produto's own
            // "Salvar alterações".
            <Button
              type="button"
              variant="light"
              onClick={() => onSalvarAnuncios(conta.id, dirtyLinkIds)}
              loading={savingConta === conta.id}
              disabled={disabled || !canPublish || savingConta !== null || contaLoading}
            >
              {/* Plural counts the listings it will actually SAVE, not the
                  listings in the card — "Salvar anúncios" beside a card holding
                  two listings of which one is dirty would promise more than the
                  click does. */}
              {dirtyLinkIds.length > 1 ? 'Salvar anúncios' : 'Salvar anúncio'}
            </Button>
          )}
          {hasPublished && (
            // Deliberately NOT disabled while a listing is latched: the push is
            // precisely the operation whose skip row explains WHY it is latched,
            // and after a re-arm it is how the operator verifies. The legacy
            // action sent regardless and let the per-listing gate answer.
            //
            // Nor is it blocked by `publishBlocked`: the push sends the stock
            // Firestore already holds, never the pending form edits, so unsaved
            // listing fields cannot make it ship a stale value the way a publish
            // would.
            <Button
              type="button"
              variant="default"
              onClick={() =>
                onEnviarEstoque(
                  conta,
                  contaLinks.some((l) => isStockLatched(l.data)),
                )
              }
              loading={sendingStock === conta.id}
              disabled={
                disabled || !hasClient || !canPublish || sendingStock !== null || contaLoading
              }
            >
              Enviar estoque
            </Button>
          )}
          {needsListingType ? (
            <>
              <Select
                label="Tipo de anúncio"
                data={[...LISTING_TYPE_OPTIONS]}
                value={listingTypeId}
                onChange={(v) => onListingTypeChange(v ?? DEFAULT_LISTING_TYPE)}
                allowDeselect={false}
                disabled={disabled || !canPublish || contaLoading}
                w={160}
              />
              {/* Publishing straight from here is impossible, not merely
                  unlikely: with no link doc there is no `category_id`, and
                  publish raises that as a 422 BEFORE it writes any doc — so the
                  failure leaves nothing behind and the next attempt fails
                  identically. The draft is what breaks that cycle. */}
              <Button
                type="button"
                variant="filled"
                onClick={() => onPreparar(conta.id)}
                loading={preparing === conta.id}
                disabled={
                  disabled ||
                  !canPublish ||
                  preparing !== null ||
                  produtoNome === '' ||
                  contaLoading
                }
              >
                Preparar anúncio
              </Button>
            </>
          ) : (
            // ⚠️ The <span> is load-bearing: Mantine turns pointer events OFF on
            // a disabled button, so a Tooltip wrapping it directly never fires.
            // Wrapping an inline-block element instead is the idiom that works —
            // see `PermGate`.
            // ⚠️ A wrapper does not change the button's accessible name
            // (`Publicar no Mercado Livre` / `Republicar`), which the vendas e2e
            // locates by role+name. An `aria-label` here would silently break it.
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
                  onClick={() => onPublish(conta.id, false)}
                  loading={publishing?.contaId === conta.id && !publishing.withPrices}
                  disabled={publishReason != null}
                >
                  {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
                </Button>
              </span>
            </Tooltip>
          )}
          {/* The paired action (#798). A publish never carries prices, so without
              this the operator has no way to say "and the price too" from the
              produto screen. Shares `publishReason` — it is the same publish with
              one extra call, so every guard that blocks one blocks the other by
              definition.

              Absent while the conta has NO link doc at all (there is no
              category_id, so publish 422s before writing anything and there would
              be nothing to price). A rascunho — a link doc with `id == null` —
              DOES get it: pairing a first publish with a price push is
              legitimate. */}
          {!needsListingType && (
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
                  onClick={() => onPublish(conta.id, false, true)}
                  loading={publishing?.contaId === conta.id && publishing.withPrices}
                  disabled={publishReason != null}
                >
                  {isFirstPublish ? 'Publicar e atualizar preços' : 'Republicar e atualizar preços'}
                </Button>
              </span>
            </Tooltip>
          )}
          {publishBlocked && (
            <Text size="xs" c="dimmed">
              Salve as alterações pendentes antes de publicar.
            </Text>
          )}
          {missingCategoria && !publishBlocked && (
            <Text size="xs" c="dimmed">
              Escolha a categoria do Mercado Livre antes de publicar.
            </Text>
          )}
          {!canPublish && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
