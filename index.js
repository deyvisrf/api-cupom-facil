const express = require('express');
const { chromium } = require('playwright');
const resolverRecaptcha = require('./resolverCaptcha');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ⏱️ Orçamento de tempo, do mais interno para o mais externo:
//   captcha (120s) + carregamento da página (~10s) + submit/extração (~20s) = ~150s < rota (160s) < frontend (180s)
// Cada camada precisa de folga sobre a de dentro, senão o erro que chega ao usuário é o genérico
// da camada externa em vez da causa real.
const ROUTE_TIMEOUT_MS = 160_000;
//⏱️ limite de espera pela resolução do captcha (a lib do Anti-Captcha não tem timeout interno).
// Medido em produção: token que demora costuma vir de worker degradado e ser recusado pela SEFAZ,
// enquanto token rápido quase sempre passa. Cortar em 30s e pedir outro venceu 4/4 contra 1/4.
const CAPTCHA_TIMEOUT_MS = Number(process.env.CAPTCHA_TIMEOUT_MS) || 30_000;
//🔁 A SEFAZ recusa o token com frequência e, ao recusar, devolve a própria página de consulta
// com HTTP 200. Ciclar tokens é o que sustenta a taxa de sucesso.
const MAX_TENTATIVAS = Number(process.env.MAX_TENTATIVAS) || 5;
// Folga reservada para conseguir responder antes de ROUTE_TIMEOUT_MS estourar
const MARGEM_RESPOSTA_MS = 20_000;
// Abaixo disso não cabe nem a tentativa mais rápida; melhor responder do que começar e ser cortado
const TENTATIVA_MINIMA_MS = 25_000;

const URL_CONSULTA = 'https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx';
// Discriminadores medidos em produção: a tabela de itens só existe no cupom, enquanto a página
// devolvida na recusa mantém o campo da chave e a mensagem de captcha inválido.
const SELETOR_RESULTADO = '#tableItens';
const MSG_CAPTCHA_RECUSADO = 'O texto digitado não confere';
//🔒 número máximo de consultas simultâneas (evita retries gastarem captcha duplicado).
// Cada Chromium consome ~300-500MB: subir isso exige conferir a memória da instância.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
let emAndamento = 0;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// O corte por tempo do captcha é um Promise.race: ele desiste de esperar, mas a solve continua
// rodando no Anti-Captcha e é cobrada do mesmo jeito. Medido localmente: das 5 tasks de uma
// consulta, 5 foram resolvidas e pagas e só 2 chegaram a ser submetidas — as outras 3 chegaram
// depois do corte e foram para o lixo, enquanto a tentativa seguinte abria task nova do zero.
// Guardar a solve pendente faz a próxima tentativa aproveitar o token já pago.
function criarFonteDeToken() {
  let pendente = null;

  return (limiteMs) => {
    if (!pendente) {
      pendente = resolverRecaptcha();
      // Solve que falha de vez não pode ficar grudada envenenando as tentativas seguintes
      pendente.catch(() => { pendente = null; });
    }
    const emCurso = pendente;
    return withTimeout(emCurso, limiteMs, 'Tempo excedido ao resolver o reCAPTCHA.')
      .then((token) => {
        // Token entregue é token consumido; só o abandonado por timeout continua guardado
        if (pendente === emCurso) pendente = null;
        return token;
      });
  };
}

// Deixa a página pronta para submeter: na primeira tentativa é preciso navegar, mas depois de uma
// recusa a SEFAZ devolve o próprio formulário — reaproveitar a página pula o goto, que na rede do
// Railway chega a estourar os 30s e sozinho inviabiliza a tentativa seguinte.
async function prepararPagina(page, chaveAcesso) {
  const jaCarregada = page.url().startsWith(URL_CONSULTA);
  if (!jaCarregada) {
    await page.goto(URL_CONSULTA, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  }

  // O api.js do reCAPTCHA é async/defer: o textarea do token só existe depois do grecaptcha.render(),
  // tanto no primeiro carregamento quanto no re-render que vem junto com a página de recusa.
  try {
    await page.waitForSelector('[name="g-recaptcha-response"]', { state: 'attached', timeout: 15_000 });
  } catch (erro) {
    // Página reaproveitada em estado inesperado: recarrega uma vez antes de desistir
    if (!jaCarregada) throw erro;
    await page.goto(URL_CONSULTA, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[name="g-recaptcha-response"]', { state: 'attached', timeout: 15_000 });
  }

  // (opcional, mas mantido caso o ASP.NET valide)
  await page.$eval('#__VIEWSTATE', el => el.value);
  await page.$eval('#__EVENTVALIDATION', el => el.value);

  await page.fill('#conteudo_txtChaveAcesso', chaveAcesso);
}

// Uma tentativa completa: token novo, submit e verificação do resultado.
// O sucesso é aferido pelo conteúdo, não pelo status: quando a SEFAZ recusa o captcha ela
// responde 200 devolvendo a própria página de consulta.
// Devolve { ok: true, notaHtml } ou { ok: false, motivo }.
async function tentarConsulta(page, chaveAcesso, obterToken, msRestantes) {
  // O captcha não pode consumir todo o tempo restante: ainda é preciso submeter e extrair
  const limiteCaptcha = Math.max(15_000, Math.min(CAPTCHA_TIMEOUT_MS, msRestantes - 30_000));

  await prepararPagina(page, chaveAcesso);

  const captchaToken = await obterToken(limiteCaptcha);

  // Se o campo do reCAPTCHA não existir, o submit iria sem token e a recusa viria
  // silenciosamente — melhor reportar como falha e deixar a retentativa cuidar.
  const tokenAplicado = await page.evaluate((token) => {
      const el = document.querySelector('[name="g-recaptcha-response"]');
      if (!el) return false;
      el.value = token;
    return true;
  }, captchaToken);
  if (!tokenAplicado) return { ok: false, motivo: 'campo g-recaptcha-response ausente na página' };

  // Garante botão habilitado
  await page.evaluate(() => {
    const btn = document.querySelector('#conteudo_btnConsultar');
    if (btn) btn.disabled = false;
  });

  await page.click('#conteudo_btnConsultar');

  // A recusa aparece quase imediatamente. Esperar só pelo seletor do cupom desperdiçaria os
  // 25s inteiros em toda tentativa recusada, então os dois desfechos são observados juntos.
  const desfecho = await page
    .waitForFunction(
      ({ seletor, msg }) => {
        if (document.querySelector(seletor)) return 'cupom';
        if (document.body?.innerHTML?.includes(msg)) return 'recusa';
        return false;
      },
      { seletor: SELETOR_RESULTADO, msg: MSG_CAPTCHA_RECUSADO },
      { timeout: 25_000 }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 'timeout');

  if (desfecho !== 'cupom') {
    return {
      ok: false,
      motivo: desfecho === 'recusa' ? 'SEFAZ recusou o captcha' : 'cupom não apareceu após o submit'
    };
  }

  // Extrai somente a div da nota para exibição + performance
  let notaHtml;
  try {
    notaHtml = await page.$eval('#conteudo', el => el.outerHTML);
  } catch {
    // fallback: retorna a página inteira
    notaHtml = await page.content();
  }
  return { ok: true, notaHtml };
}

app.post('/consulta', async (req, res) => {
  // O frontend manda a chave formatada ("3523 0419 ..."), então normaliza antes de conferir.
  // Sem essa checagem um corpo sem chave queimava as 5 tentativas — navegador, captcha pago e
  // tudo — só para falhar no page.fill e responder 503 em vez de 400.
  const chaveAcesso = String(req.body?.chaveAcesso ?? '').replace(/\D/g, '');
  if (chaveAcesso.length !== 44) {
    return res.status(400).json({ error: 'Chave de acesso inválida: informe os 44 dígitos.' });
  }

  if (emAndamento >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Já existe uma consulta em andamento. Tente novamente em instantes.' });
  }
  emAndamento++;

  const inicio = Date.now();
  let respondido = false;
  let browser;
  let abortado = false;
  let slotLiberado = false;

  // O contador tem que cair no momento do abort, não no fim da limpeza: a espera pelo captcha é
  // uma promise comum que fechar o browser não cancela, e ela ainda pode levar minutos para
  // se resolver. Guardado por flag para o finally não decrementar de novo.
  const liberarSlot = () => {
    if (slotLiberado) return;
    slotLiberado = true;
    emAndamento--;
  };

  // Encerra o Chromium e libera o slot para interromper a consulta órfã: sem isso MAX_CONCURRENT
  // fica preso até o fim do scraping, mesmo sem ninguém para receber a resposta.
  const abortarConsulta = (motivo) => {
    abortado = true;
    console.warn(`🔌 Consulta abortada: ${motivo}`);
    liberarSlot();
    if (browser) browser.close().catch(() => {});
  };

  res.setTimeout(ROUTE_TIMEOUT_MS, () => {
    if (respondido) return;
    respondido = true;
    console.error('⏱️ Timeout da rota /consulta atingido.');
    res.status(504).json({ error: 'Tempo excedido ao consultar o SAT. Tente novamente.' });
    abortarConsulta('timeout da rota');
  });

  // Cliente fechou a aba ou o fetch abortou antes da resposta.
  // Precisa ser em `res`, não em `req`: o 'close' de `req` dispara assim que o body é lido.
  // 'close' também ocorre no fim normal, por isso o writableFinished distingue os dois casos.
  res.on('close', () => {
    if (respondido || res.writableFinished) return;
    respondido = true;
    abortarConsulta('cliente desconectou');
  });

  try {
    // 🚀 Produção: headless + no-sandbox. HEADLESS=false abre o navegador para depuração local.
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox','--disable-dev-shm-usage']
    });

    // Contexto e página vivem a consulta inteira: é o que permite reaproveitar a página depois de
    // uma recusa. A limpeza vem do browser.close() no finally.
    const context = await browser.newContext();
    const page = await context.newPage();
    const obterToken = criarFonteDeToken();

    let notaHtml = null;
    let ultimoMotivo = 'não foi possível obter o cupom';

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS && !abortado; tentativa++) {
      const restante = ROUTE_TIMEOUT_MS - MARGEM_RESPOSTA_MS - (Date.now() - inicio);
      if (restante < TENTATIVA_MINIMA_MS) {
        console.warn('⏳ Tempo insuficiente para nova tentativa; respondendo com o que há.');
        break;
      }

      let resultado;
      try {
        resultado = await tentarConsulta(page, chaveAcesso, obterToken, restante);
      } catch (erroTentativa) {
        // Falha isolada (captcha lento, navegação que caiu): não pode derrubar as demais tentativas
        if (abortado) break;
        resultado = { ok: false, motivo: erroTentativa.message };
      }

      if (resultado.ok) {
        notaHtml = resultado.notaHtml;
        console.log(`✅ Cupom obtido na tentativa ${tentativa}/${MAX_TENTATIVAS}.`);
        break;
      }

      ultimoMotivo = resultado.motivo;
      console.warn(`↻ Tentativa ${tentativa}/${MAX_TENTATIVAS} falhou: ${resultado.motivo}`);
    }

    if (!abortado && !respondido) {
      respondido = true;
      if (notaHtml) {
        res.json({ status: 'ok', notaHtml });
      } else {
        // 503 e não 200: a recusa da SEFAZ é falha temporária, e devolver a página de consulta
        // como se fosse o cupom era justamente o que enganava o frontend.
        console.error(`❌ Todas as tentativas falharam. Último motivo: ${ultimoMotivo}`);
        res.status(503).json({
          error: 'A SEFAZ recusou a consulta nas tentativas realizadas. Tente novamente em instantes.'
        });
      }
    }
  } catch (error) {
    // Quando abortamos de propósito, o Playwright rejeita por browser fechado: não é falha real
    if (abortado) {
      console.warn('Consulta interrompida antes de concluir.');
    } else {
      console.error('Erro /consulta:', error);
      if (!respondido) {
        respondido = true;
        res.status(500).json({ error: 'Erro ao consultar SAT.' });
      }
    }
  } finally {
    liberarSlot();
    try { if (browser) await browser.close(); } catch {}
  }
});

// A plataforma de deploy injeta PORT; 3000 é só o padrão local
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`🚀 Endpoint rodando na porta ${PORT}!`));
