const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const NUM_LOCALS = 10;
const CARDS_PER_LOCAL = 15;

// ── GAME STATE ──────────────────────────────────────────────────────
let gameState = {
  drawnNumbers: [],
  active: false,
  cards: {},       // { "local_1": [...15 cards...], ... }
  prizes: {
    L: false, T: false, X: false, CRUZ: false,
    line: false, fullCard: false
  }
};

// ── BINGO CARD GENERATOR ────────────────────────────────────────────
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
    pickRandom(1,  15, 5),
    pickRandom(16, 30, 5),
    pickRandom(31, 45, 5),
    pickRandom(46, 60, 5),
    pickRandom(61, 75, 5),
  ];
  // Return as 5x5 grid row-major
  const grid = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 2) row.push(0); // FREE
      else row.push(cols[c][r]);
    }
    grid.push(row);
  }
  return grid;
}

function generateAllCards() {
  const cards = {};
  for (let local = 1; local <= NUM_LOCALS; local++) {
    cards[`local_${local}`] = [];
    for (let i = 0; i < CARDS_PER_LOCAL; i++) {
      cards[`local_${local}`].push(makeCard());
    }
  }
  return cards;
}

// ── CONNECTED CLIENTS ───────────────────────────────────────────────
const clients = new Map(); // ws → { role: 'host'|'local', localId: N }

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

// ── WEBSOCKET HANDLER ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('Client connected:', req.url);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join_host':
        clients.set(ws, { role: 'host' });
        sendTo(ws, { type: 'state', state: gameState });
        break;

      case 'join_local':
        clients.set(ws, { role: 'local', localId: msg.localId });
        sendTo(ws, {
          type: 'state',
          state: gameState,
          cards: gameState.cards[`local_${msg.localId}`] || []
        });
        break;

      case 'new_game':
        // Host starts a new game — generate all new cards
        gameState = {
          drawnNumbers: [],
          active: true,
          cards: generateAllCards(),
          prizes: { L:false, T:false, X:false, CRUZ:false, line:false, fullCard:false }
        };
        // Send each local their cards
        clients.forEach((info, client) => {
          if (info.role === 'local') {
            sendTo(client, {
              type: 'new_game',
              cards: gameState.cards[`local_${info.localId}`] || [],
              drawnNumbers: []
            });
          }
        });
        // Confirm to host
        sendTo(ws, { type: 'new_game_confirmed', state: gameState });
        console.log('New game started, cards generated for all locals');
        break;

      case 'draw':
        if (!gameState.drawnNumbers.includes(msg.n)) {
          gameState.drawnNumbers.push(msg.n);
          // Broadcast to everyone including host
          broadcast({ type: 'draw', n: msg.n });
        }
        break;

      case 'prize_won':
        if (!gameState.prizes[msg.prize]) {
          gameState.prizes[msg.prize] = { localId: msg.localId, cardIdx: msg.cardIdx };
          broadcast({
            type: 'prize_won',
            prize: msg.prize,
            localId: msg.localId,
            cardIdx: msg.cardIdx,
            playerName: msg.playerName
          });
        }
        break;

      case 'reset':
        gameState.drawnNumbers = [];
        gameState.prizes = { L:false, T:false, X:false, CRUZ:false, line:false, fullCard:false };
        gameState.cards = generateAllCards();
        clients.forEach((info, client) => {
          if (info.role === 'local') {
            sendTo(client, {
              type: 'reset',
              cards: gameState.cards[`local_${info.localId}`] || []
            });
          }
        });
        sendTo(ws, { type: 'reset_confirmed', state: gameState });
        break;

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

// ── STATIC FILES ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// All routes → serve the right page
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/local/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'local.html')));
app.get('/', (req, res) => res.redirect('/host'));

server.listen(PORT, () => {
  console.log(`✅ Bingo Tavarez corriendo en puerto ${PORT}`);
  console.log(`   Host:    http://localhost:${PORT}/host`);
  for (let i = 1; i <= NUM_LOCALS; i++) {
    console.log(`   Local ${i}: http://localhost:${PORT}/local/${i}`);
  }
});
