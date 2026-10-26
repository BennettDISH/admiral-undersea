const kit = require('fleet-kit/server');

// The bug tracker's widget: index.html loads widget.js from here and the widget posts reports
// back to it (the kit puts it in script-src and connect-src, with 'unsafe-inline' styles for its
// shadow root and blob: images for its screenshot).
const WIDGET_ORIGIN = 'https://bug-tracker-production-4ccb.up.railway.app';

// Everything the pages really load (found by reading client/src and client/index.html), on top
// of the kit's strict defaults (this origin only, no inline script, no framing): index.html loads
// the Black Ops One, Oswald and Share Tech Mono stylesheet from Google Fonts. Socket.IO connects
// back to this host, which 'self' covers.
const CSP_ADD = {
  'style-src': ['https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
};

// CSP, HSTS (over https), frame protection, nosniff, the referrer policy and COOP: fleet-kit's.
const securityHeaders = () => kit.securityHeaders({ widgetOrigin: WIDGET_ORIGIN, add: CSP_ADD });

module.exports = { securityHeaders, WIDGET_ORIGIN };
