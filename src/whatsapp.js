const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const EventEmitter = require('events');

const fs = require('fs');
const path = require('path');

// Detecta Chrome/Chromium no Windows ou Linux (Railway/Nix)
function detectarChrome() {
  // 1. Variável de ambiente (pode ter sido setada no nixpacks)
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Caminhos estáticos conhecidos (Windows + Linux)
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ];
  for (const p of candidatos) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Nix store (Railway): /nix/store/<hash>-chromium-<ver>/bin/chromium
  try {
    const { execSync } = require('child_process');
    const found = execSync(
      "find /nix/store -maxdepth 5 -type f -name chromium 2>/dev/null | head -1",
      { encoding: 'utf8', timeout: 8000, shell: '/bin/sh' }
    ).trim();
    if (found) {
      console.log('  [boot] Chromium Nix detectado:', found);
      return found;
    }
  } catch (e) {
    console.log('  [boot] find Nix falhou:', e.message);
  }

  return null;
}

class GerenciadorWhatsApp extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.conectado = false;
    this.qrCodeData = null;
    this.qrCodeBase64 = null;
    this.inicializando = false;
  }

  /**
   * Inicializa a conexão WhatsApp
   */
  async iniciar() {
    if (this.inicializando) return;
    this.inicializando = true;

    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--window-size=800,600'
      ]
    };

    // Se Chrome já estiver instalado, usa ele
    const chromePath = detectarChrome();
    if (chromePath) {
      puppeteerOpts.executablePath = chromePath;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: require('path').join(__dirname, '..', 'storage', 'whatsapp-session')
      }),
      puppeteer: puppeteerOpts
    });

    this.client.on('qr', async (qr) => {
      console.log('  🟡 QR Code recebido!');
      this.qrCodeData = qr;
      try {
        this.qrCodeBase64 = await qrcode.toDataURL(qr);
        console.log('  🟢 QR Code convertido para base64');
      } catch {
        console.error('  🔴 Falha ao converter QR para base64');
        this.qrCodeBase64 = null;
      }
      this.emit('qr', { qr, qrBase64: this.qrCodeBase64 });
    });

    this.client.on('ready', () => {
      this.conectado = true;
      this.inicializando = false;
      const numero = this.client.info?.wid?.user || 'desconhecido';
      console.log('  🟢 WhatsApp conectado! Número:', numero);
      this.emit('conectado', { numero });
    });

    this.client.on('disconnected', (motivo) => {
      console.log('  🟡 WhatsApp desconectado:', motivo);
      this.conectado = false;
      this.inicializando = false;
      this.emit('desconectado', { motivo });
    });

    this.client.on('message', async (msg) => {
      if (!msg.fromMe) {
        this.emit('resposta', {
          de: msg.from,
          corpo: msg.body,
          timestamp: msg.timestamp
        });
      }
    });

    this.client.on('auth_failure', (msg) => {
      this.conectado = false;
      this.inicializando = false;
      this.emit('erro_auth', { msg });
    });

    try {
      console.log('  🟡 Iniciando Chromium/Puppeteer...');
      await this.client.initialize();
      console.log('  🟢 WhatsApp client initialized successfully');
    } catch (err) {
      this.inicializando = false;
      console.error('  🔴 Erro ao inicializar WhatsApp:', err.message);
      if (err.stack) console.error('     Stack:', err.stack.split('\n').slice(0, 3).join('\n     '));
      this.emit('erro', { erro: err.message });
    }
  }

  /**
   * Envia mensagem para um número
   * @param {string} numero - 5511999999999
   * @param {string} texto - Mensagem
   */
  async enviarMensagem(numero, texto) {
    if (!this.conectado || !this.client) {
      throw new Error('WhatsApp não conectado');
    }
    const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
    const result = await this.client.sendMessage(chatId, texto);
    return { id: result.id._serialized };
  }

  async enviarImagem(numero, caminhoImagem) {
    if (!this.conectado || !this.client) {
      throw new Error('WhatsApp não conectado');
    }
    const { MessageMedia } = require('whatsapp-web.js');
    const fs = require('fs');
    if (!fs.existsSync(caminhoImagem)) throw new Error('Arquivo de imagem não encontrado');
    const media = MessageMedia.fromFilePath(caminhoImagem);
    const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
    const result = await this.client.sendMessage(chatId, media, { caption: '' });
    return { id: result.id._serialized };
  }

  /**
   * Desconecta
   */
  async desconectar() {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.conectado = false;
    }
  }

  getStatus() {
    return {
      conectado: this.conectado,
      qr: !!this.qrCodeData,
      inicializando: this.inicializando
    };
  }
}

module.exports = GerenciadorWhatsApp;
