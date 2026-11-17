'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import { ZodError } from 'zod';
import { docIdDaMarcaShopee, type MarcaDaContaShopee, type MarcaDto } from '@delfrance/schemas';
import { useObjectViewTransactionDocuments } from '@delfrance/ui';
import { useMarcasShopee, type MarcasShopeeLidas } from '@/lib/shopee/marcas';
import {
  CAMPO_MARCAS_SHOPEE,
  FRASE_MARCAS_CARREGANDO_SHOPEE,
  adicionarMarcasShopee,
  ajustesDasBaselinesMarcasShopee,
  cadastrosJaGravadosMarcasShopee,
  caminhoDoRegistroMarcaShopee,
  desfazerAdicaoMarcaShopee,
  desfazerRemocaoMarcaShopee,
  lerAlteracoesMarcasShopee,
  ocupantesDosRegistrosMarcasShopee,
  remocoesJaFeitasMarcasShopee,
  removerMarcaShopee,
  type AlteracoesMarcasShopee,
  type OcupanteDoRegistroMarcaShopee,
} from '@/lib/shopee/marcasDaConta';

import { AdicionarMarcasShopeeModal } from './AdicionarMarcasShopeeModal';

/**
 * The «Marcas» section of `/canais/shopee/[id]` — the conta's brand SHORTLIST
 * (`integracao/{id}/brandshopee`, #1911 D10), the brands a listing's brand
 * picker offers without waiting on Shopee's slow brand API.
 *
 * ## The form value is the staged DELTA, never the list
 *
 * `value` is the transient field `marcasShopee`: `null` while nothing is
 * staged, else `{adicionar, remover}` — built and undone ONLY through
 * `lib/shopee/marcasDaConta.ts`, the module the conta's save turns into its
 * sibling writes. Undoing the last staged item gives `null` back, so the form
 * is pristine again: an untouched section never writes.
 *
 * Removal is STAGED (`apps/web` rule 7): the row stays, dimmed, «Será removida»
 * with «Desfazer», and nothing is deleted until «Salvar alterações». Every
 * staged item stays on screen with its undo — a brand staged for removal that
 * left the list meanwhile keeps a line of its own — so the form can never stay
 * dirty over a change the operator cannot see.
 *
 * ## The baselines: one per DOCUMENT, from server truth only
 *
 * Each `brandshopee` document gets its own ObjectView baseline, seeded from the
 * first SERVER snapshot that shows it (`fromCache === false`, no pending
 * writes). A held ROW is never moved to newer content by a later emission, so
 * a row another operator changed after that is the save's conflict, never
 * silently the new truth. A row that first appears in a LATER server snapshot
 * (another operator registered it) gets its own baseline then — unless it sits
 * at the id of a registration staged HERE, which waits until that registration
 * leaves the stage (otherwise the save would overwrite it unguarded).
 *
 * What a later server snapshot DOES move is a path's EXISTENCE
 * (`ajustesDasBaselinesMarcasShopee`, `lib/shopee/marcasDaConta.ts`): a held
 * row the snapshot no longer lists becomes "absent", and a held "absent" it
 * lists again becomes its row — each with the exception that keeps a staged
 * change's conflict. A stale existence is a write `saveRecord` skips without
 * re-reading it: a re-add of a brand another tab deleted, or a removal of a doc
 * re-created at a path this tab deleted, would otherwise be dropped in silence
 * (#1911 batch-B review R1-rule7#1).
 *
 * Until the first server snapshot has been read the section is read-only, and
 * says why: a change staged from a cached list would have nothing to be guarded
 * by. After it, the section LISTS and STAGES from the last server snapshot —
 * the one its baselines were moved by — never from a later cached emission: a
 * cached list that dropped a brand would offer it for a re-add the save skips
 * unread (its baseline still that brand's row), and one that shows a doc
 * re-created where this tab deleted one would offer a removal the save skips
 * as "already gone" (#2084 review F1). A cached emission therefore changes
 * nothing here; the next server one does.
 *
 * A staged registration or removal the registry comes to hold as already
 * done — a registration held as stored EXACTLY, a removal with EVERY document
 * held absent (the conflict modal's "Salvar mesmo assim" over another
 * operator's identical row, or over a removal another tab already did) —
 * leaves the delta at once, before the save reads the form
 * (`cadastrosJaGravadosMarcasShopee`, #2084 review F2;
 * `remocoesJaFeitasMarcasShopee`, its removal mirror).
 *
 * ## Identity is the integer `brand_id`
 *
 * Rows come from `marcasDaContaShopee` (`@delfrance/schemas`, THE reader, via
 * `useMarcasShopee`): duplicate legacy documents of one brand are ONE row
 * ("(N registros)") whose removal deletes all of them; two brands with the same
 * name are two rows. Rows that are not a readable brand (unreadable, or a stored
 * «Sem marca») are counted under the list, never shown as brands.
 *
 * Removing needs `PERM.integracao.delete` (the generated rules' delete bit for
 * `brandshopee`): without it there is no «Remover» button at all.
 */
export interface MarcasShopeeManagerProps {
  db: Firestore;
  integracaoId: string;
  /** The transient form value: the staged delta, or `null`. */
  value: unknown;
  onChange: (next: AlteracoesMarcasShopee | null) => void;
  /** The form is read-only (no `PERM.integracao.write`). */
  disabled?: boolean;
  /** `PERM.integracao.delete`. */
  podeRemover: boolean;
}

/** "Nike · id 1001" or "Marca sem nome (id 7)", plus "(N registros)" for legacy duplicates. */
export function rotuloDaMarcaCadastrada(m: MarcaDaContaShopee): string {
  const nome =
    m.originalBrandName === null && m.displayBrandName === null
      ? `Marca sem nome (id ${String(m.brandId)})`
      : `${m.rotulo} · id ${String(m.brandId)}`;
  return m.docIds.length > 1 ? `${nome} (${String(m.docIds.length)} registros)` : nome;
}

function rotuloDaMarcaNova(dto: MarcaDto): string {
  return `${dto.originalBrandName} · id ${String(dto.brandId)}`;
}

/** The staged delta, or the refusal when the form holds something that is not one. */
function lerDelta(value: unknown): {
  alteracoes: AlteracoesMarcasShopee | null;
  invalida: boolean;
} {
  try {
    return { alteracoes: lerAlteracoesMarcasShopee(value), invalida: false };
  } catch (err) {
    if (err instanceof ZodError) return { alteracoes: null, invalida: true };
    throw err;
  }
}

export function MarcasShopeeManager({
  db,
  integracaoId,
  value,
  onChange,
  disabled = false,
  podeRemover,
}: MarcasShopeeManagerProps) {
  const lista = useMarcasShopee(db, integracaoId);
  const documents = useObjectViewTransactionDocuments();
  const [modalAberto, setModalAberto] = useState(false);

  // The last SERVER-truth reading of THIS conta (`fromCache === false`, no
  // pending writes): what the baselines are moved by, so what the section
  // lists and stages from. Kept across a later cached emission, which is never
  // a reason to move a baseline — so never one to stage from either (#2084
  // review F1). Remembered here, as React's "state from the previous render":
  // `useMarcasShopee` hands back ONE reading per emission, so this updates
  // once per server emission.
  const daServidor =
    lista.documentos !== undefined && lista.fromCache === false && !lista.hasPendingWrites;
  const [ultimaDoServidor, setUltimaDoServidor] = useState<{
    readonly integracaoId: string;
    readonly lida: MarcasShopeeLidas;
  } | null>(null);
  if (
    daServidor &&
    (ultimaDoServidor?.lida !== lista || ultimaDoServidor.integracaoId !== integracaoId)
  )
    setUltimaDoServidor({ integracaoId, lida: lista });
  const servidor: MarcasShopeeLidas | undefined = daServidor
    ? lista
    : ultimaDoServidor?.integracaoId === integracaoId
      ? ultimaDoServidor.lida
      : undefined;
  /** What the section shows: server truth once read; before it, the cached list, read-only. */
  const exibida = servidor ?? lista;

  const { alteracoes, invalida } = lerDelta(value);
  const adicionadas = alteracoes?.adicionar ?? [];
  const remocoes = alteracoes?.remover ?? [];
  // Every path this section may hold a baseline for: listed by a server
  // snapshot, or written by a staged registration (its commit leaves the row's
  // baseline even when no snapshot ever listed it). The registry cannot be
  // enumerated, and a held path a snapshot stops listing must be found again.
  const conhecidos = useRef(new Set<string>());

  // The baselines, from server truth (`ajustesDasBaselinesMarcasShopee`): a
  // path's first row, and its existence as each server snapshot says — never a
  // held row moved to newer content.
  //
  // ⚠️ A document at the id a STAGED registration will write (another operator
  // registered the same brand while this one was staged) stays unseeded while
  // that registration is staged. A baseline held for it would guard the
  // registration's `set` with the very row it overwrites — a silent lost
  // update; unseeded, the save raises the conflict instead. Once the
  // registration leaves the stage (undone, or dropped by the conflict's
  // "Recarregar"), the next run seeds it like any other row — hence `value`
  // in the deps: unstaging a change re-runs this against the last SERVER
  // snapshot, even while the latest emission is a cached one (#2084 review F1).
  const { error } = lista;
  const listadosNoServidor = servidor?.documentos;
  useEffect(() => {
    if (!documents || error || listadosNoServidor === undefined) return;
    const delta = lerDelta(value).alteracoes;
    const caminho = (docId: string) => caminhoDoRegistroMarcaShopee(db, integracaoId, docId);
    const caminhosAdicionados = new Set(
      (delta?.adicionar ?? []).map((d) => caminho(docIdDaMarcaShopee(d.brandId))),
    );
    const caminhosRemovidos = new Set((delta?.remover ?? []).flatMap((r) => r.docIds.map(caminho)));
    for (const path of caminhosAdicionados) conhecidos.current.add(path);
    for (const doc of listadosNoServidor) conhecidos.current.add(doc.path);
    const ajustes = ajustesDasBaselinesMarcasShopee({
      listados: listadosNoServidor,
      conhecidos: conhecidos.current,
      guardada: (path) => documents.getBaseline(path),
      caminhosAdicionados,
      caminhosRemovidos,
    });
    for (const ajuste of ajustes) {
      if (ajuste.tipo === 'semear') documents.seedBaseline(ajuste.path, ajuste.data);
      else documents.rebase(ajuste.path, ajuste.data);
    }
    // The section's "server truth read" mark — nothing is staged at load.
    documents.seedFormField(CAMPO_MARCAS_SHOPEE, null);
  }, [db, integracaoId, documents, error, listadosNoServidor, value]);

  // A staged registration or removal the registry comes to hold as already
  // done leaves the delta: a registration held as stored EXACTLY is satisfied
  // (#2084 review F2), a removal with EVERY document held absent is done (its
  // removal mirror). Both are read against the SAME delta and leave in ONE
  // `onChange`. It must leave INSIDE the registry's notify: "Salvar mesmo
  // assim" rebases the contested path and saves in the same click, and
  // `saveRecord` would skip that `set` or `delete` unread and never project it
  // off the form — so an effect after the render would come too late, after
  // the save had read (and, with another edit, reset the form to) the delta
  // still holding it. The subscription is live while another tab
  // is shown only because the page keeps this tab mounted
  // (`persistentSections`): a hidden `<Activity>` would unmount it, and the
  // "Salvar mesmo assim" clicked from «Dados gerais» would drop nothing.
  // `atuais` carries the latest props into
  // that callback, which runs outside render. It is refreshed in a LAYOUT
  // effect, which runs before every passive effect of the same commit: the
  // seeding run above moves a baseline (and so notifies) in a passive effect,
  // in the very commit that swapped a staged registration for a staged
  // removal of that brand («Remover» on its listed row), and read against the
  // previous render's delta that notify would hand the form the old delta
  // minus the registration — the removal gone, nothing said.
  const atuais = useRef({ db, integracaoId, value, onChange });
  useLayoutEffect(() => {
    atuais.current = { db, integracaoId, value, onChange };
  });
  useEffect(() => {
    if (!documents) return;
    return documents.subscribe(() => {
      const delta = lerDelta(atuais.current.value).alteracoes;
      const satisfeitos = cadastrosJaGravadosMarcasShopee(
        atuais.current.db,
        atuais.current.integracaoId,
        delta,
        documents,
      );
      const feitas = remocoesJaFeitasMarcasShopee(
        atuais.current.db,
        atuais.current.integracaoId,
        delta,
        documents,
      );
      if (satisfeitos.length === 0 && feitas.length === 0) return;
      let proximo: AlteracoesMarcasShopee | null = delta;
      for (const brandId of satisfeitos) proximo = desfazerAdicaoMarcaShopee(proximo, brandId);
      for (const brandId of feitas) proximo = desfazerRemocaoMarcaShopee(proximo, brandId);
      atuais.current = { ...atuais.current, value: proximo };
      atuais.current.onChange(proximo);
    });
  }, [documents]);

  const semeada =
    documents === null || documents.getFormBaseline(CAMPO_MARCAS_SHOPEE) !== undefined;
  const bloqueada = disabled || !semeada;

  const marcas = useMemo(() => exibida.leitura?.marcas ?? [], [exibida.leitura]);
  const porBrandId = useMemo(() => new Map(marcas.map((m) => [m.brandId, m])), [marcas]);
  const porRemocao = new Map(remocoes.map((r) => [r.brandId, r]));
  const removidasForaDaLista = remocoes.filter((r) => !porBrandId.has(r.brandId));

  const ocupantes = useMemo(
    () =>
      exibida.leitura === undefined
        ? new Map<string, OcupanteDoRegistroMarcaShopee>()
        : ocupantesDosRegistrosMarcasShopee(exibida.leitura, rotuloDaMarcaCadastrada),
    [exibida.leitura],
  );
  const outrosRegistros =
    (exibida.leitura?.semMarca.length ?? 0) + (exibida.leitura?.ilegiveis.length ?? 0);

  const adicionar = (dtos: MarcaDto[]) => {
    onChange(adicionarMarcasShopee(value, dtos));
    setModalAberto(false);
  };

  if (lista.error) {
    return (
      <Alert color="red" variant="light" data-testid="shopee-marcas-falha">
        <Text size="sm">
          Não foi possível carregar as marcas desta conta: {lista.error.message}
        </Text>
      </Alert>
    );
  }

  if (invalida) {
    return (
      <Alert color="red" variant="light" data-testid="shopee-marcas-delta-invalido">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm">As alterações de marcas deste formulário são inválidas.</Text>
          <Button size="xs" variant="light" disabled={disabled} onClick={() => onChange(null)}>
            Descartar alterações de marcas
          </Button>
        </Group>
      </Alert>
    );
  }

  return (
    <Stack gap="sm" data-testid="shopee-marcas-manager">
      <Text size="sm" c="dimmed">
        As marcas cadastradas aqui são as oferecidas na escolha de marca dos anúncios desta conta (a
        Shopee demora para listar marcas). «Sem marca» está sempre disponível no anúncio.
      </Text>
      {exibida.truncada && (
        <Alert color="yellow" variant="light" data-testid="shopee-marcas-truncada">
          <Text size="sm">
            {`Mostrando os primeiros ${String(exibida.documentos?.length ?? 0)} registros de marca — pode haver marcas cadastradas que não aparecem aqui.`}
          </Text>
        </Alert>
      )}
      {lista.leitura !== undefined && !semeada && !disabled && (
        <Text size="sm" c="dimmed" data-testid="shopee-marcas-carregando-servidor">
          {FRASE_MARCAS_CARREGANDO_SHOPEE}
        </Text>
      )}
      {!podeRemover && (
        <Text size="sm" c="dimmed" data-testid="shopee-marcas-sem-permissao-remover">
          Remover marcas requer permissão de exclusão em integrações.
        </Text>
      )}

      {exibida.leitura === undefined ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : (
        <Stack gap={6}>
          {adicionadas.map((dto) => (
            <Paper
              key={`nova-${String(dto.brandId)}`}
              withBorder
              p="xs"
              data-testid={`shopee-marca-nova-${String(dto.brandId)}`}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap="xs" wrap="nowrap">
                  <Badge color="green" variant="light" size="sm">
                    Nova
                  </Badge>
                  <Text size="sm">{rotuloDaMarcaNova(dto)}</Text>
                  {porBrandId.has(dto.brandId) && (
                    <Text size="xs" c="orange">
                      já consta na lista — desfaça esta adição
                    </Text>
                  )}
                </Group>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={disabled}
                  onClick={() => onChange(desfazerAdicaoMarcaShopee(value, dto.brandId))}
                >
                  Desfazer
                </Button>
              </Group>
            </Paper>
          ))}

          {marcas.length === 0 && adicionadas.length === 0 && (
            <Text size="sm" c="dimmed" data-testid="shopee-marcas-vazia">
              Nenhuma marca cadastrada nesta conta.
            </Text>
          )}

          {marcas.map((m) => {
            const remocao = porRemocao.get(m.brandId);
            const marcada = remocao !== undefined;
            // A document of this brand that appeared AFTER it was marked (another
            // operator registered it again) is not in the staged removal: the
            // save leaves it, and the brand with it — said here, never only after.
            const novosRegistros =
              remocao === undefined
                ? 0
                : m.docIds.filter((id) => !remocao.docIds.includes(id)).length;
            return (
              <Paper
                key={m.brandId}
                withBorder
                p="xs"
                opacity={marcada ? 0.5 : 1}
                data-testid={`shopee-marca-${String(m.brandId)}`}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Group gap="xs" wrap="nowrap">
                    {marcada && (
                      <Badge color="red" variant="light" size="sm">
                        Será removida
                      </Badge>
                    )}
                    <Text size="sm" td={marcada ? 'line-through' : undefined}>
                      {rotuloDaMarcaCadastrada(m)}
                    </Text>
                  </Group>
                  {marcada ? (
                    <Button
                      size="xs"
                      variant="subtle"
                      disabled={disabled}
                      onClick={() => onChange(desfazerRemocaoMarcaShopee(value, m.brandId))}
                    >
                      Desfazer
                    </Button>
                  ) : (
                    podeRemover && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={bloqueada}
                        onClick={() => onChange(removerMarcaShopee(value, m))}
                      >
                        Remover
                      </Button>
                    )
                  )}
                </Group>
                {novosRegistros > 0 && (
                  <Group
                    gap="xs"
                    wrap="nowrap"
                    mt={4}
                    data-testid={`shopee-marca-registro-novo-${String(m.brandId)}`}
                  >
                    <Text size="xs" c="orange">
                      {`${String(novosRegistros)} registro(s) desta marca apareceram depois de marcá-la e não serão removidos — a marca continuará na lista.`}
                    </Text>
                    {podeRemover && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={bloqueada}
                        onClick={() => onChange(removerMarcaShopee(value, m))}
                      >
                        Incluir na remoção
                      </Button>
                    )}
                  </Group>
                )}
              </Paper>
            );
          })}

          {removidasForaDaLista.map((r) => (
            <Paper
              key={`fora-${String(r.brandId)}`}
              withBorder
              p="xs"
              opacity={0.5}
              data-testid={`shopee-marca-removida-fora-${String(r.brandId)}`}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap="xs" wrap="nowrap">
                  <Badge color="red" variant="light" size="sm">
                    Será removida
                  </Badge>
                  <Text size="sm">
                    {`Marca id ${String(r.brandId)} — não está mais na lista (removida em outra tela?)`}
                  </Text>
                </Group>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={disabled}
                  onClick={() => onChange(desfazerRemocaoMarcaShopee(value, r.brandId))}
                >
                  Desfazer
                </Button>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}

      {outrosRegistros > 0 && (
        <Text size="xs" c="dimmed" data-testid="shopee-marcas-outros-registros">
          {`${String(outrosRegistros)} registro(s) desta lista não são uma marca legível (ilegíveis ou «Sem marca») e não aparecem acima.`}
        </Text>
      )}

      <Group>
        <Button
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={bloqueada}
          onClick={() => setModalAberto(true)}
        >
          Adicionar marcas
        </Button>
      </Group>

      {modalAberto && (
        <AdicionarMarcasShopeeModal
          integracaoId={integracaoId}
          cadastradas={new Set(porBrandId.keys())}
          jaSelecionadas={new Set(adicionadas.map((d) => d.brandId))}
          ocupantes={ocupantes}
          onAdicionar={adicionar}
          onFechar={() => setModalAberto(false)}
        />
      )}
    </Stack>
  );
}
