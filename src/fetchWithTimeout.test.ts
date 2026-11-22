import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./fetchWithTimeout";

const REQUEST_URL = "http://example.test/resource";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("returns the response and passes a timeout signal to fetch", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithTimeout(REQUEST_URL, 1234);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      REQUEST_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it("rejects with the timeout reason when fetch outlives the timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchWithTimeout(REQUEST_URL, 10).catch((reason: unknown) => reason);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  it("passes the request URL through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithTimeout(REQUEST_URL, 1000);

    expect(fetchMock.mock.calls[0][0]).toBe(REQUEST_URL);
  });
});
