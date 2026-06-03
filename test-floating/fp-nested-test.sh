#!/usr/bin/env bash
#
# fp-nested-test.sh - run the floating-panel fork in an isolated nested Cinnamon
# session (Xephyr) WITHOUT disturbing your live session.
#
# What it does, and why it's safe:
#   * Backs up the stock /usr/share/cinnamon/js/ui/panel.js, then drops in the
#     fork's panel.js + panel-strategy modules. (sudo) These are restored on exit.
#   * Your LIVE session keeps running the code already loaded in memory; it is
#     only affected if Cinnamon is restarted while the swap is in place - and even
#     then the fork is a no-op unless a panel has a "panels-extended" entry, which
#     is only ever written into the ISOLATED test config below, never your real one.
#   * Settings are isolated via a throwaway XDG_CONFIG_HOME and a schema-dir
#     override, so your real dconf and the system gschema are never modified.
#
# Requires: sudo (for the JS swap only), Xephyr. Watch the Xephyr window that opens.
# Press Ctrl-C in this terminal (or close Xephyr) to tear down and restore.
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYS=/usr/share/cinnamon/js/ui
CSMOD=/usr/share/cinnamon/cinnamon-settings/modules
WSAPPLET=/usr/share/cinnamon/applets/workspace-switcher@cinnamon.org/applet.js
THEMEDIR=/usr/share/cinnamon/theme
BK="$REPO/test-floating/backup"
TMP=$(mktemp -d /tmp/fp-nested.XXXXXX)
SCHEMADIR=/tmp/fp-schemas
DISPLAY_NUM=:5
XEPHYR_SIZE=1600x900

cleanup() {
    echo
    echo "[cleanup] tearing down ..."
    [ -n "${CINNAMON_PID:-}" ] && kill "$CINNAMON_PID" 2>/dev/null
    [ -n "${XEPHYR_PID:-}" ]   && kill "$XEPHYR_PID"   2>/dev/null
    # Restore stock JS
    if [ -f "$BK/panel.js" ]; then
        sudo cp -a "$BK/panel.js" "$SYS/panel.js"
        echo "[cleanup] restored stock panel.js"
    fi
    if [ -f "$BK/appletManager.js" ]; then
        sudo cp -a "$BK/appletManager.js" "$SYS/appletManager.js"
        echo "[cleanup] restored stock appletManager.js"
    fi
    if [ -f "$BK/applet.js" ]; then
        sudo cp -a "$BK/applet.js" "$SYS/applet.js"
        echo "[cleanup] restored stock applet.js"
    fi
    if [ -f "$BK/workspace-switcher-applet.js" ]; then
        sudo cp -a "$BK/workspace-switcher-applet.js" "$WSAPPLET"
        echo "[cleanup] restored stock workspace-switcher applet.js"
    fi
    if [ -f "$BK/main.js" ]; then
        sudo cp -a "$BK/main.js" "$SYS/main.js"
        echo "[cleanup] restored stock main.js"
    fi
    if [ -f "$BK/popupMenu.js" ]; then
        sudo cp -a "$BK/popupMenu.js" "$SYS/popupMenu.js"
        echo "[cleanup] restored stock popupMenu.js"
    fi
    if [ -f "$BK/tooltips.js" ]; then
        sudo cp -a "$BK/tooltips.js" "$SYS/tooltips.js"
        echo "[cleanup] restored stock tooltips.js"
    fi
    sudo rm -f "$THEMEDIR/floating-panels.css"
    if [ -f "$BK/cs_panel.py" ]; then
        sudo cp -a "$BK/cs_panel.py" "$CSMOD/cs_panel.py"
        echo "[cleanup] restored stock cs_panel.py"
    fi
    if [ -f "$BK/cs_applets.py" ]; then
        sudo cp -a "$BK/cs_applets.py" "$CSMOD/cs_applets.py"
        echo "[cleanup] restored stock cs_applets.py"
    fi
    sudo rm -f "$SYS/panelGeometry.js" "$SYS/panelVisibility.js" "$SYS/panelLayout.js" 2>/dev/null
    echo "[cleanup] removed test JS files"
    rm -rf "$TMP"
    echo "[cleanup] done."
}
trap cleanup EXIT INT TERM

echo "[1/5] Compiling modified schema (no system change) ..."
mkdir -p "$SCHEMADIR"
cp "$REPO/data/org.cinnamon.gschema.xml" "$SCHEMADIR/"
glib-compile-schemas "$SCHEMADIR/" || { echo "schema compile failed"; exit 1; }

echo "[2/5] Backing up + installing fork JS into $SYS (sudo) ..."
mkdir -p "$BK"
[ -f "$BK/panel.js" ]          || sudo cp -a "$SYS/panel.js"          "$BK/panel.js"
[ -f "$BK/appletManager.js" ]  || sudo cp -a "$SYS/appletManager.js"  "$BK/appletManager.js"
[ -f "$BK/applet.js" ]         || sudo cp -a "$SYS/applet.js"         "$BK/applet.js"
[ -f "$BK/main.js" ]           || sudo cp -a "$SYS/main.js"           "$BK/main.js"
[ -f "$BK/popupMenu.js" ]      || sudo cp -a "$SYS/popupMenu.js"      "$BK/popupMenu.js"
[ -f "$BK/tooltips.js" ]       || sudo cp -a "$SYS/tooltips.js"       "$BK/tooltips.js"
[ -f "$BK/workspace-switcher-applet.js" ] || sudo cp -a "$WSAPPLET"   "$BK/workspace-switcher-applet.js"
[ -f "$BK/cs_panel.py" ]       || sudo cp -a "$CSMOD/cs_panel.py"     "$BK/cs_panel.py"
[ -f "$BK/cs_applets.py" ]     || sudo cp -a "$CSMOD/cs_applets.py"   "$BK/cs_applets.py"
# Install panel.js plus every fork JS module that exists (guarded), so a newly
# added module is never forgotten - a missing import crashes Cinnamon at startup.
for m in panel main popupMenu appletManager applet tooltips panelGeometry panelVisibility panelLayout; do
    [ -f "$REPO/js/ui/$m.js" ] && sudo cp -a "$REPO/js/ui/$m.js" "$SYS/$m.js"
done
sudo cp -a "$REPO/files/usr/share/cinnamon/cinnamon-settings/modules/cs_panel.py"   "$CSMOD/cs_panel.py"
sudo cp -a "$REPO/files/usr/share/cinnamon/cinnamon-settings/modules/cs_applets.py" "$CSMOD/cs_applets.py"
sudo cp -a "$REPO/files/usr/share/cinnamon/applets/workspace-switcher@cinnamon.org/applet.js" "$WSAPPLET"
sudo cp -a "$REPO/data/theme/floating-panels.css" "$THEMEDIR/floating-panels.css"

echo "[3/5] Starting Xephyr on $DISPLAY_NUM ..."
Xephyr "$DISPLAY_NUM" -screen "$XEPHYR_SIZE" -title "Cinnamon floating-panel test" >/dev/null 2>&1 &
XEPHYR_PID=$!
sleep 1.5

echo "[4/5] Seeding isolated config + launching nested Cinnamon ..."
export XDG_CONFIG_HOME="$TMP/config"
export XDG_CACHE_HOME="$TMP/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
export GSETTINGS_SCHEMA_DIR="$SCHEMADIR"
export DISPLAY="$DISPLAY_NUM"
# Seed profile, to bisect what works. Pass as $1:
#   edge  - just the stock bottom panel (tests the base Panel changes)
#   float - + one collapsible floating panel, on top
#   full  - + a second, plain floating panel lower down (default)
#   grid / expanding / workspace / hover / floatplain - one panel type each
#   autohide - + a floating panel mid-screen (y=300) that auto-hides
export FP_PROFILE="${1:-full}"

# Seed + launch inside one dbus session so gsettings and cinnamon share dconf.
# The seed is written to a temp script (NOT bash -c '...') because the GVariant
# string literals contain single quotes that would otherwise close the bash -c
# single-quoted argument early.
SEED="$TMP/seed.sh"
cat > "$SEED" <<'SEEDEOF'
set -e
case "${FP_PROFILE:-full}" in
  edge)
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom']"
    gsettings set org.cinnamon panels-extended "[]"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1']"
    ;;
  floatplain)
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":200,\"width\":700,\"height\":40,\"orientation\":\"horizontal\"}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:center:0:calendar@cinnamon.org:31']"
    ;;
  autohide)
    # Floating panel mid-screen (y=300) with auto-hide on: it should slide up to
    # its nearest edge, and return to y=300 (not the screen top) when revealed.
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":300,\"width\":700,\"height\":40,\"orientation\":\"horizontal\"}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:true']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:center:0:calendar@cinnamon.org:31']"
    ;;
  float)
    # bottom EDGE panel (id 1) with a drawer, plus a floating panel (id 2) with a
    # drawer - exercises the drawer behavior on both geometries.
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":1,\"drawer\":true,\"drawerDirection\":\"end\"}', '{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":200,\"width\":700,\"height\":40,\"orientation\":\"horizontal\",\"drawer\":true,\"drawerDirection\":\"end\"}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:center:0:calendar@cinnamon.org:31']"
    ;;
  workspace)
    # floating panel visible only on workspace 1 (index 0). Switch workspaces
    # (Ctrl+Alt+Right / Left in the nested session) to see it appear/disappear.
    # Force 4 static workspaces so there's actually something to switch to.
    gsettings set org.cinnamon.muffin dynamic-workspaces false || true
    gsettings set org.cinnamon.desktop.wm.preferences num-workspaces 4 || true
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":200,\"width\":700,\"height\":40,\"orientation\":\"horizontal\",\"workspaceContextual\":true,\"workspaces\":[0]}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:center:0:calendar@cinnamon.org:31']"
    ;;
  hover)
    # floating panel with drawer + hover-to-expand: starts collapsed to a nub;
    # hover the nub to expand, leave to collapse, click the nub to lock open.
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":200,\"width\":700,\"height\":40,\"orientation\":\"horizontal\",\"drawer\":true,\"drawerDirection\":\"end\",\"hoverExpand\":true}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:center:0:calendar@cinnamon.org:31']"
    ;;
  grid)
    # a 2-ROW grid panel anchored top-center: row0 (menu) left-aligned, row1
    # (calendar) right-aligned. Applets use the row name as their location.
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"grid\",\"monitor\":0,\"anchor\":\"top-center\",\"width\":420,\"height\":84,\"sizing\":\"fixed\",\"rows\":2,\"rowAlignments\":[\"left\",\"right\"]}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:84']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:row0:0:menu@cinnamon.org:31', 'panel2:row1:0:calendar@cinnamon.org:32']"
    ;;
  expanding)
    # id2 = corner L (top-left): horizontal arm (armh) + vertical arm (armv).
    # id3 = a single vertical strip (bottom-left corner, expandAxes "y": only the
    # vertical arm). Hover the junction nub to expand; leave to collapse; click to lock.
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top', '3:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"expanding\",\"monitor\":0,\"anchor\":\"top-left\",\"width\":360,\"height\":280,\"thickness\":44,\"expandAxes\":\"both\"}', '{\"id\":3,\"type\":\"expanding\",\"monitor\":0,\"anchor\":\"bottom-left\",\"width\":44,\"height\":320,\"thickness\":44,\"expandAxes\":\"y\"}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false', '3:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:44', '3:44']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0', '3:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0', '3:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:armh:0:calendar@cinnamon.org:31', 'panel2:armv:0:menu@cinnamon.org:32', 'panel3:armv:0:menu@cinnamon.org:33']"
    ;;
  *)
    gsettings set org.cinnamon panels-enabled  "['1:0:bottom', '2:0:top', '3:0:top']"
    gsettings set org.cinnamon panels-extended "['{\"id\":2,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":200,\"width\":700,\"height\":40,\"orientation\":\"horizontal\",\"drawer\":true,\"drawerDirection\":\"end\"}', '{\"id\":3,\"type\":\"floating\",\"monitor\":0,\"x\":350,\"y\":420,\"width\":520,\"height\":40,\"orientation\":\"horizontal\"}']"
    gsettings set org.cinnamon panels-autohide   "['1:false', '2:false', '3:false']"
    gsettings set org.cinnamon panels-height     "['1:40', '2:40', '3:40']"
    gsettings set org.cinnamon panels-show-delay "['1:0', '2:0', '3:0']"
    gsettings set org.cinnamon panels-hide-delay "['1:0', '2:0', '3:0']"
    gsettings set org.cinnamon enabled-applets "['panel1:left:0:menu@cinnamon.org:0', 'panel1:right:0:systray@cinnamon.org:1', 'panel2:left:0:menu@cinnamon.org:30', 'panel2:center:0:calendar@cinnamon.org:31', 'panel3:center:0:calendar@cinnamon.org:32']"
    ;;
esac
gsettings set org.cinnamon next-applet-id 40

echo "    config seeded (profile=${FP_PROFILE:-full}); starting cinnamon --replace (watch the Xephyr window)"
cinnamon --replace
SEEDEOF
dbus-run-session -- bash "$SEED" &
CINNAMON_PID=$!

echo "[5/5] Running. With the default profile you should see: a bottom EDGE panel; a"
echo "      FLOATING panel near the top (350,200) with a thin handle at its RIGHT end -"
echo "      click it to COLLAPSE the panel to that handle, click again to expand; and a"
echo "      second floating panel lower down. Drag a floating panel by its empty area"
echo "      to move it. Test the SETTINGS UI: open the menu in the nested session >"
echo "      Panel (or run 'cinnamon-settings panel' from a terminal inside this"
echo "      session): 'Add new panel' offers the panel types, and each panel's"
echo "      'Advanced settings' holds its geometry, drawer, hover and workspace options."
echo "      Open Looking Glass (Alt+F2 > lg) for any errors."
echo
echo "      Press Ctrl-C here to stop and restore. Logs follow:"
wait "$CINNAMON_PID"
