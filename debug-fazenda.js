const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('Acessando a página da Fazenda...');
    await page.goto('https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx', { timeout: 20000 });

    await page.waitForSelector('#conteudo_txtChaveAcesso', { timeout: 10000 });

    const html = await page.content();
    console.log('✅ Página carregada com sucesso!');
    console.log(html.slice(0, 1000)); // Só printa os primeiros 1000 caracteres pra não entupir

  } catch (error) {
    console.error('❌ Erro ao carregar página:', error);
  } finally {
    await browser.close();
  }
})();
