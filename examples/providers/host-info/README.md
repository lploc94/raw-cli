# Host information provider

Copy this whole folder. Node is the only executable dependency. Run from any cwd:

```sh
raw --config /path/to/host-info/raw.json vars list
raw --config /path/to/host-info/raw.json vars get hostname
raw --config /path/to/host-info/raw.json vars get platform
```

These commands do not need a configured model or its credentials. To use the
agent with inference, replace YOUR_INSTALLED_MODEL with an installed model ID.
`token` is consumption-only and needs RAW_EXAMPLE_TOKEN in the parent's environment
only when consumed. `vars get token` always rejects read access.

The host provider runs from the config directory, receives fixed params on stdin,
and returns the actual hostname/platform. Fork provider.mjs to query another
source; keep stdout exclusively for one JSON response and logs on stderr.
