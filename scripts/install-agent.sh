#!/usr/bin/env bash
# Build wgraph, put a launcher on disk, and install the subagent definition.
#
# Everything it writes lives under ~/.claude, and re-running it is safe.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN_DIR="$CLAUDE_DIR/bin"
AGENTS_DIR="$CLAUDE_DIR/agents"
LAUNCHER="$BIN_DIR/wgraph"
AGENT_SRC="$REPO/agent/website-grapher.md"
AGENT_DEST="$AGENTS_DIR/website-grapher.md"

echo "Building wgraph in $REPO"
cd "$REPO"
[ -d node_modules ] || npm install
npm run build

mkdir -p "$BIN_DIR" "$AGENTS_DIR"

# A launcher rather than `npm link`: no global npm writes, no PATH surprises,
# and it keeps working when the repo moves as long as this is re-run.
cat > "$LAUNCHER" <<LAUNCHER_EOF
#!/usr/bin/env bash
exec node "$REPO/dist/cli/index.js" "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"
echo "Launcher: $LAUNCHER"

# A symlink so edits to the agent definition take effect without reinstalling.
ln -sf "$AGENT_SRC" "$AGENT_DEST"
echo "Agent:    $AGENT_DEST -> $AGENT_SRC"

echo
"$LAUNCHER" graph list >/dev/null && echo "wgraph runs."
echo
echo "Add $BIN_DIR to your PATH to use \`wgraph\` directly:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
echo
echo "Then, in Claude Code, ask the website-grapher agent something like:"
echo "  \"How do I find the price of a product on books.toscrape.com?\""
