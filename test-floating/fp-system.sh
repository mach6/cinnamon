#!/usr/bin/env bash
#
# fp-system.sh - install / revert the panel-strategies fork on the LIVE system.
#
# Unlike fp-nested-test.sh (which runs the fork in a throwaway Xephyr session), this
# swaps the fork into your real /usr/share/cinnamon install so floating / grid /
# expanding / drawer panels work in your everyday Cinnamon. It is fully reversible:
# the first install backs up every stock file it touches, and `revert` restores them
# bit-for-bit and deletes the files the fork adds.
#
#   ./fp-system.sh install   # back up stock, install fork, restart Cinnamon
#   ./fp-system.sh revert     # restore stock, clean fork config, restart Cinnamon
#   ./fp-system.sh status     # show which version of each managed file is active
#
# Run as your normal user (NOT root) - it uses sudo only for the /usr writes, and
# plain gsettings (your session bus) for the config cleanup on revert.
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYS=/usr/share/cinnamon/js/ui
CSMOD=/usr/share/cinnamon/cinnamon-settings/modules
WSAPPLET=/usr/share/cinnamon/applets/workspace-switcher@cinnamon.org/applet.js
THEMEDIR=/usr/share/cinnamon/theme
SCHEMA_DIR=/usr/share/glib-2.0/schemas
SCHEMA_SYS=$SCHEMA_DIR/org.cinnamon.gschema.xml
# Backups live OUTSIDE the repo so git operations can't disturb them and so a stock
# snapshot survives even if the working tree changes.
BK=${XDG_STATE_HOME:-$HOME/.local/state}/cinnamon-panel-fork/backup

# kind|src (in repo)|dest (on system)
#   over - a stock file we overwrite (backed up first, restored on revert)
#   new  - a file the fork adds (no stock version; deleted on revert)
manifest() {
    local ui="$REPO/js/ui"
    local mods="$REPO/files/usr/share/cinnamon/cinnamon-settings/modules"
    cat <<EOF
over|$ui/panel.js|$SYS/panel.js
over|$ui/main.js|$SYS/main.js
over|$ui/popupMenu.js|$SYS/popupMenu.js
over|$ui/tooltips.js|$SYS/tooltips.js
over|$ui/appletManager.js|$SYS/appletManager.js
over|$ui/applet.js|$SYS/applet.js
over|$mods/cs_panel.py|$CSMOD/cs_panel.py
over|$mods/cs_applets.py|$CSMOD/cs_applets.py
over|$REPO/files/usr/share/cinnamon/applets/workspace-switcher@cinnamon.org/applet.js|$WSAPPLET
over|$REPO/data/org.cinnamon.gschema.xml|$SCHEMA_SYS
new|$ui/panelGeometry.js|$SYS/panelGeometry.js
new|$ui/panelVisibility.js|$SYS/panelVisibility.js
new|$ui/panelLayout.js|$SYS/panelLayout.js
new|$REPO/data/theme/floating-panels.css|$THEMEDIR/floating-panels.css
EOF
}

die() { echo "error: $*" >&2; exit 1; }

# Backup path mirrors the absolute dest under $BK so same-named files (js/ui/applet.js
# vs the workspace-switcher applet.js) never collide.
bkpath() { echo "$BK$1"; }

preflight() {
    [ "${EUID:-$(id -u)}" -ne 0 ] || die "run as your normal user, not root (the script sudo's where needed)."
    [ -d "$REPO/js/ui" ] || die "repo not found at $REPO"
    # Every source file must exist, or we'd install a half-set and crash Cinnamon.
    local kind src dest
    while IFS='|' read -r kind src dest; do
        [ -f "$src" ] || die "missing source file: $src"
    done < <(manifest)
}

install_fork() {
    preflight
    echo "Backing up stock files to $BK ..."
    local kind src dest bk
    while IFS='|' read -r kind src dest; do
        [ "$kind" = over ] || continue
        bk=$(bkpath "$dest")
        if [ -e "$bk" ]; then
            continue   # already have a stock snapshot; never overwrite it
        fi
        if [ ! -e "$dest" ]; then
            echo "  ! $dest absent on system; skipping backup"
            continue
        fi
        if cmp -s "$src" "$dest"; then
            # dest already equals the fork version but we have no backup: we cannot
            # recover the stock file, so refuse rather than save a forked "stock".
            die "$dest already matches the fork but no backup exists at $bk.
       Restore the stock file (e.g. reinstall the cinnamon package) before installing."
        fi
        mkdir -p "$(dirname "$bk")"
        sudo cp -a "$dest" "$bk" && echo "  backed up $dest"
    done < <(manifest)

    echo "Installing fork files ..."
    while IFS='|' read -r kind src dest; do
        sudo mkdir -p "$(dirname "$dest")"
        sudo cp -a "$src" "$dest" && echo "  $([ "$kind" = new ] && echo '+ added' || echo '~ replaced') $dest"
    done < <(manifest)

    echo "Recompiling gsettings schemas ..."
    sudo glib-compile-schemas "$SCHEMA_DIR" || die "schema compile failed"

    echo
    echo "Installed. Floating / grid / expanding panels are now available via"
    echo "System Settings > Panel > Add new panel."
    maybe_restart
}

revert_fork() {
    [ "${EUID:-$(id -u)}" -ne 0 ] || die "run as your normal user, not root."
    [ -d "$BK" ] || die "no backup directory at $BK - nothing to revert (was the fork installed by this script?)"

    # Clean the fork's config from dconf FIRST, while the panels-extended key still
    # exists in the active (fork) schema: drop any non-edge panels from panels-enabled
    # (so stock Cinnamon doesn't turn a floating panel id into a stray edge panel) and
    # reset panels-extended. Done before the schema is restored below.
    clean_fork_config

    echo "Restoring stock files from $BK ..."
    local kind src dest bk
    while IFS='|' read -r kind src dest; do
        if [ "$kind" = new ]; then
            sudo rm -f "$dest" && echo "  - removed $dest"
            continue
        fi
        bk=$(bkpath "$dest")
        if [ -e "$bk" ]; then
            sudo cp -a "$bk" "$dest" && echo "  ~ restored $dest"
        else
            echo "  ! no backup for $dest; leaving current file in place"
        fi
    done < <(manifest)

    echo "Recompiling gsettings schemas ..."
    sudo glib-compile-schemas "$SCHEMA_DIR" || die "schema compile failed"

    echo
    echo "Reverted to stock Cinnamon. (Stock snapshots remain in $BK; delete it"
    echo "manually if you're sure you won't reinstall.)"
    maybe_restart
}

# Strip non-edge panels from panels-enabled and reset panels-extended.
clean_fork_config() {
    command -v gsettings >/dev/null 2>&1 || { echo "  (gsettings unavailable; skipping config cleanup)"; return; }
    echo "Cleaning fork panel config from dconf ..."
    python3 - <<'PY' || echo "  (config cleanup skipped: $?)"
import ast, json, subprocess, sys

def get(key):
    out = subprocess.check_output(['gsettings', 'get', 'org.cinnamon', key]).decode()
    return ast.literal_eval(out)

def setlist(key, values):
    variant = '[' + ', '.join("'" + v.replace("'", r"\'") + "'" for v in values) + ']'
    subprocess.check_call(['gsettings', 'set', 'org.cinnamon', key, variant])

try:
    extended = get('panels-extended')
    enabled = get('panels-enabled')
except Exception as e:
    print("  (could not read panel settings: %s)" % e); sys.exit(0)

nonedge = set()
for entry in extended:
    try:
        obj = json.loads(entry)
        if str(obj.get('type', 'edge')) != 'edge':
            nonedge.add(str(obj.get('id')))
    except Exception:
        pass

kept = [d for d in enabled if d.split(':')[0] not in nonedge]
if len(kept) != len(enabled):
    setlist('panels-enabled', kept)
    print("  removed %d non-edge panel(s) from panels-enabled" % (len(enabled) - len(kept)))
if extended:
    subprocess.call(['gsettings', 'reset', 'org.cinnamon', 'panels-extended'])
    print("  reset panels-extended")
PY
}

show_status() {
    [ -d "$REPO/js/ui" ] || die "repo not found at $REPO"
    local kind src dest bk state
    printf "%-46s %-8s %s\n" "FILE" "ACTIVE" "BACKUP"
    while IFS='|' read -r kind src dest; do
        if [ ! -e "$dest" ]; then
            state="absent"
        elif cmp -s "$src" "$dest"; then
            state="FORK"
        else
            state="stock"
        fi
        bk=$(bkpath "$dest")
        printf "%-46s %-8s %s\n" "$(basename "$dest")" "$state" "$([ -e "$bk" ] && echo yes || echo '-')"
    done < <(manifest)
}

maybe_restart() {
    echo
    if [ -z "${DISPLAY:-}" ]; then
        echo "No \$DISPLAY detected - restart Cinnamon manually (Ctrl+Alt+Esc, or log out/in)."
        return
    fi
    read -r -p "Restart Cinnamon now to apply? [y/N] " ans
    case "$ans" in
        [yY]*)
            echo "Restarting Cinnamon (the desktop will briefly flicker) ..."
            setsid cinnamon --replace >/dev/null 2>&1 < /dev/null &
            ;;
        *)
            echo "Skipped. Apply later with: cinnamon --replace &  (or Ctrl+Alt+Esc)."
            ;;
    esac
}

case "${1:-}" in
    install) install_fork ;;
    revert)  revert_fork ;;
    status)  show_status ;;
    *) echo "usage: $0 {install|revert|status}" >&2; exit 2 ;;
esac
