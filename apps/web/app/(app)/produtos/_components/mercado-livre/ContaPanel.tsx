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
  /**
   * Our own 422 pre-flight refusals, keyed by the LISTING they came from.
   *
   * Per listing rather than per account since publishing became per listing: a
   * 422 describes one publish, and keying it by conta painted every sibling
   * listing's fields red for a rejection that was never about them.
   */
  issuesByLink: Record<string, string[]>;
  stockResultByLink: Record<string, StockPushRow>;
  urlPorLink: Record<string, string>;
  /** The link doc whose re-check is in flight, across every account. */
  rechecking: string | null;
  abrindoAnuncio: string | null;
  publishing: { contaId: string; linkDocId: string; withPrices: boolean } | null;
  savingConta: string | null;
  sendingStock: string | null;
  /** The conta whose draft creation is in flight, across every account. */
  criando: string | null;
  onPublish: (integracaoId: string, linkDocId: string, withPrices?: boolean) => void;
  onNovoAnuncio: (integracaoId: string) => void;
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
  issuesByLink,
  stockResultByLink,
  urlPorLink,
  rechecking,
  abrindoAnuncio,
  publishing,
  savingConta,
  sendingStock,
  criando,
  onPublish,
  onNovoAnuncio,
  onSalvarAnuncios,
  onEnviarEstoque,
  onReverificar,
  onAbrirAnuncio,
  onDirtyChange,
  onLoadingChange,
  registerFlush,
}: ContaPanelProps) {
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
  const dirtyLinkIds = contaLinks.filter((l) => dirtyIds.has(l.id)).map((l) => l.id);
  const contaDirty = dirtyLinkIds.length > 0;
  // Filtered THROUGH the rendered links, like `contaDirty` above: a stale id
  // left by a link doc that has since disappeared is then never consulted, so it
  // cannot wedge the gate shut.
  const contaLoading = carregandoGeral || contaLinks.some((l) => loadingIds.has(l.id));

  return (
    <Card withBorder padding="md" data-testid={`ml-conta-${conta.id}`}>
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{conta.nome}</Text>
            {contaLinks.length === 0 && (
              <Badge color="gray" variant="light">
                Não publicado
              </Badge>
            )}
          </Group>
          {/* Always offered, not only for an account with nothing — a produto
              may carry several anúncios on one account, which is the whole point
              of this screen. The listing type is chosen inside the modal; see
              its docblock for why it cannot stay inline. */}
          <Button
            type="button"
            variant={contaLinks.length === 0 ? 'filled' : 'light'}
            size="xs"
            data-testid={`ml-novo-anuncio-${conta.id}`}
            onClick={() => onNovoAnuncio(conta.id)}
            loading={criando === conta.id}
            disabled={
              disabled ||
              !canPublish ||
              criando !== null ||
              // The draft's `title` is seeded from the produto's nome, and the
              // stored schema requires a non-empty one — so a draft built before
              // the produto snapshot lands would fail its own write-side parse.
              produtoNome === '' ||
              contaLoading
            }
          >
            Novo anúncio
          </Button>
        </Group>

        {contaLinks.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum anúncio desta conta para este produto.
          </Text>
        )}

        {contaLinks.map((l, index) => {
          const issues = issuesByLink[l.id] ?? [];
          // Our OWN pre-flight refusals (422), mapped onto controls by the
          // module written for it. Every issue still renders verbatim in the
          // alert beside the form — a mapping miss loses nothing, it just
          // highlights nothing (`publishIssues.ts` docblock).
          const blockedPorCampo: Record<string, string[]> = {};
          for (const target of mapPublishIssues(issues)) {
            if (target.scope !== 'listing' || target.field == null) continue;
            (blockedPorCampo[target.field] ??= []).push(target.message);
          }
          const anuncioDirty = dirtyIds.has(l.id);
          // Publish refuses a create with no category ("categoria do Mercado
          // Livre não definida"). Saying so here beats a round trip that comes
          // back as a 422 the operator has to read.
          const missingCategoria = (l.data.category_id ?? '') === '';
          // One place decides both whether Publicar is disabled and what the
          // tooltip says, so the two can never disagree.
          //
          // ⚠️ `anuncioDirty`, not `contaDirty`: a publish reads THIS listing's
          // own doc, so a sibling's unsaved edits are irrelevant to it. The
          // message already said "Salve as alterações do anúncio" — it was
          // per-listing wording behind a per-account gate.
          const publishReason = publishDisabledReason({
            loading: contaLoading,
            disabled: Boolean(disabled),
            canPublish,
            hasClient,
            publishingThisConta: publishing?.linkDocId === l.id,
            publishingOtherConta: publishing != null && publishing.linkDocId !== l.id,
            produtoDirty,
            contaDirty: anuncioDirty,
            missingCategoria,
          });
          return (
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
              // THREE sources, one control vocabulary, and all three are now
              // per listing: Mercado Livre's own rejection of a write of ours —
              // read live off THIS link doc, so it survives a reload — ML's POLICY
              // moderation on the listing itself (#1087), from the same doc, and
              // our own pre-flight refusal, keyed by the listing it was raised
              // for.
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
              issues={issues}
              publishReason={publishReason}
              publishing={publishing?.linkDocId === l.id ? publishing.withPrices : null}
              onPublish={(withPrices) => onPublish(conta.id, l.id, withPrices)}
            />
          );
        })}

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
