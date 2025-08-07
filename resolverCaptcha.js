require('dotenv').config();
const anticaptcha = require('@antiadmin/anticaptchaofficial');

anticaptcha.setAPIKey(process.env.ANTI_CAPTCHA_KEY);

// backoff “adulto”: espera inicial maior, depois polling moderado até 60s
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolverRecaptcha() {
  const websiteURL = 'https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx';
  const siteKey    = '6LeEy8wUAAAAAHN6Wu2rNdku25fyHUVgovX-rJqM';

  console.log('🔄 Criando task no Anti-Captcha...');
  const taskId = await anticaptcha.createTask({
    type: 'NoCaptchaTaskProxyless',
    websiteURL,
    websiteKey: siteKey
  });

  const deadline = Date.now() + 60_000;      // timeout total: 60s
  await sleep(8_000);                         // espera inicial (8s) — evita “ficar cutucando”

  while (Date.now() < deadline) {
    const res = await anticaptcha.getTaskResult(taskId);
    if (res?.status === 'ready' && res.solution?.gRecaptchaResponse) {
      console.log('✅ reCAPTCHA resolvido.');
      return res.solution.gRecaptchaResponse;
    }
    await sleep(3_000);                       // polling a cada 3s
  }

  throw new Error('Tempo esgotado aguardando reCAPTCHA (60s).');
}

module.exports = resolverRecaptcha;
