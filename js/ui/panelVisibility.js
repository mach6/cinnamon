/**
 * FILE:panelVisibility.js
 * @short_description: Composable visibility behaviors for panels
 *
 * Visibility behaviors control when/how a panel shows and hides. They are
 * composable flags (a panel may have several at once), so rather than a single
 * enum strategy, a panel gets a #VisibilityManager holding zero or more behavior
 * objects built from its panels-extended config:
 *   - drawer: collapse the panel IN PLACE along its long axis down to a peek
 *     handle, anchored at a configurable end. The panel does not move to a
 *     screen edge; it shrinks where it is. Works on any geometry. With the
 *     hoverExpand modifier it opens while hovered (see #HoverExpand).
 *   - workspaceContextual: the panel is only visible on a set of workspaces.
 *
 * Edge panels keep using the upstream autohide machinery in #Panel unchanged;
 * that is not modelled as a behavior here.
 *
 * This module also owns the two pieces an expanding panel (panelGeometry.js)
 * shares with a hover drawer: the #PeekHandle grab nub and the #HoverExpand
 * state machine.
 *
 * NB Cinnamon 6.6's #Panel exposes its actor as panel.actor and its applet zones
 * through the layout strategy's getZones(); behaviors operate on those.
 */
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const Main = imports.ui.main;
const PanelManager = imports.ui.panel;
const SignalManager = imports.misc.signalManager;

const PEEK_HANDLE = 3;          // px thickness of a peek/trigger handle, pre-scale
const HOVER_SHOW_DELAY = 150;   // ms, hoverShowDelay default
const HOVER_HIDE_DELAY = 400;   // ms, hoverHideDelay default

// The panels-extended fields the behaviors are built from. #Panel rebuilds its
// VisibilityManager when any of these change (see configSignature) and leaves it
// alone for transient writes (a dragged position, drawerCollapsed).
const CONFIG_KEYS = ["drawer", "drawerDirection", "hoverExpand", "hoverShowDelay",
                     "hoverHideDelay", "workspaceContextual", "workspaces"];

/**
 * configSignature:
 * @cfg (object): a panel's panels-extended config
 *
 * Returns: (string) a stable string of just the structural visibility config
 */
function configSignature(cfg) {
    let sig = {};
    CONFIG_KEYS.forEach(k => { sig[k] = cfg[k]; });
    return JSON.stringify(sig);
}

function handleSize() {
    return Math.round(PEEK_HANDLE * global.ui_scale);
}

// ============================================================
// VisibilityManager - holds the panel's set of visibility behaviors and
// fans the lifecycle hooks out to each.
// ============================================================
function VisibilityManager(behaviors) {
    this._behaviors = behaviors;
}

VisibilityManager.prototype = {
    attach: function() {
        this._behaviors.forEach(b => b.attach());
    },
    detach: function() {
        this._behaviors.forEach(b => b.detach());
    },
    // Called by Panel._moveResizePanel after the geometry has (re)positioned the
    // panel, so behaviors can re-apply state relative to the fresh home geometry.
    afterGeometry: function() {
        this._behaviors.forEach(b => b.afterGeometry());
    },
    // Whether this panel has a drawer behavior (used by Panel to skip strut reservation).
    hasDrawer: function() {
        return this._behaviors.some(b => b instanceof DrawerBehavior);
    }
};

// ============================================================
// PeekHandle - the small St.Button a collapsed drawer / expanding panel is
// grabbed by. It lives in uiGroup, not under the panel actor (whose allocation
// code it would otherwise fight), so it mirrors the actor's visibility itself
// (e.g. a workspace-contextual panel hidden on another workspace) and is raised
// to the top whenever it is placed. Appearance comes from @styleClass (default
// in theme/floating-panels.css, overridable by the user theme).
// ============================================================
function PeekHandle(panel, styleClass) {
    this.actor = new St.Button({ style_class: styleClass, reactive: true, track_hover: true });
    Main.uiGroup.add_child(this.actor);
    this._signals = new SignalManager.SignalManager(null);
    this._signals.connect(panel.actor, 'notify::visible', () => { this.actor.visible = panel.actor.visible; });
    this.actor.visible = panel.actor.visible;
}

PeekHandle.prototype = {
    place: function(x, y, w, h) {
        this.actor.set_size(w, h);
        this.actor.set_position(x, y);
        Main.uiGroup.set_child_above_sibling(this.actor, null);
    },

    destroy: function() {
        this._signals.disconnectAllSignals();
        this.actor.destroy();
    }
};

// ============================================================
// HoverExpand - the hover-to-expand state machine shared by a hover drawer and
// an expanding panel:
//   closed --(pointer enters the handle, hoverShowDelay)--> open
//   open   --(pointer leaves the panel, hoverHideDelay)--> closed
//   a click on the handle toggles a locked-open state that ignores hover.
// @target supplies isOpen()/open()/close()/pointerOver(). The delays are read
// from the panel's panels-extended config when a timer starts, so a settings
// change applies at once.
// ============================================================
function HoverExpand(panel, target) {
    this._panel = panel;
    this._target = target;
    this._locked = false;
    this._showTimer = 0;
    this._hideTimer = 0;
}

HoverExpand.prototype = {
    _delay: function(field, fallback) {
        let v = PanelManager.getPanelExtended(this._panel.panelId)[field];
        return (v != null) ? v : fallback;
    },

    onEnter: function() {
        if (this._locked)
            return;
        this._cancelHide();
        if (this._target.isOpen() || this._showTimer)
            return;
        this._showTimer = Mainloop.timeout_add(this._delay("hoverShowDelay", HOVER_SHOW_DELAY), () => {
            this._showTimer = 0;
            if (!this._locked && !this._target.isOpen()) {
                this._target.open();
                this._panel.actor.add_style_class_name('panel-hover-expand-active');
            }
            return false;
        });
    },

    // Entering the panel body while open cancels a pending close.
    onPanelEnter: function() {
        this._cancelHide();
    },

    onLeave: function() {
        if (this._locked || !this._target.isOpen())
            return;
        this._cancelShow();
        if (this._hideTimer)
            return;
        this._hideTimer = Mainloop.timeout_add(this._delay("hoverHideDelay", HOVER_HIDE_DELAY), () => {
            this._hideTimer = 0;
            if (!this._locked && this._target.isOpen() && !this._target.pointerOver()) {
                this._target.close();
                this._panel.actor.remove_style_class_name('panel-hover-expand-active');
            }
            return false;
        });
    },

    onClick: function() {
        this.cancel();
        this._locked = !this._locked;
        if (this._locked) {
            if (!this._target.isOpen())
                this._target.open();
            this._panel.actor.add_style_class_name('panel-hover-expand-locked');
        } else {
            this._panel.actor.remove_style_class_name('panel-hover-expand-locked');
            // Resume hover behavior: close now unless the pointer is still on it.
            if (!this._target.pointerOver())
                this._target.close();
        }
    },

    _cancelShow: function() {
        if (this._showTimer) {
            Mainloop.source_remove(this._showTimer);
            this._showTimer = 0;
        }
    },

    _cancelHide: function() {
        if (this._hideTimer) {
            Mainloop.source_remove(this._hideTimer);
            this._hideTimer = 0;
        }
    },

    /** Cancels the pending timers; the owner calls this when it detaches. */
    cancel: function() {
        this._cancelShow();
        this._cancelHide();
    }
};

// ============================================================
// DrawerBehavior - collapse-to-a-peek-handle, in place.
// The panel shrinks along its long axis down to a small handle, anchored at the
// configured end. It does NOT move to a screen edge - it collapses where it
// sits. Collapsed state is persisted in panels-extended ("drawerCollapsed").
// ============================================================
function DrawerBehavior(panel, config) {
    this._panel = panel;
    // Collapse direction. "start"/"end" follow the panel's own orientation;
    // "left"/"right"/"top"/"bottom" name an explicit edge, so a grid panel can
    // have a top or bottom drawer regardless of its orientation. When unset, the
    // geometry picks a sensible default (an edge panel collapses toward its
    // docked edge).
    this._direction = config.drawerDirection || panel._geometry.getDefaultDrawerDirection();

    // Hover-to-expand modifier: collapsed by default, opens when the pointer
    // enters the handle and re-collapses when it leaves the panel; click locks.
    this._hoverExpand = !!config.hoverExpand;
    this.collapsed = (config.drawerCollapsed !== undefined) ? !!config.drawerCollapsed : this._hoverExpand;

    this._home = null;          // expanded geometry { x, y, w, h }
    this._handle = null;
    this._hover = null;
    this._signals = new SignalManager.SignalManager(null);
}

DrawerBehavior.prototype = {
    attach: function() {
        let panel = this._panel;
        panel.actor.add_style_class_name('panel-drawer');
        this._handle = new PeekHandle(panel, 'panel-drawer-handle');
        this._handle.actor.connect('clicked', () => this._onHandleClicked());
        // Keep the handle glued to the panel actor as it moves/resizes (e.g. when
        // a floating panel is dragged), not just on collapse/expand/geometry.
        this._signals.connect(panel.actor, 'notify::allocation', () => this._positionHandle());

        if (this._hoverExpand) {
            this._hover = new HoverExpand(panel, {
                isOpen: () => !this.collapsed,
                open: () => this.expand(),
                close: () => this.collapse(),
                pointerOver: () => this._pointerOverPanel()
            });
            this._handle.actor.connect('enter-event', () => { this._hover.onEnter(); return false; });
            // Leaving the handle counts as leaving too, so moving off the nub
            // collapses even when the pointer never touched the panel body.
            this._handle.actor.connect('leave-event', () => { this._hover.onLeave(); return false; });
            this._signals.connect(panel.actor, 'enter-event', () => { this._hover.onPanelEnter(); return false; });
            this._signals.connect(panel.actor, 'leave-event', () => { this._hover.onLeave(); return false; });
        }
        // Home geometry + initial collapsed state are applied in afterGeometry,
        // which runs right after the panel's first _moveResizePanel positions it.
    },

    detach: function() {
        if (this._hover)
            this._hover.cancel();
        this._signals.disconnectAllSignals();
        this._handle.destroy();
        this._handle = null;
        // Restore the panel to its expanded geometry so removing the drawer
        // doesn't leave it stuck collapsed.
        if (this.collapsed && this._home)
            this._applyExpanded();
        let actor = this._panel.actor;
        actor.remove_style_class_name('panel-drawer');
        actor.remove_style_class_name('panel-drawer-collapsed');
        actor.remove_style_class_name('panel-drawer-expanded');
    },

    afterGeometry: function() {
        // The geometry just placed the panel at its expanded home geometry.
        let a = this._panel.actor;
        this._home = { x: a.x, y: a.y, w: a.get_width(), h: a.get_height() };
        this._setStateClass();
        if (this.collapsed)
            this._applyCollapsed();
        this._positionHandle();
    },

    // A collapsed drawer hides the panel's actual content zones (grid rows,
    // expanding arms, or the standard boxes), as the layout defines them.
    _hideZones: function() {
        this._panel._layout.getZones().forEach(z => z.hide());
    },

    _showZones: function() {
        this._panel._layout.getZones().forEach(z => z.show());
    },

    // Resolve the collapse direction into an axis (vertical?) and which edge the
    // collapsed nub sits at (end = far edge). "start"/"end" follow the panel's
    // orientation; "left"/"right"/"top"/"bottom" are explicit.
    _resolveDrawer: function() {
        switch (this._direction) {
            case "left":   return { vertical: false, end: false };
            case "right":  return { vertical: false, end: true  };
            case "top":    return { vertical: true,  end: false };
            case "bottom": return { vertical: true,  end: true  };
            case "start":  return { vertical: this._panel.is_vertical, end: false };
            case "end":
            default:       return { vertical: this._panel.is_vertical, end: true  };
        }
    },

    // The nub rect: @base shrunk along the collapse axis to the handle thickness,
    // anchored at the end the drawer collapses toward. This is both the collapsed
    // panel geometry (base = home) and the handle's rect (base = the actor).
    _nubRect: function(base) {
        let H = handleSize();
        let d = this._resolveDrawer();
        let r = { x: base.x, y: base.y, w: base.w, h: base.h };
        if (d.vertical) {
            r.h = H;
            if (d.end) r.y = base.y + base.h - H;   // collapse toward the bottom edge
        } else {
            r.w = H;
            if (d.end) r.x = base.x + base.w - H;   // collapse toward the right edge
        }
        return r;
    },

    _applyCollapsed: function() {
        let a = this._panel.actor;
        let c = this._nubRect(this._home);
        this._hideZones();
        a.set_size(c.w, c.h);
        a.set_position(c.x, c.y);
        this._positionHandle();
    },

    _applyExpanded: function() {
        let a = this._panel.actor;
        this._showZones();
        a.set_size(this._home.w, this._home.h);
        a.set_position(this._home.x, this._home.y);
        this._positionHandle();
    },

    // The handle covers the nub: the whole actor when collapsed, else the strip
    // the actor will shrink to. Derived from the actor's live rect (not _home) so
    // it follows a floating panel mid-drag.
    _positionHandle: function() {
        if (!this._handle)
            return;
        let a = this._panel.actor;
        let r = this._nubRect({ x: a.x, y: a.y, w: a.get_width(), h: a.get_height() });
        this._handle.place(r.x, r.y, r.w, r.h);
    },

    _setStateClass: function() {
        let actor = this._panel.actor;
        if (this.collapsed) {
            actor.add_style_class_name('panel-drawer-collapsed');
            actor.remove_style_class_name('panel-drawer-expanded');
        } else {
            actor.add_style_class_name('panel-drawer-expanded');
            actor.remove_style_class_name('panel-drawer-collapsed');
        }
    },

    toggle: function() {
        if (this.collapsed)
            this.expand();
        else
            this.collapse();
    },

    collapse: function() {
        if (this.collapsed)
            return;
        let a = this._panel.actor;
        this._home = { x: a.x, y: a.y, w: a.get_width(), h: a.get_height() };
        this.collapsed = true;
        this._setStateClass();
        this._applyCollapsed();
        PanelManager.updatePanelExtended(this._panel.panelId, { drawerCollapsed: true });
    },

    expand: function() {
        if (!this.collapsed)
            return;
        this.collapsed = false;
        this._setStateClass();
        this._applyExpanded();
        PanelManager.updatePanelExtended(this._panel.panelId, { drawerCollapsed: false });
    },

    _onHandleClicked: function() {
        // Plain drawer: click toggles collapse/expand. Hover drawer: click
        // toggles the locked-open state.
        if (this._hover)
            this._hover.onClick();
        else
            this.toggle();
    },

    _pointerOverPanel: function() {
        let a = this._panel.actor;
        let [px, py] = global.get_pointer();
        return px >= a.x && px <= a.x + a.get_width() &&
               py >= a.y && py <= a.y + a.get_height();
    }
};

// ============================================================
// WorkspaceContextualBehavior - the panel is only visible on a configured set of
// workspaces (by index). On other workspaces the whole panel actor is hidden.
// Composable with other behaviors (e.g. autohide, drawer). An empty workspace
// list means "all workspaces" (a safe no-op rather than a panel that never shows).
// ============================================================
function WorkspaceContextualBehavior(panel, config) {
    this._panel = panel;
    this._workspaces = Array.isArray(config.workspaces)
        ? config.workspaces.map(n => parseInt(n)).filter(n => !isNaN(n))
        : [];
    this._signals = new SignalManager.SignalManager(null);
}

WorkspaceContextualBehavior.prototype = {
    attach: function() {
        // The same signal Cinnamon's own window manager reacts to.
        this._signals.connect(global.workspace_manager, 'workspace-switched', () => this._update());
        this._update();
    },

    detach: function() {
        this._signals.disconnectAllSignals();
        this._panel.actor.show();
        this._panel.actor.remove_style_class_name('panel-workspace-hidden');
    },

    afterGeometry: function() {
        this._update();
    },

    _update: function() {
        let actor = this._panel.actor;
        let idx = global.workspace_manager.get_active_workspace_index();
        // Empty list => no restriction (visible everywhere). Otherwise visible
        // only when the active workspace is in the configured set.
        let visible = (this._workspaces.length === 0) ||
                      this._workspaces.indexOf(idx) !== -1;
        if (visible) {
            actor.show();
            actor.remove_style_class_name('panel-workspace-hidden');
        } else {
            actor.hide();
            actor.add_style_class_name('panel-workspace-hidden');
        }
    }
};

/**
 * createVisibility:
 * @panel: the #Panel instance
 * @config (object): the panel's panels-extended config object
 *
 * Builds the panel's visibility manager from its (composable) config flags:
 *   - "drawer": true                  -> DrawerBehavior (+ "drawerDirection",
 *                                        "hoverExpand", "hoverShowDelay", "hoverHideDelay")
 *   - "workspaceContextual": true     -> WorkspaceContextualBehavior (+ "workspaces": [int,...])
 *
 * Returns: a #VisibilityManager
 */
function createVisibility(panel, config) {
    let behaviors = [];
    if (config.drawer)
        behaviors.push(new DrawerBehavior(panel, config));
    if (config.workspaceContextual)
        behaviors.push(new WorkspaceContextualBehavior(panel, config));
    return new VisibilityManager(behaviors);
}
