import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { schema, handler, set_plist_valueLogic } from '../set_plist_value.ts';
import {
  createCommandMatchingMockExecutor,
  createMockCommandResponse,
  createMockExecutor,
  createMockFileSystemExecutor,
  type CommandExecutor,
} from '../../../../test-utils/mock-executors.ts';

describe('set_plist_value tool', () => {
  const plistPath = '/tmp/Info.plist';

  describe('schema/handler exports', () => {
    it('exports a handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('validates schema input and applies defaults', () => {
      const schemaObj = z.object(schema);

      const parsed = schemaObj.safeParse({
        plistPath,
        keyPath: 'CFBundleDisplayName',
        value: 'My App',
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.valueType).toBe('string');
        expect(parsed.data.createIfMissing).toBe(true);
      }
    });

    it('rejects invalid schema input', () => {
      const schemaObj = z.object(schema);

      expect(schemaObj.safeParse({}).success).toBe(false);
      expect(
        schemaObj.safeParse({
          plistPath,
          keyPath: 'CFBundleDisplayName',
          value: 42,
        }).success,
      ).toBe(false);
      expect(
        schemaObj.safeParse({
          plistPath,
          keyPath: 'CFBundleDisplayName',
          value: 'My App',
          valueType: 'invalid',
        }).success,
      ).toBe(false);
    });
  });

  describe('handler validation', () => {
    it('returns parameter validation errors for missing required fields', async () => {
      const result = await handler({});
      expect(result.isError).toBe(true);

      const text = String(result.content?.[0]?.text ?? '');
      expect(text).toContain('Parameter validation failed');
      expect(text).toContain('plistPath');
      expect(text).toContain('keyPath');
      expect(text).toContain('value');
    });

    it('returns parameter validation errors for invalid bool value', async () => {
      const result = await handler({
        plistPath,
        keyPath: 'NSAppTransportSecurity:NSAllowsArbitraryLoads',
        value: 'yes',
        valueType: 'bool',
      });
      expect(result.isError).toBe(true);
      const text = String(result.content?.[0]?.text ?? '');
      expect(text).toContain('Boolean values must be true or false.');
    });

    it('returns parameter validation errors for invalid int/real values', async () => {
      const intResult = await handler({
        plistPath,
        keyPath: 'BuildNumber',
        value: '1.2',
        valueType: 'int',
      });
      expect(intResult.isError).toBe(true);
      expect(String(intResult.content?.[0]?.text ?? '')).toContain(
        'Integer values must use whole-number format',
      );

      const realResult = await handler({
        plistPath,
        keyPath: 'Opacity',
        value: 'Infinity',
        valueType: 'real',
      });
      expect(realResult.isError).toBe(true);
      expect(String(realResult.content?.[0]?.text ?? '')).toContain(
        'Real values must use finite decimal or scientific format',
      );
    });
  });

  describe('logic behavior', () => {
    it('returns an error when the plist file does not exist', async () => {
      let commandCallCount = 0;
      const mockExecutor = createMockExecutor({
        success: true,
        output: '',
        onExecute: () => {
          commandCallCount += 1;
        },
      });
      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => false,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'CFBundleDisplayName',
          value: 'My App',
          valueType: 'string',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).toBe(true);
      expect(String(result.content?.[0]?.text ?? '')).toContain('Plist file not found');
      expect(commandCallCount).toBe(0);
    });

    it('sets an existing key successfully and reports previous value', async () => {
      const capturedCommands: string[][] = [];
      let printCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        capturedCommands.push(command);
        const plistCommand = command[2];

        if (plistCommand === 'Print :CFBundleDisplayName') {
          printCount += 1;
          return createMockCommandResponse({
            success: true,
            output: printCount === 1 ? 'Old Name' : 'New Name',
          });
        }

        if (plistCommand === 'Set :CFBundleDisplayName "New Name"') {
          return createMockCommandResponse({ success: true, output: '' });
        }

        return createMockCommandResponse({
          success: false,
          error: `Unexpected command: ${command.join(' ')}`,
        });
      };

      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'CFBundleDisplayName',
          value: 'New Name',
          valueType: 'string',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).not.toBe(true);
      const text = String(result.content?.[0]?.text ?? '');
      expect(text).toContain(`'${plistPath}'`);
      expect(text).toContain(`'CFBundleDisplayName'`);
      expect(text).toContain(`'New Name'`);
      expect(text).toContain('Previous value: Old Name');

      expect(capturedCommands).toEqual([
        ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleDisplayName', plistPath],
        ['/usr/libexec/PlistBuddy', '-c', 'Set :CFBundleDisplayName "New Name"', plistPath],
        ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleDisplayName', plistPath],
      ]);
    });

    it('falls back to Add when Set fails and createIfMissing=true', async () => {
      const capturedCommands: string[][] = [];
      let printCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        capturedCommands.push(command);
        const plistCommand = command[2];

        if (plistCommand === 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads') {
          printCount += 1;
          if (printCount === 1) {
            return createMockCommandResponse({
              success: false,
              error: 'Entry Does Not Exist',
            });
          }
          return createMockCommandResponse({ success: true, output: 'true' });
        }

        if (plistCommand === 'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads true') {
          return createMockCommandResponse({
            success: false,
            error: 'Entry Does Not Exist',
          });
        }

        if (plistCommand === 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true') {
          return createMockCommandResponse({ success: true, output: '' });
        }

        return createMockCommandResponse({
          success: false,
          error: `Unexpected command: ${command.join(' ')}`,
        });
      };

      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'NSAppTransportSecurity:NSAllowsArbitraryLoads',
          value: 'TRUE',
          valueType: 'bool',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).not.toBe(true);
      expect(String(result.content?.[0]?.text ?? '')).toContain(`to 'true'`);

      expect(capturedCommands).toEqual([
        [
          '/usr/libexec/PlistBuddy',
          '-c',
          'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads',
          plistPath,
        ],
        [
          '/usr/libexec/PlistBuddy',
          '-c',
          'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads true',
          plistPath,
        ],
        [
          '/usr/libexec/PlistBuddy',
          '-c',
          'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true',
          plistPath,
        ],
        [
          '/usr/libexec/PlistBuddy',
          '-c',
          'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads',
          plistPath,
        ],
      ]);
    });

    it('returns an error when Set fails and createIfMissing=false', async () => {
      const mockExecutor = createCommandMatchingMockExecutor({
        'Print :CFBundleDisplayName': { success: false, error: 'Entry Does Not Exist' },
        'Set :CFBundleDisplayName "New Name"': { success: false, error: 'Entry Does Not Exist' },
      });
      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'CFBundleDisplayName',
          value: 'New Name',
          valueType: 'string',
          createIfMissing: false,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).toBe(true);
      const text = String(result.content?.[0]?.text ?? '');
      expect(text).toContain('Failed to set plist value');
      expect(text).toContain('Entry Does Not Exist');
    });

    it('validates bool values in logic', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });
      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'MyBoolean',
          value: 'not-a-bool',
          valueType: 'bool',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).toBe(true);
      expect(String(result.content?.[0]?.text ?? '')).toContain(
        'Boolean values must be true or false.',
      );
    });

    it('uses escaped key-path segments for PlistBuddy commands', async () => {
      const capturedCommands: string[][] = [];
      let printCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        capturedCommands.push(command);
        const plistCommand = command[2];
        if (plistCommand === 'Print :A\\:B:C') {
          printCount += 1;
          return createMockCommandResponse({
            success: true,
            output: printCount === 1 ? 'old' : 'new',
          });
        }
        if (plistCommand === 'Set :A\\:B:C "new"') {
          return createMockCommandResponse({ success: true, output: '' });
        }
        return createMockCommandResponse({
          success: false,
          error: `Unexpected command: ${command.join(' ')}`,
        });
      };

      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'A\\:B:C',
          value: 'new',
          valueType: 'string',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).not.toBe(true);
      expect(capturedCommands).toEqual([
        ['/usr/libexec/PlistBuddy', '-c', 'Print :A\\:B:C', plistPath],
        ['/usr/libexec/PlistBuddy', '-c', 'Set :A\\:B:C "new"', plistPath],
        ['/usr/libexec/PlistBuddy', '-c', 'Print :A\\:B:C', plistPath],
      ]);
    });

    it('escapes string values and preserves verified string output', async () => {
      const capturedCommands: string[][] = [];
      let printCount = 0;
      const stringValue = 'Line1\nLine2\t"Quote"\\Slash';

      const mockExecutor: CommandExecutor = async (command) => {
        capturedCommands.push(command);
        const plistCommand = command[2];
        if (plistCommand === 'Print :Escaped') {
          printCount += 1;
          return createMockCommandResponse({
            success: true,
            output: printCount === 1 ? 'old' : stringValue,
          });
        }
        if (plistCommand === 'Set :Escaped "Line1\\nLine2\\t\\"Quote\\"\\\\Slash"') {
          return createMockCommandResponse({ success: true, output: '' });
        }
        return createMockCommandResponse({
          success: false,
          error: `Unexpected command: ${command.join(' ')}`,
        });
      };

      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'Escaped',
          value: stringValue,
          valueType: 'string',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).not.toBe(true);
      expect(String(result.content?.[0]?.text ?? '')).toContain(stringValue);
      expect(capturedCommands).toEqual([
        ['/usr/libexec/PlistBuddy', '-c', 'Print :Escaped', plistPath],
        [
          '/usr/libexec/PlistBuddy',
          '-c',
          'Set :Escaped "Line1\\nLine2\\t\\"Quote\\"\\\\Slash"',
          plistPath,
        ],
        ['/usr/libexec/PlistBuddy', '-c', 'Print :Escaped', plistPath],
      ]);
    });

    it('does not attempt Add fallback for clear non-missing set failures', async () => {
      const capturedCommands: string[][] = [];
      const mockExecutor: CommandExecutor = async (command) => {
        capturedCommands.push(command);
        const plistCommand = command[2];
        if (plistCommand === 'Print :Count') {
          return createMockCommandResponse({
            success: true,
            output: '12',
          });
        }
        if (plistCommand === 'Set :Count 13') {
          return createMockCommandResponse({
            success: false,
            error: 'Type mismatch while setting value',
          });
        }
        return createMockCommandResponse({
          success: false,
          error: `Unexpected command: ${command.join(' ')}`,
        });
      };

      const mockFileSystemExecutor = createMockFileSystemExecutor({
        existsSync: () => true,
      });

      const result = await set_plist_valueLogic(
        {
          plistPath,
          keyPath: 'Count',
          value: '13',
          valueType: 'int',
          createIfMissing: true,
        },
        mockExecutor,
        mockFileSystemExecutor,
      );

      expect(result.isError).toBe(true);
      expect(String(result.content?.[0]?.text ?? '')).toContain('set_error: Type mismatch');
      expect(capturedCommands).toEqual([
        ['/usr/libexec/PlistBuddy', '-c', 'Print :Count', plistPath],
        ['/usr/libexec/PlistBuddy', '-c', 'Set :Count 13', plistPath],
      ]);
    });
  });
});
