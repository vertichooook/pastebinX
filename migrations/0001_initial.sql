CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(64) UNIQUE NOT NULL,
 password_hash text NOT NULL, role varchar(8) NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
 is_active boolean NOT NULL DEFAULT true, next_def_number integer NOT NULL DEFAULT 1 CHECK(next_def_number>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 def_number integer NOT NULL CHECK(def_number>0), slug varchar(32) NOT NULL,
 title varchar(200),content text NOT NULL,is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,
 UNIQUE(user_id,def_number),UNIQUE(user_id,slug),CHECK(slug='def'||def_number::text)
);
CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf_token text NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),admin_id uuid,action varchar(32) NOT NULL,target_user_id uuid,target_entry_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_created ON audit_logs(created_at);
CREATE TABLE login_limits(key text PRIMARY KEY,count integer NOT NULL,expires_at timestamptz NOT NULL);
