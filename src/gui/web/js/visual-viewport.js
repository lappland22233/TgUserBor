'use strict';

// Some mobile browsers resize only the visual viewport when a keyboard opens.
// Constrain the chat shell only while a chat input is focused and the visible
// viewport is substantially shorter. Leave pinch zoom and other views alone.
(function () {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let scheduled = false;

  function update() {
    scheduled = false;
    const active = document.activeElement;
    const isChatInput = active && active.matches('input, textarea, [contenteditable="true"]') &&
      Boolean(active.closest('#view-client, .channel-comments-overlay, .forum-overlay'));
    const layoutHeight = root.clientHeight || window.innerHeight;
    const visualBottom = Math.min(layoutHeight, Math.max(0, viewport.offsetTop + viewport.height));
    const isUnzoomed = Math.abs((viewport.scale || 1) - 1) < 0.02;
    if (window.innerWidth <= 900 && isChatInput && isUnzoomed && layoutHeight - visualBottom > 50) {
      root.style.setProperty('--chat-visible-height', `${Math.round(visualBottom)}px`);
      root.dataset.chatKeyboard = 'open';
    } else {
      root.style.removeProperty('--chat-visible-height');
      delete root.dataset.chatKeyboard;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }

  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  schedule();
})();
