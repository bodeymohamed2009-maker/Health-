/**
 * Web Audio API synthesizer for soft, clinical-style cardiac pulse cues
 * synchronized in real time with detected heartbeats.
 */
export class PulseAudioSynthesizer {
  private ctx: AudioContext | null = null;

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtor) return null;
      try {
        this.ctx = new AudioCtor();
      } catch {
        return null;
      }
    }
    return this.ctx;
  }

  public unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // Ignore browser autoplay restriction until next gesture
      });
    }
  }

  /**
   * Plays a gentle, short sine/triangle pulse tone (~650-760 Hz depending on BPM)
   * shaped with a click-free envelope to mimic bedside pulse oximeter cues.
   */
  public playHeartbeatBeep(bpm?: number | null): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
      return;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const safeBpm = bpm && Number.isFinite(bpm) ? bpm : 72;
    const freqHz = Math.max(
      620,
      Math.min(780, 645 + (safeBpm - 60) * 1.35)
    );

    osc.type = "sine";
    osc.frequency.setValueAtTime(freqHz, now);

    // Smooth 6ms attack + 72ms exponential decay to prevent speaker clicks
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.065, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.082);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.09);
  }

  public dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
