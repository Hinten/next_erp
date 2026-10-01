import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="home">
      <h1>Governança</h1>
      <p className="document-intro">
        Informações sobre o uso do Delfrance e o tratamento de dados pessoais.
      </p>
      <div className="document-links">
        <Link href="/termos-de-uso" prefetch={false}>
          <h2>Termos de Uso</h2>
          <p>Condições de acesso, uso responsável e funcionamento do ERP e CRM.</p>
        </Link>
        <Link href="/politica-privacidade" prefetch={false}>
          <h2>Política de Privacidade</h2>
          <p>Dados tratados, finalidades, compartilhamento e direitos dos titulares.</p>
        </Link>
      </div>
      <p>Estes documentos podem ser consultados sem entrar no sistema.</p>
    </div>
  );
}
