(function initGlobalShortcutBlocking() {
  function onKeydown(event) {
    const key = (event.key || '').toLowerCase();
    const isF12 = key === 'f12' || event.keyCode === 123;
    const isCtrlShiftC = event.ctrlKey && event.shiftKey && key === 'c';

    if (isF12 || isCtrlShiftC) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  document.addEventListener('keydown', onKeydown);
})();
