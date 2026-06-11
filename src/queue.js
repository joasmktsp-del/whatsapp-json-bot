const EventEmitter = require('events');
const db = require('./database');

class FilaDeEnvio extends EventEmitter {
  constructor() {
    super();
    this.fila = [];
    this.rodando = false;
    this.timer = null;
    this.enviosHoje = 0;
    this.diaAtual = new Date().toDateString();
    this.config = db.carregarConfig();
  }

  /**
   * Adiciona clientes à fila (status -> na_fila)
   */
  enfileirar(ids) {
    const clientes = db.carregarClientes();
    let count = 0;
    for (const id of ids) {
      const idx = clientes.findIndex(c => c.id === id);
      if (idx === -1) continue;
      if (clientes[idx].status !== 'aprovado') continue;
      clientes[idx].status = 'na_fila';
      clientes[idx].enfileirado_em = new Date().toISOString();
      clientes[idx].atualizado_em = clientes[idx].enfileirado_em;
      this.fila.push(clientes[idx]);
      count++;
    }
    db.salvarClientes(clientes);
    this._persistirFila();
    this.emit('fila_atualizada', { na_fila: this.fila.length, adicionados: count });
    return count;
  }

  /**
   * Inicia o disparo
   */
  iniciar() {
    if (this.rodando) return;
    this.rodando = true;
    this.config = db.carregarConfig();
    this._verificarLimiteDiario();
    this.emit('status', { rodando: true });
    this._processarProximo();
  }

  /**
   * Dispara a fila (se já enfileirado)
   */
  disparar() {
    if (this.rodando) return { sucesso: false, motivo: 'ja_rodando' };
    if (this.fila.length === 0) return { sucesso: false, motivo: 'fila_vazia' };
    this.iniciar();
    return { sucesso: true };
  }

  /**
   * Limpa toda a fila (volta status para aprovado)
   */
  limpar() {
    for (const c of this.fila) {
      db.atualizarCliente(c.id, { status: 'aprovado' });
    }
    this.fila = [];
    this._persistirFila();
    this.rodando = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('status', { rodando: false });
    this.emit('fila_atualizada', { na_fila: 0 });
  }

  /**
   * Pausa o disparo
   */
  pausar() {
    this.rodando = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('status', { rodando: false });
  }

  /**
   * Remove um cliente da fila (sem emitir socket event)
   */
  removerDaFilaSilencioso(id) {
    this.fila = this.fila.filter(c => c.id !== id);
    this._persistirFila();
  }

  /**
   * Remove um cliente da fila
   */
  removerDaFila(id) {
    this.fila = this.fila.filter(c => c.id !== id);
    this._persistirFila();
    db.atualizarCliente(id, { status: 'aprovado' });
    this.emit('fila_atualizada', { na_fila: this.fila.length });
  }

  /**
   * Callback quando mensagem é enviada
   */
  marcarEnviado(id, resultado) {
    const atualizado = db.atualizarCliente(id, {
      status: resultado.erro ? 'erro' : 'enviado',
      enviado_em: resultado.erro ? null : new Date().toISOString(),
      erro: resultado.erro || null
    });
    // Remove da fila
    this.fila = this.fila.filter(c => c.id !== id);
    this._persistirFila();
    this.emit('fila_atualizada', { na_fila: this.fila.length });
    return atualizado;
  }

  /**
   * Callback quando resposta chega
   */
  marcarResposta(id, texto) {
    const config = db.carregarConfig();
    const palavrasOptout = config.palavras_optout || [];
    const lower = texto.toLowerCase();
    const ehOptout = palavrasOptout.some(p => lower.includes(p));
    const novoStatus = ehOptout ? 'optout' : 'respondeu';
    return db.atualizarCliente(id, {
      status: novoStatus,
      resposta: texto,
      respondeu_em: new Date().toISOString()
    });
  }

  /**
   * Adiciona um cliente já em na_fila diretamente (vindo do Aprovar)
   */
  adicionarNaFila(cliente) {
    // Evita duplicata
    if (this.fila.some(c => c.id === cliente.id)) return;
    this.fila.push(cliente);
    this._persistirFila();
    this.emit('fila_atualizada', { na_fila: this.fila.length });
  }

  /**
   * Retorna lista detalhada da fila ordenada por enfileirado_em (mais antigo primeiro)
   */
  /**
   * Restaura fila da storage após reinício do servidor
   * Clientes com status 'na_fila' voltam para a fila em memória
   */
  restaurarDaStorage() {
    const ids = db.carregarFilaIds();
    const todosClientes = db.carregarClientes();
    const matching = ids.length > 0
      ? todosClientes.filter(c => ids.includes(c.id))
      : [];
    this.fila = matching;
    this.enviosHoje = 0;
    this.diaAtual = new Date().toDateString();
    this.rodando = false;
    if (matching.length > 0) {
      console.log(`  ♻️ Fila restaurada: ${matching.length} cliente(s) da fila_ids.json`);
    }
    this.emit('fila_atualizada', { na_fila: this.fila.length });
    this.emit('status', { rodando: false, na_fila: this.fila.length });
  }

  getFilaDetalhada() {
    const ordenados = [...this.fila].sort((a, b) => {
      const ta = a.enfileirado_em || a.atualizado_em || '';
      const tb = b.enfileirado_em || b.atualizado_em || '';
      return ta.localeCompare(tb);
    });
    return ordenados.map(c => ({
      id: c.id,
      nome: c.nome,
      telefone: c.telefone,
      bairro: c.bairro,
      status: c.status,
      enfileirado_em: c.enfileirado_em || c.atualizado_em
    }));
  }

  getStatusFila() {
    return {
      rodando: this.rodando,
      tamanho: this.fila.length,
      na_fila: this.fila.length,
      enviosHoje: this.enviosHoje,
      limiteDiario: this.config.max_por_dia
    };
  }

  // ========== PRIVADO ==========

  _persistirFila() {
    db.salvarFilaIds(this.fila.map(c => c.id));
  }

  _processarProximo() {
    if (!this.rodando) return;
    if (this._verificarLimiteDiario()) return;

    const cliente = this.fila[0];
    if (!cliente) {
      this.rodando = false;
      this.emit('status', { rodando: false, motivo: 'fila_vazia' });
      this.emit('fila_concluida');
      return;
    }

    this.emit('enviar', cliente);
  }

  _verificarLimiteDiario() {
    const hoje = new Date().toDateString();
    if (hoje !== this.diaAtual) {
      this.diaAtual = hoje;
      this.enviosHoje = 0;
    }
    if (this.enviosHoje >= this.config.max_por_dia) {
      this.rodando = false;
      this.emit('status', { rodando: false, motivo: 'limite_diario' });
      return true;
    }
    return false;
  }

  _proximoAposEnvio() {
    this.enviosHoje++;
    this.config = db.carregarConfig();
    const delay = this.config.delay_entre_envios_ms || 8000;
    this.emit('progresso', {
      enviados: this.enviosHoje,
      restantes: this.fila.length,
      limite: this.config.max_por_dia
    });
    this.timer = setTimeout(() => this._processarProximo(), delay);
  }

  /**
   * Chamado externamente quando o envio foi concluído
   */
  confirmarEnvio(cliente, resultado) {
    this.marcarEnviado(cliente.id, resultado);
    this._proximoAposEnvio();
  }
}

module.exports = new FilaDeEnvio();
