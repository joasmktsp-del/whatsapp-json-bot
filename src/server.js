const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const importer = require('./importer');
const db = require('./database');
const queue = require('./queue');
const GerenciadorWhatsApp = require('./whatsapp');

process.on('unhandledRejection', (err) => {
  console.error('  🔴 Unhandled Rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('  🔴 Uncaught Exception:', err?.message || err);
  console.error('     Stack:', err?.stack?.split('\n').slice(0, 3).join('\n     '));
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const whatsapp = new GerenciadorWhatsApp();

const multer = require('multer');
const IMAGEM_DIR = path.join(__dirname, '..', 'storage', 'imagem_envio');
const imagemStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGEM_DIR),
  filename: (req, file, cb) => cb(null, 'imagem_envio' + path.extname(file.originalname))
});
const uploadImagem = multer({ storage: imagemStorage, limits: { fileSize: 10 * 1024 * 1024 } });
let imagemEnvioPath = null;
// Restaura imagem salva se existir (persiste entre restarts)
try {
  const fs = require('fs');
  if (fs.existsSync(IMAGEM_DIR)) {
    const arquivos = fs.readdirSync(IMAGEM_DIR);
    const img = arquivos.find(f => f.startsWith('imagem_envio'));
    if (img) imagemEnvioPath = path.join(IMAGEM_DIR, img);
  }
} catch (e) { /* silent */ }

// ========== STATIC ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Image serve for preview
app.get('/api/imagem-file', (req, res) => {
  if (!imagemEnvioPath || !fs.existsSync(imagemEnvioPath)) return res.status(404).end();
  res.sendFile(imagemEnvioPath);
});

// Upload imagem
app.post('/api/upload-imagem', uploadImagem.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  imagemEnvioPath = req.file.path;
  res.json({ sucesso: true, nome: req.file.originalname });
});

// Status da imagem
app.get('/api/imagem', (req, res) => {
  if (!imagemEnvioPath || !fs.existsSync(imagemEnvioPath)) {
    return res.json({ existe: false });
  }
  res.json({ existe: true, nome: path.basename(imagemEnvioPath) });
});

// Remover imagem
app.delete('/api/imagem', (req, res) => {
  if (imagemEnvioPath && fs.existsSync(imagemEnvioPath)) {
    fs.unlinkSync(imagemEnvioPath);
  }
  imagemEnvioPath = null;
  res.json({ sucesso: true });
});

// ========== API REST ==========

// Status geral
app.get('/api/status', (req, res) => {
  res.json({
    whatsapp: whatsapp.getStatus(),
    fila: queue.getStatusFila(),
    contagem: db.contarPorStatus()
  });
});

// Importar JSON via upload (sem depender de arquivo fixo)
const uploadJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) cb(null, true);
    else cb(new Error('Apenas arquivos .json são permitidos'));
  }
});
app.post('/api/importar', uploadJson.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  let dados;
  try {
    dados = JSON.parse(req.file.buffer.toString('utf-8'));
  } catch (e) {
    return res.status(400).json({ error: 'JSON inválido: ' + e.message });
  }
  if (!Array.isArray(dados)) {
    return res.status(400).json({ error: 'JSON deve ser um array de clientes' });
  }
  try {
    const resultado = importer.importarDeObjeto(dados);
    io.emit('contagem', db.contarPorStatus());
    io.emit('notificacao', { tipo: 'sucesso', texto: `📥 Importados: ${resultado.adicionados} | Já existiam: ${resultado.ignorados_ja_existiam} | Sem tel: ${resultado.sem_telefone}` });
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao importar: ' + e.message });
  }
});

// Listar clientes
app.get('/api/clientes', (req, res) => {
  const { status } = req.query;
  const clientes = db.clientesPorStatus(status || 'todos');
  res.json(clientes);
});

// Buscar cliente por ID
app.get('/api/clientes/:id', (req, res) => {
  const cliente = db.buscarCliente(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(cliente);
});

// Aprovar cliente (vai pra fila mas mantém status aprovado p/ contador verde)
app.post('/api/clientes/:id/aprovar', (req, res) => {
  const atualizado = db.atualizarCliente(req.params.id, {
    status: 'aprovado',
    enfileirado_em: new Date().toISOString()
  });
  if (!atualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  // Adiciona na fila em memória
  queue.adicionarNaFila(atualizado);
  io.emit('cliente_atualizado', atualizado);
  io.emit('contagem', db.contarPorStatus());
  io.emit('fila_atualizada', { na_fila: queue.getStatusFila().tamanho });
  res.json(atualizado);
});

// Ignorar cliente (arquivar)
app.post('/api/clientes/:id/ignorar', (req, res) => {
  const atualizado = db.atualizarCliente(req.params.id, { status: 'erro' });
  if (!atualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  io.emit('cliente_atualizado', atualizado);
  io.emit('contagem', db.contarPorStatus());
  res.json(atualizado);
});

// Excluir cliente permanentemente (remove do JSON)
app.delete('/api/clientes/:id', (req, res) => {
  const id = req.params.id;
  const removido = db.excluirCliente(id);
  if (!removido) return res.status(404).json({ error: 'Cliente não encontrado' });
  // Remove também da fila se estiver
  try { queue.removerDaFila(id); } catch (e) { /* silent */ }
  io.emit('cliente_removido', { id });
  io.emit('contagem', db.contarPorStatus());
  res.json({ ok: true, removido });
});

// Editar mensagem de um cliente
app.post('/api/clientes/:id/editar-mensagem', (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ error: 'Mensagem não pode ficar vazia' });
  }
  const atualizado = db.atualizarCliente(req.params.id, { mensagem: mensagem.trim() });
  if (!atualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  io.emit('cliente_atualizado', atualizado);
  io.emit('contagem', db.contarPorStatus());
  res.json({ sucesso: true, cliente: atualizado });
});

// Marcar como enviado manualmente (sem WhatsApp)
app.post('/api/clientes/:id/marcar-enviado', (req, res) => {
  const cliente = db.buscarCliente(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
  const atualizado = db.atualizarCliente(req.params.id, {
    status: 'enviado',
    enviado_em: new Date().toISOString()
  });
  if (!atualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  // Log
  db.adicionarLogEnvio({
    cliente_id: cliente.id,
    nome: cliente.nome,
    telefone: cliente.telefone,
    bairro: cliente.bairro,
    status: 'enviado',
    metodo: 'marcar_enviado',
    detalhes: 'Manual'
  });
  // Remove da fila em memória se estiver
  queue.removerDaFilaSilencioso(cliente.id);
  io.emit('cliente_atualizado', atualizado);
  io.emit('contagem', db.contarPorStatus());
  res.json({ sucesso: true, cliente: atualizado });
});

// Enviar agora (um cliente específico)
app.post('/api/clientes/:id/enviar-agora', async (req, res) => {
  const cliente = db.buscarCliente(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
  if (!whatsapp.getStatus().conectado) {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  if (!cliente.telefone) {
    return res.status(400).json({ error: 'Cliente sem telefone' });
  }

  try {
    io.emit('log_terminal', {
      hora: new Date().toLocaleTimeString(),
      texto: `📤 Enviando agora para ${cliente.nome} (${cliente.telefone})...`,
      tipo: 'info'
    });
    const resultado = await whatsapp.enviarMensagem(cliente.telefone, cliente.mensagem);
    io.emit('log_terminal', {
      hora: new Date().toLocaleTimeString(),
      texto: `✅ Texto enviado para ${cliente.nome}`,
      tipo: 'sucesso'
    });

    // Envia imagem se houver
    let detalhes = 'OK';
    if (imagemEnvioPath && fs.existsSync(imagemEnvioPath)) {
      io.emit('log_terminal', {
        hora: new Date().toLocaleTimeString(),
        texto: `🖼️ Enviando imagem para ${cliente.nome}...`,
        tipo: 'info'
      });
      try {
        await whatsapp.enviarImagem(cliente.telefone, imagemEnvioPath);
        io.emit('log_terminal', {
          hora: new Date().toLocaleTimeString(),
          texto: `✅ Imagem enviada para ${cliente.nome}`,
          tipo: 'sucesso'
        });
        detalhes = 'texto+imagem';
      } catch (imgErr) {
        io.emit('log_terminal', {
          hora: new Date().toLocaleTimeString(),
          texto: `⚠️ Falha ao enviar imagem para ${cliente.nome}: ${imgErr.message}`,
          tipo: 'aviso'
        });
        detalhes = `texto, img_erro: ${imgErr.message}`;
      }
    }

    const atualizado = db.atualizarCliente(cliente.id, {
      status: 'enviado',
      enviado_em: new Date().toISOString()
    });
    // Log
    db.adicionarLogEnvio({
      cliente_id: cliente.id,
      nome: cliente.nome,
      telefone: cliente.telefone,
      bairro: cliente.bairro,
      status: 'enviado',
      metodo: 'enviar_agora',
      detalhes
    });
    io.emit('cliente_atualizado', atualizado);
    io.emit('contagem', db.contarPorStatus());
    res.json({ sucesso: true, cliente: atualizado, resultado });
  } catch (err) {
    io.emit('log_terminal', {
      hora: new Date().toLocaleTimeString(),
      texto: `❌ Erro ao enviar para ${cliente.nome}: ${err.message}`,
      tipo: 'erro'
    });
    db.adicionarLogEnvio({
      cliente_id: cliente.id,
      nome: cliente.nome,
      telefone: cliente.telefone,
      bairro: cliente.bairro,
      status: 'erro',
      metodo: 'enviar_agora',
      detalhes: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Iniciar fila de envio
app.post('/api/fila/iniciar', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Lista de IDs obrigatória' });
  }
  const adicionados = queue.enfileirar(ids);
  // Remove listeners antigos (evita duplicação se a rota for chamada de novo)
  queue.removeAllListeners('enviar');
  queue.removeAllListeners('fila_atualizada');
  queue.removeAllListeners('status');
  queue.removeAllListeners('progresso');
  queue.removeAllListeners('fila_concluida');

  queue.on('enviar', async (cliente) => {
      io.emit('log_terminal', {
        hora: new Date().toLocaleTimeString(),
        texto: `📤 Enviando para ${cliente.nome} (${cliente.telefone})...`,
        tipo: 'info'
      });
      try {
        const resultado = await whatsapp.enviarMensagem(cliente.telefone, cliente.mensagem);
        io.emit('log_terminal', {
          hora: new Date().toLocaleTimeString(),
          texto: `✅ Texto enviado para ${cliente.nome}`,
          tipo: 'sucesso'
        });

        // Envia imagem se houver
        let imagemOk = false;
        if (imagemEnvioPath && fs.existsSync(imagemEnvioPath)) {
          io.emit('log_terminal', {
            hora: new Date().toLocaleTimeString(),
            texto: `🖼️ Enviando imagem para ${cliente.nome}...`,
            tipo: 'info'
          });
          try {
            await whatsapp.enviarImagem(cliente.telefone, imagemEnvioPath);
            io.emit('log_terminal', {
              hora: new Date().toLocaleTimeString(),
              texto: `✅ Imagem enviada para ${cliente.nome}`,
              tipo: 'sucesso'
            });
            imagemOk = true;
          } catch (imgErr) {
            io.emit('log_terminal', {
              hora: new Date().toLocaleTimeString(),
              texto: `⚠️ Falha ao enviar imagem para ${cliente.nome}: ${imgErr.message}`,
              tipo: 'aviso'
            });
          }
        }

        queue.confirmarEnvio(cliente, { sucesso: true, id: resultado.id });
        db.adicionarLogEnvio({
          cliente_id: cliente.id,
          nome: cliente.nome,
          telefone: cliente.telefone,
          bairro: cliente.bairro,
          status: 'enviado',
          metodo: 'fila',
          detalhes: imagemOk ? 'texto+imagem' : 'texto'
        });
        io.emit('cliente_atualizado', db.buscarCliente(cliente.id));
      } catch (err) {
        io.emit('log_terminal', {
          hora: new Date().toLocaleTimeString(),
          texto: `❌ Erro para ${cliente.nome}: ${err.message}`,
          tipo: 'erro'
        });
        queue.confirmarEnvio(cliente, { erro: err.message });
        db.adicionarLogEnvio({
          cliente_id: cliente.id,
          nome: cliente.nome,
          telefone: cliente.telefone,
          bairro: cliente.bairro,
          status: 'erro',
          metodo: 'fila',
          detalhes: err.message
        });
        io.emit('cliente_atualizado', db.buscarCliente(cliente.id));
      }
      io.emit('contagem', db.contarPorStatus());
    });

  queue.on('fila_atualizada', (dados) => io.emit('fila_atualizada', dados));
  queue.on('status', (dados) => io.emit('fila_status', dados));
  queue.on('progresso', (dados) => io.emit('fila_progresso', dados));
  queue.on('fila_concluida', () => io.emit('fila_concluida'));

  queue.iniciar();
  res.json({ sucesso: true, adicionados, fila: queue.getStatusFila() });
});

// Pausar fila
app.post('/api/fila/pausar', (req, res) => {
  queue.pausar();
  res.json({ sucesso: true });
});

// Disparar fila (iniciar processamento)
app.post('/api/fila/disparar', (req, res) => {
  if (!whatsapp.getStatus().conectado) {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  const result = queue.disparar();
  if (result.sucesso) {
    res.json({ sucesso: true });
  } else {
    res.status(400).json({ error: result.motivo === 'fila_vazia' ? 'Fila vazia' : 'Fila já está rodando' });
  }
});

// Limpar fila (volta tudo para aprovado)
app.post('/api/fila/limpar', (req, res) => {
  queue.limpar();
  io.emit('contagem', db.contarPorStatus());
  res.json({ sucesso: true });
});

// Status da fila
app.get('/api/fila', (req, res) => {
  res.json(queue.getStatusFila());
});

// Fila detalhada (quem está na fila, ordenado por chegada)
app.get('/api/fila/detalhada', (req, res) => {
  res.json(queue.getFilaDetalhada());
});

// Remover da fila
app.post('/api/fila/remover/:id', (req, res) => {
  queue.removerDaFila(req.params.id);
  io.emit('cliente_atualizado', db.buscarCliente(req.params.id));
  io.emit('contagem', db.contarPorStatus());
  res.json({ sucesso: true });
});

// QR Code
app.get('/api/qrcode', (req, res) => {
  if (whatsapp.qrCodeBase64) {
    res.json({ qr: whatsapp.qrCodeBase64 });
  } else if (whatsapp.getStatus().conectado) {
    res.json({ conectado: true, mensagem: 'WhatsApp já conectado' });
  } else {
    res.json({ qr: null, mensagem: 'Aguardando QR Code...' });
  }
});

// Configurações
app.get('/api/config', (req, res) => {
  res.json(db.carregarConfig());
});

app.post('/api/config', (req, res) => {
  const config = db.carregarConfig();
  const novos = { ...config, ...req.body };
  db.salvarConfig(novos);
  res.json(novos);
});

// Log de envios
app.get('/api/log-envios', (req, res) => {
  res.json(db.carregarLogEnvios());
});

app.post('/api/log-envios/limpar', (req, res) => {
  db.limparLogEnvios();
  res.json({ sucesso: true });
});

// Importar/reimportar dados
app.post('/api/importar', (req, res) => {
  const result = importer.importar();
  io.emit('contagem', db.contarPorStatus());
  res.json(result);
});

// Importar JSON enviado pelo usuário (upload via UI)
app.post('/api/importar/upload', (req, res) => {
  try {
    const { clientes } = req.body;
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ error: 'Envie um array de clientes' });
    }
    const result = importer.importarDeObjeto(clientes);
    io.emit('contagem', db.contarPorStatus());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reimportar mantendo status de clientes já existentes
app.post('/api/reimportar', (req, res) => {
  // Carrega clientes existentes com status
  const existentes = db.carregarClientes();
  const porTelefone = {};
  for (const c of existentes) {
    if (c.telefone) porTelefone[c.telefone] = c;
  }

  // Reimporta
  const result = importer.importar();
  const novos = db.carregarClientes();

  // Restaura status de clientes que já existiam
  for (let i = 0; i < novos.length; i++) {
    const c = novos[i];
    if (c.telefone && porTelefone[c.telefone]) {
      const antigo = porTelefone[c.telefone];
      if (antigo.status !== 'pendente' && antigo.status !== 'sem_telefone' && antigo.status !== 'duplicado') {
        novos[i].status = antigo.status;
        novos[i].enviado_em = antigo.enviado_em || null;
        novos[i].resposta = antigo.resposta || null;
        novos[i].respondeu_em = antigo.respondeu_em || null;
        novos[i].erro = antigo.erro || null;
      }
    }
  }

  db.salvarClientes(novos);
  io.emit('contagem', db.contarPorStatus());
  res.json({ ...result, status_restaurados: Object.keys(porTelefone).length });
});

// Exportar CSV
app.get('/api/exportar/csv', (req, res) => {
  const clientes = db.carregarClientes();
  const cabecalho = ['id','nome','telefone','bairro','endereco','tipo','status','mensagem','resposta','enviado_em','nota'];
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const linhas = [cabecalho.join(',')];
  for (const c of clientes) {
    linhas.push(cabecalho.map(k => esc(c[k])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=clientes.csv');
  res.send('\uFEFF' + linhas.join('\n')); // BOM para acentos no Excel
});

// Reiniciar do zero (limpa tudo)
app.post('/api/reiniciar', (req, res) => {
  try {
    db.salvarClientes([]);
    db.limparLogEnvios();
    queue.limpar();
    io.emit('contagem', db.contarPorStatus());
    io.emit('fila_status', queue.getStatusFila());
    io.emit('fila_atualizada', { na_fila: 0 });
    res.json({ sucesso: true, mensagem: 'Sistema resetado. Pronto para importar novo arquivo.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  socket.emit('contagem', db.contarPorStatus());
  socket.emit('whatsapp_status', whatsapp.getStatus());
  socket.emit('fila_status', queue.getStatusFila());

  socket.on('solicitar_qr', () => {
    if (whatsapp.qrCodeBase64) {
      socket.emit('qr_code', { qr: whatsapp.qrCodeBase64 });
    }
  });
});

// ========== WHATSAPP EVENTS -> SOCKET ==========
whatsapp.on('qr', (data) => {
  io.emit('qr_code', { qr: data.qrBase64 });
  io.emit('whatsapp_status', whatsapp.getStatus());
});

whatsapp.on('conectado', (data) => {
  io.emit('whatsapp_status', whatsapp.getStatus());
  io.emit('notificacao', { tipo: 'sucesso', texto: `WhatsApp conectado: ${data.numero}` });
});

whatsapp.on('desconectado', () => {
  io.emit('whatsapp_status', whatsapp.getStatus());
  io.emit('notificacao', { tipo: 'aviso', texto: 'WhatsApp desconectado' });
});

whatsapp.on('erro_auth', (data) => {
  io.emit('notificacao', { tipo: 'erro', texto: `Erro de autenticação: ${data.msg}` });
});

whatsapp.on('erro', (data) => {
  io.emit('notificacao', { tipo: 'erro', texto: data.erro });
});

whatsapp.on('resposta', (data) => {
  // Busca cliente pelo telefone
  const clientes = db.carregarClientes();
  const telefoneRemetente = data.de.replace('@c.us', '').replace('@s.whatsapp.net', '');
  const cliente = clientes.find(c => c.telefone === telefoneRemetente);
  if (cliente) {
    const atualizado = queue.marcarResposta(cliente.id, data.corpo);
    io.emit('cliente_atualizado', atualizado);
    io.emit('contagem', db.contarPorStatus());
    io.emit('notificacao', {
      tipo: atualizado.status === 'optout' ? 'aviso' : 'info',
      texto: `${cliente.nome}: "${data.corpo.substring(0, 60)}"`
    });
  }
});

// ========== START ==========
const PORT = process.env.PORT || 3001;

server.listen(PORT, async () => {
  console.log(`\n  🚀 WhatsApp JSON Bot rodando em http://localhost:${PORT}`);
  console.log(`  📁 Dados: data/messages_bar_tatuap.json`);
  console.log(`  📦 Storage: storage/clientes.json\n`);

  // Restaura fila da storage (clientes com status na_fila)
  queue.restaurarDaStorage();

  // Inicia conexão WhatsApp automaticamente
  console.log('  🔌 Iniciando conexão WhatsApp...');
  try {
    await whatsapp.iniciar();
  } catch (err) {
    console.error('  🔴 Falha ao iniciar WhatsApp (servidor continua rodando):', err?.message);
  }
});
