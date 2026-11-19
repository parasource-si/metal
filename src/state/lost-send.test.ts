import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

const SEND = "/api/bots/bot/messages";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return (onError: () => void) => dispatch({ type: "send", botId: "bot", threadId: "thread", text: "say ok6", sendId: "send-0123456789abcdef", onError });
}
afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("asks again with the same sendId when a send's answer is lost, and never gives a delivered message back", async () => {
  const bodies: string[] = [];
  const requests = vi.fn<typeof fetch>(async (path, init) => {
    if (path !== SEND) return response({});
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new TypeError("Failed to fetch");
    return response({ ok: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "say ok6", at: 1, sendId: "send-0123456789abcdef" } }, 202);
  });
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1]!).sendId).toBe(JSON.parse(bodies[0]!).sendId);
  expect(onError).not.toHaveBeenCalled();
});

it("keeps a slow send pending until the server's steered receipt answers", async () => {
  const requests = vi.fn<typeof fetch>((path, init) => path !== SEND ? Promise.resolve(response({})) : new Promise((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    setTimeout(() => resolve(response({ ok: true, steered: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "say ok6", at: 1, sendId: "send-0123456789abcdef", steered: true } }, 202)), 90_000);
  }));
  const onError = vi.fn();
  const send = mount(requests);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  send(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(90_000);
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === SEND)).toHaveLength(1);
  expect(onError).not.toHaveBeenCalled();
});

it("still gives the draft back when the server refuses the send", async () => {
  const requests = vi.fn<typeof fetch>(async (path) => path === SEND ? response({ error: "no" }, 409) : response({}));
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === SEND)).toHaveLength(1);
  expect(onError).toHaveBeenCalledOnce();
});

it("asks again with the same sendId when an edit's answer timed out at the gateway", async () => {
  const EDIT = "/api/bots/bot/messages/m0/edit";
  const bodies: string[] = [];
  const requests = vi.fn<typeof fetch>(async (path, init) => {
    if (path !== EDIT) return response({});
    bodies.push(String(init?.body));
    if (bodies.length === 1) return response({ error: "The server took too long to answer." }, 504);
    return response({ ok: true, message: { id: "m2", role: "user", kind: "text", text: "again", at: 1, sendId: "edit-0123456789abcdef" } }, 202);
  });
  vi.useFakeTimers();
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  dispatch({ type: "editMessage", botId: "bot", threadId: "thread", messageId: "m0", text: "again", sendId: "edit-0123456789abcdef" });
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1]!).sendId).toBe("edit-0123456789abcdef");
});

it.each([502, 503, 504])("asks again with the same sendId when a gateway answers %i, since the server may have it or be about to", async (status) => {
  const bodies: string[] = [];
  const requests = vi.fn<typeof fetch>(async (path, init) => {
    if (path !== SEND) return response({});
    bodies.push(String(init?.body));
    if (bodies.length === 1) return response({ error: "This server is not connected." }, status);
    return response({ ok: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "say ok6", at: 1, sendId: "send-0123456789abcdef" } }, 202);
  });
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1]!).sendId).toBe(JSON.parse(bodies[0]!).sendId);
  expect(onError).not.toHaveBeenCalled();
});

it("holds a send to a waking Cloud past the lost-answer window, says the Cloud is waking, then delivers it once", async () => {
  const { cloudSendWaiting, resetCloudPowerForTests } = await import("../lib/cloud-power");
  resetCloudPowerForTests();
  const waking = () => new Response("This Metal is waking up. Try again in a few seconds.", { status: 503, headers: { "retry-after": "5", "x-dusk-cloud-power": "waking" } });
  let up = false;
  const bodies: string[] = [];
  const requests = vi.fn<typeof fetch>(async (path, init) => {
    if (path !== SEND) return response({});
    bodies.push(String(init?.body));
    if (!up) return waking();
    return response({ ok: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "say ok6", at: 1, sendId: "send-0123456789abcdef" } }, 202);
  });
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(cloudSendWaiting()).toBe(true);
  expect(onError).not.toHaveBeenCalled();
  up = true;
  await vi.advanceTimersByTimeAsync(6_000);
  await flush();
  expect(cloudSendWaiting()).toBe(false);
  expect(onError).not.toHaveBeenCalled();
  expect(new Set(bodies.map(body => JSON.parse(body).sendId))).toEqual(new Set(["send-0123456789abcdef"]));
  expect(bodies.length).toBeGreaterThan(10);
});

it("gives a send up after three minutes of a Cloud that does not wake, with a message saying to try again", async () => {
  const { cloudSendWaiting, resetCloudPowerForTests } = await import("../lib/cloud-power");
  resetCloudPowerForTests();
  const requests = vi.fn<typeof fetch>(async (path) => path !== SEND ? response({})
    : new Response("waking", { status: 503, headers: { "retry-after": "5", "x-dusk-cloud-power": "waking" } }));
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(170_000);
  expect(onError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  expect(onError).toHaveBeenCalledOnce();
  expect(cloudSendWaiting()).toBe(false);
  const calls = requests.mock.calls.filter(([path]) => path === SEND).length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests.mock.calls.filter(([path]) => path === SEND).length).toBe(calls);
});
