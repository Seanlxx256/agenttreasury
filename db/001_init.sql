CREATE TABLE agents (
    id uuid PRIMARY KEY,
    token_digest bytea NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE research_tasks (
    id uuid PRIMARY KEY,
    agent_id uuid NOT NULL REFERENCES agents(id),
    active_until timestamptz NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    budget bigint NOT NULL CHECK (budget > 0),
    daily_limit bigint NOT NULL CHECK (daily_limit > 0),
    reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
    CHECK (reserved + spent <= budget)
);

CREATE TABLE services (
    id uuid PRIMARY KEY,
    endpoint text NOT NULL CHECK (endpoint LIKE 'https://%'),
    network text NOT NULL CHECK (network = 'eip155:84532'),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    payee text NOT NULL CHECK (payee ~ '^0x[0-9a-f]{40}$'),
    price bigint NOT NULL CHECK (price > 0),
    enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE task_services (
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    service_id uuid NOT NULL REFERENCES services(id),
    PRIMARY KEY (task_id, service_id)
);

CREATE TABLE daily_spend (
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    day date NOT NULL,
    reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
    PRIMARY KEY (task_id, day)
);

CREATE TABLE payment_intents (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    service_id uuid NOT NULL,
    request_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('RESERVED', 'REJECTED')),
    reason text,
    policy_version text NOT NULL,
    endpoint text NOT NULL,
    network text NOT NULL,
    asset text NOT NULL,
    payee text NOT NULL,
    amount bigint NOT NULL CHECK (amount > 0),
    budget_day date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, idempotency_key),
    UNIQUE (task_id, request_id),
    CHECK ((reason IS NULL) = (status = 'RESERVED'))
);

CREATE TABLE outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    intent_id uuid NOT NULL REFERENCES payment_intents(id),
    event_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (intent_id, event_type)
);
