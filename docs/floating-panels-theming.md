# Theming extended panels (floating / grid / expanding / drawers)

Extended panels reuse the normal panel actor, so the usual selectors still apply:
`#panel`, `.panel-top`, `.panel-bottom`, `.panel-left`, `.panel-right`. On top of those,
the strategies add stable style classes a theme can target. Nothing here is required —
panels look reasonable with a stock theme — but these let you style them deliberately.

## Per-panel targeting

Every panel actor gets `panel-id-<N>` (N = the panel id), so a theme can style one
specific panel:

```css
.panel-id-3 { background-gradient-start: #202020; }
```

## Type classes (on the panel actor)

| Class              | Applied to                              |
|--------------------|------------------------------------------|
| `.panel-floating`  | a floating panel                         |
| `.panel-grid`      | a grid panel                             |
| `.panel-expanding` | an expanding panel (the bounding actor; it is kept transparent inline so the empty inner corner of the L doesn't paint) |

## Sub-zones

| Class                  | Applied to                                                        |
|------------------------|-------------------------------------------------------------------|
| `.panel-grid-row`      | each row box of a grid panel (`row0`, `row1`, …)                  |
| `.panel-expanding-arm` | each arm box of an expanding panel. Arms also carry the matching edge class (`.panel-top`/`.panel-bottom` for the horizontal arm, `.panel-left`/`.panel-right` for the vertical arm) so they inherit the theme's edge-panel background. They are deliberately not named `panel`. |

## Handles (peek grips)

| Class                      | Applied to                                  |
|----------------------------|----------------------------------------------|
| `.panel-drawer-handle`     | the grab handle of a collapsed/peeking drawer |
| `.panel-expanding-handle`  | the junction handle of an expanding panel     |

Both handles share one default look (a thin translucent grip) in
`theme/floating-panels.css`, which is loaded beneath the active theme, so a theme
can fully override it by targeting these classes.

## State classes (toggled at runtime on the panel actor)

| Class                          | Meaning                                              |
|--------------------------------|------------------------------------------------------|
| `.panel-drawer`                | panel has a drawer behavior                          |
| `.panel-drawer-collapsed`      | drawer is collapsed to its handle                    |
| `.panel-drawer-expanded`       | drawer is open                                       |
| `.panel-expanding-collapsed`   | expanding panel's arms are collapsed                 |
| `.panel-expanding-expanded`    | expanding panel's arms are extended                  |
| `.panel-hover-expand-active`   | hover-to-expand panel is currently expanded by hover |
| `.panel-hover-expand-locked`   | hover-to-expand panel is click-locked open           |
| `.panel-workspace-hidden`      | workspace-contextual panel is hidden on this workspace |

Example — fade a drawer's handle until hovered, and round a grid row:

```css
.panel-grid-row { border-radius: 4px; }
.panel-drawer-collapsed .panel-drawer-handle { background-color: rgba(255,255,255,0.25); }
```
