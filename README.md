# Geo Live Server - Random Game Mode

## Overview
This server implements a geography quiz game with support for both manual city selection and automatic random game mode.

## Features

### Random Game Mode
The random game mode automatically selects cities for the game based on predefined rules, making it easy for hosts to start a game without manually selecting cities.

#### How It Works
1. The server loads city data from `cities.json` on startup
2. When a host triggers the random game mode, the server:
   - Filters cities with population > 500,000
   - Randomly selects 10 cities with the following distribution:
     - 4 cities from Europe
     - 4 cities from North America
     - 2 cities from rest of world (Asia, South America, Africa, Oceania)
3. The selected cities are sent to all clients in the game room

#### Socket.io Events

**New Event: `startRandomGame`**
- **Direction:** Client → Server
- **Payload:** `{ gameId: string }`
- **Description:** Triggers random city selection for the game
- **Permission:** Only the host can trigger this event

**New Event: `random:cities`**
- **Direction:** Server → Client(s)
- **Payload:** `{ cities: Array<City> }`
- **Description:** Broadcasts the randomly selected cities to all clients in the room
- **City Object:**
  ```javascript
  {
    name: string,        // City name
    country: string,     // Country name
    continent: string,   // Continent (Europe, North America, Asia, etc.)
    population: number,  // Population (always > 500,000)
    lat: number,         // Latitude
    lng: number          // Longitude
  }
  ```

## City Data

The `cities.json` file contains 56 cities from around the world:
- **15 European cities** (Stockholm, Berlin, Madrid, Paris, Rome, London, etc.)
- **14 North American cities** (New York, Los Angeles, Toronto, Mexico City, etc.)
- **27 cities from other continents** (Tokyo, Shanghai, São Paulo, Cairo, Sydney, etc.)

All cities have a population greater than 500,000 inhabitants.

## Usage Example

### Server-side
The random game mode is automatically available when the server starts:
```bash
npm start
```

The server will log:
```
Laddade 56 städer från cities.json
Server igång: http://localhost:3000
```

### Client-side Integration
To use the random game mode from the client:

```javascript
// Host creates a game
socket.emit('host:createGame', {});

// Listen for game creation
socket.on('game:created', (data) => {
  const { gameId } = data;
  
  // Trigger random game mode
  socket.emit('startRandomGame', { gameId });
});

// Receive the selected cities
socket.on('random:cities', (data) => {
  console.log('Selected cities:', data.cities);
  // data.cities is an array of 10 city objects
});
```

## Client Implementation (Separate Repository)
For the complete feature, the client should implement:
1. A "Starta Slumpmässigt Spel" (Start Random Game) button
2. This button should only be visible to the game host
3. Clicking the button sends the `startRandomGame` event
4. The client should handle the `random:cities` event to display the selected cities

## API Reference

### Existing Events
All existing socket.io events remain unchanged:
- `host:createGame` - Create a new game
- `host:startRound` - Start a round with a specific city
- `player:join` - Join a game
- `player:submitGuess` - Submit a guess
- etc.

For complete API documentation, see the source code comments in `server.js`.
