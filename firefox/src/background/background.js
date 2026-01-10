// Background script for handling sidebar toggle (Firefox version)
console.log("TabPaladin Firefox background script loaded.");

// Toggle sidebar when browser action is clicked
browser.browserAction.onClicked.addListener(() => {
    browser.sidebarAction.toggle();
});

browser.runtime.onInstalled.addListener(() => {
    console.log("TabPaladin installed on Firefox.");
});
