const express = require('express');
const { chromium } = require('playwright');
const resolverRecaptcha = require('./resolverCaptcha');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ⏱️ timeout de resposta da rota (evita requests penduradas)
const ROUTE_TIMEOUT_MS = 70_000;

app.post('/consulta', async (req, res) => {
  res.setTimeout(ROUTE_TIMEOUT_MS);
  const { chaveAcesso } = req.body;

  // 🚀 Produção: headless + no-sandbox
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();

  try {
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

    // 3) Quando realmente precisar, aguarda o token
    const captchaToken = await captchaPromise;

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

    await page.waitForSelector('text=CUPOM FISCAL ELETRÔNICO', { timeout: 20_000 });

    // 4) Espera o conteúdo da nota aparecer (seletor robusto)
    // try {
    //   await page.waitForSelector('#conteudo', { timeout: 20_000 });
    // } catch {
    //   // fallback por texto
    //   await page.waitForSelector('text=CUPOM FISCAL ELETRÔNICO', { timeout: 20_000 });
    // }

    // 5) Extrai somente a div da nota para exibição + performance
    let notaHtml;
    try {
      notaHtml = await page.$eval('#conteudo', el => el.outerHTML);
    } catch {
      // fallback: retorna a página inteira
      notaHtml = await page.content();
    }

    res.json({ status: 'ok', notaHtml });
  } catch (error) {
    console.error('Erro /consulta:', error);
    res.status(500).json({ error: 'Erro ao consultar SAT.' });
  } finally {
    try { await page.close(); } catch {}
    await browser.close();
  }
});

app.listen(3000, () => console.log('🚀 Endpoint rodando com sucesso!'));
