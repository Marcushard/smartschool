import { chromium } from "playwright";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

const LOGIN = process.env.SMARTSCHOOL_LOGIN;
const SENHA = process.env.SMARTSCHOOL_SENHA;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

const ESTADO_PATH = new URL("./estado.json", import.meta.url);

const MESES = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

const NOMES_DISCIPLINA = {
  "Geog": "Geografia",
  "Port": "Lingua Portuguesa",
  "Hist": "Historia",
  "Mat.": "Matematica",
  "Cien": "Ciencias",
  "Ciên": "Ciencias",
  "Ing": "Lingua Inglesa",
  "Arte": "Arte",
  "Ed_Tec": "Educacao Tecnologica",
};

function nomeDisciplina(abrev) {
  return NOMES_DISCIPLINA[abrev] || abrev;
}

function carregarEstado() {
  if (!existsSync(ESTADO_PATH)) return {};
  return JSON.parse(readFileSync(ESTADO_PATH, "utf-8"));
}

function salvarEstado(estado) {
  writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2) + "\n");
}

function chaveUnica(texto) {
  return crypto.createHash("sha1").update(texto).digest("hex").slice(0, 16);
}

// "02 de out sexta-feira" + ano de referencia -> "2026-10-02"
function parseDataCurta(texto, anoReferencia) {
  const m = texto.match(/(\d{1,2})\s+de\s+([a-z]{3})/i);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  return { dia, mes, ano: anoReferencia };
}

function formatarISO({ ano, mes, dia }) {
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

async function login(page) {
  await page.goto("https://smartschoolweb.com.br/SmartSchoolWeb/Conta/Login", {
    waitUntil: "domcontentloaded",
  });
  await page.fill("#ipLogin", LOGIN);
  await page.fill("#ipSenha", SENHA);
  await Promise.all([
    page.waitForLoadState("networkidle"),
    page.click('button[type="submit"]'),
  ]);
  if (page.url().includes("/Conta/Login")) {
    throw new Error("Login no SmartSchool falhou. Confira usuario e senha.");
  }
}

async function coletarAtividades(page) {
  await page.goto("https://smartschoolweb.com.br/SmartSchoolWeb/LicaoCasa/IdxLicaoCasa", {
    waitUntil: "networkidle",
  });
  const linhas = await page.$eval("#gvLicaoCasaAluno_DXMainTable", (tabela) =>
    Array.from(tabela.rows).map((r) => Array.from(r.cells).map((c) => c.innerText.trim()))
  );

  const eventos = [];
  for (const linha of linhas) {
    const codigo = linha[0];
    if (!codigo || !/^\d+$/.test(codigo)) continue; // pula cabecalho/linhas vazias
    const disciplina = linha[1];
    const entregaTexto = linha[4];
    const publicacaoDataHora = linha[13]; // dd/mm/yyyy hh:mm
    const anoPublicacao = publicacaoDataHora
      ? parseInt(publicacaoDataHora.split("/")[2].slice(0, 4), 10)
      : new Date().getFullYear();

    const dataEntrega = parseDataCurta(entregaTexto, anoPublicacao);
    if (!dataEntrega) continue;

    // vira o ano se a entrega parece ser antes da publicacao (virada dez/jan)
    const dataPubMatch = publicacaoDataHora && publicacaoDataHora.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dataPubMatch) {
      const mesPub = parseInt(dataPubMatch[2], 10);
      if (dataEntrega.mes < mesPub - 6) dataEntrega.ano += 1;
    }

    eventos.push({
      id: `ativ-${codigo}`,
      tipo: "atividade",
      titulo: `Entrega de atividade: ${nomeDisciplina(disciplina)}`,
      dataISO: formatarISO(dataEntrega),
      lembretesMinutosAntes: [24 * 60],
    });
  }
  return eventos;
}

async function coletarAvaliacoes(page) {
  await page.goto("https://smartschoolweb.com.br/SmartSchoolWeb/Home/IdxResponsavel", {
    waitUntil: "networkidle",
  });
  await page.click("text=Calendario", { timeout: 5000 }).catch(() => {});
  await page.click("text=Calendário").catch(() => {});
  await page.click("text=Avaliações").catch(() => {});
  await page.waitForTimeout(1500);

  const texto = await page.innerText("body");
  const anoAtual = new Date().getFullYear();
  const eventos = [];

  const regex = /Detalhes\t([^\t\n]+)\t([^\t\n]+)\t(\d{1,2}) de? ?([a-z]{3})[^\n]*/gi;
  let m;
  while ((m = regex.exec(texto)) !== null) {
    const [linhaCompleta, disciplina, titulo, dia, mesAbrev] = m;
    if (/Conclu[ií]da/i.test(linhaCompleta)) continue; // so' futuras
    const mes = MESES[mesAbrev.toLowerCase()];
    if (!mes) continue;
    const chave = chaveUnica(`${disciplina}-${titulo}-${dia}-${mes}`);
    eventos.push({
      id: `aval-${chave}`,
      tipo: "avaliacao",
      titulo: `Prova: ${disciplina} - ${titulo}`,
      dataISO: formatarISO({ ano: anoAtual, mes, dia: parseInt(dia, 10) }),
      lembretesMinutosAntes: [3 * 24 * 60, 24 * 60],
    });
  }
  return eventos;
}

async function criarEventoGoogle(calendar, evento) {
  const [ano, mes, dia] = evento.dataISO.split("-").map(Number);
  const fim = new Date(Date.UTC(ano, mes - 1, dia + 1));
  const fimISO = fim.toISOString().slice(0, 10);

  const resp = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: evento.titulo,
      description: "Sincronizado automaticamente do SmartSchool.",
      start: { date: evento.dataISO },
      end: { date: fimISO },
      reminders: {
        useDefault: false,
        overrides: evento.lembretesMinutosAntes.map((minutos) => ({
          method: "popup",
          minutes: minutos,
        })),
      },
    },
  });
  return resp.data.id;
}

async function main() {
  if (!LOGIN || !SENHA) throw new Error("Faltam SMARTSCHOOL_LOGIN / SMARTSCHOOL_SENHA");
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Faltam credenciais do Google (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)");
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const estado = carregarEstado();

  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log("Entrando no SmartSchool...");
  await login(page);

  console.log("Lendo atividades...");
  const atividades = await coletarAtividades(page);

  console.log("Lendo avaliações...");
  const avaliacoes = await coletarAvaliacoes(page);

  await browser.close();

  const todosEventos = [...atividades, ...avaliacoes];
  let novos = 0;

  for (const evento of todosEventos) {
    if (estado[evento.id]) continue;
    try {
      const googleEventId = await criarEventoGoogle(calendar, evento);
      estado[evento.id] = { googleEventId, criadoEm: new Date().toISOString(), titulo: evento.titulo };
      novos++;
      console.log(`Novo evento criado: ${evento.titulo} (${evento.dataISO})`);
    } catch (e) {
      console.error(`Falha ao criar evento "${evento.titulo}":`, e.message);
    }
  }

  salvarEstado(estado);
  console.log(`Concluido. ${novos} evento(s) novo(s) de ${todosEventos.length} encontrados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
