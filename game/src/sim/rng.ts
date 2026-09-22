// 시드가 있는 난수. 같은 시드면 같은 교통이 나와서 실험 조건을 맞출 수 있다.

export class Rng {
  private x: number;

  constructor(seed: number) {
    this.x = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    // xorshift32
    let x = this.x;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.x = x >>> 0;
    return this.x / 4294967296;
  }

  normal(mean: number, sd: number): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  weighted<T>(items: [T, number][]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1][0];
  }
}
