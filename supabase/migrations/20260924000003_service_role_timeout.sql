-- The daily ingest is one long-ish transaction (tens of thousands of rows). PostgREST connects as `authenticator`
-- (8 s statement timeout) and applies the impersonated role's own settings, so give the server-side service_role
-- a generous limit. anon / authenticated keep their short limits.
alter role service_role set statement_timeout = '120s';
