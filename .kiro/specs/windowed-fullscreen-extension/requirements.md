# Requirements Document

## Introduction

The Windowed Fullscreen Extension is a Chromium browser extension (Manifest V3) for Google Chrome and Microsoft Edge that adds a "windowed fullscreen" viewing mode to video sites, beginning with YouTube. Native browser fullscreen covers the Windows taskbar and makes switching to other applications awkward. This extension introduces a separate control, placed next to a site's native fullscreen button, that expands the video player to fill the entire browser viewport and hides surrounding site chrome (header, sidebar, comments, scrollbar) WITHOUT invoking the browser's native Fullscreen API. Because the browser remains a normal maximized window, the taskbar stays visible and standard window switching continues to work.

The extension leaves each site's native fullscreen control untouched, persists user preferences across sessions, exposes a settings/options page, supports a configurable keyboard shortcut, and is built around a generic core with per-site adapters so additional video platforms can be added later. The extension is free and includes a donation link.

## Glossary

- **Extension**: The Windowed Fullscreen Extension software package, built on Manifest V3, installed in a Chromium-based browser.
- **Content_Script**: The portion of the Extension injected into a supported web page that manipulates the page DOM and renders the Windowed_Fullscreen_Button.
- **Service_Worker**: The Manifest V3 background service worker of the Extension that handles keyboard commands, storage coordination, and messaging.
- **Options_Page**: The Extension settings page where the User configures preferences.
- **Popup**: The Extension toolbar popup surface that provides quick access to status and links.
- **Windowed_Fullscreen_Button**: A control rendered by the Content_Script next to the site's native fullscreen control that toggles Windowed_Fullscreen_Mode.
- **Native_Fullscreen_Button**: The video site's own existing fullscreen control, which the Extension does not modify.
- **Windowed_Fullscreen_Mode**: A display state in which the video player fills the entire browser viewport and site chrome is hidden, achieved without calling the browser Fullscreen API.
- **Native_Fullscreen_Mode**: The browser display state produced by the Fullscreen API, which covers the operating system taskbar.
- **Site_Adapter**: A per-site module that provides site-specific DOM selectors and behaviors (locating the player, the native control, and the chrome elements to hide) to the generic core.
- **Generic_Core**: The site-independent logic of the Extension that drives Windowed_Fullscreen_Mode using data supplied by a Site_Adapter.
- **Site_Chrome**: Page elements outside the video player (for example header, sidebar, comments, scrollbar) that are hidden during Windowed_Fullscreen_Mode.
- **Keyboard_Shortcut**: A User-configurable key combination registered with the browser that toggles Windowed_Fullscreen_Mode.
- **Preference_Store**: The persistent storage used by the Extension to retain User preferences across browser sessions.
- **User**: The person interacting with the browser and the Extension.
- **Supported_Site**: A website for which a Site_Adapter is registered in the Extension; YouTube is the v1 Supported_Site.
- **Donation_Link**: A hyperlink to an external donation page presented to the User.

## Requirements

### Requirement 1: Inject the windowed-fullscreen control

**User Story:** As a User, I want a dedicated windowed-fullscreen button next to the native fullscreen control, so that I can choose a viewing mode that keeps the taskbar visible.

#### Acceptance Criteria

1. WHEN the video player controls on a Supported_Site become present in the page, THE Content_Script SHALL render the Windowed_Fullscreen_Button within 2 seconds, positioned in the same controls container as and immediately adjacent to the Native_Fullscreen_Button.
2. THE Content_Script SHALL leave the Native_Fullscreen_Button unmodified, retaining its original position, dimensions, label, and event handlers.
3. WHEN the Windowed_Fullscreen_Button is rendered, THE Content_Script SHALL assign it an accessible name identifying the control as the windowed-fullscreen toggle, exposed to assistive technologies and distinct from the Native_Fullscreen_Button accessible name.
4. IF an instance of the Windowed_Fullscreen_Button is already present in the player controls when a render is attempted, THEN THE Content_Script SHALL retain exactly one instance and SHALL NOT create a duplicate.
5. WHEN the Supported_Site player navigates to a different video without a full page reload, THE Content_Script SHALL re-verify within 2 seconds that exactly one Windowed_Fullscreen_Button remains adjacent to the Native_Fullscreen_Button, and SHALL re-render it if absent.
6. IF the Native_Fullscreen_Button cannot be located in the player controls, THEN THE Content_Script SHALL NOT render the Windowed_Fullscreen_Button and SHALL retry detection at intervals not exceeding 2 seconds for a maximum of 10 attempts.

### Requirement 2: Toggle windowed fullscreen mode

**User Story:** As a User, I want to enter and exit windowed fullscreen, so that the video fills the viewport while the taskbar stays visible.

#### Acceptance Criteria

1. WHEN the User activates the Windowed_Fullscreen_Button while Windowed_Fullscreen_Mode is inactive, THE Generic_Core SHALL enter Windowed_Fullscreen_Mode within 200 milliseconds.
2. WHEN the Generic_Core enters Windowed_Fullscreen_Mode, THE Generic_Core SHALL expand the video player to occupy 100 percent of the browser viewport width and 100 percent of the browser viewport height.
3. WHEN the Generic_Core enters Windowed_Fullscreen_Mode, THE Generic_Core SHALL hide all Site_Chrome elements defined by the active Site_Adapter.
4. WHILE Windowed_Fullscreen_Mode is active, THE Generic_Core SHALL refrain from calling the browser Fullscreen API.
5. WHEN the User activates the Windowed_Fullscreen_Button while Windowed_Fullscreen_Mode is active, THE Generic_Core SHALL exit Windowed_Fullscreen_Mode within 200 milliseconds.
6. WHEN the Generic_Core exits Windowed_Fullscreen_Mode, THE Generic_Core SHALL restore the video player dimensions and the visibility of every Site_Chrome element to the layout state recorded immediately before Windowed_Fullscreen_Mode was entered.
7. WHEN the User presses the Escape key while Windowed_Fullscreen_Mode is active, THE Generic_Core SHALL exit Windowed_Fullscreen_Mode within 200 milliseconds.
8. WHEN the Generic_Core enters Windowed_Fullscreen_Mode, THE Generic_Core SHALL record the current video player dimensions and the current visibility of each Site_Chrome element as the prior layout state used for restoration on exit.
9. IF the active Site_Adapter defines no Site_Chrome elements when the Generic_Core enters Windowed_Fullscreen_Mode, THEN THE Generic_Core SHALL complete entry into Windowed_Fullscreen_Mode and expand the video player without hiding any Site_Chrome elements.
10. WHILE Windowed_Fullscreen_Mode is active, THE Generic_Core SHALL display the Windowed_Fullscreen_Button in its active (engaged) state, and WHILE Windowed_Fullscreen_Mode is inactive, THE Generic_Core SHALL display the Windowed_Fullscreen_Button in its inactive state.

### Requirement 3: Keyboard shortcut handling

**User Story:** As a User, I want a configurable keyboard shortcut, so that I can toggle windowed fullscreen without using the mouse.

#### Acceptance Criteria

1. WHEN the User triggers the configured Keyboard_Shortcut on a Supported_Site, THE Service_Worker SHALL signal the Content_Script to toggle Windowed_Fullscreen_Mode within 500 milliseconds.
2. WHERE the User has assigned a custom key combination to the Keyboard_Shortcut consisting of at least one modifier key and exactly one non-modifier key, THE Extension SHALL register the custom key combination as the active trigger for toggling Windowed_Fullscreen_Mode.
3. THE Extension SHALL expose at least one additional unassigned configurable shortcut slot reserved for future actions.
4. IF a requested Keyboard_Shortcut combination conflicts with a combination already reserved by the browser, THEN THE Extension SHALL retain the previous Keyboard_Shortcut assignment and display a message identifying the conflicting combination.
5. WHEN the User triggers the configured Keyboard_Shortcut on a site that is not a Supported_Site, THE Extension SHALL NOT toggle Windowed_Fullscreen_Mode.
6. IF the Service_Worker cannot reach the Content_Script when the Keyboard_Shortcut is triggered, THEN THE Extension SHALL leave Windowed_Fullscreen_Mode unchanged and display a failure indication.

### Requirement 4: Preference persistence

**User Story:** As a User, I want my preferences remembered, so that I do not have to reconfigure the Extension each session.

#### Acceptance Criteria

1. WHEN the User changes a preference, THE Extension SHALL write the updated preference value to the Preference_Store within 1 second.
2. IF writing a preference to the Preference_Store fails, THEN THE Extension SHALL retain the previously stored preference value unchanged and display an error indication that the preference was not saved.
3. WHEN a browser session starts, THE Extension SHALL load all stored preferences from the Preference_Store within 2 seconds of Extension initialization.
4. IF the Preference_Store is unavailable or its stored preferences cannot be read, THEN THE Extension SHALL apply documented default preference values and display an error indication that stored preferences could not be loaded.
5. WHERE the User enables auto-apply for a Supported_Site, WHEN the video player on that Supported_Site finishes loading, THE Content_Script SHALL enter Windowed_Fullscreen_Mode within 1 second.
6. THE Extension SHALL store preferences on a per-Supported_Site basis, such that a preference change for one Supported_Site does not alter the stored preferences of any other Supported_Site.
7. IF no stored preference exists for a Supported_Site, THEN THE Extension SHALL apply the documented default preference values for that Supported_Site.

### Requirement 5: Settings and options page

**User Story:** As a User, I want a settings page, so that I can view and adjust the Extension's behavior.

#### Acceptance Criteria

1. THE Options_Page SHALL display a control for each User-configurable preference, including the auto-apply behavior preference and a per-Supported_Site setting for every Supported_Site, where each control reflects the valid input values accepted for that preference.
2. THE Options_Page SHALL display a control for configuring the Keyboard_Shortcut.
3. WHEN the User changes a control on the Options_Page to a valid value, THE Options_Page SHALL persist the change to the Preference_Store within 1 second and display a confirmation that the change was saved.
4. WHEN the Options_Page opens, THE Options_Page SHALL display the current preference value loaded from the Preference_Store for each control.
5. WHEN the Options_Page opens AND no stored value exists in the Preference_Store for a preference, THE Options_Page SHALL display the predefined default value for that preference.
6. IF the User changes a control to a value outside the valid input values accepted for that preference, THEN THE Options_Page SHALL reject the change, retain the previously persisted value, and display an error indication identifying the invalid input.
7. IF persisting a change to the Preference_Store fails, THEN THE Options_Page SHALL retain the previously persisted value and display an error indication that the change was not saved.

### Requirement 6: Per-site adapter architecture

**User Story:** As a maintainer, I want a generic core with per-site adapters, so that additional video sites can be supported without reworking core logic.

#### Acceptance Criteria

1. THE Generic_Core SHALL drive Windowed_Fullscreen_Mode using only the player reference, native control reference, and Site_Chrome selectors supplied by the active Site_Adapter, and SHALL NOT reference any site-specific selector or identifier defined outside the active Site_Adapter.
2. IF the active Site_Adapter does not supply all of the player reference, the native control reference, and the Site_Chrome selectors, THEN THE Generic_Core SHALL NOT enter Windowed_Fullscreen_Mode and SHALL preserve the pre-activation page state.
3. WHERE a Site_Adapter matches the current site, WHEN the page finishes loading, THE Extension SHALL activate that Site_Adapter within 1000 milliseconds.
4. IF more than one registered Site_Adapter matches the current site, THEN THE Extension SHALL activate exactly one Site_Adapter, selected by registration order.
5. THE Extension SHALL include exactly one Site_Adapter for YouTube.
6. WHERE no Site_Adapter matches the current site, THE Content_Script SHALL NOT render the Windowed_Fullscreen_Button.

### Requirement 7: Graceful handling of missing or changed page structure

**User Story:** As a User, I want the Extension to fail safely when the page structure is unexpected, so that my browsing is not disrupted.

#### Acceptance Criteria

1. IF the active Site_Adapter cannot locate the video player within its configured detection window of at most 10 seconds after the Content_Script begins detection, THEN THE Content_Script SHALL skip rendering the Windowed_Fullscreen_Button, record a diagnostic log entry indicating the player was not found, and leave the page unchanged.
2. IF the active Site_Adapter cannot locate the Native_Fullscreen_Button within its configured detection window of at most 10 seconds after the Content_Script begins detection, THEN THE Content_Script SHALL skip rendering the Windowed_Fullscreen_Button, record a diagnostic log entry indicating the native control was not found, and leave the page unchanged.
3. IF one or more Site_Chrome elements defined by the active Site_Adapter are absent when entering Windowed_Fullscreen_Mode, THEN THE Generic_Core SHALL hide all located Site_Chrome elements, record a diagnostic log entry identifying each absent element, and continue entering Windowed_Fullscreen_Mode.
4. WHILE Windowed_Fullscreen_Mode is inactive, IF the page DOM changes such that the Windowed_Fullscreen_Button is removed, THEN THE Content_Script SHALL re-render the Windowed_Fullscreen_Button within 2 seconds of the player controls becoming available again, for up to 5 re-render attempts.
5. IF the player controls do not become available within 30 seconds after the Windowed_Fullscreen_Button is removed while Windowed_Fullscreen_Mode is inactive, THEN THE Content_Script SHALL stop attempting to re-render the Windowed_Fullscreen_Button and record a diagnostic log entry indicating re-render was abandoned.
6. WHILE Windowed_Fullscreen_Mode is active, IF the page DOM changes such that the video player is removed, THEN THE Generic_Core SHALL exit Windowed_Fullscreen_Mode, restore the previously hidden Site_Chrome elements, and record a diagnostic log entry indicating the player was lost.

### Requirement 8: Donation link

**User Story:** As a User, I want a donation link, so that I can support the Extension if I choose.

#### Acceptance Criteria

1. WHEN the Options_Page is opened, THE Options_Page SHALL display the Donation_Link with a visible text label identifying it as a donation link.
2. WHILE the Options_Page is displayed, THE Options_Page SHALL keep the Donation_Link visible and activatable.
3. WHEN the User activates the Donation_Link, THE Extension SHALL open the external donation page in a new browser tab within 2 seconds while keeping the Options_Page open in its original tab.
4. IF the external donation page cannot be opened when the User activates the Donation_Link, THEN THE Extension SHALL display an error message indicating that the donation page could not be opened and SHALL keep the Options_Page open and unchanged.
