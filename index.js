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
// Com retentativa, abandonar um token lento e pedir outro rende mais que esperar indefinidamente.
const CAPTCHA_TIMEOUT_MS = Number(process.env.CAPTCHA_TIMEOUT_MS) || 60_000;
//🔁 A SEFAZ recusa o token com frequência e, ao recusar, devolve a própria página de consulta
// com HTTP 200. Retentar com token novo é o que sustenta a taxa de sucesso.
const MAX_TENTATIVAS = Number(process.env.MAX_TENTATIVAS) || 3;
// Folga reservada para conseguir responder antes de ROUTE_TIMEOUT_MS estourar
const MARGEM_RESPOSTA_MS = 20_000;
// Abaixo disso não cabe nem a tentativa mais rápida; melhor responder do que começar e ser cortado
const TENTATIVA_MINIMA_MS = 35_000;

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

// Uma tentativa completa: contexto limpo, token novo, submit e verificação do resultado.
// O sucesso é aferido pelo conteúdo, não pelo status: quando a SEFAZ recusa o captcha ela
// responde 200 devolvendo a própria página de consulta.
// Devolve { ok: true, notaHtml } ou { ok: false, motivo }.
async function tentarConsulta(browser, chaveAcesso, msRestantes) {
  // O captcha não pode consumir todo o tempo restante: ainda é preciso submeter e extrair
  const limiteCaptcha = Math.max(15_000, Math.min(CAPTCHA_TIMEOUT_MS, msRestantes - 30_000));
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(URL_CONSULTA, { timeout: 30_000, waitUntil: 'domcontentloaded' });

    // (opcional, mas mantido caso o ASP.NET valide)
    await page.$eval('#__VIEWSTATE', el => el.value);
    await page.$eval('#__EVENTVALIDATION', el => el.value);

    await page.fill('#conteudo_txtChaveAcesso', chaveAcesso);

    const captchaToken = await withTimeout(
      resolverRecaptcha(),
      limiteCaptcha,
      'Tempo excedido ao resolver o reCAPTCHA.'
    );

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
  } finally {
    try { await context.close(); } catch {}
  }
}

app.post('/consulta', async (req, res) => {
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

  const { chaveAcesso } = req.body;

  try {
    // 🚀 Produção: headless + no-sandbox. HEADLESS=false abre o navegador para depuração local.
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox','--disable-dev-shm-usage']
    });

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
        resultado = await tentarConsulta(browser, chaveAcesso, restante);
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
