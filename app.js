(() => {
  "use strict";

  const TICK_INTERVAL = 3000;
  const INITIAL_CAPITAL = 125000;
  const PREFERENCES_KEY = "b3-ai-trader.preferences.v1";
  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const signedMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", signDisplay: "exceptZero" });
  const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const shortClock = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const shortDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
  const fullDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });

  const instruments = {
    PETR4: { name: "Petrobras PN", initial: 38.72, previousClose: 38.18, tick: .01, decimals: 2, multiplier: 1, volatility: .04, avatar: "P", unit: "ações" },
    VALE3: { name: "Vale ON", initial: 62.84, previousClose: 62.44, tick: .01, decimals: 2, multiplier: 1, volatility: .06, avatar: "V", unit: "ações" },
    WINFUT: { name: "Mini-índice · contrato contínuo", initial: 130280, previousClose: 130555, tick: 5, decimals: 0, multiplier: .2, volatility: 65, avatar: "W", unit: "contratos" },
    WDOFUT: { name: "Minidólar · contrato contínuo", initial: 5681.5, previousClose: 5663, tick: .5, decimals: 1, multiplier: 10, volatility: 2, avatar: "$", unit: "contratos" },
    ITUB4: { name: "Itaú Unibanco PN", initial: 35.18, previousClose: 35.36, tick: .01, decimals: 2, multiplier: 1, volatility: .03, avatar: "I", unit: "ações" }
  };
  const modalities = { day: "Day Trade", swing: "Swing Trade", analysis: "Análise / Alertas" };
  const routes = {
    dashboard: ["Visão geral", "Uma visão completa do seu capital em movimento."],
    agents: ["Agentes e estratégias", "Inteligência autônoma, com você no controle."],
    analysis: ["Gráficos e análise", "Preço, volume e contexto para acompanhar suas estratégias."],
    history: ["Histórico de ordens", "Cada execução, do primeiro sinal ao resultado."],
    settings: ["API e corretora", "Sua infraestrutura, seus limites, suas regras."]
  };
  const defaultPreferences = { restUrl: "http://localhost:8000", wsUrl: "ws://localhost:8000/ws", dailyLossLimit: 1500, exposureLimit: 100 };
  const histories = new Map();
  let chart = null;
  let timer = null;
  let confirmAction = null;
  let navigationOpen = false;
  const mobileQuery = window.matchMedia("(max-width: 768px)");

  function number(value, decimals = 2, signed = false) {
    return new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: signed ? "exceptZero" : "auto"
    }).format(value);
  }

  function currency(value, signed = false) {
    const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
    return (signed ? signedMoney : money).format(Object.is(rounded, -0) ? 0 : rounded);
  }

  function priceText(symbol, price) {
    const instrument = instruments[symbol];
    return instrument.unit === "ações" ? currency(price) : `${number(price, instrument.decimals)} pts`;
  }

  function roundToTick(value, symbol) {
    const instrument = instruments[symbol];
    return Number((Math.round(value / instrument.tick) * instrument.tick).toFixed(instrument.decimals));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function icon(name, extraClass = "") {
    return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function setText(id, text) {
    const element = $(id);
    if (element.textContent !== text) element.textContent = text;
  }

  function signedClass(value) {
    return value > 0 ? "positive" : value < 0 ? "negative" : "muted";
  }

  function setSigned(element, value, text = currency(value, true)) {
    element.textContent = text;
    element.classList.remove("positive", "negative", "muted");
    element.classList.add(signedClass(value));
  }

  function flash(element, value) {
    const previous = element.dataset.previousValue;
    if (previous !== undefined && Number(previous) !== value && !document.hidden) {
      element.classList.remove("flash-up", "flash-down");
      void element.offsetWidth;
      element.classList.add(value > Number(previous) ? "flash-up" : "flash-down");
    }
    element.dataset.previousValue = String(value);
  }

  function toast(message, error = false) {
    const element = document.createElement("div");
    element.className = `toast${error ? " error" : ""}`;
    if (error) element.setAttribute("role", "alert");
    element.innerHTML = `${icon(error ? "warning" : "check")}<p>${escapeHtml(message)}</p><button class="icon-button" aria-label="Dispensar notificação">${icon("close")}</button>`;
    element.querySelector("button").addEventListener("click", () => element.remove());
    $("toast-container").append(element);
    while ($("toast-container").children.length > 3) $("toast-container").firstElementChild.remove();
    window.setTimeout(() => element.remove(), error ? 10000 : 6000);
  }

  function formError(id, message = "") {
    $(id).textContent = message;
    $(id).hidden = !message;
  }

  function parseEndpoint(value, protocols) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Informe um endereço completo.");
    const url = new URL(value.trim());
    if (!protocols.includes(url.protocol)) throw new Error(`Use o protocolo ${protocols.join(" ou ")}.`);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Use endereços sem credenciais, parâmetros ou fragmentos.");
    }
    return value.trim();
  }

  function loadPreferences() {
    try {
      const saved = localStorage.getItem(PREFERENCES_KEY);
      if (!saved) return { ...defaultPreferences };
      const preferences = JSON.parse(saved);
      if (!preferences || typeof preferences !== "object"
        || !Number.isInteger(preferences.dailyLossLimit) || preferences.dailyLossLimit < 1 || preferences.dailyLossLimit > INITIAL_CAPITAL
        || !Number.isInteger(preferences.exposureLimit) || preferences.exposureLimit < 1 || preferences.exposureLimit > 200) {
        throw new Error("Formato ou limites inválidos nas preferências locais.");
      }
      return {
        restUrl: parseEndpoint(preferences.restUrl, ["http:", "https:"]),
        wsUrl: parseEndpoint(preferences.wsUrl, ["ws:", "wss:"]),
        dailyLossLimit: preferences.dailyLossLimit,
        exposureLimit: preferences.exposureLimit
      };
    } catch (error) {
      console.warn("Não foi possível restaurar as preferências:", error);
      toast("Não foi possível ler as preferências locais. Os valores padrão foram carregados para esta sessão.", true);
      return { ...defaultPreferences };
    }
  }

  function savePreferences(preferences, errorId) {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      state.preferences = preferences;
      formError(errorId);
      return true;
    } catch (error) {
      console.error("Não foi possível persistir as preferências:", error);
      formError(errorId, "O navegador bloqueou o armazenamento local. Nada foi salvo; verifique as permissões e tente novamente.");
      return false;
    }
  }

  function createSessionTime() {
    const date = new Date();
    date.setUTCHours(17, 32, 18, 0);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
    return date.getTime();
  }

  // REST futuro: GET /api/dashboard deve fornecer o snapshot validado de
  // carteira, cotações, agentes, posições e ordens no lugar deste estado fictício.
  // Nunca exponha tokens da corretora no HTML, no JS ou no localStorage.
  function createInitialState() {
    const now = createSessionTime();
    const agents = [
      { id: "alpha", name: "Mini-índice Alpha", strategy: "Cruzamento de médias", symbol: "WINFUT", modality: "day", realized: 1045.4, lossLimit: 1200, paused: false, color: "", icon: "chart" },
      { id: "petro", name: "Petro Momentum", strategy: "Price Action + Sentimento", symbol: "PETR4", modality: "day", realized: 482.24, lossLimit: 600, paused: false, color: "teal", icon: "trend" },
      { id: "swing", name: "Swing Compass", strategy: "Momentum + Tendência", symbol: "VALE3", modality: "swing", realized: 798.68, lossLimit: 900, paused: false, color: "blue", icon: "chart" },
      { id: "radar", name: "Radar de Mercado", strategy: "Suporte e resistência", symbol: "WDOFUT", modality: "analysis", realized: 0, lossLimit: 350, paused: false, color: "amber", icon: "search" },
      { id: "reversion", name: "Reversão Quant", strategy: "Reversão à média", symbol: "ITUB4", modality: "day", realized: -72, lossLimit: 500, paused: true, color: "gray", icon: "history" }
    ];
    const positions = [
      { id: "pos-1", symbol: "WINFUT", agentId: "alpha", side: "buy", quantity: 2, entry: 130025, stop: 129825, take: 130900 },
      { id: "pos-2", symbol: "PETR4", agentId: "petro", side: "buy", quantity: 100, entry: 38.44, stop: 38.12, take: 39.2 },
      { id: "pos-3", symbol: "VALE3", agentId: "swing", side: "buy", quantity: 100, entry: 62.1, stop: 61.65, take: 64.1 }
    ];
    const closedOrders = agents.filter((agent) => agent.realized !== 0).map((agent, index) => ({
      id: `ord-${index + 1}`, time: now - (index + 2) * 600000, symbol: agent.symbol,
      side: "sell", kind: "Saída", quantity: agent.symbol === "WINFUT" ? 2 : 100,
      price: instruments[agent.symbol].initial, realized: agent.realized, origin: agent.name
    }));
    closedOrders.push({
      id: "ord-5", time: now - 4800000, symbol: "PETR4", side: "buy", kind: "Saída",
      quantity: 100, price: 38.2, realized: 0, origin: "Petro Momentum"
    });
    const openingOrders = positions.map((position, index) => ({
      id: `ord-${index + 6}`, time: now - (index + 1) * 150000, symbol: position.symbol,
      side: position.side, kind: "Entrada", quantity: position.quantity, price: position.entry,
      realized: null, origin: agents.find((agent) => agent.id === position.agentId).name
    }));
    return {
      now, page: "dashboard", symbol: "PETR4", timeframe: "5m", chartStyle: "candles", filter: "all",
      agents, positions, orders: [...openingOrders, ...closedOrders].sort((a, b) => b.time - a.time),
      quotes: Object.fromEntries(Object.entries(instruments).map(([symbol, instrument]) => [symbol, { price: instrument.initial }])),
      manualRealized: 0, sequence: 20, tickCount: 0, logsPaused: false, logFilter: "all",
      lastTickAt: performance.now(), preferences: loadPreferences(),
      logs: [
        { time: now - 18000, level: "system", source: "ENGINE", message: "Simulador iniciado. 5 estratégias carregadas; 4 agentes ativos." },
        { time: now - 15000, level: "signal", source: "PETRO", message: "Suporte de referência em R$ 38,44. Monitorando confirmação de volume." },
        { time: now - 12000, level: "order", source: "ALPHA", message: "Posição comprada: 2 contratos WINFUT. Stop e alvo registrados." },
        { time: now - 9000, level: "signal", source: "SWING", message: "VALE3 acima da média de referência. Acompanhando a posição." },
        { time: now - 6000, level: "risk", source: "RISK MANAGER", message: "Proteções de 3 posições monitoradas. Nenhuma ordem real será enviada." },
        { time: now - 3000, level: "signal", source: "RADAR", message: "WDOFUT em observação. Aguardando um novo sinal simulado." }
      ]
    };
  }

  const state = createInitialState();

  function positionPnl(position) {
    const direction = position.side === "buy" ? 1 : -1;
    return (state.quotes[position.symbol].price - position.entry) * position.quantity * instruments[position.symbol].multiplier * direction;
  }

  function agentPnl(agent) {
    return agent.realized + state.positions.filter((position) => position.agentId === agent.id).reduce((sum, position) => sum + positionPnl(position), 0);
  }

  function statistics() {
    const realized = state.agents.reduce((sum, agent) => sum + agent.realized, state.manualRealized);
    const unrealized = state.positions.reduce((sum, position) => sum + positionPnl(position), 0);
    const exposure = state.positions.reduce((sum, position) => sum + state.quotes[position.symbol].price * position.quantity * instruments[position.symbol].multiplier, 0);
    return { realized, unrealized, exposure, dailyPnl: realized + unrealized, balance: INITIAL_CAPITAL + realized + unrealized };
  }

  function agentStatus(agent) {
    if (agent.paused) return { text: "Pausado", className: "badge-neutral" };
    if (state.positions.some((position) => position.agentId === agent.id)) return { text: "Operando", className: "badge-positive" };
    if (agent.modality === "analysis") return { text: "Aguardando sinal", className: "badge-warning" };
    return { text: "Ativo", className: "badge-blue" };
  }

  function marketOpen(timestamp = state.now) {
    const date = new Date(timestamp);
    return date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && date.getUTCHours() >= 13 && date.getUTCHours() < 20;
  }

  function renderSummary() {
    const stats = statistics();
    const active = state.agents.filter((agent) => !agent.paused);
    const operating = active.filter((agent) => state.positions.some((position) => position.agentId === agent.id)).length;
    const performancePercent = stats.dailyPnl / INITIAL_CAPITAL * 100;
    const exposurePercent = stats.balance > 0 ? stats.exposure / stats.balance * 100 : 0;
    setText("total-balance", currency(stats.balance));
    setText("header-balance", currency(stats.balance));
    setSigned($("daily-pnl"), stats.dailyPnl);
    setSigned($("header-pnl"), stats.dailyPnl, `${currency(stats.dailyPnl, true)} · ${number(performancePercent, 2, true)}%`);
    setSigned($("daily-pnl-percent"), performancePercent, `${number(performancePercent, 2, true)}%`);
    setSigned($("balance-return"), performancePercent, `${number(performancePercent, 2, true)}%`);
    flash($("balance-card"), stats.balance);
    flash($("pnl-card"), stats.dailyPnl);
    setText("active-agent-count", String(active.length).padStart(2, "0"));
    setText("total-agent-count", String(state.agents.length).padStart(2, "0"));
    setText("header-agent-count", `${active.length}/${state.agents.length} ativos`);
    setText("nav-agent-count", String(state.agents.length));
    setText("agent-summary", active.length ? `${operating} operando · ${active.length - operating} monitorando` : "Todos os agentes pausados");
    $("agent-dots").innerHTML = state.agents.map((agent) => `<i class="${agent.paused ? "" : "running"}"></i>`).join("");
    setText("total-exposure", currency(stats.exposure));
    setText("exposure-summary", `${state.positions.length} ${state.positions.length === 1 ? "posição" : "posições"} · ${number(exposurePercent, 1)}% da banca`);
    $("exposure-progress").style.width = `${Math.min(100, Math.max(0, exposurePercent))}%`;
    $("exposure-progress").style.background = exposurePercent > state.preferences.exposureLimit ? "var(--red)" : "";
    $("kill-switch").disabled = active.length === 0;
    setText("kill-switch-text", active.length ? "Pausar todos os agentes" : "Todos os agentes pausados");
    setText("position-count", String(state.positions.length));
    setSigned($("open-pnl"), stats.unrealized);
    setText("history-total", String(state.orders.length));
    setSigned($("history-realized"), stats.realized);
    setText("session-date", fullDate.format(state.now));
    setText("last-update", clock.format(state.now));
    $("last-update").dateTime = new Date(state.now).toISOString();
    const open = marketOpen();
    $("market-status").classList.toggle("closed", !open);
    setText("market-status-text", open ? "Mercado aberto" : "Mercado fechado");
  }

  function renderAgents() {
    const agents = state.agents.filter((agent) => state.filter === "all" || agent.modality === state.filter);
    document.querySelectorAll("[data-agent-filters] button").forEach((button) => {
      const selected = button.dataset.filter === state.filter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("dashboard-agents").innerHTML = agents.map((agent) => {
      const status = agentStatus(agent);
      const pnl = agentPnl(agent);
      return `<tr data-agent-row="${agent.id}">
        <td><div class="agent-cell"><span class="agent-avatar ${agent.color}">${icon(agent.icon)}</span><div><div class="agent-name">${escapeHtml(agent.name)}</div><span class="agent-strategy">${escapeHtml(agent.strategy)}</span></div></div></td>
        <td><span class="symbol-tag">${agent.symbol}</span></td>
        <td><span class="badge ${status.className}" data-agent-status="${agent.id}">${status.text}</span></td>
        <td class="align-right"><span class="agent-pnl ${signedClass(pnl)}" data-agent-pnl="${agent.id}">${currency(pnl, true)}</span></td>
        <td><div class="row-actions"><button class="icon-button ${agent.paused ? "resume-button" : ""}" data-action="toggle-agent" data-agent-id="${agent.id}" aria-label="${agent.paused ? "Retomar" : "Pausar"} ${escapeHtml(agent.name)}" title="${agent.paused ? "Retomar" : "Pausar"} agente">${icon(agent.paused ? "play" : "pause")}</button><button class="icon-button" data-action="configure-agent" data-agent-id="${agent.id}" aria-label="Configurar ${escapeHtml(agent.name)}" title="Configurar agente">${icon("settings")}</button></div></td>
      </tr>`;
    }).join("") || '<tr><td colspan="5" class="empty-state">Nenhum agente nesta modalidade.</td></tr>';
    $("agent-detail-grid").innerHTML = agents.map((agent) => {
      const status = agentStatus(agent);
      const pnl = agentPnl(agent);
      return `<article class="panel agent-detail-card" data-agent-row="${agent.id}">
        <div class="agent-detail-header"><span class="agent-avatar ${agent.color}">${icon(agent.icon)}</span><span class="badge ${status.className}" data-agent-status="${agent.id}">${status.text}</span></div>
        <h2>${escapeHtml(agent.name)}</h2><p class="strategy-description">${escapeHtml(agent.strategy)}</p>
        <div class="agent-detail-meta"><span>${modalities[agent.modality]}</span><span class="symbol-tag">${agent.symbol}</span></div>
        <div class="agent-detail-result"><div><span>Resultado do dia</span><strong class="${signedClass(pnl)}" data-agent-pnl="${agent.id}">${currency(pnl, true)}</strong></div><span>PNL BRUTO</span></div>
        <p class="agent-risk-limit">Limite diário de perda: ${currency(agent.lossLimit)}</p>
        <div class="agent-detail-actions"><button class="button ${agent.paused ? "button-primary" : "button-secondary"}" data-action="toggle-agent" data-agent-id="${agent.id}">${icon(agent.paused ? "play" : "pause")}${agent.paused ? "Retomar" : "Pausar"}</button><button class="button button-secondary" data-action="configure-agent" data-agent-id="${agent.id}">${icon("settings")}Configurar</button></div>
      </article>`;
    }).join("") || '<div class="panel empty-state">Nenhum agente nesta modalidade.</div>';
    setText("filtered-agent-count", `${agents.length} ${agents.length === 1 ? "agente" : "agentes"}`);
  }

  function updateAgentValues() {
    state.agents.forEach((agent) => {
      const pnl = agentPnl(agent);
      document.querySelectorAll(`[data-agent-pnl="${agent.id}"]`).forEach((element) => {
        setSigned(element, pnl);
        flash(element.closest("[data-agent-row]"), pnl);
      });
      const status = agentStatus(agent);
      document.querySelectorAll(`[data-agent-status="${agent.id}"]`).forEach((element) => {
        element.className = `badge ${status.className}`;
        element.textContent = status.text;
      });
    });
  }

  function renderPositions() {
    $("positions-list").innerHTML = state.positions.map((position) => {
      const instrument = instruments[position.symbol];
      return `<article class="position-card" data-position-id="${position.id}">
        <div class="position-topline"><div class="position-symbol"><strong>${position.symbol}</strong><span class="side-tag ${position.side === "sell" ? "sell" : ""}">${position.side === "buy" ? "LONG" : "SHORT"}</span></div><span>${position.quantity} ${instrument.unit}</span></div>
        <div class="position-prices"><div><span>Entrada · ${instrument.unit === "ações" ? "R$" : "pts"}</span><strong>${number(position.entry, instrument.decimals)}</strong></div><div><span>Stop Loss</span><strong class="stop-price">${number(position.stop, instrument.decimals)}</strong></div><div><span>Take Profit</span><strong class="take-price">${number(position.take, instrument.decimals)}</strong></div></div>
        <div class="position-bottomline"><div class="position-profit"><strong data-position-pnl></strong><small data-position-mark></small></div><button class="close-position" data-action="close-position" data-position="${position.id}" aria-label="Zerar posição ${position.symbol}, ${position.quantity} ${instrument.unit}">Zerar posição</button></div>
      </article>`;
    }).join("") || `<div class="empty-state">${icon("shield")}<strong>Nenhuma posição aberta</strong>Seu capital está fora do mercado.<br>Use + para criar uma ordem simulada.</div>`;
    updatePositionValues();
  }

  function updatePositionValues() {
    state.positions.forEach((position) => {
      const card = document.querySelector(`[data-position-id="${position.id}"]`);
      const pnl = positionPnl(position);
      setSigned(card.querySelector("[data-position-pnl]"), pnl);
      card.querySelector("[data-position-mark]").textContent = `Atual: ${priceText(position.symbol, state.quotes[position.symbol].price)}`;
      flash(card, pnl);
    });
  }

  function pushLog(level, source, message) {
    state.logs.push({ time: state.now, level, source, message });
    if (state.logs.length > 120) state.logs.shift();
    renderLogs();
  }

  function renderLogs(force = false) {
    if (state.logsPaused && !force) return;
    const terminal = $("terminal");
    const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 60;
    const scrollPosition = terminal.scrollTop;
    const levels = { signal: "SINAL", order: "ORDEM", risk: "RISCO", system: "SISTEMA" };
    const logs = state.logs.filter((log) => state.logFilter === "all" || log.level === state.logFilter).slice(-35);
    terminal.innerHTML = logs.map((log) => `<div class="log-entry ${log.level}">
      <div class="log-meta"><time class="log-time">[${clock.format(log.time)}]</time><span class="log-label ${log.level}">${levels[log.level]}</span><span class="log-agent" title="${escapeHtml(log.source)}">${escapeHtml(log.source)}</span></div>
      <div class="log-message">${escapeHtml(log.message)}</div>
    </div>`).join("") || '<div class="empty-state">Nenhum evento para este filtro.</div>';
    terminal.scrollTop = force || nearBottom ? terminal.scrollHeight : scrollPosition;
  }

  function filteredOrders() {
    const search = $("history-search").value.trim().toLocaleLowerCase("pt-BR");
    const side = $("history-side").value;
    return state.orders.filter((order) => (side === "all" || order.side === side)
      && `${order.symbol} ${order.origin}`.toLocaleLowerCase("pt-BR").includes(search));
  }

  function renderHistory() {
    const orders = filteredOrders();
    $("history-body").innerHTML = orders.map((order) => `<tr>
      <td class="mono">${clock.format(order.time)}<small>${fullDate.format(order.time)}</small></td>
      <td><span class="symbol-tag">${order.symbol}</span></td>
      <td><span class="side-tag ${order.side === "sell" ? "sell" : ""}">${order.side === "buy" ? "COMPRA" : "VENDA"}</span><small>${escapeHtml(order.kind)}</small></td>
      <td class="align-right mono">${number(order.quantity, 0)}</td><td class="align-right mono">${priceText(order.symbol, order.price)}</td>
      <td class="align-right mono ${order.realized === null ? "muted" : signedClass(order.realized)}">${order.realized === null ? "—" : currency(order.realized, true)}</td>
      <td class="order-origin">${escapeHtml(order.origin)}</td><td><span class="badge badge-positive">Executada</span></td>
    </tr>`).join("") || '<tr><td colspan="8" class="empty-state">Nenhuma ordem encontrada. Altere a busca ou o filtro.</td></tr>';
    setText("history-results", `${orders.length} de ${state.orders.length} ordens`);
  }

  function csvCell(value) {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv(report = false) {
    const orders = report ? state.orders : filteredOrders();
    const rows = [];
    if (report) {
      const stats = statistics();
      rows.push(["RELATÓRIO DEMONSTRATIVO", "DADOS FICTÍCIOS — NÃO É NOTA DE CORRETAGEM"],
        ["Sessão simulada", `${fullDate.format(state.now)} ${clock.format(state.now)} BRT`],
        ["Banca inicial", currency(INITIAL_CAPITAL)], ["Patrimônio", currency(stats.balance)],
        ["Resultado realizado", currency(stats.realized)], ["Resultado não realizado", currency(stats.unrealized)],
        ["Resultado total", currency(stats.dailyPnl)], ["Exposição nocional", currency(stats.exposure)], []);
    }
    rows.push(["Data", "Horário BRT", "Ativo", "Direção", "Tipo", "Quantidade", "Preço", "PnL realizado R$", "Origem", "Ambiente"]);
    orders.forEach((order) => rows.push([
      fullDate.format(order.time), clock.format(order.time), order.symbol, order.side === "buy" ? "Compra" : "Venda",
      order.kind, order.quantity, number(order.price, instruments[order.symbol].decimals),
      order.realized === null ? "" : number(order.realized), order.origin, "Simulação"
    ]));
    const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report ? "relatorio" : "ordens"}-b3-demo-${new Date(state.now).toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${report ? "Relatório" : "Histórico filtrado"} exportado em CSV. Todos os valores são simulados.`);
  }

  function confirm(options, action) {
    confirmAction = action;
    setText("confirm-title", options.title);
    setText("confirm-description", options.description);
    setText("confirm-submit", options.button);
    $("confirm-detail").textContent = options.detail || "";
    $("confirm-detail").hidden = !options.detail;
    $("confirm-icon").innerHTML = icon(options.icon || "pause");
    $("confirm-dialog").returnValue = "cancel";
    $("confirm-dialog").showModal();
  }

  function pauseAll(reason = "Pausa global solicitada pelo operador.") {
    // REST futuro: POST /api/agents/pause-all. Confirme o ACK do servidor antes
    // de refletir sucesso e mantenha erros visíveis. O kill switch não zera posições.
    const active = state.agents.filter((agent) => !agent.paused);
    if (!active.length) return;
    active.forEach((agent) => { agent.paused = true; });
    pushLog("risk", "KILL SWITCH", `${reason} ${active.length} agentes pausados. Posições e stops continuam monitorados.`);
    renderAgents();
    renderSummary();
    toast(`${active.length} agentes pausados. As posições abertas não foram encerradas.`);
  }

  function toggleAgent(id) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) { toast("O agente não foi encontrado.", true); return; }
    if (agent.paused && (agentPnl(agent) <= -agent.lossLimit || statistics().dailyPnl <= -state.preferences.dailyLossLimit)) {
      toast("A retomada foi bloqueada pelo limite diário de perda. Revise os limites antes de continuar.", true);
      return;
    }
    // REST futuro: POST /api/agents/:id/pause ou /resume, com estado confirmado pelo backend.
    agent.paused = !agent.paused;
    pushLog("system", agent.name, agent.paused ? "Agente pausado pelo operador. Proteções das posições preservadas." : "Agente retomado. Monitoramento de sinais simulado habilitado.");
    renderAgents();
    renderSummary();
    const replacement = $(`page-${state.page}`).querySelector(`[data-action="toggle-agent"][data-agent-id="${id}"]`);
    if (replacement) replacement.focus({ preventScroll: true });
    toast(`${agent.name}: ${agent.paused ? "pausado" : "retomado"}.`);
  }

  function configureAgent(id) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) { toast("O agente não foi encontrado.", true); return; }
    $("agent-id").value = id;
    $("agent-name").value = agent.name;
    $("agent-strategy").value = agent.strategy;
    $("agent-loss-limit").value = agent.lossLimit;
    formError("agent-error");
    $("agent-dialog").showModal();
  }

  function enforceRiskLimits() {
    if (statistics().dailyPnl <= -state.preferences.dailyLossLimit) {
      pauseAll("Limite global de perda diária atingido.");
      return;
    }
    let changed = false;
    state.agents.forEach((agent) => {
      if (!agent.paused && agentPnl(agent) <= -agent.lossLimit) {
        agent.paused = true;
        changed = true;
        pushLog("risk", agent.name, `Limite de perda de ${currency(agent.lossLimit)} atingido. Agente pausado; posição e proteções permanecem ativas.`);
        toast(`${agent.name} foi pausado pelo limite de perda.`, true);
      }
    });
    if (changed) renderAgents();
  }

  function closePosition(id, reason = "Manual", notify = true) {
    const position = state.positions.find((item) => item.id === id);
    if (!position) { toast("Esta posição já foi encerrada pelo simulador.", true); return; }
    // REST futuro: POST /api/positions/:id/close. Use preço e PnL da execução
    // retornados pela corretora, não o preço da tela; trate rejeições e idempotência.
    const pnl = Math.round(positionPnl(position) * 100) / 100;
    const agent = state.agents.find((item) => item.id === position.agentId);
    if (agent) agent.realized += pnl;
    else state.manualRealized += pnl;
    state.orders.unshift({
      id: `ord-${++state.sequence}`, time: state.now, symbol: position.symbol,
      side: position.side === "buy" ? "sell" : "buy", kind: `Saída · ${reason}`,
      quantity: position.quantity, price: state.quotes[position.symbol].price,
      realized: pnl, origin: agent ? agent.name : "Manual"
    });
    state.positions = state.positions.filter((item) => item.id !== id);
    pushLog(reason === "Stop Loss" ? "risk" : "order", agent ? agent.name : "MANUAL", `${position.symbol} encerrado por ${reason.toLocaleLowerCase("pt-BR")}. Resultado bruto: ${currency(pnl, true)}.`);
    renderPositions();
    updateAgentValues();
    renderSummary();
    renderHistory();
    if (notify) toast(`Posição ${position.symbol} zerada na simulação. Resultado: ${currency(pnl, true)}.`);
  }

  function requestClosePosition(id) {
    const position = state.positions.find((item) => item.id === id);
    if (!position) { toast("Esta posição não está mais aberta.", true); return; }
    confirm({
      title: `Zerar posição em ${position.symbol}?`,
      description: "A saída será simulada a mercado. O resultado será calculado pelo preço disponível no momento da confirmação, sem taxas.",
      detail: `${position.quantity} ${instruments[position.symbol].unit} · PnL indicativo: ${currency(positionPnl(position), true)}`,
      button: "Zerar posição", icon: "close"
    }, () => {
      closePosition(id);
      enforceRiskLimits();
      renderSummary();
    });
  }

  function orderSide() {
    return $("order-form").querySelector('input[name="order-side"]:checked').value;
  }

  function resetOrderPrices() {
    const symbol = $("order-symbol").value;
    const instrument = instruments[symbol];
    const price = state.quotes[symbol].price;
    const buy = orderSide() === "buy";
    ["order-stop", "order-take"].forEach((id) => {
      $(id).step = String(instrument.tick);
      $(id).min = String(instrument.tick);
    });
    $("order-stop").value = roundToTick(price * (buy ? .99 : 1.01), symbol).toFixed(instrument.decimals);
    $("order-take").value = roundToTick(price * (buy ? 1.02 : .98), symbol).toFixed(instrument.decimals);
    $("order-quantity").max = instrument.unit === "ações" ? "100000" : "1000";
    setText("order-quantity-label", `Quantidade (${instrument.unit})`);
    formError("order-error");
    updateOrderPreview();
  }

  function updateOrderPreview() {
    const symbol = $("order-symbol").value;
    const price = state.quotes[symbol].price;
    const quantity = Number($("order-quantity").value);
    setText("order-reference-price", priceText(symbol, price));
    setText("order-estimate", Number.isFinite(quantity) && quantity > 0 ? currency(price * quantity * instruments[symbol].multiplier) : "—");
    const buy = orderSide() === "buy";
    setText("order-submit", buy ? "Simular compra" : "Simular venda");
    $("order-submit").className = `button ${buy ? "button-primary" : "button-danger-solid"}`;
  }

  function openOrder() {
    $("order-symbol").value = state.symbol;
    $("order-form").querySelector('input[value="buy"]').checked = true;
    $("order-quantity").value = instruments[state.symbol].unit === "ações" ? "100" : "1";
    resetOrderPrices();
    $("order-dialog").showModal();
  }

  function submitOrder(event) {
    event.preventDefault();
    if (!$("order-form").reportValidity()) return;
    const symbol = $("order-symbol").value;
    const side = orderSide();
    const quantity = Number($("order-quantity").value);
    const stop = Number($("order-stop").value);
    const take = Number($("order-take").value);
    const entry = state.quotes[symbol].price;
    const instrument = instruments[symbol];
    const stats = statistics();
    let error = "";
    if (!marketOpen()) error = "O mercado está fechado neste cenário simulado.";
    else if (!Number.isInteger(quantity) || quantity <= 0 || quantity > Number($("order-quantity").max)) error = "Informe uma quantidade inteira dentro do limite da boleta.";
    else if (![stop, take].every((price) => Number.isFinite(price) && price > 0 && Math.abs(price - roundToTick(price, symbol)) < 1e-8)) error = `Stop e alvo devem ser positivos e respeitar o incremento de ${number(instrument.tick, instrument.decimals)}.`;
    else if (side === "buy" ? !(stop < entry && take > entry) : !(stop > entry && take < entry)) error = side === "buy" ? "Na compra, o stop deve ficar abaixo do preço atual e o alvo acima dele." : "Na venda, o stop deve ficar acima do preço atual e o alvo abaixo dele.";
    else if (stats.dailyPnl <= -state.preferences.dailyLossLimit) error = "Novas ordens estão bloqueadas pelo limite diário de perda.";
    else if (stats.exposure + entry * quantity * instrument.multiplier > stats.balance * state.preferences.exposureLimit / 100) error = `A ordem excede o limite de exposição nocional de ${state.preferences.exposureLimit}% da banca. Reduza a quantidade ou revise os limites.`;
    formError("order-error", error);
    if (error) return;
    // REST futuro: POST /api/orders com identificador idempotente. Validação de
    // risco, autenticação e execução devem ocorrer novamente no backend Python.
    const position = { id: `pos-${++state.sequence}`, symbol, side, quantity, entry, stop, take, agentId: null };
    state.positions.push(position);
    state.orders.unshift({ id: `ord-${++state.sequence}`, time: state.now, symbol, side, quantity, price: entry, kind: "Entrada", realized: null, origin: "Manual" });
    pushLog("order", "MANUAL", `${side === "buy" ? "Compra" : "Venda"} simulada: ${quantity} ${instrument.unit} de ${symbol} a ${priceText(symbol, entry)}.`);
    renderPositions();
    renderHistory();
    renderSummary();
    $("order-dialog").close();
    toast(`Ordem simulada executada: ${side === "buy" ? "compra" : "venda"} de ${quantity} ${symbol}.`);
  }

  // O histórico usa sessões fictícias de 10h às 17h BRT, sem feriados da B3.
  // WINFUT/WDOFUT são séries contínuas demonstrativas, não códigos para envio de ordens reais.
  function currentBarTime(timestamp, timeframe) {
    const date = new Date(timestamp);
    const open = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 13);
    if (timeframe === "1D") return open;
    const minutes = { "1m": 1, "5m": 5, "15m": 15 }[timeframe];
    const duration = minutes * 60000;
    return Math.min(open + 7 * 3600000 - duration, open + Math.floor((timestamp - open) / duration) * duration);
  }

  function previousBarTime(timestamp, timeframe) {
    const date = new Date(timestamp);
    if (timeframe !== "1D") {
      const duration = { "1m": 60000, "5m": 300000, "15m": 900000 }[timeframe];
      const previous = timestamp - duration;
      if (new Date(previous).getUTCHours() >= 13) return previous;
      date.setUTCDate(date.getUTCDate() - 1);
      while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
      date.setUTCHours(20, 0, 0, 0);
      return date.getTime() - duration;
    }
    date.setUTCDate(date.getUTCDate() - 1);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
    return date.getTime();
  }

  function getSeries() {
    const key = `${state.symbol}:${state.timeframe}`;
    if (histories.has(key)) return histories.get(key).candles;
    const symbol = state.symbol;
    const price = state.quotes[symbol].price;
    const span = price * (state.timeframe === "1D" ? .09 : .012);
    const times = [currentBarTime(state.now, state.timeframe)];
    for (let index = 1; index < 56; index++) times.unshift(previousBarTime(times[0], state.timeframe));
    let previousClose = roundToTick(price - span, symbol);
    const candles = times.map((time, index) => {
      const progress = index / (times.length - 1);
      const center = price - span * (1 - progress) + Math.sin(index * .47) * span * .18 + (Math.random() - .5) * span * .1;
      const close = index === times.length - 1 ? price : roundToTick(center, symbol);
      const open = previousClose;
      previousClose = close;
      return {
        time, open, close,
        high: roundToTick(Math.max(open, close) + Math.random() * span * .065, symbol),
        low: roundToTick(Math.max(instruments[symbol].tick, Math.min(open, close) - Math.random() * span * .065), symbol),
        volume: Math.floor((1000 + Math.random() * 9000) * (instruments[symbol].unit === "ações" ? 10 : 1))
      };
    });
    histories.set(key, { symbol, timeframe: state.timeframe, candles });
    return candles;
  }

  function movingAverage(candles, period) {
    let sum = 0;
    return candles.map((candle, index) => {
      sum += candle.close;
      if (index >= period) sum -= candles[index - period].close;
      return index < period - 1 ? null : sum / period;
    });
  }

  function rsi(candles, period = 14) {
    let gains = 0;
    let losses = 0;
    for (let index = 1; index <= period; index++) {
      const change = candles[index].close - candles[index - 1].close;
      gains += Math.max(change, 0) / period;
      losses += Math.max(-change, 0) / period;
    }
    for (let index = period + 1; index < candles.length; index++) {
      const change = candles[index].close - candles[index - 1].close;
      gains = (gains * (period - 1) + Math.max(change, 0)) / period;
      losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
    }
    return gains === 0 && losses === 0 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }

  const tradingPlugin = {
    id: "tradingCandles",
    beforeDatasetsDraw(instance) {
      const candles = getSeries();
      const { ctx, chartArea, scales } = instance;
      if (!chartArea) return;
      const width = Math.max(2, chartArea.width / candles.length * .65);
      const maxVolume = Math.max(...candles.map((candle) => candle.volume));
      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
      ctx.clip();
      candles.forEach((candle, index) => {
        const x = scales.x.getPixelForValue(index);
        const up = candle.close >= candle.open;
        const volumeHeight = candle.volume / maxVolume * chartArea.height * .17;
        ctx.fillStyle = up ? "rgba(0,230,118,.17)" : "rgba(255,82,82,.16)";
        ctx.fillRect(x - width / 2, chartArea.bottom - volumeHeight, width, volumeHeight);
        if (state.chartStyle !== "candles") return;
        const open = scales.y.getPixelForValue(candle.open);
        const close = scales.y.getPixelForValue(candle.close);
        ctx.strokeStyle = ctx.fillStyle = up ? "#00c77a" : "#ef626d";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, scales.y.getPixelForValue(candle.high));
        ctx.lineTo(x, scales.y.getPixelForValue(candle.low));
        ctx.stroke();
        ctx.fillRect(x - width / 2, Math.min(open, close), width, Math.max(1.5, Math.abs(open - close)));
      });
      ctx.restore();
    },
    afterDatasetsDraw(instance) {
      const { ctx, chartArea, scales } = instance;
      if (!chartArea) return;
      const candles = getSeries();
      const last = candles[candles.length - 1];
      const y = scales.y.getPixelForValue(last.close);
      const color = last.close >= last.open ? "#00c77a" : "#ef626d";
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = .6;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = .7;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      const labelWidth = Math.max(42, instance.width - chartArea.right - 2);
      ctx.fillRect(chartArea.right, y - 9, labelWidth, 18);
      ctx.font = "9px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#071b12";
      ctx.fillText(number(last.close, instruments[state.symbol].decimals), chartArea.right + labelWidth / 2, y + .5);
      const active = instance.getActiveElements();
      if (active.length) {
        const x = scales.x.getPixelForValue(active[0].index);
        ctx.strokeStyle = "#617087";
        ctx.lineWidth = .7;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  function initializeChart() {
    if (typeof window.Chart !== "function") {
      $("chart-error").hidden = false;
      $("price-chart").hidden = true;
      pushLog("risk", "INTERFACE", "Chart.js não carregou. Verifique a conexão com a CDN e recarregue para exibir o gráfico.");
      return;
    }
    chart = new window.Chart($("price-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Preço", data: [], borderColor: "transparent", backgroundColor: "rgba(0,230,118,.045)", pointRadius: 0, pointHoverRadius: 0, borderWidth: 0, tension: .2 },
          { label: "MM 9", data: [], borderColor: "#6ea8fe", pointRadius: 0, pointHoverRadius: 0, borderWidth: 1.1, tension: .25 },
          { label: "MM 21", data: [], borderColor: "#b393ff", pointRadius: 0, pointHoverRadius: 0, borderWidth: 1.1, tension: .25 }
        ]
      },
      plugins: [tradingPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { intersect: false, mode: "index" },
        layout: { padding: { top: 10, bottom: 1, left: 3, right: 3 } },
        scales: {
          x: {
            grid: { display: false }, border: { color: "#283142" },
            ticks: { color: "#7d8ba1", maxTicksLimit: 7, maxRotation: 0, font: { family: "Consolas, monospace", size: 9 }, padding: 8 }
          },
          y: {
            position: "right", border: { display: false },
            grid: { color: "rgba(42,51,67,.48)", drawTicks: false },
            ticks: { color: "#7d8ba1", maxTicksLimit: 6, padding: 9, font: { family: "Consolas, monospace", size: 9 }, callback: (value) => number(value, instruments[state.symbol].decimals) }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1a2230", borderColor: "#3d4b61", borderWidth: 1, padding: 12, displayColors: false,
            titleColor: "#edf0f7", bodyColor: "#b6c4d9", titleFont: { size: 10 }, bodyFont: { family: "Consolas, monospace", size: 10 },
            filter: (item) => item.datasetIndex === 0,
            callbacks: {
              title: (items) => {
                if (!items.length) return "";
                const candle = getSeries()[items[0].dataIndex];
                return `${state.symbol} · ${fullDate.format(candle.time)} ${shortClock.format(candle.time)}`;
              },
              label: (context) => {
                const candle = getSeries()[context.dataIndex];
                const decimals = instruments[state.symbol].decimals;
                return [`Abertura: ${number(candle.open, decimals)}`, `Máxima:   ${number(candle.high, decimals)}`, `Mínima:   ${number(candle.low, decimals)}`, `Fechamento: ${number(candle.close, decimals)}`, `Volume: ${number(candle.volume, 0)}`];
              }
            }
          }
        }
      }
    });
    updateChart();
  }

  function updateChart() {
    const candles = getSeries();
    const last = candles[candles.length - 1];
    const instrument = instruments[state.symbol];
    setText("chart-ohlc", `O ${number(last.open, instrument.decimals)}   H ${number(last.high, instrument.decimals)}   L ${number(last.low, instrument.decimals)}   C ${number(last.close, instrument.decimals)}`);
    if (!chart) return;
    const low = Math.min(...candles.map((candle) => candle.low));
    const high = Math.max(...candles.map((candle) => candle.high));
    const spread = Math.max(high - low, instrument.tick * 10);
    chart.data.labels = candles.map((candle) => state.timeframe === "1D" ? shortDate.format(candle.time) : shortClock.format(candle.time));
    chart.data.datasets[0].data = candles.map((candle) => candle.close);
    chart.data.datasets[0].borderColor = state.chartStyle === "line" ? "#00e676" : "transparent";
    chart.data.datasets[0].borderWidth = state.chartStyle === "line" ? 1.8 : 0;
    chart.data.datasets[0].fill = state.chartStyle === "line";
    chart.data.datasets[1].data = movingAverage(candles, 9);
    chart.data.datasets[2].data = movingAverage(candles, 21);
    chart.options.scales.y.min = low - spread * .25;
    chart.options.scales.y.max = high + spread * .12;
    chart.update("none");
  }

  function renderMarket() {
    const instrument = instruments[state.symbol];
    const price = state.quotes[state.symbol].price;
    const change = price - instrument.previousClose;
    const percent = change / instrument.previousClose * 100;
    setText("chart-price", priceText(state.symbol, price));
    flash($("chart-price"), price);
    setSigned($("chart-change"), change, `${number(change, instrument.decimals, true)} (${number(percent, 2, true)}%)`);
    setText("instrument-name", instrument.name);
    setText("asset-avatar", instrument.avatar);
    setText("chart-volume-unit", instrument.unit);
    setText("chart-clock", `${clock.format(state.now)} BRT`);
    $("price-chart").setAttribute("aria-label", `Gráfico ${state.chartStyle === "candles" ? "de candles" : "de linha"} simulado de ${state.symbol}, período ${state.timeframe}. Último preço: ${priceText(state.symbol, price)}.`);
    $("asset-select").value = state.symbol;
    document.querySelectorAll("[data-ticker]").forEach((button) => {
      const symbol = button.dataset.ticker;
      const quote = state.quotes[symbol].price;
      const variation = (quote - instruments[symbol].previousClose) / instruments[symbol].previousClose * 100;
      setSigned(button.querySelector("span"), variation, `${number(variation, 2, true)}%`);
      button.classList.toggle("selected", symbol === state.symbol);
      button.setAttribute("aria-pressed", String(symbol === state.symbol));
      button.title = `${instruments[symbol].name} · ${priceText(symbol, quote)}`;
      flash(button, quote);
    });
    if ($("order-dialog").open) updateOrderPreview();
  }

  function renderAnalysis() {
    if (state.page !== "analysis") return;
    const candles = getSeries();
    const index = rsi(candles);
    const ma9 = movingAverage(candles, 9).slice(-1)[0];
    const ma21 = movingAverage(candles, 21).slice(-1)[0];
    const trend = ma9 > ma21 ? "Alta" : ma9 < ma21 ? "Baixa" : "Neutra";
    const support = Math.min(...candles.slice(-20).map((candle) => candle.low));
    const resistance = Math.max(...candles.slice(-20).map((candle) => candle.high));
    const decimals = instruments[state.symbol].decimals;
    $("analysis-indicators").innerHTML = `
      <article class="panel indicator-card"><h3>RSI · 14 períodos</h3><strong>${number(index, 1)}</strong><p>${index > 70 ? "Faixa de sobrecompra" : index < 30 ? "Faixa de sobrevenda" : "Faixa neutra"} · suavização de Wilder</p></article>
      <article class="panel indicator-card"><h3>Tendência · MM 9 / MM 21</h3><strong class="${signedClass(ma9 - ma21)}">${trend}</strong><p>${number(ma9, decimals)} / ${number(ma21, decimals)} · médias simples</p></article>
      <article class="panel indicator-card"><h3>Suporte de referência</h3><strong>${number(support, decimals)}</strong><p>Menor mínima dos últimos 20 candles</p></article>
      <article class="panel indicator-card"><h3>Resistência de referência</h3><strong>${number(resistance, decimals)}</strong><p>Maior máxima dos últimos 20 candles</p></article>`;
  }

  function selectSymbol(symbol) {
    if (!instruments[symbol]) { toast("Ativo indisponível neste simulador.", true); return; }
    state.symbol = symbol;
    delete $("chart-price").dataset.previousValue;
    renderMarket();
    updateChart();
    renderAnalysis();
  }

  function updateMarketData() {
    Object.keys(instruments).forEach((symbol) => {
      const instrument = instruments[symbol];
      const step = (Math.random() - .48) * 2 * instrument.volatility;
      state.quotes[symbol].price = roundToTick(Math.max(instrument.tick, state.quotes[symbol].price + step), symbol);
    });
    histories.forEach(({ symbol, timeframe, candles }) => {
      const price = state.quotes[symbol].price;
      const last = candles[candles.length - 1];
      const time = currentBarTime(state.now, timeframe);
      if (time > last.time) {
        candles.push({ time, open: last.close, close: price, high: Math.max(price, last.close), low: Math.min(price, last.close), volume: 1000 });
        if (candles.length > 56) candles.shift();
      } else {
        last.close = price;
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.volume += Math.floor(100 + Math.random() * 700);
      }
    });
  }

  function checkProtectiveOrders() {
    [...state.positions].forEach((position) => {
      const price = state.quotes[position.symbol].price;
      const stopped = position.side === "buy" ? price <= position.stop : price >= position.stop;
      const target = position.side === "buy" ? price >= position.take : price <= position.take;
      if (stopped || target) closePosition(position.id, stopped ? "Stop Loss" : "Take Profit", false);
    });
  }

  function generateAgentLog() {
    const active = state.agents.filter((agent) => !agent.paused);
    if (!active.length) {
      pushLog("system", "ENGINE", "Todos os agentes pausados. Acompanhamento de preços e proteções permanece ativo.");
      return;
    }
    const agent = active[state.tickCount % active.length];
    const price = state.quotes[agent.symbol].price;
    const position = state.positions.find((item) => item.agentId === agent.id);
    const messages = [
      `${agent.symbol} a ${priceText(agent.symbol, price)}. ${position ? "Posição e proteções em acompanhamento." : "Aguardando confirmação de um novo sinal."}`,
      `${agent.symbol}: volume simulado em ${number(1 + Math.random() * .8, 2)}x a referência. Novo ciclo de análise iniciado.`,
      position ? `Proteção monitorada: stop ${priceText(agent.symbol, position.stop)}; alvo ${priceText(agent.symbol, position.take)}.` : `${agent.symbol}: faixa de referência próxima a ${priceText(agent.symbol, roundToTick(price * .995, agent.symbol))}. Sem execução automática.`,
      `Estratégia ${agent.strategy.toLocaleLowerCase("pt-BR")} processada. PnL do agente: ${currency(agentPnl(agent), true)}.`
    ];
    pushLog("signal", agent.name, messages[state.tickCount % messages.length]);
  }

  function tick() {
    state.now += TICK_INTERVAL;
    state.tickCount += 1;
    state.lastTickAt = performance.now();
    if (marketOpen()) {
      updateMarketData();
      checkProtectiveOrders();
      enforceRiskLimits();
      generateAgentLog();
    } else {
      pushLog("system", "MERCADO", "Sessão simulada fechada. Preços congelados e novas ordens indisponíveis.");
    }
    renderSummary();
    updateAgentValues();
    updatePositionValues();
    renderMarket();
    updateChart();
    renderAnalysis();
  }

  // WebSocket futuro: substitua este timer por eventos validados de /ws
  // (quote, agent_status, position, order, log). Reconcile com um novo snapshot
  // após reconexão; nunca mantenha o mock funcionando em paralelo aos dados reais.
  // O navegador é apenas a camada de controle: stops reais pertencem ao backend/corretora.
  function startSimulation() {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(tick, TICK_INTERVAL);
  }

  function setNavigation(open, restoreFocus = true) {
    navigationOpen = mobileQuery.matches && open;
    $("sidebar").classList.toggle("is-open", navigationOpen);
    $("sidebar-overlay").hidden = !navigationOpen;
    $("sidebar").inert = mobileQuery.matches && !navigationOpen;
    $("menu-button").setAttribute("aria-expanded", String(navigationOpen));
    $("menu-button").setAttribute("aria-label", navigationOpen ? "Fechar menu" : "Abrir menu");
    document.body.classList.toggle("nav-open", navigationOpen);
    if (navigationOpen) $("sidebar").querySelector(".brand").focus();
    else if (restoreFocus && mobileQuery.matches) $("menu-button").focus();
  }

  function renderRoute(focus = false) {
    const requested = window.location.hash.slice(1) || "dashboard";
    const route = Object.prototype.hasOwnProperty.call(routes, requested) ? requested : "dashboard";
    if (route !== requested) {
      window.history.replaceState(null, "", "#dashboard");
      toast("Essa página não existe. A visão geral foi aberta.", true);
    }
    state.page = route;
    document.querySelectorAll(".page-view").forEach((view) => { view.hidden = view.id !== `page-${route}`; });
    document.querySelectorAll("[data-route]").forEach((link) => {
      const active = link.dataset.route === route;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("page-title").innerHTML = `${routes[route][0]}<span class="title-dot">.</span>`;
    setText("page-description", routes[route][1]);
    setText("breadcrumb-current", routes[route][0]);
    document.title = `${routes[route][0]} — B3 AI Trader Engine`;
    const slot = $(route === "analysis" ? "analysis-chart-slot" : "dashboard-chart-slot");
    if ($("chart-panel").parentElement !== slot) slot.append($("chart-panel"));
    $("expand-chart").setAttribute("aria-label", route === "analysis" ? "Voltar à visão geral" : "Abrir análise ampliada");
    $("expand-chart").title = $("expand-chart").getAttribute("aria-label");
    setNavigation(false, false);
    renderAnalysis();
    if (chart && (route === "dashboard" || route === "analysis")) window.requestAnimationFrame(() => { chart.resize(); chart.update("none"); });
    if (focus) {
      $("main-content").focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function handleAction(button) {
    switch (button.dataset.action) {
      case "toggle-agent": toggleAgent(button.dataset.agentId); break;
      case "configure-agent": configureAgent(button.dataset.agentId); break;
      case "close-position": requestClosePosition(button.dataset.position); break;
      case "new-order": openOrder(); break;
      case "select-symbol": selectSymbol(button.dataset.ticker); break;
      case "expand-chart": window.location.hash = state.page === "analysis" ? "dashboard" : "analysis"; break;
      case "export-report": exportCsv(true); break;
      case "export-orders": exportCsv(); break;
      case "clear-logs":
        state.logs = [];
        pushLog("system", "ENGINE", "Terminal limpo pelo operador.");
        renderLogs(true);
        break;
      case "reload": window.location.reload(); break;
      case "check-simulator": {
        const healthy = timer !== null && performance.now() - state.lastTickAt < TICK_INTERVAL * 3;
        toast(healthy ? "Simulador local respondendo. Ciclo de 3 segundos ativo; nenhuma API externa conectada." : "O simulador não atualizou recentemente. A aba pode estar suspensa; retorne à página ou recarregue.", !healthy);
        break;
      }
      default: console.error("Ação não reconhecida:", button.dataset.action); toast("Este controle não pôde ser executado.", true);
    }
  }

  function bindEvents() {
    document.querySelector(".skip-link").addEventListener("click", (event) => {
      event.preventDefault();
      $("main-content").focus();
    });
    document.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("[data-action]");
      if (action) handleAction(action);
      const close = event.target.closest("[data-close-dialog]");
      if (close) $(close.dataset.closeDialog).close();
      const filter = event.target.closest("[data-filter]");
      if (filter) { state.filter = filter.dataset.filter; renderAgents(); }
      const timeframe = event.target.closest("[data-timeframe]");
      if (timeframe) {
        state.timeframe = timeframe.dataset.timeframe;
        document.querySelectorAll("[data-timeframe]").forEach((button) => {
          const selected = button === timeframe;
          button.classList.toggle("selected", selected);
          button.setAttribute("aria-pressed", String(selected));
        });
        updateChart();
        renderAnalysis();
        renderMarket();
      }
    });
    $("kill-switch").addEventListener("click", () => confirm({
      title: "Pausar todos os agentes?",
      description: "O kill switch interrompe o monitoramento de sinais de todos os agentes ativos. As posições abertas não serão zeradas, e os stops e alvos simulados continuam sendo monitorados.",
      detail: "Você poderá retomar cada agente individualmente quando estiver pronto.",
      button: "Sim, pausar todos"
    }, () => pauseAll()));
    $("confirm-dialog").addEventListener("close", () => {
      const action = confirmAction;
      confirmAction = null;
      if ($("confirm-dialog").returnValue === "confirm" && action) action();
    });
    $("agent-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!$("agent-form").reportValidity()) return;
      const agent = state.agents.find((item) => item.id === $("agent-id").value);
      const name = $("agent-name").value.trim();
      const lossLimit = Number($("agent-loss-limit").value);
      if (!agent || !name || !Number.isInteger(lossLimit) || lossLimit < 1 || lossLimit > INITIAL_CAPITAL) {
        formError("agent-error", "Informe um nome e um limite inteiro válido entre R$ 1 e R$ 125.000.");
        return;
      }
      // REST futuro: PATCH /api/agents/:id/config. A estratégia real deve ser
      // reconfigurada e confirmada pelo serviço Python; aqui alteramos só a demonstração.
      agent.name = name;
      agent.strategy = $("agent-strategy").value;
      agent.lossLimit = lossLimit;
      $("agent-dialog").close();
      pushLog("system", agent.name, "Configuração demonstrativa atualizada para esta sessão.");
      renderAgents();
      enforceRiskLimits();
      renderSummary();
      toast("Configuração do agente atualizada nesta sessão simulada.");
    });
    $("toggle-logs").addEventListener("click", () => {
      state.logsPaused = !state.logsPaused;
      $("toggle-logs").innerHTML = icon(state.logsPaused ? "play" : "pause");
      $("toggle-logs").setAttribute("aria-pressed", String(state.logsPaused));
      $("toggle-logs").setAttribute("aria-label", state.logsPaused ? "Retomar exibição dos logs" : "Pausar exibição dos logs");
      $("toggle-logs").title = $("toggle-logs").getAttribute("aria-label");
      $("terminal-status").classList.toggle("paused", state.logsPaused);
      $("terminal-status").innerHTML = `<span class="status-dot"></span> ${state.logsPaused ? "EXIBIÇÃO PAUSADA" : "STREAM ONLINE"}`;
      setText("terminal-footer-text", state.logsPaused ? "Eventos continuam sendo capturados" : "Monitorando oportunidades de mercado");
      if (!state.logsPaused) renderLogs(true);
    });
    $("log-filter").addEventListener("change", (event) => { state.logFilter = event.target.value; renderLogs(true); });
    $("asset-select").addEventListener("change", (event) => selectSymbol(event.target.value));
    $("chart-style").addEventListener("change", (event) => { state.chartStyle = event.target.value; updateChart(); renderMarket(); });
    $("history-search").addEventListener("input", renderHistory);
    $("history-side").addEventListener("change", renderHistory);
    $("order-form").addEventListener("submit", submitOrder);
    $("order-form").querySelectorAll('input[name="order-side"]').forEach((input) => input.addEventListener("change", resetOrderPrices));
    $("order-symbol").addEventListener("change", () => {
      $("order-quantity").value = instruments[$("order-symbol").value].unit === "ações" ? "100" : "1";
      resetOrderPrices();
    });
    $("order-quantity").addEventListener("input", updateOrderPreview);
    $("connection-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!$("connection-form").reportValidity()) return;
      let restUrl;
      let wsUrl;
      try {
        restUrl = parseEndpoint($("rest-url").value, ["http:", "https:"]);
        wsUrl = parseEndpoint($("ws-url").value, ["ws:", "wss:"]);
      } catch (error) {
        formError("connection-error", `Endereço inválido. ${error.message}`);
        return;
      }
      if (savePreferences({ ...state.preferences, restUrl, wsUrl }, "connection-error")) {
        pushLog("system", "CONFIG", "Endereços salvos localmente. Conexão REST/WebSocket ainda não implementada.");
        toast("Endereços salvos. A interface continua no simulador; nenhuma conexão foi aberta.");
      }
    });
    $("risk-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!$("risk-form").reportValidity()) return;
      const dailyLossLimit = Number($("daily-loss-limit").value);
      const exposureLimit = Number($("exposure-limit").value);
      if (!Number.isInteger(dailyLossLimit) || dailyLossLimit < 1 || dailyLossLimit > INITIAL_CAPITAL
        || !Number.isInteger(exposureLimit) || exposureLimit < 1 || exposureLimit > 200) {
        formError("risk-error", "Informe limites inteiros dentro dos intervalos indicados.");
        return;
      }
      if (savePreferences({ ...state.preferences, dailyLossLimit, exposureLimit }, "risk-error")) {
        pushLog("risk", "CONFIG", "Limites de risco da simulação atualizados.");
        enforceRiskLimits();
        renderSummary();
        toast("Limites salvos. As novas ordens respeitarão a configuração atualizada.");
      }
    });
    $("menu-button").addEventListener("click", () => setNavigation(!navigationOpen));
    $("sidebar-overlay").addEventListener("click", () => setNavigation(false));
    $("sidebar-overlay").tabIndex = -1;
    mobileQuery.addEventListener("change", () => setNavigation(false, false));
    document.addEventListener("keydown", (event) => {
      if (!navigationOpen) return;
      if (event.key === "Escape") setNavigation(false);
      if (event.key !== "Tab") return;
      const focusable = [...$("sidebar").querySelectorAll("a[href], button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dialog.close("cancel");
        }
      });
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close("cancel");
      });
    });
    window.addEventListener("hashchange", () => renderRoute(true));
    window.addEventListener("pagehide", () => { window.clearInterval(timer); timer = null; });
    window.addEventListener("pageshow", (event) => { if (event.persisted) startSimulation(); });
  }

  function initialize() {
    $("market-ticker").innerHTML = ["PETR4", "VALE3", "WINFUT", "WDOFUT"].map((symbol) => `<button class="ticker-item" data-action="select-symbol" data-ticker="${symbol}" aria-pressed="${symbol === state.symbol}"><strong>${symbol}</strong><span></span></button>`).join("");
    $("rest-url").value = state.preferences.restUrl;
    $("ws-url").value = state.preferences.wsUrl;
    $("daily-loss-limit").value = state.preferences.dailyLossLimit;
    $("exposure-limit").value = state.preferences.exposureLimit;
    bindEvents();
    renderSummary();
    renderAgents();
    updateAgentValues();
    renderPositions();
    renderHistory();
    renderMarket();
    renderLogs(true);
    initializeChart();
    renderRoute();
    startSimulation();
  }

  initialize();
})();
