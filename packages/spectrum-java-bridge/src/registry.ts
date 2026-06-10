import type { Message, Space } from "spectrum-ts";

const SPACE_CAPACITY = 1024;
const MESSAGE_CAPACITY = 8192;

/** Insertion-ordered map that evicts its least-recently-used entry at capacity. */
class BoundedMap<T> {
  private readonly entries = new Map<string, T>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }
}

/**
 * Keeps live `Space`/`Message` objects addressable by id so wire requests
 * (`send`, `react`, `reply`, …) can be routed back to real SDK objects.
 */
export class BridgeRegistry {
  private readonly spaces = new BoundedMap<Space>(SPACE_CAPACITY);
  private readonly messages = new BoundedMap<Message>(MESSAGE_CAPACITY);

  registerSpace(space: Space): void {
    this.spaces.set(space.id, space);
  }

  /** Registers a message plus every nested message it references. */
  registerMessage(message: Message): void {
    if (message.id) {
      this.messages.set(message.id, message);
    }
    const content = message.content;
    if (
      content.type === "reaction" ||
      content.type === "reply" ||
      content.type === "edit" ||
      content.type === "unsend"
    ) {
      this.registerMessage(content.target);
      return;
    }
    if (content.type === "group") {
      for (const item of content.items) {
        this.registerMessage(item);
      }
    }
  }

  getSpace(id: string): Space | undefined {
    return this.spaces.get(id);
  }

  getMessage(id: string): Message | undefined {
    return this.messages.get(id);
  }
}
