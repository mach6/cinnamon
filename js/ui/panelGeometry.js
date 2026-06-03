/**
 * FILE:panelGeometry.js
 * @short_description: Geometry strategies for panels (where/how big a panel is)
 *
 * A geometry strategy owns a panel's position, size, struts/barriers and clip
 * region - everything that differs between an edge-docked panel, a free-floating
 * panel, a grid panel and an expanding panel. It is attached to a #Panel instance
 * during construction (see panel.js Panel._init) so that adding a new panel type
 * is configuration, not a new Panel subclass.
 *
 * #Panel routes its geometry entry points through the attached strategy via stable
 * dispatcher methods (_moveResizePanel, _updatePanelBarriers, _setClipRegion,
 * _onButtonPressEvent). The default strategy, #EdgeGeometry, delegates straight to
 * the panel's preserved upstream implementations (the *_edge methods), so edge
 * panels behave bit-identically to upstream.
 *
 * The anchor and expanding-panel dimension helpers here are the single source of
 * truth for the layout strategies too (panelLayout.js imports them), so the two
 * can never disagree about where a panel's arms or rows sit.
 *
 * NB Cinnamon 6.6's #Panel is a prototype-style object whose visible actor is a
 * separate object, this.actor; strategies operate on panel.actor.
 */
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;

const Main = imports.ui.main;
const AppletManager = imports.ui.appletManager;
// Loaded lazily from Panel._init at runtime, after panel.js has finished
// evaluating, so importing the panel module here is not a cycle.
const PanelManager = imports.ui.panel;
const PanelLoc = PanelManager.PanelLoc;
const PanelVisibility = imports.ui.panelVisibility;
const SignalManager = imports.misc.signalManager;

const FREE_MIN_DIM = 24;        // smallest side of a floating / grid panel
const FLOAT_DEFAULT_WIDTH = 480;
const FLOAT_DEFAULT_HEIGHT = 40;
const GRID_DEFAULT_WIDTH = 300;
const GRID_DEFAULT_HEIGHT = 80;
const EXP_DEFAULT_WIDTH = 320;
const EXP_DEFAULT_HEIGHT = 200;
const EXP_DEFAULT_THICKNESS = 40;
const EXP_MIN_THICKNESS = 8;
const EXP_ANIM = 250;           // ms arm scale animation

// ============================================================
// Anchor helpers (shared with panelLayout.js)
// ============================================================

/**
 * anchorRowCol:
 * @anchor (string): one of the nine anchor names ("top-left" ... "bottom-right",
 * "center", "middle-left" etc.)
 *
 * Returns: [rowKey, colKey] - "top"/"middle"/"bottom" and "left"/"center"/"right".
 * Unknown names map to the top-left corner.
 */
function anchorRowCol(anchor) {
    switch (anchor) {
        case "top-left":      return ["top", "left"];
        case "top-center":    return ["top", "center"];
        case "top-right":     return ["top", "right"];
        case "middle-left":   return ["middle", "left"];
        case "center":        return ["middle", "center"];
        case "middle-right":  return ["middle", "right"];
        case "bottom-left":   return ["bottom", "left"];
        case "bottom-center": return ["bottom", "center"];
        case "bottom-right":  return ["bottom", "right"];
        default:              return ["top", "left"];
    }
}

/**
 * anchorXY:
 *
 * Returns: [x, y] placing a @w x @h box at @anchor within monitor rect @m.
 */
function anchorXY(anchor, w, h, m) {
    let [row, col] = anchorRowCol(anchor);
    let x = (col === "left")  ? m.x
          : (col === "right") ? (m.x + m.width - w)
          :                     (m.x + Math.round((m.width - w) / 2));
    let y = (row === "top")    ? m.y
          : (row === "bottom") ? (m.y + m.height - h)
          :                      (m.y + Math.round((m.height - h) / 2));
    return [x, y];
}

/**
 * expandAnchor:
 * @cfg (object): an expanding panel's panels-extended config
 *
 * Expanding panels are corner-anchored only (both arms meet at the corner,
 * forming an L); any other anchor is coerced to the nearest top/bottom corner.
 *
 * Returns: { name, top, bottom, left, right } - the corner name and the booleans
 * the geometry and layout use to place the arms, junction and handle.
 */
function expandAnchor(cfg) {
    let a = cfg.anchor || "top-left";
    let bottom = a.indexOf("bottom") !== -1;
    let right = a.indexOf("right") !== -1;
    return {
        name: (bottom ? "bottom" : "top") + "-" + (right ? "right" : "left"),
        top: !bottom, bottom: bottom, left: !right, right: right
    };
}

/**
 * expandDims:
 * @cfg (object): an expanding panel's panels-extended config
 *
 * Bounding-box dimensions of an expanding panel: expandAxes "x" reduces it to a
 * single horizontal strip (a row), "y" to a single vertical strip (a column),
 * "both" is the full L bounding box.
 *
 * Returns: { W, H, T, axes } - width, height, arm thickness and the axes string
 */
function expandDims(cfg) {
    let T = Math.max(EXP_MIN_THICKNESS, Math.round(cfg.thickness || EXP_DEFAULT_THICKNESS));
    let axes = cfg.expandAxes || "both";
    let W = Math.max(T, Math.round(cfg.width || EXP_DEFAULT_WIDTH));
    let H = Math.max(T, Math.round(cfg.height || EXP_DEFAULT_HEIGHT));
    if (axes === "x") H = T;
    if (axes === "y") W = T;
    return { W: W, H: H, T: T, axes: axes };
}

/**
 * menuAnchorBox:
 *
 * The shape returned by a geometry's getMenuAnchorBox() to tell popupMenu where to
 * place an applet's menu (all coords are absolute stage px):
 *   anchor - the box whose outer edge the menu hugs on the open axis (the panel for
 *            a floating/grid panel, the specific L-arm for an expanding panel).
 *   bounds - the rectangle the menu is confined to on the cross axis, or null for
 *            "the whole monitor". For an expanding L this is the free-space region
 *            between the two arms, so a menu off the horizontal arm doesn't spill
 *            across the vertical arm (and vice-versa).
 * @actor: the actor whose transformed allocation to use for @anchor.
 * @bounds: the cross-axis bounds box, or null.
 */
function menuAnchorBox(actor, bounds) {
    return { anchor: Cinnamon.util_get_transformed_allocation(actor), bounds: bounds || null };
}

/**
 * resolvePanelSize:
 *
 * Shared by the free-form geometries (floating, grid) to turn the configured
 * "sizing" mode into a concrete [w, h] (rounded, floored at FREE_MIN_DIM):
 *   "fixed" (default)      - the configured width/height.
 *   "fit-content"          - the actor's natural size (shrink-wrap to its applets).
 *   "fit-content-with-max" - natural size, capped at the configured width/height.
 *
 * To measure the natural size we must FIRST clear any fixed size a previous pass
 * pinned with set_size(): once set, Clutter's get_preferred_*() returns that
 * forced value, so without the reset "fit-content" would just re-report the old
 * size and appear to do nothing.
 */
function resolvePanelSize(panel, cfg, defaultW, defaultH) {
    let sizing = cfg.sizing || "fixed";
    let w, h;
    if (sizing === "fit-content" || sizing === "fit-content-with-max") {
        panel.actor.set_size(-1, -1);
        let [, natW] = panel.actor.get_preferred_width(-1);
        let [, natH] = panel.actor.get_preferred_height(-1);
        w = natW || defaultW;
        h = natH || defaultH;
        if (sizing === "fit-content-with-max") {
            if (cfg.width)  w = Math.min(w, cfg.width);
            if (cfg.height) h = Math.min(h, cfg.height);
        }
    } else {
        w = cfg.width || defaultW;
        h = cfg.height || defaultH;
    }
    return [Math.max(FREE_MIN_DIM, Math.round(w)), Math.max(FREE_MIN_DIM, Math.round(h))];
}

// ============================================================
// EdgeGeometry - the default, upstream edge-docked behavior.
// Holds no state and forwards every hook to the Panel's preserved
// implementation, so edge panels are bit-identical to upstream.
// ============================================================
function EdgeGeometry(panel) {
    this._panel = panel;
}

EdgeGeometry.prototype = {
    attach: function() {},
    detach: function() {},

    moveResize: function() { return this._panel._moveResizePanel_edge(); },
    updateBarriers: function() { return this._panel._updatePanelBarriers_edge(); },
    setClipRegion: function(hidden, offset) { return this._panel._setClipRegion_edge(hidden, offset); },
    onButtonPress: function(actor, event) { return this._panel._onButtonPressEvent_edge(actor, event); },

    /** Edge panels span a screen edge and reserve that strip (see Panel.occupiesEdge). */
    occupiesEdge: function() { return true; },

    supportsAutoHide: function() { return true; },

    /**
     * The auto-hide rectangles, exactly as upstream computes them: the panel
     * docked to its monitor edge when shown, slid out leaving a 1px strip when
     * hidden. Only the axis the panel slides along is derived from the monitor;
     * the other keeps the actor's own value.
     */
    getShownRect: function() {
        let panel = this._panel, a = panel.actor, m = panel.monitor;
        let rect = { x: a.x, y: a.y, width: a.width, height: a.height };
        switch (panel.panelPosition) {
            case PanelLoc.top:    rect.y = m.y; break;
            case PanelLoc.bottom: rect.y = m.y + m.height - a.height; break;
            case PanelLoc.left:   rect.x = m.x; break;
            case PanelLoc.right:  rect.x = m.x + m.width - a.width; break;
            default:
                global.log("updatePanelVisibility - unrecognised panel position " + panel.panelPosition);
        }
        return rect;
    },

    getHiddenRect: function() {
        let panel = this._panel, a = panel.actor, m = panel.monitor;
        let rect = { x: a.x, y: a.y, width: a.width, height: a.height };
        switch (panel.panelPosition) {
            case PanelLoc.top:    rect.y = m.y - a.get_height() + 1; break;
            case PanelLoc.bottom: rect.y = m.y + m.height - 1; break;
            case PanelLoc.left:   rect.x = m.x - a.get_width() + 1; break;
            case PanelLoc.right:  rect.x = m.x + m.width - 1; break;
        }
        return rect;
    },

    /** Intelligent auto-hide hides when a window overlaps this rectangle. */
    getOverlapRect: function() { return this.getShownRect(); },

    /** Edge panels keep upstream menu positioning (anchored to the screen edge). */
    getMenuAnchorBox: function(sourceActor) { return null; },

    /** A drawer on an edge panel collapses toward the edge it's docked to. */
    getDefaultDrawerDirection: function() {
        switch (this._panel.panelPosition) {
            case PanelLoc.top:    return "top";
            case PanelLoc.bottom: return "bottom";
            case PanelLoc.left:   return "left";
            case PanelLoc.right:  return "right";
        }
        return "end";
    }
};

// ============================================================
// FreeGeometryHooks - the hooks shared by the free-form geometries (floating,
// grid, expanding). They sit inside the monitor rather than on an edge: no
// struts, no pressure barriers, no edge clip, and a click on the panel body
// opens the context menu as upstream does. Each geometry mixes these into its
// prototype and overrides what differs.
// ============================================================
const FreeGeometryHooks = {
    attach: function() {
        this._panel.actor.add_style_class_name(this._styleClass);
    },

    detach: function() {
        this._panel.actor.remove_style_class_name(this._styleClass);
    },

    _cfg: function() {
        return PanelManager.getPanelExtended(this._panel.panelId);
    },

    updateBarriers: function() {
        this._panel._clearPanelBarriers();
    },

    setClipRegion: function(hidden, offset) {
        this._panel.actor.remove_clip();
    },

    occupiesEdge: function() {
        return false;
    },

    /** Auto-hide slides a panel along a monitor edge; only geometries that can do that opt in. */
    supportsAutoHide: function() {
        return false;
    },

    onButtonPress: function(actor, event) {
        return this._panel._onButtonPressEvent_edge(actor, event);
    },

    /** No docked edge to collapse toward: a drawer collapses to the panel's far end. */
    getDefaultDrawerDirection: function() {
        return "end";
    },

    /** Common tail of moveResize: place the actor and refresh what depends on it. */
    _place: function(x, y) {
        let panel = this._panel;
        panel.actor.remove_all_transitions();
        panel.actor.set_position(x, y);
        panel._clearPanelBarriers();
        panel._updatePanelVisibility();
        if (AppletManager.appletsLoaded)
            panel._setPanelHeight();
    }
};

/**
 * floatingRect:
 * @cfg (object): a floating panel's panels-extended config
 * @w, @h (number): the panel's resolved size
 * @m: the monitor rectangle
 *
 * Returns: the panel's configured monitor-relative position, clamped so the
 * panel stays on the monitor, as a { x, y, width, height } rectangle.
 */
function floatingRect(cfg, w, h, m) {
    return {
        x: (m.x + (cfg.x || 0)).clamp(m.x, m.x + m.width - w),
        y: (m.y + (cfg.y || 0)).clamp(m.y, m.y + m.height - h),
        width: w, height: h
    };
}

// ============================================================
// FloatingGeometry - free x/y position, fixed size, draggable. Stays in the
// chrome layer (above windows); it gets out of the way via the autohide
// visibility behavior, not by reparenting.
// ============================================================
function FloatingGeometry(panel) {
    this._panel = panel;
    this._styleClass = 'panel-floating';
    this._dragging = false;
    this._dragDX = 0;
    this._dragDY = 0;
    this._dragSignals = new SignalManager.SignalManager(null);
}

FloatingGeometry.prototype = Object.assign({}, FreeGeometryHooks, {
    detach: function() {
        this._dragSignals.disconnectAllSignals();
        FreeGeometryHooks.detach.call(this);
    },

    /**
     * Size and position the panel from its monitor-relative config instead of
     * stretching it to a monitor edge. panelPosition is (ab)used as an orientation
     * flag (top => horizontal, left => vertical) so inherited zone-sizing and the
     * auto-hide policy keep working. Reserves no struts and clears edge barriers.
     */
    moveResize: function() {
        let panel = this._panel;
        if (panel._destroyed)
            return false;
        if (this._dragging)
            return false;

        panel.monitor = global.display.get_monitor_geometry(panel.monitorIndex);

        let cfg = this._cfg();
        let vertical = cfg.orientation === "vertical";
        panel.is_vertical = vertical;

        // Sizing (fixed / fit-content / fit-content-with-max). See resolvePanelSize.
        let [w, h] = resolvePanelSize(panel, cfg, FLOAT_DEFAULT_WIDTH, FLOAT_DEFAULT_HEIGHT);
        panel.actor.set_size(w, h);

        let m = panel.monitor;
        let { x: gx, y: gy } = floatingRect(cfg, w, h, m);

        // Orient applets - and therefore the direction their menus open - toward the
        // free space, by treating the panel as the edge panel of the monitor half it
        // sits in: bottom half => behaves like a bottom panel (menus open upward),
        // right half => like a right panel, etc. (panelPosition top/bottom both mean a
        // horizontal panel, so this doesn't change the layout, only the menu side.)
        let pos = vertical
            ? ((gx + w / 2 > m.x + m.width / 2)  ? PanelLoc.right  : PanelLoc.left)
            : ((gy + h / 2 > m.y + m.height / 2) ? PanelLoc.bottom : PanelLoc.top);
        let posChanged = (panel.panelPosition !== pos);
        panel.panelPosition = pos;
        panel.addPanelStyleClass(pos);
        if (vertical)
            panel._set_vertical_panel_style();
        else
            panel._set_horizontal_panel_style();

        // An auto-hidden panel stays out at its monitor edge (see getHiddenRect).
        let home = (panel._hidden && panel.isHideable()) ? this.getHiddenRect() : { x: gx, y: gy };
        this._place(home.x, home.y);
        this.setClipRegion();
        // If the panel crossed the monitor's midline (e.g. dragged from top to
        // bottom), re-orient its applets so their menus follow.
        if (posChanged && AppletManager.appletsLoaded)
            AppletManager.updateAppletsOnPanel(panel);
        return true;
    },

    // -- Auto-hide ---------------------------------------------------------

    /** A drawer already collapses the panel, so the two don't combine. */
    supportsAutoHide: function() {
        return !this._panel._visibility.hasDrawer();
    },

    /** The panel at its own configured position, never docked to a monitor edge. */
    getShownRect: function() {
        let a = this._panel.actor;
        return floatingRect(this._cfg(), a.get_width(), a.get_height(), this._panel.monitor);
    },

    /**
     * Slid out toward the nearest monitor edge (the one panelPosition names),
     * keeping its place along that edge and leaving a 1px strip on screen.
     */
    getHiddenRect: function() {
        let panel = this._panel, m = panel.monitor;
        let rect = this.getShownRect();
        switch (panel.panelPosition) {
            case PanelLoc.top:    rect.y = m.y - rect.height + 1; break;
            case PanelLoc.bottom: rect.y = m.y + m.height - 1; break;
            case PanelLoc.left:   rect.x = m.x - rect.width + 1; break;
            case PanelLoc.right:  rect.x = m.x + m.width - 1; break;
        }
        return rect;
    },

    getOverlapRect: function() {
        return this.getShownRect();
    },

    /**
     * Unlike an edge panel, a floating panel slides along the inside of the
     * monitor, so on a multi-monitor layout it would show through on the
     * neighbouring monitor. Clip it to the monitor while any of it is outside;
     * leave it unclipped (shadow intact) when fully inside.
     */
    setClipRegion: function(hidden, offset) {
        let a = this._panel.actor, m = this._panel.monitor;
        let x1 = Math.max(0, m.x - a.x), y1 = Math.max(0, m.y - a.y);
        let x2 = Math.min(a.width, m.x + m.width - a.x), y2 = Math.min(a.height, m.y + m.height - a.y);
        if (x1 === 0 && y1 === 0 && x2 === a.width && y2 === a.height)
            a.remove_clip();
        else
            a.set_clip(x1, y1, x2 - x1, y2 - y1);
    },

    /**
     * Anchor applet menus to the panel box so they open just off the floating
     * panel (above it in the lower monitor half, below in the upper half; left/
     * right for a vertical panel) instead of jumping to a screen edge. The menu is
     * free to span the whole monitor on the cross axis (bounds null).
     */
    getMenuAnchorBox: function(sourceActor) {
        return menuAnchorBox(this._panel.actor, null);
    },

    // -- Drag to move ------------------------------------------------------

    onButtonPress: function(actor, event) {
        let panel = this._panel;
        if (event.get_button() === 1) {
            let source = event.get_source();
            // Start a move only on the panel body or an empty zone - never on an
            // applet, which must receive the click.
            if (source === panel.actor ||
                source === panel._leftBox ||
                source === panel._centerBox ||
                source === panel._rightBox) {
                this._startDrag();
                return Clutter.EVENT_STOP;
            }
        }
        return panel._onButtonPressEvent_edge(actor, event);
    },

    _startDrag: function() {
        if (this._dragging)
            return;
        let panel = this._panel;
        let [px, py] = global.get_pointer();
        this._dragging = true;
        this._dragDX = px - panel.actor.x;
        this._dragDY = py - panel.actor.y;
        // Listen on the stage so we keep getting events if the pointer briefly
        // outruns the panel actor during a fast drag.
        this._dragSignals.connect(global.stage, 'motion-event', () => this._onDragMotion());
        this._dragSignals.connect(global.stage, 'button-release-event', () => this._onDragRelease());
    },

    _onDragMotion: function() {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        let panel = this._panel;
        let [px, py] = global.get_pointer();
        let w = panel.actor.get_width();
        let h = panel.actor.get_height();
        let m = panel.monitor;
        let nx = Math.round(px - this._dragDX).clamp(m.x, m.x + m.width - w);
        let ny = Math.round(py - this._dragDY).clamp(m.y, m.y + m.height - h);
        panel.actor.set_position(nx, ny);
        return Clutter.EVENT_STOP;
    },

    _onDragRelease: function() {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        this._dragging = false;
        this._dragSignals.disconnectAllSignals();
        let panel = this._panel;
        PanelManager.updatePanelExtended(panel.panelId, {
            x: Math.round(panel.actor.x - panel.monitor.x),
            y: Math.round(panel.actor.y - panel.monitor.y)
        });
        return Clutter.EVENT_STOP;
    }
});

// ============================================================
// GridGeometry - the panel is anchored at one of the eight edge/corner points of
// its monitor at a fixed or content-fitted size. Not draggable. The multi-row
// content arrangement is the job of the grid LAYOUT strategy (panelLayout.js);
// this only owns position/size.
// ============================================================
function GridGeometry(panel) {
    this._panel = panel;
    this._styleClass = 'panel-grid';
}

GridGeometry.prototype = Object.assign({}, FreeGeometryHooks, {
    moveResize: function() {
        let panel = this._panel;
        if (panel._destroyed)
            return false;

        panel.monitor = global.display.get_monitor_geometry(panel.monitorIndex);

        let cfg = this._cfg();
        let m = panel.monitor;

        // A grid panel anchored at the true screen centre isn't a valid position
        // (it would float mid-screen); coerce it to a corner.
        let anchor = cfg.anchor || "top-left";
        if (anchor === "center") anchor = "top-right";

        // Grid rows are always horizontal, but the panel still has a top/bottom
        // identity (where it's anchored) so its applet menus open toward the screen
        // interior - a bottom-anchored grid behaves like a bottom panel (menus up).
        panel.panelPosition = (anchorRowCol(anchor)[0] === "bottom") ? PanelLoc.bottom : PanelLoc.top;
        panel.is_vertical = false;
        panel.addPanelStyleClass(panel.panelPosition);
        panel._set_horizontal_panel_style();

        // Sizing (fixed / fit-content / fit-content-with-max). See resolvePanelSize.
        let [w, h] = resolvePanelSize(panel, cfg, GRID_DEFAULT_WIDTH, GRID_DEFAULT_HEIGHT);
        // Never exceed the monitor.
        w = Math.min(w, m.width);
        h = Math.min(h, m.height);
        panel.actor.set_size(w, h);

        let [x, y] = anchorXY(anchor, w, h, m);
        this._place(x, y);
        return true;
    },

    /**
     * Anchor applet menus to the whole grid box, so a menu opens past the panel's
     * outer-most row rather than from the applet's own inner row, which would
     * overlap the other rows.
     */
    getMenuAnchorBox: function(sourceActor) {
        return menuAnchorBox(this._panel.actor, null);
    }
});

// ============================================================
// ExpandingGeometry - anchored at one of the four monitor corners; the arms
// (laid out by ExpandLayout) collapse toward the corner and expand away from it
// with a pivot-based scale animation. Expand axes (x/y/both) control which arms
// exist. Hover the junction handle to expand, leave to collapse, click to lock
// open (see PanelVisibility.HoverExpand). Clamps to the monitor.
// ============================================================
function ExpandingGeometry(panel) {
    this._panel = panel;
    this._styleClass = 'panel-expanding';
    this._expanded = false;     // starts collapsed
    this._handle = null;
    this._hover = null;
    this._signals = new SignalManager.SignalManager(null);
}

ExpandingGeometry.prototype = Object.assign({}, FreeGeometryHooks, {
    attach: function() {
        FreeGeometryHooks.attach.call(this);
        let panel = this._panel;
        this._handle = new PanelVisibility.PeekHandle(panel, 'panel-expanding-handle');
        this._hover = new PanelVisibility.HoverExpand(panel, {
            isOpen: () => this._expanded,
            open: () => this.expand(),
            close: () => this.collapse(),
            pointerOver: () => this._pointerOverArms()
        });
        this._handle.actor.connect('clicked', () => this._hover.onClick());
        this._handle.actor.connect('enter-event', () => { this._hover.onEnter(); return false; });
        this._handle.actor.connect('leave-event', () => { this._hover.onLeave(); return false; });
        this._signals.connect(panel.actor, 'enter-event', () => { this._hover.onPanelEnter(); return false; });
        this._signals.connect(panel.actor, 'leave-event', () => { this._hover.onLeave(); return false; });
    },

    detach: function() {
        this._hover.cancel();
        this._signals.disconnectAllSignals();
        this._handle.destroy();
        this._handle = null;
        FreeGeometryHooks.detach.call(this);
    },

    _axes: function() {
        let a = this._cfg().expandAxes || "both";
        return { x: (a === "both" || a === "x"), y: (a === "both" || a === "y") };
    },

    moveResize: function() {
        let panel = this._panel;
        if (panel._destroyed)
            return false;

        panel.monitor = global.display.get_monitor_geometry(panel.monitorIndex);
        panel.panelPosition = PanelLoc.top;
        panel.is_vertical = false;
        panel._set_horizontal_panel_style();

        let cfg = this._cfg();
        let m = panel.monitor;
        let d = expandDims(cfg);
        let w = Math.min(d.W, m.width);
        let h = Math.min(d.H, m.height);
        panel.actor.set_size(w, h);

        let [x, y] = anchorXY(expandAnchor(cfg).name, w, h, m);
        this._place(x, y);

        // Apply current expand/collapse state to the arms (no animation).
        this._applyScale(false);
        return true;
    },

    // Collapse/expand the ARMS (a multi-dimensional drawer): the horizontal arm
    // scales along X toward the junction, the vertical arm along Y. Arms not
    // selected by expandAxes are hidden. The actor itself is not scaled.
    _applyScale: function(animate) {
        let panel = this._panel;
        let axes = this._axes();
        let armh = panel._armhBox;
        let armv = panel._armvBox;
        let s = this._expanded ? 1 : 0.001;

        if (armh) {
            if (axes.x) {
                armh.show();
                armh.remove_all_transitions();
                if (animate) armh.ease({ scale_x: s, scale_y: 1, duration: EXP_ANIM, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                else armh.set_scale(s, 1);
            } else {
                armh.hide();
            }
        }
        if (armv) {
            if (axes.y) {
                armv.show();
                armv.remove_all_transitions();
                if (animate) armv.ease({ scale_x: 1, scale_y: s, duration: EXP_ANIM, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                else armv.set_scale(1, s);
            } else {
                armv.hide();
            }
        }

        if (this._expanded) {
            panel.actor.add_style_class_name('panel-expanding-expanded');
            panel.actor.remove_style_class_name('panel-expanding-collapsed');
        } else {
            panel.actor.add_style_class_name('panel-expanding-collapsed');
            panel.actor.remove_style_class_name('panel-expanding-expanded');
        }
        this._positionHandle();
    },

    // The trigger handle sits at the junction: the anchored corner.
    _positionHandle: function() {
        if (!this._handle)
            return;
        let a = this._panel.actor;
        let anchor = expandAnchor(this._cfg());
        let H = PanelVisibility.handleSize();
        let jx = anchor.right  ? (a.get_width() - H)  : 0;
        let jy = anchor.bottom ? (a.get_height() - H) : 0;
        this._handle.place(a.x + jx, a.y + jy, H, H);
    },

    expand: function() {
        if (this._expanded)
            return;
        this._expanded = true;
        this._applyScale(true);
    },

    collapse: function() {
        if (!this._expanded)
            return;
        this._expanded = false;
        this._applyScale(true);
    },

    // Over either arm (not the empty inner area of the L's bounding box).
    _pointerOverArms: function() {
        let [px, py] = global.get_pointer();
        let inArm = (arm) => {
            if (!arm || !arm.visible) return false;
            let [ax, ay] = arm.get_transformed_position();
            return px >= ax && px <= ax + arm.get_width() &&
                   py >= ay && py <= ay + arm.get_height();
        };
        return inArm(this._panel._armhBox) || inArm(this._panel._armvBox);
    },

    /**
     * Anchor an applet menu to the specific arm (horizontal or vertical) the applet
     * sits in, not the L's full bounding box (which is mostly empty), so the menu
     * opens just off that arm - down/up off the horizontal arm, left/right off the
     * vertical arm - matching the per-arm orientation from ExpandLayout. The menu is
     * confined to the L's free-space region (the monitor minus both arms' columns/
     * rows) so it can't spill across the perpendicular arm.
     */
    getMenuAnchorBox: function(sourceActor) {
        let panel = this._panel;
        let arm = panel.actor;
        let a = sourceActor;
        while (a && a !== panel.actor) {
            if (a === panel._armhBox || a === panel._armvBox) { arm = a; break; }
            a = a.get_parent();
        }

        // Free-space rect: the monitor narrowed by each visible arm so the menu stays
        // clear of the perpendicular arm (e.g. a top-left L pushes the menu right of
        // the left/vertical arm and below the top/horizontal arm).
        let anchor = expandAnchor(this._cfg());
        let m = panel.monitor;
        let b = { x1: m.x, y1: m.y, x2: m.x + m.width, y2: m.y + m.height };
        let armv = panel._armvBox, armh = panel._armhBox;
        if (armv && armv.visible) {
            let vb = Cinnamon.util_get_transformed_allocation(armv);
            if (anchor.left)  b.x1 = Math.max(b.x1, vb.x2);
            if (anchor.right) b.x2 = Math.min(b.x2, vb.x1);
        }
        if (armh && armh.visible) {
            let hb = Cinnamon.util_get_transformed_allocation(armh);
            if (anchor.top)    b.y1 = Math.max(b.y1, hb.y2);
            if (anchor.bottom) b.y2 = Math.min(b.y2, hb.y1);
        }
        return menuAnchorBox(arm, b);
    }
});

/**
 * createGeometry:
 * @panel: the #Panel instance
 * @type (string): the panel type ("edge", "floating", "grid", "expanding"),
 * as normalised by PanelManager.getPanelType
 *
 * Returns: a geometry strategy object
 */
function createGeometry(panel, type) {
    switch (type) {
        case "floating":
            return new FloatingGeometry(panel);
        case "grid":
            return new GridGeometry(panel);
        case "expanding":
            return new ExpandingGeometry(panel);
        default:
            return new EdgeGeometry(panel);
    }
}
