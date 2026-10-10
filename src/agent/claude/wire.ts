/**
 * Reading what Claude Code sends as `unknown`. The SDK's types describe less than the wire
 * carries (of 24 recorded kinds, 9 hold fields the types do not declare and one is absent from
 * the union, measured 2026-10-10 on SDK 0.3.296), so nothing here trusts a declared shape: each
 * value is narrowed where it is read.
 */
import { isRecord } from "../../values.ts";

/** A JSON object off the wire, its values still unread. */
export type WireRecord = Readonly<Record<string, unknown>>;

/** `value` when it is a string, else null. */
export function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `value` when it is a string that says something, else null. */
export function words(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `value` when it is a whole number, else null. */
export function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** `value` when it is a number, else null. */
export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The objects of `value` when it is a list, in order; anything else in it is left out. */
export function records(value: unknown): WireRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
