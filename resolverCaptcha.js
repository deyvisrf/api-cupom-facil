require('dotenv').config();

const anticaptcha = require('@antiadmin/anticaptchaofficial');

// Configurar a chave da API
anticaptcha.setAPIKey(process.env.ANTI_CAPTCHA_KEY);

/**
 * Resolve o reCAPTCHA V2 da página SAT da Fazenda-SP
 */
async function resolverRecaptcha() {
  const siteKey = '6LeEy8wUAAAAAHN6Wu2rNdku25fyHUVgovX-rJqM'; // fixa pra essa página
  const websiteURL = 'https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx';

  try {
    console.log('🔄 Resolvendo reCAPTCHA...');
    
    // Resolve reCAPTCHA V2 sem proxy (método correto da API oficial)
    const gRecaptchaResponse = await anticaptcha.solveRecaptchaV2Proxyless(websiteURL, siteKey);
    
    console.log('✅ Token captcha resolvido:', gRecaptchaResponse);
    return gRecaptchaResponse;
    
  } catch (error) {
    console.error('❌ Erro ao resolver captcha:', error);
    throw error;
  }
}

module.exports = resolverRecaptcha;
