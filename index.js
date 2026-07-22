const express = require('express');
const { chromium } = require('playwright');
const resolverRecaptcha = require('./resolverCaptcha');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

//⏱️ timeout de resposta da rota (evita requests penduradas), com folga para captcha lento
const ROUTE_TIMEOUT_MS = 120_000;
//⏱️ limite máximo de espera pela resolução do captcha (a lib do Anti-Captcha não tem timeout interno)
const CAPTCHA_TIMEOUT_MS = 90_000;
//🔒 número máximo de consultas simultâneas (evita retries gastarem captcha duplicado)
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 1;
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
  res.setTimeout(ROUTE_TIMEOUT_MS, () => {
    if (respondido) return;
    respondido = true;
    console.error('⏱️ Timeout da rota /consulta atingido.');
    res.status(504).json({ error: 'Tempo excedido ao consultar o SAT. Tente novamente.' });
  });

  const { chaveAcesso } = req.body;

  let browser;
  let page;

  try {
    // 🚀 Produção: headless + no-sandbox
    browser = await chromium.launch({
      headless: true,
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
    console.error('Erro /consulta:', error);
    if (!respondido) {
      respondido = true;
      res.status(500).json({ error: 'Erro ao consultar SAT.' });
    }
  } finally {
    emAndamento--;
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
});

app.listen(3000, () => console.log('🚀 Endpoint rodando com sucesso!'));
