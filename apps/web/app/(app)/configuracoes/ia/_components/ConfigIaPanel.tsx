'use client';

/**
 * Settings for ONE AI agent — the `configIa/{agenteId}` document.
 *
 * The panel is agent-agnostic: `agenteId` picks the document, and the heading
 * and blurb come from props. Two agents render it today (attributes and size
 * charts) and they deliberately do NOT share a document — see
 * `CONFIG_IA_ML_MEDIDAS_DOC_ID` for why (different instructions, independent
 * kill switches).
 *
 * ⚠️ **Hand-written, NOT an `ObjectView`.** Every `recordId` in this app is a
 * route param; ObjectView has never been bound to a fixed known id, and its
 * `saveRecord` takes a `tx.update` path that throws when the document does not
 * exist — which is precisely the state of a fresh `configIa/{agenteId}`. The
 * precedent for editing a known-id config doc is `NfeConfigPanel.tsx`, and this
 * follows it: `useQuery` + `getDoc`, save through `runTransaction` re-reading
 * inside the transaction, an explicit "does not exist yet" state, and a
 * `usePermission` write gate.
 *
 * **Two permissions gate this page, not one.** `/configuracoes/layout.tsx` wraps
 * every child in `RequirePerm bit={PERM.configuracoes.read}`, so viewing needs
 * `configuracoes.read` while saving needs `integracao.write`. That pairing is
 * deliberate (reusing the integracao bits avoided minting a new one and
 * re-minting every user's claims) but it is genuinely two gates.
 *
 * **What is NOT editable here, on purpose:** the response schema. It is rebuilt
 * server-side from ML's own category metadata on every call and is what carries
 * the anti-hallucination guarantee — no `required`, no `nullable`, no `anyOf`,
 * so omission stays the cheapest thing the model can do. Exposing it as text
 * would put that guarantee one typo away from gone.
 */
import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc, runTransaction } from 'firebase/firestore';
import { z } from 'zod';

import { PERM } from '@delfrance/auth';
import { nowMillis } from '@delfrance/core/datetime';
import {
  CONFIG_IA_MODELO_PADRAO,
  PROVEDOR_IA,
  configIaSchema,
  type ConfigIa,
  type ProvedorIa,
} from '@delfrance/schemas';

import { usePermission } from '@/lib/auth';
import { configIaCollection } from '@/lib/data/configIaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { isRetryableMercadoLivreError, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';

/**
 * Raised when someone else saved this page while this form was open.
 *
 * Tier 3 of the lost-update ladder: the browser SDK cannot express a
 * `lastUpdateTime` precondition, so an interactive edit that loses a race has to
 * be shown to the human rather than dropped (root `CLAUDE.md` rule 7).
 */
class ConfigIaConflictError extends Error {
  constructor() {
    super(
      'Outra pessoa alterou estas configurações enquanto esta página estava aberta. Recarregue para ver os valores atuais antes de salvar.',
    );
    this.name = 'ConfigIaConflictError';
  }
}

const PROVEDOR_OPTIONS = [
  { value: PROVEDOR_IA.vertex, label: 'Vertex AI (recomendado)' },
  // Disabled until it is actually wired: the suggestion route calls
  // `createVertexGenerateFn()` unconditionally and now declines outright for any
  // other provider. Offering a selectable option that only produces a 409 is
  // worse than not offering it.
  {
    value: PROVEDOR_IA.googleai,
    label: 'Google AI (Gemini API) — não implementado',
    disabled: true,
  },
] as const;

/** How long a saved change can take to reach a warm backend instance. */
const CACHE_TTL_LABEL = '15 minutos';

const ORIGEM_LABEL: Record<'config' | 'env' | 'padrao', string> = {
  config: 'escolhido nesta tela',
  env: 'forçado por variável de ambiente no backend',
  padrao: 'padrão do sistema',
};

export interface ConfigIaPanelProps {
  /** Which `configIa/{agenteId}` document this panel edits. */
  agenteId: string;
  titulo: string;
  descricao: string;
}

export function ConfigIaPanel({ agenteId, titulo, descricao }: ConfigIaPanelProps) {
  const db = getFirebaseFirestore();
  const queryClient = useQueryClient();
  const client = useMercadoLivreClient();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);

  const cfgQuery = useQuery({
    queryKey: ['configIa', agenteId],
    queryFn: async () => {
      const snap = await getDoc(configIaCollection.docRef(db, {}, agenteId));
      // `null` is a first-class answer, not an error: no tenant has this doc
      // until someone saves this page for the first time.
      return snap.exists() ? snap.data() : null;
    },
  });

  const modelosQuery = useQuery({
    // ⚠️ Keyed by agent. The model list is shared, but `efetivo` and
    // `promptPadrao` are per-agent — a shared key would show one agent's
    // effective model and default instruction under the other's heading.
    queryKey: ['ia', 'modelos', agenteId],
    enabled: client != null,
    // The catalogue moves when Google ships a model. The backend caches it too;
    // this only avoids re-asking on every tab focus.
    staleTime: 30 * 60 * 1000,
    queryFn: () => client!.iaModelos(agenteId),
    retry: mercadoLivreQueryRetry,
  });

  const modelosRetry = queryRetry(modelosQuery);
  const modelosRetryable =
    modelosQuery.error != null && isRetryableMercadoLivreError(modelosQuery.error);

  const cfg = cfgQuery.data ?? null;
  // Defaults come from the schema so a new field cannot be forgotten here.
  const base: ConfigIa = cfg ?? configIaSchema.parse({});

  const [modelo, setModelo] = useState<string | null>(null);
  const [provedor, setProvedor] = useState<ProvedorIa | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [temperatura, setTemperatura] = useState<number | null>(null);
  const [ativo, setAtivo] = useState<boolean | null>(null);

  // Local edits win; otherwise mirror the persisted doc (or the schema default).
  const modeloValue = modelo ?? base.modelo ?? '';
  const provedorValue = provedor ?? base.provedor;
  const promptValue = prompt ?? base.promptSistema ?? '';
  const maxTokensValue = maxTokens ?? base.maxOutputTokens;
  const temperaturaValue = temperatura ?? base.temperatura;
  const ativoValue = ativo ?? base.ativo;

  const dirty =
    modeloValue !== (base.modelo ?? '') ||
    provedorValue !== base.provedor ||
    promptValue !== (base.promptSistema ?? '') ||
    maxTokensValue !== base.maxOutputTokens ||
    temperaturaValue !== base.temperatura ||
    ativoValue !== base.ativo;

  const save = useMutation({
    mutationFn: async () => {
      const ref = configIaCollection.docRef(db, {}, agenteId);
      const next = {
        // '' means "no explicit choice" and must be stored as null, or the
        // resolution chain can never reach the env step and the shipped default
        // is frozen for this tenant forever.
        modelo: modeloValue.trim() === '' ? null : modeloValue.trim(),
        provedor: provedorValue,
        promptSistema: promptValue.trim() === '' ? null : promptValue,
        maxOutputTokens: maxTokensValue,
        temperatura: temperaturaValue,
        ativo: ativoValue,
        ultimaModificacao: nowMillis(),
      } satisfies ConfigIa;

      // `tx.set`, not `tx.update`: the document legitimately may not exist yet —
      // this page is the thing that creates it.
      //
      // ⚠️ The re-read is NOT here to preserve sibling fields. `next` covers
      // every field in `configIaSchema`, so `{ ...fresh, ...next }` IS `next` —
      // that is what makes this different from `NfeConfigPanel`, whose doc holds
      // counters the panel does not own. What the re-read buys here is the
      // CONFLICT check below, which root `CLAUDE.md` rule 7 tier 3 asks for: the
      // browser SDK has no `lastUpdateTime` precondition, so without it two
      // operators on this page silently overwrite each other — A opens it, B
      // saves a new model, A saves a stale form and B's change is gone with no
      // signal on either side.
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const fresh = snap.exists() ? snap.data() : configIaSchema.parse({});
        // Compared against the doc the FORM was seeded from, re-derived inside
        // the transaction — comparing against a value captured outside it would
        // be a guard that never fires (rule 7).
        if (snap.exists() && fresh.ultimaModificacao !== base.ultimaModificacao) {
          throw new ConfigIaConflictError();
        }
        tx.set(ref, { ...fresh, ...next });
      });
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Configuração de IA salva.' });
      setModelo(null);
      setProvedor(null);
      setPrompt(null);
      setMaxTokens(null);
      setTemperatura(null);
      setAtivo(null);
      void queryClient.invalidateQueries({ queryKey: ['configIa'] });
      void queryClient.invalidateQueries({ queryKey: ['ia', 'modelos'] });
    },
    onError: (err) => {
      if (err instanceof ConfigIaConflictError) {
        notifications.show({
          color: 'yellow',
          title: 'Configuração alterada',
          message: err.message,
        });
        void queryClient.invalidateQueries({ queryKey: ['configIa'] });
        return;
      }
      if (err instanceof FirebaseError || err instanceof z.ZodError) {
        notifications.show({ color: 'red', title: 'Falha ao salvar', message: err.message });
        return;
      }
      throw err;
    },
  });

  if (cfgQuery.isLoading) return <Loader size="sm" />;
  if (cfgQuery.isError) {
    return (
      <Alert color="red" title="Falha ao carregar a configuração de IA">
        {cfgQuery.error instanceof Error ? cfgQuery.error.message : 'Erro desconhecido'}
      </Alert>
    );
  }

  const lista = modelosQuery.data;
  // Always include the stored value, even when the provider does not list it —
  // otherwise a Select silently blanks a real setting and the operator cannot
  // see what is stored, let alone that it is the problem.
  const options = buildOptions(lista?.modelos ?? [], modeloValue);

  return (
    <Stack gap="lg" maw={760}>
      <Stack gap={4}>
        <Title order={4}>{titulo}</Title>
        <Text size="sm" c="dimmed">
          {descricao}
        </Text>
      </Stack>

      {cfg == null && (
        <Alert color="blue" title="Ainda usando os padrões do sistema">
          O documento <Code>configIa/{agenteId}</Code> ainda não existe. Os valores abaixo são os
          padrões; salvar cria o documento.
        </Alert>
      )}

      {!canWrite && (
        <Alert color="yellow" title="Somente leitura">
          Você pode ver estas configurações, mas alterá-las exige a permissão de escrita em
          integrações.
        </Alert>
      )}

      <EfetivoAlert
        lista={lista}
        loading={modelosQuery.isPending && client != null}
        onRetry={modelosRetryable ? modelosRetry.retry : undefined}
        retrying={modelosRetry.retrying}
      />

      <Select
        label="Modelo"
        description={`Vazio = usar o padrão do sistema (${CONFIG_IA_MODELO_PADRAO}).`}
        data={options}
        value={modeloValue === '' ? null : modeloValue}
        onChange={(v) => setModelo(v ?? '')}
        placeholder="Padrão do sistema"
        clearable
        disabled={!canWrite}
        searchable
      />

      <Select
        label="Provedor"
        description="Vertex AI é o único provedor com credencial configurada hoje."
        data={[...PROVEDOR_OPTIONS]}
        value={provedorValue}
        onChange={(v) => setProvedor((v as ProvedorIa | null) ?? PROVEDOR_IA.vertex)}
        allowDeselect={false}
        disabled={!canWrite}
      />

      <Stack gap={6}>
        <Textarea
          label="Instrução do sistema"
          description="Vazio = usar a instrução padrão abaixo, incluindo a regra de omitir o que não for possível determinar."
          placeholder="Instrução padrão do sistema"
          value={promptValue}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={14}
          disabled={!canWrite}
        />
        <PromptPadrao
          texto={lista?.promptPadrao ?? null}
          emUso={promptValue.trim() === ''}
          podeCopiar={canWrite && promptValue.trim() === ''}
          onCopiar={() => setPrompt(lista?.promptPadrao ?? '')}
        />
      </Stack>

      <Group grow align="flex-start">
        <NumberInput
          label="Máximo de tokens na resposta"
          description="A resposta é um JSON pequeno; um limite baixo corta o JSON no meio."
          value={maxTokensValue}
          onChange={(v) => setMaxTokens(typeof v === 'number' ? v : maxTokensValue)}
          min={256}
          max={65_536}
          step={512}
          disabled={!canWrite}
        />
        <NumberInput
          label="Temperatura"
          description="0 = determinístico. Isto é extração de dados, não redação."
          value={temperaturaValue}
          onChange={(v) => setTemperatura(typeof v === 'number' ? v : temperaturaValue)}
          min={0}
          max={2}
          step={0.1}
          decimalScale={1}
          disabled={!canWrite}
        />
      </Group>

      <Switch
        label="Sugestão por IA ativa"
        description="Desligado, o botão de sugestão responde com um aviso e nenhuma chamada é cobrada."
        checked={ativoValue}
        onChange={(e) => setAtivo(e.currentTarget.checked)}
        disabled={!canWrite}
      />

      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          Uma alteração pode levar até {CACHE_TTL_LABEL} para valer em todas as instâncias do
          backend.
        </Text>
        <Button
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!canWrite || !dirty}
        >
          Salvar
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * The shipped system instruction, shown in full.
 *
 * An instruction you cannot read is one you cannot decide to change — and this
 * text carries the anti-hallucination rule ("OMITA a chave de qualquer atributo
 * que você não conseguir determinar"), which is the single most consequential
 * sentence in the whole AI surface.
 *
 * ⚠️ It is NOT auto-filled into the textarea, and that is deliberate rather than
 * lazy. An empty `promptSistema` is stored as `null`, meaning "use whatever the
 * system ships today"; pre-filling would make the first save store a *copy*, and
 * that copy would then be frozen — a later improvement to the shipped wording
 * would silently never reach this tenant. The button makes taking the copy an
 * explicit choice, which is the same click's worth of effort with none of the
 * silent consequence.
 */
function PromptPadrao({
  texto,
  emUso,
  podeCopiar,
  onCopiar,
}: {
  texto: string | null;
  emUso: boolean;
  podeCopiar: boolean;
  onCopiar: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  if (texto == null) return null;

  return (
    <Stack gap={4}>
      <Group gap="sm">
        <Anchor component="button" type="button" size="xs" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Ocultar instrução padrão' : 'Ver instrução padrão do sistema'}
        </Anchor>
        {emUso && (
          <Badge size="xs" variant="light" color="green">
            em uso
          </Badge>
        )}
        {podeCopiar && (
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={onCopiar}>
            copiar para o campo e editar
          </Anchor>
        )}
      </Group>
      {aberto && (
        <Paper withBorder p="xs" bg="var(--mantine-color-default-hover)">
          <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
            {texto}
          </Text>
        </Paper>
      )}
    </Stack>
  );
}

/**
 * What a suggestion would actually use, and why.
 *
 * The `env` case is the one this exists for: a backend environment variable
 * overrides the dropdown and the operator has no other way to find out. Showing
 * the stored value alone would be a lie of omission.
 */
function EfetivoAlert({
  lista,
  loading,
  onRetry,
  retrying,
}: {
  onRetry?: () => void;
  retrying?: boolean;
  lista:
    | {
        fonte: 'live' | 'fallback';
        erro?: string;
        efetivo: { modelo: string; substituido: boolean; origem: 'config' | 'env' | 'padrao' };
      }
    | undefined;
  loading: boolean;
}) {
  if (loading) return <Loader size="xs" />;
  if (!lista) {
    return (
      <RetryAlert
        color="gray"
        title="Não foi possível consultar o backend do Mercado Livre"
        message="A lista de modelos e o valor em uso não puderam ser lidos. As configurações abaixo ainda podem ser salvas."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }

  const { efetivo } = lista;
  const problema = efetivo.substituido || lista.fonte === 'fallback' || efetivo.origem === 'env';
  return (
    <Alert color={problema ? 'yellow' : 'green'} title="Em uso agora">
      <Stack gap={4}>
        <Group gap="xs">
          <Code>{efetivo.modelo}</Code>
          <Badge variant="light" color={efetivo.origem === 'env' ? 'orange' : 'gray'}>
            {ORIGEM_LABEL[efetivo.origem]}
          </Badge>
        </Group>
        {efetivo.substituido && (
          <Text size="sm">
            O modelo salvo não está disponível no provedor e foi substituído automaticamente.
            Escolha outro para deixar de depender dessa substituição.
          </Text>
        )}
        {efetivo.origem === 'env' && (
          <Text size="sm">
            Há uma variável de ambiente <Code>MERCADO_LIVRE_AI_MODEL</Code> definida no backend. Ela
            tem prioridade sobre o padrão do sistema, mas não sobre a escolha desta tela.
          </Text>
        )}
        {lista.fonte === 'fallback' && (
          <Text size="sm" c="dimmed">
            Mostrando a lista que acompanha o sistema — não foi possível consultar o catálogo do
            provedor{lista.erro ? `: ${lista.erro}` : '.'}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * The Select's options, always including the stored value.
 *
 * A stored model the provider stopped serving must stay visible and selected —
 * a Select that blanks it hides both the setting and the reason the suggestion
 * is behaving unexpectedly.
 */
function buildOptions(
  modelos: readonly { id: string; label: string }[],
  stored: string,
): Array<{ value: string; label: string }> {
  const options = modelos.map((m) => ({ value: m.id, label: m.label }));
  if (stored !== '' && !options.some((o) => o.value === stored)) {
    options.unshift({ value: stored, label: `${stored} (indisponível no provedor)` });
  }
  return options;
}
