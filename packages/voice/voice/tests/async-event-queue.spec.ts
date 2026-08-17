import { describe, expect, it } from 'vitest'
import { AsyncEventQueue } from '../src/async-event-queue.ts'

describe('AsyncEventQueue', () => {
  it('delivers buffered values before a consumer attaches', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.end()
    const seen: number[] = []
    for await (const value of queue) seen.push(value)
    expect(seen).toEqual([1, 2])
  })

  it('delivers a value pushed while a consumer is already waiting', async () => {
    const queue = new AsyncEventQueue<string>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.push('hello')
    await expect(pending).resolves.toEqual({ value: 'hello', done: false })
  })

  it('resolves done:true once ended, after draining the buffer', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.end()
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false })
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('resolves a waiting consumer with done:true when ended with an empty buffer', async () => {
    const queue = new AsyncEventQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.end()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })

  it('rejects the next call once failed', async () => {
    const queue = new AsyncEventQueue<number>()
    const failure = new Error('transport dropped')
    queue.fail(failure)
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBe(failure)
  })

  it('rejects a waiting consumer when failed', async () => {
    const queue = new AsyncEventQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    const failure = new Error('transport dropped')
    queue.fail(failure)
    await expect(pending).rejects.toBe(failure)
  })

  it('discards the buffer on failure', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.fail(new Error('dropped'))
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('dropped')
  })

  it('ignores push, end, and fail after a terminal state', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.end()
    queue.push(1)
    queue.end()
    queue.fail(new Error('ignored'))
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })

    const failed = new AsyncEventQueue<number>()
    failed.fail(new Error('first'))
    failed.push(1)
    failed.end()
    failed.fail(new Error('second'))
    await expect(failed[Symbol.asyncIterator]().next()).rejects.toThrow('first')
  })

  it('rejects a second concurrent consumer', async () => {
    const queue = new AsyncEventQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()
    void iterator.next()
    await expect(iterator.next()).rejects.toThrow('AsyncEventQueue supports exactly one concurrent consumer')
  })
})
