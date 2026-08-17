import { describe, expect, it } from 'vitest'
import { AsyncEventQueue } from '../src/async-event-queue.ts'

/** Drain every currently-available value without blocking on an empty queue. */
async function drainAvailable<T>(queue: AsyncEventQueue<T>, count: number): Promise<T[]> {
  const values: T[] = []
  const iterator = queue[Symbol.asyncIterator]()
  for (let i = 0; i < count; i++) {
    const result = await iterator.next()
    if (result.done) break
    values.push(result.value)
  }
  return values
}

describe('AsyncEventQueue', () => {
  it('delivers buffered values in order to a for-await consumer', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.end()
    const values: number[] = []
    for await (const value of queue) values.push(value)
    expect(values).toEqual([1, 2])
  })

  it('delivers a push directly to an already-waiting consumer', async () => {
    const queue = new AsyncEventQueue<string>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.push('hello')
    await expect(pending).resolves.toEqual({ value: 'hello', done: false })
  })

  it('a push after end() is silently dropped', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.end()
    queue.push(2)
    const values = await drainAvailable(queue, 5)
    expect(values).toEqual([1])
  })

  it('a push after fail() is silently dropped and the buffer is discarded', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.fail(new Error('boom'))
    queue.push(2)
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('boom')
  })

  it('rejects a waiting consumer immediately on fail()', async () => {
    const queue = new AsyncEventQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.fail(new Error('transport closed'))
    await expect(pending).rejects.toThrow('transport closed')
  })

  it('a second concurrent next() rejects: exactly one consumer is supported', async () => {
    const queue = new AsyncEventQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()
    const first = iterator.next()
    await expect(iterator.next()).rejects.toThrow(/exactly one concurrent consumer/)
    queue.push(1)
    await expect(first).resolves.toEqual({ value: 1, done: false })
  })

  it('end() then end() again stays idempotent', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.end()
    queue.end()
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('fail() after end() is a no-op: the queue stays ended, not failed', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.end()
    queue.fail(new Error('too late'))
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('fail() after fail() is a no-op: the first failure wins', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.fail(new Error('first'))
    queue.fail(new Error('second'))
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('first')
  })
})
