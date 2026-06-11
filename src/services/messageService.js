// src/services/messageService.js
// =============================================================
// Lógica UNIFICADA de envio de mensagem (texto + imagem)
// Substitui a duplicação que existia entre:
//   - server.js  -> /api/clientes/:id/enviar-agora
//   - queue.js   -> handler do evento 'enviar'
//
// Uso típico (envio avulso):
//   const messageService = require('./services/messageService');
//   const resultado = await messageService.enviarParaCliente(cliente, {
//     io, whatsapp, db, queue, imagemPath, metodo: 'avulso'
//   });
//
// Uso típico (consumido pelo handler 'enviar' da fila — server.js faz a ponte):
//   queue.on('enviar', async (cliente) => {
//     await messageService.enviarParaCliente(cliente, {
//       io, whatsapp, db, queue, imagemPath, metodo: 'fila'
//     });
//   });
//
// Retorno padronizado: { sucesso, mensagem, imageEnviada, erro? }
// =============================================================

const fs = require('fs');

/**
 * Emite uma linha no log_terminal via socket.io, se io estiver disponível
 * @param {object|null} io
 * @param {string} texto
 * @param {'info'|'sucesso'|'aviso'|'erro'} tipo
 */
function _emitLog(io, texto, tipo = 'info') {
  if (!io || typeof io.emit !== 'function') return;
  try {
    io.emit('log_terminal', {
      hora: new Date().toLocaleTimeString(),
      texto,
      tipo
    });
  } catch (e) {
    // nunca derruba o envio por causa de log
  }
}

/**
 * Resolve o caminho da imagem a enviar
 * Prioridade: opts.imagemPath explícito > whatsapp? nada > null
 * @param {object} opts
 * @returns {string|null}
 */
function _resolverImagemPath(opts) {
  if (opts.imagemPath && fs.existsSync(opts.imagemPath)) {
    return opts.imagemPath;
  }
  return null;
}

/**
 * Envia mensagem (texto + opcionalmente imagem) para um cliente.
 *
 * @param {object} cliente   - objeto cliente vindo do db (precisa ter id, nome, telefone, mensagem, bairro)
 * @param {object} [opts]
 * @param {object} [opts.io]           - instância do socket.io para emitir logs
 * @param {object} [opts.whatsapp]     - instância de GerenciadorWhatsApp (enviarMensagem / enviarImagem / getStatus)
 * @param {object} [opts.db]           - módulo database (atualizarCliente, adicionarLogEnvio, buscarCliente)
 * @param {object} [opts.queue]        - instância da fila (confirmarEnvio, removerDaFilaSilencioso) — usado no metodo 'fila'
 * @param {string} [opts.imagemPath]   - caminho absoluto de uma imagem para enviar depois do texto
 * @param {boolean} [opts.socketEmit=true] - se true, emite cliente_atualizado/contagem no io
 * @param {string} [opts.metodo='avulso']   - 'avulso' | 'fila' | 'marcar_enviado' | etc (vai para o log)
 *
 * @returns {Promise<{sucesso:boolean, mensagem:boolean, imageEnviada:boolean, erro?:string}>}
 */
async function enviarParaCliente(cliente, opts = {}) {
  const {
    io = null,
    whatsapp = null,
    db = null,
    queue = null,
    imagemPath = null,
    socketEmit = true,
    metodo = 'avulso'
  } = opts;

  // 1) Valida WhatsApp conectado
  if (!whatsapp || !whatsapp.getStatus || !whatsapp.getStatus().conectado) {
    return { sucesso: false, mensagem: false, imageEnviada: false, erro: 'WhatsApp não conectado' };
  }

  // 2) Valida cliente mínimo
  if (!cliente || !cliente.id) {
    return { sucesso: false, mensagem: false, imageEnviada: false, erro: 'Cliente inválido' };
  }
  if (!cliente.telefone) {
    return { sucesso: false, mensagem: false, imageEnviada: false, erro: 'Cliente sem telefone' };
  }

  const imagemFinalPath = _resolverImagemPath({ imagemPath });
  const nome = cliente.nome || '(sem nome)';
  const telefone = cliente.telefone;

  // 3) Envia TEXTO
  let textoOk = false;
  try {
    _emitLog(io, `📤 Enviando${metodo === 'fila' ? '' : ' agora'} para ${nome} (${telefone})...`, 'info');
    await whatsapp.enviarMensagem(telefone, cliente.mensagem);
    textoOk = true;
    _emitLog(io, `✅ Texto enviado para ${nome}`, 'sucesso');
  } catch (err) {
    // Falha no texto: registra log e retorna erro (imagem nem é tentada)
    _emitLog(io, `❌ Erro ao enviar para ${nome}: ${err.message}`, 'erro');
    if (db && typeof db.adicionarLogEnvio === 'function') {
      try {
        db.adicionarLogEnvio({
          cliente_id: cliente.id,
          nome,
          telefone,
          bairro: cliente.bairro,
          status: 'erro',
          metodo,
          detalhes: err.message
        });
      } catch (_) { /* silent */ }
    }
    return { sucesso: false, mensagem: false, imageEnviada: false, erro: err.message };
  }

  // 4) Envia IMAGEM (se houver) — não derruba o envio do texto se ela falhar
  let imageEnviada = false;
  let detalhes = 'texto';
  if (imagemFinalPath) {
    _emitLog(io, `🖼️ Enviando imagem para ${nome}...`, 'info');
    try {
      await whatsapp.enviarImagem(telefone, imagemFinalPath);
      imageEnviada = true;
      detalhes = 'texto+imagem';
      _emitLog(io, `✅ Imagem enviada para ${nome}`, 'sucesso');
    } catch (imgErr) {
      // Falha de imagem é aviso, não erro fatal
      _emitLog(io, `⚠️ Falha ao enviar imagem para ${nome}: ${imgErr.message}`, 'aviso');
      detalhes = `texto, img_erro: ${imgErr.message}`;
    }
  }

  // 5) Atualiza status do cliente no banco (enviado) e registra log
  let atualizado = null;
  if (db) {
    if (typeof db.atualizarCliente === 'function') {
      try {
        atualizado = db.atualizarCliente(cliente.id, {
          status: 'enviado',
          enviado_em: new Date().toISOString()
        });
      } catch (_) { /* silent */ }
    }
    if (typeof db.adicionarLogEnvio === 'function') {
      try {
        db.adicionarLogEnvio({
          cliente_id: cliente.id,
          nome,
          telefone,
          bairro: cliente.bairro,
          status: 'enviado',
          metodo,
          detalhes
        });
      } catch (_) { /* silent */ }
    }
  }

  // 6) Integração com a fila (só faz sentido no metodo 'fila')
  //    - Para 'avulso'/'enviar_agora' removemos silenciosamente (ele pode ter sido
  //      aprovado/enfileirado antes mas o usuário disparou avulso).
  //    - Para 'fila' chamamos confirmarEnvio para que a fila ande e remova o item.
  if (queue) {
    try {
      if (metodo === 'fila') {
        if (typeof queue.confirmarEnvio === 'function') {
          queue.confirmarEnvio(cliente, { sucesso: true, id: cliente.id });
        }
      } else {
        if (typeof queue.removerDaFilaSilencioso === 'function') {
          queue.removerDaFilaSilencioso(cliente.id);
        }
      }
    } catch (_) { /* silent */ }
  }

  // 7) Emite eventos de socket (se habilitado)
  if (socketEmit && io) {
    try {
      if (atualizado) io.emit('cliente_atualizado', atualizado);
      if (db && typeof db.contarPorStatus === 'function') {
        io.emit('contagem', db.contarPorStatus());
      }
    } catch (_) { /* silent */ }
  }

  return { sucesso: true, mensagem: textoOk, imageEnviada, erro: undefined };
}

module.exports = {
  enviarParaCliente
};
