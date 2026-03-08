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
    queue = new CommandQueue(mockLogger);
    queue.setDelay(10); // Short delay for tests
    queue.setTimeout(100); // Short timeout for tests
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

  test('should timeout slow commands', async () => {
    const executor = jest.fn().mockImplementation(async () => {
      return new Promise(resolve => setTimeout(resolve, 200)); // finishes in 200ms, timeout is 100ms
    });

    await expect(queue.add(executor, 'Slow Cmd')).rejects.toThrow(/timed out/);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Failed: Slow Cmd'));
  });
});
