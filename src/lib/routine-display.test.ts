import { describe, expect, it } from "vitest";

import type { RoutineRun } from "./routines";
import { automationStatus, runLine } from "./automations";
import { isLimitSkip, routineRunLabel, routineRunTone, routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {
  it("on the Cloud, every routine runs on schedule even when the person's computer is off", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: true })).toEqual({
      label: "The cloud", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud", cloudHome: true })).toEqual({
      label: "Cloud desktop", hint: "Runs the whole job on the bot's cloud desktop, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "cloud", cloudHome: true })).toEqual({
      label: "The bot's cloud desktop", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: true, cloudHome: true })).toEqual({
      label: "The cloud, with the whole group", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm", cloudHome: true }).label).toBe("The cloud");
  });

  it("on a desktop, a routine starts while Metal is open there", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: false })).toEqual({
      label: "This computer", hint: "Starts while Metal is open here.",
    });
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud", cloudHome: false })).toEqual({
      label: "Cloud desktop", hint: "Runs the whole job on the bot's cloud desktop while Metal is open.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm", cloudHome: false }).label).toBe("The bot's private desktop");
    expect(routineRunsOn({ roomGoal: true, cloudHome: false }).label).toBe("This computer, with the whole group");
  });

  it("never names retired desktop provider or a cloud runner", () => {
    for (const cloudHome of [true, false]) {
      for (const input of [{ runOn: "cloud" }, { computer: "cloud" }, {}]) {
        const { label, hint } = routineRunsOn({ roomGoal: false, cloudHome, ...input });
        expect(`${label} ${hint}`).not.toMatch(/\x62oat|runner|VM\b/i);
      }
    }
  });
});

describe("a run's status", () => {
  const run = (patch: Partial<RoutineRun>) => ({ id: "r", routineId: "x", routineName: "Brief", botId: "b", status: "failed", manual: false, scheduledFor: 0, createdAt: 0, ...patch }) as RoutineRun;

  it("reads partly done, in the waiting colour, when only a step failed after the reply came back", () => {
    expect(routineRunLabel(run({ partial: true }))).toBe("Partly done");
    expect(routineRunTone(run({ partial: true }))).toBe("text-warning");
    expect(routineRunLabel(run({ partial: true, retried: "failed" }))).toBe("Retried after a failure · Partly done");
  });

  it("still reads failed, in red, for any other failure", () => {
    expect(routineRunLabel(run({}))).toBe("Failed");
    expect(routineRunTone(run({}))).toBe("text-danger");
    expect(routineRunLabel(run({ status: "completed", partial: true }))).toBe("Completed");
  });
});

describe("a run the weekly limit skipped", () => {
  const run = (extra: Partial<RoutineRun>): RoutineRun => ({ id: "r", routineId: "x", routineName: "Digest", target: "bot", botId: "b", runOn: "maus",
    scheduledFor: 0, status: "missed", manual: false, createdAt: 0, ...extra });

  it("reads as skipped, never as a failure that needs the person", () => {
    const skipped = run({ error: "Skipped: weekly limit reached. It resets Monday 12:00 AM, in 5 days." });
    expect(isLimitSkip(skipped)).toBe(true);
    expect(runLine(skipped)).toMatchObject({ mark: "–", text: "Skipped: weekly limit" });
    expect(automationStatus({ enabled: true, runs: [skipped] }).state).not.toBe("needs-you");
    expect(isLimitSkip(run({ error: "this computer was offline for more than 12 hours after the scheduled time" }))).toBe(false);
    expect(isLimitSkip(run({ status: "failed", error: "Skipped: weekly limit reached. It resets Monday 12:00 AM, in 5 days." }))).toBe(false);
  });
});
