// An original, quiet bell arpeggio. Everything is synthesized on the device.
const NOTES = [
  { frequency: 523.251, offset: 0, duration: 0.95, strength: 0.85 },
  { frequency: 659.255, offset: 0.065, duration: 1.02, strength: 0.9 },
  { frequency: 783.991, offset: 0.14, duration: 1.12, strength: 0.95 },
  { frequency: 1046.502, offset: 0.23, duration: 1.25, strength: 1 },
];
const PARTIALS = [
  { ratio: 1, peak: 0.027, length: 1 },
  { ratio: 2.0015, peak: 0.006, length: 0.72 },
  { ratio: 3.997, peak: 0.002, length: 0.45 },
];
let sharedContext;

/** Schedule on a live or OfflineAudioContext without fetching audio assets. */
export function scheduleCompletionChime(context, when = context.currentTime) {
  if (!Number.isFinite(when)) throw new TypeError('A finite audio start time is required.');
  const startsAt = Math.max(context.currentTime, when);
  const master = context.createGain();
  master.gain.value = 0.55;
  master.connect(context.destination);
  const voices = [];
  let endsAt = startsAt;
  let remaining = 0;

  function partial(frequency, start, duration, peak) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    voices.push({ oscillator, envelope });
    remaining += 1;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.00001, start + duration);
    envelope.gain.linearRampToValueAtTime(0, start + duration + 0.012);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      oscillator.onended = null;
      remaining -= 1;
      if (remaining === 0) master.disconnect();
    };
    const stopAt = start + duration + 0.02;
    oscillator.start(start);
    oscillator.stop(stopAt);
    endsAt = Math.max(endsAt, stopAt);
  }

  try {
    for (const note of NOTES) {
      for (const harmonic of PARTIALS) {
        partial(
          note.frequency * harmonic.ratio,
          startsAt + note.offset,
          note.duration * harmonic.length,
          harmonic.peak * note.strength,
        );
        // A small, shorter reflection adds air without a long reverb tail.
        partial(
          note.frequency * harmonic.ratio,
          startsAt + note.offset + 0.16,
          note.duration * harmonic.length * 0.68,
          harmonic.peak * note.strength * 0.11,
        );
      }
    }
  } catch (error) {
    for (const { oscillator, envelope } of voices) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* It may not have started. */ }
      oscillator.disconnect();
      envelope.disconnect();
    }
    master.disconnect();
    throw error;
  }
  return { endsAt };
}

/** Invoke directly from a user gesture; audio failure never blocks a task. */
export async function playCompletionSound() {
  try {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) return false;
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext();
    const context = sharedContext;
    // Calling resume before the first await preserves iOS gesture activation.
    if (context.state !== 'running') await context.resume();
    if (context.state !== 'running') return false;
    scheduleCompletionChime(context);
    return true;
  } catch {
    return false;
  }
}
