'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconMapPin, IconSearch } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { z, ZodError } from 'zod';
import { PERM } from '@delfrance/auth';
import {
  TIPO_CLIENTE,
  type Endereco,
  TIPO_CLIENTE_LABELS,
  clienteSchema,
  refineClienteTipoDocumento,
  tipoClienteSchema,
} from '@delfrance/schemas';
import { saveRecord } from '@delfrance/ui';
import { formatCNPJ, formatCPF } from '@delfrance/core/documents';
import { normalizeTelefone } from '@delfrance/core/phone';
import { CpfCnpjTextInput } from '@/components/inputs/CpfCnpjInput';
import { TelefoneTextInput } from '@/components/inputs/TelefoneInput';
import { EnderecoFormModal } from '@/components/pickers/EnderecoFormModal';
import {
  type ClienteDedupInput,
  type ClienteDedupResult,
  type DedupCandidate,
  checkClienteDuplicates,
} from '@/lib/clientes/dedup';
import type { ClienteCnpjEndereco } from '@/lib/clientes/consultaCnpj';
import { findExistingEndereco } from '@/lib/clientes/enderecoDedup';
import { resolveCnpj } from '@/lib/clientes/resolveCnpj';
import { useDefaultFilialId } from '@/lib/clientes/useDefaultFilialId';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import { useAuth, usePermission } from '@/lib/auth';

/**
 * Quick-create modal opened from the ClientePicker (issue #143). Minimal
 * fields — everything else stays at schema defaults; full editing remains
 * on /clientes/[id]. Before creating it deduplicates:
 *
 *  - exact cpf_cnpj / idEstrangeiro match → creation is BLOCKED, the
 *    existing cliente is offered instead;
 *  - similar nome (pipeline regex, case/accent-insensitive) → candidate
 *    list with "Usar cliente existente" next to "Criar mesmo assim";
 *  - same telefone (either wire shape) or e-mail → warning only.
 */
export interface ClienteQuickCreateModalProps {
  opened: boolean;
  onClose: () => void;
  /** Created OR picked-existing cliente. The picker converts id → emit shape. */
  onResolve: (picked: { id: string; nome: string }) => void;
}

// Validation rides the (tightened) clienteSchema field rules; `tipo` decides
// whether cpf_cnpj or idEstrangeiro is collected, and nome becomes required.
const quickCreateSchema = clienteSchema
  .pick({ cpf_cnpj: true, idEstrangeiro: true, ie: true, email: true, telefone: true })
  .extend({
    tipo: tipoClienteSchema.default('0'),
    nome: z.string().min(1, 'Obrigatório').max(255),
  })
  // `.pick()` drops the base object's cross-field refine — re-apply it so the
  // modal blocks a Pessoa Física + CNPJ (or PJ + CPF) just like the full form.
  .superRefine(refineClienteTipoDocumento);

type QuickCreateInput = z.input<typeof quickCreateSchema>;
type QuickCreateOutput = z.output<typeof quickCreateSchema>;

const TIPO_OPTIONS = tipoClienteSchema.options.map((value) => ({
  value,
  label: TIPO_CLIENTE_LABELS[value],
}));

function toDedupInput(v: QuickCreateOutput): ClienteDedupInput {
  return {
    nome: v.nome ?? '',
    cpf_cnpj: (v.tipo === TIPO_CLIENTE.estrangeiro ? null : v.cpf_cnpj) ?? '',
    idEstrangeiro: (v.tipo === TIPO_CLIENTE.estrangeiro ? v.idEstrangeiro : null) ?? '',
    email: v.email ?? '',
    telefone: v.telefone ?? '',
  };
}

function candidateDoc(c: DedupCandidate): string | null {
  if (c.cpf_cnpj) return c.cpf_cnpj.length === 11 ? formatCPF(c.cpf_cnpj) : formatCNPJ(c.cpf_cnpj);
  return c.idEstrangeiro;
}

function CandidateRow({ candidate, onUse }: { candidate: DedupCandidate; onUse: () => void }) {
  const detail = [candidateDoc(candidate), candidate.telefone, candidate.email]
    .filter(Boolean)
    .join(' · ');
  return (
    <Group justify="space-between" wrap="nowrap">
      <Stack gap={0}>
        <Text size="sm">{candidate.nome ?? candidate.id}</Text>
        {detail && (
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        )}
      </Stack>
      <Button size="xs" variant="light" onClick={onUse}>
        Usar cliente existente
      </Button>
    </Group>
  );
}

/** Cliente resolved by the modal form, with the CNPJ-resolved address to review. */
interface QuickCreateResolved {
  id: string;
  nome: string;
  endereco: ClienteCnpjEndereco | null;
}

function QuickCreateForm({
  onResolved,
  onCancel,
}: {
  onResolved: (picked: QuickCreateResolved) => void;
  onCancel: () => void;
}) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  const nfe = useNFeClient();
  // Filial whose A1 cert signs the (best-effort) SEFAZ Consulta Cadastro leg of
  // the CNPJ lookup — first filial, same default the cliente pages use.
  const filialId = useDefaultFilialId();

  const [dedup, setDedup] = useState<ClienteDedupResult | null>(null);
  const [confirmRequired, setConfirmRequired] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  // Address resolved by the CNPJ lookup, held until create then relayed to the
  // cliente's cadastro (the modal has no endereço UI). `enderecoFound` drives the
  // pre-create hint; the ref carries the value (mirrors the create page).
  const pendingEnderecoRef = useRef<ClienteCnpjEndereco | null>(null);
  const [enderecoFound, setEnderecoFound] = useState(false);
  // "Criar mesmo assim" — bypasses the NON-blocking findings on the next
  // submit. Blocking matches re-checked at submit can never be bypassed.
  const forceCreate = useRef(false);
  // Live checks are debounced + async — drop responses from stale inputs.
  const checkSeq = useRef(0);

  const form = useForm<QuickCreateInput, unknown, QuickCreateOutput>({
    resolver: zodResolver(quickCreateSchema),
    defaultValues: {
      tipo: '0',
      nome: '',
      cpf_cnpj: null,
      idEstrangeiro: null,
      ie: null,
      email: null,
      telefone: null,
    },
    mode: 'onBlur',
  });

  // Any edit invalidates a pending "criar mesmo assim" confirmation.
  useEffect(() => {
    // form.watch() returns a subscription (not a memoizable value); the
    // React Compiler flags the API but the subscribe/unsubscribe usage is safe.
    // eslint-disable-next-line react-hooks/incompatible-library
    const sub = form.watch(() => {
      forceCreate.current = false;
      setConfirmRequired(false);
    });
    return () => sub.unsubscribe();
  }, [form]);

  const blocked = (dedup?.blocking.length ?? 0) > 0;

  const runLiveCheck = useDebouncedCallback(() => {
    const input = toDedupInput(form.getValues() as QuickCreateOutput);
    const seq = ++checkSeq.current;
    if (!input.nome && !input.cpf_cnpj && !input.idEstrangeiro && !input.email && !input.telefone) {
      setDedup(null);
      return;
    }
    checkClienteDuplicates(db, input)
      .then((result) => {
        if (seq === checkSeq.current) setDedup(result);
      })
      .catch((err) => {
        // Live checks are advisory and fire-and-forget: a failure must never
        // become an unhandled rejection or leave stale (possibly blocking)
        // findings on screen. Drop this input's findings; the awaited re-check
        // at submit is what surfaces a real, persistent error to the user.
        if (seq === checkSeq.current) setDedup(null);
        if (!(err instanceof FirebaseError)) {
          console.error('[ClienteQuickCreate] live dedup check failed', err);
        }
      });
  }, 300);

  // PJ-only CNPJ lookup (issue #250): fills nome + inscrição estadual from the
  // public BrasilAPI + best-effort SEFAZ Consulta Cadastro (shared `resolveCnpj`,
  // same as the cliente pages). No endereço — this modal has no endereço UI.
  async function buscarDados() {
    const cnpj = form.getValues('cpf_cnpj') ?? '';
    // Validate on click (the button is always enabled): an invalid/empty CNPJ
    // surfaces a red notification and never hits the API. The modal feeds back
    // via notifications (not an inline field error, which renders unreliably
    // inside the Mantine Modal portal) — matching the green/yellow success ones.
    if (!/^\d{14}$/.test(cnpj)) {
      notifications.show({
        color: 'red',
        message: 'Informe um CNPJ válido (14 dígitos) para buscar os dados.',
      });
      return;
    }
    setLookupLoading(true);
    try {
      const outcome = await resolveCnpj(cnpj, nfe, filialId);
      if (!outcome.ok) {
        notifications.show({
          color: 'red',
          message:
            outcome.reason === 'network'
              ? 'Falha de rede ao consultar o CNPJ.'
              : outcome.reason === 'invalid-response'
                ? 'Resposta inválida da API de CNPJ.'
                : 'CNPJ não encontrado na base pública.',
        });
        return;
      }
      const { nome, ie, endereco, sefazNote } = outcome.data;
      const SET_OPTS = { shouldDirty: true, shouldValidate: true } as const;
      // A CNPJ belongs to a Pessoa Jurídica — switch the tipo so the form stays
      // valid (PF + CNPJ is rejected) and the PJ-only IE field is revealed.
      const switchedToPJ = form.getValues('tipo') !== '1';
      if (switchedToPJ) form.setValue('tipo', '1', SET_OPTS);
      form.setValue('nome', nome, SET_OPTS);
      if (ie) form.setValue('ie', ie, SET_OPTS);
      // Hold the resolved address (null too — a no-address lookup retracts a
      // previously captured one); it's offered after the cliente is created.
      pendingEnderecoRef.current = endereco;
      setEnderecoFound(endereco !== null);
      // Nome changed — re-run the dedup check against the resolved razão social.
      runLiveCheck();
      // Announce the silent tipo change so the operator notices it.
      const tipoNote = switchedToPJ ? 'Tipo alterado para Pessoa Jurídica. ' : '';
      if (ie) {
        notifications.show({
          color: 'green',
          message: `${tipoNote}Dados de ${nome} preenchidos (IE ${ie})`,
        });
      } else {
        const why = sefazNote ?? 'IE não disponível';
        notifications.show({
          color: 'yellow',
          message: `${tipoNote}Dados de ${nome} preenchidos. ${why} — preencha a IE manualmente.`,
        });
      }
    } finally {
      setLookupLoading(false);
    }
  }

  async function doCreate(values: QuickCreateOutput) {
    const doc = clienteSchema.parse({
      tipo: values.tipo,
      nome: values.nome.trim(),
      cpf_cnpj: values.tipo === TIPO_CLIENTE.estrangeiro ? null : values.cpf_cnpj || null,
      idEstrangeiro: values.tipo === TIPO_CLIENTE.estrangeiro ? values.idEstrangeiro || null : null,
      // IE is a PJ concept — only persist it for Pessoa Jurídica (tipo '1').
      ie: values.tipo === TIPO_CLIENTE.pessoaJuridica ? values.ie || null : null,
      email: values.email || null,
      telefone: values.telefone ? normalizeTelefone(values.telefone) : null,
      // Nullish stamps — saveRecord fills create + last-modified at write time.
      timestamp: null,
      ultimaModificacao: null,
    });
    const { id } = await saveRecord<typeof clienteSchema, Record<string, unknown>>({
      db,
      collection: clienteCollection,
      pathContext: {},
      values: doc as Record<string, unknown>,
      dirtyFields: {},
      currentUserUid: user?.uid ?? '',
      stampUnit: 'ms',
    });
    // Hand the created cliente + its resolved address up; the modal opens the
    // endereço review in place (no more new-tab relay).
    onResolved({ id, nome: doc.nome ?? '', endereco: pendingEnderecoRef.current });
  }

  async function onSubmit(values: QuickCreateOutput) {
    setSubmitError(null);
    try {
      // Always re-check at submit — never trust the (debounced) live result.
      const result = await checkClienteDuplicates(db, toDedupInput(values));
      checkSeq.current++; // invalidate in-flight live checks
      setDedup(result);
      if (result.blocking.length > 0) {
        forceCreate.current = false;
        setConfirmRequired(false);
        return;
      }
      // Only similar-nome candidates require an explicit "Criar mesmo assim".
      // Telefone/e-mail matches are warning-only — shown, but never blocking
      // and never a second confirmation step (per the issue spec).
      if (!forceCreate.current && result.similarNome.length > 0) {
        setConfirmRequired(true);
        return;
      }
      await doCreate(values);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
        return;
      }
      if (err instanceof ZodError) {
        setSubmitError(err.issues.map((i) => i.message).join('; '));
        return;
      }
      throw err;
    }
  }

  const submitting = form.formState.isSubmitting;
  const tipo = form.watch('tipo') ?? '0';
  const similar = dedup?.similarNome ?? [];
  const warnings = [
    ...(dedup?.telefoneMatches.length
      ? [
          `telefone já cadastrado em: ${dedup.telefoneMatches.map((c) => c.nome ?? c.id).join(', ')}`,
        ]
      : []),
    ...(dedup?.emailMatches.length
      ? [`e-mail já cadastrado em: ${dedup.emailMatches.map((c) => c.nome ?? c.id).join(', ')}`]
      : []),
  ];

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <Stack>
        <Controller
          control={form.control}
          name="tipo"
          render={({ field, fieldState }) => (
            <Select
              label="Tipo"
              data={TIPO_OPTIONS}
              value={field.value ?? '0'}
              onChange={(next) => {
                field.onChange(next ?? '0');
                // The hidden counterpart must not leak into dedup/create.
                form.setValue(next === '2' ? 'cpf_cnpj' : 'idEstrangeiro', null);
                // IE is PJ-only — drop it (and its field) when leaving Pessoa Jurídica.
                if (next !== '1') form.setValue('ie', null);
              }}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
              allowDeselect={false}
            />
          )}
        />

        <Controller
          control={form.control}
          name="nome"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              onBlur={() => {
                field.onBlur();
                runLiveCheck();
              }}
              label="Nome"
              error={fieldState.error?.message}
              maxLength={255}
              required
              data-autofocus
            />
          )}
        />

        {tipo !== '2' ? (
          <Controller
            control={form.control}
            name="cpf_cnpj"
            render={({ field, fieldState }) => (
              <CpfCnpjTextInput
                value={field.value ?? ''}
                onChange={(next) => {
                  // Editing clears a stale zod validation error mid-edit.
                  if (fieldState.error) form.clearErrors('cpf_cnpj');
                  // Editing the CNPJ invalidates any address a prior lookup held.
                  if (pendingEnderecoRef.current) {
                    pendingEnderecoRef.current = null;
                    setEnderecoFound(false);
                  }
                  field.onChange(next === '' ? null : next);
                }}
                onBlur={() => {
                  field.onBlur();
                  runLiveCheck();
                }}
                label="CPF / CNPJ"
                error={fieldState.error?.message}
                // "buscar dados" — shown for any tipo and always clickable; it
                // validates on click (invalid CNPJ → error, no API call) and a
                // successful lookup switches tipo to PJ.
                rightSection={
                  <Tooltip label="Buscar dados do CNPJ (razão social, IE)" withArrow>
                    <ActionIcon
                      type="button"
                      variant="subtle"
                      onClick={buscarDados}
                      loading={lookupLoading}
                      aria-label="Buscar dados do CNPJ"
                    >
                      <IconSearch size={16} />
                    </ActionIcon>
                  </Tooltip>
                }
              />
            )}
          />
        ) : (
          <Controller
            control={form.control}
            name="idEstrangeiro"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                onChange={(e) =>
                  field.onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)
                }
                onBlur={() => {
                  field.onBlur();
                  runLiveCheck();
                }}
                label="ID estrangeiro"
                error={fieldState.error?.message}
                maxLength={20}
              />
            )}
          />
        )}

        {/* Inscrição estadual — PJ only; filled by "buscar dados", editable. */}
        {tipo === '1' && (
          <Controller
            control={form.control}
            name="ie"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                onChange={(e) =>
                  field.onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)
                }
                label="Inscrição estadual"
                error={fieldState.error?.message}
                maxLength={16}
              />
            )}
          />
        )}

        {enderecoFound && (
          <Alert color="blue" icon={<IconMapPin size={16} />} title="Endereço encontrado">
            O endereço deste CNPJ será oferecido para revisão ao criar ou usar o cliente.
          </Alert>
        )}

        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              onChange={(e) =>
                field.onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)
              }
              onBlur={() => {
                field.onBlur();
                runLiveCheck();
              }}
              label="E-mail"
              type="email"
              error={fieldState.error?.message}
              maxLength={255}
            />
          )}
        />

        <Controller
          control={form.control}
          name="telefone"
          render={({ field, fieldState }) => (
            <TelefoneTextInput
              value={field.value ?? ''}
              onChange={(next) => field.onChange(next === '' ? null : next)}
              onBlur={() => {
                field.onBlur();
                runLiveCheck();
              }}
              label="Telefone"
              error={fieldState.error?.message}
            />
          )}
        />

        {blocked && dedup && (
          <Alert color="red" title="Cliente já cadastrado">
            <Stack gap="xs">
              <Text size="sm">
                Já existe um cliente com este {tipo === '2' ? 'ID estrangeiro' : 'CPF/CNPJ'}. Use o
                cadastro existente:
              </Text>
              {dedup.blocking.map((c) => (
                <CandidateRow
                  key={c.id}
                  candidate={c}
                  onUse={() =>
                    // Exact CNPJ match ⇒ the picked cliente owns this address; offer it.
                    onResolved({
                      id: c.id,
                      nome: c.nome ?? '',
                      endereco: pendingEnderecoRef.current,
                    })
                  }
                />
              ))}
              {/* The endereço review on "Usar cliente existente" needs a resolved
                  address; without a lookup there's nothing to review, so nudge the
                  operator to run one (CNPJ tipo only). */}
              {tipo !== '2' && !enderecoFound && (
                <Text size="xs" c="dimmed">
                  Clique em &quot;Buscar dados&quot; para revisar o endereço deste cliente.
                </Text>
              )}
            </Stack>
          </Alert>
        )}

        {!blocked && warnings.length > 0 && (
          <Alert color="yellow" title="Possível duplicado">
            <Stack gap={2}>
              {warnings.map((w) => (
                <Text key={w} size="sm">
                  {w}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}

        {!blocked && similar.length > 0 && (
          <Stack gap="xs">
            <Divider label="Clientes com nome parecido" />
            {similar.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                // A fuzzy name match is a different identity — don't apply this
                // CNPJ's address to it.
                onUse={() => onResolved({ id: c.id, nome: c.nome ?? '', endereco: null })}
              />
            ))}
          </Stack>
        )}

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="space-between" align="center">
          <Anchor component={Link} href="/clientes/novo" target="_blank" size="xs" c="dimmed">
            Precisa de mais campos? Abrir cadastro completo
          </Anchor>
          <Group>
            <Button variant="default" onClick={onCancel} disabled={submitting}>
              Cancelar
            </Button>
            {confirmRequired && !blocked ? (
              <Button
                color="yellow"
                loading={submitting}
                onClick={() => {
                  forceCreate.current = true;
                  void form.handleSubmit(onSubmit)();
                }}
              >
                Criar mesmo assim
              </Button>
            ) : (
              <Button type="submit" loading={submitting} disabled={blocked}>
                Criar
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </form>
  );
}

/** The CNPJ-resolved address maps 1:1 onto enderecoSchema keys (estado is a UF). */
function toEnderecoPrefill(e: ClienteCnpjEndereco): Partial<Endereco> {
  return { ...e, estado: e.estado as Endereco['estado'] };
}

/**
 * Modal flow: `form` (the quick-create form) → `checking` (the endereço dedup
 * query, a Loader in the same Modal) → `endereco` (the `EnderecoFormModal` review,
 * a separate sibling Modal). Only one Modal is ever open — the repo has no
 * modal-in-modal pattern.
 */
type QuickCreatePhase =
  | { step: 'form' }
  | { step: 'checking'; id: string; nome: string; endereco: ClienteCnpjEndereco }
  | {
      step: 'endereco';
      clienteId: string;
      nome: string;
      recordId?: string;
      prefill?: Partial<Endereco>;
    };

export function ClienteQuickCreateModal({
  opened,
  onClose,
  onResolve,
}: ClienteQuickCreateModalProps) {
  const db = getFirebaseFirestore();
  const { allowed: canWriteEndereco, loading: permLoading } = usePermission(PERM.endereco.write);
  const [phase, setPhase] = useState<QuickCreatePhase>({ step: 'form' });
  // Remember the resolved cliente so the endereço step (save OR skip) can emit it.
  const resolvedRef = useRef<{ id: string; nome: string } | null>(null);
  // `onResolve` is a fresh closure each parent render — keep the latest in a ref
  // so the decision effect can call it without re-running on every render.
  const onResolveRef = useRef(onResolve);
  useEffect(() => {
    onResolveRef.current = onResolve;
  }, [onResolve]);

  // Every fresh open starts at the form (resetting the wizard when the parent
  // reopens the modal is exactly the prop-driven reset effects exist for).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on reopen
    if (opened) setPhase({ step: 'form' });
  }, [opened]);

  // Emit the resolved cliente exactly once — from the endereço step (save OR
  // skip) or the no-address / no-permission short-circuits. Clearing the ref
  // makes a stray second call a no-op. Stable (ref-only) so the effect below can
  // depend on it without re-running each render.
  const finishEndereco = useCallback(() => {
    const resolved = resolvedRef.current;
    resolvedRef.current = null;
    if (resolved) onResolveRef.current(resolved);
  }, []);

  function handleClienteResolved(picked: QuickCreateResolved) {
    resolvedRef.current = { id: picked.id, nome: picked.nome };
    // No address to review → emit the cliente now. A missing endereço-write
    // permission is handled by the effect (which waits for it to resolve first).
    if (!picked.endereco) {
      finishEndereco();
      return;
    }
    setPhase({ step: 'checking', id: picked.id, nome: picked.nome, endereco: picked.endereco });
  }

  // Decide register-new vs review-existing once the endereço permission has
  // RESOLVED (usePermission is `allowed:false` while loading — deciding early
  // would wrongly skip the review). Cancellable so a late response can't reopen
  // the step after the modal moved on (mirrors EnderecosSection).
  useEffect(() => {
    if (phase.step !== 'checking' || permLoading) return;
    if (!canWriteEndereco) {
      finishEndereco();
      return;
    }
    let cancelled = false;
    void (async () => {
      const existing = await findExistingEndereco(db, phase.id, phase.endereco);
      if (cancelled) return;
      if (existing) {
        notifications.show({
          color: 'yellow',
          message: 'Endereço já cadastrado para este cliente — abrindo para revisão.',
        });
        setPhase({
          step: 'endereco',
          clienteId: phase.id,
          nome: phase.nome,
          recordId: existing.id,
        });
      } else {
        setPhase({
          step: 'endereco',
          clienteId: phase.id,
          nome: phase.nome,
          prefill: toEnderecoPrefill(phase.endereco),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, permLoading, canWriteEndereco, db, finishEndereco]);

  return (
    <>
      <Modal
        opened={opened && phase.step !== 'endereco'}
        onClose={onClose}
        title="Novo cliente"
        size="lg"
      >
        {/* Conditional mount so every open starts with fresh form/dedup state.
            The `onSubmit` guard stops the inner form's submit from bubbling up the
            React tree (the portaled Modal is still a React-tree descendant) into
            an ancestor <form> — e.g. the pedido form when this modal is opened
            from the Principal/Frete ClientePicker — which would otherwise submit
            (and `addDoc`) the pedido on every "Criar". */}
        {opened && phase.step === 'checking' && (
          <Center py="xl">
            <Loader />
          </Center>
        )}
        {opened && phase.step === 'form' && (
          <div onSubmit={(e) => e.stopPropagation()}>
            <QuickCreateForm onResolved={handleClienteResolved} onCancel={onClose} />
          </div>
        )}
      </Modal>

      {/* Endereço review — a sibling Modal, open only while the quick-create one
          is closed (phase 'endereco'), so the two never stack. */}
      {phase.step === 'endereco' && (
        <EnderecoFormModal
          opened={opened}
          onClose={finishEndereco}
          clienteId={phase.clienteId}
          recordId={phase.recordId}
          prefill={phase.prefill}
          onSaved={finishEndereco}
        />
      )}
    </>
  );
}
