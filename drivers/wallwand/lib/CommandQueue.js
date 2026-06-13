'use strict';

class CommandQueue {
  constructor(logger, delayMs = 250, timeoutMs = 10000) {
    this.logger = logger;
    this._queue = [];
    this._isProcessing = false;
    this.COMMAND_DELAY_MS = delayMs;
    this.COMMAND_TIMEOUT_MS = timeoutMs;
  }

  clear() {
    const pending = this._queue.splice(0);
    for (const command of pending) {
      command.reject(new Error('Queue cleared'));
    }
  }

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
      while (this._queue.length) {
        const command = this._queue.shift();

        let execution;
        try {
          this.logger.log(`[QUEUE] Processing: ${command.description}`);
          execution = Promise.resolve(command.executor());
          await this._withTimeout(execution, this.COMMAND_TIMEOUT_MS);
          command.resolve();
        } catch (error) {
          command.reject(error);
          this.logger.error(`[QUEUE] Failed: ${command.description} - ${error.message || error}`);

          // A timed-out Z-Wave command keeps running and can't be cancelled; log if it settles late
          if (error.isTimeout && execution) {
            execution.then(
              () =>
                this.logger.log(`[QUEUE] Timed-out command resolved late: ${command.description}`),
              err =>
                this.logger.log(
                  `[QUEUE] Timed-out command rejected late: ${command.description} - ${err?.message || err}`
                )
            );
          }
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
        const error = new Error(`Command timed out after ${ms}ms`);
        error.isTimeout = true;
        reject(error);
      }, ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }
}

module.exports = CommandQueue;
