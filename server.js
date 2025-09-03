// server.js – enkel live-server för kart-quiz (host + spelare)
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // enkel CORS för test

// --- Hjälp ---
const haversineKm = (a, b) => {
  const toRad = d => d * Math.PI / 180, R = 6371;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const makeCode = () => String(Math.floor(100000 + Math.random()*900000)); // 6 siffror
const room = id => `game:${id}`;

// --- “Databas” i minnet ---
const gamesById = new Map();   // id -> game
const gamesByCode = new Map(); // code -> id

function endRound(gameId) {
  const g = gamesById.get(gameId);
  if (!g || !g.current) return;
  if (g.timer) { clearTimeout(g.timer); g.timer = null; }

  const { target, guesses } = g.current;
  const results = [];
  for (const [pid, p] of g.players) {
    const guess = guesses.get(pid);
    const km = guess ? guess.km : g.penaltyKm;
    p.totalKm += km;
    results.push({
      name: p.name,
      km: +km.toFixed(1),
      totalKm: +p.totalKm.toFixed(1),
      guess: guess ? { lat: guess.lat, lng: guess.lng } : null
    });
  }
  results.sort((a,b) => a.km - b.km);
  g.state = 'showing_results';
  io.to(room(gameId)).emit('round:results', {
    round: g.round,
    city: { name: g.current.cityName, ...target },
    results
  });
}

io.on('connection', (socket) => {
  socket.data.role = null;   // 'host' eller 'player'
  socket.data.gameId = null; // vilket spel
  socket.data.playerId = null;

  // Host skapar spel -> får kod
  socket.on('host:createGame', ({ roundTimeSec = 10, penaltyKm = 20000 } = {}) => {
    const gameId = `${Date.now()}-${Math.floor(Math.random()*1000)}`;
    let code; do { code = makeCode(); } while (gamesByCode.has(code));

    const game = {
      id: gameId,
      code,
      state: 'lobby',     // 'lobby' | 'in_round' | 'showing_results' | 'finished'
      host: socket.id,
      round: 0,
      roundTimeSec,
      penaltyKm,
      players: new Map(), // playerId -> {id,name,totalKm}
      current: null,      // pågående runda
      timer: null
    };
    gamesById.set(gameId, game);
    gamesByCode.set(code, gameId);

    socket.data.role = 'host';
    socket.data.gameId = gameId;
    socket.join(room(gameId));

    socket.emit('game:created', { gameId, code, roundTimeSec, penaltyKm });
    io.to(room(gameId)).emit('lobby:update', { players: [...game.players.values()] });
  });

  // Spelare går med med kod + namn
  socket.on('player:join', ({ code, name }) => {
    const gameId = gamesByCode.get(code);
    const g = gamesById.get(gameId);
    if (!g || g.state === 'finished') {
      socket.emit('join:error', { message: 'Ingen aktiv match med den koden.' }); return;
    }
    const playerId = `p-${Math.random().toString(36).slice(2,8)}`;
    const player = { id: playerId, name: name || 'Spelare', totalKm: 0 };
    g.players.set(playerId, player);

    socket.data.role = 'player';
    socket.data.gameId = gameId;
    socket.data.playerId = playerId;
    socket.join(room(gameId));

    socket.emit('player:joined', { gameId, playerId, name: player.name, code: g.code });
    io.to(room(gameId)).emit('lobby:update', { players: [...g.players.values()] });
  });

  // Host startar runda (host väljer lat/lon)
  socket.on('host:startRound', ({ gameId, cityName, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.timer) clearTimeout(g.timer);

    g.round += 1;
    const startedAt = Date.now();
    const deadlineAt = startedAt + g.roundTimeSec * 1000;
    g.state = 'in_round';
    g.current = {
      cityName: cityName || 'Okänd plats',
      target: { lat, lng },
      startedAt, deadlineAt,
      guesses: new Map() // playerId -> {lat,lng,km,at}
    };

    io.to(room(gameId)).emit('round:started', { round: g.round, cityName: g.current.cityName, deadlineAt });

    // Stäng rundan när tiden gått
    g.timer = setTimeout(() => endRound(gameId), g.roundTimeSec * 1000);
  });

  // Spelare skickar gissning (första gissning räknas)
  socket.on('player:submitGuess', ({ gameId, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || g.state !== 'in_round') return;
    const pid = socket.data.playerId;
    if (!pid || !g.players.has(pid)) return;
    if (g.current.guesses.has(pid)) return; // redan gissat

    const km = haversineKm({ lat, lng }, g.current.target);
    g.current.guesses.set(pid, { lat, lng, km, at: Date.now() });
    socket.emit('guess:accepted', { km: +km.toFixed(1) });

    // Stäng när alla gissat
    if (g.current.guesses.size >= g.players.size) {
      if (g.timer) clearTimeout(g.timer);
      endRound(gameId);
    }
  });

  // Host: nästa runda / avsluta
  socket.on('host:nextRound', ({ gameId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    g.state = 'lobby';
    io.to(room(gameId)).emit('lobby:ready');
  });

  socket.on('host:endGame', ({ gameId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    g.state = 'finished';
    const leaderboard = [...g.players.values()]
      .sort((a,b)=>a.totalKm-b.totalKm)
      .map(p => ({ name: p.name, totalKm: +p.totalKm.toFixed(1) }));
    io.to(room(gameId)).emit('game:final', { leaderboard });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server igång: http://localhost:${PORT}`));
