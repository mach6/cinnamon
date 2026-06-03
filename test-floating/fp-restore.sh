#!/usr/bin/env bash
# Safety net: restore the stock Cinnamon JS files that fp-nested-test.sh backed up.
# Run this if a test left the system files swapped (e.g. after a hard kill).
set -u
SYS=/usr/share/cinnamon/js/ui
CSMOD=/usr/share/cinnamon/cinnamon-settings/modules
BK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup"

if [ -f "$BK/panel.js" ]; then
    echo "Restoring panel.js ..."
    sudo cp -a "$BK/panel.js" "$SYS/panel.js"
fi

if [ -f "$BK/appletManager.js" ]; then
    echo "Restoring appletManager.js ..."
    sudo cp -a "$BK/appletManager.js" "$SYS/appletManager.js"
fi

if [ -f "$BK/applet.js" ]; then
    echo "Restoring applet.js ..."
    sudo cp -a "$BK/applet.js" "$SYS/applet.js"
fi

if [ -f "$BK/workspace-switcher-applet.js" ]; then
    echo "Restoring workspace-switcher applet.js ..."
    sudo cp -a "$BK/workspace-switcher-applet.js" "/usr/share/cinnamon/applets/workspace-switcher@cinnamon.org/applet.js"
fi

if [ -f "$BK/main.js" ]; then
    echo "Restoring main.js ..."
    sudo cp -a "$BK/main.js" "$SYS/main.js"
fi

if [ -f "$BK/popupMenu.js" ]; then
    echo "Restoring popupMenu.js ..."
    sudo cp -a "$BK/popupMenu.js" "$SYS/popupMenu.js"
fi

if [ -f "$BK/tooltips.js" ]; then
    echo "Restoring tooltips.js ..."
    sudo cp -a "$BK/tooltips.js" "$SYS/tooltips.js"
fi

if [ -f "/usr/share/cinnamon/theme/floating-panels.css" ]; then
    echo "Removing test floating-panels.css ..."
    sudo rm -f "/usr/share/cinnamon/theme/floating-panels.css"
fi

if [ -f "$BK/cs_panel.py" ]; then
    echo "Restoring cs_panel.py ..."
    sudo cp -a "$BK/cs_panel.py" "$CSMOD/cs_panel.py"
fi

if [ -f "$BK/cs_applets.py" ]; then
    echo "Restoring cs_applets.py ..."
    sudo cp -a "$BK/cs_applets.py" "$CSMOD/cs_applets.py"
fi

# The panel-strategy modules are NEW files - the stock system has none, so
# restoring means removing them.
for f in panelGeometry.js panelVisibility.js panelLayout.js; do
    if [ -f "$SYS/$f" ] && [ ! -f "$BK/$f" ]; then
        echo "Removing test file $f ..."
        sudo rm -f "$SYS/$f"
    fi
done

echo "Done. System Cinnamon JS restored to stock."
echo "(Your live session already runs the in-memory stock code; nothing to restart.)"
