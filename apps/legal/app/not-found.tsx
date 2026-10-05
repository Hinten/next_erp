import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="home">
      <h1>Documento não encontrado</h1>
      <p>Consulte os documentos disponíveis para encontrar a informação que procura.</p>
      <Link href="/" prefetch={false}>
        Ver Governança
      </Link>
    </div>
  );
}
