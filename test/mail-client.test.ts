import { describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as mailClient from "../src/client.cjs";

function createRequestHarness(responseBody: string, statusCode = 200) {
  let capturedOptions: any;
  const request = vi.fn((options, callback) => {
    capturedOptions = options;
    const handlers: Record<string, Function> = {};
    const req = {
      on: vi.fn((event, handler) => {
        handlers[event] = handler;
        return req;
      }),
      setTimeout: vi.fn(),
      write: vi.fn(),
      end: vi.fn(() => {
        const resHandlers: Record<string, Function> = {};
        const res = {
          statusCode,
          on: vi.fn((event, handler) => {
            resHandlers[event] = handler;
            return res;
          }),
        };
        callback(res);
        resHandlers.data?.(responseBody);
        resHandlers.end?.();
      }),
      destroy: vi.fn(),
    };
    return req;
  });
  return { request, getOptions: () => capturedOptions };
}

describe("mail client module", () => {
  it("adds auth and parses json responses", async () => {
    const harness = createRequestHarness(JSON.stringify({ ok: true }));

    const response = await mailClient.mailRequest(
      "GET",
      "/api/v1/mail/messages",
      null,
      "secret",
      {
        baseUrl: "https://mail.example.test",
        httpsLib: { request: harness.request },
      },
    );

    expect(harness.getOptions()).toMatchObject({
      method: "GET",
      hostname: "mail.example.test",
      path: "/api/v1/mail/messages",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer secret",
      },
    });
    expect(response).toEqual({ status: 200, data: { ok: true } });
  });

  it("falls back to raw payloads when the response is not json", async () => {
    const harness = createRequestHarness("not-json", 500);

    const response = await mailClient.mailRequest(
      "POST",
      "/api/v1/mail/send",
      { hello: "world" },
      null,
      {
        baseUrl: "http://mail.example.test",
        httpLib: { request: harness.request },
      },
    );

    expect(response).toEqual({ status: 500, data: { raw: "not-json" } });
  });
});
