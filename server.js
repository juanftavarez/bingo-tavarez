const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const NUM_LOCALS = 10;
const CARDS_PER_LOCAL = 21;
const ROUND_MINUTES = 15;

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
      // Auto start new game
      startNewGame();
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
  sendTo(getHostWs(), { type: 'new_game_confirmed', state: gameState });

  // Countdown starts automatically when all 75 balls are drawn (see 'draw' case)
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
          countdownActive: gameState.countdownActive
        });
        broadcastLocalsUpdate();
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
          countdownActive: gameState.countdownActive
        });
        broadcastLocalsUpdate();
        break;

      case 'new_game':
        startNewGame();
        break;

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
        stopCountdown();
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/local/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'local.html')));
app.get('/', (req, res) => res.redirect('/host'));

server.listen(PORT, () => {
  console.log(`✅ Bingo Tavarez corriendo en puerto ${PORT}`);
});
