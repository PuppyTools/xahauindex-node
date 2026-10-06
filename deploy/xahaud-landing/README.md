# XahauIndex xahaud landing

Drop-in replacement for the public xahl-node landing page on `node.xahauindex.dev`.

It still reads `/.well-known/xahau.toml` that xahl-node already refreshes. Leave the toml writer, nginx allowlist, and websocket/RPC restrictions alone. Only replace the HTML.

## Install on the node host

Find the file nginx serves for `/`:

```bash
sudo nginx -T 2>/dev/null | grep -nE 'root |index '
# often: /opt/xahl-node/website/index.html
```

Back it up, then drop this file in:

```bash
PAGE=/opt/xahl-node/website/index.html
sudo cp "$PAGE" "${PAGE}.xahl-bak"
sudo curl -fsSL -o "$PAGE" \
  https://raw.githubusercontent.com/PuppyTools/xahauindex-node/cursor/xahaud-landing-5c2e/deploy/xahaud-landing/index.html
```

Hard-refresh `https://node.xahauindex.dev`.

Do not put this page on the indexer (`xahauindex.dev`). That host is the API.

`server_state: full` is shown as **caught up**. It does not mean full history.
