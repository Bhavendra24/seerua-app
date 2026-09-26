// Phone "Back" closes whatever popup / bottom sheet / chat is open, instead
// of leaving the site. Works for every .modal-backdrop, .bottom-sheet-backdrop
// and the chat panel without touching their own code: when one gets the
// "open" class we add a history entry; Back pops it and closes that overlay.
// (The booking sheet #spSheet has its own handling in service-page.js.)
(function () {
  if (!window.history || !history.pushState || !window.MutationObserver) return;
  var SEL = '.modal-backdrop, .bottom-sheet-backdrop, #chatPanel';
  var stack = [];
  var ignorePop = 0;
  var closingByBack = false;
  var pendingBack = null;
  var linkNavAt = 0;
  // A tap on a real link inside a menu/popup closes it AND navigates —
  // never undo that navigation with history.back().
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href === '#' || /^javascript:/i.test(href) || a.target === '_blank') return;
    linkNavAt = Date.now();
  }, true);

  function closeEl(el) {
    var btn = el.id === 'chatPanel' ? document.getElementById('chatCloseBtn') : el.querySelector('.modal-close');
    if (btn) btn.click();
    if (el.classList.contains('open') && !el.classList.contains('bottom-sheet-backdrop')) {
      // most modals close when their dark backdrop is tapped
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    if (el.classList.contains('open')) el.classList.remove('open');
  }

  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      var el = m.target;
      if (!el.matches || !el.matches(SEL)) return;
      var isOpen = el.classList.contains('open');
      var idx = stack.indexOf(el);
      if (isOpen && idx < 0) {
        stack.push(el);
        if (pendingBack) { clearTimeout(pendingBack); pendingBack = null; return; } // one overlay replaced another: reuse the entry
        try { history.pushState({ seeruaOverlay: 1 }, ''); } catch (e) { /* ignore */ }
      } else if (!isOpen && idx >= 0) {
        stack.splice(idx, 1);
        if (closingByBack) return;
        if (Date.now() - linkNavAt < 1000) return; // closed because a link was tapped — let it navigate
        // closed with its own X / backdrop: drop our history entry too
        pendingBack = setTimeout(function () {
          pendingBack = null;
          // only if our entry is still on top (another popup, e.g. the booking
          // sheet, may have pushed its own entry in the meantime)
          if (history.state && history.state.seeruaOverlay) { ignorePop++; history.back(); }
        }, 0);
      }
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });

  window.addEventListener('popstate', function () {
    if (ignorePop > 0) { ignorePop--; return; }
    if (!stack.length) return;
    var el = stack[stack.length - 1];
    closingByBack = true;
    try { closeEl(el); } finally { closingByBack = false; }
    var i = stack.indexOf(el); if (i >= 0) stack.splice(i, 1);
  });
})();
