(() => {
  "use strict";

  const TICK_INTERVAL = 3000;
  const INITIAL_CAPITAL = 125000;
  const $ = (id) => document.getElementById(id);

  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const signedMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", signDisplay: "exceptZero" });
  const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

  const instruments = {
    PETR4: { name: "Petrobras PN", initial: 38.72, previousClose: 38.18, tick: .01, decimals: 2, multiplier: 1, volatility: .04, avatar: "P", unit: "ações" },
    VALE3: { name: "Vale ON", initial: 62.84, previousClose: 62.44, tick: .01, decimals: 2, multiplier: 1, volatility: .06, avatar: "V", unit: "ações" },
    WINFUT: { name: "Mini-índice", initial: 130280, previousClose: 130555, tick: 5, decimals: 0, multiplier: .2, volatility: 65, avatar: "W", unit: "contratos" },
    WDOFUT: { name: "Minidólar", initial: 5681.5, previousClose: 5663, tick: .5, decimals: 1, multiplier: 10, volatility: 2, avatar: "$", unit: "contratos" },
    ITUB4: { name: "Itaú Unibanco PN", initial: 35.18, previousClose: 35.36, tick: .01, decimals: 2, multiplier: 1, volatility: .03, avatar: "I", unit: "ações" }
  };

  const modalities = { day: "Day Trade", swing: "Swing Trade", analysis: "Análise / Alertas" };

  const defaultPreferences = { restUrl: "http://localhost:8000", wsUrl: "ws://localhost:8000/ws", dailyLossLimit: 1500, exposureLimit: 100 };

  const state = {
    now: null,
    page: "sync",
    symbol: "PETR4",
    timeframe: "5m",
    agents: [],
    positions: [],
    orders: [],
    quotes: Object.fromEntries(Object.entries(instruments).map(([s, i]) => [s, { price: i.initial }])),
    manualRealized: 0,
    sequence: 0,
    logs: [],
    logsPaused: false,
    filter: "all",
    sync: { active: true, sharedPrice: null, lastTickAt: null, conflicts: [] },
    preferences: defaultPreferences,
    chart: null,
    timer: null
  };

  function nowBrt() {
    return new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour12: false });
  }

  function createSessionTime() {
    const date = new Date();
    date.setUTCHours(17, 32, 18, 0);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
    return date.getTime();
  }

  function number(value, decimals = 2, signed = false) {
    return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, signDisplay: signed ? "exceptZero" : "auto" }).format(value);
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
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function signedClass(value) {
    return value > 0 ? "positive" : value < 0 ? "negative" : "muted";
  }

  function setSigned(element, value, text = currency(value, true)) {
    element.textContent = text;
    element.classList.remove("positive", "negative", "muted");
    element.classList.add(signedClass(value));
  }

  function pushLog(level, source, message) {
    const t = state.now !== null ? state.now : Date.now();
    state.logs.push({ time: t, level, source, message });
    if (state.logs.length > 200) state.logs.shift();
    renderTerminal();
  }

  function renderTerminal() {
    const terminal = $("sync-terminal");
    if (!terminal) return;
    const logs = state.logs.slice(-60);
    terminal.innerHTML = logs.map((log) => {
      const time = clock ? clock.format(log.time) : "--:--:--";
      return `<div class="log-entry"><span class="log-time">[${time}]</span><span class="log-source">${escapeHtml(log.source)}</span><span class="log-msg">${escapeHtml(log.message)}</span></div>`;
    }).join("");
    terminal.scrollTop = terminal.scrollHeight;
  }

  function initAgents() {
    state.agents = [
      { id: "alpha", name: "Mini-Índice Alpha", strategy: "Cruzamento de médias", symbol: "WINFUT", modality: "day", realized: 0, lossLimit: 1200, paused: false, color: "blue", avatar: "A" },
      { id: "petro", name: "Petro Momentum", strategy: "Price Action + Sentimento", symbol: "PETR4", modality: "day", realized: 0, lossLimit: 600, paused: false, color: "teal", avatar: "P" },
      { id: "swing", name: "Swing Compass", strategy: "Momentum + Tendência", symbol: "VALE3", modality: "swing", realized: 0, lossLimit: 900, paused: false, color: "amber", avatar: "S" },
      { id: "radar", name: "Radar de Mercado", strategy: "Suporte e resistência", symbol: "WDOFUT", modality: "analysis", realized: 0, lossLimit: 350, paused: false, color: "purple", avatar: "R" },
      { id: "reversion", name: "Reversão Quant", strategy: "Reversão à média", symbol: "ITUB4", modality: "day", realized: 0, lossLimit: 500, paused: true, color: "gray", avatar: "Q" }
    ];
    state.now = createSessionTime();
    pushLog("system", "ENGINE", "Painel sincronizado iniciado. 5 agentes carregados; market data compartilhado ativo.");
  }

  function agentPnl(agent) {
    const unrealized = state.positions.filter((p) => p.agentId === agent.id).reduce((sum, p) => {
      const dir = p.side === "buy" ? 1 : -1;
      const inst = instruments[p.symbol];
      return sum + (state.quotes[p.symbol].price - p.entry) * p.quantity * inst.multiplier * dir;
    }, 0);
    return agent.realized + unrealized;
  }

  function statistics() {
    const realized = state.agents.reduce((s, a) => s + a.realized, state.manualRealized);
    const unrealized = state.positions.reduce((s, p) => {
      const dir = p.side === "buy" ? 1 : -1;
      const inst = instruments[p.symbol];
      return s + (state.quotes[p.symbol].price - p.entry) * p.quantity * inst.multiplier * dir;
    }, 0);
    const exposure = state.positions.reduce((s, p) => s + state.quotes[p.symbol].price * p.quantity * instruments[p.symbol].multiplier, 0);
    return { realized, unrealized, exposure, dailyPnl: realized + unrealized, balance: INITIAL_CAPITAL + realized + unrealized };
  }

  function marketOpen() {
    const d = new Date(state.now);
    return d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && d.getUTCHours() >= 13 && d.getUTCHours() < 20;
  }

  function updateSyncState() {
    state.sync.sharedPrice = state.quotes[state.symbol].price;
    state.sync.lastTickAt = Date.now();
    state.sync.conflicts = [];
    const symbolsInUse = new Set(state.agents.filter((a) => !a.paused).map((a) => a.symbol));
    state.agents.forEach((a) => {
      if (!a.paused && symbolsInUse.has(a.symbol) && state.agents.filter((x) => !x.paused && x.symbol === a.symbol).length > 1) {
        state.sync.conflicts.push({ symbol: a.symbol, agents: state.agents.filter((x) => !x.paused && x.symbol === a.symbol).map((x) => x.id) });
      }
    });
  }

  function updateMarketData() {
    Object.keys(instruments).forEach((symbol) => {
      const inst = instruments[symbol];
      const step = (Math.random() - 0.48) * 2 * inst.volatility;
      state.quotes[symbol].price = roundToTick(Math.max(inst.tick, state.quotes[symbol].price + step), symbol);
    });

    state.positions.forEach((position) => {
      const agent = state.agents.find((a) => a.id === position.agentId);
      if (!agent || agent.paused) return;
      const price = state.quotes[position.symbol].price;
      if (position.side === "buy") {
        if (price <= position.stop) closePosition(position.id, "Stop Loss");
        else if (price >= position.take) closePosition(position.id, "Take Profit");
      } else {
        if (price >= position.stop) closePosition(position.id, "Stop Loss");
        else if (price <= position.take) closePosition(position.id, "Take Profit");
      }
    });

    enforceRiskLimits();
    updateSyncState();
    renderAll();
  }

  function enforceRiskLimits() {
    const stats = statistics();
    if (stats.dailyPnl <= -state.preferences.dailyLossLimit) {
      state.agents.forEach((a) => { if (!a.paused) a.paused = true; });
      pushLog("risk", "KILL SWITCH", `Limite global de perda diária atingido (${currency(stats.dailyPnl)}). Todos os agentes pausados.`);
      return;
    }
    state.agents.forEach((agent) => {
      if (!agent.paused && agentPnl(agent) <= -agent.lossLimit) {
        agent.paused = true;
        pushLog("risk", agent.name, `Limite de perda do agente atingido (${currency(agent.lossLimit)}). Pausado.`);
      }
    });
  }

  function closePosition(id, reason = "Manual") {
    const position = state.positions.find((p) => p.id === id);
    if (!position) return;
    const pnl = Math.round(positionPnl(position) * 100) / 100;
    const agent = state.agents.find((a) => a.id === position.agentId);
    if (agent) agent.realized += pnl;
    else state.manualRealized += pnl;
    state.orders.unshift({ id: `ord-${++state.sequence}`, time: state.now, symbol: position.symbol, side: position.side === "buy" ? "sell" : "buy", kind: `Saída · ${reason}`, quantity: position.quantity, price: state.quotes[position.symbol].price, realized: pnl, origin: agent ? agent.name : "Manual" });
    state.positions = state.positions.filter((p) => p.id !== id);
    pushLog(reason === "Stop Loss" ? "risk" : "order", agent ? agent.name : "MANUAL", `${position.symbol} encerrado por ${reason.toLowerCase()}. Resultado: ${currency(pnl, true)}.`);
  }

  function positionPnl(position) {
    const dir = position.side === "buy" ? 1 : -1;
    return (state.quotes[position.symbol].price - position.entry) * position.quantity * instruments[position.symbol].multiplier * dir;
  }

  function toggleAgent(id) {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return;
    if (agent.paused && (agentPnl(agent) <= -agent.lossLimit || statistics().dailyPnl <= -state.preferences.dailyLossLimit)) {
      pushLog("system", agent.name, "Retomada bloqueada por limite de perda.");
      return;
    }
    agent.paused = !agent.paused;
    pushLog("system", agent.name, agent.paused ? "Agente pausado pelo operador." : "Agente retomado. Monitoramento de sinais habilitado.");
    updateSyncState();
    renderAll();
  }

  function pauseAll() {
    const active = state.agents.filter((a) => !a.paused);
    if (!active.length) return;
    active.forEach((a) => { a.paused = true; });
    pushLog("risk", "KILL SWITCH", `${active.length} agentes pausados globalmente.`);
    updateSyncState();
    renderAll();
  }

  function openOrder(symbol, side, quantity) {
    if (!marketOpen()) { pushLog("risk", "SISTEMA", "Mercado fechado. Ordem bloqueada."); return; }
    const inst = instruments[symbol];
    const price = state.quotes[symbol].price;
    const stop = roundToTick(price * (side === "buy" ? 0.99 : 1.01), symbol);
    const take = roundToTick(price * (side === "buy" ? 1.02 : 0.98), symbol);
    const stats = statistics();
    if (stats.exposure + price * quantity * inst.multiplier > stats.balance * state.preferences.exposureLimit / 100) {
      pushLog("risk", "RISCO", "Ordem bloqueada: limite de exposição nocional excedido.");
      return;
    }
    const position = { id: `pos-${++state.sequence}`, symbol, side, quantity, entry: price, stop, take, agentId: null };
    state.positions.push(position);
    state.orders.unshift({ id: `ord-${++state.sequence}`, time: state.now, symbol, side, quantity, price, kind: "Entrada", realized: null, origin: "Manual" });
    pushLog("order", "MANUAL", `${side === "buy" ? "Compra" : "Venda"} simulada: ${quantity} ${inst.unit} de ${symbol} a ${priceText(symbol, price)}.`);
    renderAll();
  }

  function renderAll() {
    renderSummary();
    renderAgents();
    renderPositions();
    renderTerminal();
  }

  function renderSummary() {
    const stats = statistics();
    const active = state.agents.filter((a) => !a.paused);
    const operating = active.filter((a) => state.positions.some((p) => p.agentId === a.id)).length;
    const perf = stats.dailyPnl / INITIAL_CAPITAL * 100;
    const exposurePct = stats.balance > 0 ? stats.exposure / stats.balance * 100 : 0;
    $("m-balance").textContent = currency(stats.balance);
    setSigned($("m-pnl"), stats.dailyPnl);
    $("m-agents").textContent = active.length.toString().padStart(2, "0");
    $("m-positions").textContent = state.positions.length.toString().padStart(2, "0");
    const open = marketOpen();
    const dot = $("sync-status").querySelector(".dot");
    const txt = $("sync-status-text");
    dot.className = "dot" + (open ? " sync-on" : "");
    txt.textContent = open ? "Mercado aberto · sincronizado" : "Mercado fechado · sincronia mantida";
    const expFill = $("exposure-fill");
    if (expFill) expFill.style.width = `${Math.min(100, Math.max(0, exposurePct))}%`;
    $("exposure-value").textContent = currency(stats.exposure);
    $("nav-position-count").textContent = state.positions.length.toString().padStart(2, "0");
    const badge = $("sync-badge");
    badge.textContent = state.sync.active ? "Síncrono" : "Assíncrono";
    badge.className = `badge ${state.sync.active ? "badge-active" : "badge-paused"}`;
    const nowStr = clock ? clock.format(state.now) : "--:--:--";
    $("market-clock").textContent = nowStr;
  }

  function renderAgents() {
    const list = $("agents-list");
    if (!list) return;
    const agents = state.filter === "all" ? state.agents : state.agents.filter((a) => a.modality === state.filter);
    list.innerHTML = agents.map((agent) => {
      const pnl = agentPnl(agent);
      const status = agent.paused ? { text: "Pausado", cls: "badge-paused" } : (state.positions.some((p) => p.agentId === agent.id) ? { text: "Operando", cls: "badge-active" } : { text: "Ativo", cls: "badge-active" });
      const modCls = agent.modality === "day" ? "badge-day" : agent.modality === "swing" ? "badge-swing" : "badge-an";
      return `<div class="agent-row" data-agent-id="${agent.id}" onclick="toggleAgentSync('${agent.id}')">
        <div class="agent-cell">
          <div class="avatar ${agent.color}">${agent.avatar}</div>
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text);">${escapeHtml(agent.name)}</div>
            <div style="font-size:9px;color:var(--muted);">${escapeHtml(agent.strategy)}</div>
          </div>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">${agent.symbol}</div>
        <span class="badge ${modCls}">${modalities[agent.modality]}</span>
        <span class="badge ${status.cls}">${status.text}</span>
        <div class="pnl-cell ${signedClass(pnl)}">${currency(pnl, true)}</div>
        <button class="icon-button" onclick="event.stopPropagation(); toggleAgentSync('${agent.id}')" aria-label="${agent.paused ? "Retomar" : "Pausar"} ${escapeHtml(agent.name)}">${icon(agent.paused ? "play" : "pause")}</button>
      </div>`;
    }).join("") || '<div style="padding:12px;color:var(--muted);font-size:11px;">Nenhum agente nesta modalidade.</div>';
  }

  function renderPositions() {
    const list = $("positions-list");
    if (!list) return;
    list.innerHTML = state.positions.map((position) => {
      const inst = instruments[position.symbol];
      const pnl = positionPnl(position);
      const agent = state.agents.find((a) => a.id === position.agentId);
      return `<div class="position-card">
        <div class="pos-top">
          <div class="pos-sym">${position.symbol}</div>
          <span class="side-tag ${position.side === "buy" ? "side-buy" : "side-sell"}">${position.side === "buy" ? "LONG" : "SHORT"}</span>
        </div>
        <div class="pos-prices">
          <span>Entrada</span><strong>${number(position.entry, inst.decimals)}</strong>
          <span>Stop</span><strong style="color:var(--red)">${number(position.stop, inst.decimals)}</strong>
          <span>Alvo</span><strong style="color:var(--green)">${number(position.take, inst.decimals)}</strong>
        </div>
        <div class="pnl-cell ${signedClass(pnl)}">${currency(pnl, true)}</div>
        <button class="icon-button" onclick="closePositionSync('${position.id}')" aria-label="Zerar ${position.symbol}">${icon("close")}</button>
      </div>`;
    }).join("") || '<div style="padding:12px;color:var(--muted);font-size:11px;">Nenhuma posição aberta.</div>';
  }

  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24"><use href="#i-${name}"></use></svg>`;
  }

  function initChart() {
    if (typeof window.Chart !== "function") return;
    const ctx = $("sync-chart").getContext("2d");
    state.chart = new window.Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [{ label: "Preço", data: [], borderColor: "#00e676", backgroundColor: "rgba(0,230,118,.04)", pointRadius: 0, borderWidth: 1.5, tension: .2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { grid: { display: false }, border: { color: "#283142" }, ticks: { color: "#7d8ba1", font: { family: "Consolas, monospace", size: 8 }, maxTicksLimit: 7 } },
          y: { position: "right", border: { display: false }, grid: { color: "rgba(42,51,67,.48)" }, ticks: { color: "#7d8ba1", font: { family: "Consolas, monospace", size: 8 }, callback: (v) => number(v, instruments[state.symbol].decimals) } }
        },
        plugins: { legend: { display: false } }
      }
    });
    updateChart();
  }

  function updateChart() {
    if (!state.chart) return;
    const symbol = state.symbol;
    const inst = instruments[symbol];
    const price = state.quotes[symbol].price;
    const span = price * 0.012;
    const now = state.now;
    const openTime = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), 13);
    const minutes = { "1m": 1, "5m": 5, "15m": 15, "1D": 480 }[state.timeframe];
    const duration = minutes * 60000;
    const labels = [];
    const data = [];
    let prevClose = roundToTick(price - span, symbol);
    for (let i = 55; i >= 0; i--) {
      const t = openTime + i * duration;
      labels.push(clock ? clock.format(new Date(t)) : "--:--");
      const center = price - span * (i / 55) + Math.sin(i * 0.47) * span * 0.18;
      const c = i === 0 ? price : roundToTick(center, symbol);
      data.push(c);
      prevClose = c;
    }
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = data;
    state.chart.options.scales.y.min = Math.min(...data) - span * 0.25;
    state.chart.options.scales.y.max = Math.max(...data) + span * 0.12;
    state.chart.update("none");
    const last = data[data.length - 1];
    $("sync-ohlc").textContent = `C ${number(last, inst.decimals)}`;
    $("chart-symbol-label").textContent = symbol;
  }

  window.toggleAgentSync = (id) => { toggleAgent(id); renderAll(); };
  window.closePositionSync = (id) => { closePosition(id); renderAll(); };

  function start() {
    initAgents();
    initChart();
    state.timer = setInterval(() => {
      state.now += TICK_INTERVAL;
      updateMarketData();
    }, TICK_INTERVAL);
    updateMarketData();

    $("btn-kill-switch").addEventListener("click", () => { pauseAll(); renderAll(); });
    $("btn-reset-sync").addEventListener("click", () => {
      state.agents.forEach((a) => { a.paused = false; });
      state.positions = [];
      state.orders = [];
      state.manualRealized = 0;
      state.sequence = 0;
      state.now = createSessionTime();
      state.logs = [];
      pushLog("system", "ENGINE", "Ciclo reiniciado. Agentes retomados e posições zeradas.");
      renderAll();
    });

    document.querySelectorAll(".segmented button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".segmented button").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        state.timeframe = btn.dataset.tf;
        updateChart();
      });
    });

    window.addEventListener("beforeunload", () => { if (state.timer) clearInterval(state.timer); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

})();
