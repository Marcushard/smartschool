# Sincronizacao SmartSchool para Google Agenda

Este robo entra no SmartSchool duas vezes por dia (as 08h e 20h, horario de Brasilia), le as atividades e provas do Leonardo, e cria os eventos que ainda nao existem na sua Google Agenda. Como a agenda e compartilhada, os eventos aparecem tambem no celular da Camila e do Leonardo.

## O que ja esta pronto

- `sync.mjs`: script que faz o login, le as atividades (Ativ. Assincrona) e as avaliacoes (provas), e cria os eventos no Google.
- `obter-token.mjs`: script para gerar, uma unica vez, a autorizacao do Google.
- `estado.json`: guarda quais eventos ja foram criados, para nao duplicar.
- `workflow-smartschool-sync.yml`: roda tudo automaticamente pelo GitHub, duas vezes por dia.

## O que falta voce fazer (sao passos que so voce consegue completar, pois exigem login na sua conta Google)

### 1. Criar um projeto no Google Cloud e ativar a Calendar API

1. Acesse https://console.cloud.google.com/ e crie um projeto novo (qualquer nome, ex: "Agenda Escola Leonardo").
2. No menu, va em "APIs e servicos" > "Biblioteca", procure "Google Calendar API" e clique em Ativar.
3. Va em "APIs e servicos" > "Tela de consentimento OAuth". Escolha "Externo", preencha nome do app e seu email, e adicione os tres emails (viniciuslomo@gmail.com, camicristine@gmail.com, leo.on0417@gmail.com) como usuarios de teste.
4. Va em "APIs e servicos" > "Credenciais" > "Criar credenciais" > "ID do cliente OAuth". Tipo de aplicativo: "Aplicativo para computador". Anote o Client ID e o Client Secret gerados.

### 2. Gerar o token de acesso (uma vez so)

No seu computador, com Node.js instalado:

```
cd smartschool-sync
npm install
GOOGLE_CLIENT_ID=seu_client_id GOOGLE_CLIENT_SECRET=seu_client_secret node obter-token.mjs
```

Abra o link que aparecer, faca login com **viniciuslomo@gmail.com**, autorize o acesso a agenda. O terminal vai mostrar um `refresh token`. Guarde esse valor.

### 3. Compartilhar a agenda com a Camila e o Leonardo

Na sua conta Google (viniciuslomo@gmail.com):

1. Abra o Google Agenda no navegador.
2. Nas configuracoes da sua agenda principal, va em "Compartilhar com pessoas especificas".
3. Adicione camicristine@gmail.com e leo.on0417@gmail.com com permissao de "Ver todos os detalhes do evento".

### 4. Colocar o codigo no GitHub e configurar os segredos

1. Copie a pasta `smartschool-sync` inteira para dentro do repositorio `mercado.app` (ou peca para eu fazer o push, se me passar um token do GitHub com permissao "repo").
2. Mova o arquivo `workflow-smartschool-sync.yml` para dentro de `.github/workflows/smartschool-sync.yml` no repositorio.
3. No GitHub, va em Settings > Secrets and variables > Actions, e crie estes segredos:
   - `SMARTSCHOOL_LOGIN`: o email de login do SmartSchool
   - `SMARTSCHOOL_SENHA`: a senha do SmartSchool
   - `GOOGLE_CLIENT_ID`: o Client ID do passo 1
   - `GOOGLE_CLIENT_SECRET`: o Client Secret do passo 1
   - `GOOGLE_REFRESH_TOKEN`: o token gerado no passo 2

Pronto. A partir dai o robo roda sozinho duas vezes por dia. Voce tambem pode rodar na hora, manualmente, pela aba "Actions" do GitHub, botao "Run workflow".

## Observacao importante

O SmartSchool nao tem uma API oficial, entao o robo funciona simulando o acesso de um navegador comum. Se a escola mudar o layout do site no futuro, o robo pode parar de encontrar as informacoes certas, e o script precisara de um ajuste pontual.
