# Dashboard HTTP contract

The dashboard serves a bundled application and a small local API. Every `/api` route requires `Authorization: Bearer TOKEN`. Host must match the actual `127.0.0.1:PORT` listener; a browser Origin must exactly match its HTTP origin. Missing or foreign authorization/origin is rejected. Query-string tokens are never accepted. Responses do not permit cross-origin reading or embedding.

Ordinary JSON requests are at most 1 MiB and use `Content-Type: application/json`. Errors have `{ "error": { "code": "...", "message": "...", "details": ... } }`. Statuses distinguish malformed input (400), missing authentication (401), forbidden origin/host (403), missing resources (404), state/revision conflicts (409), oversized bodies (413), invalid candidates (422), unavailable capabilities (503) and internal failures (500).

`GET /api/bootstrap` returns `apiVersion`, `version`, `instanceId`, `cwd`, `configPath`, optional `preferredAgent`, safe config metadata (`exists`, `revision`, `canonical`, `valid`, optional `diagnostic`, agent/model alias lists and `defaultAgent`) and store readiness/diagnostic. It does not return credentials, raw config, conversation text or lease tokens and does not instantiate a runtime.

Only defined browser routes return the application entrypoint on refresh. Unknown API paths, missing static assets and unknown page routes return their actual errors. Static files are contained in the installed `dist/dashboard` directory; config/source files are never served through static routes.

Further session, stream and management schemas are specified alongside their adapters in the shared TypeScript contract. API versioning is separate from session persistence compatibility.
