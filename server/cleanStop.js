// Stopping when Railway asks (every deploy stops the old server with SIGTERM). A stop that doesn't end in
// exit 0 is mailed as "Deploy crashed", which Bennett got for every update until 11-26: `npm start` ran
// `sh -c "node …"`, npm handed its SIGTERM to sh, sh died of it (npm exit 143), and node, orphaned, was
// killed with the container. The start script now execs node, so npm's signal reaches this process. On
// the first SIGTERM or SIGINT this runs close() and exits 0, after graceMs at the latest, however the
// close went; a second signal (Railway may signal every process while npm passes its own on) is only noted.
// Returns a function that takes the handlers off again.
function exitCleanlyOn(close, { signals = ['SIGTERM', 'SIGINT'], graceMs = 5000, log = (line) => console.log(line), exit = (code) => process.exit(code), target = process } = {}) {
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) {
      log(`${signal} again: already stopping`);
      return;
    }
    stopping = true;
    log(`${signal}: closing`);
    const deadline = setTimeout(() => {
      log(`stopped (gave up waiting after ${graceMs} ms)`);
      exit(0);
    }, graceMs);
    deadline.unref?.();
    try {
      await close();
    } catch (err) {
      log(`closing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(deadline);
    log('stopped');
    exit(0);
  };
  for (const signal of signals) target.on(signal, stop);
  return () => { for (const signal of signals) target.off(signal, stop); };
}

module.exports = { exitCleanlyOn };
