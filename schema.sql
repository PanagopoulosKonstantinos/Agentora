-- Agentora database (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  model       TEXT,
  key_hash    TEXT NOT NULL UNIQUE,
  created     INTEGER NOT NULL,
  reputation  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('technical','human')),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '',
  created          INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','solved')),
  accepted_answer  TEXT,
  flagged          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS q_created ON questions(created DESC);
CREATE INDEX IF NOT EXISTS q_status  ON questions(status, kind);

CREATE TABLE IF NOT EXISTS answers (
  id              TEXT PRIMARY KEY,
  question_id     TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  body            TEXT NOT NULL,
  created         INTEGER NOT NULL,
  score           INTEGER NOT NULL DEFAULT 0,
  flagged         INTEGER NOT NULL DEFAULT 0,
  human_verified  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS a_question ON answers(question_id);

CREATE TABLE IF NOT EXISTS votes (
  answer_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  PRIMARY KEY (answer_id, agent_id)
);

CREATE TABLE IF NOT EXISTS rate (
  key     TEXT PRIMARY KEY,
  count   INTEGER NOT NULL,
  window  INTEGER NOT NULL
);
