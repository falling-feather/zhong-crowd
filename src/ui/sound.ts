export class Sound {
  private context: AudioContext | null = null;
  enabled = false;
  async enable(enabled: boolean) {
    if (enabled) {
      this.context ??= new AudioContext();
      await this.context.resume();
    }
    this.enabled = enabled;
    if (enabled) this.cue('select');
  }
  cue(kind: 'select' | 'run' | 'success' | 'review') {
    const context = this.context;
    if (!this.enabled || !context || context.state !== 'running') return;
    const notes = kind === 'success' ? [392, 493.88, 587.33] : kind === 'run' ? [220, 330] : kind === 'review' ? [293.66, 261.63] : [523.25];
    notes.forEach((frequency, index) => {
      const start = context.currentTime + index * .085;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.035, start + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .3);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(start); oscillator.stop(start + .32);
    });
  }
}
