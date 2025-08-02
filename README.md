# Consulta SAT API

API para consulta automática de notas fiscais no SAT da Fazenda-SP com resolução automática de reCAPTCHA.

## 🚀 Funcionalidades

- Consulta automática de Cupons Fiscais Eletrônicos (CFe) no portal da Fazenda-SP
- Resolução automática de reCAPTCHA usando Anti-Captcha
- Retorna o HTML completo da nota fiscal
- Captura screenshot da página para debug

## 📋 Pré-requisitos

- Node.js
- Conta no [Anti-Captcha](https://anti-captcha.com/) para resolver reCAPTCHA
- Chave de acesso válida do CFe

## 🛠️ Instalação

1. Clone o repositório
2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente criando um arquivo `.env`:
```env
ANTI_CAPTCHA_KEY=sua_chave_do_anticaptcha_aqui
```

## 📡 Uso

1. Inicie o servidor:
```bash
npm start
```

2. A API estará disponível em `http://localhost:3000`

3. Faça uma requisição POST para `/consulta`:
```bash
curl -X POST http://localhost:3000/consulta \
  -H "Content-Type: application/json" \
  -d '{"chaveAcesso": "sua_chave_de_acesso_de_44_digitos"}'
```

## 📝 Resposta da API

### Sucesso (200)
```json
{
  "status": "ok",
  "notaHtml": "<html>...</html>"
}
```

### Erro (500)
```json
{
  "error": "Erro ao consultar SAT."
}
```

## 🔧 Tecnologias

- **Express.js** - Framework web
- **Playwright** - Automação do navegador
- **Anti-Captcha** - Resolução de reCAPTCHA
- **CORS** - Habilitação de requisições cross-origin

## 📄 Licença

ISC

## 👨‍💻 Autor

Deyvis Ferreira