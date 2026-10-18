type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

// One context for every notification sound. A fresh context per sound starts suspended on iOS/Safari (it is not created
// inside a user gesture), and unclosed contexts pile up until the browser refuses to create more.
let sharedContext: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Constructor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!Constructor) return null;
  try {
    sharedContext = new Constructor();
  } catch {
    sharedContext = null;
  }
  return sharedContext;
}

// Returns the context only while it is running. Before the first tap it is still locked, so the sound is skipped
// (scheduling on a locked context would replay a burst of stale tones once it unlocks).
export function getNotificationAudioContext(): AudioContext | null {
  const context = ensureContext();
  if (!context) return null;
  if (context.state === 'running') return context;
  void context.resume().catch(() => undefined);
  return null;
}

// Unlocks audio from real user gestures. The listeners stay attached because iOS suspends the context again after the
// app has been in the background or a call interrupted it.
export function installNotificationAudioUnlock(): () => void {
  const events = ['touchend', 'click', 'keydown'] as const;
  const options = { capture: true, passive: true } as const;

  const unlock = () => {
    const context = ensureContext();
    if (!context || context.state === 'running') return;
    void context.resume().catch(() => undefined);
    try {
      // Some iOS versions only unlock once a sound has been started inside the gesture.
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, 22050);
      source.connect(context.destination);
      source.start(0);
    } catch {
      // Unlocking is best effort.
    }
  };

  events.forEach(event => document.addEventListener(event, unlock, options));
  return () => events.forEach(event => document.removeEventListener(event, unlock, options));
}
