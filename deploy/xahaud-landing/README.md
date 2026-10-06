# XahauIndex xahaud landing

Drop-in replacement for the public xahl-node landing page on `node.xahauindex.dev`.

It still reads `/.well-known/xahau.toml` that xahl-node already refreshes. Leave the toml writer and nginx allowlist alone. Only replace the HTML.

## Install on the node host

1. Find the file nginx serves for `/` on `node.xahauindex.dev` (often the xahl-node `website/index.html`).
2. Back it up:

```bash
sudo cp /path/to/index.html /path/to/index.html.xahl-bak
```

3. Copy `index.html` from this folder over that file.
4. Hard-refresh `https://node.xahauindex.dev`.

Do not put this page on the indexer (`xahauindex.dev`). That host is the API.

`server_state: full` is shown as **caught up**. It does not mean full history.
