// Rode este script UMA VEZ na sua maquina para gerar o refresh token do Google.
// Uso: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node obter-token.mjs
import { google } from "googleapis";
import http from "http";
import { URL } from "url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET antes de rodar.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/calendar"],
});

console.log("\nAbra este link no navegador, faca login com a conta Google que vai receber a agenda, e autorize:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  if (!code) {
    res.end("Nenhum codigo recebido. Feche esta aba e tente novamente.");
    return;
  }
  res.end("Autorizado! Pode fechar esta aba e voltar para o terminal.");
  const { tokens } = await oauth2Client.getToken(code);
  console.log("\nSeu REFRESH TOKEN (guarde em local seguro, e o unico que aparece):\n");
  console.log(tokens.refresh_token);
  console.log("\nAdicione esse valor como o secret GOOGLE_REFRESH_TOKEN no GitHub.\n");
  server.close();
  process.exit(0);
});

server.listen(3000, () => {
  console.log("Aguardando autorizacao em http://localhost:3000 ...\n");
});
