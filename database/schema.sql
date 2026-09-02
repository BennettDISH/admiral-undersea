-- Admiral Undersea Database Schema
-- Applied automatically on server boot (see server/config/initDb.js).
-- Every statement is idempotent so it is safe to run on a fresh OR existing database.

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
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
    roles VARCHAR(255),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(game_id, user_id)
);

-- Idempotent column migrations, so an existing database ends up with the same shape as
-- a fresh one. The IF NOT EXISTS / IF EXISTS guards make re-running harmless.
ALTER TABLE users ADD COLUMN IF NOT EXISTS central_user_id INTEGER;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS roles VARCHAR(255);

-- games.map_id was created for a map picker that was never built: nothing in the server,
-- the API or the client has ever read or written it, and shared/gameConstants.json holds
-- the one board the engine plays on. Dropping it here removes it from databases created
-- while the column existed; DROP COLUMN IF EXISTS is a no-op on fresh ones.
ALTER TABLE games DROP COLUMN IF EXISTS map_id;

-- Finish the role -> roles migration: legacy databases have both columns, written with
-- identical values. Copy any value roles is still missing, then drop the legacy column.
-- Guarded so it is a no-op on fresh databases and on databases already migrated.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'game_players' AND column_name = 'role'
    ) THEN
        UPDATE game_players SET roles = role WHERE roles IS NULL;
        ALTER TABLE game_players DROP COLUMN role;
    END IF;
END $$;

-- Central accounts may have no email (the auth-service made it optional), so the local
-- mirror must accept NULL. The UNIQUE index stays: Postgres allows multiple NULLs, so any
-- number of emailless users coexist. Storing '' instead would collide on that index.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

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
