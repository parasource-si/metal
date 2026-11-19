import { describe, expect, it } from "vitest";

import { localizeComputerProblem, looksRaw } from "./computer-messages";

describe("computer problems in the panel", () => {
  it("never shows docker's, a build's or a log's own output", () => {
    for (const raw of [
      "The bot computer image ghcr.io/sidddevz/omb-bot-desktop:v5 could not be downloaded (Error response from daemon: manifest unknown)",
      "building it on the VPS failed: ERROR: failed to solve: docker.io/moby/buildkit:buildx-stable-1: pulling is not allowed",
      "Traceback (most recent call last):\n  File \"/opt/venv/lib/python3.12/site-packages/cua_driver/server.py\"",
      "connect ECONNREFUSED /run/duskbot-docker/docker.sock",
      "x".repeat(300),
    ]) {
      expect(looksRaw(raw)).toBe(true);
      expect(localizeComputerProblem(raw)).toBe("The screen isn't available right now. Try again in a moment.");
    }
  });

  it("keeps the server's own short sentences", () => {
    for (const plain of [
      "The Metal VPS container is stopped",
      "Docker over SSH could not reach the VPS; check the SSH alias and Docker on the VPS",
      "This computer couldn't be set up yet. It tries again by itself; try again in a few minutes.",
    ]) {
      expect(looksRaw(plain)).toBe(false);
      expect(localizeComputerProblem(plain)).toBe(plain);
    }
  });
});
