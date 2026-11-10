const kit = require('fleet-kit/server');

// The bug tracker's widget: index.html loads widget.js from here and the widget posts reports
// back to it (the kit puts it in script-src and connect-src, with 'unsafe-inline' styles for its
// shadow root and blob: images for its screenshot).
const WIDGET_ORIGIN = 'https://bug-tracker-production-4ccb.up.railway.app';

// The media host the boat's sounds and sprites live on (client/public/audio/manifest.json,
// client/public/art/manifest.json): the page fetches each sound and each sprite set's frames file
// (connect-src, not media-src: sounds are decoded for Web Audio), and draws the sets' atlas images
// on canvases (img-src).
const MEDIA_ORIGIN = 'https://media.bennettdishmanmedia.com';

// Everything the pages really load (found by reading client/src and client/index.html), on top
// of the kit's strict defaults (this origin only, no inline script, no framing): index.html loads
// the Black Ops One, Oswald and Share Tech Mono stylesheet from Google Fonts, and the sounds and
// sprites come from the media host. Socket.IO connects back to this host, which 'self' covers.
const CSP_ADD = {
  'style-src': ['https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'connect-src': [MEDIA_ORIGIN],
  'img-src': [MEDIA_ORIGIN],
};

// CSP, HSTS (over https), frame protection, nosniff, the referrer policy and COOP: fleet-kit's.
const securityHeaders = () => kit.securityHeaders({ widgetOrigin: WIDGET_ORIGIN, add: CSP_ADD });

module.exports = { securityHeaders, WIDGET_ORIGIN, MEDIA_ORIGIN };
