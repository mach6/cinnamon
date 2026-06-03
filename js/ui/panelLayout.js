/**
 * FILE:panelLayout.js
 * @short_description: Layout strategies for panels (how applet zones are arranged)
 *
 * A layout strategy owns how a panel arranges its applet zones and how its actor
 * allocates them. "linear" is the upstream left/center/right (or top/middle/bottom
 * for vertical) arrangement; "grid" arranges applets into stacked rows; "expand"
 * lays out an expanding panel's two perpendicular arms.
 *
 * #Panel routes its allocation hooks (_getPreferredWidth/_getPreferredHeight/
 * _allocate) through the attached layout strategy. #LinearLayout delegates to the
 * panel's preserved upstream implementations (the *_edge methods), so edge/floating
 * panels are unchanged. The other layouts supply their own zones and allocation.
 *
 * Zones are exposed as panel._<name>Box (panel._row0Box, panel._armhBox, ...) so
 * that AppletManager.getLocation(panel, "row0") -> panel._row0Box places applets
 * into the right zone with no AppletManager change. Applet definitions therefore
 * use the zone name as their "location": panelN:row0:order:uuid:id. getZones()
 * lists a layout's zones for the behaviors that hide/show them.
 *
 * NB Cinnamon 6.6's #Panel.actor is a Cinnamon.GenericContainer with manual
 * allocation; the strategy operates on panel.actor and the zone St.BoxLayouts.
 */
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;

// Loaded lazily from Panel._init at runtime, after panel.js has finished
// evaluating, so importing the panel module here is not a cycle.
const PanelManager = imports.ui.panel;
const PanelGeometry = imports.ui.panelGeometry;

const GRID_DEFAULT_ROWS = 2;
// Row thickness (logical px) used in fit-content sizing modes, where the content - not
// the panel height - determines the size, so the row/icon size is a fixed default.
const GRID_FIT_ROW_THICKNESS = 36;

// Applet labels in a grid row / expanding arm scale to the zone's thickness (like the
// icons do) so text fits a thin zone. ~0.25pt per logical px gives roughly the normal
// panel font in a ~40px zone; clamped so it stays legible / not huge.
const ZONE_FONT_MIN_PT = 6;
const ZONE_FONT_MAX_PT = 16;
function zoneFontStyle(thicknessPx) {
    let pt = (thicknessPx / global.ui_scale) * 0.25;
    pt = Math.min(Math.max(pt, ZONE_FONT_MIN_PT), ZONE_FONT_MAX_PT);
    return 'font-size: ' + pt.toFixed(1) + 'pt;';
}

// ============================================================
// LinearLayout - the default upstream arrangement. Forwards every allocation hook
// to the panel's preserved implementation, so it changes nothing.
// ============================================================
function LinearLayout(panel) {
    this._panel = panel;
}

LinearLayout.prototype = {
    attach: function() {},
    detach: function() {},
    getPreferredWidth: function(actor, forHeight, alloc) {
        return this._panel._getPreferredWidth_edge(actor, forHeight, alloc);
    },
    getPreferredHeight: function(actor, forWidth, alloc) {
        return this._panel._getPreferredHeight_edge(actor, forWidth, alloc);
    },
    allocate: function(actor, box, flags) {
        return this._panel._allocate_edge(actor, box, flags);
    },
    getZones: function() {
        let p = this._panel;
        return [p._leftBox, p._centerBox, p._rightBox];
    },
    // The standard zones follow the panel's own orientation and height.
    getZoneOrientation: function(location, fallback) {
        return fallback;
    },
    getZoneThickness: function(location) {
        return 0;
    }
};

// ============================================================
// GridLayout - arrange applets into stacked rows. Each row is a horizontal
// St.BoxLayout exposed as panel._row{i}Box (so AppletManager routes applets to it).
// Rows are stacked top-to-bottom; each row's content block is aligned left/center/
// right within the panel width per the configured per-row alignment.
// ============================================================
function GridLayout(panel) {
    this._panel = panel;
    this._rows = [];
    this._alignments = [];
    this._dndHandlers = [];
}

GridLayout.prototype = {
    _cfg: function() {
        return PanelManager.getPanelExtended(this._panel.panelId);
    },

    attach: function() {
        let panel = this._panel;
        let cfg = this._cfg();
        let nrows = Math.max(1, parseInt(cfg.rows) || GRID_DEFAULT_ROWS);
        let aligns = Array.isArray(cfg.rowAlignments) ? cfg.rowAlignments : [];

        // The 3 standard zones aren't used by a grid panel; hide them.
        panel._leftBox.hide();
        panel._centerBox.hide();
        panel._rightBox.hide();

        for (let i = 0; i < nrows; i++) {
            let rowBox = new St.BoxLayout({
                name: 'panelRow' + i,
                style_class: 'panel-grid-row',
                vertical: false,
                important: true
            });
            // Clip each row to its own band so a tall applet can't paint (or be
            // picked for drag-and-drop) over an adjacent row.
            rowBox.set_clip_to_allocation(true);
            panel.actor.add_actor(rowBox);
            panel['_row' + i + 'Box'] = rowBox;
            // Make the row a drop target in panel edit mode so applets can be dragged
            // into and between rows. Grid rows always flow horizontally.
            this._dndHandlers.push(new PanelManager.PanelZoneDNDHandler(rowBox, 'row' + i, panel.panelId, false));
            this._rows.push(rowBox);
            this._alignments.push(aligns[i] || "left");
        }
    },

    detach: function() {
        let panel = this._panel;
        for (let i = 0; i < this._rows.length; i++) {
            this._rows[i].destroy();
            delete panel['_row' + i + 'Box'];
        }
        this._rows = [];
        this._dndHandlers = [];
        panel._leftBox.show();
        panel._centerBox.show();
        panel._rightBox.show();
    },

    getZones: function() {
        return this._rows;
    },

    resetDNDZones: function() {
        this._dndHandlers.forEach(h => h.reset());
    },

    getPreferredWidth: function(actor, forHeight, alloc) {
        // Width = widest row's content.
        let minW = 0, natW = 0;
        for (let i = 0; i < this._rows.length; i++) {
            let [rmin, rnat] = this._rows[i].get_preferred_width(-1);
            minW = Math.max(minW, rmin);
            natW = Math.max(natW, rnat);
        }
        alloc.min_size = minW;
        alloc.natural_size = natW;
    },

    getPreferredHeight: function(actor, forWidth, alloc) {
        // Height = sum of row heights.
        let minH = 0, natH = 0;
        for (let i = 0; i < this._rows.length; i++) {
            let [rmin, rnat] = this._rows[i].get_preferred_height(-1);
            minH += rmin;
            natH += rnat;
        }
        alloc.min_size = minH;
        alloc.natural_size = natH;
    },

    allocate: function(actor, box, flags) {
        let n = this._rows.length;
        if (n === 0)
            return;
        let totalW = box.x2 - box.x1;
        let totalH = box.y2 - box.y1;
        let rowH = Math.floor(totalH / n);
        let editMode = global.settings.get_boolean("panel-edit-mode");

        // Scale label text to the row thickness (guarded so we only restyle when it
        // actually changes, to avoid a relayout loop).
        if (rowH !== this._lastRowH) {
            this._lastRowH = rowH;
            let style = zoneFontStyle(rowH);
            this._rows.forEach(r => r.set_style(style));
        }

        for (let i = 0; i < n; i++) {
            let rowBox = this._rows[i];
            let thisRowH = (i === n - 1) ? (totalH - rowH * (n - 1)) : rowH;

            // Content width of the row, clamped to the panel width.
            let [, natCW] = rowBox.get_preferred_width(thisRowH);
            let cw = Math.min(Math.max(natCW, 0), totalW);
            let rx;
            if (editMode) {
                // While editing, every row is a full-width band so it's an obvious,
                // easy drag-and-drop target (including empty rows). Left-aligned so
                // existing applets keep their natural size at the start of the row.
                cw = totalW;
                rx = 0;
            } else {
                let align = this._alignments[i] || "left";
                rx = (align === "right")  ? (totalW - cw)
                   : (align === "center") ? Math.floor((totalW - cw) / 2)
                   :                        0;
            }

            let cb = new Clutter.ActorBox();
            cb.x1 = box.x1 + rx;
            cb.x2 = cb.x1 + cw;
            cb.y1 = box.y1 + i * rowH;
            cb.y2 = cb.y1 + thisRowH;
            rowBox.allocate(cb, flags);
        }
    },

    // Grid rows run horizontally; an applet's orientation is TOP/BOTTOM (horizontal)
    // following the anchored edge. Non-row zones keep the caller's fallback.
    getZoneOrientation: function(location, fallback) {
        if (typeof location === "string" && location.indexOf("row") === 0) {
            let anchor = this._cfg().anchor || "top-left";
            return (PanelGeometry.anchorRowCol(anchor)[0] === "bottom") ? St.Side.BOTTOM : St.Side.TOP;
        }
        return fallback;
    },

    // Thickness (px) of a row, so applets can size their icons to fit it.
    getZoneThickness: function(location) {
        if (typeof location !== "string" || location.indexOf("row") !== 0)
            return 0;
        // Read sizing fresh (the layout isn't rebuilt on a config change).
        let cfg = this._cfg();
        let sizing = cfg.sizing || "fixed";
        // In fit-content modes the CONTENT drives the panel height, so a row's thickness
        // (hence icon size) is a fixed default - if it were panelHeight/rows the two
        // would be mutually defined and "fit content" could never change the size.
        if (sizing === "fit-content" || sizing === "fit-content-with-max")
            return Math.round(GRID_FIT_ROW_THICKNESS * global.ui_scale);
        let n = Math.max(1, this._rows.length || parseInt(cfg.rows) || GRID_DEFAULT_ROWS);
        let h = this._panel.actor.get_height() || parseInt(cfg.height) || 0;
        return Math.floor(h / n);
    }
};

// ============================================================
// ExpandLayout - lays out an expanding panel as two perpendicular arm strips (a
// horizontal armh and a vertical armv) meeting at the anchored corner, forming
// an L. Each arm is an applet zone exposed as panel._armhBox / panel._armvBox
// (AppletManager routes 'armh'/'armv' applet locations to them). The arms carry
// the panel background; the actor itself is transparent so the empty inner area
// doesn't show. The collapse/expand scaling of the arms is done by
// ExpandingGeometry. Dimensions and anchor come from PanelGeometry.expandDims /
// expandAnchor, the same helpers the geometry sizes the actor with.
// ============================================================
function ExpandLayout(panel) {
    this._panel = panel;
    this._armh = null;
    this._armv = null;
    this._dndHandlers = [];
}

ExpandLayout.prototype = {
    _cfg: function() {
        return PanelManager.getPanelExtended(this._panel.panelId);
    },

    attach: function() {
        let panel = this._panel;
        panel._leftBox.hide();
        panel._centerBox.hide();
        panel._rightBox.hide();
        // The actor is just the bounding box; the arms carry the visible panel. The
        // inline transparent style must stay inline so it beats the theme's #panel
        // background (which the actor would otherwise pick up and fill the L's corner).
        panel.actor.set_style('background-color: transparent; border: none; box-shadow: none;');

        // Style each arm like the edge panel it visually is (horizontal arm = a
        // top/bottom panel, vertical arm = a left/right panel) so it inherits the
        // active theme's panel background (themes style .panel-top/.panel-bottom/...).
        // NOTE: the arm must NOT be name="panel" - PopupMenu.getPanel() walks up for an
        // actor named "panel" to z-order menus, and an arm answering to that name (it
        // isn't in uiGroup) breaks applet menu positioning.
        let a = PanelGeometry.expandAnchor(this._cfg());
        let hEdge = a.bottom ? 'panel-bottom' : 'panel-top';
        let vEdge = a.right  ? 'panel-right'  : 'panel-left';
        this._armh = new St.BoxLayout({ name: 'panelArmH', style_class: 'panel-expanding-arm ' + hEdge, vertical: false, important: true });
        this._armv = new St.BoxLayout({ name: 'panelArmV', style_class: 'panel-expanding-arm ' + vEdge, vertical: true, important: true });
        panel.actor.add_actor(this._armh);
        panel.actor.add_actor(this._armv);
        panel._armhBox = this._armh;
        panel._armvBox = this._armv;
        // Make each arm a drop target so applets can be dragged into and between
        // arms in panel edit mode. The horizontal arm flows horizontally, the
        // vertical arm vertically (regardless of the panel's own orientation).
        this._dndHandlers.push(new PanelManager.PanelZoneDNDHandler(this._armh, 'armh', panel.panelId, false));
        this._dndHandlers.push(new PanelManager.PanelZoneDNDHandler(this._armv, 'armv', panel.panelId, true));
    },

    detach: function() {
        let panel = this._panel;
        this._armh.destroy();
        this._armv.destroy();
        this._armh = this._armv = null;
        this._dndHandlers = [];
        delete panel._armhBox;
        delete panel._armvBox;
        panel.actor.set_style('');
        panel._leftBox.show();
        panel._centerBox.show();
        panel._rightBox.show();
    },

    getZones: function() {
        return [this._armh, this._armv];
    },

    resetDNDZones: function() {
        this._dndHandlers.forEach(h => h.reset());
    },

    getPreferredWidth: function(actor, forHeight, alloc) {
        let d = PanelGeometry.expandDims(this._cfg());
        alloc.min_size = d.W;
        alloc.natural_size = d.W;
    },

    getPreferredHeight: function(actor, forWidth, alloc) {
        let d = PanelGeometry.expandDims(this._cfg());
        alloc.min_size = d.H;
        alloc.natural_size = d.H;
    },

    allocate: function(actor, box, flags) {
        let cfg = this._cfg();
        let d = PanelGeometry.expandDims(cfg);
        let a = PanelGeometry.expandAnchor(cfg);
        let W = box.x2 - box.x1;
        let H = box.y2 - box.y1;
        let T = Math.min(d.T, Math.min(W, H));
        let bothArms = (d.axes === "both");   // an L: both arms present

        // Scale label text to the arm thickness (guarded against relayout loops).
        if (T !== this._lastT) {
            this._lastT = T;
            let style = zoneFontStyle(T);
            this._armh.set_style(style);
            this._armv.set_style(style);
        }

        // Vertical arm owns the full corner column (incl. the junction). Pinned to
        // the anchored left/right edge.
        let vx = a.right ? (W - T) : 0;
        let vb = new Clutter.ActorBox();
        vb.x1 = box.x1 + vx; vb.x2 = vb.x1 + T; vb.y1 = box.y1; vb.y2 = box.y1 + H;
        this._armv.allocate(vb, flags);
        this._armv.set_pivot_point(0.5, a.bottom ? 1 : 0);

        // Horizontal arm: pinned to the anchored top/bottom edge. For an L, inset
        // it past the vertical arm's column so the two arms' applets don't overlap
        // at the corner; the corner belongs to the vertical arm + handle.
        let hy = a.bottom ? (H - T) : 0;
        let hx1 = box.x1, hx2 = box.x1 + W;
        if (bothArms) {
            if (a.right) hx2 = box.x1 + W - T;
            else         hx1 = box.x1 + T;
        }
        let hb = new Clutter.ActorBox();
        hb.x1 = hx1; hb.x2 = hx2; hb.y1 = box.y1 + hy; hb.y2 = hb.y1 + T;
        this._armh.allocate(hb, flags);
        this._armh.set_pivot_point(a.right ? 1 : 0, 0.5);
    },

    // The vertical arm orients applets vertically (LEFT/RIGHT, toward the anchored
    // side); the horizontal arm horizontally (TOP/BOTTOM). Other zones: fallback.
    getZoneOrientation: function(location, fallback) {
        let a = PanelGeometry.expandAnchor(this._cfg());
        if (location === "armv")
            return a.right ? St.Side.RIGHT : St.Side.LEFT;
        if (location === "armh")
            return a.bottom ? St.Side.BOTTOM : St.Side.TOP;
        return fallback;
    },

    // Both arms are the configured thickness; applets size their icons to fit it.
    getZoneThickness: function(location) {
        if (location !== "armh" && location !== "armv")
            return 0;
        return PanelGeometry.expandDims(this._cfg()).T;
    }
};

/**
 * createLayout:
 * @panel: the #Panel instance
 * @type (string): the panel type, as normalised by PanelManager.getPanelType
 *
 * Returns the layout strategy: grid panels use #GridLayout, expanding panels use
 * #ExpandLayout, everything else uses the linear (upstream) layout.
 *
 * Returns: a layout strategy object
 */
function createLayout(panel, type) {
    if (type === "grid")
        return new GridLayout(panel);
    if (type === "expanding")
        return new ExpandLayout(panel);
    return new LinearLayout(panel);
}
