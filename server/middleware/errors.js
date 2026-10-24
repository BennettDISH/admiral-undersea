// An /api path no route answered is a JSON 404, not the app's HTML page with a 200. And the last
// line of defence: any error a route forwards is logged with the request's id, and the player
// gets a plain sentence, never the error itself. A body the JSON parser refuses is a 4xx.
const { scrubPath } = require('./requestLog');

function apiNotFound(req, res) {
  res.status(404).json({ error: 'No such endpoint' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  console.error(req.id, req.method, scrubPath(req.originalUrl.split('?')[0]), err);
  res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { apiNotFound, errorHandler };
