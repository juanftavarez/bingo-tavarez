const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const NUM_LOCALS = 21;
const CARDS_PER_LOCAL = 21;

// Cajero users — one per local
const CAJERO_USERS = {};
for(let i=1;i<=21;i++){
  CAJERO_USERS[`local${i}`] = {
    password: `bingo${i}`,  // default password: bingo1, bingo2, etc
    localId: i,
    name: `Local ${i}`
  };
}

const CARD_PRICE = 50;
const fs = require('fs');
const SALES_FILE = './sales_data.json';
let salesData = { games: [], currentGame: { gameId: Date.now(), startedAt: null, sales: {}, prizes: {} } };
try {
  if (fs.existsSync(SALES_FILE)) { salesData = JSON.parse(fs.readFileSync(SALES_FILE,'utf8')); }
} catch(e) {}
function saveSalesData() {
  try { fs.writeFileSync(SALES_FILE, JSON.stringify(salesData)); } catch(e) {}
}

const ROUND_MINUTES = 10;

// ── GAME STATE ──────────────────────────────────────────────────────
let gameState = {
  drawnNumbers: [],
  active: false,
  cards: {},
  prizes: {},
  localNames: {},
  disabledLocals: new Set(), // locals with no cards sold this round
  countdown: null,
  countdownActive: false
};

// Init prizes per local
function initPrizes() {
  const p = {};
  for (let i = 1; i <= NUM_LOCALS; i++) {
    p[`local_${i}`] = { L:false, T:false, X:false, CRUZ:false, line:false, fullCard:false };
  }
  return p;
}

// Init local names
function initLocalNames() {
  const n = {};
  for (let i = 1; i <= NUM_LOCALS; i++) n[`local_${i}`] = `Local ${i}`;
  return n;
}

gameState.prizes = initPrizes();
gameState.localNames = initLocalNames();

// ── CARD GENERATOR ──────────────────────────────────────────────────
function pickRandom(lo, hi, count) {
  const pool = [];
  for (let i = lo; i <= hi; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function makeCard() {
  const cols = [
    pickRandom(1,15,5), pickRandom(16,30,5), pickRandom(31,45,5),
    pickRandom(46,60,5), pickRandom(61,75,5),
  ];
  const grid = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 2) row.push(0);
      else row.push(cols[c][r]);
    }
    grid.push(row);
  }
  return grid;
}

function generateAllCards() {
  const cards = {};
  for (let i = 1; i <= NUM_LOCALS; i++) {
    cards[`local_${i}`] = [];
    for (let j = 0; j < CARDS_PER_LOCAL; j++) cards[`local_${i}`].push(makeCard());
  }
  return cards;
}

// ── COUNTDOWN TIMER ─────────────────────────────────────────────────
let countdownInterval = null;
let countdownSeconds = ROUND_MINUTES * 60;
let autoDrawInterval = null;
let autoDrawRunning = false;
const DRAW_INTERVAL_MS = 5500; // ms between balls

// Init cards on startup
gameState.cards = generateAllCards();
gameState.prizes = initPrizes();

function startAutoDraw() {
  if (autoDrawRunning) return;
  if (waitingForPlay) return; // waiting for host to press PLAY
  autoDrawRunning = true;
  broadcastAll({ type: 'auto_started' });
  autoDrawInterval = setInterval(() => {
    if (!gameState.active) return;
    const remaining = [];
    for (let n = 1; n <= 75; n++) {
      if (!gameState.drawnNumbers.includes(n)) remaining.push(n);
    }
    if (!remaining.length) {
      stopAutoDraw();
      return;
    }
    const n = remaining[Math.floor(Math.random() * remaining.length)];
    gameState.drawnNumbers.push(n);
    broadcastAll({ type: 'draw', n });
    // If ALL 75 balls drawn, start countdown
    if (gameState.drawnNumbers.length >= 75 && !gameState.countdownActive) {
      stopAutoDraw();
      console.log('All 75 balls drawn — starting 10-min countdown');
      startCountdown();
    }
  }, DRAW_INTERVAL_MS);
}

function stopAutoDraw() {
  autoDrawRunning = false;
  clearInterval(autoDrawInterval);
  autoDrawInterval = null;
  broadcastAll({ type: 'auto_stopped' });
}

let waitingForPlay = false; // true after reset, waiting for PLAY button

function buildSalesReport(game) {
  const report = { locals: {}, totals: { cards: 0, revenue: 0, prizes: 0, net: 0 } };
  for (let i = 1; i <= NUM_LOCALS; i++) {
    const key = `local_${i}`;
    const sales = game.sales?.[key] || [];
    const prizes = game.prizes?.[key] || [];
    const revenue = sales.length * CARD_PRICE;
    const prizesTotal = prizes.reduce((s, p) => s + (p.amount || 0), 0);
    report.locals[key] = {
      name: gameState.localNames[key] || `Local ${i}`,
      cardsSold: sales.length, revenue, prizes: prizesTotal,
      net: revenue - prizesTotal,
      salesDetail: sales, prizesDetail: prizes
    };
    report.totals.cards += sales.length;
    report.totals.revenue += revenue;
    report.totals.prizes += prizesTotal;
    report.totals.net += revenue - prizesTotal;
  }
  return report;
}

server.listen(PORT, () => {
  console.log(`✅ Bingo Tavarez corriendo en puerto ${PORT}`);
});
function startCountdown(seconds = ROUND_MINUTES * 60) {
  countdownSeconds = seconds;
  gameState.countdownActive = true;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    countdownSeconds--;
    broadcastAll({ type: 'countdown', seconds: countdownSeconds });
    if (countdownSeconds <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      waitingForPlay = false; // auto-start from countdown is OK
      startNewGame();
      setTimeout(() => startAutoDraw(), 2000);
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  gameState.countdownActive = false;
  broadcastAll({ type: 'countdown_stopped' });
}

// ── CONNECTED CLIENTS ────────────────────────────────────────────────
const clients = new Map();

function broadcastAll(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(msg);
  });
}

function broadcastToLocal(localId, data) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (info.localId === localId && ws.readyState === 1) ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getConnectedLocals() {
  const set = new Set();
  clients.forEach(info => { if (info.role === 'local') set.add(info.localId); });
  return [...set].sort((a,b) => a-b);
}

function broadcastLocalsUpdate() {
  broadcastAll({
    type: 'locals_update',
    connected: getConnectedLocals(),
    names: gameState.localNames,
    disabled: [...gameState.disabledLocals]
  });
}

// ── START NEW GAME ───────────────────────────────────────────────────
function startNewGame() {
  // Archive current game to history
  if (salesData.currentGame.startedAt) {
    salesData.currentGame.endedAt = new Date().toISOString();
    salesData.currentGame.drawnNumbers = [...gameState.drawnNumbers];
    salesData.games.unshift(salesData.currentGame); // newest first
    if (salesData.games.length > 100) salesData.games = salesData.games.slice(0, 100);
  }
  // Keep sales from the selling window (collected during countdown)
  // They belong to this new game
  const keptSales = salesData.currentGame.sales || {};
  salesData.currentGame = {
    gameId: Date.now(),
    startedAt: new Date().toISOString(),
    sales: keptSales, // keep names already entered
    prizes: {}
  };
  saveSalesData();

  gameState.drawnNumbers = [];
  gameState.active = true;
  gameState.cards = generateAllCards();
  gameState.prizes = initPrizes();
  gameState.disabledLocals = new Set(); // reset disabled list each new game
  // NOTE: localNames intentionally NOT reset — preserved across games

  // Send each local their new cards
  clients.forEach((info, ws) => {
    if (info.role === 'local') {
      sendTo(ws, {
        type: 'new_game',
        cards: gameState.cards[`local_${info.localId}`] || [],
        drawnNumbers: [],
        localName: gameState.localNames[`local_${info.localId}`]
      });
    }
  });
  // Send new cards to each local
  clients.forEach((info, client) => {
    if (info.role === 'local') {
      sendTo(client, {
        type: 'new_game',
        cards: gameState.cards[`local_${info.localId}`] || [],
        prizes: gameState.prizes[`local_${info.localId}`] || {}
      });
    }
  });
  sendTo(getHostWs(), { type: 'new_game_confirmed', state: gameState });
  // startCountdown will open cajero when called after fullCard
}

function getHostWs() {
  for (const [ws, info] of clients) {
    if (info.role === 'host' && ws.readyState === 1) return ws;
  }
  return null;
}

// ── WEBSOCKET HANDLER ─────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join_host':
        clients.set(ws, { role: 'host' });
        sendTo(ws, {
          type: 'state', state: gameState,
          countdown: countdownSeconds,
          countdownActive: gameState.countdownActive,
          sales: salesData ? salesData.currentGame.sales : {}
        });
        broadcastLocalsUpdate();
        break;

      case 'join_cajero':
        clients.set(ws, { role: 'cajero', localId: msg.localId });
        // Send current countdown state
        if (gameState.countdownActive) {
          sendTo(ws, { type: 'countdown', seconds: countdownSeconds });
        }
        break;

      case 'join_local':
        clients.set(ws, { role: 'local', localId: msg.localId });
        sendTo(ws, {
          type: 'state',
          state: {
            ...gameState,
            disabledLocals: [...gameState.disabledLocals]
          },
          cards: gameState.cards[`local_${msg.localId}`] || [],
          prizes: gameState.prizes[`local_${msg.localId}`] || {},
          localName: gameState.localNames[`local_${msg.localId}`],
          isDisabled: gameState.disabledLocals.has(msg.localId),
          countdown: countdownSeconds,
          countdownActive: gameState.countdownActive,
          sales: salesData ? (salesData.currentGame.sales[`local_${msg.localId}`] || []) : []
        });
        broadcastLocalsUpdate();
        break;

      case 'new_game':
        startNewGame();
        break;

      case 'toggle_auto':
        if (autoDrawRunning) stopAutoDraw();
        else startAutoDraw();
        break;
      case 'start_auto':
        waitingForPlay = false;
        startAutoDraw();
        break;
      case 'stop_auto':
        stopAutoDraw();
        break;

      case 'card_sold': {
        // Local reports a card was sold
        const { cardIdx, playerName, price } = msg;
        const localKey = `local_${info.localId}`;
        if (!salesData.currentGame.sales[localKey]) salesData.currentGame.sales[localKey] = [];
        // Check not already sold
        const alreadySold = salesData.currentGame.sales[localKey].some(s => s.cardIdx === cardIdx);
        if (!alreadySold) {
          salesData.currentGame.sales[localKey].push({
            cardIdx,
            playerName: playerName || `Cartón ${cardIdx+1}`,
            price: price || CARD_PRICE,
            soldAt: new Date().toISOString()
          });
          saveSalesData();
          // Broadcast sold status to all in same local
          broadcastAll({ type: 'card_sold_confirm', localId: info.localId, cardIdx, playerName: playerName || `Cartón ${cardIdx+1}` });
          // Notify host
          sendTo(getHostWs(), { type: 'sales_update', localId: info.localId, sales: salesData.currentGame.sales[localKey] });
        }
        break;
      }

      case 'card_unsold': {
        // Undo a sale
        const localKey2 = `local_${info.localId}`;
        if (salesData.currentGame.sales[localKey2]) {
          salesData.currentGame.sales[localKey2] = salesData.currentGame.sales[localKey2].filter(s => s.cardIdx !== msg.cardIdx);
          saveSalesData();
          broadcastAll({ type: 'card_unsold_confirm', localId: info.localId, cardIdx: msg.cardIdx });
          sendTo(getHostWs(), { type: 'sales_update', localId: info.localId, sales: salesData.currentGame.sales[localKey2] });
        }
        break;
      }

      case 'get_sales_report': {
        // Host requests full sales report
        if (info.role !== 'host') break;
        res_sales(ws);
        break;
      }

      case 'draw':
        if (!gameState.drawnNumbers.includes(msg.n)) {
          gameState.drawnNumbers.push(msg.n);
          broadcastAll({ type: 'draw', n: msg.n });
          // If ALL 75 balls drawn, start countdown for next game
          if (gameState.drawnNumbers.length >= 75 && !gameState.countdownActive) {
            console.log('All 75 balls drawn — starting 15-min countdown');
            startCountdown(ROUND_MINUTES * 60);
            broadcastAll({ type: 'countdown', seconds: ROUND_MINUTES * 60 });
          }
        }
        break;

      case 'prize_won':
        // Prizes are per-local — only update and notify that specific local
        const localKey = `local_${msg.localId}`;
        if (gameState.prizes[localKey] && !gameState.prizes[localKey][msg.prize]) {
          gameState.prizes[localKey][msg.prize] = { cardIdx: msg.cardIdx, playerName: msg.playerName };
          // Broadcast to ALL locals + host so ticker shows on every screen
          const prizeMsg = {
            type: 'prize_won',
            prize: msg.prize,
            localId: msg.localId,
            cardIdx: msg.cardIdx,
            playerName: msg.playerName,
            x2: msg.x2 || false
          };
          broadcastAll(prizeMsg); // sends to every connected client including all locals
          // Auto start 10-min countdown when fullCard is won
          if (msg.prize === 'fullCard' && !gameState.countdownActive) {
            setTimeout(() => startCountdown(), 3000); // 3s delay so winner animation shows
          }
        }
        break;

      case 'set_local_name':
        gameState.localNames[`local_${msg.localId}`] = msg.name;
        broadcastLocalsUpdate();
        // Notify that local of their new name
        broadcastToLocal(msg.localId, { type: 'name_update', name: msg.name });
        break;

      case 'start_countdown':
        startCountdown(msg.seconds || ROUND_MINUTES * 60);
        broadcastAll({ type: 'countdown', seconds: countdownSeconds });
        break;

      case 'stop_countdown':
        stopCountdown();
        break;

      case 'reset':
        stopAutoDraw();
        waitingForPlay = true;
        // Restart countdown so cajero opens
        stopCountdown();
        startCountdown();
        gameState.drawnNumbers = [];
        gameState.prizes = initPrizes();
        gameState.cards = generateAllCards();
        clients.forEach((info, client) => {
          if (info.role === 'local') {
            sendTo(client, {
              type: 'reset',
              cards: gameState.cards[`local_${info.localId}`] || [],
              prizes: gameState.prizes[`local_${info.localId}`]
            });
          }
        });
        sendTo(ws, { type: 'reset_confirmed', state: gameState });
        break;

      case 'disable_local':
        gameState.disabledLocals.add(msg.localId);
        broadcastToLocal(msg.localId, { type: 'disabled', localId: msg.localId });
        broadcastLocalsUpdate();
        break;

      case 'enable_local':
        gameState.disabledLocals.delete(msg.localId);
        broadcastToLocal(msg.localId, { type: 'enabled', localId: msg.localId });
        broadcastLocalsUpdate();
        break;

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastLocalsUpdate();
  });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
}));
app.get('/host',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/local',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'local.html')));
app.get('/local/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'local.html')));
app.get('/cajero', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cajero.html')));
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.redirect('/host'));

// ── CAJERO & ADMIN API ───────────────────────────────────────────────
app.post('/api/cajero/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = CAJERO_USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = Buffer.from(`${username}:${password}:${user.localId}`).toString('base64');
  res.json({ ok: true, localId: user.localId, name: user.name, token });
});

function verifyCajero(req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const localId = parts[2];
    const username = parts[0];
    const password = parts[1];
    const user = CAJERO_USERS[username];
    if (!user || user.password !== password) return null;
    return { localId: parseInt(localId), username };
  } catch(e) { return null; }
}

app.get('/api/cajero/cards', (req, res) => {
  const user = verifyCajero(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });
  const localKey = `local_${user.localId}`;
  const cards = gameState.cards[localKey] || [];
  const sales = salesData.currentGame.sales[localKey] || [];
  const soldMap = {};
  sales.forEach(s => { soldMap[s.cardIdx] = s.playerName; });
  res.json({
    localId: user.localId,
    localName: gameState.localNames[localKey] || `Local ${user.localId}`,
    gameActive: gameState.active,
    cards: cards.map((card, i) => ({
      idx: i, grid: card,
      sold: soldMap[i] !== undefined,
      playerName: soldMap[i] || ''
    }))
  });
});

app.post('/api/cajero/sell', (req, res) => {
  const user = verifyCajero(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });
  const { cardIdx, playerName, action } = req.body || {};
  const localKey = `local_${user.localId}`;
  if (!salesData.currentGame.sales[localKey]) salesData.currentGame.sales[localKey] = [];
  if (action === 'sell') {
    const alreadySold = salesData.currentGame.sales[localKey].some(s => s.cardIdx === cardIdx);
    if (!alreadySold) {
      salesData.currentGame.sales[localKey].push({
        cardIdx, playerName: playerName || `Cartón ${cardIdx+1}`,
        price: CARD_PRICE, soldAt: new Date().toISOString()
      });
      saveSalesData();
      broadcastAll({ type: 'card_sold_confirm', localId: user.localId, cardIdx, playerName: playerName || `Cartón ${cardIdx+1}` });
    }
  } else if (action === 'unsell') {
    salesData.currentGame.sales[localKey] = salesData.currentGame.sales[localKey].filter(s => s.cardIdx !== cardIdx);
    saveSalesData();
    broadcastAll({ type: 'card_unsold_confirm', localId: user.localId, cardIdx });
  }
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== 'admin2024') return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ ok: true, token: Buffer.from('admin:admin2024').toString('base64') });
});

app.get('/api/sales/current', (req, res) => {
  res.json({ game: salesData.currentGame, report: buildSalesReport(salesData.currentGame) });
});

app.get('/api/sales/history', (req, res) => {
  const history = salesData.games.slice(0, 50).map(g => ({
    gameId: g.gameId, startedAt: g.startedAt, endedAt: g.endedAt,
    report: buildSalesReport(g)
  }));
  res.json({ history, currentGame: { gameId: salesData.currentGame.gameId, startedAt: salesData.currentGame.startedAt, report: buildSalesReport(salesData.currentGame) } });
});
