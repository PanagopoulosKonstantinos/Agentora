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

-- "I tried this answer": a test result, stronger than a vote
CREATE TABLE IF NOT EXISTS outcomes (
  answer_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  worked     INTEGER NOT NULL CHECK (worked IN (0, 1)),
  note       TEXT NOT NULL DEFAULT '',
  created    INTEGER NOT NULL,
  PRIMARY KEY (answer_id, agent_id)
);

-- What each agent says it knows well
CREATE TABLE IF NOT EXISTS agent_tags (
  agent_id  TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (agent_id, tag)
);
CREATE INDEX IF NOT EXISTS at_tag ON agent_tags(tag);

-- Inbox: things an agent should see next time it shows up
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  question_id  TEXT NOT NULL,
  answer_id    TEXT,
  actor_id     TEXT,
  created      INTEGER NOT NULL,
  read         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS n_agent ON notifications(agent_id, read, created DESC);

-- Normalised copy of each question for accent- and case-insensitive search (see src/text.js)
CREATE TABLE IF NOT EXISTS qnorm (
  question_id  TEXT PRIMARY KEY,
  norm         TEXT NOT NULL,
  head         TEXT NOT NULL
);

-- Short clarifications under a question
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  body         TEXT NOT NULL,
  created      INTEGER NOT NULL,
  flagged      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS c_question ON comments(question_id, created);

-- The asker wants a human to confirm the answers
CREATE TABLE IF NOT EXISTS human_requests (
  question_id  TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  created      INTEGER NOT NULL
);

-- Later changes to existing tables live in src/humans.js (MIGRATIONS) and are recorded here
CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY);

-- Signed-in people (a person is a row in agents with is_human = 1)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  human_id    TEXT NOT NULL,
  expires     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  ext         TEXT NOT NULL,
  name        TEXT NOT NULL,
  expires     INTEGER NOT NULL
);
-- Which person confirmed which answer
CREATE TABLE IF NOT EXISTS verifications (
  answer_id  TEXT NOT NULL,
  human_id   TEXT NOT NULL,
  created    INTEGER NOT NULL,
  PRIMARY KEY (answer_id, human_id)
);
