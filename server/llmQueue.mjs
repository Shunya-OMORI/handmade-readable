export class LlmPriorityQueue {
  constructor({ layoutMinIntervalMs = 7000 } = {}) {
    this.layoutMinIntervalMs = layoutMinIntervalMs;
    this.lastLayoutRequestAt = 0;
    this.running = false;
    this.pending = [];
  }

  enqueue({ label, priority = "normal", kind = "general", task }) {
    return new Promise((resolve, reject) => {
      this.pending.push({
        label,
        priority: priorityValue(priority),
        kind,
        task,
        resolve,
        reject,
        enqueuedAt: Date.now()
      });
      this.drain();
    });
  }

  snapshot() {
    return {
      running: this.running,
      pending: this.pending.map((job) => ({
        label: job.label,
        kind: job.kind,
        priority: job.priority,
        enqueuedAt: job.enqueuedAt
      }))
    };
  }

  async drain() {
    if (this.running) return;
    const next = this.takeNext();
    if (!next) return;

    this.running = true;
    try {
      if (next.kind === "layout") {
        const elapsed = Date.now() - this.lastLayoutRequestAt;
        if (elapsed < this.layoutMinIntervalMs) {
          await wait(this.layoutMinIntervalMs - elapsed);
        }
        this.lastLayoutRequestAt = Date.now();
      }
      const result = await next.task();
      next.resolve(result);
    } catch (error) {
      next.reject(error);
    } finally {
      this.running = false;
      this.drain();
    }
  }

  takeNext() {
    if (this.pending.length === 0) return null;
    let selectedIndex = 0;
    for (let index = 1; index < this.pending.length; index += 1) {
      const current = this.pending[index];
      const selected = this.pending[selectedIndex];
      if (current.priority > selected.priority || (current.priority === selected.priority && current.enqueuedAt < selected.enqueuedAt)) {
        selectedIndex = index;
      }
    }
    return this.pending.splice(selectedIndex, 1)[0];
  }
}

function priorityValue(priority) {
  if (priority === "high") return 3;
  if (priority === "low") return 1;
  return 2;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
