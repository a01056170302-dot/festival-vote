PRAGMA foreign_keys = ON;
CREATE TABLE participants (
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
 mask_name TEXT NOT NULL CHECK(length(mask_name) BETWEEN 1 AND 80), image_url TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE matches (
 id TEXT PRIMARY KEY, round_label TEXT NOT NULL, match_title TEXT NOT NULL,
 participant_a_id TEXT NOT NULL REFERENCES participants(id), participant_b_id TEXT NOT NULL REFERENCES participants(id),
 participant_a_name_snapshot TEXT NOT NULL, participant_b_name_snapshot TEXT NOT NULL,
 participant_a_mask_snapshot TEXT NOT NULL, participant_b_mask_snapshot TEXT NOT NULL,
 participant_a_image_snapshot TEXT NOT NULL DEFAULT '', participant_b_image_snapshot TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','OPEN','CLOSED','PUBLISHED')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 opened_at TEXT, closed_at TEXT, published_at TEXT, version INTEGER NOT NULL DEFAULT 1,
 CHECK(participant_a_id <> participant_b_id)
);
CREATE UNIQUE INDEX one_open_match ON matches((1)) WHERE status='OPEN';
CREATE TABLE event_state (
 id INTEGER PRIMARY KEY CHECK(id=1), current_match_id TEXT REFERENCES matches(id),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO event_state(id) VALUES(1);
CREATE TABLE votes (
 id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id), voter_hash TEXT NOT NULL,
 selected_participant_id TEXT NOT NULL REFERENCES participants(id), request_id TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(match_id,voter_hash)
);
CREATE INDEX vote_count ON votes(match_id,selected_participant_id);
CREATE INDEX matches_created ON matches(created_at);
CREATE TABLE admin_sessions (
 token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX session_expiry ON admin_sessions(expires_at);
CREATE TABLE rate_limits (
 key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL
);
CREATE TABLE admin_audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, match_id TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Each statement is serialized by SQLite. A close cannot interleave within a vote INSERT.
CREATE TRIGGER vote_guard BEFORE INSERT ON votes BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM matches m JOIN event_state e ON e.current_match_id=m.id AND e.id=1
  WHERE m.id=NEW.match_id AND m.status='OPEN'
    AND NEW.selected_participant_id IN(m.participant_a_id,m.participant_b_id)
 ) THEN RAISE(ABORT,'VOTE_NOT_ALLOWED') END;
END;
CREATE TRIGGER votes_no_update BEFORE UPDATE ON votes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VOTE'); END;
CREATE TRIGGER votes_no_delete BEFORE DELETE ON votes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VOTE'); END;
CREATE TRIGGER immutable_published BEFORE UPDATE ON matches WHEN OLD.status='PUBLISHED'
BEGIN SELECT RAISE(ABORT,'PUBLISHED_IMMUTABLE'); END;
CREATE TRIGGER match_transition BEFORE UPDATE OF status ON matches
WHEN NOT ((OLD.status='READY' AND NEW.status='OPEN') OR (OLD.status='OPEN' AND NEW.status='CLOSED') OR (OLD.status='CLOSED' AND NEW.status IN ('OPEN','PUBLISHED')))
BEGIN SELECT RAISE(ABORT,'INVALID_TRANSITION'); END;
CREATE TRIGGER open_current_only BEFORE UPDATE OF status ON matches
WHEN NEW.status='OPEN' AND NOT EXISTS(SELECT 1 FROM event_state WHERE id=1 AND current_match_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'NOT_CURRENT'); END;
CREATE TRIGGER no_switch_while_open BEFORE UPDATE OF current_match_id ON event_state
WHEN NEW.current_match_id IS NOT OLD.current_match_id AND EXISTS(SELECT 1 FROM matches WHERE id=OLD.current_match_id AND status='OPEN')
BEGIN SELECT RAISE(ABORT,'CLOSE_FIRST'); END;
CREATE TRIGGER audit_status AFTER UPDATE OF status ON matches BEGIN
 INSERT INTO admin_audit_logs(action,match_id) VALUES(OLD.status||'->'||NEW.status,NEW.id);
END;
CREATE TRIGGER audit_select AFTER UPDATE OF current_match_id ON event_state BEGIN
 INSERT INTO admin_audit_logs(action,match_id) VALUES('SELECT',NEW.current_match_id);
END;
CREATE TRIGGER audit_create AFTER INSERT ON matches BEGIN
 INSERT INTO admin_audit_logs(action,match_id) VALUES('CREATE',NEW.id);
END;
