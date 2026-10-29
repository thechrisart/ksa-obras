# KSA Grand Construction · Diário de reformas

Cadastro de obras (cliente, cidade, endereço, contato) com fotos e vídeos de **antes, durante e depois** de cada reforma.
Cada obra guarda o valor do trabalho e o material gasto, calcula o investimento total e gera **invoice em PDF** (inglês ou português).

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
5. Em `config.js`, preencha endereço e telefone da empresa (aparecem no invoice) e a moeda, se não for dólar.
6. Em **Project Settings → API** copie a **Project URL** e a chave **anon public** e coloque em [`config.js`](config.js).

A chave "anon public" é feita para ficar no site. Os dados só abrem para quem fizer login, pelas regras do `setup.sql`.
Nunca coloque a chave `service_role` neste repositório.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html`, `style.css`, `app.js` | O site |
| `config.js` | URL e chave pública do Supabase |
| `setup.sql` | Cria tabelas, regras de acesso e o bucket de fotos |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalação como app no celular |

## Fotos e vídeos no Google Drive (opcional)

Com o Drive ligado, cada obra cadastrada ganha uma pasta própria dentro de **KSA Obras** no Google Drive da empresa,
com as subpastas **Antes**, **Durante** e **Depois**. As fotos e vídeos enviados pelo site vão direto para lá.

1. Entre no Google com a conta da empresa e abra **https://script.new**.
2. Dê o nome **KSA Obras Drive**. Apague o que estiver no editor e cole todo o conteúdo de
   [`google-drive/Code.gs`](google-drive/Code.gs). Clique no ícone de salvar.
3. No topo, escolha a função **autorizar** e clique em **Executar** → **Revisar permissões** → escolha a conta da empresa →
   **Avançado** → **Acessar KSA Obras Drive (não seguro)** → **Permitir**. O aviso aparece porque o script é seu e não passou
   pela revisão do Google; é normal.
4. Clique em **Implantar → Nova implantação** → engrenagem → **App da Web**.
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
5. Clique em **Implantar** e copie a **URL do app da Web** (termina em `/exec`). Coloque em `DRIVE_URL` no [`config.js`](config.js).

"Qualquer pessoa" é necessário para o site conseguir chamar o script. O próprio script recusa quem não estiver logado no site.
Os arquivos enviados ficam com "qualquer pessoa com o link pode ver", para o site conseguir mostrar as fotos.
Fotos enviadas antes de ligar o Drive continuam no Supabase.
