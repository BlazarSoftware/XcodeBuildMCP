/**
 * Utilities Plugin: Set Plist Value
 *
 * Sets a value for a key path in a plist file using PlistBuddy.
 */

import * as z from 'zod';
import type { ToolResponse } from '../../../types/common.ts';
import type { CommandExecutor, FileSystemExecutor } from '../../../utils/execution/index.ts';
import {
  getDefaultCommandExecutor,
  getDefaultFileSystemExecutor,
} from '../../../utils/execution/index.ts';
import { createErrorResponse } from '../../../utils/responses/index.ts';
import { createTypedTool } from '../../../utils/typed-tool-factory.ts';

const plistValueTypeSchema = z.enum(['string', 'bool', 'int', 'real']);

const setPlistValueSchema = z
  .object({
    plistPath: z.string().min(1).describe('Path to the plist file (for example, Info.plist)'),
    keyPath: z
      .string()
      .min(1)
      .describe(
        'Key path like CFBundleDisplayName or NSAppTransportSecurity:NSAllowsArbitraryLoads. Use \\: for literal colons in key names.',
      ),
    value: z.string().describe('Value to write'),
    valueType: plistValueTypeSchema
      .default('string')
      .describe('Value type. One of: string, bool, int, real (default: string)'),
    createIfMissing: z
      .boolean()
      .default(true)
      .describe('If true, add the key when it does not already exist (default: true)'),
  })
  .superRefine((params, ctx) => {
    const keyPathValidation = parseKeyPathSegments(params.keyPath);
    if (!keyPathValidation.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyPath'],
        message: keyPathValidation.error,
      });
    }

    const valueValidationError = validateValueForType(params.value, params.valueType);
    if (valueValidationError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: valueValidationError,
      });
    }
  });

type SetPlistValueParams = z.infer<typeof setPlistValueSchema>;

type NormalizedValueResult =
  | { ok: true; normalizedValue: string; commandValue: string }
  | { ok: false; error: string };

type KeyPathParseResult =
  | { ok: true; segments: string[] }
  | {
      ok: false;
      error: string;
    };

type SetFailureClassification = 'missing-key' | 'non-missing' | 'unknown';

function parseKeyPathSegments(keyPath: string): KeyPathParseResult {
  const segments: string[] = [];
  let currentSegment = '';
  let escaping = false;

  for (const character of keyPath) {
    if (escaping) {
      currentSegment += character;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === ':') {
      const normalizedSegment = currentSegment.trim();
      if (normalizedSegment.length === 0) {
        return {
          ok: false,
          error: 'Key path contains an empty segment.',
        };
      }
      segments.push(normalizedSegment);
      currentSegment = '';
      continue;
    }

    currentSegment += character;
  }

  if (escaping) {
    return {
      ok: false,
      error: 'Key path ends with an unfinished escape sequence.',
    };
  }

  const normalizedSegment = currentSegment.trim();
  if (normalizedSegment.length === 0) {
    return {
      ok: false,
      error: 'Key path contains an empty segment.',
    };
  }

  segments.push(normalizedSegment);
  return { ok: true, segments };
}

function escapeKeySegmentForPlistBuddy(segment: string): string {
  return segment.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

function normalizeKeyPathForPlistBuddy(
  keyPath: string,
): KeyPathParseResult & { plistBuddyKeyPath?: string } {
  const parsed = parseKeyPathSegments(keyPath);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    segments: parsed.segments,
    plistBuddyKeyPath: `:${parsed.segments.map(escapeKeySegmentForPlistBuddy).join(':')}`,
  };
}

function quotePlistBuddyString(value: string): string {
  let escaped = '';

  for (const character of value) {
    if (character === '\\') {
      escaped += '\\\\';
      continue;
    }
    if (character === '"') {
      escaped += '\\"';
      continue;
    }
    if (character === '\n') {
      escaped += '\\n';
      continue;
    }
    if (character === '\r') {
      escaped += '\\r';
      continue;
    }
    if (character === '\t') {
      escaped += '\\t';
      continue;
    }
    escaped += character;
  }

  return `"${escaped}"`;
}

function validateValueForType(
  value: string,
  valueType: z.infer<typeof plistValueTypeSchema>,
): string | null {
  if (valueType === 'bool') {
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      return 'Boolean values must be true or false.';
    }
    return null;
  }

  if (valueType === 'int') {
    const normalized = value.trim();
    if (!/^[+-]?\d+$/.test(normalized)) {
      return 'Integer values must use whole-number format (for example: -1, 0, 42).';
    }
    return null;
  }

  if (valueType === 'real') {
    const normalized = value.trim();
    if (
      !/^[+-]?(?:(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)$/.test(normalized) ||
      !Number.isFinite(Number(normalized))
    ) {
      return 'Real values must use finite decimal or scientific format (for example: 1.0, -0.5, 1e3).';
    }
    return null;
  }

  return null;
}

function classifySetFailure(errorOrOutput: string): SetFailureClassification {
  const normalized = errorOrOutput.toLowerCase();

  if (
    normalized.includes('does not exist') ||
    normalized.includes('unknown entry') ||
    normalized.includes('missing key')
  ) {
    return 'missing-key';
  }

  if (
    normalized.includes('type mismatch') ||
    normalized.includes('cannot parse') ||
    normalized.includes('malformed') ||
    normalized.includes('invalid')
  ) {
    return 'non-missing';
  }

  return 'unknown';
}

function getCommandErrorText(output?: string, error?: string): string {
  const normalizedError = error?.trim();
  if (normalizedError && normalizedError.length > 0) {
    return normalizedError;
  }

  const normalizedOutput = output?.trim();
  if (normalizedOutput && normalizedOutput.length > 0) {
    return normalizedOutput;
  }

  return 'Unknown error';
}

function normalizeDisplayedValue(
  value: string,
  valueType: z.infer<typeof plistValueTypeSchema>,
): string {
  if (valueType === 'string') {
    return value;
  }
  return value.trim();
}

function normalizeValueForType(
  value: string,
  valueType: z.infer<typeof plistValueTypeSchema>,
): NormalizedValueResult {
  const validationError = validateValueForType(value, valueType);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  if (valueType === 'bool') {
    const normalized = value.trim().toLowerCase();
    return { ok: true, normalizedValue: normalized, commandValue: normalized };
  }

  if (valueType === 'int' || valueType === 'real') {
    const normalized = value.trim();
    return { ok: true, normalizedValue: normalized, commandValue: normalized };
  }

  if (valueType === 'string') {
    return { ok: true, normalizedValue: value, commandValue: quotePlistBuddyString(value) };
  }

  return { ok: true, normalizedValue: value, commandValue: value };
}

async function runPlistBuddyCommand(
  plistCommand: string,
  plistPath: string,
  executor: CommandExecutor,
  logPrefix: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const result = await executor(
    ['/usr/libexec/PlistBuddy', '-c', plistCommand, plistPath],
    logPrefix,
  );
  return { success: result.success, output: result.output, error: result.error };
}

export async function set_plist_valueLogic(
  params: SetPlistValueParams,
  executor: CommandExecutor,
  fileSystemExecutor: FileSystemExecutor,
): Promise<ToolResponse> {
  if (!fileSystemExecutor.existsSync(params.plistPath)) {
    return createErrorResponse('Plist file not found', `No file exists at '${params.plistPath}'.`);
  }

  const normalizedKeyPath = normalizeKeyPathForPlistBuddy(params.keyPath);
  if (!normalizedKeyPath.ok || !normalizedKeyPath.plistBuddyKeyPath) {
    return createErrorResponse(
      'Parameter validation failed',
      `Invalid parameters:\nkeyPath: ${normalizedKeyPath.ok ? 'Invalid key path.' : normalizedKeyPath.error}`,
    );
  }

  const normalizedValueResult = normalizeValueForType(params.value, params.valueType);
  if (!normalizedValueResult.ok) {
    return createErrorResponse('Parameter validation failed', normalizedValueResult.error);
  }

  let previousValue: string | null = null;
  try {
    const previousResult = await runPlistBuddyCommand(
      `Print ${normalizedKeyPath.plistBuddyKeyPath}`,
      params.plistPath,
      executor,
      'Read existing plist value',
    );
    if (previousResult.success) {
      previousValue = normalizeDisplayedValue(previousResult.output, params.valueType);
    }
  } catch {
    // Best-effort read: non-fatal when key is missing or unreadable.
  }

  const setResult = await runPlistBuddyCommand(
    `Set ${normalizedKeyPath.plistBuddyKeyPath} ${normalizedValueResult.commandValue}`,
    params.plistPath,
    executor,
    'Set plist value',
  );

  if (!setResult.success) {
    const setErrorText = getCommandErrorText(setResult.output, setResult.error);
    const setFailureType = classifySetFailure(setErrorText);

    if (!params.createIfMissing) {
      return createErrorResponse('Failed to set plist value', `set_error: ${setErrorText}`);
    }

    if (setFailureType === 'non-missing') {
      return createErrorResponse('Failed to set plist value', `set_error: ${setErrorText}`);
    }

    const addResult = await runPlistBuddyCommand(
      `Add ${normalizedKeyPath.plistBuddyKeyPath} ${params.valueType} ${normalizedValueResult.commandValue}`,
      params.plistPath,
      executor,
      'Add plist value',
    );

    if (!addResult.success) {
      const addErrorText = getCommandErrorText(addResult.output, addResult.error);
      return createErrorResponse(
        'Failed to set plist value',
        [`set_error: ${setErrorText}`, `add_error: ${addErrorText}`].join('\n'),
      );
    }
  }

  const verifyResult = await runPlistBuddyCommand(
    `Print ${normalizedKeyPath.plistBuddyKeyPath}`,
    params.plistPath,
    executor,
    'Verify plist value',
  );

  if (!verifyResult.success) {
    const verifyErrorText = getCommandErrorText(verifyResult.output, verifyResult.error);
    return createErrorResponse('Failed to verify plist write', `verify_error: ${verifyErrorText}`);
  }

  const finalValue = normalizeDisplayedValue(verifyResult.output, params.valueType);
  const previousValueText = previousValue !== null ? ` Previous value: ${previousValue}.` : '';

  return {
    content: [
      {
        type: 'text',
        text: `Set plist key '${params.keyPath}' in '${params.plistPath}' to '${finalValue}'.${previousValueText}`,
      },
    ],
    isError: false,
  };
}

export const schema = setPlistValueSchema.shape;

export const handler = createTypedTool(
  setPlistValueSchema,
  (params: SetPlistValueParams, executor: CommandExecutor) =>
    set_plist_valueLogic(params, executor, getDefaultFileSystemExecutor()),
  getDefaultCommandExecutor,
);
