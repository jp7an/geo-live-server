// server.js – live-server med:
// - Reglage för rondtid + frizon (per match)
// - 10–60 s rondtid, 0–25 km frizon (valideras)
// - Kicka spelare
// - Host-återtag inom 3 min (utan ny kod)
// - Starta om spelet (nollställ poäng) utan ny kod
// - Geokodning stad -> lat/lon, robust felhantering
// - 10 km frizon som standard (kan ändras i UI)

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 60000,
  transports: ['websocket', 'polling']
});

// ======= Konstanter / standarder =======
const DEFAULT_ROUND_SEC = 20;
const DEFAULT_FREE_RADIUS_KM = 10;
const DEFAULT_PENALTY_KM = 20000;
const HOST_GRACE_MS = 3 * 60 * 1000; // 3 min för host att återta spelet

// ======= Läs städer från cities.json =======
let citiesData = [];
try {
  const citiesPath = path.join(__dirname, 'cities.json');
  const rawData = fs.readFileSync(citiesPath, 'utf8');
  citiesData = JSON.parse(rawData);
  console.log(`Laddade ${citiesData.length} städer från cities.json`);
} catch (error) {
  console.error('Kunde inte läsa cities.json:', error.message);
}

// ======= Hjälp =======
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toRad = d => d * Math.PI / 180;
const R = 6371;
const haversineKm = (a, b) => {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const makeCode = () => String(Math.floor(100000 + Math.random()*900000)); // 6 siffror
const makeHostToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const room = id => `game:${id}`;

// ======= “Databas” i minnet =======
/** game = {
 *  id, code, host (socketId|null), hostToken, hostDisconnectedAt|null, graceTimer|null,
 *  state: 'lobby' | 'in_round' | 'showing_results' | 'finished',
 *  round: number,
 *  settings: { roundTimeSec, freeRadiusKm, penaltyKm },
 *  players: Map<playerId, { id, name, totalKm, socketId }>,
 *  current: { cityName, target:{lat,lng}, startedAt, deadlineAt, guesses: Map<playerId, {lat,lng,km,rawKm,at}> } | null,
 *  timer: NodeJS.Timeout | null,
 *  randomGameCities: Array<City> | null
 * }
 */
const gamesById = new Map();
const gamesByCode = new Map();

// ======= Geokodning via Nominatim (OpenStreetMap) =======
async function geocodeCity(name) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'kart-quiz/1.0 (din-email@exempel.se)' }
  });
  if (!res.ok) throw new Error('Geokodning misslyckades');
  const data = await res.json();
  if (Array.isArray(data) && data[0]) {
    return { name, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  throw new Error('Hittade inte stad');
}

// ======= Slumpmässig stadsval för slumpmässigt läge =======
function selectRandomCities() {
  // Filtrera städer med population > 500000
  const validCities = citiesData.filter(city => city.population > 500000);
  
  // Dela upp städer per kontinent
  const europeCities = validCities.filter(c => c.continent === 'Europe');
  const northAmericaCities = validCities.filter(c => c.continent === 'North America');
  const otherCities = validCities.filter(c => 
    c.continent !== 'Europe' && c.continent !== 'North America'
  );
  
  // Hjälpfunktion för slumpmässigt urval utan duplicering
  const randomSelect = (arr, count) => {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, arr.length));
  };
  
  // Slumpmässigt välj städer
  const selected = [];
  selected.push(...randomSelect(europeCities, 4));
  selected.push(...randomSelect(northAmericaCities, 4));
  selected.push(...randomSelect(otherCities, 2));
  
  return selected;
}

// ======= Runda-slut =======
function endRound(gameId) {
  const g = gamesById.get(gameId);
  if (!g || !g.current) return;
  if (g.timer) { clearTimeout(g.timer); g.timer = null; }

  const { target, guesses } = g.current;
  const results = [];
  for (const [pid, p] of g.players) {
    const guess = guesses.get(pid);
    const km = guess ? guess.km : g.settings.penaltyKm;
    p.totalKm += km;
    results.push({
      id: p.id,
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

// ======= Socket.io =======
io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.gameId = null;
  socket.data.playerId = null;
  
  // Acknowledge connection
  socket.emit('connected', { socketId: socket.id });

  // ---- HOST: skapa spel ----
  socket.on('host:createGame', (payload = {}) => {
    let { roundTimeSec = DEFAULT_ROUND_SEC, freeRadiusKm = DEFAULT_FREE_RADIUS_KM, penaltyKm = DEFAULT_PENALTY_KM } = payload;
    roundTimeSec = clamp(parseInt(roundTimeSec, 10) || DEFAULT_ROUND_SEC, 10, 60);
    freeRadiusKm = clamp(parseInt(freeRadiusKm, 10) || DEFAULT_FREE_RADIUS_KM, 0, 25);
    penaltyKm = parseInt(penaltyKm, 10) || DEFAULT_PENALTY_KM;

    const gameId = `${Date.now()}-${Math.floor(Math.random()*1000)}`;
    let code; do { code = makeCode(); } while (gamesByCode.has(code));
    const hostToken = makeHostToken();

    const game = {
      id: gameId,
      code,
      host: socket.id,
      hostToken,
      hostDisconnectedAt: null,
      graceTimer: null,
      state: 'lobby',
      round: 0,
      settings: { roundTimeSec, freeRadiusKm, penaltyKm },
      players: new Map(),
      current: null,
      timer: null,
      randomGameCities: null
    };
    gamesById.set(gameId, game);
    gamesByCode.set(code, gameId);

    socket.data.role = 'host';
    socket.data.gameId = gameId;
    socket.join(room(gameId));

    socket.emit('game:created', { gameId, code, ...game.settings, hostToken });
    io.to(room(gameId)).emit('lobby:update', { players: [...game.players.values()] });
  });

  // ---- HOST: uppdatera inställningar (valfritt) ----
  socket.on('host:updateSettings', ({ gameId, roundTimeSec, freeRadiusKm }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (typeof roundTimeSec === 'number') g.settings.roundTimeSec = clamp(roundTimeSec, 10, 60);
    if (typeof freeRadiusKm === 'number') g.settings.freeRadiusKm = clamp(freeRadiusKm, 0, 25);
    io.to(room(gameId)).emit('settings:update', { ...g.settings });
  });

  // ---- SPELARE: gå med ----
  socket.on('player:join', ({ code, name }) => {
    const gameId = gamesByCode.get(code);
    const g = gamesById.get(gameId);
    if (!g || g.state === 'finished') {
      socket.emit('join:error', { message: 'Ingen aktiv match med den koden.' }); return;
    }
    const playerId = `p-${Math.random().toString(36).slice(2,8)}`;
    const player = { id: playerId, name: (name || 'Spelare').trim(), totalKm: 0, socketId: socket.id };
    g.players.set(playerId, player);

    socket.data.role = 'player';
    socket.data.gameId = gameId;
    socket.data.playerId = playerId;
    socket.join(room(gameId));

    socket.emit('player:joined', { gameId, playerId, name: player.name, code: g.code });
    io.to(room(gameId)).emit('lobby:update', { players: [...g.players.values()].map(p => ({ id:p.id, name:p.name, totalKm:p.totalKm })) });
  });

  // ---- HOST: starta runda (stad eller lat/lon) ----
  socket.on('host:startRound', async ({ gameId, cityName, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;

    // Geokoda först – ändra INTE state/round förrän vi har target
    let target;
    try {
      if (typeof lat === 'number' && typeof lng === 'number') {
        target = { lat, lng };
      } else if (cityName) {
        const c = await geocodeCity(cityName);
        target = { lat: c.lat, lng: c.lng };
      } else {
        socket.emit('round:error', { message: 'Ange stad eller lat,lng' });
        io.to(room(gameId)).emit('lobby:ready');
        return;
      }
    } catch (e) {
      socket.emit('round:error', { message: 'Kunde inte hitta staden.' });
      io.to(room(gameId)).emit('lobby:ready');
      return;
    }

    // Nu safe att starta runda
    if (g.timer) clearTimeout(g.timer);
    g.round += 1;
    const startedAt = Date.now();
    const deadlineAt = startedAt + g.settings.roundTimeSec * 1000;
    g.state = 'in_round';
    g.current = {
      cityName: cityName || 'Okänd plats',
      target, startedAt, deadlineAt,
      guesses: new Map()
    };

    io.to(room(gameId)).emit('round:started', {
      round: g.round, cityName: g.current.cityName, deadlineAt, freeRadiusKm: g.settings.freeRadiusKm
    });

    g.timer = setTimeout(() => endRound(gameId), g.settings.roundTimeSec * 1000);
  });

  // ---- HOST: starta slumpmässigt spel ----
  socket.on('startRandomGame', (payload = {}) => {
    // Använd gameId från payload eller från socket.data som fallback
    const gameId = payload.gameId || socket.data.gameId;
    if (!gameId) {
      socket.emit('round:error', { message: 'Inget gameId angivet' });
      return;
    }
    
    const g = gamesById.get(gameId);
    if (!g) {
      socket.emit('round:error', { message: 'Spelet hittades inte' });
      return;
    }
    
    if (socket.id !== g.host) {
      socket.emit('round:error', { message: 'Endast host kan starta slumpmässigt spel' });
      return;
    }
    
    // Välj slumpmässiga städer
    const selectedCities = selectRandomCities();
    
    if (selectedCities.length < 10) {
      console.warn(`Varning: Kunde endast välja ${selectedCities.length} av 10 städer`);
    }
    
    if (selectedCities.length === 0) {
      socket.emit('round:error', { message: 'Inga städer tillgängliga' });
      return;
    }
    
    // Spara städerna i spelet
    g.randomGameCities = selectedCities;
    
    // Skicka städerna till alla klienter i rummet
    io.to(room(gameId)).emit('random:cities', { cities: selectedCities });
    
    // Starta första rundan automatiskt med första staden
    const firstCity = selectedCities[0];
    if (g.timer) clearTimeout(g.timer);
    g.round += 1;
    const startedAt = Date.now();
    const deadlineAt = startedAt + g.settings.roundTimeSec * 1000;
    g.state = 'in_round';
    g.current = {
      cityName: firstCity.name,
      target: { lat: firstCity.lat, lng: firstCity.lng },
      startedAt,
      deadlineAt,
      guesses: new Map()
    };

    io.to(room(gameId)).emit('round:started', {
      round: g.round,
      cityName: g.current.cityName,
      deadlineAt,
      freeRadiusKm: g.settings.freeRadiusKm
    });

    g.timer = setTimeout(() => endRound(gameId), g.settings.roundTimeSec * 1000);
  });

  // ---- SPELARE: gissa ----
  socket.on('player:submitGuess', ({ gameId, lat, lng }) => {
    const g = gamesById.get(gameId);
    if (!g || g.state !== 'in_round') return;
    const pid = socket.data.playerId;
    if (!pid || !g.players.has(pid)) return;

    const rawKm = haversineKm({ lat, lng }, g.current.target);
    const adjKm = Math.max(0, rawKm - g.settings.freeRadiusKm); // frizon
    
    // Check if this is a new guess or an update
    const existingGuess = g.current.guesses.get(pid);
    const isFirstGuess = !existingGuess;
    
    // Store the guess with first guess position if it's an update
    g.current.guesses.set(pid, { 
      lat, 
      lng, 
      km: adjKm, 
      rawKm, 
      at: Date.now(),
      firstGuess: existingGuess ? existingGuess.firstGuess : { lat, lng, at: Date.now() }
    });
    
    socket.emit('guess:accepted', { 
      km: +adjKm.toFixed(1), 
      rawKm: +rawKm.toFixed(1), 
      freeKm: g.settings.freeRadiusKm,
      isUpdate: !isFirstGuess,
      firstGuess: existingGuess ? existingGuess.firstGuess : { lat, lng }
    });

    // Note: We no longer end the round early when all players have guessed,
    // since players can now update their guesses until time runs out
  });

  // ---- HOST: nästa runda ----
  socket.on('host:nextRound', ({ gameId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    g.state = 'lobby';
    g.current = null;
    io.to(room(gameId)).emit('lobby:ready');
  });

  // ---- HOST: avsluta ----
  socket.on('host:endGame', ({ gameId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    g.state = 'finished';
    const leaderboard = [...g.players.values()]
      .sort((a,b)=>a.totalKm-b.totalKm)
      .map(p => ({ id:p.id, name:p.name, totalKm: +p.totalKm.toFixed(1) }));
    io.to(room(gameId)).emit('game:final', { leaderboard });
  });

  // ---- HOST: starta om (nollställ poäng, behåll kod) ----
  socket.on('host:resetGame', ({ gameId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    g.state = 'lobby';
    g.round = 0;
    g.current = null;
    g.randomGameCities = null;
    for (const p of g.players.values()) p.totalKm = 0;
    io.to(room(gameId)).emit('game:reset', { players: [...g.players.values()].map(p => ({ id:p.id, name:p.name, totalKm:p.totalKm })) });
  });

  // ---- HOST: kicka spelare ----
  socket.on('host:kickPlayer', ({ gameId, playerId }) => {
    const g = gamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    const p = g.players.get(playerId);
    if (!p) return;
    // meddela och koppla ner spelaren
    io.to(p.socketId).emit('player:kicked');
    try { io.sockets.sockets.get(p.socketId)?.disconnect(true); } catch {}
    g.players.delete(playerId);
    // Om alla kvarvarande redan gissat -> stäng rundan
    if (g.state === 'in_round' && g.current && g.current.guesses.size >= g.players.size) {
      if (g.timer) clearTimeout(g.timer);
      endRound(gameId);
    } else {
      io.to(room(gameId)).emit('lobby:update', { players: [...g.players.values()].map(x => ({ id:x.id, name:x.name, totalKm:x.totalKm })) });
    }
  });

  // ---- HOST: återta spelet (inom grace) ----
  socket.on('host:reclaim', ({ gameId, hostToken }) => {
    const g = gamesById.get(gameId);
    if (!g || g.hostToken !== hostToken) { socket.emit('host:reclaim:failed'); return; }

    // Inom grace eller redan aktivt
    const now = Date.now();
    if (g.host && g.host !== socket.id) {
      // redan en host aktiv – avslå
      socket.emit('host:reclaim:failed'); return;
    }
    if (g.hostDisconnectedAt && (now - g.hostDisconnectedAt) > HOST_GRACE_MS) {
      // grace har gått ut -> spelet avslutas
      g.state = 'finished';
      const leaderboard = [...g.players.values()]
        .sort((a,b)=>a.totalKm-b.totalKm)
        .map(p => ({ id:p.id, name:p.name, totalKm: +p.totalKm.toFixed(1) }));
      io.to(room(gameId)).emit('game:final', { leaderboard });
      socket.emit('host:reclaim:failed'); return;
    }

    // Reclaim
    g.host = socket.id;
    g.hostDisconnectedAt = null;
    if (g.graceTimer) { clearTimeout(g.graceTimer); g.graceTimer = null; }
    socket.data.role = 'host';
    socket.data.gameId = gameId;
    socket.join(room(gameId));

    // Skicka aktuell status till host
    socket.emit('game:created', { gameId, code: g.code, ...g.settings, hostToken: g.hostToken });
    socket.emit('game:state', {
      state: g.state,
      round: g.round,
      players: [...g.players.values()].map(p => ({ id:p.id, name:p.name, totalKm:p.totalKm })),
      current: g.current ? { cityName: g.current.cityName, deadlineAt: g.current.deadlineAt } : null
    });
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const gid = socket.data.gameId;
    if (!gid) return;
    const g = gamesById.get(gid);
    if (!g) return;

    if (socket.data.role === 'player' && socket.data.playerId) {
      const pid = socket.data.playerId;
      const p = g.players.get(pid);
      if (p && p.socketId === socket.id) {
        g.players.delete(pid);
        io.to(room(gid)).emit('lobby:update', { players: [...g.players.values()].map(x => ({ id:x.id, name:x.name, totalKm:x.totalKm })) });
        // om alla kvarvarande gissat -> stäng runda
        if (g.state === 'in_round' && g.current && g.current.guesses.size >= g.players.size) {
          if (g.timer) clearTimeout(g.timer);
          endRound(gid);
        }
      }
    } else if (socket.id === g.host) {
      // Host tappad -> starta grace-timer
      g.host = null;
      g.hostDisconnectedAt = Date.now();
      if (g.graceTimer) clearTimeout(g.graceTimer);
      g.graceTimer = setTimeout(() => {
        if (g.host) return; // någon tog över
        g.state = 'finished';
        const leaderboard = [...g.players.values()]
          .sort((a,b)=>a.totalKm-b.totalKm)
          .map(p => ({ id:p.id, name:p.name, totalKm: +p.totalKm.toFixed(1) }));
        io.to(room(gid)).emit('game:final', { leaderboard });
      }, HOST_GRACE_MS);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server igång: http://localhost:${PORT}`));
