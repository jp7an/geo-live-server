// Test client to verify the startRandomGame event
const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
  transports: ['websocket']
});

socket.on('connect', () => {
  console.log('✓ Connected to server');
  
  // Create a game as host
  socket.emit('host:createGame', {});
});

socket.on('game:created', (data) => {
  console.log('✓ Game created:', data);
  const { gameId } = data;
  
  // Try to start random game
  console.log('\n→ Emitting startRandomGame event...');
  socket.emit('startRandomGame', { gameId });
  
  // Wait a bit to see if we get a response
  setTimeout(() => {
    console.log('\n❌ Timeout: No random:cities event received after 3 seconds');
    process.exit(1);
  }, 3000);
});

socket.on('random:cities', (data) => {
  console.log('\n✓ Received random:cities event!');
  console.log('Selected cities:', data.cities.length);
  if (data.cities.length > 0) {
    console.log('First city:', data.cities[0]);
  }
  process.exit(0);
});

socket.on('round:error', (data) => {
  console.error('✗ Error:', data.message);
  process.exit(1);
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error);
  process.exit(1);
});
