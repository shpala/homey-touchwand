'use strict';

const CommandQueue = require('../drivers/wallwand/lib/CommandQueue');

describe('CommandQueue', () => {
  let queue;
  let mockLogger;
  let mockLog;
  let mockError;

  beforeEach(() => {
    mockLog = jest.fn();
    mockError = jest.fn();
    mockLogger = {
      log: mockLog,
      error: mockError,
    };
    queue = new CommandQueue(mockLogger, 10, 100); // Short delay and timeout for tests
  });

  test('should execute a single command', async () => {
    const executor = jest.fn().mockResolvedValue('success');
    await queue.add(executor, 'Test Command');
    expect(executor).toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Processing: Test Command'));
  });

  test('should execute commands sequentially with delay', async () => {
    const order = [];
    const executor1 = jest.fn().mockImplementation(async () => {
      order.push(1);
    });
    const executor2 = jest.fn().mockImplementation(async () => {
      order.push(2);
    });

    const p1 = queue.add(executor1, 'Cmd 1');
    const p2 = queue.add(executor2, 'Cmd 2');

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
    expect(executor1).toHaveBeenCalled();
    expect(executor2).toHaveBeenCalled();
  });

  test('should handle command failure without blocking queue', async () => {
    const executor1 = jest.fn().mockRejectedValue(new Error('Fail'));
    const executor2 = jest.fn().mockResolvedValue('success');

    try {
      await queue.add(executor1, 'Fail Cmd');
    } catch (e) {
      expect(e.message).toBe('Fail');
    }

    await queue.add(executor2, 'Success Cmd');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Failed: Fail Cmd'));
    expect(executor2).toHaveBeenCalled();
  });

  test('should execute command within timeout', async () => {
    const executor = jest.fn().mockImplementation(async () => {
      return new Promise(resolve => setTimeout(resolve, 10)); // finishes in 10ms, timeout is 100ms
    });
    await queue.add(executor, 'Fast Cmd');
    expect(executor).toHaveBeenCalled();
  });

  test('clear rejects pending commands without touching the one in flight', async () => {
    let resolveFirst;
    const executor1 = jest.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    );
    const executor2 = jest.fn().mockResolvedValue('success');

    const p1 = queue.add(executor1, 'In Flight');
    const p2 = queue.add(executor2, 'Pending');

    await Promise.resolve();
    queue.clear();

    await expect(p2).rejects.toThrow('Queue cleared');
    expect(executor2).not.toHaveBeenCalled();

    resolveFirst();
    await expect(p1).resolves.toBeUndefined();
  });

  test('times out a slow command, honoring the constructor timeout', async () => {
    const q = new CommandQueue(mockLogger, 5, 50);
    const executor = () => new Promise(resolve => setTimeout(resolve, 200));

    await expect(q.add(executor, 'Slow Cmd')).rejects.toThrow(/timed out after 50ms/);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Failed: Slow Cmd'));
  });

  test('logs a warning when a timed-out command resolves late', async () => {
    let resolveLate;
    const executor = () =>
      new Promise(resolve => {
        resolveLate = resolve;
      });

    await expect(queue.add(executor, 'Slow Cmd')).rejects.toThrow(/timed out/);
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('late'));

    resolveLate();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('resolved late'));
  });

  test('logs a warning when a timed-out command rejects late', async () => {
    let rejectLate;
    const executor = () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      });

    await expect(queue.add(executor, 'Slow Cmd')).rejects.toThrow(/timed out/);

    rejectLate(new Error('NO_ACK'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('rejected late'));
  });

  test('does not log a late warning when the executor itself rejected', async () => {
    const executor = jest.fn().mockRejectedValue(new Error('Fail'));

    await expect(queue.add(executor, 'Fail Cmd')).rejects.toThrow('Fail');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });
});
