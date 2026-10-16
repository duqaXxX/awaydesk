/**
 * What `awaydesk service` asks of the machine's service manager. One implementation per system
 * (launchd on macOS today); a system with none has no `service` command.
 */
import type { Program } from "../program.ts";

export const SERVICE_ACTIONS = ["install", "uninstall", "status", "restart"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** What one action printed and its exit status: `out` for stdout, `err` for stderr. */
export interface Report {
  code: number;
  out: string[];
  err: string[];
}

export interface ServiceManager {
  /** Writes the service's definition for `program` and loads it, so the daemon starts now and at login. */
  install(program: Program): Report;
  /** Unloads the service and removes its definition; leaves the configuration and the logs. */
  uninstall(): Report;
  /** Whether the service is installed, loaded and running. Status 0 when it runs, 3 otherwise. */
  status(): Report;
  /** Sends the daemon `SIGTERM`, the stop that lets running turns finish; the manager starts it again. */
  restart(): Report;
}

/** How a manager runs a system command: its exit status (null when killed) and its output. */
export type Run = (
  command: string,
  args: readonly string[],
) => { status: number | null; stdout: string; stderr: string };
