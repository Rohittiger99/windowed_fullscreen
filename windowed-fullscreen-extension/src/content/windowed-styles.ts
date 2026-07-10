/**
 * Active-mode stylesheet for Windowed_Fullscreen_Mode, injected by the content
 * script as a single source of truth (see `injectWindowedStyles`). All rules
 * are scoped under the `wfs-windowed` class that the Generic_Core toggles on
 * `<html>`, so they only take effect while the mode is active.
 *
 * The rules use `!important` so they beat YouTube's own inline sizing of the
 * player and the `<video>` element (YouTube sets those via JS; without the
 * override the enlarged player would letterbox to 16:9 and the page content
 * below it would remain visible).
 *
 * No browser Fullscreen API is involved — this is pure CSS layout, so the
 * window stays a normal maximized window and the taskbar remains visible.
 */
export const WINDOWED_STYLE_ELEMENT_ID = "wfs-windowed-styles";

export const WINDOWED_CSS = `
/* Hide the page scrollbar while the player fills the viewport. */
html.wfs-windowed,
html.wfs-windowed body {
  overflow: hidden !important;
}

/* The player fills the whole viewport and sits above all page chrome. */
html.wfs-windowed #movie_player,
html.wfs-windowed .html5-video-player {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  margin: 0 !important;
  z-index: 2147483647 !important;
  background: #000 !important;
}

/* Force YouTube's video container + <video> to fill the player, overriding the
   inline px sizing YouTube applies via its own JS. */
html.wfs-windowed .html5-video-container {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  left: 0 !important;
  top: 0 !important;
}

html.wfs-windowed video.html5-main-video,
html.wfs-windowed video.video-stream {
  width: 100% !important;
  height: 100% !important;
  left: 0 !important;
  top: 0 !important;
  /* Letterbox instead of stretch, preserving aspect ratio. */
  object-fit: contain !important;
}

/* YouTube sets an inline px 'width' (and 'left') on the bottom control bar
   based on the ORIGINAL watch-page player size (~half the screen). When we
   enlarge #movie_player to the full viewport YouTube does not recompute that
   width, so the scrubber, buttons and the settings/chapters menus anchored to
   it stay stuck spanning only the left half. Override the inline sizing so the
   control bar (and everything anchored to it) stretches across the full player.
   The 12px insets match YouTube's own gutter. */
html.wfs-windowed .ytp-chrome-bottom {
  width: auto !important;
  left: 12px !important;
  right: 12px !important;
}

/* Hide YouTube's in-player title / top-chrome overlay (video title, channel,
   share/watch-later buttons and the top gradient). The bottom control bar
   (play/seek/volume/settings) is kept usable. */
html.wfs-windowed .ytp-chrome-top,
html.wfs-windowed .ytp-gradient-top,
html.wfs-windowed .ytp-title,
html.wfs-windowed .ytp-show-cards-title,
html.wfs-windowed .ytp-ce-element {
  display: none !important;
}

/* Safety net: hide the watch-page title/metadata block, the secondary column,
   comments and masthead so nothing shows even if the player is not covering
   them. These are siblings of the player (never its ancestors), so hiding them
   cannot hide the video itself. */
html.wfs-windowed ytd-watch-metadata,
html.wfs-windowed #above-the-fold,
html.wfs-windowed #secondary,
html.wfs-windowed #secondary-inner,
html.wfs-windowed #comments,
html.wfs-windowed #masthead-container,
html.wfs-windowed #masthead {
  display: none !important;
}
`;

/**
 * Inject the windowed-mode stylesheet into `doc` exactly once. Idempotent: if a
 * stylesheet with {@link WINDOWED_STYLE_ELEMENT_ID} already exists, this is a
 * no-op. Uses `textContent` (not `innerHTML`) so pages enforcing Trusted Types
 * (e.g. YouTube) cannot block it.
 */
export function injectWindowedStyles(doc: Document): void {
  if (doc.getElementById(WINDOWED_STYLE_ELEMENT_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = WINDOWED_STYLE_ELEMENT_ID;
  style.textContent = WINDOWED_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
