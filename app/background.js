/* global chrome */
chrome.action.onClicked.addListener(() => {
  chrome.system.display.getInfo((displays) => {
    const display = displays[0];
    const leftPos = display.workArea.width - 400;

    chrome.windows.create({
      url: 'src/popup/popup.html',
      type: 'popup',
      width: 360,
      height: 500,
      top: 70,
      left: leftPos
    });
  });
});
