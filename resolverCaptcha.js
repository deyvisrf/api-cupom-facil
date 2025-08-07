require('dotenv').config();
const anticaptcha = require('@antiadmin/anticaptchaofficial');

anticaptcha.setAPIKey(process.env.ANTI_CAPTCHA_KEY);

// backoff “adulto”: espera inicial maior, depois polling moderado até 60s
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolverRecaptcha() {
  const websiteURL = 'https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx';
  const siteKey    = '6LeEy8wUAAAAAHN6Wu2rNdku25fyHUVgovX-rJqM';

  console.log('🔄 Resolvendo reCAPTCHA v2 com Anti-Captcha...');
  console.log('📋 URL:', websiteURL);
  console.log('🔑 Site Key:', siteKey);
  
  try {
    // Primeiro, vamos verificar o saldo
    const balance = await anticaptcha.getBalance();
    console.log('💰 Saldo da conta Anti-Captcha:', balance);
    
    if (balance <= 0) {
      throw new Error('Saldo insuficiente na conta Anti-Captcha');
    }
    
    console.log('⏳ Iniciando resolução do reCAPTCHA...');
    const solution = await anticaptcha.solveRecaptchaV2Proxyless(websiteURL, siteKey);
    
    console.log('📦 Resposta completa do Anti-Captcha:', JSON.stringify(solution, null, 2));
    
    // Verificar diferentes formatos de resposta
    if (solution) {
      if (solution.gRecaptchaResponse) {
        console.log('✅ reCAPTCHA resolvido com sucesso (gRecaptchaResponse).');
        return solution.gRecaptchaResponse;
      } else if (typeof solution === 'string') {
        console.log('✅ reCAPTCHA resolvido com sucesso (string direta).');
        return solution;
      } else if (solution.solution && solution.solution.gRecaptchaResponse) {
        console.log('✅ reCAPTCHA resolvido com sucesso (solution.gRecaptchaResponse).');
        return solution.solution.gRecaptchaResponse;
      }
    }
    
    throw new Error('Formato de resposta inesperado do Anti-Captcha.');
  } catch (error) {
    console.error('❌ Erro ao resolver reCAPTCHA:', error.message);
    console.error('📝 Stack completo:', error.stack);
    throw new Error(`Erro no Anti-Captcha: ${error.message}`);
  }
}

module.exports = resolverRecaptcha;
