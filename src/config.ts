import { SchemaValidationError } from "./schema.js";

export interface RunReviewConfig {
  storageDir?: string;
  captureFullContent?: boolean;
  summaryMaxChars?: number;
  duplicateWindow?: number;
  duplicateThreshold?: number;
  recoveryWindow?: number;
  maxEventsPerRun?: number;
  verificationCommands?: string[];
  autoSummary?: boolean;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new SchemaValidationError(`config.${field} 必须是正整数`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SchemaValidationError(`config.${field} 必须是布尔值`);
  return value;
}

export function parseRunReviewConfig(value: unknown): RunReviewConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SchemaValidationError("config 必须是对象");
  const input = value as Record<string, unknown>;
  if (input.storageDir !== undefined && (typeof input.storageDir !== "string" || !input.storageDir.trim())) {
    throw new SchemaValidationError("config.storageDir 必须是非空字符串");
  }
  if (input.verificationCommands !== undefined && (!Array.isArray(input.verificationCommands) || input.verificationCommands.length === 0 || input.verificationCommands.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new SchemaValidationError("config.verificationCommands 必须是非空字符串数组");
  }
  return {
    storageDir: input.storageDir as string | undefined,
    captureFullContent: optionalBoolean(input.captureFullContent, "captureFullContent"),
    summaryMaxChars: positiveInteger(input.summaryMaxChars, "summaryMaxChars"),
    duplicateWindow: positiveInteger(input.duplicateWindow, "duplicateWindow"),
    duplicateThreshold: positiveInteger(input.duplicateThreshold, "duplicateThreshold"),
    recoveryWindow: positiveInteger(input.recoveryWindow, "recoveryWindow"),
    maxEventsPerRun: positiveInteger(input.maxEventsPerRun, "maxEventsPerRun"),
    verificationCommands: input.verificationCommands as string[] | undefined,
    autoSummary: optionalBoolean(input.autoSummary, "autoSummary"),
  };
}
