/**
 * The price vocabulary: pt-BR for every reason a listing can come back unsent.
 *
 * Moved verbatim out of `precoManual.ts` (which re-exports `mensagemDe`, so no
 * caller changed). The reason for the move is import weight, not tidiness: this
 * table is the repo's registry of the price codes, and the next surface that
 * needs it is an HTTP route. Reaching it through `precoManual.ts` would drag
 * `runPool`, `resolverAnchors` and `fetchPrecoFamiliasByIds` — the whole manual
 * push machinery — into a bundle that only wants a string.
 *
 * ⚠️ The backend owns the WORDING, and that is deliberate. A persisted report
 * row stores the `motivo` code only and the copy is rendered at read time, so
 * fixing a message here applies retroactively to runs already recorded. It is
 * also the convention `envioPrecoListingSchema` already sets in apps/web, where
 * the row carries `mensagem` rather than the reader mapping the code itself.
 */

/**
 * pt-BR for every reason a listing can come back unsent. The manual push is the
 * ONLY surface where these codes reach a human — the bulk job persists them raw
 * in a capped `skips` list — so each one names the cause AND the remedy. A bare
 * `PRECO_NAO_MODIFICAVEL` is not actionable.
 */
export const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  // Plan-time (`buildPrecoDrafts`)
  SEM_LINK: 'Este produto não tem anúncio nesta conta.',
  SEM_ITEM_ID: 'O anúncio ainda não foi publicado no Mercado Livre.',
  AGUARDANDO_MIGRACAO: 'Anúncio em migração para User Products — envio suspenso.',
  PRECO_NAO_ENCONTRADO:
    'O produto não tem preço na tabela normal desta conta. Preencha o preço e tente de novo.',
  FAMILIA_MUITO_GRANDE: 'A família tem variações demais para um único envio.',
  // Send-time (`enviarPrecoDraft`)
  PRECO_ANTIGO_IGUAL: 'O anúncio já está com este preço.',
  PRECO_ANTIGO_MAIOR:
    'Pulado: o preço do ERP é MENOR que o do anúncio. Marque "Permitir baixar preços" para ' +
    'reduzir o preço no Mercado Livre.',
  PRECO_NAO_MODIFICAVEL:
    'O vendedor ativou a automação de preços do Mercado Livre para este anúncio, então o ML ' +
    'recusa preços vindos daqui. Desative a automação no anúncio para voltar a enviar.',
  PRECO_NAO_ATUALIZADO:
    'O Mercado Livre aceitou o envio mas não confirmou o preço novo. Confira o anúncio.',
  CLOSED: 'O anúncio está encerrado no Mercado Livre.',
  FORBIDDEN: 'O anúncio está em revisão e foi bloqueado pelo Mercado Livre.',
  STATUS_desconhecido: 'O Mercado Livre não informou o status deste anúncio.',
  GET_PRODUTO_ERROR: 'Não foi possível ler o anúncio no Mercado Livre.',
  UPDATE_PRECO_ERROR: 'O Mercado Livre recusou o novo preço.',
  // `precoManual.ts`'s own
  NAO_PUBLICADO: 'O produto está oculto (não publicado) no ERP.',
  PRODUTO_NAO_ENCONTRADO: 'Produto não encontrado.',
  FAMILIA_NAO_ENCONTRADA: 'Produto não encontrado ou não é um produto pai.',
  SEM_TABELA_NORMAL: 'A conta não tem tabela de preços normal configurada.',
  CONTA_PAUSADA: 'Não tentado: o Mercado Livre limitou as requisições desta conta.',
  TEMPO_ESGOTADO: 'Não tentado: o tempo do envio se esgotou. Tente com menos produtos.',
  REAUTH: 'Não tentado: a conta precisa ser reconectada ao Mercado Livre.',
  ERRO_CANAL: 'O Mercado Livre não respondeu. Tente novamente.',
  // The account-wide job's reconciliation phase (#1072). The manual push never
  // EMITS them — it reads anchors by key, so it has no unenumerated set — but
  // the table is the repo's registry of the price vocabulary, and a code that
  // is not in it is a code nobody can look up.
  NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO:
    'O anúncio está ativo, mas o produto não registra esta conta — por isso o envio em massa ' +
    'não o alcançou. Envie o preço por aqui, pela tabela de produtos.',
  NAO_ENUMERADO_LINK_EM_VARIACAO:
    'O anúncio está vinculado a uma variação, não ao produto pai. Nenhuma tela consegue enviar ' +
    'preço para ele — corrija o vínculo do anúncio.',
  NAO_ENUMERADO_PAI_ID_INVALIDO:
    'O produto tem um vínculo de pai inválido (nem vazio, nem um produto real), então o envio ' +
    'em massa não o alcança. Corrija o cadastro do produto.',
  NAO_ENUMERADO_PRODUTO_AUSENTE:
    'O anúncio aponta para um produto que não existe mais. Refaça o vínculo ou remova o anúncio.',
  RECONCILIACAO_INCOMPLETA:
    'A conferência de anúncios não enumerados foi interrompida — o relatório está incompleto.',
};

/**
 * `podeEnviarPreco` emits `STATUS_<x>` for any status outside its accept set,
 * so the table above cannot enumerate them — the prefix arm names the status
 * back to the operator instead of falling through to a useless generic.
 */
export function mensagemDe(motivo: string): string {
  const exata = MENSAGEM_POR_MOTIVO[motivo];
  if (exata !== undefined) return exata;
  if (motivo.startsWith('STATUS_')) {
    return `O Mercado Livre não aceita envio de preço para um anúncio "${motivo.slice(7)}".`;
  }
  return 'Não enviado.';
}
