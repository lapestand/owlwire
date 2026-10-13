export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FakeClock implements Clock {
  #t: number;

  constructor(start: Date) {
    this.#t = start.getTime();
  }

  now(): Date {
    return new Date(this.#t);
  }

  advance(ms: number): void {
    this.#t += ms;
  }

  set(d: Date): void {
    this.#t = d.getTime();
  }
}
