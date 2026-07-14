-- Admiral Undersea Database Schema
-- Applied automatically on server boot (see server/config/initDb.js).
-- Every statement is idempotent so it is safe to run on a fresh OR existing database.

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'player',
    central_user_id INTEGER,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Games table
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE NOT NULL,
    status VARCHAR(50) DEFAULT 'lobby',
    same_room BOOLEAN DEFAULT false,
    game_mode VARCHAR(50) DEFAULT 'turn-based',
    map_id INTEGER,
    team_alpha_name VARCHAR(100) DEFAULT 'Alpha',
    team_bravo_name VARCHAR(100) DEFAULT 'Bravo',
    created_by INTEGER REFERENCES users(id),
    winner_team VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    ended_at TIMESTAMP
);

-- Game players
CREATE TABLE IF NOT EXISTS game_players (
    id SERIAL PRIMARY KEY,
    game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    team VARCHAR(50) NOT NULL,
    role VARCHAR(50) NOT NULL,
    roles VARCHAR(255),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(game_id, user_id)
);

-- Idempotent column back-fills for databases created before these columns existed.
-- ADD COLUMN IF NOT EXISTS makes re-running harmless.
ALTER TABLE users ADD COLUMN IF NOT EXISTS central_user_id INTEGER;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS roles VARCHAR(255);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
-- UNIQUE index (not an inline column constraint) so uniqueness is enforced identically
-- on fresh and migrated databases. Multiple NULLs are allowed, so unlinked local users
-- are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_central ON users(central_user_id);
CREATE INDEX IF NOT EXISTS idx_games_code ON games(code);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
