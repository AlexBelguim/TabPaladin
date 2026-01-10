// Background script for handling window creation and other background tasks.
console.log("TabWorkflow background script loaded.");

// Set behavior on every load to ensure it persists and for debugging
if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("TabPaladin: Failed to set panel behavior:", error));
} else {
  console.warn("TabPaladin: chrome.sidePanel API is not available. Ensure you are using Chrome 116+.");
}

// Fallback: If sidePanel API is missing, clicking the action should open the index page in a tab.
chrome.action.onClicked.addListener(() => {
  // If sidePanel API works, this might not trigger if setPanelBehavior worked.
  // But if it didn't work, this handles it.
  chrome.tabs.create({ url: chrome.runtime.getURL("src/sidepanel/sidepanel.html") });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("TabPaladin installed.");
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});
