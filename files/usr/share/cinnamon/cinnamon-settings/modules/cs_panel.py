#!/usr/bin/python3

import sys
import json
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

from SettingsWidgets import SidePage
from xapp.GSettingsWidgets import *
import config

# The panel types the shell knows (js/ui/panel.js PANEL_TYPES). Anything else in
# a panels-extended entry is an edge panel, there and here.
PANEL_TYPES = ("edge", "floating", "grid", "expanding")

# The "sizing" modes of a floating / grid panel (js/ui/panelGeometry.js resolvePanelSize).
SIZING_OPTIONS = [["fixed", _("Fixed size")], ["fit-content", _("Fit content")],
                  ["fit-content-with-max", _("Fit content, up to a maximum")]]

# Each panel type's name and one-line description, for the Add menu and a panel's page.
PANEL_TYPE_INFO = {
    "edge": (_("Edge panel"), _("Spans the whole length of a screen edge, like the default panels.")),
    "floating": (_("Floating panel"), _("A panel you can place anywhere on the screen.")),
    "grid": (_("Grid panel"), _("Rows of applets pinned to an edge or corner of the screen.")),
    "expanding": (_("Expanding panel"), _("Tucks into a screen corner and opens along the screen edges when you point at it.")),
}


def load_panels_extended(settings):
    # The per-panel JSON objects of the "panels-extended" ('as') key, keyed by
    # panel "id". Malformed entries are skipped. This is the one parser the panel
    # settings share.
    out = []
    for entry in settings.get_strv("panels-extended"):
        try:
            obj = json.loads(entry)
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def find_panel_extended(settings, panel_id):
    for obj in load_panels_extended(settings):
        if str(obj.get("id")) == str(panel_id):
            return obj
    return None


def add_extended_reveal_row(section, widget, panel_id, check):
    # A section row that is only shown while check(panel's panels-extended object) is
    # true. SettingsSection reveal rows follow a gsettings key; these fields live inside
    # a JSON element of one, so the revealer is driven from panels-extended directly.
    revealer = SettingsRevealer()
    section.add_reveal_row(widget, revealer=revealer)
    settings = Gio.Settings.new("org.cinnamon")

    def update(*args):
        revealer.set_reveal_child(bool(check(find_panel_extended(settings, panel_id) or {})))

    changed_id = settings.connect("changed::panels-extended", update)
    revealer.connect("destroy", lambda *args: settings.disconnect(changed_id))
    update()


class Monitor:
    def __init__(self):
        self.top = -1
        self.bottom = -1
        self.right = -1
        self.left = -1

    def position_used(self, position):
        if position == "top":
            return self.top != -1
        elif position == "bottom":
            return self.bottom != -1
        elif position == "left":
            return self.left != -1
        elif position == "right":
            return self.right != -1

def build_zone_page(panel_id, zone, size_group):
    # The per-zone (left/center/right) appearance controls used by edge panels.
    zone_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)

    text_options = [[0, _("Allow theme to determine font size")]]
    points = 6.0
    while points <= 16.0:
        text_options.append([points, "%.1fpt" % points])
        points += 0.5
    zone_page.pack_start(PanelJSONComboBox(_("Font size"),
                                           "org.cinnamon", "panel-zone-text-sizes",
                                           panel_id, zone, text_options, valtype=float,
                                           size_group=size_group), False, False, 0)

    fullcolor_options = [
        [-1, _("Scale to panel size exactly")],
        [0, _("Scale to panel size optimally")],
        [16, '16px'], [22, '22px'], [24, '24px'], [32, '32px'], [48, '48px']
    ]
    zone_page.pack_start(PanelJSONComboBox(_("Colored icon size"),
                                           "org.cinnamon", "panel-zone-icon-sizes",
                                           panel_id, zone, fullcolor_options, valtype=int,
                                           size_group=size_group), False, False, 0)

    zone_page.pack_start(PanelJSONSpinButton(_("Symbolic icon size"),
                                             "org.cinnamon", "panel-zone-symbolic-icon-sizes",
                                             panel_id, zone, _("px"), 10, 50, 1, 0), False, False, 0)
    return zone_page


class PanelSettingsPage(SettingsPage):
    # One panel's settings, inline. An edge panel gets the stock page (visibility,
    # size, appearance) plus the options that also apply to it; every other type gets
    # only the sections that type honours.
    def __init__(self, panel_id, position, panel_type="edge"):
        super(PanelSettingsPage, self).__init__()
        self.set_margin_top(0)
        self.set_margin_bottom(0)
        self.panel_id = panel_id
        self.panel_type = panel_type
        self.size_group = Gtk.SizeGroup.new(Gtk.SizeGroupMode.HORIZONTAL)

        if panel_type == "edge":
            self._add_edge_sections(position)
            self._add_collapse_section()
            self._add_workspaces_section()
        else:
            self._add_type_section()
            if panel_type == "floating":
                self._add_floating_section()
                visibility, autohide = self._add_visibility_section()
                drawer = self._add_collapse_section()
                self._keep_apart(visibility, autohide, drawer)
            else:
                {"grid": self._add_grid_section,
                 "expanding": self._add_expanding_section}[panel_type]()
                self._add_collapse_section()
            self._add_workspaces_section()
            # Grid rows and expanding arms size their icons from their own thickness;
            # only a floating panel has the left/center/right zones these set.
            if panel_type == "floating":
                self._add_appearance_section(_("Start"), _("Middle"), _("End"))

        self.show_all()

    def _add_edge_sections(self, position):
        # The stock edge panel page: unchanged from upstream.
        if position in ("top", "bottom"):
            dimension_text = _("Panel height:")
            left_label = _("Left Zone")
            right_label = _("Right Zone")
        else:
            dimension_text = _("Panel width:")
            left_label = _("Top Zone")
            right_label = _("Bottom Zone")

        self._add_visibility_section()

        section = self.add_section(_("Customize"))
        widget = PanelRange(dimension_text, "org.cinnamon", "panels-height", self.panel_id, _("Smaller"), _("Larger"), mini=20, maxi=60, digits=0, step=1.0, show_value=True)
        widget.set_rounding(0)
        section.add_row(widget)

        self._add_appearance_section(left_label, _("Center Zone"), right_label)

    def _add_visibility_section(self):
        # The stock auto-hide options, shared by the edge and floating pages.
        # Returns the section and its auto-hide combo.
        def can_show(vlist, possible):
            for item in vlist:
                if item.split(":")[0] == self.panel_id:
                    return item.split(":")[1] != "false"

        section = self.add_section(_("Panel Visibility"))
        options = [["true", _("Auto hide panel")], ["false", _("Always show panel")], ["intel", _("Intelligently hide panel")]]
        autohide = PanelComboBox(_("Auto-hide panel"), "org.cinnamon", "panels-autohide", self.panel_id, options, size_group=self.size_group)
        section.add_row(autohide)
        section.add_reveal_row(PanelSpinButton(_("Show delay"), "org.cinnamon", "panels-show-delay", self.panel_id, _("milliseconds"), 0, 2000, 50, 200),
                               "org.cinnamon", "panels-autohide", check_func=can_show)
        section.add_reveal_row(PanelSpinButton(_("Hide delay"), "org.cinnamon", "panels-hide-delay", self.panel_id, _("milliseconds"), 0, 2000, 50, 200),
                               "org.cinnamon", "panels-autohide", check_func=can_show)
        return section, autohide

    def _keep_apart(self, visibility, autohide, drawer):
        # A collapsed panel is already out of the way, so auto-hide and the collapse
        # handle can't both be on: each is greyed out while the other is. If both
        # were set by hand, only the handle stays editable so it can be switched off.
        visibility.add_note("<small>%s</small>" % _(
            "Auto-hide and collapsing to a handle can't be used together. Turn one off to use the other."))
        settings = Gio.Settings.new("org.cinnamon")

        def update(*args):
            hides = any(item.split(":")[0] == self.panel_id and item.split(":")[1] != "false"
                        for item in settings.get_strv("panels-autohide"))
            collapses = bool((find_panel_extended(settings, self.panel_id) or {}).get("drawer"))
            autohide.set_sensitive(not collapses)
            drawer.set_sensitive(collapses or not hides)

        ids = [settings.connect("changed::panels-autohide", update),
               settings.connect("changed::panels-extended", update)]
        autohide.connect("destroy", lambda *args: [settings.disconnect(i) for i in ids])
        update()

    def _add_appearance_section(self, left_label, center_label, right_label):
        section = self.add_section(_("Panel appearance"))
        switcher_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, border_width=5)
        zones_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.SLIDE_LEFT_RIGHT, transition_duration=150)
        switcher = Gtk.StackSwitcher(stack=stack, halign=Gtk.Align.CENTER)
        section.add_row(switcher_box)
        switcher_box.get_parent().set_activatable(False)
        switcher_box.pack_start(switcher, False, False, 0)
        zones_box.pack_start(stack, False, False, 0)
        for [zone, label] in (["left", left_label], ["center", center_label], ["right", right_label]):
            zp = build_zone_page(self.panel_id, zone, self.size_group)
            zp.show_all()
            stack.add_titled(zp, zone, label)
        section.add_row(zones_box)
        zones_box.get_parent().set_activatable(False)
        stack.set_visible_child_name("left")

    def _add_type_section(self):
        # Read-only: the layout isn't rebuilt live when the type changes.
        name, description = PANEL_TYPE_INFO[self.panel_type]
        section = self.add_section(_("Type"))
        row = SettingsWidget()
        row.pack_start(SettingsLabel(_("Type")), False, False, 0)
        row.pack_end(SettingsLabel(name), False, False, 0)
        section.add_row(row)
        section.add_note("<small>%s %s</small>" % (
            description, _("To use a different type, add a new panel and remove this one.")))

    def _add_size_rows(self, section, width_label, height_label, width_check=None, height_check=None):
        for label, field, check in ((width_label, "width", width_check), (height_label, "height", height_check)):
            row = PanelExtendedSpinButton(label, self.panel_id, field, _("px"), 24, 10000, 1, 0)
            if check:
                add_extended_reveal_row(section, row, self.panel_id, check)
            else:
                section.add_row(row)

    def _add_sizing_rows(self, section):
        # Width and height only matter when the size isn't fitted to the content.
        section.add_row(PanelExtendedComboBox(_("Sizing"), self.panel_id, "sizing", SIZING_OPTIONS, size_group=self.size_group))
        not_fitted = lambda obj: obj.get("sizing", "fixed") != "fit-content"
        self._add_size_rows(section, _("Width"), _("Height"), not_fitted, not_fitted)

    def _add_floating_section(self):
        section = self.add_section(_("Position and size"))
        section.add_row(PanelExtendedSpinButton(_("Distance from left"), self.panel_id, "x", _("px"), 0, 10000, 1, 0))
        section.add_row(PanelExtendedSpinButton(_("Distance from top"), self.panel_id, "y", _("px"), 0, 10000, 1, 0))
        self._add_sizing_rows(section)
        section.add_row(PanelExtendedComboBox(_("Orientation"), self.panel_id, "orientation",
                        [["horizontal", _("Horizontal")], ["vertical", _("Vertical")]], size_group=self.size_group))

    def _add_grid_section(self):
        section = self.add_section(_("Position and size"))
        section.add_row(PanelAnchorPicker(_("Screen position"), self.panel_id, "anchor"))
        section.add_row(PanelExtendedSpinButton(_("Rows"), self.panel_id, "rows", "", 1, 8, 1, 0))
        self._add_sizing_rows(section)

    def _add_expanding_section(self):
        section = self.add_section(_("Position and size"))
        section.add_row(PanelAnchorPicker(_("Corner"), self.panel_id, "anchor", corners_only=True))
        section.add_row(PanelExtendedComboBox(_("Expand direction"), self.panel_id, "expandAxes",
                        [["both", _("Both (L shape)")], ["x", _("Horizontal only")],
                         ["y", _("Vertical only")]], size_group=self.size_group))
        section.add_row(PanelExtendedSpinButton(_("Thickness"), self.panel_id, "thickness", _("px"), 8, 200, 1, 0))
        # A horizontal-only strip is as thick as the panel, so its height isn't used
        # (and a vertical-only strip's width).
        self._add_size_rows(section, _("Width when open"), _("Height when open"),
                            lambda obj: obj.get("expandAxes", "both") != "y",
                            lambda obj: obj.get("expandAxes", "both") != "x")

    def _add_collapse_section(self):
        if self.panel_type == "expanding":
            # The arms are this panel's collapsed state and always open on hover,
            # so there is no switch: only how quickly.
            section = self.add_section(_("Open on hover"))
            section.add_row(PanelExtendedSpinButton(_("Open delay"), self.panel_id, "hoverShowDelay", _("ms"), 0, 2000, 10, 50))
            section.add_row(PanelExtendedSpinButton(_("Close delay"), self.panel_id, "hoverHideDelay", _("ms"), 0, 5000, 10, 100))
            return

        section = self.add_section(_("Collapse"))
        collapsible = lambda obj: bool(obj.get("drawer"))
        drawer = PanelExtendedSwitch(_("Collapse to a handle"), self.panel_id, "drawer")
        section.add_row(drawer)
        add_extended_reveal_row(section, PanelExtendedComboBox(_("Collapse toward"), self.panel_id, "drawerDirection",
                                [["left", _("Left")], ["right", _("Right")],
                                 ["top", _("Top")], ["bottom", _("Bottom")]], size_group=self.size_group),
                                self.panel_id, collapsible)
        add_extended_reveal_row(section, PanelExtendedSwitch(_("Open when the pointer is over it"), self.panel_id, "hoverExpand"),
                                self.panel_id, collapsible)
        opens_on_hover = lambda obj: bool(obj.get("drawer")) and bool(obj.get("hoverExpand"))
        add_extended_reveal_row(section, PanelExtendedSpinButton(_("Open delay"), self.panel_id, "hoverShowDelay", _("ms"), 0, 2000, 10, 50),
                                self.panel_id, opens_on_hover)
        add_extended_reveal_row(section, PanelExtendedSpinButton(_("Close delay"), self.panel_id, "hoverHideDelay", _("ms"), 0, 5000, 10, 100),
                                self.panel_id, opens_on_hover)
        return drawer

    def _add_workspaces_section(self):
        section = self.add_section(_("Show on workspaces"))
        section.add_row(PanelExtendedSwitch(_("Only show on selected workspaces"), self.panel_id, "workspaceContextual"))
        add_extended_reveal_row(section, PanelWorkspaceSelector(_("Workspaces"), self.panel_id, "workspaces"),
                                self.panel_id, lambda obj: bool(obj.get("workspaceContextual")))


class Module:
    name = "panel"
    category = "prefs"
    comment = _("Manage Cinnamon panel settings")

    def __init__(self, content_box):
        keywords = _("panel, height, bottom, top, autohide, size, layout")
        self.sidePage = SidePage(_("Panel"), "cs-panel", keywords, content_box, module=self)

    def on_module_selected(self):
        if not self.loaded:
            print("Loading Panel module")

            self.settings = Gio.Settings.new("org.cinnamon")

            try:
                if config.PARSED_ARGS.panel is not None:
                    self.panel_id = config.PARSED_ARGS.panel
                else:
                    self.panel_id = self.settings.get_strv("panels-enabled")[0].split(":")[0]
            except:
                self.panel_id = ""

            self.panels = []
            self.updating = False
            # The ids of the panels listed last time, to spot a newly added one (None
            # until the first listing, so panels that already exist aren't "new").
            self._known_ids = None
            # The id of the panel currently highlighted on the desktop, or None.
            # All highlighting goes through self._highlight() so exactly one panel
            # is ever lit (prev/next, add and list-rebuild can't leave two selected).
            self._highlighted_id = None

            self.previous_button = Gtk.Button(_("Previous panel"))
            self.next_button = Gtk.Button(_("Next panel"))

            controller = SettingsWidget()
            controller.fill_row()
            controller.pack_start(self.previous_button, False, False, 0)
            controller.pack_end(self.next_button, False, False, 0)
            self.previous_button.connect("clicked", self.on_previous_panel)
            self.next_button.connect("clicked", self.on_next_panel)

            self.revealer = SettingsRevealer()

            page = SettingsPage()
            page.add(controller)
            page.set_margin_bottom(0)
            self.revealer.add(page)
            self.sidePage.add_widget(self.revealer)

            self.config_stack = Gtk.Stack()
            self.config_stack.set_transition_duration(150)
            self.revealer.add(self.config_stack)

            page = SettingsPage()
            self.sidePage.add_widget(page)
            section = page.add_section(_("General Panel Options"))

            buttons = SettingsWidget()
            self.add_panel_button = Gtk.Button(label=_("Add new panel"))

            buttons.pack_start(self.add_panel_button, False, False, 2)
            toggle_button = Gtk.ToggleButton(label=_("Panel edit mode"))

            self.settings.bind("panel-edit-mode", toggle_button, "active", Gio.SettingsBindFlags.DEFAULT)
            buttons.pack_end(toggle_button, False, False, 2)
            section.add_row(buttons)

            section.add_row(GSettingsSwitch(_("Allow the pointer to pass through the edges of panels"), "org.cinnamon", "no-adjacent-panel-barriers"))

            # Floating/grid/expanding panels can always be added, so the button is
            # always enabled; only the "Edge panel" menu entry needs a free edge.
            self.add_panel_button.connect("clicked", self.on_add_panel)
            self.can_add_edge = True

            self.settings.connect("changed::panels-enabled", self.on_panel_list_changed)

            self.proxy = None

            try:
                Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                                          "org.Cinnamon", "/org/Cinnamon", "org.Cinnamon", None, self._on_proxy_ready, None)
            except GLib.Error as e:
                print(e.message)
                self.proxy = None

        self.on_panel_list_changed()

    def _on_proxy_ready (self, object, result, data=None):
        self.proxy = Gio.DBusProxy.new_for_bus_finish(result)

        if not self.proxy.get_name_owner():
            self.proxy = None

        if self.proxy:
            self.revealer.connect("unmap", self.restore_panels)
            self.revealer.connect("destroy", self.restore_panels)

            self._highlight(self.panel_id)

    def on_add_panel(self, widget):
        # Present a type picker. Edge uses the existing dummy-placement flow;
        # floating/grid/expanding are created directly.
        menu = Gtk.Menu()
        for ptype in PANEL_TYPES:
            name, description = PANEL_TYPE_INFO[ptype]
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, border_width=4)
            title = Gtk.Label(xalign=0)
            title.set_markup("<b>%s</b>" % GLib.markup_escape_text(name))
            detail = Gtk.Label(label=description, xalign=0, wrap=True, max_width_chars=40)
            detail.get_style_context().add_class("dim-label")
            box.pack_start(title, False, False, 0)
            box.pack_start(detail, False, False, 0)
            item = Gtk.MenuItem()
            item.add(box)
            if ptype == "edge":
                if not self.proxy:
                    item.set_sensitive(False)
                    item.set_tooltip_text(_("Edge panels are placed by clicking on the screen, which needs Cinnamon to be running."))
                elif not self.can_add_edge:
                    item.set_sensitive(False)
                    item.set_tooltip_text(_("Every edge of every screen already has a panel. Remove one to add an edge panel."))
                item.connect("activate", lambda *a: self.on_add_edge_panel())
            else:
                item.connect("activate", lambda a, t=ptype: self.add_extended_panel(t))
            menu.append(item)
        menu.show_all()
        menu.popup_at_widget(widget, Gdk.Gravity.SOUTH_WEST, Gdk.Gravity.NORTH_WEST, None)

    def on_add_edge_panel(self):
        if self.proxy:
            self.proxy.addPanelQuery()

    def _ensure_panel_defaults(self, panel_id, autohide="false"):
        defaults = {
            "panels-autohide": autohide,
            "panels-show-delay": "0",
            "panels-hide-delay": "0",
            "panels-height": "40",
        }
        for key, dval in defaults.items():
            vals = self.settings.get_strv(key)
            if not any(v.split(":")[0] == str(panel_id) for v in vals):
                vals.append("%s:%s" % (panel_id, dval))
                self.settings.set_strv(key, vals)

    def add_extended_panel(self, ptype):
        panel_defs = self.settings.get_strv("panels-enabled")
        used = set()
        for d in panel_defs:
            try:
                used.add(int(d.split(":")[0]))
            except Exception:
                pass
        new_id = 1
        while new_id in used:
            new_id += 1

        if ptype == "floating":
            ext = {"id": new_id, "type": "floating", "monitor": 0,
                   "x": 200, "y": 200, "width": 600, "height": 40, "sizing": "fixed", "orientation": "horizontal"}
            position = "top"
        elif ptype == "grid":
            ext = {"id": new_id, "type": "grid", "monitor": 0, "anchor": "top-right",
                   "width": 320, "height": 80, "sizing": "fixed", "rows": 2}
            position = "top"
        elif ptype == "expanding":
            ext = {"id": new_id, "type": "expanding", "monitor": 0, "anchor": "top-left",
                   "width": 360, "height": 280, "thickness": 44, "expandAxes": "both"}
            position = "top"
        else:
            return

        # Write the extended config FIRST so dispatch sees the type when the
        # panels-enabled change below triggers creation. Drop any stale entry for this
        # id (e.g. a removed panel whose id we're reusing) so the new panel doesn't
        # inherit the old type/geometry.
        exts = [o for o in load_panels_extended(self.settings) if str(o.get("id")) != str(new_id)]
        exts.append(ext)
        self.settings.set_strv("panels-extended", [json.dumps(o) for o in exts])

        self._ensure_panel_defaults(new_id)

        panel_defs.append("%d:%d:%s" % (new_id, ext.get("monitor", 0), position))
        self.settings.set_strv("panels-enabled", panel_defs)

    def _highlight(self, panel_id):
        # Highlight exactly one panel on the desktop, always clearing the previously
        # highlighted one first. Tracking the lit panel here (rather than firing a
        # bare on/off pair at each call site) is what stops two panels from ever
        # showing as selected when navigating, adding, or rebuilding the list.
        if not self.proxy:
            return
        pid = None if panel_id in (None, "") else str(panel_id)
        if pid == self._highlighted_id:
            return
        if self._highlighted_id is not None:
            try:
                self.proxy.highlightPanel('(ib)', int(self._highlighted_id), False)
            except (ValueError, TypeError):
                pass
            self._highlighted_id = None
        if pid is not None:
            try:
                self.proxy.highlightPanel('(ib)', int(pid), True)
                self._highlighted_id = pid
            except (ValueError, TypeError):
                pass

    def _highlight_when_created(self, panel_id):
        # The shell builds a new panel only after it sees the panels-enabled change, so
        # a highlight sent straight away finds nothing to light. Send it again shortly
        # after, if that panel is still the selected one.
        def highlight_again():
            if self.proxy and self.panel_id == panel_id:
                try:
                    self.proxy.highlightPanel('(ib)', int(panel_id), True)
                    self._highlighted_id = panel_id
                except (ValueError, TypeError):
                    pass
            return False

        GLib.timeout_add(300, highlight_again)

    def on_previous_panel(self, widget):
        current = self.panels.index(self.current_panel)

        if current - 1 >= 0:
            self.current_panel = self.panels[current - 1]
        else:
            self.current_panel = self.panels[len(self.panels) - 1]
        self.panel_id = self.current_panel.panel_id

        self.config_stack.set_transition_type(Gtk.StackTransitionType.SLIDE_RIGHT)
        self._highlight(self.panel_id)
        self.config_stack.set_visible_child(self.current_panel)

    def on_next_panel(self, widget):
        current = self.panels.index(self.current_panel)

        if current + 1 < len(self.panels):
            self.current_panel = self.panels[current + 1]
        else:
            self.current_panel = self.panels[0]
        self.panel_id = self.current_panel.panel_id

        self.config_stack.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT)
        self._highlight(self.panel_id)
        self.config_stack.set_visible_child(self.current_panel)

    def get_panel_type(self, panel_id):
        # Read the panel's type from the parallel panels-extended key. Absent or
        # unknown => edge, as in the shell.
        obj = find_panel_extended(self.settings, panel_id)
        ptype = obj.get("type") if obj else None
        return ptype if ptype in PANEL_TYPES else "edge"

    def id_or_monitor_position_used(self, kept_panels, monitor_layout, panel_id, monitor_id, position, panel_type="edge"):
        for keeper in kept_panels:
            if keeper.panel_id == panel_id:
                print(f"cs_panel: Ignoring panel definition with an already-used ID: (ID: {panel_id}, Monitor: {monitor_id}, Position: {position})")
                return True
            # Only edge panels are constrained to a unique monitor edge. Floating/
            # grid/expanding panels share nominal positions and must NOT be removed.
            if panel_type == "edge" and monitor_layout[monitor_id].position_used(position):
                print(f"cs_panel: Ignoring panel definition with an already-used monitor:position: (ID: {panel_id}, Monitor: {monitor_id}, Position: {position})")
                return True
        return False

    def on_panel_list_changed(self, *args):
        if self.updating:
            return

        self.updating = True

        if len(self.panels) > 0:
            for panel in self.panels:
                panel.destroy()

        self.panels = []
        monitor_layout = []

        panel_defs = self.settings.get_strv("panels-enabled")
        panel_ids = [def_.split(":")[0] for def_ in panel_defs]
        # A panel that just appeared (added here, or placed on the desktop) becomes the
        # selected one, so its page is shown and it is highlighted.
        added = [pid for pid in panel_ids if self._known_ids is not None and pid not in self._known_ids]
        self._known_ids = set(panel_ids)
        if added:
            self.panel_id = added[-1]
        n_mons = Gdk.Screen.get_default().get_n_monitors()

        for i in range(n_mons):
            monitor_layout.append(Monitor())

        current_found = False
        already_defined_panels = []
        non_edge_panels = []
        removals = []

        for def_ in panel_defs:
            panel_id, monitor_id, position = def_.split(":")
            monitor_id = int(monitor_id)
            panel_type = self.get_panel_type(panel_id)

            if monitor_id >= n_mons:
                print(f"cs_panel: Ignoring panel definition with a monitor out of range: (ID: {panel_id}, Monitor: {monitor_id}, Position: {position})")
            elif self.id_or_monitor_position_used(already_defined_panels, monitor_layout, panel_id, monitor_id, position, panel_type):
                removals.append(def_)
                continue

            panel_page = PanelSettingsPage(panel_id, position, panel_type)
            self.config_stack.add_named(panel_page, panel_id)
            already_defined_panels.append(panel_page)

            # we may already have a current panel id from the command line or if
            # if the panels-enabled key changed since everything was loaded
            if panel_id == self.panel_id:
                current_found = True
                self.current_panel = panel_page
                self.config_stack.set_visible_child(panel_page)

            # Only edge panels occupy a monitor edge slot. Non-edge panels are
            # tracked separately so they don't consume edge slots (or overwrite
            # each other), but remain reachable via prev/next.
            if panel_type == "edge" and monitor_id < n_mons:
                if "top" in position:
                    monitor_layout[monitor_id].top = panel_page
                elif "bottom" in position:
                    monitor_layout[monitor_id].bottom = panel_page
                elif "left" in position:
                    monitor_layout[monitor_id].left = panel_page
                else:
                    monitor_layout[monitor_id].right = panel_page
            elif panel_type != "edge":
                non_edge_panels.append(panel_page)

        if removals:
            print("Cleaning up conflicting defs in panels-enabled")
            for def_ in removals:
                panel_defs.remove(def_)
            self.settings.set_strv("panels-enabled", panel_defs)

        # Index the panels for the next/previous buttons
        for monitor in monitor_layout:
            for panel_page in (monitor.top, monitor.bottom, monitor.left, monitor.right):
                if panel_page != -1:
                    self.panels.append(panel_page)

        # Non-edge panels have no edge slot; append them so they stay navigable.
        for panel_page in non_edge_panels:
            self.panels.append(panel_page)

        # if there are no panels, there's no point in showing the stack
        if len(self.panels) == 0:
            self.next_button.hide()
            self.previous_button.hide()
            self.config_stack.hide()
            self.current_panel = None
            self.panel_id = None
            self.updating = False
            return

        self.config_stack.show()
        self.next_button.show()
        self.previous_button.show()

        # Disable the panel switch buttons if there's only one panel
        if len(self.panels) == 1:
            self.next_button.set_sensitive(False)
            self.previous_button.set_sensitive(False)
        else:
            self.next_button.set_sensitive(True)
            self.previous_button.set_sensitive(True)

        if not current_found:
            self.current_panel = self.panels[0]
            self.panel_id = self.current_panel.panel_id
            self.config_stack.set_visible_child(self.current_panel)

        self.revealer.set_reveal_child(len(self.panels) != 0)

        # If all panel positions are full, we want to disable the add button
        can_add = False
        for monitor in monitor_layout:
            if -1 in (monitor.top, monitor.bottom, monitor.left, monitor.right):
                can_add = True
                break

        # Only the "Edge panel" menu entry depends on a free edge; the button
        # itself stays enabled (floating/grid/expanding can always be added).
        self.can_add_edge = can_add

        self.updating = False
        self._highlight(self.panel_id)
        if added:
            self._highlight_when_created(self.panel_id)

    def restore_panels(self, widget):
        self.proxy.destroyDummyPanels()
        self._highlight(None)

class PanelWidgetBackend(object):
    def connect_to_settings(self, schema, key):
        self.key = key
        self.settings = Gio.Settings.new(schema)
        self.settings_changed_id = self.settings.connect("changed::"+self.key, self.on_setting_changed)
        self.connect("destroy", self.on_destroy)
        self.on_setting_changed()

        # unless we have a binding direction get, we need to connect the handlers after hooking up the settings
        # this is different from the GSettingsBackend because we cant use a bind here due to the complicated nature
        # of the getting and setting
        if self.bind_dir is None or (self.bind_dir & Gio.SettingsBindFlags.GET == 0):
            self.connect_widget_handlers()

    def set_value(self, value):
        vals = self.settings[self.key]
        newvals = []
        for val in vals:
            if val.split(":")[0] == self.panel_id:
                newvals.append(self.panel_id + ":" + self.stringify(value))
            else:
                newvals.append(val)
        self.settings[self.key] = newvals

    def get_value(self):
        vals = self.settings[self.key]
        for val in vals:
            [pid, value] = val.split(":")
            if pid == self.panel_id:
                return self.unstringify(value)

    def stringify(self, value):
        return str(value)

    def on_destroy(self, *args):
        self.settings.disconnect(self.settings_changed_id)

class PanelSwitch(Switch, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelSwitch, self).__init__(label, *args, **kwargs)

        self.connect_to_settings(schema, key)

    def stringify(self, value):
        return "true" if value else "false"

    def unstringify(self, value):
        return value != "false"

    def on_setting_changed(self, *args):
        value = self.get_value()
        if value != self.content_widget.get_active():
            self.content_widget.set_active(value)

    def connect_widget_handlers(self, *args):
        self.content_widget.connect("notify::active", self.on_my_value_changed)

    def on_my_value_changed(self, *args):
        active = self.content_widget.get_active()
        if self.get_value() != active:
            self.set_value(active)

class PanelSpinButton(SpinButton, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelSpinButton, self).__init__(label, *args, **kwargs)

        self.content_widget.set_value(0)

        self.connect_to_settings(schema, key)

    def get_range(self):
        return None

    # We use integer directly here because that is all the panel currently uses.
    # If that changes in the future, we will need to fix this.
    def stringify(self, value):
        return str(int(value))

    def unstringify(self, value):
        return int(value)

    def on_setting_changed(self, *args):
        value = self.get_value()
        if value is not None and value != int(self.content_widget.get_value()):
            self.content_widget.set_value(value)

class PanelJSONSpinButton(SpinButton, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, zone, *args, **kwargs):
        self.panel_id = panel_id
        self.zone = zone
        super(PanelJSONSpinButton, self).__init__(label, *args, **kwargs)

        self.connect_to_settings(schema, key)

    def get_range(self):
        return

    # We use integer directly here because that is all the panel currently uses.
    # If that changes in the future, we will need to fix this.
    def stringify(self, value):
        return str(int(value))

    def unstringify(self, value):
        return int(value)

    def on_setting_changed(self, *args):
        self.content_widget.set_value(self.get_value())

    def set_value(self, value):
        vals = json.loads(self.settings[self.key])
        for obj in vals:
            if obj['panelId'] != int(self.panel_id):
                continue
            for key, val in obj.items():
                if key == self.zone:
                    obj[key] = int(value)
                    break

        self.settings[self.key] = json.dumps(vals)

    def get_value(self):
        vals = self.settings[self.key]
        vals = json.loads(vals)
        for obj in vals:
            if obj['panelId'] != int(self.panel_id):
                continue
            for key, val in obj.items():
                if key == self.zone:
                    return int(val)
        return 0 # prevent warnings if key is reset

class PanelComboBox(ComboBox, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelComboBox, self).__init__(label, *args, **kwargs)

        self.connect_to_settings(schema, key)

    def stringify(self, value):
        return value

    def unstringify(self, value):
        return value

class PanelJSONComboBox(ComboBox, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, zone, *args, **kwargs):
        self.panel_id = panel_id
        self.zone = zone
        super(PanelJSONComboBox, self).__init__(label, *args, **kwargs)

        self.connect_to_settings(schema, key)

    def stringify(self, value):
        return value

    def unstringify(self, value):
        return value

    def set_value(self, value):
        vals = json.loads(self.settings[self.key])
        for obj in vals:
            if obj['panelId'] != int(self.panel_id):
                continue
            for key, val in obj.items():
                if key == self.zone:
                    obj[key] = self.valtype(value)
                    break

        self.settings[self.key] = json.dumps(vals)

    def get_value(self):
        vals = self.settings[self.key]
        vals = json.loads(vals)
        for obj in vals:
            if obj['panelId'] != int(self.panel_id):
                continue
            for key, val in obj.items():
                if key == self.zone:
                    return self.valtype(val)

class PanelRange(Range, PanelWidgetBackend):
    def __init__(self, label, schema, key, panel_id, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelRange, self).__init__(label, *args, **kwargs)
        self.connect_to_settings(schema, key)

    def get_range(self):
        return None

    # We use integer directly here because that is all the panel currently uses.
    # If that changes in the future, we will need to fix this.
    def stringify(self, value):
        return str(int(value))

    def unstringify(self, value):
        return int(value)

    def on_setting_changed(self, *args):
        value = self.get_value()
        if value is not None and value != int(self.bind_object.get_value()):
            self.bind_object.set_value(value)

class PanelExtendedBackend(object):
    # Reads/writes one field of this panel's object in the JSON-per-element
    # "panels-extended" ('as') key, keyed by panel id.
    def connect_to_extended(self, field, valtype):
        self.ext_field = field
        self.ext_valtype = valtype
        self.settings = Gio.Settings.new("org.cinnamon")
        self.settings_changed_id = self.settings.connect("changed::panels-extended", self.on_setting_changed)
        self.connect("destroy", self.on_destroy)
        self.on_setting_changed()
        # We can't use Gio.Settings.bind here (a field lives inside a JSON element of
        # an 'as' array, not a settings key of its own), so every widget syncs through
        # manual handlers. Wire them for any widget that provides them; SpinButton
        # connects its own "value-changed" in its constructor and defines none.
        if hasattr(self, "connect_widget_handlers"):
            self.connect_widget_handlers()

    def get_value(self):
        obj = find_panel_extended(self.settings, self.panel_id)
        v = obj.get(self.ext_field) if obj else None
        return self.ext_valtype(v) if v is not None else None

    def set_value(self, value):
        vals = load_panels_extended(self.settings)
        for obj in vals:
            if str(obj.get("id")) == str(self.panel_id):
                obj[self.ext_field] = self.ext_valtype(value)
                break
        else:
            vals.append({"id": int(self.panel_id), self.ext_field: self.ext_valtype(value)})
        self.settings.set_strv("panels-extended", [json.dumps(o) for o in vals])

    def stringify(self, value):
        return value

    def unstringify(self, value):
        return value

    def on_destroy(self, *args):
        self.settings.disconnect(self.settings_changed_id)

class PanelExtendedSwitch(Switch, PanelExtendedBackend):
    def __init__(self, label, panel_id, field, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelExtendedSwitch, self).__init__(label, *args, **kwargs)
        self.connect_to_extended(field, bool)

    def on_setting_changed(self, *args):
        value = bool(self.get_value())
        if value != self.content_widget.get_active():
            self.content_widget.set_active(value)

    def connect_widget_handlers(self, *args):
        self.content_widget.connect("notify::active", self.on_my_value_changed)

    def on_my_value_changed(self, *args):
        active = self.content_widget.get_active()
        if bool(self.get_value()) != active:
            self.set_value(active)

class PanelExtendedSpinButton(SpinButton, PanelExtendedBackend):
    def __init__(self, label, panel_id, field, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelExtendedSpinButton, self).__init__(label, *args, **kwargs)
        self.content_widget.set_value(0)
        self.connect_to_extended(field, int)

    def get_range(self):
        return None

    def on_setting_changed(self, *args):
        value = self.get_value()
        if value is not None and value != int(self.content_widget.get_value()):
            self.content_widget.set_value(value)

class PanelExtendedComboBox(ComboBox, PanelExtendedBackend):
    def __init__(self, label, panel_id, field, *args, **kwargs):
        self.panel_id = panel_id
        super(PanelExtendedComboBox, self).__init__(label, *args, **kwargs)
        self.connect_to_extended(field, str)

class PanelAnchorPicker(SettingsWidget, PanelExtendedBackend):
    # A 3x3 visual picker for a panel's anchor. A grid panel can use the 8 edge and
    # corner positions (the screen centre is never a valid panel anchor, so that cell
    # is left empty); an expanding panel is corner-anchored only (corners_only), so
    # only the 4 corner cells are offered.
    bind_dir = None

    POSITIONS = [
        ("top-left", 0, 0), ("top-center", 1, 0), ("top-right", 2, 0),
        ("middle-left", 0, 1), ("center", 1, 1), ("middle-right", 2, 1),
        ("bottom-left", 0, 2), ("bottom-center", 1, 2), ("bottom-right", 2, 2),
    ]

    def __init__(self, label, panel_id, field, corners_only=False):
        self.panel_id = panel_id
        super(PanelAnchorPicker, self).__init__()
        self._updating = False
        self.buttons = {}

        self.label = SettingsLabel(label)
        self.pack_start(self.label, False, False, 0)

        grid = Gtk.Grid(row_spacing=2, column_spacing=2, halign=Gtk.Align.END, valign=Gtk.Align.CENTER)
        for (name, col, row) in self.POSITIONS:
            if name == "center" or (corners_only and (col == 1 or row == 1)):
                spacer = Gtk.Box()
                spacer.set_size_request(28, 20)
                grid.attach(spacer, col, row, 1, 1)
                continue
            btn = Gtk.ToggleButton()
            btn.set_size_request(28, 20)
            btn.set_tooltip_text(name.replace("-", " ").capitalize())
            btn.connect("toggled", self._on_toggled, name)
            grid.attach(btn, col, row, 1, 1)
            self.buttons[name] = btn
        self.pack_end(grid, False, False, 0)

        self.connect_to_extended(field, str)

    def _on_toggled(self, btn, name):
        if self._updating:
            return
        if btn.get_active():
            self._updating = True
            for n, b in self.buttons.items():
                if n != name:
                    b.set_active(False)
            self._updating = False
            if self.get_value() != name:
                self.set_value(name)
        elif self.get_value() == name:
            # Keep exactly one cell selected.
            self._updating = True
            btn.set_active(True)
            self._updating = False

    def on_setting_changed(self, *args):
        val = self.get_value()
        self._updating = True
        for n, b in self.buttons.items():
            b.set_active(n == val)
        self._updating = False

    def connect_widget_handlers(self, *args):
        pass    # the per-button "toggled" handlers are connected in __init__

class PanelWorkspaceSelector(SettingsWidget, PanelExtendedBackend):
    # Multi-select of which workspaces a workspace-contextual panel appears on. Stores
    # an array of 0-based workspace indices in the panels-extended "workspaces" field.
    bind_dir = None

    def __init__(self, label, panel_id, field):
        self.panel_id = panel_id
        super(PanelWorkspaceSelector, self).__init__()
        self._updating = False
        self.checks = {}

        self.label = SettingsLabel(label)
        self.pack_start(self.label, False, False, 0)

        try:
            n = Gio.Settings.new("org.cinnamon.desktop.wm.preferences").get_int("num-workspaces")
        except Exception:
            n = 4
        n = max(1, min(n, 36))

        box = Gtk.Box(spacing=4, halign=Gtk.Align.END, valign=Gtk.Align.CENTER)
        for i in range(n):
            cb = Gtk.CheckButton(label=str(i + 1))
            cb.connect("toggled", self._on_toggled)
            box.pack_start(cb, False, False, 0)
            self.checks[i] = cb
        self.pack_end(box, False, False, 0)

        self.connect_to_extended(field, self._workspace_list)

    @staticmethod
    def _workspace_list(v):
        # The field is a list of 0-based workspace indices; anything else reads as [].
        return [int(x) for x in v] if isinstance(v, list) else []

    def _get_list(self):
        return self.get_value() or []

    def _on_toggled(self, *args):
        if self._updating:
            return
        selected = sorted([i for i, cb in self.checks.items() if cb.get_active()])
        if selected != self._get_list():
            self.set_value(selected)

    def on_setting_changed(self, *args):
        current = set(self._get_list())
        self._updating = True
        for i, cb in self.checks.items():
            cb.set_active(i in current)
        self._updating = False
