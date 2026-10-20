'use client';

import { useMemo, useState } from 'react';
import { Alert, Badge, Group, Paper, Select, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_FRETE, idDoAlvoDoMapaLi, idServicoMelhorEnvioLi } from '@delfrance/schemas';
import { useSectionActive } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import {
  aplicarAlvoLi,
  type AlvoMapaFreteLi,
  type MotivoRecusaAlvoLi,
  type ServicoMelhorEnvioLi,
} from '@/lib/loja-integrada/freteDaConta';
import { FreteDaContaLiAviso } from './FreteDaContaLiAviso';
import { ServicoMelhorEnvioSelect } from './ServicoMelhorEnvioSelect';
import { rotuloAlvoFreteLi, useAlvosMapaFreteLi, type AlvoFreteLi } from './useAlvosMapaFreteLi';
import { intFreteIdDe, useSemearFreteDaContaLi, type FreteDaContaLi } from './useFreteDaContaLi';

/** The "Nenhum" option — clears a row's mapping. */
const NENHUM = '__nenhum__';

const MOTIVO: Record<MotivoRecusaAlvoLi, string> = {
  'tipo-nao-suportado': 'Este destino não pode receber formas de envio da Loja Integrada.',
  'servico-obrigatorio': 'Escolha o serviço do Melhor Envio para concluir.',
  'linha-sem-chave': 'Esta linha não tem identificador e não pode ser mapeada.',
};

function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** `registro` without `chave` — a fresh object, for a state update. */
function semChave<T>(registro: Readonly<Record<string, T>>, chave: string): Record<string, T> {
  const resto = { ...registro };
  delete resto[chave];
  return resto;
}

function textoOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * The stored Melhor Envio service id of a row (`targetData.id`), or `null` — read through the
 * shared `idServicoMelhorEnvioLi`, the one service reader the label route resolves through (and
 * the order importer is to move onto), so a service stored as `3` and one stored as `'3'` show
 * the same service here, and a value it does not read (`'03'`, `0`) shows none. Display only: the
 * write path stores the picked service as is.
 */
function servicoArmazenado(linha: Readonly<Record<string, unknown>>): number | null {
  const id = idServicoMelhorEnvioLi(linha.targetData);
  return id === null ? null : Number(id);
}

export interface MapaFreteManagerProps {
  readonly db: Firestore;
  readonly frete: FreteDaContaLi;
  /** The transient `freteMapa` form value: the doc's `mapa`, RAW as stored. */
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  /** The page's read-only flag (no conta write permission). */
  readonly disabled?: boolean;
}

/**
 * "Mapeamento do Frete" tab of a Loja Integrada conta: one row per shipping
 * method the conta's orders have used (the freight doc's `mapa`), each pointed
 * at the internal freight integration that ships it.
 *
 * - **Rows are never added or removed here.** The order importer registers each
 *   new method; the operator only maps them. A row with no identifier is shown
 *   read-only.
 * - **"Mapped" is decided by the row's `integracaoUid`**, never by its
 *   `targetTipoIntegracao`: `'outros'` is both a real target tipo and the value a
 *   cleared row stores.
 * - **Targets** are the freight integrations of the tipos a Loja Integrada row
 *   may use; a stored target that is inactive, deleted or of an unsupported tipo
 *   is still named, never dropped.
 * - **Melhor Envio** needs the service too: picking a Melhor Envio account only
 *   STAGES it on the row's screen, and the row changes when a service is picked.
 * - **Editable** only with BOTH the conta's write permission (the page's save)
 *   and `PERM.frete.write` (the freight doc's rules), and only once the doc is
 *   loaded from the server.
 *
 * Edits stay in the form; the conta's "Salvar" writes them (see
 * `escritasFreteDaContaLi`).
 */
export function MapaFreteManager({ db, frete, value, onChange, disabled }: MapaFreteManagerProps) {
  const { allowed: podeEscreverFrete } = usePermission(PERM.frete.write);
  const semente = useSemearFreteDaContaLi(db, intFreteIdDe(frete));

  // Latch: the tab is mounted from page load; read the targets, and each stored
  // Melhor Envio row's services, once it is opened.
  const sectionActive = useSectionActive();
  const [aberto, setAberto] = useState(false);
  if (sectionActive !== false && !aberto) setAberto(true);

  const linhas: readonly unknown[] | null = Array.isArray(value) ? value : null;
  const idsArmazenados = useMemo(
    () =>
      (linhas ?? [])
        .map((l) => idDoAlvoDoMapaLi(comoObjeto(l)?.integracaoUid))
        .filter((id): id is string => id !== null),
    [linhas],
  );
  const pronto = frete.estado === 'encontrado' && semente.ready;
  const alvos = useAlvosMapaFreteLi(db, idsArmazenados, aberto && pronto);

  // A Melhor Envio account picked for a row, awaiting its service — keyed by
  // the row's `idOriginal` (rows are never reordered or removed here).
  const [pendentes, setPendentes] = useState<Readonly<Record<string, string>>>({});
  const [recusas, setRecusas] = useState<Readonly<Record<string, MotivoRecusaAlvoLi>>>({});

  const editavel =
    !disabled && podeEscreverFrete && pronto && frete.estado === 'encontrado' && frete.naConsulta;

  function aplicar(indice: number, chave: string, alvo: AlvoMapaFreteLi | null) {
    const atual = comoObjeto(linhas?.[indice]);
    if (linhas === null || atual === null) return;
    const resultado = aplicarAlvoLi(atual, alvo);
    if (!resultado.ok) {
      setRecusas((r) => ({ ...r, [chave]: resultado.motivo }));
      return;
    }
    setRecusas((r) => semChave(r, chave));
    setPendentes((p) => semChave(p, chave));
    onChange(linhas.map((l, i) => (i === indice ? resultado.linha : l)));
  }

  return (
    <Stack>
      <FreteDaContaLiAviso frete={frete} semente={semente} />
      {pronto && !podeEscreverFrete && !disabled && (
        <Text size="sm" c="dimmed">
          Somente leitura: editar o mapeamento exige permissão de escrita nas integrações de frete.
        </Text>
      )}
      {pronto && alvos.erro !== null && (
        <Alert color="red" title="Falha ao carregar os destinos">
          {alvos.erro.message}
        </Alert>
      )}
      {pronto && value !== null && linhas === null && (
        <Alert color="orange" title="Mapeamento em formato inesperado">
          O mapeamento salvo nesta conta não é uma lista e não pode ser editado aqui. Ele é mantido
          como está.
        </Alert>
      )}
      {pronto && (value === null || linhas?.length === 0) && (
        <Text size="sm" c="dimmed">
          Nenhuma forma de envio registrada ainda. Cada forma de envio aparece aqui quando um pedido
          da Loja Integrada a usa pela primeira vez.
        </Text>
      )}
      {pronto &&
        linhas?.map((elemento, indice) => (
          <LinhaDoMapa
            // Rows are never reordered or removed here, so the index is stable.
            key={indice}
            indice={indice}
            elemento={elemento}
            alvos={alvos.alvos}
            armazenados={alvos.armazenados}
            carregandoAlvos={alvos.carregando}
            aberto={aberto}
            editavel={editavel}
            pendentes={pendentes}
            recusas={recusas}
            onPendente={(chave, alvoId) => {
              setRecusas((r) => semChave(r, chave));
              setPendentes((p) =>
                alvoId === null ? semChave(p, chave) : { ...p, [chave]: alvoId },
              );
            }}
            onAplicar={(chave, alvo) => aplicar(indice, chave, alvo)}
          />
        ))}
    </Stack>
  );
}

interface LinhaDoMapaProps {
  readonly indice: number;
  readonly elemento: unknown;
  readonly alvos: readonly AlvoFreteLi[];
  readonly armazenados: ReadonlyMap<string, AlvoFreteLi | null>;
  readonly carregandoAlvos: boolean;
  /** The tab has been opened: the service list may be read. */
  readonly aberto: boolean;
  readonly editavel: boolean;
  readonly pendentes: Readonly<Record<string, string>>;
  readonly recusas: Readonly<Record<string, MotivoRecusaAlvoLi>>;
  readonly onPendente: (chave: string, alvoId: string | null) => void;
  readonly onAplicar: (chave: string, alvo: AlvoMapaFreteLi | null) => void;
}

function LinhaDoMapa({
  indice,
  elemento,
  alvos,
  armazenados,
  carregandoAlvos,
  aberto,
  editavel,
  pendentes,
  recusas,
  onPendente,
  onAplicar,
}: LinhaDoMapaProps) {
  const linha = comoObjeto(elemento);
  const numero = indice + 1;
  if (linha === null) {
    return (
      <Paper withBorder p="sm" data-testid={`mapa-frete-linha-${indice}`}>
        <Text size="sm" c="dimmed">
          Linha {numero}: registro em formato inesperado (mantido como está).
        </Text>
      </Paper>
    );
  }

  const chave = textoOuNull(linha.idOriginal);
  const alvoArmazenadoId = idDoAlvoDoMapaLi(linha.integracaoUid);
  const mapeada = alvoArmazenadoId !== null;
  const pendenteId = chave === null ? undefined : pendentes[chave];
  const escolhidoId = pendenteId ?? alvoArmazenadoId;

  // The choosable targets: the active ones of a supported tipo, plus the stored
  // one whatever its state, so a stored mapping is always named.
  const opcoes: { value: string; label: string }[] = [{ value: NENHUM, label: 'Nenhum' }];
  for (const alvo of alvos) {
    if (alvo.ativo && alvo.suportado)
      opcoes.push({ value: alvo.id, label: rotuloAlvoFreteLi(alvo) });
  }
  if (alvoArmazenadoId !== null && !opcoes.some((o) => o.value === alvoArmazenadoId)) {
    const armazenado = armazenados.get(alvoArmazenadoId);
    const nome = textoOuNull(linha.nomeTarget) ?? alvoArmazenadoId;
    let rotulo: string;
    if (armazenado === undefined) rotulo = carregandoAlvos ? nome : `${nome} (não encontrada)`;
    else if (armazenado === null) rotulo = `${nome} (excluída)`;
    else if (!armazenado.suportado) rotulo = `${rotuloAlvoFreteLi(armazenado)} — não suportado`;
    else if (!armazenado.ativo) rotulo = `${rotuloAlvoFreteLi(armazenado)} (inativa)`;
    else rotulo = rotuloAlvoFreteLi(armazenado);
    opcoes.push({ value: alvoArmazenadoId, label: rotulo });
  }

  const tipoDe = (id: string | null): string | null => {
    if (id === null) return null;
    const alvo = alvos.find((a) => a.id === id) ?? armazenados.get(id) ?? null;
    if (alvo !== null) return alvo.tipo;
    // Not resolved (yet): the stored row still knows the tipo it was mapped to.
    return id === alvoArmazenadoId ? textoOuNull(linha.targetTipoIntegracao) : null;
  };
  const tipoEscolhido = tipoDe(escolhidoId);
  const recusa = chave === null ? undefined : recusas[chave];

  return (
    <Paper withBorder p="sm" data-testid={`mapa-frete-linha-${indice}`}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={500} style={{ overflowWrap: 'anywhere' }}>
              {textoOuNull(linha.nomeOriginal) ?? chave ?? `Forma de envio ${numero}`}
            </Text>
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {chave === null ? 'Sem identificador' : `Identificador: ${chave}`}
            </Text>
            {textoOuNull(linha.observacao) !== null && (
              <Text size="xs" c="dimmed">
                {textoOuNull(linha.observacao)}
              </Text>
            )}
          </Stack>
          {mapeada ? (
            <Badge color="green" variant="light">
              Mapeada
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Sem mapeamento
            </Badge>
          )}
        </Group>
        <Select
          label={`Destino da forma de envio ${numero}`}
          data={opcoes}
          value={escolhidoId ?? NENHUM}
          onChange={(v) => {
            if (chave === null) return;
            if (v === null || v === NENHUM) {
              onPendente(chave, null);
              onAplicar(chave, null);
              return;
            }
            if (v === alvoArmazenadoId) {
              onPendente(chave, null);
              return;
            }
            const tipo = tipoDe(v);
            if (tipo === INTEGRACAO_FRETE.melhorEnvios) {
              onPendente(chave, v);
              return;
            }
            onAplicar(chave, { id: v, tipo: tipo ?? '' });
          }}
          disabled={!editavel || chave === null}
          searchable
          allowDeselect={false}
          nothingFoundMessage="Nenhuma integração de frete encontrada."
        />
        {escolhidoId !== null && tipoEscolhido === INTEGRACAO_FRETE.melhorEnvios && (
          <ServicoMelhorEnvioSelect
            label={`Serviço da forma de envio ${numero}`}
            intFreteId={escolhidoId}
            value={pendenteId === undefined ? servicoArmazenado(linha) : null}
            nomeArmazenado={pendenteId === undefined ? textoOuNull(linha.nomeTarget) : null}
            habilitado={aberto}
            disabled={!editavel || chave === null}
            onChange={(servico: ServicoMelhorEnvioLi) => {
              if (chave === null) return;
              onAplicar(chave, { id: escolhidoId, tipo: INTEGRACAO_FRETE.melhorEnvios, servico });
            }}
          />
        )}
        {pendenteId !== undefined && recusa === undefined && (
          <Text size="xs" c="orange">
            {MOTIVO['servico-obrigatorio']} Até lá, a linha continua como está.
          </Text>
        )}
        {recusa !== undefined && (
          <Text size="xs" c="red">
            {MOTIVO[recusa]}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
