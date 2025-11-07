// Test client to verify the complete flow
const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
  transports: ['websocket']
});

let receivedCities = false;
let roundStarted = false;

socket.on('connect', () => {
  console.log('✓ Connected to server');
  socket.emit('host:createGame', {});
});

socket.on('game:created', (data) => {
  console.log('✓ Game created:', data);
  const { gameId } = data;
  
  console.log('\n→ Emitting startRandomGame event...');
  socket.emit('startRandomGame', { gameId });
  
  // Wait to see what happens
  setTimeout(() => {
    console.log('\n--- RESULTS ---');
    console.log('Received random:cities:', receivedCities);
    console.log('Round started automatically:', roundStarted);
    
    if (receivedCities && !roundStarted) {
      console.log('\n❌ ISSUE: Cities were selected but round did not start automatically!');
      console.log('This is likely the bug - user clicks "Start Random Game" but nothing happens');
      console.log('because the client needs to manually start rounds.');
    }
    process.exit(receivedCities && !roundStarted ? 1 : 0);
  }, 3000);
});

socket.on('random:cities', (data) => {
  console.log('\n✓ Received random:cities event with', data.cities.length, 'cities');
  receivedCities = true;
});

socket.on('round:started', (data) => {
  console.log('\n✓ Round started automatically!', data);
  roundStarted = true;
});

socket.on('round:error', (data) => {
  console.error('✗ Error:', data.message);
  process.exit(1);
});
