import { describe, expect, it } from "vitest";
import { computerProblem } from "./computer-problem";

describe("a bot computer's problem in plain words", () => {
  it("names an incompatible VPS desktop as an update, fixed by replacing it on its home volume", () => {
    expect(computerProblem({ phase: "vps-incompatible", failed: true, vps: { managed: true, desktop: "bot-desktop" } }))
      .toEqual({ line: "botPanel.screen.updateReady", fix: "replace", keepsFiles: true });
  });

  it("says when Fix would lose files: an older Cua desktop keeps nothing inside it", () => {
    expect(computerProblem({ phase: "vps-incompatible", failed: true, vps: { managed: true, desktop: "cua" } }))
      .toEqual({ line: "botPanel.screen.updateReady", fix: "replace", keepsFiles: false });
  });

  it("never replaces a container Metal did not make, nor a team's shared computer, from one bot's tab", () => {
    expect(computerProblem({ phase: "vps-incompatible", failed: true, vps: { managed: false } })).toMatchObject({ line: "computer.problem.notOurs", fix: "settings" });
    expect(computerProblem({ phase: "vps-incompatible", failed: true, vps: { managed: true, teamComputer: { id: "t" } } })).toMatchObject({ line: "botPanel.screen.updateReady", fix: "settings" });
  });

  it("asks to try again when the VPS can't be reached or the computer failed, and says nothing without a failure", () => {
    expect(computerProblem({ phase: "error", failed: true, vps: { configured: true, daemonUp: false } })).toMatchObject({ line: "computer.problem.unreachable", fix: "retry" });
    expect(computerProblem({ phase: "error", failed: true, vps: { configured: true, daemonUp: true } })).toMatchObject({ line: "computer.problem.failed", fix: "retry" });
    expect(computerProblem({ phase: "vm-unavailable", failed: true })).toMatchObject({ line: "computer.problem.failed", fix: "retry" });
    expect(computerProblem({ phase: "error", failed: false })).toBeNull();
    expect(computerProblem({ phase: "ready", failed: true })).toBeNull();
  });
});
