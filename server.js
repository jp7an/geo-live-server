// server.js – live-server med 10 km frizon, 20s ronder, lobbylista och geokodning
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // enkelt för test

// ===== Inställningar =====
const FREE_RADIUS_KM = 10;      // <-- Frizon: första 10 km är gratis
const DEFAULT_ROUND_SEC = 20;   // 20s ronder
const DEFAULT_PENALTY_KM = 20000;

// ---- Avståndsberäkning (Haversine) ----
const haversineKm = (a, b) => {
  const toRad = d => d * Math.PI / 180, R = 6371;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const applyFreeRadius = (rawKm) => Math.max(0, rawKm - FREE_RADIUS_KM);

const makeCode = () => String(Math.floor(100000 + Math.random()*900000)); // 6 siffror
const room = id => `game:${id}`;

// ---- Minnes-”databas” ----
const gamesById = new Map();
const gamesByCode = new Map();

// ---- Geokodning (stad -> lat/lon) via Nominatim ----
// Byt 'din-email@exempel.se' till din riktiga e-post enligt Nominatims policy.
async function geocodeCity(name) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'kart-quiz/1.0 (skidgud@gmail.com)' }
  });
  if (!res.ok) throw new Error('Geokodning misslyckades');
  const data = await res.json();
  if (Array.isArray(data) && data[0]) {
    return { name, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  throw new Error('Hittade inte stad');
}

function endRound(gameId) {
  const g = gamesById.get(gameId);
  if (!g || !g.current) return;
  if (g.timer) { clearTimeout(g.timer); g.timer = null; }

  const { target, guesses } = g.current;
  const results = [];
  for (const [pid, p] of g.players) {
    const guess = guesses.get(pid);
    const km = guess ? guess.km : g.penaltyKm; // penaltypåslag om ingen gissning
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
  socket.data.role = null;
  socket.data.gameId = null;
  socket.data.playerId = null;

  // HOST: skapa spel -> få kod (default 20s ronder)
  socket.on('host:createGame', ({ roundTimeSec = DEFAULT_ROUND_SEC, penaltyKm = DEFAULT_PENALTY_KM } = {}) => {
    const gameId = `${Date.now()}-${Math.floor(Math.random()*1000)}`;
    let code; do { code = makeCode(); } while (gamesByCode.has(code));

    const game = {
      id: gameId, code,
      state: 'lobby', host: socket.id,
      round: 0, roundTimeSec, penaltyKm,
      players: new Map(), current: null, timer: null
    };
    gamesById.set(gameId, game);
    gamesByCode.set(code, gameId);

    socket.data.role = 'host';
    socket.data.gameId = gameId;
    socket.join(room(gameId));

    socket.emit('game:created', { gameId, code, roundTimeSec, penaltyKm, freeRadiusKm: FREE_RADIUS_KM });
    io.to(room(gameId)).emit('lobby:update', { players: [...game.players.values()] });
  });

  // SPELARE: gå med
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

  // HOST: starta runda – skriv stad (servern geokodar) eller skicka lat/lon
  socket.on('host:startRound', async ({ gameId, cityName, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.timer) clearTimeout(g.timer);

    let target;
    try {
      if (typeof lat === 'number' && typeof lng === 'number') {
        target = { lat, lng };
      } else if (cityName) {
        const c = await geocodeCity(cityName);
        target = { lat: c.lat, lng: c.lng };
      } else {
        socket.emit('round:error', { message: 'Ange stad eller lat,lng' });
        return;
      }
    } catch (e) {
      socket.emit('round:error', { message: 'Kunde inte hitta staden.' });
      return;
    }

    g.round += 1;
    const startedAt = Date.now();
    const deadlineAt = startedAt + g.roundTimeSec * 1000;
    g.state = 'in_round';
    g.current = {
      cityName: cityName || 'Okänd plats',
      target, startedAt, deadlineAt,
      guesses: new Map()
    };

    io.to(room(gameId)).emit('round:started', {
      round: g.round, cityName: g.current.cityName, deadlineAt, freeRadiusKm: FREE_RADIUS_KM
    });

    g.timer = setTimeout(() => endRound(gameId), g.roundTimeSec * 1000);
  });

  // SPELARE: skicka gissning
  socket.on('player:submitGuess', ({ gameId, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || g.state !== 'in_round') return;
    const pid = socket.data.playerId;
    if (!pid || !g.players.has(pid)) return;
    if (g.current.guesses.has(pid)) return;

    // 1) Rådistans, 2) applicera 10 km frizon
    const rawKm = haversineKm({ lat, lng }, g.current.target);
    const adjKm = applyFreeRadius(rawKm);

    g.current.guesses.set(pid, { lat, lng, km: adjKm, at: Date.now() });
    socket.emit('guess:accepted', { km: +adjKm.toFixed(1), rawKm: +rawKm.toFixed(1), freeKm: FREE_RADIUS_KM });

    if (g.current.guesses.size >= g.players.size) {
      if (g.timer) clearTimeout(g.timer);
      endRound(gameId);
    }
  });

  // HOST: nästa runda / avsluta
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

  // Rensa när någon kopplar ner
  socket.on('disconnect', () => {
    const gid = socket.data.gameId;
    if (!gid) return;
    const g = gamesById.get(gid);
    if (!g) return;
    if (socket.data.role === 'player' && socket.data.playerId) {
      g.players.delete(socket.data.playerId);
      io.to(room(gid)).emit('lobby:update', { players: [...g.players.values()] });
    } else if (socket.id === g.host) {
      // Om host försvinner: avsluta och visa slutställning
      g.state = 'finished';
      const leaderboard = [...g.players.values()]
        .sort((a,b)=>a.totalKm-b.totalKm)
        .map(p => ({ name: p.name, totalKm: +p.totalKm.toFixed(1) }));
      io.to(room(gid)).emit('game:final', { leaderboard });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server igång: http://localhost:${PORT}`));
