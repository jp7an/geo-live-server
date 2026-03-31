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
    
    // Determine first guess position (preserve existing or set new)
    const firstGuessTimestamp = Date.now();
    const firstGuessData = existingGuess 
      ? existingGuess.firstGuess 
      : { lat, lng, at: firstGuessTimestamp };
    
    // Store the guess with first guess position
    g.current.guesses.set(pid, { 
      lat, 
      lng, 
      km: adjKm, 
      rawKm, 
      at: firstGuessTimestamp,
      firstGuess: firstGuessData
    });
    
    socket.emit('guess:accepted', { 
      km: +adjKm.toFixed(1), 
      rawKm: +rawKm.toFixed(1), 
      freeKm: g.settings.freeRadiusKm,
      isUpdate: !isFirstGuess,
      firstGuess: firstGuessData
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

// ======================================================================
// ========================= LAGLÄGE (TEAM MODE) ========================
// ======================================================================

// ======= "Databas" för lagspel =======
/**
 * teamGame = {
 *   id, code, host (socketId|null), hostToken,
 *   state: 'lobby' | 'drawing' | 'showing_results' | 'finished',
 *   totalRounds: number,        // antal fulla omgångar (standard 12)
 *   currentRound: number,       // aktuell full omgång (1-baserad)
 *   currentTeamIndex: number,   // vilket lags tur det är (0-baserad)
 *   scoringMode: 'average' | 'best',
 *   teams: Array<{
 *     id: string,
 *     name: string,
 *     players: Array<{ id, name, socketId, totalKm }>,
 *     totalKm: number,
 *     drawerIndex: number
 *   }>,
 *   current: {
 *     cityName: string,
 *     target: { lat, lng },
 *     drawingTeamIndex: number,
 *     drawerPlayerId: string,
 *     guesses: Map<playerId, { lat, lng, km }>
 *   } | null
 * }
 */
const teamGamesById = new Map();
const teamGamesByCode = new Map();

// ======= Hjälp för lagspel =======
const teamRoom = id => `teamgame:${id}`;

// ======= Stadsval för lagläge (population > 100 000) =======
function selectTeamCities(count = 3) {
  const validCities = citiesData.filter(city => city.population > 100000);
  // Fisher-Yates shuffle för korrekt slumpmässigt urval
  const arr = [...validCities];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

// ======= Hjälp: formatera lobby-uppdatering =======
function formatTeamLobbyUpdate(g) {
  return {
    teams: g.teams.map(t => ({
      id: t.id,
      name: t.name,
      maxPlayers: t.players.length,
      players: t.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: !!(p.id && p.socketId)
      }))
    }))
  };
}

// ======= Avsluta delomgång =======
function endTeamSubRound(gameId) {
  const g = teamGamesById.get(gameId);
  if (!g || !g.current) return;

  const activeTeam = g.teams[g.current.drawingTeamIndex];
  const { target, guesses } = g.current;

  // Samla gissningar från lagets gissare (ej ritaren), hoppa över tomma platser
  const guessResults = [];
  for (const player of activeTeam.players) {
    if (!player.id) continue; // hoppa över tomma platser
    if (player.id === g.current.drawerPlayerId) continue; // hoppa över ritaren
    const guess = guesses.get(player.id);
    if (guess) {
      guessResults.push({
        playerName: player.name,
        km: +guess.km.toFixed(1),
        guess: { lat: guess.lat, lng: guess.lng }
      });
    }
  }

  // Lägg till spelare som INTE gissade (om scoring är average → maxstraff)
  for (const player of activeTeam.players) {
    if (!player.id) continue; // hoppa över tomma platser
    if (player.id === g.current.drawerPlayerId) continue;
    if (!guesses.has(player.id)) {
      guessResults.push({
        playerName: player.name,
        km: DEFAULT_PENALTY_KM,
        guess: null
      });
    }
  }

  // Räkna ut lagets poäng
  let teamScore;
  if (guessResults.length === 0) {
    teamScore = DEFAULT_PENALTY_KM; // ingen gissade → maxstraff
  } else if (g.scoringMode === 'best') {
    teamScore = Math.min(...guessResults.map(r => r.km));
  } else {
    // 'average'
    teamScore = guessResults.reduce((sum, r) => sum + r.km, 0) / guessResults.length;
  }
  teamScore = +teamScore.toFixed(1);

  // Lägg till lagets poäng
  activeTeam.totalKm += teamScore;

  g.state = 'showing_results';

  io.to(teamRoom(gameId)).emit('team:subRoundResults', {
    teamName: activeTeam.name,
    guesses: guessResults,
    teamScore,
    target: { lat: target.lat, lng: target.lng, name: g.current.cityName },
    teams: g.teams.map(t => ({ name: t.name, totalKm: +t.totalKm.toFixed(1) }))
  });
}

// ======= Socket.io – lagspel =======
io.on('connection', (socket) => {

  // ---- HOST: skapa lagspel ----
  socket.on('host:createTeamGame', (payload = {}) => {
    const { totalRounds = 12, scoringMode = 'average', numTeams, teamNames, playersPerTeam } = payload;

    // Validera numTeams
    const parsedNumTeams = parseInt(numTeams, 10);
    if (!parsedNumTeams || parsedNumTeams < 2 || parsedNumTeams > 5) {
      socket.emit('teamGame:error', { message: 'Antal lag måste vara mellan 2 och 5.' });
      return;
    }

    // Validera teamNames
    if (!Array.isArray(teamNames) || teamNames.length !== parsedNumTeams) {
      socket.emit('teamGame:error', { message: 'teamNames måste vara en array med längd lika med numTeams.' });
      return;
    }
    for (const n of teamNames) {
      if (!n?.trim()) {
        socket.emit('teamGame:error', { message: 'Varje lag måste ha ett namn.' });
        return;
      }
    }

    // Validera playersPerTeam
    const parsedPPT = parseInt(playersPerTeam, 10);
    if (parsedPPT !== 2 && parsedPPT !== 3) {
      socket.emit('teamGame:error', { message: 'Spelare per lag måste vara 2 eller 3.' });
      return;
    }

    const gameId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let code;
    do { code = makeCode(); } while (teamGamesByCode.has(code));
    const hostToken = makeHostToken();

    // Skapa lag med förallokerade tomma platser
    const teams = teamNames.map((n, ti) => ({
      id: `team-${ti}`,
      name: n.trim(),
      players: Array.from({ length: parsedPPT }, (_, pi) => ({
        id: null,
        name: null,
        socketId: null,
        totalKm: 0
      })),
      totalKm: 0,
      drawerIndex: 0
    }));

    const game = {
      id: gameId,
      code,
      host: socket.id,
      hostToken,
      state: 'lobby',
      totalRounds: Math.max(1, parseInt(totalRounds, 10) || 12),
      currentRound: 0,
      currentTeamIndex: 0,
      scoringMode: scoringMode === 'best' ? 'best' : 'average',
      teams,
      current: null
    };

    teamGamesById.set(gameId, game);
    teamGamesByCode.set(code, gameId);

    socket.data.teamGameId = gameId;
    socket.join(teamRoom(gameId));

    socket.emit('teamGame:created', {
      gameId,
      code,
      hostToken,
      teams: teams.map(t => ({ id: t.id, name: t.name, maxPlayers: t.players.length })),
      totalRounds: game.totalRounds,
      scoringMode: game.scoringMode
    });

    io.to(teamRoom(gameId)).emit('teamLobby:update', formatTeamLobbyUpdate(game));
  });

  // ---- SPELARE: gå med i lagspel via lobbyval (slot-baserad anslutning) ----
  function handleJoinTeamLobby({ code, name, teamId }) {
    const gameId = teamGamesByCode.get(code);
    const g = teamGamesById.get(gameId);

    if (!g || g.state === 'finished') {
      socket.emit('join:error', { message: 'Ingen aktiv lagmatch med den koden.' });
      return;
    }
    if (g.state !== 'lobby') {
      socket.emit('join:error', { message: 'Spelet har redan startat.' });
      return;
    }

    // Om inget teamId angivet → spelare letar upp lobbyn utan att välja lag
    // Gå med i socket-rummet och skicka tillbaka aktuell lobby-status
    if (!teamId) {
      socket.join(teamRoom(gameId));
      socket.emit('teamLobby:update', formatTeamLobbyUpdate(g));
      return;
    }

    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      socket.emit('join:error', { message: 'Ange ett namn.' });
      return;
    }

    // Hitta laget
    const team = g.teams.find(t => t.id === teamId);
    if (!team) {
      socket.emit('join:error', { message: 'Laget hittades inte.' });
      return;
    }

    // Stöd återanslutning: om samma namn redan finns i laget → byt ut socketId
    const existingPlayer = team.players.find(
      p => p.name && p.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      socket.data.teamGameId = gameId;
      socket.data.teamPlayerId = existingPlayer.id;
      socket.data.teamTeamId = team.id;
      socket.join(teamRoom(gameId));

      socket.emit('player:teamJoined', {
        gameId,
        playerId: existingPlayer.id,
        teamId: team.id,
        teamName: team.name
      });

      io.to(teamRoom(gameId)).emit('teamLobby:update', formatTeamLobbyUpdate(g));
      return;
    }

    // Hitta första tomma plats (id === null)
    const slot = team.players.find(p => p.id === null);
    if (!slot) {
      socket.emit('join:error', { message: 'Laget är fullt.' });
      return;
    }

    const playerId = `tp-${team.id}-${Math.random().toString(36).slice(2, 8)}`;
    slot.id = playerId;
    slot.name = trimmedName;
    slot.socketId = socket.id;
    slot.totalKm = 0;

    socket.data.teamGameId = gameId;
    socket.data.teamPlayerId = playerId;
    socket.data.teamTeamId = team.id;
    socket.join(teamRoom(gameId));

    socket.emit('player:teamJoined', {
      gameId,
      playerId,
      teamId: team.id,
      teamName: team.name
    });

    io.to(teamRoom(gameId)).emit('teamLobby:update', formatTeamLobbyUpdate(g));
  }

  socket.on('player:joinTeamLobby', handleJoinTeamLobby);
  socket.on('player:joinTeam', handleJoinTeamLobby);
  socket.on('player:joinTeamByTeamId', handleJoinTeamLobby);

  // ---- HOST: starta lagspel ----
  socket.on('host:startTeamGame', ({ gameId }) => {
    const g = teamGamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.state !== 'lobby') return;

    // Kräv att varje lag har minst 2 anslutna spelare (fyllda platser med aktiv socket)
    const underStaffed = g.teams.some(t =>
      t.players.filter(p => p.id !== null && p.socketId !== null).length < 2
    );
    if (underStaffed) {
      socket.emit('teamGame:error', { message: 'Alla lag måste ha minst 2 anslutna spelare.' });
      return;
    }

    // Starta första delomgången
    _startNextTeamSubRound(g, gameId);
  });

  // ---- Ritaren väljer stad ----
  socket.on('team:chooseCity', ({ gameId, cityIndex }) => {
    const g = teamGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;
    if (!g.current) return;

    const pid = socket.data.teamPlayerId;
    if (pid !== g.current.drawerPlayerId) return; // bara ritaren

    if (!g.current.cityChoices || cityIndex < 0 || cityIndex >= g.current.cityChoices.length) return;

    const chosen = g.current.cityChoices[cityIndex];
    g.current.cityName = chosen.name;
    g.current.target = { lat: chosen.lat, lng: chosen.lng };
    g.current.cityChoices = null; // rensa valen

    // Bekräfta till ritaren
    socket.emit('team:cityChosen', { cityName: chosen.name });

    // Meddela alla UTOM ritaren att ritandet börjar (utan att avslöja stadens namn)
    const activeTeam = g.teams[g.current.drawingTeamIndex];
    const drawer = activeTeam.players.find(p => p.id === g.current.drawerPlayerId);
    socket.to(teamRoom(gameId)).emit('team:drawingStarted', {
      drawerName: drawer ? drawer.name : 'Okänd',
      teamName: activeTeam.name
    });
  });

  // ---- Rita i realtid ----
  socket.on('team:draw', ({ gameId, x, y, drawing, color, lineWidth }) => {
    const g = teamGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;
    if (!g.current) return;

    const pid = socket.data.teamPlayerId;
    if (pid !== g.current.drawerPlayerId) return; // bara ritaren

    socket.to(teamRoom(gameId)).emit('team:draw', {
      x, y, drawing, color, lineWidth,
      drawerId: pid
    });
  });

  // ---- Rensa ritningen ----
  socket.on('team:clearCanvas', ({ gameId }) => {
    const g = teamGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;
    if (!g.current) return;

    const pid = socket.data.teamPlayerId;
    if (pid !== g.current.drawerPlayerId) return; // bara ritaren

    io.to(teamRoom(gameId)).emit('team:clearCanvas', {});
  });

  // ---- Gissare placerar nål ----
  socket.on('team:submitGuess', ({ gameId, lat, lng }) => {
    const g = teamGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;
    if (!g.current) return;

    const pid = socket.data.teamPlayerId;
    if (!pid) return;

    // Kontrollera att spelaren är i det aktiva laget
    const activeTeam = g.teams[g.current.drawingTeamIndex];
    const isInActiveTeam = activeTeam.players.some(p => p.id === pid);
    if (!isInActiveTeam) return; // motståndarlaget kan inte gissa

    // Ritaren kan inte gissa
    if (pid === g.current.drawerPlayerId) return;

    // Kräv att stad är vald
    if (!g.current.target) return;

    const km = haversineKm({ lat, lng }, g.current.target);
    g.current.guesses.set(pid, { lat, lng, km: +km.toFixed(1) });

    socket.emit('team:guessAccepted', { km: +km.toFixed(1) });

    // Broadcast pin to all other players so spectators see locked-in guesses in real-time
    const guessingPlayer = activeTeam.players.find(p => p.id === pid);
    socket.to(teamRoom(gameId)).emit('team:guessPinUpdate', {
      playerName: guessingPlayer ? guessingPlayer.name : 'Okänd',
      teamName: activeTeam.name,
      lat,
      lng
    });

    // Kontrollera om alla gissare i aktiva laget har gissat (hoppa över tomma platser)
    const guessers = activeTeam.players.filter(p => p.id !== null && p.id !== g.current.drawerPlayerId);
    const allGuessed = guessers.every(p => g.current.guesses.has(p.id));
    if (allGuessed) {
      endTeamSubRound(gameId);
    }
  });

  // ---- HOST: nästa delomgång ----
  socket.on('host:nextTeamSubRound', ({ gameId }) => {
    const g = teamGamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    if (g.state !== 'showing_results') return;

    // Gå till nästa lag
    g.currentTeamIndex++;

    // Om alla lag har haft sin tur i denna omgång → ny full omgång
    if (g.currentTeamIndex >= g.teams.length) {
      g.currentTeamIndex = 0;
      g.currentRound++;
      // Rotera ritarens index för varje lag (baserat på fyllda platser)
      for (const team of g.teams) {
        const filledCount = team.players.filter(p => p.id !== null).length;
        team.drawerIndex = (team.drawerIndex + 1) % Math.max(1, filledCount);
      }
    }

    // Kontrollera om spelet är slut
    if (g.currentRound > g.totalRounds) {
      _endTeamGame(g, gameId);
      return;
    }

    _startNextTeamSubRound(g, gameId);
  });

  // ---- HOST: avsluta lagspelet ----
  socket.on('host:endTeamGame', ({ gameId }) => {
    const g = teamGamesById.get(gameId);
    if (!g || socket.id !== g.host) return;
    _endTeamGame(g, gameId);
  });

  // ---- DISCONNECT (lagläge) ----
  socket.on('disconnect', () => {
    const tgid = socket.data.teamGameId;
    if (!tgid) return;
    const g = teamGamesById.get(tgid);
    if (!g) return;

    const pid = socket.data.teamPlayerId;
    if (pid) {
      // Rensa spelarens socketId vid frånkoppling (de kan återansluta)
      for (const team of g.teams) {
        const player = team.players.find(p => p.id === pid);
        if (player && player.socketId === socket.id) {
          player.socketId = null;
          io.to(teamRoom(tgid)).emit('teamLobby:update', formatTeamLobbyUpdate(g));
          break;
        }
      }

      // Om ritaren kopplade ifrån under drawing → meddela host och avsluta delomgången
      if (g.state === 'drawing' && g.current && pid === g.current.drawerPlayerId) {
        const hostSocket = g.host ? io.sockets.sockets.get(g.host) : null;
        if (hostSocket) {
          hostSocket.emit('team:drawerDisconnected', { drawerPlayerId: pid });
        }
        endTeamSubRound(tgid);
      }
      // Om en gissare kopplade ifrån → kontrollera om alla kvarvarande har gissat
      else if (g.state === 'drawing' && g.current) {
        const activeTeam = g.teams[g.current.drawingTeamIndex];
        const connectedGuessers = activeTeam.players.filter(
          p => p.id !== null && p.id !== g.current.drawerPlayerId && p.socketId
        );
        if (connectedGuessers.length > 0 &&
            connectedGuessers.every(p => g.current.guesses.has(p.id))) {
          endTeamSubRound(tgid);
        }
      }
    }
  });

});

// ======= Intern: starta nästa delomgång =======
function _startNextTeamSubRound(g, gameId) {
  const team = g.teams[g.currentTeamIndex];

  // Välj bara fyllda platser för ritar-rotation
  const filledPlayers = team.players.filter(p => p.id !== null);
  if (filledPlayers.length === 0) {
    // Säkerhetskontroll: ska inte hända om start-valideringen kördes
    io.to(teamRoom(gameId)).emit('teamGame:error', { message: `Lag "${team.name}" har inga spelare.` });
    return;
  }
  const drawer = filledPlayers[team.drawerIndex % filledPlayers.length];

  // Om currentRound är 0 (första start), sätt till 1
  if (g.currentRound === 0) g.currentRound = 1;

  // Välj 3 slumpmässiga städer privat till ritaren
  const cityChoices = selectTeamCities(3);

  g.state = 'drawing';
  g.current = {
    cityName: null,
    target: null,
    drawingTeamIndex: g.currentTeamIndex,
    drawerPlayerId: drawer.id,
    guesses: new Map(),
    cityChoices
  };

  // Skicka stadsvalen privat till ritaren
  const drawerSocket = drawer.socketId ? io.sockets.sockets.get(drawer.socketId) : null;
  if (drawerSocket) {
    drawerSocket.emit('team:cityChoices', {
      cities: cityChoices.map(c => ({ name: c.name, lat: c.lat, lng: c.lng }))
    });
  } else {
    console.warn(`[team] Drawer ${drawer.id} (name: ${drawer.name}) has no active socket. socketId=${drawer.socketId}`);
    const hostSocket = g.host ? io.sockets.sockets.get(g.host) : null;
    if (hostSocket) {
      hostSocket.emit('teamGame:error', {
        message: `Ritaren (${drawer.name}) är inte ansluten. Vänta tills de anslutit om igen.`
      });
    }
  }

  // Meddela alla om ny delomgång
  io.to(teamRoom(gameId)).emit('team:roundStarted', {
    round: g.currentRound,
    totalRounds: g.totalRounds,
    drawingTeamName: team.name,
    drawerName: drawer.name,
    drawerId: drawer.id,
    teamId: team.id,
    teamIndex: g.currentTeamIndex
  });
}

// ======= Intern: avsluta spelet =======
function _endTeamGame(g, gameId) {
  g.state = 'finished';
  const leaderboard = [...g.teams]
    .sort((a, b) => a.totalKm - b.totalKm)
    .map((t, i) => ({ teamName: t.name, totalKm: +t.totalKm.toFixed(1), rank: i + 1 }));

  io.to(teamRoom(gameId)).emit('teamGame:final', { leaderboard });
}

// ======================================================================
// =================== KLASSISKT LÄGE (CLASSIC MODE) ====================
// ======================================================================

// ======= Läs ord från words.json =======
let classicWordsData = [];
try {
  const wordsPath = path.join(__dirname, 'words.json');
  const rawWords = fs.readFileSync(wordsPath, 'utf8');
  classicWordsData = JSON.parse(rawWords);
  console.log(`Laddade ${classicWordsData.length} ord från words.json`);
} catch (error) {
  console.error('Kunde inte läsa words.json:', error.message);
}

// ======= "Databas" för klassiskt läge =======
/**
 * classicGame = {
 *   id, code,
 *   host: socketId,
 *   state: 'lobby' | 'picking' | 'drawing' | 'round_end' | 'finished',
 *   totalRoundsPerPlayer: number,
 *   drawTimeSec: number,
 *   players: Map<playerId, { id, name, socketId, score }>,
 *   playerOrder: [playerId, ...],
 *   drawerIndex: number,
 *   roundNumber: number,
 *   totalRounds: number,
 *   current: {
 *     wordOptions: string[],
 *     word: string | null,
 *     drawerPlayerId: string,
 *     correctGuessers: string[],
 *     wrongGuesses: Map<playerId, Array<{id, text}>>,
 *     roundScores: Map<playerId, number>,
 *   } | null,
 *   timer: NodeJS.Timeout | null
 * }
 */
const classicGamesById = new Map();
const classicGamesByCode = new Map();

const classicRoom = id => `classicgame:${id}`;

function selectClassicWords(count = 5) {
  if (!classicWordsData.length) return [];
  const arr = [...classicWordsData];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

function endClassicRound(gameId) {
  const g = classicGamesById.get(gameId);
  if (!g || !g.current) return;

  if (g.timer) { clearTimeout(g.timer); g.timer = null; }

  const { word, roundScores } = g.current;

  // Build per-player round scores
  const roundScoreList = [...g.players.values()].map(p => ({
    playerId: p.id,
    name: p.name,
    roundPoints: roundScores.get(p.id) || 0,
    totalPoints: p.score
  }));

  // Determine next drawer
  const nextDrawerIndex = (g.drawerIndex + 1) % g.playerOrder.length;
  const nextDrawerPlayerId = g.playerOrder[nextDrawerIndex];
  const nextDrawerPlayer = g.players.get(nextDrawerPlayerId);

  g.state = 'round_end';

  io.to(classicRoom(gameId)).emit('classic:roundEnd', {
    word,
    roundScores: roundScoreList,
    nextDrawerId: nextDrawerPlayerId,
    nextDrawerName: nextDrawerPlayer ? nextDrawerPlayer.name : null,
    roundNumber: g.roundNumber,
    totalRounds: g.totalRounds
  });
}

function _startClassicRound(g, gameId) {
  g.roundNumber += 1;

  if (g.roundNumber > g.totalRounds) {
    g.state = 'finished';
    const finalScores = [...g.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ playerId: p.id, name: p.name, totalPoints: p.score, rank: i + 1 }));
    io.to(classicRoom(gameId)).emit('classic:gameEnd', { finalScores });
    return;
  }

  g.state = 'picking';
  const drawerPlayerId = g.playerOrder[g.drawerIndex];
  const drawer = g.players.get(drawerPlayerId);
  const wordOptions = selectClassicWords(3);

  g.current = {
    wordOptions,
    word: null,
    drawerPlayerId,
    correctGuessers: [],
    wrongGuesses: new Map(),
    roundScores: new Map(),
    drawerAwarded: false
  };

  // Send full round-start (with wordOptions) privately to the drawer
  const drawerSocket = drawer && drawer.socketId ? io.sockets.sockets.get(drawer.socketId) : null;
  if (drawerSocket) {
    drawerSocket.emit('classicRound:start', {
      roundNumber: g.roundNumber,
      totalRounds: g.totalRounds,
      drawerId: drawerPlayerId,
      drawerName: drawer.name,
      wordOptions,
      drawTimeSec: g.drawTimeSec
    });
  }

  // Send round-start without wordOptions to all other players
  drawerSocket
    ? drawerSocket.to(classicRoom(gameId)).emit('classicRound:start', {
        roundNumber: g.roundNumber,
        totalRounds: g.totalRounds,
        drawerId: drawerPlayerId,
        drawerName: drawer ? drawer.name : null,
        drawTimeSec: g.drawTimeSec
      })
    : io.to(classicRoom(gameId)).emit('classicRound:start', {
        roundNumber: g.roundNumber,
        totalRounds: g.totalRounds,
        drawerId: drawerPlayerId,
        drawerName: drawer ? drawer.name : null,
        drawTimeSec: g.drawTimeSec
      });
}

// ======= Socket.io – klassiskt läge =======
io.on('connection', (socket) => {

  // ---- HOST: skapa klassiskt spel ----
  socket.on('host:createClassicGame', ({ totalRoundsPerPlayer, hostName, drawTimeSec } = {}) => {
    const parsedRounds = Math.max(1, Math.min(10, parseInt(totalRoundsPerPlayer, 10) || 4));
    const clampedDrawTimeSec = Math.max(20, Math.min(180, parseInt(drawTimeSec, 10) || 60)); // 20–180 s, default 60

    const gameId = `c-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let code;
    do { code = makeCode(); } while (classicGamesByCode.has(code) || gamesByCode.has(code) || teamGamesByCode.has(code));

    const game = {
      id: gameId,
      code,
      host: socket.id,
      state: 'lobby',
      totalRoundsPerPlayer: parsedRounds,
      drawTimeSec: clampedDrawTimeSec,
      players: new Map(),
      playerOrder: [],
      drawerIndex: 0,
      roundNumber: 0,
      totalRounds: 0,
      current: null,
      timer: null
    };

    classicGamesById.set(gameId, game);
    classicGamesByCode.set(code, gameId);

    socket.data.classicGameId = gameId;
    socket.join(classicRoom(gameId));

    // Register host as a player in the game
    let hostPlayerId;
    const trimmedHostName = (hostName || '').toString().trim().slice(0, 30);
    if (trimmedHostName) {
      hostPlayerId = `cp-${Math.random().toString(36).slice(2, 8)}`;
      const hostPlayer = { id: hostPlayerId, name: trimmedHostName, socketId: socket.id, score: 0 };
      game.players.set(hostPlayerId, hostPlayer);
      socket.data.classicPlayerId = hostPlayerId;
    }

    socket.emit('classicGame:created', {
      gameId,
      code,
      drawTimeSec: clampedDrawTimeSec,
      totalRoundsPerPlayer: parsedRounds,
      playerId: hostPlayerId
    });

    if (hostPlayerId) {
      io.to(classicRoom(gameId)).emit('classicLobby:update', {
        players: [...game.players.values()].map(p => ({ id: p.id, name: p.name })),
        hostSocketId: game.host
      });
    }
  });

  // ---- SPELARE: gå med i klassiskt spel ----
  socket.on('player:joinClassicGame', ({ code, name } = {}) => {
    const gameId = classicGamesByCode.get(String(code || '').trim());
    const g = classicGamesById.get(gameId);

    if (!g || g.state !== 'lobby') {
      socket.emit('classicGame:error', { message: 'Inget aktivt spel med den koden.' });
      return;
    }

    const trimmedName = (name || '').toString().trim().slice(0, 30);
    if (!trimmedName) {
      socket.emit('classicGame:error', { message: 'Ogiltigt namn.' });
      return;
    }

    const playerId = `cp-${Math.random().toString(36).slice(2, 8)}`;
    const player = { id: playerId, name: trimmedName, socketId: socket.id, score: 0 };

    g.players.set(playerId, player);
    socket.data.classicGameId = gameId;
    socket.data.classicPlayerId = playerId;
    socket.join(classicRoom(gameId));

    socket.emit('classicGame:joined', { playerId, gameId, code: g.code });

    io.to(classicRoom(gameId)).emit('classicLobby:update', {
      players: [...g.players.values()].map(p => ({ id: p.id, name: p.name })),
      hostSocketId: g.host
    });
  });

  // ---- HOST: stäng lobby och starta spel ----
  socket.on('host:startClassicGame', ({ gameId } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || socket.id !== g.host || g.state !== 'lobby') return;

    if (g.players.size < 2) {
      socket.emit('classicGame:error', { message: 'Minst 2 spelare krävs för att starta.' });
      return;
    }

    // Fix player rotation order and total rounds
    g.playerOrder = [...g.players.keys()];
    g.totalRounds = g.playerOrder.length * g.totalRoundsPerPlayer;
    g.drawerIndex = 0;
    g.roundNumber = 0;

    _startClassicRound(g, gameId);
  });

  // ---- Ritaren väljer ord ----
  socket.on('classic:pickWord', ({ gameId, word } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || g.state !== 'picking') return;

    const pid = socket.data.classicPlayerId;
    if (!g.current || pid !== g.current.drawerPlayerId) return;
    if (!g.current.wordOptions.includes(word)) return;

    g.current.word = word;
    g.state = 'drawing';

    io.to(classicRoom(gameId)).emit('classic:drawingStarted', {
      drawerId: g.current.drawerPlayerId
    });

    // Start the round timer using drawTimeSec
    g.timer = setTimeout(() => endClassicRound(gameId), g.drawTimeSec * 1000);
  });

  // ---- Relay ritning till alla andra ----
  socket.on('classic:draw', ({ gameId, ...drawData } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;

    const pid = socket.data.classicPlayerId;
    if (!g.current || pid !== g.current.drawerPlayerId) return;

    socket.to(classicRoom(gameId)).emit('classic:draw', drawData);
  });

  // ---- Gissare skickar gissning ----
  socket.on('classic:guess', ({ gameId, guess } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;

    const pid = socket.data.classicPlayerId;
    if (!pid || !g.players.has(pid)) return;
    if (!g.current || pid === g.current.drawerPlayerId) return;
    if (g.current.correctGuessers.includes(pid)) return;

    const guessText = (guess || '').toString().trim();
    if (!guessText) return;

    const isCorrect = guessText.toLowerCase() === g.current.word.toLowerCase();

    if (isCorrect) {
      const wrongCount = g.current.wrongGuesses.has(pid) ? g.current.wrongGuesses.get(pid).length : 0;
      const pointsEarned = Math.max(1, 6 - wrongCount);
      g.current.correctGuessers.push(pid);
      g.current.roundScores.set(pid, (g.current.roundScores.get(pid) || 0) + pointsEarned);
      g.players.get(pid).score += pointsEarned;

      // Drawer gets 11 points, but only once (from the first correct guesser)
      if (!g.current.drawerAwarded) {
        const drawer = g.players.get(g.current.drawerPlayerId);
        if (drawer) {
          drawer.score += 11;
          g.current.roundScores.set(
            g.current.drawerPlayerId,
            (g.current.roundScores.get(g.current.drawerPlayerId) || 0) + 11
          );
          g.current.drawerAwarded = true;
        }
      }

      io.to(classicRoom(gameId)).emit('classic:guessResult', {
        playerId: pid,
        playerName: g.players.get(pid).name,
        guess: guessText,
        correct: true,
        points: pointsEarned
      });

      endClassicRound(gameId);
    } else {
      if (!g.current.wrongGuesses.has(pid)) g.current.wrongGuesses.set(pid, []);
      const wrongList = g.current.wrongGuesses.get(pid);
      const guessId = `${pid}-${wrongList.length}`;
      wrongList.push({ id: guessId, text: guessText });

      io.to(classicRoom(gameId)).emit('classic:guessResult', {
        playerId: pid,
        playerName: g.players.get(pid).name,
        guess: guessText,
        guessId,
        correct: false,
        points: 0
      });
    }
  });

  // ---- Ritaren ger rätt för en gissning ----
  socket.on('classic:grantCorrect', ({ gameId, targetPlayerId } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || g.state !== 'drawing') return;

    const pid = socket.data.classicPlayerId;
    if (!g.current || pid !== g.current.drawerPlayerId) return;
    if (g.current.correctGuessers.includes(targetPlayerId)) return;
    if (!g.players.has(targetPlayerId)) return;

    const wrongCount = g.current.wrongGuesses.has(targetPlayerId) ? g.current.wrongGuesses.get(targetPlayerId).length : 0;
    const pointsEarned = Math.max(1, 6 - wrongCount);
    g.current.correctGuessers.push(targetPlayerId);
    g.current.roundScores.set(
      targetPlayerId,
      (g.current.roundScores.get(targetPlayerId) || 0) + pointsEarned
    );
    g.players.get(targetPlayerId).score += pointsEarned;

    // Drawer gets 11 points, but only once (from the first correct guesser)
    if (!g.current.drawerAwarded) {
      const drawer = g.players.get(g.current.drawerPlayerId);
      if (drawer) {
        drawer.score += 11;
        g.current.roundScores.set(
          g.current.drawerPlayerId,
          (g.current.roundScores.get(g.current.drawerPlayerId) || 0) + 11
        );
        g.current.drawerAwarded = true;
      }
    }

    io.to(classicRoom(gameId)).emit('classic:guessResult', {
      playerId: targetPlayerId,
      playerName: g.players.get(targetPlayerId).name,
      guess: null,
      correct: true,
      granted: true,
      points: pointsEarned
    });

    endClassicRound(gameId);
  });

  // ---- Nästa ritare startar nästa omgång ----
  socket.on('host:nextClassicRound', ({ gameId } = {}) => {
    const g = classicGamesById.get(gameId);
    if (!g || g.state !== 'round_end') return;

    // Only the next drawer can start the next round
    const nextDrawerIndex = (g.drawerIndex + 1) % g.playerOrder.length;
    const nextDrawerPlayerId = g.playerOrder[nextDrawerIndex];

    const pid = socket.data.classicPlayerId;
    if (pid !== nextDrawerPlayerId) return;

    g.drawerIndex = nextDrawerIndex;
    _startClassicRound(g, gameId);
  });
});

// ======================================================================
// ========================= SERVER START ===============================
// ======================================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server igång: http://localhost:${PORT}`));
