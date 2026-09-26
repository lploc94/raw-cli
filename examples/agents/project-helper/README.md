# Portable project helper

Copy the whole folder, replace the model ID in raw.json and run:

```sh
raw --config /path/to/project-helper/raw.json --agent project "Inspect this project"
raw --config /path/to/project-helper/raw.json vars get project_info
```

The project_info JSON file resolves beside config even from another cwd. Its
value is read only on demand through read_var; list_vars exposes metadata.
The second command needs no model or credentials. Prompt, tools, skills and
variable data travel together. See examples/providers/host-info for an executable
source; MCP authentication and remote services remain separate prerequisites.
