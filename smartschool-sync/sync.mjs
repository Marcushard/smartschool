import { chromium } from "playwright";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

    const situacao = linha[8] || "";
    const realizada = (linha[11] || "").toLowerCase() === "sim";

    eventos.push({
      id: `ativ-${codigo}`,
      codigo,
      tipo: "atividade",
      titulo: `Entrega de atividade: ${nomeDisciplina(disciplina)}`,
      disciplina: nomeDisciplina(disciplina),
      dataISO: formatarISO(dataEntrega),
      lembretesMinutosAntes: [24 * 60],
      realizada,
      situacao,
    });
  }
  return eventos;
}

async function coletarDetalheAtividade(page, codigo) {
  try {
    await page.evaluate((cod) => {
      document.getElementById(`butDetalhe_${cod}`)?.click();
    }, codigo);
    await page.waitForSelector("#txtDisciplina_PopL_I", { timeout: 4000 });
    await page.waitForTimeout(300);

    const detalhe = await page.evaluate(() => {
      const val = (id) => document.getElementById(id)?.value || "";
      const conteudoEl = document.getElementById("rpContLicaoCasa_PopL_RPC");
      return {
        professor: val("txtProfessor_PopL_I"),
        tipoEntrega: val("txtTipoEntrega_PopL_I"),
        trabalho: val("txtTrabalho_PopL_I"),
        conteudo: conteudoEl ? conteudoEl.innerText.trim() : "",
      };
    });

    await page.evaluate(() => {
      document.querySelector(".dxpc-closeBtn")?.click();
    });
    await page.waitForTimeout(300);
    return detalhe;
  } catch (e) {
    console.error(`Nao consegui abrir detalhe da atividade ${codigo}:`, e.message);
    return null;
  }
}

async function coletarComunicados(page) {
  await page.goto("https://smartschoolweb.com.br/SmartSchoolWeb/Comunicado/IdxComunicado", {
    waitUntil: "networkidle",
  });
  const linhas = await page
    .$eval("#gvListaComunicado_DXMainTable", (tabela) =>
      Array.from(tabela.rows).map((r) => Array.from(r.cells).map((c) => c.innerText.trim()))
    )
    .catch(() => []);

  const anoAtual = new Date().getFullYear();
  const itens = [];
  for (const linha of linhas) {
    const titulo = linha[1];
    const dataTexto = linha[2];
    if (!titulo || !dataTexto || titulo === "Comunicado") continue;
    const data = parseDataCurta(dataTexto, anoAtual);
    itens.push({
      id: `com-${chaveUnica(titulo + dataTexto)}`,
      tipo: "comunicado",
      titulo,
      dataISO: data ? formatarISO(data) : null,
    });
  }
  return itens;
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
      disciplina,
      nomeAvaliacao: titulo,
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

const DIAS_SEMANA = ["domingo", "segunda-feira", "terca-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sabado"];
const MESES_NOME = ["janeiro","fevereiro","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

function formatarDataLonga(dataISO) {
  if (!dataISO) return "";
  const [ano, mes, dia] = dataISO.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return `${dia} de ${MESES_NOME[mes - 1]}`;
}

function diasRestantes(dataISO) {
  if (!dataISO) return null;
  const hoje = new Date();
  const hojeISO = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()));
  const [ano, mes, dia] = dataISO.split("-").map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1, dia));
  return Math.round((alvo - hojeISO) / 86400000);
}

function rotuloPrazo(dataISO) {
  const d = diasRestantes(dataISO);
  if (d === null) return "";
  if (d < 0) return `atrasado ha ${Math.abs(d)} dia(s)`;
  if (d === 0) return "e para hoje";
  if (d === 1) return "e para amanha";
  return `faltam ${d} dias`;
}

function escapeHTML(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function cartaoAtividade(a, idx) {
  const urgente = diasRestantes(a.dataISO) !== null && diasRestantes(a.dataISO) <= 1;
  const modalId = `modal-ativ-${idx}`;
  return `
    <div class="cartao clicavel ${urgente ? "urgente" : ""} ${a.realizada ? "feito" : ""}" onclick="document.getElementById('${modalId}').classList.add('aberto')">
      <div class="cartao-topo">
        <span class="tag">${escapeHTML(a.disciplina)}</span>
        ${a.realizada ? '<span class="selo ok">Feita</span>' : ""}
      </div>
      <div class="cartao-data">${formatarDataLonga(a.dataISO)} - ${rotuloPrazo(a.dataISO)}</div>
      ${a.tipoEntrega ? `<div class="cartao-rodape">${escapeHTML(a.tipoEntrega)}</div>` : ""}
    </div>
    <div class="modal-fundo" id="${modalId}" onclick="if(event.target===this) this.classList.remove('aberto')">
      <div class="modal-caixa">
        <div class="modal-fechar" onclick="document.getElementById('${modalId}').classList.remove('aberto')">&times;</div>
        <h3>${escapeHTML(a.disciplina)}</h3>
        <div class="modal-linha"><b>Entrega:</b> ${formatarDataLonga(a.dataISO)} (${rotuloPrazo(a.dataISO)})</div>
        ${a.professor ? `<div class="modal-linha"><b>Professor:</b> ${escapeHTML(a.professor)}</div>` : ""}
        ${a.tipoEntrega ? `<div class="modal-linha"><b>Onde fazer:</b> ${escapeHTML(a.tipoEntrega)}</div>` : ""}
        ${a.trabalho ? `<div class="modal-linha"><b>E trabalho valendo nota:</b> ${escapeHTML(a.trabalho)}</div>` : ""}
        ${a.conteudo ? `<div class="modal-conteudo">${escapeHTML(a.conteudo).replace(/\n/g, "<br>")}</div>` : '<div class="modal-conteudo vazio">O professor nao escreveu detalhes adicionais para esta atividade.</div>'}
      </div>
    </div>`;
}

function cartaoAvaliacao(a) {
  return `
    <div class="cartao prova">
      <div class="cartao-topo">
        <span class="tag prova-tag">${escapeHTML(a.disciplina)}</span>
      </div>
      <div class="cartao-titulo">${escapeHTML(a.nomeAvaliacao)}</div>
      <div class="cartao-data">${formatarDataLonga(a.dataISO)} - ${rotuloPrazo(a.dataISO)}</div>
    </div>`;
}

function cartaoComunicado(c) {
  return `
    <div class="cartao comunicado">
      <div class="cartao-titulo">${escapeHTML(c.titulo)}</div>
      <div class="cartao-data">${formatarDataLonga(c.dataISO)}</div>
    </div>`;
}

function gerarPainelHTML(dados) {
  const atividadesOrdenadas = [...dados.atividades].sort((a, b) => (a.dataISO || "").localeCompare(b.dataISO || ""));
  const avaliacoesOrdenadas = [...dados.avaliacoes].sort((a, b) => (a.dataISO || "").localeCompare(b.dataISO || ""));
  const comunicadosOrdenados = [...dados.comunicados].sort((a, b) => (b.dataISO || "").localeCompare(a.dataISO || ""));

  const atualizado = new Date(dados.atualizadoEm);
  const atualizadoTexto = atualizado.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel Escola - Leonardo</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #f4f6fb;
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    color: #1f2937;
  }
  .topo { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom: 24px; }
  h1 { font-size: 1.5rem; margin: 0; }
  .atualizado { font-size: 0.8rem; color: #6b7280; }
  h2 { font-size: 1.05rem; margin: 28px 0 12px; color: #374151; }
  .grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .cartao {
    background: white; border-radius: 12px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid #93c5fd;
  }
  .cartao.urgente { border-left-color: #f87171; background: #fff7f7; }
  .cartao.feito { opacity: 0.55; }
  .cartao.prova { border-left-color: #a78bfa; }
  .cartao.comunicado { border-left-color: #34d399; }
  .cartao-topo { display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px; }
  .tag { font-size: 0.72rem; font-weight: 600; color: #1d4ed8; background:#dbeafe; padding: 2px 8px; border-radius: 999px; }
  .prova-tag { color:#6d28d9; background:#ede9fe; }
  .selo.ok { font-size: 0.7rem; background:#d1fae5; color:#065f46; padding:2px 8px; border-radius:999px; }
  .cartao-titulo { font-weight: 600; margin-bottom: 4px; font-size: 0.92rem; }
  .cartao-data { font-size: 0.8rem; color: #6b7280; }
  .cartao-rodape { margin-top:6px; font-size:0.72rem; color:#9ca3af; }
  .vazio { color:#9ca3af; font-size:0.9rem; }
  .clicavel { cursor: pointer; transition: transform 0.1s; }
  .clicavel:hover { transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,0.12); }
  .modal-fundo {
    display:none; position:fixed; inset:0; background:rgba(17,24,39,0.45);
    align-items:center; justify-content:center; padding:20px; z-index:50;
  }
  .modal-fundo.aberto { display:flex; }
  .modal-caixa {
    background:white; border-radius:14px; padding:22px; max-width:480px; width:100%;
    max-height:80vh; overflow-y:auto; position:relative; box-shadow:0 10px 30px rgba(0,0,0,0.25);
  }
  .modal-caixa h3 { margin:0 0 12px; font-size:1.1rem; }
  .modal-fechar { position:absolute; top:14px; right:18px; cursor:pointer; font-size:1.3rem; color:#9ca3af; }
  .modal-linha { font-size:0.88rem; margin-bottom:8px; color:#374151; }
  .modal-conteudo { margin-top:12px; padding-top:12px; border-top:1px solid #e5e7eb; font-size:0.86rem; color:#374151; white-space:normal; }
  .modal-conteudo.vazio { color:#9ca3af; font-style:italic; }
</style>
</head>
<body>
  <div class="topo">
    <h1>Painel Escola - Leonardo</h1>
    <div class="atualizado">Atualizado em ${atualizadoTexto}</div>
  </div>

  <h2>Tarefas pendentes</h2>
  <div class="grade">
    ${atividadesOrdenadas.filter(a => !a.realizada).map((a,i) => cartaoAtividade(a, "p"+i)).join("") || '<div class="vazio">Nenhuma tarefa pendente.</div>'}
  </div>

  <h2>Provas</h2>
  <div class="grade">
    ${avaliacoesOrdenadas.map(cartaoAvaliacao).join("") || '<div class="vazio">Nenhuma prova futura cadastrada ainda.</div>'}
  </div>

  <h2>Comunicados recentes</h2>
  <div class="grade">
    ${comunicadosOrdenados.map(cartaoComunicado).join("") || '<div class="vazio">Nenhum comunicado.</div>'}
  </div>

  <h2>Tarefas ja entregues</h2>
  <div class="grade">
    ${atividadesOrdenadas.filter(a => a.realizada).map((a,i) => cartaoAtividade(a, "f"+i)).join("") || '<div class="vazio">Nenhuma ainda.</div>'}
  </div>
</body>
</html>`;
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

  console.log("Lendo detalhes de cada atividade...");
  for (const a of atividades) {
    const detalhe = await coletarDetalheAtividade(page, a.codigo);
    if (detalhe) Object.assign(a, detalhe);
  }

  console.log("Lendo avaliações...");
  const avaliacoes = await coletarAvaliacoes(page);

  console.log("Lendo comunicados...");
  const comunicados = await coletarComunicados(page);

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

  const dados = {
    atualizadoEm: new Date().toISOString(),
    atividades,
    avaliacoes,
    comunicados,
  };
  writeFileSync(new URL("./dados.json", import.meta.url), JSON.stringify(dados, null, 2) + "\n");

  const pastaDocs = new URL("../docs/", import.meta.url);
  mkdirSync(pastaDocs, { recursive: true });
  writeFileSync(new URL("./index.html", pastaDocs), gerarPainelHTML(dados));

  console.log(`Concluido. ${novos} evento(s) novo(s) de ${todosEventos.length} encontrados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
