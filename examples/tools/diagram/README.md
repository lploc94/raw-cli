# Sidebar diagram example

Copy this folder into your local Raw tools directory, select `local/diagram` for an agent, and call it with `source`, optional `title`, and optional plain-text `fallback`. The manifest explicitly declares a v2 sidebar view. This standalone module has no package dependencies and uses the host's shared renderer; it does not introduce a diagram builtin.

```json
{"source":"sequenceDiagram\nUser->>Server: Request\nServer-->>User: Result","title":"Request flow","fallback":"User requests a result from the server."}
```

Use `placement: "chat"` in the declaration instead to publish an inline view. For source restrictions and failure behavior, see [diagrams.md](../../../docs/diagrams.md).
