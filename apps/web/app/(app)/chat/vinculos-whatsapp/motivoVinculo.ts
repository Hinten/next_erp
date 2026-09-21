export function motivoVinculo(motivo: string): string {
  const labels: Record<string, string> = {
    sem_cliente: 'Nenhum cliente vinculado',
    sem_vinculo: 'Nenhum cliente vinculado',
    nenhum_cliente: 'Nenhum cliente vinculado',
    ambiguo: 'Mais de um cliente candidato',
    multiplos_clientes: 'Mais de um cliente candidato',
    conflito: 'Identificadores conflitantes',
    identificadores_conflitantes: 'Identificadores conflitantes',
    configuracao: 'Configuração incompleta',
  };
  return labels[motivo] ?? motivo;
}

export function estadoVinculo(estado: 'aguardando' | 'recuperando' | 'resolvido' | 'erro'): string {
  return {
    aguardando: 'Aguardando vínculo',
    recuperando: 'Recuperando mensagens',
    resolvido: 'Vinculado',
    erro: 'Erro na recuperação',
  }[estado];
}
