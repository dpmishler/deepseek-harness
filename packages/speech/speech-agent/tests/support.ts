/**
 * Minimal single-consumer async queue used only by this package's tests to
 * script `SttSession.events`/`TtsSession.events` deterministically. Not part
 * of the public API — `@deepseek-ai/dsh-speech` providers use their own
 * transport-backed iterables; this exists purely so a test can push events on
 * its own schedule and signal completion with `end()`.
 */
export class TestEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | undefined
  private ended = false

  push(value: T): void {
    if (this.ended) return
    if (this.waiting !== undefined) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value, done: false })
    } else {
      this.buffered.push(value)
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.waiting !== undefined) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: undefined, done: true })
    }
  }

  /** Reject the next (or currently pending) `next()` call — scripts a real stream failure for error-path tests. */
  fail(error: unknown): void {
    if (this.ended) return
    this.ended = true
    if (this.rejecting !== undefined) {
      const reject = this.rejecting
      this.rejecting = undefined
      this.waiting = undefined
      reject(error)
      return
    }
    this.failure = { error }
  }

  private rejecting: ((error: unknown) => void) | undefined
  private failure: { error: unknown } | undefined

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false })
        }
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- caller of fail() chooses the value.
        if (this.failure !== undefined) return Promise.reject(this.failure.error)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve, reject) => { this.waiting = resolve; this.rejecting = reject })
      },
    }
  }
}

/**
 * Poll `predicate` after each microtask turn until it returns `true` or
 * `maxTicks` is exhausted, then assert it held. Deterministic and immune to
 * the exact number of internal microtask hops a change to the production
 * code might add or remove, unlike a fixed `await Promise.resolve()` count.
 * @param predicate - checked after every tick; returning `true` ends the wait.
 * @param maxTicks - upper bound on ticks before failing loudly (default 50).
 */
export async function waitFor(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition did not become true within ${maxTicks} microtask ticks`)
  }
}
