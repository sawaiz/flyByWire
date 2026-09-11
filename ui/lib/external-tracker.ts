/** Fixed-template patch tracking with brief coast + reacquisition after loss.
 * Correlation is a heuristic, not a probability. */
export type GrayFrame = { width: number; height: number; data: Uint8Array };
export type Box = { x: number; y: number; width: number; height: number };
export type Track = {
  box: Box | null;
  score: number;
  status: 'tracking' | 'lost' | 'unselected';
  dx: number | null;
  dy: number | null;
};
const N = 16;
/** Consecutive weak frames before declaring lost (absorbs takeoff hitch / blur). */
const MISS_LIMIT = 4;

function sample(frame: GrayFrame, box: Box) {
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.width > frame.width ||
    box.y + box.height > frame.height
  )
    return null;
  const out = new Float32Array(N * N);
  let mean = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const xx = Math.min(
        frame.width - 1,
        Math.floor(box.x + ((x + 0.5) * box.width) / N),
      );
      const yy = Math.min(
        frame.height - 1,
        Math.floor(box.y + ((y + 0.5) * box.height) / N),
      );
      const i = y * N + x;
      out[i] = frame.data[yy * frame.width + xx];
      mean += out[i];
    }
  mean /= out.length;
  let energy = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    energy += out[i] * out[i];
  }
  if (energy / out.length < 36) return null;
  const norm = Math.sqrt(energy);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function search(
  frame: GrayFrame,
  template: Float32Array,
  prev: Box,
  origin: Box,
  radius: number,
  step: number,
  scales: number[],
) {
  const candidates: { box: Box; score: number }[] = [];
  const cx = prev.x + prev.width / 2;
  const cy = prev.y + prev.height / 2;
  for (const scale of scales) {
    const w = prev.width * scale;
    const h = prev.height * scale;
    if (w < origin.width * 0.45 || w > origin.width * 2.5 || h < 10) continue;
    for (let dy = -radius; dy <= radius; dy += step)
      for (let dx = -radius; dx <= radius; dx += step) {
        const box = {
          x: cx + dx - w / 2,
          y: cy + dy - h / 2,
          width: w,
          height: h,
        };
        const values = sample(frame, box);
        if (!values) continue;
        let score = 0;
        for (let i = 0; i < values.length; i++) score += values[i] * template[i];
        candidates.push({ box, score });
      }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function rivalOf(
  best: { box: Box; score: number },
  candidates: { box: Box; score: number }[],
) {
  const thresh = Math.max(8, Math.min(best.box.width, best.box.height) * 0.75);
  return candidates.find((c) => {
    const d = Math.hypot(
      c.box.x + c.box.width / 2 - best.box.x - best.box.width / 2,
      c.box.y + c.box.height / 2 - best.box.y - best.box.height / 2,
    );
    return d > thresh;
  });
}

export class PatchTracker {
  template: Float32Array | null = null;
  box: Box | null = null;
  origin: Box | null = null;
  lost = false;
  missStreak = 0;

  select(frame: GrayFrame, box: Box) {
    this.clear();
    if (
      box.width < 10 ||
      box.height < 10 ||
      box.width > 120 ||
      box.height > 120
    )
      return false;
    const template = sample(frame, box);
    if (!template) return false;
    this.template = template;
    this.box = { ...box };
    this.origin = { ...box };
    return true;
  }

  clear() {
    this.template = null;
    this.box = null;
    this.origin = null;
    this.lost = false;
    this.missStreak = 0;
  }

  private emit(
    box: Box | null,
    score: number,
    status: Track['status'],
    origin: Box,
  ): Track {
    if (!box)
      return { box: null, score, status, dx: null, dy: null };
    return {
      box: { ...box },
      score,
      status,
      dx: box.x + box.width / 2 - origin.x - origin.width / 2,
      dy: box.y + box.height / 2 - origin.y - origin.height / 2,
    };
  }

  update(frame: GrayFrame): Track {
    if (!this.template || !this.box || !this.origin)
      return { box: null, score: 0, status: 'unselected', dx: null, dy: null };

    const origin = this.origin;
    const template = this.template;

    if (this.lost) {
      // Reacquire: wider / coarser search from last box, then origin.
      let cands = search(
        frame,
        template,
        this.box,
        origin,
        48,
        4,
        [0.85, 1, 1.2],
      );
      if (!cands.length)
        cands = search(frame, template, origin, origin, 72, 6, [0.9, 1, 1.25]);
      const best = cands[0];
      const rival = best ? rivalOf(best, cands) : undefined;
      if (
        best &&
        best.score >= 0.7 &&
        (!rival || best.score - rival.score >= 0.07)
      ) {
        this.lost = false;
        this.missStreak = 0;
        this.box = best.box;
        if (best.score >= 0.85) {
          const refreshed = sample(frame, best.box);
          if (refreshed) {
            for (let i = 0; i < template.length; i++)
              template[i] = template[i] * 0.7 + refreshed[i] * 0.3;
            let e = 0;
            for (let i = 0; i < template.length; i++) e += template[i] * template[i];
            const n = Math.sqrt(e) || 1;
            for (let i = 0; i < template.length; i++) template[i] /= n;
          }
        }
        return this.emit(this.box, best.score, 'tracking', origin);
      }
      return this.emit(null, best?.score || 0, 'lost', origin);
    }

    // Normal track: slightly wider radius to survive liftoff jump.
    const cands = search(
      frame,
      template,
      this.box,
      origin,
      32,
      2,
      [0.9, 1, 1.1],
    );
    const best = cands[0];
    const rival = best ? rivalOf(best, cands) : undefined;
    const weak =
      !best ||
      best.score < 0.58 ||
      (rival && best.score - rival.score < 0.05);

    if (weak) {
      this.missStreak += 1;
      if (this.missStreak < MISS_LIMIT) {
        // Coast on last box through brief blur / UI hitch.
        return this.emit(this.box, best?.score || 0, 'tracking', origin);
      }
      this.lost = true;
      this.missStreak = 0;
      return this.emit(null, best?.score || 0, 'lost', origin);
    }

    this.missStreak = 0;
    this.box = best.box;
    if (best.score >= 0.9) {
      const refreshed = sample(frame, best.box);
      if (refreshed) {
        for (let i = 0; i < template.length; i++)
          template[i] = template[i] * 0.85 + refreshed[i] * 0.15;
        let e = 0;
        for (let i = 0; i < template.length; i++) e += template[i] * template[i];
        const n = Math.sqrt(e) || 1;
        for (let i = 0; i < template.length; i++) template[i] /= n;
      }
    }
    return this.emit(this.box, best.score, 'tracking', origin);
  }
}
