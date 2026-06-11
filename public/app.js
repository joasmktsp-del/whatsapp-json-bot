/* ========== STATE ========== */
let clientes = [];
let clientesFiltrados = [];
let selecionados = new Set();
let socket = null;
let pagina = 1;
let apenasComTelefone = true; // FILTRO: só mostra clientes com WhatsApp
const TAM_PAGINA = 20;

/* ========== INIT ========== */
document.addEventListener('DOMContentLoaded', () => {
  socket = io();

  socket.on('connect', () => {
    console.log('Socket conectado');
    carregarClientes();
    carregarConfig();
    // Solicita QR Code ao conectar (pode já ter sido gerado)
    socket.emit('solicitar_qr');
    setTimeout(() => socket.emit('solicitar_qr'), 2000); // fallback
  });

  socket.on('contagem', (dados) => {
    atualizarContadores(dados);
  });

  socket.on('whatsapp_status', (dados) => {
    atualizarStatusWhatsApp(dados);
  });

  socket.on('qr_code', (dados) => {
    if (dados.qr) {
      document.getElementById('qrContainer').innerHTML = `<img src="${dados.qr}" alt="QR Code">`;
      document.getElementById('qrHelp').textContent = 'Escaneie com o WhatsApp';
    }
  });

  socket.on('cliente_atualizado', (cliente) => {
    const idx = clientes.findIndex(c => c.id === cliente.id);
    if (idx !== -1) clientes[idx] = cliente;
    filtrarClientes();
  });

  socket.on('fila_atualizada', (dados) => {
    document.getElementById('filaTamanho').textContent = dados.na_fila;
  });

  socket.on('fila_status', (dados) => {
    if (dados.rodando) {
      document.getElementById('btnIniciarFila').style.display = 'none';
      document.getElementById('btnDispararFila').style.display = 'none';
      document.getElementById('btnPausarFila').style.display = 'inline-flex';
      document.getElementById('btnLimparFila').style.display = 'none';
    } else {
      const temFila = dados.na_fila > 0;
      document.getElementById('btnIniciarFila').style.display = temFila ? 'none' : 'inline-flex';
      document.getElementById('btnDispararFila').style.display = temFila ? 'inline-flex' : 'none';
      document.getElementById('btnPausarFila').style.display = 'none';
      document.getElementById('btnLimparFila').style.display = temFila ? 'inline-flex' : 'none';
    }
  });

  socket.on('fila_progresso', (dados) => {
    document.getElementById('enviosHoje').textContent = dados.enviados;
    const total = dados.enviados + dados.restantes;
    const pct = total > 0 ? Math.round((dados.enviados / total) * 100) : 0;
    const bar = document.getElementById('progressoBarra');
    const text = document.getElementById('progressoTexto');
    if (bar) {
      bar.style.width = `${pct}%`;
      bar.style.display = 'block';
    }
    if (text) text.textContent = `${dados.enviados}/${total} (${pct}%)`;
  });

  socket.on('fila_concluida', () => {
    document.getElementById('progressoBarra').style.display = 'none';
    document.getElementById('progressoTexto').textContent = '✅ Fila concluída!';
    notificar('✅ Fila de envio concluída!', 'sucesso');
  });

  socket.on('notificacao', (dados) => {
    notificar(dados.texto, dados.tipo);
  });

  // Terminal log
  socket.on('log_terminal', (dados) => {
    adicionarLinhaTerminal(dados);
  });

  // Solicita QR Code
  socket.emit('solicitar_qr');

  // File input for image upload
  document.getElementById('inputImagem').addEventListener('change', uploadImagem);
});

/* ========== API ========== */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

/* ========== CLIENTES ========== */
async function carregarClientes() {
  const dados = await api('/api/clientes');
  clientes = dados;
  filtrarClientes();
}

function filtrarClientes() {
  const status = document.getElementById('filtroStatus').value;
  const busca = document.getElementById('buscaInput').value.toLowerCase().trim();
  const ordem = document.getElementById('filtroOrdenar').value;

  clientesFiltrados = clientes.filter(c => {
    if (apenasComTelefone && (!c.telefone || c.telefone.trim() === '')) return false;
    if (status !== 'todos' && c.status !== status) return false;
    if (busca) {
      const text = `${c.nome} ${c.bairro} ${c.telefone || ''} ${c.tipo}`.toLowerCase();
      if (!text.includes(busca)) return false;
    }
    return true;
  });

  // Ordenar
  const cmpStatus = { pendente:0, aprovado:1, na_fila:2, enviado:3, respondeu:4, erro:5, sem_telefone:6, duplicado:7, optout:8 };
  clientesFiltrados.sort((a, b) => {
    switch (ordem) {
      case 'nome_desc': return (b.nome || '').localeCompare(a.nome || '');
      case 'status': return (cmpStatus[a.status]||0) - (cmpStatus[b.status]||0);
      case 'bairro': return (a.bairro || '').localeCompare(b.bairro || '');
      case 'nota': return (b.nota || 0) - (a.nota || 0);
      default: return (a.nome || '').localeCompare(b.nome || '');
    }
  });

  pagina = 1;
  renderizarClientes();
}

function renderizarClientes() {
  const container = document.getElementById('clientesContainer');
  const totalPaginas = Math.ceil(clientesFiltrados.length / TAM_PAGINA) || 1;
  if (pagina > totalPaginas) pagina = totalPaginas;
  const inicio = (pagina - 1) * TAM_PAGINA;
  const paginaAtual = clientesFiltrados.slice(inicio, inicio + TAM_PAGINA);

  if (clientesFiltrados.length === 0) {
    container.innerHTML = '<div class="loading">Nenhum cliente encontrado</div>';
    document.getElementById('paginacao').innerHTML = '';
    return;
  }

  container.innerHTML = paginaAtual.map(c => {
    const isSelected = selecionados.has(c.id);
    const statusClass = `status-${c.status.replace('_', '-')}`;
    const statusLabel = traduzirStatus(c.status);

    return `
      <div class="cliente-card ${isSelected ? 'selecionado' : ''}">
        <input type="checkbox" class="checkbox" ${isSelected ? 'checked' : ''}
               onchange="toggleSelecao('${c.id}')">
        <div class="cliente-header">
          <div class="cliente-nome">${escapeHtml(c.nome)}</div>
          <span class="cliente-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="cliente-info">
          ${c.telefone ? `<span>📞 ${c.telefone_raw || formatarTelefone(c.telefone)}</span>` : '<span>📵 Sem telefone</span>'}
          ${c.bairro ? `<span>📍 ${escapeHtml(c.bairro)}</span>` : ''}
          ${c.tipo ? `<span>🏷️ ${escapeHtml(c.tipo)}</span>` : ''}
          ${c.endereco ? `<span>📌 ${escapeHtml(c.endereco)}</span>` : ''}
          ${c.nota ? `<span>⭐ ${c.nota}</span>` : ''}
        </div>
        <div class="cliente-mensagem" id="msg-${c.id}">
          <span class="msg-texto">${escapeHtml(c.mensagem)}</span>
          <span class="msg-acoes">
            <button class="btn btn-msg-icone" onclick="copiarMensagem('${c.id}')" title="Copiar">📋</button>
            <button class="btn btn-msg-icone" onclick="editarMensagem('${c.id}')" title="Editar">✏️</button>
          </span>
        </div>
        ${c.resposta ? `<div class="cliente-resposta">💬 ${escapeHtml(c.resposta)}</div>` : ''}
        <div class="cliente-acoes">
          <button class="btn btn-success btn-sm" onclick="aprovarCliente('${c.id}')">✅ Aprovar</button>
          <button class="btn btn-primary btn-sm" onclick="enviarAgora('${c.id}')">📤 Enviar agora</button>
          <button class="btn btn-secondary btn-sm" onclick="marcarEnviado('${c.id}')">📤 Marc. enviado</button>
          <button class="btn btn-danger btn-sm" onclick="ignorarCliente('${c.id}')">🚫 Ignorar</button>
          <button class="btn btn-dark btn-sm" onclick="excluirCliente('${c.id}', '${(c.nome || '').replace(/'/g, '')}')">🗑️ Excluir</button>
        </div>
      </div>
    `;
  }).join('');

  // Paginação
  const elPag = document.getElementById('paginacao');
  if (totalPaginas <= 1) {
    elPag.innerHTML = `<span class="pag-info">${clientesFiltrados.length} cliente(s)</span>`;
  } else {
    elPag.innerHTML = `
      <button class="btn btn-sm btn-page" onclick="mudarPagina(${pagina - 1})" ${pagina <= 1 ? 'disabled' : ''}>◀</button>
      <span class="pag-info">Pág ${pagina}/${totalPaginas} (${clientesFiltrados.length} total)</span>
      <button class="btn btn-sm btn-page" onclick="mudarPagina(${pagina + 1})" ${pagina >= totalPaginas ? 'disabled' : ''}>▶</button>
    `;
  }
}

/* ========== AÇÕES ========== */
function mudarPagina(p) {
  const total = Math.ceil(clientesFiltrados.length / TAM_PAGINA) || 1;
  if (p < 1 || p > total) return;
  pagina = p;
  renderizarClientes();
  document.getElementById('clientesContainer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function aprovarCliente(id) {
  try {
    const atualizado = await api(`/api/clientes/${id}/aprovar`, { method: 'POST' });
    const idx = clientes.findIndex(c => c.id === id);
    if (idx !== -1) clientes[idx] = atualizado;
    filtrarClientes();
    notificar(`✅ Cliente aprovado e adicionado à fila!`, 'sucesso');
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

async function ignorarCliente(id) {
  try {
    const atualizado = await api(`/api/clientes/${id}/ignorar`, { method: 'POST' });
    const idx = clientes.findIndex(c => c.id === id);
    if (idx !== -1) clientes[idx] = atualizado;
    filtrarClientes();
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

async function excluirCliente(id, nome) {
  if (!confirm(`🗑️ Excluir "${nome || id}" PERMANENTEMENTE?\n\nEssa ação não pode ser desfeita. O cliente será removido do arquivo JSON.`)) return;
  try {
    await api(`/api/clientes/${id}`, { method: 'DELETE' });
    clientes = clientes.filter(c => c.id !== id);
    filtrarClientes();
    notificar(`🗑️ Cliente "${nome || id}" excluído`, 'sucesso');
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

async function enviarAgora(id) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  try {
    const result = await api(`/api/clientes/${id}/enviar-agora`, { method: 'POST' });
    if (result.sucesso) {
      notificar(`✅ Mensagem enviada para ${result.cliente.nome}`, 'sucesso');
      carregarClientes();
    } else {
      notificar(`❌ Erro: ${result.error}`, 'erro');
    }
  } catch (err) {
    notificar(`❌ Erro: ${err.message}`, 'erro');
  }
  btn.disabled = false;
  btn.textContent = '📤 Enviar agora';
}

async function marcarEnviado(id) {
  try {
    const result = await api(`/api/clientes/${id}/marcar-enviado`, { method: 'POST' });
    const idx = clientes.findIndex(c => c.id === id);
    if (idx !== -1) clientes[idx] = result.cliente;
    filtrarClientes();
    notificar('📤 Marcado como enviado!', 'sucesso');
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

// ✏️ Editar mensagem inline
function copiarMensagem(id) {
  const cliente = clientes.find(c => c.id === id);
  if (!cliente) return;
  navigator.clipboard.writeText(cliente.mensagem).then(() => {
    notificar('📋 Mensagem copiada!', 'sucesso');
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = cliente.mensagem;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    notificar('📋 Mensagem copiada!', 'sucesso');
  });
}

function editarMensagem(id) {
  const container = document.getElementById(`msg-${id}`);
  const span = container.querySelector('.msg-texto');
  const textoAtual = span.textContent;

  container.innerHTML = `
    <div style="flex:1">
      <textarea class="msg-edit-area" id="edit-area-${id}">${escapeHtml(textoAtual)}</textarea>
      <div class="msg-edit-acoes">
        <button class="btn btn-success btn-xs" onclick="salvarEdicao('${id}')">💾 Salvar</button>
        <button class="btn btn-secondary btn-xs" onclick="cancelarEdicao('${id}')">Cancelar</button>
      </div>
    </div>
  `;
  document.getElementById(`edit-area-${id}`).focus();
}

async function salvarEdicao(id) {
  const textarea = document.getElementById(`edit-area-${id}`);
  const novaMsg = textarea.value.trim();
  if (!novaMsg) {
    notificar('Mensagem não pode ficar vazia', 'aviso');
    return;
  }

  try {
    const result = await api(`/api/clientes/${id}/editar-mensagem`, {
      method: 'POST',
      body: JSON.stringify({ mensagem: novaMsg })
    });
    const idx = clientes.findIndex(c => c.id === id);
    if (idx !== -1) clientes[idx] = result.cliente;
    filtrarClientes();
    notificar('✏️ Mensagem editada', 'sucesso');
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
    cancelarEdicao(id);
  }
}

function cancelarEdicao(id) {
  const cliente = clientes.find(c => c.id === id);
  if (!cliente) return carregarClientes();
  const container = document.getElementById(`msg-${id}`);
  container.innerHTML = `
    <span class="msg-texto">${escapeHtml(cliente.mensagem)}</span>
    <span class="msg-acoes">
      <button class="btn btn-msg-icone" onclick="copiarMensagem('${id}')" title="Copiar">📋</button>
      <button class="btn btn-msg-editar" onclick="editarMensagem('${id}')" title="Editar">✏️</button>
    </span>
  `;
}

async function reaProvar(id) {
  await api(`/api/clientes/${id}/aprovar`, { method: 'POST' });
  carregarClientes();
}

async function removerDaFila(id) {
  await api(`/api/fila/remover/${id}`, { method: 'POST' });
  carregarClientes();
}

// Seleção
function toggleSelecao(id) {
  if (selecionados.has(id)) selecionados.delete(id);
  else selecionados.add(id);
  renderizarClientes();
}

function selecionarTodos() {
  clientesFiltrados.forEach(c => selecionados.add(c.id));
  renderizarClientes();
}

async function aprovarSelecionados() {
  if (selecionados.size === 0) {
    notificar('Nenhum cliente selecionado', 'aviso');
    return;
  }
  const ids = Array.from(selecionados);
  for (const id of ids) {
    await api(`/api/clientes/${id}/aprovar`, { method: 'POST' });
  }
  selecionados.clear();
  notificar(`✅ ${ids.length} cliente(s) aprovado(s)`, 'sucesso');
  carregarClientes();
}

// Fila
async function enfileirarAprovados() {
  const aprovados = clientes.filter(c => c.status === 'aprovado');
  if (aprovados.length === 0) {
    notificar('Nenhum cliente aprovado para enfileirar', 'aviso');
    return;
  }
  try {
    const ids = aprovados.map(c => c.id);
    const result = await api('/api/fila/iniciar', {
      method: 'POST',
      body: JSON.stringify({ ids })
    });
    notificar(`⏳ ${result.adicionados} cliente(s) enfileirado(s)`, 'sucesso');
    carregarClientes();
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

async function iniciarFila() {
  try {
    const result = await api('/api/fila/disparar', { method: 'POST' });
    notificar('▶️ Disparando fila...', 'info');
  } catch (err) {
    notificar(`❌ ${err.message}`, 'erro');
  }
}

async function pausarFila() {
  await api('/api/fila/pausar', { method: 'POST' });
  notificar('⏸️ Fila pausada', 'aviso');
}

async function limparFila() {
  await api('/api/fila/limpar', { method: 'POST' });
  notificar('🗑️ Fila limpa', 'info');
  carregarClientes();
}

/* ========== EXPORT CSV ========== */
function exportarCSV() {
  const a = document.createElement('a');
  a.href = '/api/exportar/csv?_t=' + Date.now();
  a.download = `clientes_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  notificar('📊 CSV exportado!', 'sucesso');
}

/* ========== REINICIAR DO ZERO ========== */
async function reiniciarDoZero() {
  if (!confirm('⚠️ ISSO VAI APAGAR TUDO!\n\nClientes, logs, fila — tudo será resetado.\n\nDepois vc pode importar um novo arquivo JSON.\n\nTem certeza?')) return;
  if (!confirm('🔥 Confirmação final: realmente resetar o sistema do zero?')) return;
  try {
    const result = await api('/api/reiniciar', { method: 'POST' });
    if (result.sucesso) {
      notificar('✅ Sistema resetado! Importe um novo arquivo.', 'sucesso');
      setTimeout(() => abrirImportModal(), 500);
    } else {
      notificar('❌ Erro ao resetar: ' + (result.error || 'desconhecido'), 'erro');
    }
  } catch (err) {
    notificar('❌ Erro ao resetar: ' + err.message, 'erro');
  }
}

/* ========== IMPORT JSON ========== */
let importData = null;

function abrirImportModal() {
  document.getElementById('modalImport').style.display = 'flex';
  importData = null;
  document.getElementById('importFileName').textContent = '';
  document.getElementById('importTextarea').value = '';
  document.getElementById('btnImportar').disabled = false;
  document.getElementById('btnImportar').textContent = '📥 Importar';
}

function fecharImportModal() {
  document.getElementById('modalImport').style.display = 'none';
}

function toggleImportMode() {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  document.getElementById('importUploadArea').style.display = mode === 'upload' ? 'block' : 'none';
  document.getElementById('importPasteArea').style.display = mode === 'paste' ? 'block' : 'none';
}

function lerArquivoImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('importFileName').textContent = `📎 ${file.name}`;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      importData = JSON.parse(e.target.result);
      if (!Array.isArray(importData)) {
        notificar('JSON deve ser um array de clientes', 'erro');
        importData = null;
        return;
      }
      notificar(`✅ JSON lido: ${importData.length} cliente(s)`, 'sucesso');
    } catch (err) {
      notificar('❌ Erro ao ler JSON: ' + err.message, 'erro');
      importData = null;
    }
  };
  reader.readAsText(file);
}

async function importarJSON() {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  let dados = importData;

  if (mode === 'paste') {
    const text = document.getElementById('importTextarea').value.trim();
    if (!text) {
      notificar('Cole o JSON ou selecione um arquivo', 'aviso');
      return;
    }
    try {
      dados = JSON.parse(text);
      if (!Array.isArray(dados)) {
        notificar('JSON deve ser um array de clientes', 'erro');
        return;
      }
    } catch (err) {
      notificar('❌ JSON inválido: ' + err.message, 'erro');
      return;
    }
  }

  if (!dados || dados.length === 0) {
    notificar('Nenhum dado para importar', 'aviso');
    return;
  }

  const btn = document.getElementById('btnImportar');
  btn.disabled = true;
  btn.textContent = '⏳ Importando...';

  try {
    const result = await api('/api/importar/upload', {
      method: 'POST',
      body: JSON.stringify({ clientes: dados })
    });
    notificar(`✅ Importado: ${result.adicionados} novo(s), ${result.ignorados_ja_existiam} já existiam`, 'sucesso');
    fecharImportModal();
    carregarClientes();
  } catch (err) {
    notificar(`❌ Erro: ${err.message}`, 'erro');
    btn.disabled = false;
    btn.textContent = '📥 Importar';
  }
}

/* ========== CONTADORES ========== */
function atualizarContadores(contagem) {
  const el = document.getElementById('contadores');
  if (!contagem) return;
  el.innerHTML = `
    <div class="contador pendente"><span class="label">📝 Pendentes</span><span class="valor">${contagem.pendente || 0}</span></div>
    <div class="contador aprovado"><span class="label">✅ Aprovados</span><span class="valor">${contagem.aprovado || 0}</span></div>
    <div class="contador na_fila"><span class="label">⏳ Na fila</span><span class="valor">${contagem.na_fila || 0}</span></div>
    <div class="contador enviado"><span class="label">📤 Enviados</span><span class="valor">${contagem.enviado || 0}</span></div>
    <div class="contador respondeu"><span class="label">💬 Respondeu</span><span class="valor">${contagem.respondeu || 0}</span></div>
    <div class="contador erro"><span class="label">❌ Erro</span><span class="valor">${contagem.erro || 0}</span></div>
    <div class="contador sem_telefone"><span class="label">📵 S/ telefone</span><span class="valor">${contagem.sem_telefone || 0}</span></div>
    <div class="contador duplicado"><span class="label">👥 Duplicados</span><span class="valor">${contagem.duplicado || 0}</span></div>
    <div class="contador optout"><span class="label">🚫 Opt-out</span><span class="valor">${contagem.optout || 0}</span></div>
    <div class="contador total"><span class="label">📊 Total</span><span class="valor">${contagem.total || 0}</span></div>
  `;

  // Habilita/desabilita botão de iniciar fila
  const btnFila = document.getElementById('btnIniciarFila');
  if (btnFila) {
    btnFila.disabled = !contagem.aprovado || contagem.aprovado === 0;
  }
}

/* ========== WHATSAPP STATUS ========== */
function atualizarStatusWhatsApp(status) {
  const el = document.getElementById('statusConexao');
  const indicator = el.querySelector('.status-indicator');
  const texto = el.querySelector('.status-texto');
  const qrContainer = document.getElementById('qrContainer');
  const qrHelp = document.getElementById('qrHelp');

  if (!status) return;

  if (status.conectado) {
    indicator.className = 'status-indicator conectado';
    texto.textContent = 'Conectado';
    // Some QR Code quando conecta
    qrContainer.innerHTML = '<div class="qr-conectado">✅ Conectado</div>';
    qrHelp.textContent = 'WhatsApp conectado com sucesso';
  } else if (status.inicializando) {
    indicator.className = 'status-indicator conectando';
    texto.textContent = 'Conectando...';
    qrContainer.innerHTML = '<div class="qr-placeholder">Aguardando QR Code...</div>';
    qrHelp.textContent = 'Aguardando QR Code...';
  } else if (status.qr) {
    indicator.className = 'status-indicator conectando';
    texto.textContent = 'QR Code pronto';
    qrHelp.textContent = 'Escaneie com o WhatsApp';
  } else {
    indicator.className = 'status-indicator desconectado';
    texto.textContent = 'Desconectado';
    qrContainer.innerHTML = '<div class="qr-placeholder">Desconectado</div>';
    qrHelp.textContent = 'Escaneie o QR Code para conectar';
  }
}

/* ========== CONFIG ========== */
async function carregarConfig() {
  const config = await api('/api/config');
  document.getElementById('cfgDelay').value = config.delay_entre_envios_ms || 8000;
  document.getElementById('cfgMaxDia').value = config.max_por_dia || 50;
  document.getElementById('cfgOptout').value = (config.palavras_optout || []).join(', ');
  document.getElementById('limiteDiario').textContent = config.max_por_dia || 50;
}

function abrirConfig() {
  document.getElementById('modalConfig').style.display = 'flex';
}

function fecharConfig() {
  document.getElementById('modalConfig').style.display = 'none';
}

async function salvarConfig() {
  const config = {
    delay_entre_envios_ms: parseInt(document.getElementById('cfgDelay').value) || 8000,
    max_por_dia: parseInt(document.getElementById('cfgMaxDia').value) || 50,
    palavras_optout: document.getElementById('cfgOptout').value.split(',').map(s => s.trim()).filter(Boolean)
  };
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify(config)
  });
  document.getElementById('limiteDiario').textContent = config.max_por_dia;
  notificar('⚙️ Configurações salvas', 'sucesso');
  fecharConfig();
}

/* ========== UTILS ========== */
function traduzirStatus(status) {
  const mapa = {
    'pendente': '📝 Pendente',
    'aprovado': '✅ Aprovado',
    'na_fila': '⏳ Na fila',
    'enviado': '📤 Enviado',
    'respondeu': '💬 Respondeu',
    'erro': '❌ Erro',
    'sem_telefone': '📵 Sem telefone',
    'duplicado': '👥 Duplicado',
    'optout': '🚫 Opt-out'
  };
  return mapa[status] || status;
}

function formatarTelefone(numero) {
  if (!numero) return '';
  if (numero.length === 13) {
    return `(${numero.slice(2, 4)}) ${numero.slice(4, 9)}-${numero.slice(9)}`;
  }
  if (numero.length === 12) {
    return `(${numero.slice(2, 4)}) ${numero.slice(4, 8)}-${numero.slice(8)}`;
  }
  return numero;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function notificar(texto, tipo = 'info') {
  const existing = document.querySelector('.notificacao');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = `notificacao ${tipo}`;
  el.textContent = texto;
  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

/* ========== MODAL FILA DETALHADA ========== */
function abrirFilaModal() {
  document.getElementById('modalFila').style.display = 'flex';
  atualizarFilaModal();
}

function fecharFilaModal() {
  document.getElementById('modalFila').style.display = 'none';
}

async function atualizarFilaModal() {
  const lista = document.getElementById('filaModalList');
  const count = document.getElementById('filaModalCount');
  try {
    const fila = await api('/api/fila/detalhada');
    count.textContent = `${fila.length} cliente(s) na fila`;
    if (fila.length === 0) {
      lista.innerHTML = '<div class="fila-vazia">⏳ Fila vazia</div>';
      return;
    }
    lista.innerHTML = fila.map((c, i) => {
      const chegado = c.enfileirado_em ? new Date(c.enfileirado_em).toLocaleString('pt-BR') : '-';
      return `
        <div class="fila-item-card">
          <span class="fila-pos">#${i + 1}</span>
          <div class="fila-item-info">
            <strong>${escapeHtml(c.nome)}</strong>
            <span>📞 ${c.telefone || '-'} ${c.bairro ? '📍 ' + escapeHtml(c.bairro) : ''}</span>
          </div>
          <span class="fila-chegada">🕐 ${chegado}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    lista.innerHTML = `<div class="erro-msg">Erro: ${err.message}</div>`;
  }
}

/* ========== MODAL LOG DE ENVIO ========== */
function abrirLogModal() {
  document.getElementById('modalLog').style.display = 'flex';
  atualizarLogModal();
}

function fecharLogModal() {
  document.getElementById('modalLog').style.display = 'none';
}

async function atualizarLogModal() {
  const lista = document.getElementById('logModalList');
  const count = document.getElementById('logModalCount');
  try {
    const logs = await api('/api/log-envios');
    count.textContent = `${logs.length} registro(s)`;
    if (logs.length === 0) {
      lista.innerHTML = '<div class="fila-vazia">📭 Nenhum envio registrado</div>';
      return;
    }
    lista.innerHTML = logs.map(log => {
      const ts = log.timestamp ? new Date(log.timestamp).toLocaleString('pt-BR') : '-';
      const statusClass = log.status === 'enviado' ? 'log-sucesso' : 'log-erro';
      return `
        <div class="log-item ${statusClass}">
          <span class="log-icon">${log.status === 'enviado' ? '✅' : '❌'}</span>
          <div class="log-info">
            <strong>${escapeHtml(log.nome)}</strong>
            <span>📞 ${log.telefone || '-'} ${log.bairro ? '📍 ' + escapeHtml(log.bairro) : ''}</span>
            <span class="log-metodo">Método: ${log.metodo || '-'} ${log.detalhes ? '| ' + log.detalhes : ''}</span>
          </div>
          <span class="log-timestamp">${ts}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    lista.innerHTML = `<div class="erro-msg">Erro: ${err.message}</div>`;
  }
}

async function limparLog() {
  if (!confirm('Limpar todo o log de envio?')) return;
  await api('/api/log-envios/limpar', { method: 'POST' });
  notificar('🗑️ Log limpo!', 'info');
  atualizarLogModal();
}

// ========== TERMINAL LOG ==========
let terminalMinimizado = false;

function adicionarLinhaTerminal(dados) {
  const body = document.getElementById('terminalBody');
  const panel = document.getElementById('terminalLog');
  if (!body || !panel) return;
  panel.style.display = 'block';
  const line = document.createElement('div');
  line.className = `log-line log-${dados.tipo}`;
  line.textContent = `[${dados.hora}] ${dados.texto}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  // Mantém últimas 200 linhas
  while (body.children.length > 200) body.removeChild(body.firstChild);
}

function limparTerminal() {
  const body = document.getElementById('terminalBody');
  if (body) body.innerHTML = '';
}

function toggleTerminal() {
  const body = document.getElementById('terminalBody');
  const panel = document.getElementById('terminalLog');
  if (!body || !panel) return;
  terminalMinimizado = !terminalMinimizado;
  body.style.display = terminalMinimizado ? 'none' : 'block';
}

// ========== IMAGEM ==========
async function uploadImagem() {
  const input = document.getElementById('inputImagem');
  if (!input.files.length) return;
  const form = new FormData();
  form.append('imagem', input.files[0]);
  try {
    const res = await fetch('/api/upload-imagem', { method: 'POST', body: form });
    const data = await res.json();
    if (data.sucesso) {
      notificar('🖼️ Imagem carregada: ' + data.nome, 'sucesso');
      atualizarInfoImagem();
    } else {
      notificar('❌ ' + (data.error || 'Erro ao upload'), 'erro');
    }
  } catch (err) {
    notificar('❌ Erro ao enviar imagem', 'erro');
  }
  input.value = '';
}

async function removerImagem() {
  await fetch('/api/imagem', { method: 'DELETE' });
  atualizarInfoImagem();
  notificar('🗑️ Imagem removida', 'info');
}

async function atualizarInfoImagem() {
  try {
    const res = await fetch('/api/imagem');
    const data = await res.json();
    const info = document.getElementById('imagemInfo');
    const btnRm = document.getElementById('btnRemoverImagem');
    if (!info) return;
    if (data.existe) {
      info.innerHTML = `<div class="imagem-preview"><img src="/api/imagem-file?t=${Date.now()}"><br><small>${data.nome}</small></div>`;
      if (btnRm) btnRm.style.display = 'inline-flex';
    } else {
      info.innerHTML = 'Nenhuma imagem';
      if (btnRm) btnRm.style.display = 'none';
    }
  } catch {}
}

// Auto-load imagem status on startup
setTimeout(atualizarInfoImagem, 1000);
