const helmet = require('helmet');

// The bug tracker's widget: index.html loads widget.js from here and the widget posts reports
// back to it. It also injects a <style> into a shadow root, hence 'unsafe-inline' in styles.
const WIDGET_ORIGIN = 'https://bug-tracker-production-4ccb.up.railway.app';

// Everything the pages really load (found by reading client/src and client/index.html):
// nothing else may run or be fetched. Socket.IO connects back to this host, which 'self' covers.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  // The page has no inline script: Vite's entry is a module file.
  scriptSrc: ["'self'", WIDGET_ORIGIN],
  // index.html loads the Black Ops One, Oswald and Share Tech Mono stylesheet from Google
  // Fonts; React and the widget set inline styles.
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  // blob: is the widget downsizing an attached screenshot.
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", WIDGET_ORIGIN],
  frameAncestors: ["'none'"],
};

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: { directives: CSP_DIRECTIVES },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

module.exports = { securityHeaders, CSP_DIRECTIVES, WIDGET_ORIGIN };
