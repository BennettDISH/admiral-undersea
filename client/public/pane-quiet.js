// pane-quiet: keeps a game silent in the desktop app's built-in browser, where automated playtests run.
// That browser starts audio without a click and plays it straight to Bennett's headset, so there every
// AudioContext renders to no device (its clock, analysers and ended events still run) and media
// elements play muted. Add ?sound=1 to the address to hear it. Any other browser is left alone.
// Source: games-media/runtime/pane-quiet.js. Each game keeps a copy, loaded before any game code.
(() => {
  if (/[?&]sound=1(&|$)/.test(location.search)) return;
  const ua = navigator.userAgent;
  // Below 768 px wide the pane emulates a phone, and its Android user agent drops the Claude/<n> token.
  // Emulation leaves two things alone: navigator.platform still names the desktop, and window.chrome is
  // still Electron's empty object (Chrome, Edge and Brave give it loadTimes, csi and app; Firefox and
  // Safari have none). A real phone's platform never starts with Win or Mac, so phones keep their sound.
  const emulatedPhone = /Android|iPhone|iPad/.test(ua) && /^(Win|Mac)/.test(navigator.platform)
    && !!window.chrome && Object.keys(window.chrome).length === 0;
  if (!/\bClaude\/\d/.test(ua) && !emulatedPhone) return;
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
