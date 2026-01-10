// Background script for handling window creation and other background tasks.
// Compatible with both Chrome and Firefox

const api = typeof browser !== 'undefined' ? browser : chrome;

console.log("TabPaladin background script loaded.");

// Chrome: Set sidePanel behavior
if (api.sidePanel && typeof api.sidePanel.setPanelBehavior === 'function') {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("TabPaladin: Failed to set panel behavior:", error));
}

// Firefox: Toggle sidebar on browser action click
if (api.sidebarAction && typeof api.sidebarAction.toggle === 'function') {
  api.browserAction.onClicked.addListener(() => {
    api.sidebarAction.toggle();
  });
}

// Chrome: Fallback action click handler
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener(() => {
    // If sidePanel API works, this might not trigger
    api.tabs.create({ url: api.runtime.getURL("src/sidepanel/sidepanel.html") });
  });
}

api.runtime.onInstalled.addListener(() => {
  console.log("TabPaladin installed.");
  if (api.sidePanel && typeof api.sidePanel.setPanelBehavior === 'function') {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});
