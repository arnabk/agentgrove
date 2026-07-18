-- Demo dataset for the AgentGrove DB editor recording.
-- Loaded automatically by the postgres container's initdb hook.

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    owner_id INT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    stars INT NOT NULL DEFAULT 0
);

CREATE TABLE events (
    id BIGSERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users (name, email, role) VALUES
    ('Ada Lovelace',  'ada@example.dev',  'admin'),
    ('Alan Turing',   'alan@example.dev', 'member'),
    ('Grace Hopper',  'grace@example.dev','member'),
    ('Edsger Dijkstra','edsger@example.dev','viewer'),
    ('Margaret Hamilton','margaret@example.dev','member'),
    ('Katherine Johnson','katherine@example.dev','viewer'),
    ('Barbara Liskov','barbara@example.dev','member'),
    ('Donald Knuth',  'donald@example.dev','viewer');

INSERT INTO projects (owner_id, name, status, stars) VALUES
    (1, 'agentgrove',        'active',   128),
    (1, 'galaxy-map',        'active',    64),
    (2, 'enigma-redux',      'archived',  512),
    (3, 'compiler-garden',   'active',   1024),
    (5, 'apollo-flight-sim', 'active',   2048),
    (7, 'stack-machine',     'paused',     32);

INSERT INTO events (project_id, kind, payload) VALUES
    (1, 'push',     '{"branch": "main", "commits": 3}'),
    (1, 'release',  '{"tag": "v0.1.36"}'),
    (3, 'push',     '{"branch": "tape", "commits": 1}'),
    (4, 'issue',    '{"title": "type checker loop"}'),
    (4, 'push',     '{"branch": "main", "commits": 7}'),
    (5, 'release',  '{"tag": "v11.0"}'),
    (5, 'deploy',   '{"env": "sim-lab"}'),
    (6, 'issue',    '{"title": "stack overflow on empty input"}');
