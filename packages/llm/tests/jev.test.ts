import { afterEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../src/jev.js";

describe("JevClient", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the hosted sidecar without provider credentials and attributes each requesting seat", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "http://127.0.0.1:9100/");
    vi.stubEnv("TYPESAFE_API_KEY", "must-not-leak");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://must-not-contact.invalid");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "jev-latest");
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const client = new JevClient({
      fetch: async (input, init) => {
        calls.push([input, init]);
        return Response.json({
          model: "typesafe/jev-1.13",
          answers: { risk: { type: "noul", noul: 0.2 } },
          usage: { cost: 0.000013608 },
        });
      },
    });
    for (const seat of [0, 3]) {
      const result = await client.systemOne(
        { state: "A visible situation", questions: { risk: { type: "noul" } } },
        seat,
      );
      expect(result.usage.cost).toBe(0.000013608);
    }
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:9100/v1/systemone",
      "http://127.0.0.1:9100/v1/systemone",
    ]);
    expect(calls.map(([, init]) => init?.headers)).toEqual(
      [0, 3].map((seat) => ({
        accept: "application/json",
        "content-type": "application/json",
        "X-Coworld-Player-Slot": String(seat),
      })),
    );
    expect(JSON.parse(calls[0]![1]!.body as string).model).toBe("typesafe/jev-1.13");
  });

  it("rejects invalid slot attribution before sending a request", async () => {
    const send = vi.fn();
    const client = new JevClient({ apiKey: "local", fetch: send });
    await expect(
      client.systemOne({ state: "state", questions: { risk: { type: "noul" } } }, -1),
    ).rejects.toThrow("slot");
    expect(send).not.toHaveBeenCalled();
  });

  const move = {
    type: "choice",
    choice: "left",
    confidence: 0.8,
    probabilities: { left: 0.8, right: 0.2 },
  };

  it.each([
    ["missing answer", {}],
    ["extra answer", { move, extra: move }],
    ["wrong question", { other: move }],
    ["wrong primitive", { move: { type: "noul", noul: 0.8 } }],
    ["unknown choice", { move: { ...move, choice: "jump" } }],
    ["missing probability", { move: { ...move, probabilities: { left: 1 } } }],
    ["wrong probability keys", { move: { ...move, probabilities: { left: 0.8, jump: 0.2 } } }],
    ["extra probability", { move: { ...move, probabilities: { left: 0.8, right: 0.2, jump: 0 } } }],
    ["negative probability", { move: { ...move, probabilities: { left: 1.2, right: -0.2 } } }],
    ["unnormalized probabilities", { move: { ...move, probabilities: { left: 0.8, right: 0.8 } } }],
    ["nonmaximal choice", { move: { ...move, choice: "right" } }],
    ["negative confidence", { move: { ...move, confidence: -0.1 } }],
    ["excess confidence", { move: { ...move, confidence: 1.1 } }],
  ])("rejects %s before returning a decision", async (_name, answers) => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => Response.json({ model: "jev-latest", answers, usage: {} }),
    });
    await expect(
      client.systemOne({
        state: "Choose a move",
        questions: { move: { type: "choice", criteria: { left: null, right: null } } },
      }),
    ).rejects.toThrow();
  });

  it("accepts tied choices and independent confidence in a multi-question response", async () => {
    const answers = {
      move: { ...move, confidence: 0, probabilities: { left: 0.5, right: 0.5 } },
      risk: { type: "noul", noul: 0.2 },
    };
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => Response.json({ model: "jev-latest", answers, usage: {} }),
    });
    await expect(
      client.systemOne({
        state: "Choose a move",
        questions: {
          move: { type: "choice", criteria: { left: null, right: null } },
          risk: { type: "noul", instructions: "Risky?" },
        },
      }),
    ).resolves.toMatchObject({ answers });
  });

  it("accepts a rounded distribution across many choices", async () => {
    const alternatives = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`alternative_${index}`, 0.02]),
    );
    const criteria = Object.fromEntries(
      ["best", ...Object.keys(alternatives)].map((name) => [name, null]),
    );
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          model: "jev-latest",
          answers: {
            decision: {
              type: "choice",
              choice: "best",
              confidence: 0.5,
              probabilities: { best: 0.51, ...alternatives },
            },
          },
          usage: {},
        }),
    });

    await expect(
      client.systemOne({ state: "state", questions: { decision: { type: "choice", criteria } } }),
    ).resolves.toMatchObject({ answers: { decision: { choice: "best" } } });
  });

  it("rejects an empty choice set before network IO", async () => {
    let calls = 0;
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      client.systemOne({
        state: "Choose a move",
        questions: { move: { type: "choice", criteria: {} } },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("calls the TypeSafe System One endpoint and validates its response", async () => {
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            move: {
              type: "choice",
              choice: "left",
              confidence: 0.8,
              probabilities: { left: 0.8, right: 0.2 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200 },
      );
    };
    const client = new JevClient({ apiKey: "test-key", fetch: request });

    const response = await client.systemOne({
      state: { obstacle: "ahead" },
      questions: {
        move: {
          type: "choice",
          instructions: "Where should the player move?",
          criteria: { left: "open", right: "blocked" },
        },
      },
    });

    expect(response.answers.move).toMatchObject({ type: "choice", choice: "left" });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init!.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(JSON.parse(init!.body as string)).toEqual({
      state: { obstacle: "ahead" },
      model: "jev-latest",
      questions: {
        move: {
          type: "choice",
          instructions: "Where should the player move?",
          criteria: { left: "open", right: "blocked" },
        },
      },
    });
  });

  it("surfaces endpoint errors", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => new Response("quota exhausted", { status: 429 }),
    });

    await expect(
      client.systemOne({
        state: "state",
        questions: { risk: { type: "noul", instructions: "Risky?" } },
      }),
    ).rejects.toThrow("Jev request failed (429): quota exhausted");
  });

  it.each([503, 529])("retries transient provider HTTP %i at most twice", async (status) => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status }))
      .mockResolvedValueOnce(
        Response.json({
          model: "jev-latest",
          answers: { risk: { type: "noul", noul: 0.2 } },
          usage: { cost: 0.00001 },
        }),
      );
    const client = new JevClient({ apiKey: "test-key", fetch: send });

    await expect(
      client.systemOne({ state: "state", questions: { risk: { type: "noul" } } }),
    ).resolves.toMatchObject({ usage: { cost: 0.00001 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1].body).toBe(send.mock.calls[1]![1].body);
    send.mockResolvedValue(new Response("still unavailable", { status }));
    await expect(
      client.systemOne({ state: "state", questions: { risk: { type: "noul" } } }),
    ).rejects.toThrow(`Jev request failed (${status}): still unavailable`);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("retries a hosted sidecar connection refusal during startup", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "http://127.0.0.1:9100");
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          model: "typesafe/jev-1.13",
          answers: { risk: { type: "noul", noul: 0.2 } },
          usage: {},
        }),
      );
    const client = new JevClient({ fetch: send });
    await expect(
      client.systemOne({ state: "state", questions: { risk: { type: "noul" } } }),
    ).resolves.toMatchObject({ answers: { risk: { noul: 0.2 } } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects non-content state before network IO", async () => {
    const client = new JevClient({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("invalid request reached the network");
      },
    });

    await expect(
      client.systemOne({
        state: 42 as never,
        questions: { risk: { type: "noul", instructions: "Risky?" } },
      }),
    ).rejects.toThrow();
  });
});
