'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import {
  ActionIcon,
  Alert,
  Button,
  Fieldset,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronUp, IconSparkles } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { AfterSaveBlockedError } from '@delfrance/ui';
import {
  resolveCondicaoAnuncio,
  type FonteCondicaoAnuncio,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';

import {
  applySuggestions,
  attributesForSave,
  seedRows,
  validateAttr,
  type AttrRow,
} from '@/lib/mercado-livre/attributeForm';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
  type MercadoLivreAtributoSugestao,
  type MercadoLivreAtributosSugestao,
} from '@/lib/mercado-livre/client';

import {
  LISTING_TYPE_OPTIONS,
  listingTypeLabel,
  titleEditability,
  TITLE_MAX_LENGTH,
} from '@/lib/mercado-livre/listingFields';
import {
  listingFormSchema,
  toFormValues,
  toPatchValues,
  type ListingFormInput,
  type ListingFormValues,
} from '@/lib/mercado-livre/listingForm';
import { createClientListingPort } from '@/lib/mercado-livre/listingPort';
import type { ListingSaveOutcome } from '@/lib/mercado-livre/listingSaveOutcome';
import {
  ListingConflictError,
  ListingMissingError,
  ListingNothingChangedError,
  saveListing,
} from '@/lib/mercado-livre/saveListing';
import type { OperatorOwnedKey } from '@/lib/mercado-livre/listingPatch';
import { AtributosAiModal } from './AtributosAiModal';
import { AtributosSection } from './AtributosSection';
import { CategoriaField } from './CategoriaField';
import { ListingConflictModal } from './ListingConflictModal';
import { ListingField, textOr } from './ListingField';

/** ML metadata barely moves; a half-hour is generous and still bounded. */
const METADATA_STALE_MS = 30 * 60 * 1000;

export interface ListingFormProps {
  produtoId: string;
  /** Firestore id of the `produtoMercadoLivre` doc being edited. */
  linkDocId: string;
  /** The ML account this listing belongs to — needed for every metadata call. */
  integracaoId: string;
  /** Seeds the category suggestion request. */
  produtoNome: string;
  /**
   * The parent produto's `ehUsado`, which is what decides the listing's
   * condition — read from the SAVED produto doc, matching publish, which sends
   * the saved produto and not the pending form values.
   */
  produtoEhUsado: boolean;
  /** `extraData.condicao` — the second input publish resolves from. */
  produtoCondicao: number | null;
  link: ProdutoMercadoLivreLink;
  db: Firestore;
  canWrite: boolean;
  disabled?: boolean;
  /** Reported on every change so the page's leave-guard can see ML edits. */
  onDirtyChange: (linkDocId: string, dirty: boolean) => void;
  /**
   * Hands the editor a closure that saves this listing, so **both** callers can
   * drive it: the produto's own "Salvar alterações" (`'flush'`) and the
   * "Salvar anúncio" button the editor now renders next to Publicar
   * (`'button'`). `null` on unmount.
   *
   * ⚠️ The mode is not cosmetic — it decides how a failure is reported. `'flush'`
   * throws `AfterSaveBlockedError`, which `ObjectView` turns into a form alert and
   * which stops it navigating away from the conflict modal; `'button'` shows a
   * notification and swallows, because there is no outer save to block.
   */
  registerFlush: (linkDocId: string, save: ListingSaveFn | null) => void;
}

/**
 * How a registered listing save is invoked — see `registerFlush`.
 *
 * The outcome is what lets the conta-level caller aggregate; see
 * `ListingSaveOutcome`, which carries the reasoning.
 */
export type ListingSaveFn = (mode: 'button' | 'flush') => Promise<ListingSaveOutcome>;

/** Where the shown condition came from — the caption names it. */
const FONTE_CONDICAO_LABEL: Record<FonteCondicaoAnuncio, string> = {
  produto: 'Definido pelo campo "Produto usado" na aba Configurações do produto.',
  extraData: 'Definido pelo campo "Condição" na aba Dados extras do produto.',
  anuncio: 'Definido pelo campo "Produto usado" na aba Configurações do produto.',
};

/**
 * Condição, read-only, derived exactly the way publish derives it.
 *
 * It stopped being editable here because it was a second place to say something
 * the produto already says, and the two could disagree — the produto is the
 * product, and whether a product is used is a fact about the product, not about
 * one of its listings.
 *
 * ⚠️ It must run `resolveCondicaoAnuncio`, not mirror one input. Showing only
 * `ehUsado` reproduced the very defect this replaced a Select to remove: a
 * produto with `ehUsado: false` and **Recondicionado** in Dados extras rendered
 * "Novo" here while the first publish sent `used`. Same two-copies-that-disagree
 * problem, moved from link↔produto to display↔payload — and harder to notice,
 * because one side is a screen and the other a wire value. The caption names
 * whichever field actually decided, so the operator knows where to go.
 *
 * ⚠️ The note on a published listing is the other load-bearing part. ML accepts
 * `condition` **only on create** (`itemPayload.ts`, inside `if (!input.isUpdate)`),
 * so flipping "Produto usado" on a listing that already exists changes what the
 * ERP would publish NEXT time and nothing at Mercado Livre. Without saying so,
 * the operator flips the switch, sees this field change, and reasonably believes
 * it propagated.
 */
function CondicaoField({
  ehUsado,
  condicao,
  condicaoAnuncio,
  published,
}: {
  ehUsado: boolean;
  condicao: number | null;
  condicaoAnuncio: 'new' | 'used' | null;
  published: boolean;
}) {
  const { condition, fonte } = resolveCondicaoAnuncio({ ehUsado, condicao, condicaoAnuncio });
  return (
    <ListingField label="Condição">
      <Stack gap={2}>
        <Text size="sm">{condition === 'used' ? 'Usado' : 'Novo'}</Text>
        <Text size="xs" c="dimmed">
          {published
            ? 'Definido pelo produto. O Mercado Livre fixa a condição na criação do anúncio — alterá-la agora não altera este anúncio.'
            : FONTE_CONDICAO_LABEL[fonte]}
        </Text>
      </Stack>
    </ListingField>
  );
}

/**
 * The editable half of a listing.
 *
 * Everything here is an **operator-owned** key (`OPERATOR_OWNED_KEYS`); the
 * server-owned fields stay read-only in `ListingDetails`. That split is not
 * cosmetic — it is tier 0 of the lost-update ladder. A patch that only ever
 * carries these keys cannot collide with the webhook advancing `estado` or the
 * price sync refreshing `precoPublicado`, which is what makes an editor on a
 * document six writers touch safe at all.
 *
 * Two rules this component must not break, both from the surrounding
 * `ObjectView`:
 *
 *  - **never render a `<form>` element.** ObjectView already renders one and
 *    this subtree lives inside it; a nested form is invalid HTML and the inner
 *    submit would bubble into the produto save.
 *  - **never call `useUnsavedChangesGuard`.** ObjectView owns the only guard.
 *    Dirtiness is reported upward through `onDirtyChange` and reaches the guard
 *    as ObjectView's `extraDirty` prop instead.
 */
export function ListingForm({
  produtoId,
  linkDocId,
  integracaoId,
  produtoNome,
  produtoEhUsado,
  produtoCondicao,
  link,
  db,
  canWrite,
  disabled,
  onDirtyChange,
  registerFlush,
}: ListingFormProps) {
  const client = useMercadoLivreClient();
  const form = useForm<ListingFormInput, unknown, ListingFormValues>({
    resolver: zodResolver(listingFormSchema),
    defaultValues: toFormValues(link),
    mode: 'onBlur',
  });
  const isDirty = form.formState.isDirty;

  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{
    fields: OperatorOwnedKey[];
    baseline: ProdutoMercadoLivreLink;
    current: ProdutoMercadoLivreLink;
  } | null>(null);

  // The doc the form was seeded from — the concurrency baseline, deliberately
  // NOT the live snapshot. `saveListing` compares this against a fresh read
  // inside the transaction.
  const baselineRef = useRef<ProdutoMercadoLivreLink>(link);

  const titleRule = useMemo(() => titleEditability(link), [link]);
  const isPublished = link.id != null;

  // Computed ONCE, from the seed. Deriving it on every render would collapse the
  // field the instant the operator cleared the text they were editing.
  const [descricaoOpen, setDescricaoOpen] = useState(() => (link.descricao ?? '').trim() !== '');

  /**
   * Fill the form with the data ML requires a **test listing** to carry.
   *
   * Pre-fill only — nothing is saved and nothing is published. `shouldDirty`
   * marks the form so "Salvar anúncio" lights up and the operator commits
   * deliberately, exactly as for a hand-typed edit.
   */
  const aplicarDadosTeste = useCallback(
    (dados: {
      title: string;
      descricao: string;
      categoryId: string | null;
      listingTypeId: string | null;
    }) => {
      const opts = { shouldDirty: true, shouldValidate: true } as const;
      form.setValue('title', dados.title, opts);
      form.setValue('descricao', dados.descricao, opts);
      // ⚠️ Only when resolved. Writing '' would clear a category the operator had
      // already chosen and re-block Publicar, and writing a guessed id would file
      // a test listing into a real category.
      if (dados.categoryId != null) form.setValue('category_id', dados.categoryId, opts);
      if (dados.listingTypeId != null) {
        form.setValue('listing_type_id', dados.listingTypeId, opts);
      }
      setDescricaoOpen(true);
    },
    [form],
  );

  const [carregandoTeste, setCarregandoTeste] = useState(false);
  const [testeConta, setTesteConta] = useState<{
    nickname: string | null;
    ehContaDeTeste: boolean;
    categoriaResolvida: boolean;
    categoriaPath: string[] | null;
    tipoResolvido: boolean;
  } | null>(null);

  const preencherTeste = useCallback(async () => {
    if (!client) return;
    // ⚠️ Clear FIRST, so the alert is strictly a report of the latest run. The
    // catch below reports its failure as a toast and returns without touching
    // this state, so without the reset a successful fill followed by a failing
    // one left "Dados de teste preenchidos" — naming a `Categoria definida` that
    // was never applied — sitting above a fill that did not happen. A close
    // button does not fix that: it asks the operator to notice and tidy up.
    setTesteConta(null);
    setCarregandoTeste(true);
    try {
      const dados = await client.anuncioTeste(integracaoId);
      aplicarDadosTeste(dados);
      setTesteConta({
        nickname: dados.conta.nickname,
        ehContaDeTeste: dados.conta.ehContaDeTeste,
        categoriaResolvida: dados.categoryId != null,
        categoriaPath: dados.categoriaPath ?? null,
        tipoResolvido: dados.listingTypeId != null,
      });
    } catch (err) {
      // The client narrows to its own two classes; anything else is a bug and
      // must not be reported as "could not reach Mercado Livre".
      if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        notifications.show({ color: 'red', title: 'Dados de teste', message: err.message });
        return;
      }
      throw err;
    } finally {
      setCarregandoTeste(false);
    }
  }, [client, integracaoId, aplicarDadosTeste]);

  /**
   * ⚠️ The warning is the point of this feature, not decoration.
   *
   * Mercado Livre has **no sandbox** — «O Mercado Livre não tem um ambiente para
   * teste ou sandbox» — so publishing this fills a real listing on the real
   * marketplace. And ML's rule is that it must not be a real seller account:
   * «contas pessoais ou de familiares não devem ser, em hipótese alguma,
   * utilizadas para testes». The compliant path is a test user connected as a
   * second conta, which this ERP already supports, so the warning names it.
   */
  const avisoTeste =
    testeConta == null ? null : (
      <Alert
        color={testeConta.ehContaDeTeste ? 'blue' : 'yellow'}
        variant="light"
        mb="xs"
        // Without this it never goes away: `setTesteConta` is only ever called
        // on a successful fill and never reset, so the alert outlived even a
        // later FAILED click — which reports itself as a toast and leaves a
        // stale success banner sitting above the form.
        withCloseButton
        closeButtonLabel="Fechar aviso"
        onClose={() => setTesteConta(null)}
        title={
          testeConta.ehContaDeTeste
            ? 'Dados de teste preenchidos'
            : 'Esta não é uma conta de teste do Mercado Livre'
        }
      >
        <Stack gap={4}>
          {!testeConta.ehContaDeTeste && (
            <Text size="sm">
              O Mercado Livre não tem ambiente de testes: publicar aqui cria um anúncio real em{' '}
              <strong>{testeConta.nickname ?? 'nesta conta'}</strong>. A documentação pede que
              anúncios de teste fiquem em um usuário de teste — crie um e conecte-o como uma segunda
              conta em Canais &gt; Mercado Livre.
            </Text>
          )}
          {/* Name the category that was actually chosen. The route resolves a
              LEAF under "Outros" (ML files test listings there), and which leaf
              it landed on is not guessable from the id the field now shows. */}
          {testeConta.categoriaResolvida && testeConta.categoriaPath != null && (
            <Text size="sm">
              Categoria definida: <strong>{testeConta.categoriaPath.join(' › ')}</strong>.
            </Text>
          )}
          {/* Covers both ways the route can decline it: "Outros" absent from the
              catalogue, and no leaf reachable beneath it — only a leaf can be
              published into, so neither yields a usable category. */}
          {!testeConta.categoriaResolvida && (
            <Text size="sm">
              Não foi possível usar a categoria “Outros” automaticamente — escolha uma categoria
              antes de publicar.
            </Text>
          )}
          {/* ⚠️ Only meaningful once a category actually resolved. The route
              never queries listing types without one, so an unresolved category
              leaves `listingTypeId` null too — and saying "nenhum tipo nesta
              categoria" about a category that was never found blames the wrong
              thing, right beside the message that names the real one. */}
          {testeConta.categoriaResolvida && !testeConta.tipoResolvido && (
            <Text size="sm">
              Nenhum tipo de anúncio de baixa exposição está disponível nesta categoria — escolha um
              manualmente e evite Premium.
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Nada foi salvo nem publicado: os campos foram apenas preenchidos.
          </Text>
        </Stack>
      </Alert>
    );

  // ---- Attributes ---------------------------------------------------------
  // Deliberately NOT a react-hook-form field. The set of attributes is decided
  // by an async metadata call keyed on the category, so an RHF array would have
  // to be re-seeded on every arrival with `shouldDirty: false`, and every
  // re-seed is a chance to either wipe a pending edit or mark a pristine form
  // dirty. Holding the edits beside the form and deriving the rest is simpler
  // and has no effect in it.
  // `useWatch`, not `form.watch()`: the latter returns a fresh function the
  // React Compiler cannot memoize, so it opts the whole component out of
  // compilation (`react-hooks/incompatible-library`).
  const categoryId = useWatch({ control: form.control, name: 'category_id' });
  const effectiveCategoryId = categoryId == null || categoryId === '' ? null : categoryId;
  const atributosQuery = useQuery({
    queryKey: ['ml', 'atributos', integracaoId, effectiveCategoryId],
    enabled: effectiveCategoryId != null && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categoriaAtributos({ integracaoId, categoryId: effectiveCategoryId! }),
  });
  const attrs = useMemo(() => atributosQuery.data?.atributos ?? [], [atributosQuery.data]);
  const omitidos = useMemo(() => atributosQuery.data?.omitidos ?? [], [atributosQuery.data]);

  // Edits are stamped with the category they were made under, so switching
  // category falls back to the freshly seeded rows instead of showing values
  // that belong to a different attribute set.
  const [edited, setEdited] = useState<{ categoryId: string | null; rows: AttrRow[] } | null>(null);
  const seededRows = useMemo(
    () => seedRows(attrs, link.attributes ?? null),
    [attrs, link.attributes],
  );
  const attrDirty = edited != null && edited.categoryId === effectiveCategoryId;
  const attrRows = attrDirty ? edited.rows : seededRows;

  const attrErrors = useMemo(() => {
    const out: Record<string, string> = {};
    const byId = new Map(attrRows.map((r) => [r.id, r]));
    for (const attr of attrs) {
      const message = validateAttr(attr, byId.get(attr.id));
      if (message != null) out[attr.id] = message;
    }
    return out;
  }, [attrs, attrRows]);

  // ---- AI attribute suggestion (#799 A4) ---------------------------------
  // ⚠️ Staged, never applied. The route answers with suggestions and the modal
  // applies only what the operator ticked — the whole reason it is `sugerir-`.
  const [iaAberto, setIaAberto] = useState(false);
  const [iaResultado, setIaResultado] = useState<MercadoLivreAtributosSugestao | null>(null);
  const [iaOcupado, setIaOcupado] = useState(false);
  const [iaFeedback, setIaFeedback] = useState('');
  /** Bumped per run so the modal remounts and its checkbox set re-seeds. */
  const [iaRun, setIaRun] = useState(0);

  const pedirIa = useCallback(
    async (opts?: { feedback?: string; anterior?: MercadoLivreAtributoSugestao[] }) => {
      if (!client || effectiveCategoryId == null) return;
      setIaOcupado(true);
      // A revise turn keeps the modal open over the previous answer; a fresh run
      // opens it empty so the dialog is its own spinner.
      if (opts?.feedback == null) {
        setIaResultado(null);
        setIaRun((n) => n + 1);
        setIaAberto(true);
      }
      try {
        const res = await client.sugerirAtributos({
          integracaoId,
          produtoId,
          categoryId: effectiveCategoryId,
          ...(opts?.feedback != null ? { feedback: opts.feedback } : {}),
          ...(opts?.anterior != null ? { anterior: opts.anterior } : {}),
        });
        setIaResultado(res);
        setIaRun((n) => n + 1);
        setIaFeedback('');
      } catch (err) {
        if (
          err instanceof MercadoLivreClientHttpError ||
          err instanceof MercadoLivreClientNetworkError
        ) {
          setIaAberto(false);
          notifications.show({
            color: 'red',
            title: 'Não foi possível preencher com IA',
            message: err.message,
          });
          return;
        }
        throw err;
      } finally {
        setIaOcupado(false);
      }
    },
    [client, effectiveCategoryId, integracaoId, produtoId],
  );

  // Re-seed from the live snapshot ONLY while the operator has nothing pending.
  // A publish or a webhook landing mid-edit must not silently rewrite the text
  // someone is typing — that case is what the conflict modal is for.
  useEffect(() => {
    if (isDirty) return;
    baselineRef.current = link;
    form.reset(toFormValues(link));
  }, [link, isDirty, form]);

  // ⚠️ The disclosure has to follow that re-seed. `descricaoOpen` is seeded once,
  // but the effect above refills the whole form from the live snapshot whenever
  // nothing is pending — so a descrição written by a second tab, a colleague, or
  // an import lands in a textarea that stays `display: none`. No data is lost
  // (`buildListingPatch` only writes dirty keys), but "a hidden non-empty field
  // is one nobody remembers to check" is exactly the invariant the disclosure
  // exists for, and this app is never the only writer (root CLAUDE.md rule 7).
  //
  // Open-ONLY, and gated on the same `isDirty` edge, so it can never collapse
  // the field under someone mid-edit — which is why the seed is a `useState` and
  // not a derivation in the first place.
  useEffect(() => {
    if (isDirty) return;
    if ((link.descricao ?? '').trim() !== '') setDescricaoOpen(true);
  }, [link.descricao, isDirty]);

  useEffect(() => {
    onDirtyChange(linkDocId, isDirty || attrDirty);
  }, [linkDocId, isDirty, attrDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(linkDocId, false);
    },
    [linkDocId, onDirtyChange],
  );

  const runSave = useCallback(
    async (
      mode: 'button' | 'flush',
      override?: ProdutoMercadoLivreLink,
    ): Promise<ListingSaveOutcome> => {
      const valid = await form.trigger();
      if (!valid) {
        if (mode === 'flush') {
          throw new AfterSaveBlockedError(
            'Há campos inválidos no anúncio do Mercado Livre. Corrija-os na aba Mercado Livre.',
          );
        }
        // ⚠️ The one exit that shows NOTHING — the field errors render inline,
        // above the button. The caller aggregates so a skipped listing cannot
        // hide behind a sibling's success toast.
        return 'invalid';
      }
      const parsed = listingFormSchema.safeParse(form.getValues());
      if (!parsed.success) return 'invalid';

      const baseline = override ?? baselineRef.current;
      const port = createClientListingPort(db, produtoId, linkDocId);

      // `attributes` rides ONLY when the operator edited it AND the metadata
      // that governs the purge has actually loaded. `attributesForSave` decides
      // what survives by iterating that metadata, so running it against an
      // empty list would be deciding with no information — and this is the
      // field where the cost of that is silent: dropping `SIZE_GRID_ID` breaks
      // every size-chart binding with nothing on screen to show for it.
      const values = toPatchValues(parsed.data);
      const attributesRide = attrDirty && atributosQuery.data != null;
      if (attributesRide) {
        values.attributes = attributesForSave(attrs, attrRows, link.attributes ?? null, omitidos);
      }

      setSaving(true);
      try {
        await saveListing(port, {
          values,
          dirty: {
            ...(form.formState.dirtyFields as Record<string, unknown>),
            ...(attributesRide ? { attributes: true } : {}),
          },
          baseline,
          baselineMs: baseline.ultimaModificacao ?? null,
        });
        // Zero the dirty state without waiting for the snapshot round trip, so
        // the produto's leave-guard clears the moment the write lands.
        form.reset(parsed.data);
        // Drop the local attribute edits so the grid re-derives from the doc.
        setEdited(null);
        // Advance the baseline to what we just wrote — `values`, not a fresh
        // `toPatchValues`, so the attributes that rode are part of it. Waiting
        // for the snapshot instead would leave a window where a second save
        // compares against the pre-save doc and reports a conflict with our own
        // write.
        baselineRef.current = { ...baseline, ...values } as ProdutoMercadoLivreLink;
        setConflict(null);
        if (mode === 'button') {
          notifications.show({ color: 'green', message: 'Anúncio salvo.' });
        }
        return 'saved';
      } catch (err) {
        if (err instanceof ListingNothingChangedError) {
          // A round trip that ended where it started. Nothing to write, and
          // nothing worth interrupting the produto save for.
          form.reset(parsed.data);
          if (mode === 'button') {
            notifications.show({ color: 'yellow', message: err.message });
          }
          // Not a shortfall: nothing needed writing and the operator was told.
          return 'saved';
        }
        if (err instanceof ListingConflictError) {
          setConflict({ fields: err.fields, baseline, current: err.current });
          if (mode === 'flush') {
            throw new AfterSaveBlockedError(
              'O anúncio do Mercado Livre foi alterado por outra pessoa. Revise as diferenças antes de salvar.',
            );
          }
          return 'conflict';
        }
        if (err instanceof ListingMissingError) {
          notifications.show({ color: 'red', message: err.message });
          if (mode === 'flush') throw new AfterSaveBlockedError(err.message);
          return 'failed';
        }
        if (err instanceof FirebaseError) {
          notifications.show({ color: 'red', message: err.message });
          if (mode === 'flush') throw new AfterSaveBlockedError(err.message);
          return 'failed';
        }
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [
      db,
      form,
      linkDocId,
      produtoId,
      attrDirty,
      attrRows,
      attrs,
      omitidos,
      atributosQuery.data,
      link.attributes,
    ],
  );

  // The flush closure is re-read from a ref so the registration itself stays
  // stable — re-registering on every render would churn the editor's map.
  const runSaveRef = useRef(runSave);
  useEffect(() => {
    runSaveRef.current = runSave;
  }, [runSave]);
  useEffect(() => {
    registerFlush(linkDocId, (mode) => runSaveRef.current(mode));
    return () => registerFlush(linkDocId, null);
  }, [linkDocId, registerFlush]);

  const readOnly = Boolean(disabled) || !canWrite;

  return (
    <>
      <Fieldset legend="Dados do anúncio" variant="unstyled">
        {/* ⚠️ Development builds only. Publishing a test listing creates a REAL
            listing on the real marketplace (ML has no sandbox), so the affordance
            has no business existing in a deployed app — and `NODE_ENV` is a
            build-time constant, so the branch is stripped entirely rather than
            merely hidden. Same shape as the checkout harness and the print
            preview.
            ⚠️ Read INLINE, never into a module-level const: a const is captured
            at import time and `vi.stubEnv` can no longer move it, which would
            make this untestable. */}
        {process.env.NODE_ENV === 'development' && !isPublished && !readOnly && (
          <Group justify="flex-end" mb="xs">
            <Button
              type="button"
              variant="light"
              onClick={() => void preencherTeste()}
              loading={carregandoTeste}
              disabled={client == null}
            >
              Preencher com dados de teste
            </Button>
          </Group>
        )}
        {avisoTeste}
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
          <Controller
            control={form.control}
            name="title"
            render={({ field, fieldState }) => (
              <Tooltip label={titleRule.reason} disabled={titleRule.editable} multiline w={280}>
                <TextInput
                  {...field}
                  value={field.value ?? ''}
                  label="Título do anúncio"
                  maxLength={TITLE_MAX_LENGTH}
                  description={`${(field.value ?? '').length}/${TITLE_MAX_LENGTH}`}
                  disabled={readOnly || !titleRule.editable}
                  error={fieldState.error?.message}
                />
              </Tooltip>
            )}
          />
          {/* ⚠️ Condição is DERIVED from the produto's `ehUsado`, not edited
              here — see `CondicaoField`. It is deliberately a read-only pair and
              NOT a labelled control: the e2e proves the first-publish Select is
              gone by counting labelled elements on a published card, and a second
              labelled input in this grid would break that count. */}
          <CondicaoField
            ehUsado={produtoEhUsado}
            condicao={produtoCondicao}
            condicaoAnuncio={link.condition ?? null}
            published={isPublished}
          />
          <Controller
            control={form.control}
            name="category_id"
            render={({ field, fieldState }) => (
              <CategoriaField
                integracaoId={integracaoId}
                produtoNome={produtoNome}
                value={field.value === '' ? null : field.value}
                onChange={field.onChange}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          <Stack gap={4} style={{ gridColumn: '1 / -1' }}>
            {/* Collapsed by default on a listing that has none: the ML
                description is optional (publish falls back to the produto's),
                so an always-open 3-row textarea spent the most vertical space
                in the section on the field least often used. Anything already
                written opens expanded, because a hidden non-empty field is a
                field nobody remembers to check. */}
            {/* A bare `Anchor` read as body text here — no variant, no colour,
                nothing marking it as the control that reveals a whole field. A
                subtle Button with a chevron says "this opens something". */}
            <Button
              type="button"
              variant="subtle"
              size="compact-sm"
              justify="flex-start"
              w="fit-content"
              px={4}
              leftSection={
                descricaoOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
              }
              onClick={() => setDescricaoOpen((v) => !v)}
            >
              {descricaoOpen ? 'Ocultar descrição' : 'Descrição do anúncio (opcional)'}
            </Button>
            {/* ⚠️ Rendered ALWAYS and hidden with CSS, never unmounted. Mantine's
                <Collapse> unmounts its children, and an unmounted `Controller`
                is one RHF `shouldUnregister` default away from silently dropping
                the operator's text on save. Hiding costs nothing here — it is one
                textarea, not a subtree. */}
            <div
              data-testid="ml-descricao-wrapper"
              data-open={descricaoOpen ? 'true' : 'false'}
              style={{ display: descricaoOpen ? undefined : 'none' }}
            >
              <Controller
                control={form.control}
                name="descricao"
                render={({ field, fieldState }) => (
                  <Textarea
                    {...field}
                    value={field.value ?? ''}
                    label="Descrição"
                    description="Em branco, a publicação usa a descrição do produto."
                    autosize
                    minRows={3}
                    maxRows={10}
                    disabled={readOnly}
                    error={fieldState.error?.message}
                  />
                )}
              />
            </div>
          </Stack>
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Comercial" variant="unstyled">
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
          {/* ⚠️ A published listing must NOT render a labelled "Tipo de anúncio"
              control: ML only changes a listing type through its own upgrade
              endpoint, and `produto-mercado-livre.vendas.e2e.spec.ts` proves the
              first-publish Select is gone by asserting that label has count 0
              on a published card. */}
          {isPublished ? (
            <ListingField label="Tipo de anúncio">
              {textOr(listingTypeLabel(link.listing_type_id))}
            </ListingField>
          ) : (
            <Controller
              control={form.control}
              name="listing_type_id"
              render={({ field, fieldState }) => (
                <Select
                  label="Tipo de anúncio"
                  data={[...LISTING_TYPE_OPTIONS]}
                  value={field.value === '' ? null : field.value}
                  onChange={(v) => field.onChange(v ?? '')}
                  onBlur={field.onBlur}
                  disabled={readOnly}
                  error={fieldState.error?.message}
                />
              )}
            />
          )}
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Atributos da categoria" variant="unstyled">
        <AtributosSection
          categoryId={effectiveCategoryId}
          attrs={attrs}
          rows={attrRows}
          onRowsChange={(rows) => setEdited({ categoryId: effectiveCategoryId, rows })}
          errors={attrErrors}
          leaf={atributosQuery.data?.leaf ?? true}
          loading={atributosQuery.isPending && effectiveCategoryId != null}
          failed={atributosQuery.isError}
          disabled={readOnly}
          acaoIa={
            <Tooltip label="Preencher com IA" withArrow>
              {/* ⚠️ A <span> so the tooltip still fires when the button is
                  disabled — Mantine turns pointer events off on a disabled
                  control, which is the trap `PermGate` documents. */}
              <span style={{ display: 'inline-block' }}>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Preencher com IA"
                  loading={iaOcupado && !iaAberto}
                  disabled={
                    readOnly ||
                    client == null ||
                    effectiveCategoryId == null ||
                    atributosQuery.data?.leaf === false
                  }
                  onClick={() => void pedirIa()}
                >
                  <IconSparkles size={16} />
                </ActionIcon>
              </span>
            </Tooltip>
          }
        />
      </Fieldset>

      <AtributosAiModal
        key={iaRun}
        opened={iaAberto}
        onClose={() => setIaAberto(false)}
        resultado={iaResultado}
        attrs={attrs}
        rows={attrRows}
        onApply={(aceitas) => {
          const ids = new Set(aceitas.map((a) => a.id));
          setEdited({
            categoryId: effectiveCategoryId,
            rows: applySuggestions(attrs, attrRows, aceitas, (id) => ids.has(id)),
          });
        }}
        feedback={{
          value: iaFeedback,
          onChange: setIaFeedback,
          onResubmit: () =>
            void pedirIa({ feedback: iaFeedback, anterior: iaResultado?.sugestoes ?? [] }),
          busy: iaOcupado,
          placeholder: 'Ex.: a cor está errada, é azul-marinho; o material é algodão.',
        }}
      />

      {/* ⚠️ "Salvar anúncio" is NOT rendered here any more. It lives in
          `MercadoLivreEditor`'s action group, beside "Publicar no Mercado Livre",
          because saving and publishing are the two halves of one decision and
          having them at opposite ends of a long card read as unrelated.
          `registerFlush` is what lets the editor drive this form's save, and the
          editor gates the button on its own `dirtyIds` — which counts ATTRIBUTE
          edits too, unlike the RHF-only `isDirty` this button used to read. */}

      <ListingConflictModal
        opened={conflict !== null}
        fields={conflict?.fields ?? []}
        baseline={conflict?.baseline ?? null}
        current={conflict?.current ?? null}
        saving={saving}
        onCancel={() => setConflict(null)}
        onForceSave={() => {
          const current = conflict?.current;
          if (!current) return;
          void runSave('button', current);
        }}
      />
    </>
  );
}
