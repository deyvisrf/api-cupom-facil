require('dotenv').config();
const anticaptcha = require('@antiadmin/anticaptchaofficial');

const rawKey = process.env.ANTI_CAPTCHA_KEY || '';
const chaveMascarada = rawKey ? `${'*'.repeat(Math.max(rawKey.length - 4, 0))}${rawKey.slice(-4)}` : '(vazia)';
console.log(`🔑 ANTI_CAPTCHA_KEY carregada: ${chaveMascarada} (tamanho: ${rawKey.length})`);

anticaptcha.setAPIKey(rawKey);

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
    // A chave da SEFAZ é registrada no reCAPTCHA Enterprise — o próprio widget avisa que o site
    // "está excedendo a cota gratuita do reCAPTCHA Enterprise". Com Enterprise o Google devolve um
    // score de risco em vez de um sim/não, e o token do task type clássico reprovava nesse score:
    // chegava íntegro no POST (verificado byte a byte) e mesmo assim virava "O texto digitado não
    // confere". A/B submetendo à SEFAZ de verdade: clássico 1/3, enterprise 3/3.
    const solution = await anticaptcha.solveRecaptchaV2EnterpriseProxyless(websiteURL, siteKey);
    
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
