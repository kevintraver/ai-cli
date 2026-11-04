import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, test } from "vitest";

import { mediaFixture } from "../test/media.js";
import { resolveAudioFormat, shouldPreviewAudio } from "./audio.js";

describe("resolveAudioFormat", () => {
  test("defaults to mp3", () => {
    expect(resolveAudioFormat()).toBe("mp3");
  });

  test("infers known audio formats from explicit output filenames", () => {
    expect(resolveAudioFormat(undefined, "clip.wav")).toBe("wav");
    expect(resolveAudioFormat(undefined, "clip.flac")).toBe("flac");
  });

  test("does not infer a format from output directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-cli-audio-format-"));
    try {
      expect(resolveAudioFormat(undefined, dir)).toBe("mp3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores unknown output filename extensions", () => {
    expect(resolveAudioFormat(undefined, "clip.audio")).toBe("mp3");
  });

  test("rejects conflicting explicit formats and output extensions", () => {
    expect(() => resolveAudioFormat("mp3", "clip.wav")).toThrow(
      'does not match output file extension ".wav"'
    );
  });
});

describe("shouldPreviewAudio", () => {
  test("allows saved-file previews when stdout is piped and stderr is interactive", () => {
    expect(
      shouldPreviewAudio({ output: "clip.mp3" }, false, true, undefined)
    ).toBe(true);
  });

  test("skips binary stdout pipeline output", () => {
    expect(shouldPreviewAudio({}, false, true, undefined)).toBe(false);
  });

  test("skips json output and fully disabled previews", () => {
    expect(
      shouldPreviewAudio({ json: true, output: "clip.mp3" }, true, true)
    ).toBe(false);
    expect(
      shouldPreviewAudio(
        { output: "clip.mp3", play: false, waveform: false },
        true,
        true
      )
    ).toBe(false);
  });
});

describe("SDK speech generation", () => {
  const fixture = mediaFixture();
  const speak = (args: string[]) =>
    fixture.run([
      "audio",
      "speak",
      "--quiet",
      "--json",
      "--no-play",
      "-o",
      join(fixture.directory, `${crypto.randomUUID()}.mp3`),
      ...args,
    ]);

  test("forwards provider options to the Gateway speech model", async () => {
    const options = { elevenlabs: { durationSeconds: 6, loop: true } };
    const result = await speak([
      "-m",
      "elevenlabs/sound-effects-v2",
      "--provider-options",
      fixture.json(options),
      "steady rain",
    ]);
    expect(result.exitCode).toBe(0);
    const speech = result.requests.filter((request) =>
      request.route.endsWith("/speech-model")
    );
    expect(speech).toHaveLength(1);
    expect(speech[0].body).toMatchObject({
      text: "steady rain",
      providerOptions: options,
    });
    expect(speech[0].headers["ai-model-id"]).toBe(
      "elevenlabs/sound-effects-v2"
    );
  });

  test.each([
    ["a missing file", join(tmpdir(), "ai-cli-missing-options.json")],
    ["non-object provider values", { elevenlabs: 6 }],
    ["a non-object document", [1, 2]],
  ])("rejects %s before any network call", async (_label, options) => {
    const path = typeof options === "string" ? options : fixture.json(options);
    const result = await speak(["--provider-options", path, "steady rain"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--provider-options");
    expect(result.requests).toHaveLength(0);
  });
});

describe("sound effect and music generation", () => {
  const fixture = mediaFixture();
  const generate = (command: string, args: string[]) =>
    fixture.run([
      "audio",
      command,
      "--quiet",
      "--json",
      "--no-play",
      "-o",
      join(fixture.directory, `${crypto.randomUUID()}.mp3`),
      ...args,
    ]);
  const speechRequests = (result: Awaited<ReturnType<typeof generate>>) =>
    result.requests.filter((request) =>
      request.route.endsWith("/speech-model")
    );

  test("sfx sends its flags as ElevenLabs sound effect options", async () => {
    const result = await generate("sfx", [
      "--duration",
      "5",
      "--loop",
      "--prompt-influence",
      "0.4",
      "steady rain",
    ]);
    expect(result.exitCode).toBe(0);
    const [request] = speechRequests(result);
    expect(request.headers["ai-model-id"]).toBe("elevenlabs/sound-effects-v2");
    expect(request.body.text).toBe("steady rain");
    expect(request.body.providerOptions).toEqual({
      elevenlabs: { durationSeconds: 5, loop: true, promptInfluence: 0.4 },
    });
  });

  test("music sends its length in milliseconds and the instrumental switch", async () => {
    const result = await generate("music", [
      "--length",
      "8",
      "--instrumental",
      "lo-fi beat",
    ]);
    expect(result.exitCode).toBe(0);
    const [request] = speechRequests(result);
    expect(request.headers["ai-model-id"]).toBe("elevenlabs/music-v2.5");
    expect(request.body.text).toBe("lo-fi beat");
    expect(request.body.providerOptions).toEqual({
      elevenlabs: { musicLengthMs: 8000, forceInstrumental: true },
    });
  });

  test.each([
    ["speak", "openai/tts-1"],
    ["sfx", "elevenlabs/sound-effects-v2"],
    ["music", "elevenlabs/music-v2.5"],
  ])("%s defaults to %s", async (command, model) => {
    const result = await generate(command, ["hello"]);
    expect(result.exitCode).toBe(0);
    const requests = speechRequests(result);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["ai-model-id"]).toBe(model);
    expect(requests[0].body.providerOptions ?? {}).toEqual({});
  });

  test.each([
    ["sfx", "--duration", "0.4"],
    ["sfx", "--duration", "31"],
    ["sfx", "--duration", "five"],
    ["sfx", "--prompt-influence", "1.5"],
    ["music", "--length", "2"],
    ["music", "--length", "601"],
  ])(
    "%s rejects %s %s before any network call",
    async (command, flag, value) => {
      const result = await generate(command, [flag, value, "a prompt"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(flag);
      expect(result.requests).toHaveLength(0);
    }
  );

  test.each([
    ["speak", "--speed"],
    ["sfx", "--duration"],
    ["sfx", "--prompt-influence"],
    ["music", "--length"],
  ])("%s treats an empty %s as unset", async (command, flag) => {
    const result = await generate(command, [`${flag}=`, "a prompt"]);
    expect(result.exitCode).toBe(0);
    const [request] = speechRequests(result);
    expect(request.body.speed).toBeUndefined();
    expect(request.body.providerOptions ?? {}).toEqual({});
  });

  test.each([
    ["sfx", "--voice"],
    ["music", "--speed"],
  ])("%s rejects the speech-only flag %s", async (command, flag) => {
    const result = await generate(command, [flag, "1", "a prompt"]);
    expect(result.exitCode).toBe(1);
    expect(result.requests).toHaveLength(0);
  });

  test("a provider options file wins over a flag and keeps flag siblings", async () => {
    const result = await generate("sfx", [
      "--duration",
      "5",
      "--loop",
      "--provider-options",
      fixture.json({
        elevenlabs: { durationSeconds: 10 },
        gateway: { order: ["elevenlabs"] },
      }),
      "steady rain",
    ]);
    expect(result.exitCode).toBe(0);
    expect(speechRequests(result)[0].body.providerOptions).toEqual({
      elevenlabs: { durationSeconds: 10, loop: true },
      gateway: { order: ["elevenlabs"] },
    });
  });

  test.each([
    ["sfx", ["elevenlabs/sound-effects-v2"]],
    ["music", ["elevenlabs/music-v2.5"]],
    ["speech", ["openai/tts-1"]],
  ])("models --type %s lists only that category", async (type, ids) => {
    const result = await fixture.run(["models", "--type", type, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(result.stdout).map((model: { id: string }) => model.id)
    ).toEqual(ids);
  });

  test("models --type audio lists every audio category", async () => {
    const result = await fixture.run(["models", "--type", "audio"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Speech models (1)");
    expect(result.stdout).toContain("Sound effect models (1)");
    expect(result.stdout).toContain("Music models (1)");
  });
});
