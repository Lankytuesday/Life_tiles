
// Background script to handle extension events
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ defaultNewTab: false });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.defaultNewTab) {
    if (changes.defaultNewTab.newValue) {
      chrome.tabs.update({ url: chrome.runtime.getURL('index.html') });
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.pendingUrl === 'chrome://newtab/' || tab.url === 'chrome://newtab/') {
    chrome.storage.sync.get(['defaultNewTab'], (result) => {
      if (result.defaultNewTab) {
        chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('index.html') });
      }
    });
  }
});
