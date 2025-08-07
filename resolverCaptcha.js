const express = require('express');
const { chromium } = require('playwright');
const resolverRecaptcha = require('./resolverCaptcha');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/consulta', async (req, res) => {
  const { chaveAcesso } = req.body;

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();

  try {
    await page.goto('https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx');

    const viewState = await page.$eval('#__VIEWSTATE', el => el.value);
    const eventValidation = await page.$eval('#__EVENTVALIDATION', el => el.value);

    await page.fill('#conteudo_txtChaveAcesso', chaveAcesso);

    // 💥 Resolvendo captcha com anti-captcha
    const captchaToken = await resolverRecaptcha();

    await page.evaluate((token) => {
      document.querySelector('[name="g-recaptcha-response"]').value = token;
    }, captchaToken);

    // Libera o botão (só por precaução)
    await page.evaluate(() => {
      document.querySelector('#conteudo_btnConsultar').disabled = false;
    });

    await page.click('#conteudo_btnConsultar');

    // aguarda algo exclusivo da nota aparecer (ex: id, texto, classe)
    await page.waitForSelector('body:has-text("CUPOM FISCAL ELETRÔNICO")', { timeout: 10000 });

    await page.waitForLoadState('networkidle');

    const htmlResultado = await page.content();
    res.json({
      status: "ok",
      notaHtml: htmlResultado
    });

  } catch (error) {
    console.error('Erro:', error);
    res.status(500).send({ error: 'Erro ao consultar SAT.' });
  } finally {
    await page.screenshot({ path: 'nota.png', fullPage: true });
    await browser.close();
  }
});

app.listen(3000, () => console.log('🚀 Endpoint rodando em http://localhost:3000'));