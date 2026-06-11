'use strict';

class CommandQueue {
  constructor(logger) {
    this.logger = logger;
    this._queue = [];
    this._isProcessing = false;
    this.COMMAND_DELAY_MS = 300; // Default delay
    this.COMMAND_TIMEOUT_MS = 10000; // Default timeout (10s)
  }

  setDelay(ms) {
    this.COMMAND_DELAY_MS = ms;
  }

  setCommandTimeout(ms) {
    this.COMMAND_TIMEOUT_MS = ms;
  }

  clear() {
    const pending = this._queue.splice(0);
    for (const command of pending) {
      command.reject(new Error('Queue cleared'));
    }
  }

  /**
   * Enqueues a command to be executed.
   * @param {Function} executor - Async function to execute the command
   * @param {string} description - Description of the command for logging
   * @returns {Promise<void>}
   */
  async add(executor, description) {
    return new Promise((resolve, reject) => {
      this._queue.push({
        executor,
        description,
        resolve,
        reject,
      });

      if (!this._isProcessing) {
        this._process();
      }
    });
  }

  async _process() {
    if (this._isProcessing) return;

    this._isProcessing = true;

    try {
      while (true) {
        if (this._queue.length === 0) {
          break;
        }

        const command = this._queue.shift();

        try {
          this.logger.log(`[QUEUE] Processing: ${command.description}`);
          await this._withTimeout(command.executor(), this.COMMAND_TIMEOUT_MS);
          command.resolve();
        } catch (error) {
          command.reject(error);
          this.logger.error(`[QUEUE] Failed: ${command.description} - ${error.message || error}`);
        }

        if (this._queue.length > 0) {
          await this._delay(this.COMMAND_DELAY_MS);
        }
      }
    } finally {
      this._isProcessing = false;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _withTimeout(promise, ms) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Command timed out after ${ms}ms`));
      }, ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }
}

module.exports = CommandQueue;
