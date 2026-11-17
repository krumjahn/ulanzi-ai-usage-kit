#!/bin/bash
# Install a reviewed release into the current account. Quit Ulanzi Studio first.
set -euo pipefail
umask 077
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECK="$HOME/Library/Application Support/Ulanzi/UlanziDeck"
PLUGIN_NAME="com.ulanzi.ulanzideck.UsageStat.ulanziPlugin"
PLUGIN_SRC="$KIT_DIR/plugin/$PLUGIN_NAME"
PROFILE_SRC="$KIT_DIR/profile/ai-usage-kit.ulanziProfile"
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
case "${1:-}" in
    --check|'') ;;
    *) fail 'Usage: bash install.sh [--check]' ;;
esac
[[ $# -le 1 ]] || fail 'Unexpected arguments.'
[[ "$(uname -s)" == Darwin ]] || fail 'This experimental kit requires macOS.'
command -v python3 >/dev/null || fail 'Python 3 is required.'
command -v pgrep >/dev/null || fail 'pgrep is required.'
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || NODE_BIN='/Applications/Ulanzi Studio.app/Contents/MacOS/NodeJS/node'
[[ -x "$NODE_BIN" ]] || fail 'Node.js 18+ is required (standalone or bundled with Ulanzi Studio).'
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail 'Node.js 18+ is required.'
[[ -d "$DECK" ]] || fail 'Open Ulanzi Studio once to create its support folder.'
[[ -d "$PLUGIN_SRC" && -d "$PROFILE_SRC" ]] || fail 'Plugin or profile source is missing.'
"$NODE_BIN" --check "$PLUGIN_SRC/dist/app.js"
"$NODE_BIN" -e 'require(process.argv[1])' "$PLUGIN_SRC/node_modules/ws"
python3 - "$PLUGIN_SRC" "$PROFILE_SRC" <<'CHECK'
import json, pathlib, sys
for root in sys.argv[1:]:
    for file in pathlib.Path(root).rglob('*.json'):
        json.loads(file.read_text())
CHECK
if [[ "${1:-}" == --check ]]; then
    echo 'Prerequisite and source checks passed. No installation performed.'
    exit 0
fi
# Never kill the app or its workers. A running instance can overwrite profiles.
if pgrep -f 'Ulanzi Studio.app/Contents/MacOS/' >/dev/null; then
    fail 'Quit Ulanzi Studio and its plugin workers, then run the installer again.'
else
    status=$?
    [[ "$status" == 1 ]] || fail 'Could not check whether Ulanzi Studio is running.'
fi
mkdir -p "$DECK/Plugins" "$DECK/ProfilesV2" "$HOME/.ulanzi/backups"
STAGE="$(mktemp -d "$DECK/.ai-usage-stage.XXXXXX")"
BACKUP=''
PLUGIN_INSTALLED=0
PROFILE_INSTALLED=0
NEW_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
DEST="$DECK/Plugins/$PLUGIN_NAME"
NEW_PROFILE="$DECK/ProfilesV2/$NEW_ID.ulanziProfile"
[[ ! -e "$NEW_PROFILE" && ! -L "$NEW_PROFILE" ]] || fail 'Profile destination already exists.'
cleanup() {
    status=$?
    trap - EXIT
    if [[ "$status" != 0 ]]; then
        [[ "$PROFILE_INSTALLED" == 0 ]] || rm -rf "$NEW_PROFILE"
        [[ "$PLUGIN_INSTALLED" == 0 ]] || rm -rf "$DEST"
        if [[ -n "$BACKUP" && -e "$BACKUP/$PLUGIN_NAME" ]]; then
            mv "$BACKUP/$PLUGIN_NAME" "$DEST" || echo "Restore manually from $BACKUP" >&2
        fi
        echo 'Installation failed; attempted to restore the previous plugin.' >&2
    fi
    rm -rf "$STAGE"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -R "$PLUGIN_SRC" "$STAGE/$PLUGIN_NAME"
cp -R "$PROFILE_SRC" "$STAGE/profile"
python3 - "$STAGE/profile" "$HOME" <<'REWRITE'
import json, pathlib, sys
root, home = pathlib.Path(sys.argv[1]), sys.argv[2]
def rewrite(value):
    if isinstance(value, str): return value.replace('/Users/USERNAME', home)
    if isinstance(value, list): return [rewrite(v) for v in value]
    if isinstance(value, dict): return {k: rewrite(v) for k, v in value.items()}
    return value
for file in root.rglob('*.json'):
    file.write_text(json.dumps(rewrite(json.loads(file.read_text())), indent=2) + '\n')
REWRITE
if [[ -e "$DEST" || -L "$DEST" ]]; then
    [[ ! -L "$DEST" ]] || fail 'Refusing to replace a symlinked plugin.'
    BACKUP="$(mktemp -d "$HOME/.ulanzi/backups/ai-usage.XXXXXX")"
    mv "$DEST" "$BACKUP/$PLUGIN_NAME"
fi
mv "$STAGE/$PLUGIN_NAME" "$DEST"
PLUGIN_INSTALLED=1
mv "$STAGE/profile" "$NEW_PROFILE"
PROFILE_INSTALLED=1
printf 'Installed plugin: %s\nNew profile: %s\n' "$DEST" "$NEW_PROFILE"
[[ -z "$BACKUP" ]] || printf 'Previous plugin backup: %s\n' "$BACKUP"
echo 'Start Ulanzi Studio yourself and select AI Usage Kit (experimental).'
echo 'If the unbound D200 profile is not listed, add the plugin actions to a new profile manually.'
echo 'Calendar and credentials are optional separate setup steps; see README.md.'
