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
//⏱️ limite máximo de espera pela resolução do captcha (a lib do Anti-Captcha não tem timeout interno).
// 90s era curto: em horário de fila o Anti-Captcha passa disso e a consulta morria com 500.
const CAPTCHA_TIMEOUT_MS = 120_000;
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

app.post('/consulta', async (req, res) => {
  if (emAndamento >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Já existe uma consulta em andamento. Tente novamente em instantes.' });
  }
  emAndamento++;

  let respondido = false;
  let browser;
  let page;
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

  const { chaveAcesso } = req.body;

  try {
    // 🚀 Produção: headless + no-sandbox. HEADLESS=false abre o navegador para depuração local.
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox','--disable-dev-shm-usage']
    });
    page = await browser.newPage();

    // 1) Abre página e já começa a preparar o formulário
    await page.goto('https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx', {
      timeout: 30_000,
      waitUntil: 'domcontentloaded'
    });

    // (opcional, mas mantido caso o ASP.NET valide)
    await page.$eval('#__VIEWSTATE', el => el.value);
    await page.$eval('#__EVENTVALIDATION', el => el.value);

    await page.fill('#conteudo_txtChaveAcesso', chaveAcesso);

    // 2) Dispara a resolução do captcha em paralelo (overlap)
    const captchaPromise = resolverRecaptcha();

    // 3) Quando realmente precisar, aguarda o token (com limite máximo)
    const captchaToken = await withTimeout(
      captchaPromise,
      CAPTCHA_TIMEOUT_MS,
      'Tempo excedido ao resolver o reCAPTCHA.'
    );

    await page.evaluate((token) => {
      const el = document.querySelector('[name="g-recaptcha-response"]');
      if (el) el.value = token;
    }, captchaToken);

    // Garante botão habilitado
    await page.evaluate(() => {
      const btn = document.querySelector('#conteudo_btnConsultar');
      if (btn) btn.disabled = false;
    });

    await page.click('#conteudo_btnConsultar');

    try {
      await page.waitForSelector('text=CUPOM FISCAL ELETRÔNICO', { timeout: 20_000 });
    } catch (waitError) {
      // Diagnóstico: o site pode ter rejeitado o token, mostrado a chave como inválida,
      // ou apresentado um bloqueio — loga o que realmente foi renderizado para investigar depois.
      try {
        const textoPagina = await page.evaluate(() => document.body?.innerText?.slice(0, 1000));
        console.error('❌ Cupom não encontrado após submit. Conteúdo da página:', textoPagina);
      } catch {}
      throw waitError;
    }

    // 5) Extrai somente a div da nota para exibição + performance
    let notaHtml;
    try {
      notaHtml = await page.$eval('#conteudo', el => el.outerHTML);
    } catch {
      // fallback: retorna a página inteira
      notaHtml = await page.content();
    }

    if (!respondido) {
      respondido = true;
      res.json({ status: 'ok', notaHtml });
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
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
});

// A plataforma de deploy injeta PORT; 3000 é só o padrão local
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`🚀 Endpoint rodando na porta ${PORT}!`));
