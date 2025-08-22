const resolverRecaptcha = require('./resolverCaptcha');

class TokenPool {
  constructor(options = {}) {
    this.tokens = [];
    this.minPoolSize = options.minPoolSize || 3;
    this.maxPoolSize = options.maxPoolSize || 10;
    this.tokenTTL = options.tokenTTL || 110_000; // 110s (margem de segurança)
    this.isRefilling = false;
    this.stats = {
      hits: 0,
      misses: 0,
      tokensGenerated: 0,
      tokensExpired: 0
    };

    // Inicia o pool
    this.startBackgroundRefill();
    this.startCleanupTimer();
  }

  // Pega um token válido do pool (< 1s)
  async getToken() {
    // Remove tokens expirados primeiro
    this.cleanExpiredTokens();

    if (this.tokens.length > 0) {
      this.stats.hits++;
      const token = this.tokens.shift(); // FIFO: pega o mais antigo
      console.log(`✅ Token do pool usado (${this.tokens.length} restantes)`);
      
      // Dispara reposição se necessário
      this.triggerRefillIfNeeded();
      
      return token.value;
    }

    // Pool vazio - fallback para resolução direta
    this.stats.misses++;
    console.log('⚠️ Pool vazio, resolvendo captcha diretamente...');
    const token = await resolverRecaptcha();
    
    // Dispara reposição urgente
    this.triggerRefillIfNeeded();
    
    return token;
  }

  // Remove tokens expirados
  cleanExpiredTokens() {
    const now = Date.now();
    const validTokens = this.tokens.filter(token => {
      const isValid = (now - token.createdAt) < this.tokenTTL;
      if (!isValid) this.stats.tokensExpired++;
      return isValid;
    });
    
    if (validTokens.length !== this.tokens.length) {
      console.log(`🧹 ${this.tokens.length - validTokens.length} tokens expirados removidos`);
      this.tokens = validTokens;
    }
  }

  // Dispara reposição se pool estiver baixo
  triggerRefillIfNeeded() {
    if (this.tokens.length < this.minPoolSize && !this.isRefilling) {
      console.log(`🔄 Pool baixo (${this.tokens.length}), iniciando reposição...`);
      this.refillPool();
    }
  }

  // Reabastecer pool em background
  async refillPool() {
    if (this.isRefilling) return;
    this.isRefilling = true;

    try {
      const tokensNeeded = this.maxPoolSize - this.tokens.length;
      console.log(`🚀 Resolvendo ${tokensNeeded} captchas para o pool...`);

      // Resolve múltiplos captchas em paralelo
      const promises = Array(tokensNeeded).fill(null).map(async () => {
        try {
          const token = await resolverRecaptcha();
          return {
            value: token,
            createdAt: Date.now()
          };
        } catch (error) {
          console.error('❌ Erro ao resolver captcha para pool:', error.message);
          return null;
        }
      });

      const results = await Promise.allSettled(promises);
      const newTokens = results
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

      this.tokens.push(...newTokens);
      this.stats.tokensGenerated += newTokens.length;
      
      console.log(`✅ Pool reabastecido: ${newTokens.length} tokens adicionados (total: ${this.tokens.length})`);
    } catch (error) {
      console.error('❌ Erro ao reabastecer pool:', error);
    } finally {
      this.isRefilling = false;
    }
  }

  // Worker background para manter pool sempre cheio
  startBackgroundRefill() {
    setInterval(() => {
      this.cleanExpiredTokens();
      this.triggerRefillIfNeeded();
    }, 30_000); // Verifica a cada 30s
  }

  // Timer para limpeza de tokens expirados
  startCleanupTimer() {
    setInterval(() => {
      this.cleanExpiredTokens();
    }, 60_000); // Limpa a cada 1min
  }

  // Estatísticas do pool
  getStats() {
    return {
      ...this.stats,
      poolSize: this.tokens.length,
      isRefilling: this.isRefilling,
      oldestTokenAge: this.tokens.length > 0 
        ? Math.round((Date.now() - this.tokens[0].createdAt) / 1000) 
        : 0
    };
  }
}

// Singleton global
const tokenPool = new TokenPool();

module.exports = tokenPool;
