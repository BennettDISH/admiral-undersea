// pane-quiet: keeps a game silent in the desktop app's built-in browser, where automated playtests run.
// That browser starts audio without a click and plays it straight to Bennett's headset, so there every
// AudioContext renders to no device (its clock, analysers and ended events still run) and media
// elements play muted. Add ?sound=1 to the address to hear it. Any other browser is left alone.
// Source: games-media/runtime/pane-quiet.js. Each game keeps a copy, loaded before any game code.
(() => {
  if (!/\bClaude\/\d/.test(navigator.userAgent) || /[?&]sound=1(&|$)/.test(location.search)) return;
  const Real = window.AudioContext || window.webkitAudioContext;
  if (Real) {
    class QuietAudioContext extends Real {
      constructor(options) { super({ ...options, sinkId: { type: 'none' } }); }
      setSinkId() { return Promise.resolve(); }
    }
    window.AudioContext = QuietAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = QuietAudioContext;
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { this.muted = true; return play.apply(this, args); };
  document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) e.target.muted = true; }, true);
})();
