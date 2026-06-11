const fs = require('fs');
const path = require('path');
const db = require('./database');

const DATA_FILE = path.join(__dirname, '..', 'data', 'messages_bar_tatuap.json');
const STORAGE_FILE = path.join(__dirname, '..', 'storage', 'clientes.json');

/**
 * Lê o JSON de entrada e importa para storage/clientes.json
 * - Normaliza telefone para 55 + DDD + número
 * - Remove duplicados por telefone (entre si e com storage existente)
 * - Marca sem_telefone se vazio
 * - Usa SOMENTE campo "mensagem" do JSON (não gera com IA)
 */
function importar() {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const input = JSON.parse(raw);
  const existentes = db.carregarClientes();

  // Mapa de telefones já em storage (para não duplicar)
  const telefonesExistentes = new Set();
  for (const c of existentes) {
    if (c.telefone) telefonesExistentes.add(c.telefone);
  }

  // Mapa de telefones já no input atual (para evitar duplicatas intra-lote)
  const telefonesLote = new Set();

  const adicionados = [];
  const ignorados = [];
  let countSemTel = 0;

  for (const c of input) {
    const telefone = normalizarTelefone(c.telefone || c.telefone_raw || '');

    if (!telefone) {
      // Sem telefone: sempre importa (não tem como comparar duplicata)
      adicionados.push(criarEntrada(c, null, 'sem_telefone'));
      countSemTel++;
      continue;
    }

    // Já existe em storage?
    if (telefonesExistentes.has(telefone)) {
      ignorados.push({ nome: c.nome, motivo: 'ja_existente_storage' });
      continue;
    }

    // Já foi importado neste lote?
    if (telefonesLote.has(telefone)) {
      ignorados.push({ nome: c.nome, motivo: 'duplicado_lote' });
      continue;
    }

    telefonesExistentes.add(telefone);
    telefonesLote.add(telefone);
    adicionados.push(criarEntrada(c, telefone, 'pendente'));
  }

  const todos = [...existentes, ...adicionados];
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(todos, null, 2), 'utf-8');

  return {
    total_input: input.length,
    adicionados: adicionados.length,
    ja_existiam: existentes.length,
    ignorados_ja_existiam: ignorados.filter(i => i.motivo === 'ja_existente_storage').length,
    ignorados_duplicados_lote: ignorados.filter(i => i.motivo === 'duplicado_lote').length,
    sem_telefone: countSemTel,
    total_storage: todos.length,
    ignorados_detalhes: ignorados.slice(0, 5).map(i => i.nome)
  };
}

function criarEntrada(c, telefone, status) {
  return {
    id: gerarId(),
    nome: c.nome || 'Sem nome',
    telefone,
    telefone_raw: c.telefone || '',
    endereco: c.endereco || '',
    bairro: c.bairro || '',
    tipo: c.tipo || '',
    nota: c.nota || '',
    tags: c.tags || '',
    mensagem: c.mensagem || '',
    status,
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString()
  };
}

function normalizarTelefone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55')) return digits;
  if (digits.length >= 10) return '55' + digits;
  return null;
}

function gerarId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// Executar diretamente
if (require.main === module) {
  // Limpa storage para fresh start
  const result = importar();
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Importa cliente de um objeto JavaScript (recebido via upload UI)
 * Mesma lógica do importar() mas sem ler arquivo
 */
function importarDeObjeto(input) {
  const existentes = db.carregarClientes();

  const telefonesExistentes = new Set();
  for (const c of existentes) {
    if (c.telefone) telefonesExistentes.add(c.telefone);
  }

  const telefonesLote = new Set();
  const adicionados = [];
  const ignorados = [];
  let countSemTel = 0;

  for (const c of input) {
    const telefone = normalizarTelefone(c.telefone || c.telefone_raw || '');

    if (!telefone) {
      adicionados.push(criarEntrada(c, null, 'sem_telefone'));
      countSemTel++;
      continue;
    }

    if (telefonesExistentes.has(telefone)) {
      ignorados.push({ nome: c.nome, motivo: 'ja_existente_storage' });
      continue;
    }

    if (telefonesLote.has(telefone)) {
      ignorados.push({ nome: c.nome, motivo: 'duplicado_lote' });
      continue;
    }

    telefonesExistentes.add(telefone);
    telefonesLote.add(telefone);
    adicionados.push(criarEntrada(c, telefone, 'pendente'));
  }

  const todos = [...existentes, ...adicionados];
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(todos, null, 2), 'utf-8');

  return {
    total_input: input.length,
    adicionados: adicionados.length,
    ja_existiam: existentes.length,
    ignorados_ja_existiam: ignorados.filter(i => i.motivo === 'ja_existente_storage').length,
    ignorados_duplicados_lote: ignorados.filter(i => i.motivo === 'duplicado_lote').length,
    sem_telefone: countSemTel,
    total_storage: todos.length,
    ignorados_detalhes: ignorados.slice(0, 5).map(i => i.nome)
  };
}

module.exports = { importar, normalizarTelefone, importarDeObjeto };
