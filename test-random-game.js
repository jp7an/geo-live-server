// Test script to verify random game functionality
const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
  transports: ['websocket', 'polling']
});

let gameId = null;
let hostToken = null;

socket.on('connect', () => {
  console.log('Connected to server');
  
  // Create a game as host
  console.log('Creating game...');
  socket.emit('host:createGame', {});
});

socket.on('game:created', (data) => {
  console.log('Game created:', data);
  gameId = data.gameId;
  hostToken = data.hostToken;
  
  // Try to start random game
  console.log('Starting random game with gameId:', gameId);
  socket.emit('startRandomGame', { gameId });
});

socket.on('random:cities', (data) => {
  console.log('✓ SUCCESS: Received random cities!');
  console.log('Number of cities:', data.cities?.length);
  console.log('Cities:', data.cities);
  process.exit(0);
});

socket.on('round:error', (data) => {
  console.error('× ERROR: Round error:', data);
  process.exit(1);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err);
  process.exit(1);
});

// Timeout after 5 seconds
setTimeout(() => {
  console.error('× TIMEOUT: No random:cities event received within 5 seconds');
  process.exit(1);
}, 5000);
