# KSA Grand Construction · Diário de reformas

Cadastro de obras (cliente, cidade, endereço, contato) com fotos e vídeos de **antes, durante e depois** de cada reforma.

- Site: https://thechrisart.github.io/ksa-obras/
- Funciona no celular e no computador. No celular dá para instalar na tela inicial:
  - **iPhone (Safari):** botão Compartilhar → "Adicionar à Tela de Início".
  - **Android (Chrome):** menu ⋮ → "Instalar app" ou "Adicionar à tela inicial".

## Configuração (uma vez só)

O site guarda os dados no [Supabase](https://supabase.com), que tem plano gratuito (500 MB de banco e 1 GB de arquivos).

1. Crie uma conta em supabase.com e um projeto novo (ex.: `ksa-obras`). Guarde a senha do banco.
2. Abra **SQL Editor → New query**, cole todo o conteúdo de [`setup.sql`](setup.sql) e clique em **Run**.
3. Em **Authentication → Sign In / Providers**, desligue **Allow new users to sign up**. Assim só entra quem você cadastrar.
4. Em **Authentication → Users → Add user → Create new user**, crie o login de cada pessoa da equipe (e-mail e senha). Marque **Auto Confirm User**.
5. Em **Project Settings → API** copie a **Project URL** e a chave **anon public** e coloque em [`config.js`](config.js).

A chave "anon public" é feita para ficar no site. Os dados só abrem para quem fizer login, pelas regras do `setup.sql`.
Nunca coloque a chave `service_role` neste repositório.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html`, `style.css`, `app.js` | O site |
| `config.js` | URL e chave pública do Supabase |
| `setup.sql` | Cria tabelas, regras de acesso e o bucket de fotos |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalação como app no celular |
