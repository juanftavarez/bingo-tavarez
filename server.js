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

// Prize amounts — must match local.html PRIZES table
const PRIZE_AMOUNTS = {
  COSITA: 50, MEDIO: 50, L: 50, T: 50, X: 50, CRUZ: 50,
  line: 150, fullCard: 500
};

// ── PERSISTENCE: PostgreSQL (Railway) with in-memory working copy ─────
const { Pool } = require('pg');
const fs = require('fs');
const SALES_FILE = './sales_data.json';

// In-memory working copy. currentGame is the round in progress; games is a
// recent cache. The permanent record lives in Postgres (table "games").
let salesData = { games: [], currentGame: { gameId: Date.now(), startedAt: null, sales: {}, prizes: {} }, localNames: {} };

let pool = null;
let dbReady = false;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.on('error', (e) => console.error('PG pool error:', e.message));
}

async function initDb() {
  if (!pool) { console.warn('⚠️ No DATABASE_URL — running with file/memory only'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        game_id     BIGINT PRIMARY KEY,
        started_at  TIMESTAMPTZ,
        ended_at    TIMESTAMPTZ,
        cancelled   BOOLEAN DEFAULT FALSE,
        report      JSONB,
        sales       JSONB,
        prizes      JSONB,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS games_ended_idx ON games (ended_at);
      CREATE TABLE IF NOT EXISTS local_names (
        local_key TEXT PRIMARY KEY,
        name      TEXT NOT NULL
      );
    `);
    dbReady = true;
    console.log('✅ PostgreSQL conectado y tablas listas');
    // Load saved local names into memory
    const r = await pool.query('SELECT local_key, name FROM local_names');
    r.rows.forEach(row => { salesData.localNames[row.local_key] = row.name; });
  } catch (e) {
    console.error('❌ Error iniciando DB:', e.message);
  }
}

// Archive a finished/cancelled game permanently to Postgres
async function archiveGameToDb(game, report) {
  if (!dbReady) return;
  try {
    await pool.query(
      `INSERT INTO games (game_id, started_at, ended_at, cancelled, report, sales, prizes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (game_id) DO UPDATE SET ended_at=$3, cancelled=$4, report=$5, sales=$6, prizes=$7`,
      [game.gameId, game.startedAt, game.endedAt || new Date().toISOString(),
       !!game.cancelled, JSON.stringify(report), JSON.stringify(game.sales||{}), JSON.stringify(game.prizes||{})]
    );
  } catch (e) { console.error('archiveGameToDb error:', e.message); }
}

async function saveLocalNameToDb(localKey, name) {
  if (!dbReady) return;
  try {
    await pool.query(
      `INSERT INTO local_names (local_key, name) VALUES ($1,$2)
       ON CONFLICT (local_key) DO UPDATE SET name=$2`,
      [localKey, name]
    );
  } catch (e) { console.error('saveLocalNameToDb error:', e.message); }
}

// Legacy file save kept only as a backup of the live round (best-effort)
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
// Restore saved local names from disk (survive restarts/deploys).
// Only fall back to defaults for names that were never assigned.
gameState.localNames = initLocalNames();
if (salesData.localNames) {
  Object.assign(gameState.localNames, salesData.localNames);
}

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
    // If ALL 75 balls drawn with no fullCard, the round ends here
    if (gameState.drawnNumbers.length >= 75 && !gameState.countdownActive) {
      console.log('All 75 balls drawn — round ends');
      finishRound();
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
let autoChainStopped = false; // true when host pressed DETENER — blocks next round

// Called when a round's ball-drawing has ENDED (fullCard or all 75 balls).
// Sends the final cuadre (with prizes) to admin, then either chains the next
// round automatically or stops if the host pressed DETENER.
let roundFinishing = false;
function finishRound() {
  if (roundFinishing) return; // guard against double-trigger
  roundFinishing = true;

  stopAutoDraw();

  // Final cuadre of THIS round, prizes included → send to admin + all screens
  const report = buildSalesReport(salesData.currentGame);
  broadcastAll({ type: 'sales_report_auto', report, closedAt: new Date().toISOString() });
  broadcastAll({ type: 'round_ended' }); // tell host to hide the winner banner
  console.log('📊 Cuadre enviado a admin — net total:', report.totals.net);

  if (autoChainStopped) {
    // Host stopped the chain — do not open a new round
    gameState.active = false;
    broadcastAll({ type: 'chain_stopped' });
    roundFinishing = false;
    return;
  }

  // Chain the next round immediately: archive, deal new cards, open the
  // selling window with the countdown right away.
  setTimeout(() => {
    startNewGame();          // resets roundFinishing = false
    startCountdown(ROUND_MINUTES * 60); // broadcasts cajero_open → unlocks cajeros
  }, 500); // brief gap so the cuadre/round_ended messages are processed first
}

function buildSalesReport(game) {
  const report = { locals: {}, totals: { cards: 0, revenue: 0, prizes: 0, net: 0 } };
  for (let i = 1; i <= NUM_LOCALS; i++) {
    const key = `local_${i}`;
    const sales = game.sales?.[key] || [];
    const prizes = game.prizes?.[key] || [];
    const revenue = sales.length * CARD_PRICE;
    // Only prizes won by a SOLD (paid) card are a real payout. Prizes on
    // unsold cards belong to the house — they are NOT discounted.
    const prizesTotal = prizes.reduce((s, p) => s + (p.wasSold ? (p.amount || 0) : 0), 0);
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

// Connect to Postgres, then apply any saved local names over the defaults
initDb().then(() => {
  if (salesData.localNames) Object.assign(gameState.localNames, salesData.localNames);
});
function startCountdown(seconds = ROUND_MINUTES * 60) {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownSeconds = seconds;
  gameState.countdownActive = true;

  const CAJERO_CLOSE_AT = 60; // lock cajero 60s before game starts
  let cajeroClosed = false;

  // Open cajero immediately
  broadcastAll({ type: 'cajero_open', secondsToClose: seconds - CAJERO_CLOSE_AT });
  broadcastAll({ type: 'countdown', seconds: countdownSeconds });

  countdownInterval = setInterval(() => {
    countdownSeconds--;
    broadcastAll({ type: 'countdown', seconds: countdownSeconds });

    // Lock cajero at exactly 60s remaining (selling closes; cuadre is sent
    // later, when the round actually ENDS — see finishRound)
    if (!cajeroClosed && countdownSeconds <= CAJERO_CLOSE_AT) {
      cajeroClosed = true;
      broadcastAll({ type: 'cajero_close' });
      console.log('🔒 Cajero locked at', countdownSeconds, 'seconds remaining');
    }

    if (countdownSeconds <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      gameState.countdownActive = false;
      waitingForPlay = false;
      // Selling window closed → start drawing balls on the SAME cards
      // that were sold during this window. Do NOT re-deal cards here.
      gameState.active = true;
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
  roundFinishing = false; // clear the round-finishing guard for the new round
  // Archive current game to history (with its sales + prizes)
  if (salesData.currentGame.startedAt) {
    salesData.currentGame.endedAt = new Date().toISOString();
    salesData.currentGame.drawnNumbers = [...gameState.drawnNumbers];
    salesData.games.unshift(salesData.currentGame); // newest first (memory cache)
    if (salesData.games.length > 100) salesData.games = salesData.games.slice(0, 100);
    // Permanent record in Postgres
    archiveGameToDb(salesData.currentGame, buildSalesReport(salesData.currentGame));
  }
  // Fresh round — clean slate. Sales of the new selling window start empty.
  salesData.currentGame = {
    gameId: Date.now(),
    startedAt: new Date().toISOString(),
    sales: {},   // reset: no carried-over sales
    prizes: {}   // reset: no carried-over prizes
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
        // Deal fresh cards + reset accounting, then open the selling window
        // (countdown). Balls are NOT drawn until the countdown reaches zero.
        autoChainStopped = false; // (re)start the automatic chain
        stopAutoDraw();
        startNewGame();
        startCountdown(ROUND_MINUTES * 60);
        break;

      case 'start_now':
        // Skip the remaining selling window and start drawing balls immediately
        // on the cards already sold this round.
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        gameState.countdownActive = false;
        broadcastAll({ type: 'cajero_close' }); // selling closes now
        broadcastAll({ type: 'countdown', seconds: 0 });
        gameState.active = true;
        waitingForPlay = false;
        startAutoDraw();
        break;

      case 'stop_chain':
        // Host wants the auto-chain to stop after the current round
        autoChainStopped = true;
        broadcastAll({ type: 'chain_stopping' });
        break;

      case 'resume_chain':
        // Host re-enables the auto-chain
        autoChainStopped = false;
        broadcastAll({ type: 'chain_resumed' });
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
          // If ALL 75 balls drawn with no fullCard, the round ends here
          if (gameState.drawnNumbers.length >= 75 && !gameState.countdownActive) {
            console.log('All 75 balls drawn — round ends');
            finishRound();
          }
        }
        break;

      case 'prize_won':
        // Prizes are per-local — only update and notify that specific local
        const localKey = `local_${msg.localId}`;
        if (gameState.prizes[localKey] && !gameState.prizes[localKey][msg.prize]) {
          gameState.prizes[localKey][msg.prize] = { cardIdx: msg.cardIdx, playerName: msg.playerName };

          // ── Record the prize payout in the accounting ──
          // Base amount from the prize table, doubled if it was an x2 win.
          const baseAmt = PRIZE_AMOUNTS[msg.prize] || 0;
          const amount = msg.x2 ? baseAmt * 2 : baseAmt;
          // Was this winning card actually sold? (only sold cards are a real payout)
          const soldList = salesData.currentGame.sales[localKey] || [];
          const soldEntry = soldList.find(s => s.cardIdx === msg.cardIdx);
          if (!salesData.currentGame.prizes[localKey]) salesData.currentGame.prizes[localKey] = [];
          salesData.currentGame.prizes[localKey].push({
            prize: msg.prize,
            amount,
            cardIdx: msg.cardIdx,
            playerName: msg.playerName || (soldEntry ? soldEntry.playerName : `Cartón ${msg.cardIdx+1}`),
            wasSold: !!soldEntry,
            x2: !!msg.x2,
            wonAt: new Date().toISOString()
          });
          saveSalesData();
          // Notify host so the sales log updates live
          sendTo(getHostWs(), { type: 'sales_update', localId: msg.localId, sales: soldList });

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
        }
        // NOTE: fullCard no longer ends the round. Balls keep drawing until
        // all 75 are out — that is when finishRound() fires (see auto/manual draw).
        break;

      case 'set_local_name': {
        const lk = `local_${msg.localId}`;
        gameState.localNames[lk] = msg.name;
        if (!salesData.localNames) salesData.localNames = {};
        salesData.localNames[lk] = msg.name;
        saveSalesData();
        saveLocalNameToDb(lk, msg.name); // permanent in Postgres
        broadcastLocalsUpdate();
        broadcastToLocal(msg.localId, { type: 'name_update', name: msg.name });
        break;
      }

      case 'start_countdown':
        startCountdown(msg.seconds || ROUND_MINUTES * 60);
        broadcastAll({ type: 'countdown', seconds: countdownSeconds });
        break;

      case 'stop_countdown':
        stopCountdown();
        break;

      case 'reset': {
        stopAutoDraw();
        // Archive the current round as CANCELLED (for the day's records)
        if (salesData.currentGame.startedAt) {
          salesData.currentGame.endedAt = new Date().toISOString();
          salesData.currentGame.cancelled = true;
          salesData.currentGame.drawnNumbers = [...gameState.drawnNumbers];
          salesData.games.unshift(salesData.currentGame);
          if (salesData.games.length > 500) salesData.games = salesData.games.slice(0, 500);
          archiveGameToDb(salesData.currentGame, buildSalesReport(salesData.currentGame));
        }
        // Fresh round — clean slate, new cards, empty sales/prizes
        salesData.currentGame = {
          gameId: Date.now(),
          startedAt: new Date().toISOString(),
          sales: {},
          prizes: {}
        };
        saveSalesData();
        roundFinishing = false;
        gameState.drawnNumbers = [];
        gameState.prizes = initPrizes();
        gameState.cards = generateAllCards();
        gameState.active = true;
        // Tell locals the round was cancelled + give them fresh empty cards
        clients.forEach((info, client) => {
          if (info.role === 'local') {
            sendTo(client, {
              type: 'reset',
              cancelled: true,
              cards: gameState.cards[`local_${info.localId}`] || [],
              prizes: gameState.prizes[`local_${info.localId}`]
            });
          }
        });
        // Tell cajeros to clear sold names (new selling window)
        broadcastAll({ type: 'cajero_reset' });
        sendTo(ws, { type: 'reset_confirmed', state: gameState });
        // Open a brand-new selling window with the countdown from zero
        stopCountdown();
        startCountdown(ROUND_MINUTES * 60);
        break;
      }

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

// ── PERMANENT HISTORY FROM POSTGRES ──────────────────────────────────
// Helper: sum a report's totals into a day accumulator
function blankTotals() { return { cards: 0, revenue: 0, prizes: 0, net: 0, games: 0 }; }

// All games of a given day (default: today). ?date=YYYY-MM-DD
app.get('/api/db/day', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT game_id, started_at, ended_at, cancelled, report
       FROM games
       WHERE ended_at::date = $1
       ORDER BY ended_at ASC`, [date]
    );
    const totals = blankTotals();
    const games = r.rows.map(row => {
      const rep = row.report || {};
      const t = rep.totals || { cards:0, revenue:0, prizes:0, net:0 };
      if (!row.cancelled) {
        totals.cards += t.cards; totals.revenue += t.revenue;
        totals.prizes += t.prizes; totals.net += t.net; totals.games += 1;
      }
      return { gameId: row.game_id, startedAt: row.started_at, endedAt: row.ended_at,
               cancelled: row.cancelled, totals: t };
    });
    res.json({ date, totals, games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One local's games for a day. /api/db/local/3?date=YYYY-MM-DD
app.get('/api/db/local/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const id = parseInt(req.params.id);
    const key = `local_${id}`;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT game_id, started_at, ended_at, cancelled, report
       FROM games
       WHERE ended_at::date = $1
       ORDER BY ended_at ASC`, [date]
    );
    const totals = blankTotals();
    const games = [];
    r.rows.forEach(row => {
      const local = row.report?.locals?.[key];
      if (!local) return;
      if (!row.cancelled) {
        totals.cards += local.cardsSold; totals.revenue += local.revenue;
        totals.prizes += local.prizes; totals.net += local.net; totals.games += 1;
      }
      games.push({ gameId: row.game_id, endedAt: row.ended_at, cancelled: row.cancelled,
                   cardsSold: local.cardsSold, revenue: local.revenue,
                   prizes: local.prizes, net: local.net });
    });
    res.json({ localId: id, name: gameState.localNames[key] || `Local ${id}`, date, totals, games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Range summary per day. /api/db/range?from=YYYY-MM-DD&to=YYYY-MM-DD&local=3(optional)
app.get('/api/db/range', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || to;
    const localKey = req.query.local ? `local_${parseInt(req.query.local)}` : null;
    const r = await pool.query(
      `SELECT ended_at::date AS day, cancelled, report
       FROM games
       WHERE ended_at::date BETWEEN $1 AND $2
       ORDER BY day ASC`, [from, to]
    );
    const byDay = {};
    const grand = blankTotals();
    r.rows.forEach(row => {
      if (row.cancelled) return;
      const day = row.day.toISOString ? row.day.toISOString().slice(0,10) : String(row.day);
      if (!byDay[day]) byDay[day] = blankTotals();
      let t;
      if (localKey) {
        const l = row.report?.locals?.[localKey];
        if (!l) return;
        t = { cards: l.cardsSold, revenue: l.revenue, prizes: l.prizes, net: l.net };
      } else {
        t = row.report?.totals || { cards:0, revenue:0, prizes:0, net:0 };
      }
      byDay[day].cards += t.cards; byDay[day].revenue += t.revenue;
      byDay[day].prizes += t.prizes; byDay[day].net += t.net; byDay[day].games += 1;
      grand.cards += t.cards; grand.revenue += t.revenue;
      grand.prizes += t.prizes; grand.net += t.net; grand.games += 1;
    });
    res.json({ from, to, local: req.query.local || null, byDay, grand });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
