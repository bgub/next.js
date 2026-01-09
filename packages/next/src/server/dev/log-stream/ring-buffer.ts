/**
 * Fast, bounded ring buffer for log events
 *
 * Properties:
 * - Fixed size (no unbounded growth)
 * - O(1) append
 * - O(n) tail/filter operations
 * - Thread-safe for single writer, multiple readers
 */

export class RingBuffer<T> {
  private buffer: T[]
  private writeIndex: number = 0
  private size: number = 0
  private readonly capacity: number

  constructor(capacity: number = 1000) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity must be positive')
    }
    this.capacity = capacity
    this.buffer = new Array(capacity)
  }

  /**
   * Add an item to the buffer
   * If full, overwrites oldest item
   */
  push(item: T): void {
    this.buffer[this.writeIndex] = item
    this.writeIndex = (this.writeIndex + 1) % this.capacity

    if (this.size < this.capacity) {
      this.size++
    }
  }

  /**
   * Get the last n items (most recent)
   * If n > size, returns all items
   */
  tail(n: number): T[] {
    if (n <= 0) return []

    const count = Math.min(n, this.size)
    const result: T[] = new Array(count)

    // Calculate starting position
    let readIndex =
      this.size < this.capacity
        ? Math.max(0, this.size - count)
        : (this.writeIndex - count + this.capacity) % this.capacity

    for (let i = 0; i < count; i++) {
      result[i] = this.buffer[readIndex]
      readIndex = (readIndex + 1) % this.capacity
    }

    return result
  }

  /**
   * Get all items in chronological order
   */
  all(): T[] {
    return this.tail(this.size)
  }

  /**
   * Filter items (returns in chronological order)
   */
  filter(predicate: (item: T) => boolean): T[] {
    const all = this.all()
    return all.filter(predicate)
  }

  /**
   * Get items since a timestamp (assumes T has ts: number)
   */
  since(timestamp: number): T[] {
    return this.filter((item: any) => item.ts >= timestamp)
  }

  /**
   * Current number of items
   */
  length(): number {
    return this.size
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.writeIndex = 0
    this.size = 0
  }

  /**
   * Get capacity
   */
  getCapacity(): number {
    return this.capacity
  }

  /**
   * Check if buffer is full
   */
  isFull(): boolean {
    return this.size === this.capacity
  }
}
