const express = require('express');
const { chromium } = require('playwright');
// const resolverRecaptcha = require('./resolverCaptcha'); // Não usado mais diretamente
const tokenPool = require('./tokenPool');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- Config ---
const ROUTE_TIMEOUT_MS = 90_000;  // Reduzido: sem espera de captcha (15-45s)
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const GOTO_TIMEOUT = 90_000;

let browser = null;
let launching = null;       // evita launch duplicado
let useCount = 0;           // para reciclar browser
const MAX_USES_BEFORE_RESTART = 50;

// fila simples
let active = 0;
const queue = [];
function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, resolve, reject });
    runQueue();
  });
}
async function runQueue() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const item = queue.shift();
  active++;
  try {
    const out = await item.taskFn();
    item.resolve(out);
  } catch (e) {
    item.reject(e);
  } finally {
    active--;
    runQueue();
  }
}

async function getBrowser() {
  // recicla periodicamente para evitar leak/zumbi
  if (browser && browser.isConnected() && useCount < MAX_USES_BEFORE_RESTART) {
    return browser;
  }
  if (browser && browser.isConnected()) {
    try { await browser.close(); } catch {}
    browser = null;
  }
  if (!launching) {
    launching = (async () => {
      let lastErr;
      for (let i = 1; i <= 3; i++) {
        try {
          const br = await chromium.launch({
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--no-zygote',
              '--disable-gpu',
              '--renderer-process-limit=1'
              // '--single-process' // use só se ainda faltar recurso
            ]
          });
          br.on('disconnected', () => { browser = null; launching = null; });
          return br;
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 1500 * i));
        }
      }
      throw lastErr;
    })();
  }
  browser = await launching;
  launching = null;
  useCount = 0;
  return browser;
}

async function newContext() {
  const br = await getBrowser();
  const ctx = await br.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    extraHTTPHeaders: {
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });
  ctx.setDefaultNavigationTimeout(GOTO_TIMEOUT);
  ctx.setDefaultTimeout(GOTO_TIMEOUT);
  return ctx;
}

// healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// 📊 Endpoint para estatísticas do pool
app.get('/pool-stats', (_req, res) => res.json(tokenPool.getStats()));

app.post('/consulta', async (req, res) => {
  res.setTimeout(ROUTE_TIMEOUT_MS);
  const { chaveAcesso } = req.body;

  try {
    const result = await enqueue(async () => {
      const context = await newContext();
      const page = await context.newPage();

      // aborta estáticos (não bloqueie script/css)
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media') return route.abort();
        const url = route.request().url();
        if (/\.(ico|svg)$/i.test(url)) return route.abort();
        return route.continue();
      });

      try {
        // goto com retry
        const url = 'https://satsp.fazenda.sp.gov.br/COMSAT/Public/ConsultaPublica/ConsultaPublicaCfe.aspx';
        for (let i = 1; i <= 3; i++) {
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
            break;
          } catch (e) {
            if (i === 3) throw e;
            await page.waitForTimeout(2000 * i);
          }
        }

        // prepara form
        await page.$eval('#__VIEWSTATE', el => el.value);
        await page.$eval('#__EVENTVALIDATION', el => el.value);
        await page.fill('#conteudo_txtChaveAcesso', chaveAcesso);

        // 🚀 PEGA TOKEN DO POOL (< 1s)
        console.log('🎯 Obtendo token do pool...');
        const captchaToken = await tokenPool.getToken();
        console.log('✅ Token obtido, injetando...');
        
        await page.evaluate((token) => {
          const el = document.querySelector('[name="g-recaptcha-response"]');
          if (el) el.value = token;
          console.log('Token injetado:', !!token);
        }, captchaToken);

        // verifica e clica botão
        console.log('🔍 Verificando botão consultar...');
        const btnExists = await page.$('#conteudo_btnConsultar');
        if (!btnExists) {
          throw new Error('Botão #conteudo_btnConsultar não encontrado');
        }
        
        console.log('✅ Botão encontrado, habilitando e clicando...');
        await page.evaluate(() => {
          const btn = document.querySelector('#conteudo_btnConsultar');
          if (btn) {
            btn.disabled = false;
            console.log('Botão habilitado:', !btn.disabled);
          }
        });
        
        await page.click('#conteudo_btnConsultar');
        console.log('✅ Clique executado, aguardando resposta...');

        // 🎯 DETECÇÃO RÁPIDA: só verifica se apareceu
        console.log('⏳ Verificando se cupom apareceu...');
        let notaHtml = '';

        try {
          // Aguarda qualquer indicador de sucesso (mais rápido)
          await Promise.race([
            page.waitForSelector('text=CUPOM FISCAL ELETRÔNICO', { timeout: 15_000 }),
            page.waitForSelector('#conteudo', { timeout: 15_000 }),
            page.waitForSelector('text=NOTA FISCAL', { timeout: 15_000 })
          ]);
          
          console.log('✅ Cupom detectado! Extraindo HTML rapidamente...');
          
          // Extração rápida com timeout curto
          try {
            notaHtml = await page.$eval('#conteudo', el => el.outerHTML);
          } catch {
            // Fallback: pega só o body se #conteudo falhar
            notaHtml = await page.$eval('body', el => el.innerHTML);
          }
          
        } catch (e) {
          console.log('⚠️ Cupom não detectado no tempo esperado, extraindo página atual...');
          notaHtml = await page.content();
        }

        useCount++;
        return { status: 'ok', notaHtml };
      } finally {
        try { await page.close(); } catch {}
        try { await context.close(); } catch {}
      }
    });

    res.json(result);
  } catch (error) {
    console.error('Erro /consulta:', error);
    res.status(500).json({ error: 'Erro ao consultar SAT.' });
  }
});

// shutdown limpo
async function shutdown() {
  try { await browser?.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(3000, () => console.log('🚀 API no ar'));
