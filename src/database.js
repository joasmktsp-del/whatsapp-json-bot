const fs = require('fs');
const path = require('path');

const STORAGE_FILE = path.join(__dirname, '..', 'storage', 'clientes.json');
const CONFIG_FILE = path.join(__dirname, '..', 'storage', 'config.json');
const LOG_FILE = path.join(__dirname, '..', 'storage', 'log_envio.json');
const FILA_IDS_FILE = path.join(__dirname, '..', 'storage', 'fila_ids.json');

const DEFAULTS = {
  status: ['pendente', 'aprovado', 'na_fila', 'enviado', 'respondeu', 'erro', 'sem_telefone', 'duplicado', 'optout'],
  delay_entre_envios_ms: 8000,
  max_por_dia: 50,
  palavras_optout: ['não', 'nao', 'pare', 'parar', 'remover', 'tirar', 'sair', 'cancelar', 'stop', 'bloqueia', 'bloquear', 'optout']
};

function carregarClientes() {
  if (!fs.existsSync(STORAGE_FILE)) return [];
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf-8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function salvarClientes(clientes) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(clientes, null, 2), 'utf-8');
}

function carregarConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function salvarConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function buscarCliente(id) {
  const clientes = carregarClientes();
  return clientes.find(c => c.id === id) || null;
}

function atualizarCliente(id, dados) {
  const clientes = carregarClientes();
  const idx = clientes.findIndex(c => c.id === id);
  if (idx === -1) return null;
  clientes[idx] = { ...clientes[idx], ...dados, atualizado_em: new Date().toISOString() };
  salvarClientes(clientes);
  return clientes[idx];
}

function excluirCliente(id) {
  const clientes = carregarClientes();
  const idx = clientes.findIndex(c => c.id === id);
  if (idx === -1) return null;
  const removido = clientes.splice(idx, 1)[0];
  salvarClientes(clientes);
  return removido;
}

function contarPorStatus() {
  const clientes = carregarClientes();
  const contagem = {};
  for (const s of DEFAULTS.status) contagem[s] = 0;
  for (const c of clientes) {
    contagem[c.status] = (contagem[c.status] || 0) + 1;
  }
  contagem.total = clientes.length;
  return contagem;
}

function clientesPorStatus(status) {
  const clientes = carregarClientes();
  if (!status || status === 'todos') return clientes;
  return clientes.filter(c => c.status === status);
}

function clientesEnviaveis() {
  return carregarClientes().filter(c =>
    c.status === 'aprovado' || c.status === 'na_fila'
  );
}

// ========== LOG DE ENVIO ==========

function carregarLogEnvios() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function salvarLogEnvios(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
}

function adicionarLogEnvio(entry) {
  const logs = carregarLogEnvios();
  logs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString()
  });
  salvarLogEnvios(logs);
  return logs[0];
}

function limparLogEnvios() {
  salvarLogEnvios([]);
}

// ========== FILA PERSISTENCE ==========

function salvarFilaIds(ids) {
  fs.writeFileSync(FILA_IDS_FILE, JSON.stringify(ids, null, 2), 'utf-8');
}

function carregarFilaIds() {
  if (!fs.existsSync(FILA_IDS_FILE)) return [];
  try {
    const raw = fs.readFileSync(FILA_IDS_FILE, 'utf-8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

module.exports = {
  carregarClientes,
  salvarClientes,
  carregarConfig,
  salvarConfig,
  buscarCliente,
  atualizarCliente,
  excluirCliente,
  contarPorStatus,
  clientesPorStatus,
  clientesEnviaveis,
  carregarLogEnvios,
  adicionarLogEnvio,
  limparLogEnvios,
  salvarFilaIds,
  carregarFilaIds,
  DEFAULTS
};
