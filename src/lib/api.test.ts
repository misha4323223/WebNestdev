import { afterEach, describe, expect, it, vi } from "vitest";
import { apiJson } from "./api";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("apiJson: холодный старт проекта", () => {
  it("повторяет запрос после 409 PROJECT_RESTORING и учитывает Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(409, {
        error: "Проект просыпается",
        code: "PROJECT_RESTORING",
        retryAfter: 1,
      }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response(200, { checkpoints: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiJson<{ checkpoints: never[] }>("/api/projects/p1/changes");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ checkpoints: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/projects/p1/changes");
  });

  it("не скрывает другой 409 и не повторяет его", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(409, {
      error: "Агент ещё работает",
      code: "PROJECT_BUSY",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiJson("/api/projects/p1/changes")).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_BUSY",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
