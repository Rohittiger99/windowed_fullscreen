/**
 * Generic active-mode stylesheet for Windowed_Fullscreen_Mode, injected once by
 * the content script (see {@link injectWindowedStyles}).
 *
 * This module is deliberately SITE-INDEPENDENT: it contains only rules that
 * reference the extension's own classes (`wfs-windowed` toggled on `<html>` by
 * the Generic_Core, and `wfs-button` on the injected control). It hard-codes no
 * site selectors — all site-specific active-mode CSS is supplied by the active
 * Site_Adapter via {@link SiteAdapter.getActiveModeCss} and appended at
 * injection time. That keeps the architectural rule intact: a site's DOM
 * knowledge (including its CSS) lives only in its adapter (Requirement 6.1).
 *
 * No browser Fullscreen API is involved — this is pure CSS layout, so the
 * window stays a normal maximized window and the taskbar remains visible.
 */
export const WINDOWED_STYLE_ELEMENT_ID = "wfs-windowed-styles";

/**
 * Site-independent base CSS. Covers the injected button's always-on affordances
 * (focus/hover/active) and the generic scrollbar hiding while the mode is
 * active. Site-specific player/chrome rules are contributed by the adapter.
 */
export const WINDOWED_BASE_CSS = `
/* -------------------------------------------------------------------------
   Injected Windowed_Fullscreen_Button affordances.

   These rules are intentionally NOT scoped under .wfs-windowed: the button sits
   in the site's control bar at all times (mode active or not), so it always
   needs a visible focus ring, hover feedback, and a clear engaged/active state.
   They reference only the extension's own class, so they remain site-agnostic.
   ------------------------------------------------------------------------- */

/* Hover: brighten the (semi-transparent) glyph. */
.wfs-button:hover {
  opacity: 1 !important;
}

/* Keyboard focus: a clearly visible ring for keyboard users. Uses
   :focus-visible so it shows for keyboard navigation but not on mouse click.
   Inset offset keeps it inside the control bar. */
.wfs-button:focus-visible {
  outline: 2px solid #3ea6ff !important;
  outline-offset: -2px !important;
  opacity: 1 !important;
}

/* Engaged/active state (Req 2.10): an accent underline plus full opacity,
   giving sighted users the same signal screen-reader users get from
   aria-pressed="true". */
.wfs-button.is-active {
  opacity: 1 !important;
  box-shadow: inset 0 -3px 0 0 #3ea6ff !important;
}

/* Hide the page scrollbar while the player fills the viewport (generic). */
html.wfs-windowed,
html.wfs-windowed body {
  overflow: hidden !important;
}
`;

/**
 * @deprecated Prefer {@link WINDOWED_BASE_CSS} plus the adapter's
 * {@link SiteAdapter.getActiveModeCss}. Retained as an alias for the generic
 * base so any external reference keeps compiling.
 */
export const WINDOWED_CSS = WINDOWED_BASE_CSS;

/**
 * Inject the windowed-mode stylesheet into `doc` exactly once. The generic base
 * CSS is always included; `siteCss` (supplied by the active Site_Adapter) is
 * appended so a site's active-mode rules ship without this module knowing any
 * site selectors.
 *
 * Idempotent: if a stylesheet with {@link WINDOWED_STYLE_ELEMENT_ID} already
 * exists, this is a no-op. Uses `textContent` (not `innerHTML`) so pages
 * enforcing Trusted Types (e.g. YouTube) cannot block it.
 */
export function injectWindowedStyles(doc: Document, siteCss = ""): void {
  if (doc.getElementById(WINDOWED_STYLE_ELEMENT_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = WINDOWED_STYLE_ELEMENT_ID;
  style.textContent = siteCss ? `${WINDOWED_BASE_CSS}\n${siteCss}` : WINDOWED_BASE_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
